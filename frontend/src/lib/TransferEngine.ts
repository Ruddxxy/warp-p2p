/**
 * TransferEngine - Core P2P file transfer logic
 *
 * Handles:
 * - WebRTC peer connection and data channel
 * - File chunking and streaming
 * - Progress tracking and speed calculation
 * - Encryption via SecurityManager
 * - SHA-256 hash verification
 * - Receipt confirmation
 */

import streamSaver from 'streamsaver';
import { SignalingClient, SignalingMessage } from './SignalingClient';
import { SecurityManager, HandshakeMessage, generateRoomCode } from './Security';
import { StreamingHasher } from './StreamingHasher';
import { logger } from './logger';
import {
  MAX_FILE_SIZE,
  MAX_FILE_SIZE_DISPLAY,
  FileSizeError,
  formatFileSize,
  type FileMetadata,
  type TransferRole,
  type TransferState,
  type TransferProgress
} from '../types';

// Configure StreamSaver (use local service worker for better compatibility)
streamSaver.mitm = '/mitm.html';

// Transfer constants
const CHUNK_SIZE = 64 * 1024; // 64KB chunks
const BUFFER_THRESHOLD = 16 * 1024 * 1024; // 16MB buffer before backpressure
const HASH_CHUNK_SIZE = 1024 * 1024; // 1MB chunks for hashing

// Default STUN servers (always included)
const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' }
];

// Fetch ICE servers including TURN credentials from the signaling server.
// Falls back to STUN-only on any error (graceful degradation).
async function getIceServers(signalingUrl: string): Promise<RTCIceServer[]> {
  try {
    const httpUrl = signalingUrl
      .replace('wss://', 'https://')
      .replace('ws://', 'http://')
      .replace(/\/ws\/?$/, '/turn-credentials');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    const response = await fetch(httpUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) return [...DEFAULT_STUN_SERVERS];

    const data = await response.json() as { iceServers?: RTCIceServer[] };
    if (data.iceServers && data.iceServers.length > 0) {
      logger.info('Engine', 'TURN server configured via signaling server');
      return [...DEFAULT_STUN_SERVERS, ...data.iceServers];
    }
  } catch {
    // TURN fetch failed — fall back to STUN-only
  }
  return [...DEFAULT_STUN_SERVERS];
}

export interface TransferEngineEvents {
  onStateChange?: (state: TransferState) => void;
  onProgress?: (progress: TransferProgress) => void;
  onError?: (error: Error) => void;
  onPeerConnected?: (peerId: string) => void;
  onPeerDisconnected?: () => void;
  onFileMetadata?: (metadata: FileMetadata) => void;
  onRoomCode?: (code: string) => void;
  onHashVerified?: (verified: boolean) => void;
}

interface DataMessage {
  type: 'metadata' | 'chunk' | 'done' | 'ack' | 'receipt';
  data?: string; // Base64 encoded
  metadata?: FileMetadata;
  chunkIndex?: number;
  status?: 'verified' | 'failed';
}

// Compute SHA-256 hash of file using streaming (constant ~1MB memory)
async function computeFileHash(file: File): Promise<string> {
  const hasher = new StreamingHasher();
  const totalChunks = Math.ceil(file.size / HASH_CHUNK_SIZE);

  for (let i = 0; i < totalChunks; i++) {
    const start = i * HASH_CHUNK_SIZE;
    const end = Math.min(start + HASH_CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);
    const buffer = await chunk.arrayBuffer();
    hasher.update(new Uint8Array(buffer));
  }

  return hasher.digest();
}

export class TransferEngine {
  private signalingClient: SignalingClient | null = null;
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private securityManager: SecurityManager;
  private role: TransferRole = 'sender';
  private state: TransferState = 'idle';
  private events: TransferEngineEvents;
  private signalingUrl: string;
  private roomCode = '';
  private peerId = '';

  // Transfer state
  private file: File | null = null;
  private fileMetadata: FileMetadata | null = null;
  private bytesTransferred = 0;
  private speedHistory: number[] = [];
  private speedSum = 0;
  private lastSpeedUpdate = 0;
  private lastBytesForSpeed = 0;

  // Receiver streaming & verification
  private writeStream: WritableStream | null = null;
  private writer: WritableStreamDefaultWriter | null = null;
  private streamingHasher: StreamingHasher | null = null;

  // Flag to track when transfer is logically complete (all data sent/received)
  // Used to ignore cleanup-related errors
  private transferLogicallyComplete = false;

  // ICE candidate queue: buffer candidates until remote description is set
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;

  // WebRTC connection timeout (30 seconds)
  private connectionTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly CONNECTION_TIMEOUT_MS = 30_000;

  // Handshake timeout — if handshake-verify never arrives (10 seconds)
  private handshakeTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly HANDSHAKE_TIMEOUT_MS = 10_000;

  // Data channel open timeout — after WebRTC connects but channel doesn't open (15 seconds)
  private dataChannelTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly DATA_CHANNEL_TIMEOUT_MS = 15_000;

  constructor(signalingUrl: string, events: TransferEngineEvents = {}) {
    this.events = events;
    this.signalingUrl = signalingUrl;
    this.securityManager = new SecurityManager();

    this.signalingClient = new SignalingClient({
      url: signalingUrl,
      onClose: () => this.handleSignalingClose(),
      onError: () => this.handleError(new Error('Signaling error'))
    });

    this.setupSignalingHandlers();
  }

  private setupSignalingHandlers(): void {
    if (!this.signalingClient) return;

    // Handle peer joining room
    this.signalingClient.on('peer-joined', (msg) => {
      logger.info('Engine', 'Peer joined', { clientId: msg.clientId });
      this.peerId = msg.clientId ?? '';
      this.events.onPeerConnected?.(this.peerId);

      // Sender initiates handshake
      if (this.role === 'sender') {
        this.initiateHandshake();
      }
    });

    // Handle peer leaving — error during setup phases only
    // During 'transferring', data flows via WebRTC data channel, not signaling.
    // If peer truly disconnects, onconnectionstatechange → failed/disconnected handles it.
    this.signalingClient.on('peer-left', () => {
      logger.info('Engine', 'Peer left');
      this.events.onPeerDisconnected?.();
      if (this.state === 'transferring') {
        logger.info('Engine', 'Peer-left during transfer (ignored — data flows via WebRTC)');
        return;
      }
      const activeStates: TransferState[] = ['connecting', 'handshaking', 'ready'];
      if (activeStates.includes(this.state)) {
        this.handleError(new Error('Peer disconnected during transfer'));
      }
    });

    // Handle room expired
    this.signalingClient.on('room-expired', () => {
      logger.info('Engine', 'Room expired');
      this.handleError(new Error('Room expired after 10 minutes'));
    });

    // Handle handshake verification
    this.signalingClient.on('handshake-verify', async (msg) => {
      await this.handleHandshakeVerify(msg);
    });

    // Handle WebRTC offer
    this.signalingClient.on('offer', async (msg) => {
      await this.handleOffer(msg);
    });

    // Handle WebRTC answer
    this.signalingClient.on('answer', async (msg) => {
      await this.handleAnswer(msg);
    });

    // Handle ICE candidates
    this.signalingClient.on('ice-candidate', async (msg) => {
      await this.handleIceCandidate(msg);
    });

    // Handle server error messages (e.g., "Room is full", "Room ID required")
    this.signalingClient.on('error', (msg) => {
      const errorMessage = typeof msg.payload === 'string'
        ? msg.payload
        : 'Server error';
      logger.warn('Engine', 'Server error', { error: errorMessage });
      this.handleError(new Error(errorMessage));
    });
  }

  // === Public API ===

  // Create room as sender with file size validation
  async createRoom(file: File): Promise<string> {
    // Validate file size (25GB limit)
    if (file.size > MAX_FILE_SIZE) {
      throw new FileSizeError(file.size);
    }

    this.role = 'sender';
    this.file = file;

    this.setState('connecting');

    // Compute file hash for integrity verification
    logger.info('Engine', 'Computing file hash...');
    const hash = await computeFileHash(file);
    logger.info('Engine', 'File hash computed');

    this.fileMetadata = {
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      hash
    };

    // Generate room code
    this.roomCode = generateRoomCode();
    await this.securityManager.init(this.roomCode);

    // Connect to signaling server
    await this.signalingClient!.connect();
    this.signalingClient!.joinRoom(this.roomCode);
    // Disable reconnection once we've joined — reconnecting would get a new clientId
    this.signalingClient!.allowReconnect = false;

    this.events.onRoomCode?.(this.roomCode);
    logger.info('Engine', 'Room created', { roomCode: this.roomCode });

    return this.roomCode;
  }

  // Join room as receiver
  async joinRoom(code: string): Promise<void> {
    this.role = 'receiver';
    this.roomCode = code.trim().toUpperCase();

    this.setState('connecting');

    await this.securityManager.init(this.roomCode);

    // Connect to signaling server
    await this.signalingClient!.connect();
    this.signalingClient!.joinRoom(this.roomCode);
    // Disable reconnection once we've joined — reconnecting would get a new clientId
    this.signalingClient!.allowReconnect = false;

    logger.info('Engine', 'Joining room', { roomCode: this.roomCode });
  }

  // Cancel/stop transfer
  stop(): void {
    this.cleanup();
    this.setState('idle');
  }

  // Get current state
  getState(): TransferState {
    return this.state;
  }

  // Get role
  getRole(): TransferRole {
    return this.role;
  }

  // === Handshake Logic ===

  private async initiateHandshake(): Promise<void> {
    this.setState('handshaking');
    this.startHandshakeTimeout();

    const handshakeMsg = await this.securityManager.createHandshakeMessage();
    if (!this.signalingClient!.sendHandshakeVerify(handshakeMsg, this.peerId)) {
      this.handleError(new Error('Failed to send handshake: signaling connection lost'));
      return;
    }

    logger.info('Engine', 'Sent handshake message');
  }

  private startHandshakeTimeout(): void {
    this.clearHandshakeTimeout();
    this.handshakeTimeout = setTimeout(() => {
      if (this.state === 'handshaking') {
        this.handleError(new Error('Handshake timeout - peer did not respond'));
      }
    }, TransferEngine.HANDSHAKE_TIMEOUT_MS);
  }

  private clearHandshakeTimeout(): void {
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout);
      this.handshakeTimeout = null;
    }
  }

  private async handleHandshakeVerify(msg: SignalingMessage): Promise<void> {
    if (!this.validatePayload(msg, ['publicKey'])) return;

    this.clearHandshakeTimeout();
    this.setState('handshaking');

    const payload = msg.payload as HandshakeMessage;
    this.peerId = msg.from ?? '';

    logger.info('Engine', 'Received handshake', { peerId: this.peerId });

    const verified = await this.securityManager.processHandshakeMessage(payload);

    if (!verified) {
      this.handleError(new Error('Handshake failed - wrong code'));
      return;
    }

    logger.info('Engine', 'Handshake verified');

    // If we haven't sent our handshake yet, send it now
    if (this.role === 'receiver') {
      const handshakeMsg = await this.securityManager.createHandshakeMessage();
      if (!this.signalingClient!.sendHandshakeVerify(handshakeMsg, this.peerId)) {
        this.handleError(new Error('Failed to send handshake: signaling connection lost'));
        return;
      }
    }

    // Sender creates WebRTC connection
    if (this.role === 'sender') {
      await this.createPeerConnection();
      await this.createOffer();
    }
  }

  // Validate signaling payload has required fields before unsafe cast
  private validatePayload(msg: SignalingMessage, requiredFields: string[]): boolean {
    if (!msg.payload || typeof msg.payload !== 'object') {
      logger.warn('Engine', 'Missing or invalid payload', { type: msg.type });
      return false;
    }
    const payload = msg.payload as Record<string, unknown>;
    for (const field of requiredFields) {
      if (!(field in payload)) {
        logger.warn('Engine', 'Missing required field in payload', { type: msg.type, field });
        return false;
      }
    }
    return true;
  }

  // === WebRTC Logic ===

  private async createPeerConnection(): Promise<void> {
    const iceServers = await getIceServers(this.signalingUrl);
    const config: RTCConfiguration = {
      iceServers,
      iceTransportPolicy: (import.meta.env.VITE_ICE_TRANSPORT_POLICY as RTCIceTransportPolicy) || 'all'
    };

    this.peerConnection = new RTCPeerConnection(config);

    // Handle ICE candidates
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalingClient!.sendIceCandidate(event.candidate, this.peerId);
      }
    };

    // Handle connection state
    this.peerConnection.onconnectionstatechange = () => {
      const connState = this.peerConnection?.connectionState;
      logger.debug('Engine', 'Connection state', { state: connState });

      if (connState === 'connected') {
        this.clearConnectionTimeout();
        this.setState('ready');
        this.startDataChannelTimeout();
      } else if (connState === 'failed') {
        // Ignore failures after successful completion
        if (this.state !== 'completed') {
          this.handleError(new Error('Peer connection failed'));
        }
      } else if (connState === 'disconnected') {
        // Only notify if not completed
        if (this.state !== 'completed') {
          this.events.onPeerDisconnected?.();
        }
      }
    };

    // Sender creates data channel
    if (this.role === 'sender') {
      this.dataChannel = this.peerConnection.createDataChannel('file-transfer', {
        ordered: true
      });
      this.setupDataChannel();
    } else {
      // Receiver waits for data channel
      this.peerConnection.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.setupDataChannel();
      };
    }

    // Start connection timeout — if WebRTC doesn't connect within 30s,
    // STUN/TURN likely failed (symmetric NAT, firewall)
    this.connectionTimeout = setTimeout(() => {
      if (this.state !== 'ready' && this.state !== 'transferring' && this.state !== 'completed') {
        this.handleError(new Error('WebRTC connection timed out - check network or firewall settings'));
      }
    }, TransferEngine.CONNECTION_TIMEOUT_MS);
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
  }

  private startDataChannelTimeout(): void {
    this.clearDataChannelTimeout();
    this.dataChannelTimeout = setTimeout(() => {
      if (this.state === 'ready') {
        this.handleError(new Error('Data channel failed to open - connection may be blocked'));
      }
    }, TransferEngine.DATA_CHANNEL_TIMEOUT_MS);
  }

  private clearDataChannelTimeout(): void {
    if (this.dataChannelTimeout) {
      clearTimeout(this.dataChannelTimeout);
      this.dataChannelTimeout = null;
    }
  }

  private setupDataChannel(): void {
    if (!this.dataChannel) return;

    this.dataChannel.binaryType = 'arraybuffer';

    this.dataChannel.onopen = () => {
      logger.info('Engine', 'Data channel open');
      this.clearDataChannelTimeout();

      if (this.role === 'sender') {
        // Send file metadata first
        this.sendMetadata();
      }
    };

    this.dataChannel.onclose = () => {
      logger.debug('Engine', 'Data channel closed');
      // Don't treat as error if transfer completed successfully
    };

    this.dataChannel.onerror = () => {
      // Ignore errors after successful completion or logical completion (cleanup race condition)
      if (this.state === 'completed' || this.transferLogicallyComplete) {
        logger.debug('Engine', 'Data channel error after completion (ignored)');
        return;
      }
      logger.error('Engine', 'Data channel error');
      this.handleError(new Error('Data channel error'));
    };

    this.dataChannel.onmessage = async (event) => {
      try {
        await this.handleDataMessage(event.data);
      } catch (error) {
        this.handleError(error instanceof Error ? error : new Error('Failed to handle data message'));
      }
    };

  }

  private async createOffer(): Promise<void> {
    if (!this.peerConnection) return;

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    if (!this.signalingClient!.sendOffer(offer, this.peerId)) {
      this.handleError(new Error('Failed to send offer: signaling connection lost'));
      return;
    }
    logger.info('Engine', 'Sent offer');
  }

  private async handleOffer(msg: SignalingMessage): Promise<void> {
    if (!this.validatePayload(msg, ['type', 'sdp'])) return;

    this.peerId = msg.from ?? '';

    await this.createPeerConnection();

    const offer = msg.payload as RTCSessionDescriptionInit;
    await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(offer));
    this.remoteDescriptionSet = true;
    this.flushPendingIceCandidates();

    const answer = await this.peerConnection!.createAnswer();
    await this.peerConnection!.setLocalDescription(answer);

    if (!this.signalingClient!.sendAnswer(answer, this.peerId)) {
      this.handleError(new Error('Failed to send answer: signaling connection lost'));
      return;
    }
    logger.info('Engine', 'Sent answer');
  }

  private async handleAnswer(msg: SignalingMessage): Promise<void> {
    if (!this.validatePayload(msg, ['type', 'sdp'])) return;

    const answer = msg.payload as RTCSessionDescriptionInit;
    await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(answer));
    this.remoteDescriptionSet = true;
    this.flushPendingIceCandidates();
    logger.info('Engine', 'Received answer');
  }

  private async handleIceCandidate(msg: SignalingMessage): Promise<void> {
    if (!this.validatePayload(msg, ['candidate'])) return;

    const candidate = msg.payload as RTCIceCandidateInit;

    // Queue candidates until remote description is set — adding before
    // setRemoteDescription silently fails or throws in most browsers
    if (!this.remoteDescriptionSet || !this.peerConnection) {
      this.pendingIceCandidates.push(candidate);
      return;
    }

    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      logger.warn('Engine', 'Failed to add ICE candidate');
    }
  }

  private flushPendingIceCandidates(): void {
    if (!this.peerConnection || this.pendingIceCandidates.length === 0) return;

    logger.info('Engine', 'Flushing queued ICE candidates', { count: this.pendingIceCandidates.length });
    const candidates = this.pendingIceCandidates;
    this.pendingIceCandidates = [];

    for (const candidate of candidates) {
      this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {
        logger.warn('Engine', 'Failed to add queued ICE candidate');
      });
    }
  }

  // === File Transfer Logic ===

  private sendMetadata(): void {
    if (!this.fileMetadata) return;

    const msg: DataMessage = {
      type: 'metadata',
      metadata: this.fileMetadata
    };

    this.dataChannel!.send(JSON.stringify(msg));
    logger.info('Engine', 'Sent metadata');
  }

  private async handleDataMessage(data: ArrayBuffer | string): Promise<void> {
    logger.debug('Engine', 'Received data', { type: typeof data, size: typeof data === 'string' ? data.length : (data as ArrayBuffer).byteLength });

    if (typeof data === 'string') {
      const msg: DataMessage = JSON.parse(data);
      logger.debug('Engine', 'Received message type', { type: msg.type });

      if (msg.type === 'metadata') {
        this.fileMetadata = msg.metadata!;

        // Sanitize filename first: strip control chars, bidi overrides, path separators
        this.fileMetadata.name = (this.fileMetadata.name || '')
          .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
          .replace(/[/\\:]/g, '_')
          .replace(/\.\./g, '_')
          .trim();

        // Validate metadata from peer after sanitization
        if (!this.fileMetadata.name || this.fileMetadata.name.length === 0) {
          this.handleError(new Error('Invalid file: missing name'));
          return;
        }
        if (this.fileMetadata.size <= 0 || this.fileMetadata.size > MAX_FILE_SIZE) {
          this.handleError(new Error(`File size (${formatFileSize(this.fileMetadata.size)}) exceeds maximum allowed size of ${MAX_FILE_SIZE_DISPLAY}`));
          return;
        }

        this.events.onFileMetadata?.(this.fileMetadata);

        // Setup file download stream
        await this.setupDownloadStream();

        // Acknowledge ready to receive
        this.dataChannel!.send(JSON.stringify({ type: 'ack' }));
      } else if (msg.type === 'ack' && this.role === 'sender') {
        // Receiver is ready, start sending
        this.startSending().catch((err) => {
          this.handleError(err instanceof Error ? err : new Error('Send failed'));
        });
      } else if (msg.type === 'done') {
        // Transfer complete, verify and send receipt
        await this.finishReceiving();
      } else if (msg.type === 'receipt' && this.role === 'sender') {
        // Handle receipt from receiver
        this.transferLogicallyComplete = true;
        if (msg.status === 'verified') {
          logger.info('Engine', 'Receipt confirmed - transfer verified');
          this.setState('completed');
        } else {
          this.handleError(new Error('Receiver reported hash verification failed'));
        }
      }
    } else {
      // Binary chunk data
      await this.handleChunk(data);
    }
  }

  private async setupDownloadStream(): Promise<void> {
    if (!this.fileMetadata) return;

    // Use StreamSaver to write directly to disk
    this.writeStream = streamSaver.createWriteStream(this.fileMetadata.name, {
      size: this.fileMetadata.size
    });
    this.writer = this.writeStream.getWriter();

    // Initialize streaming hasher for incremental hash verification
    this.streamingHasher = new StreamingHasher();

    this.setState('transferring');
  }

  private async startSending(): Promise<void> {
    if (!this.file || !this.dataChannel) return;

    this.setState('transferring');

    const totalChunks = Math.ceil(this.file.size / CHUNK_SIZE);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, this.file.size);
      const chunk = this.file.slice(start, end);
      const buffer = await chunk.arrayBuffer();

      // Encrypt chunk
      const encrypted = await this.securityManager.encryptChunk(buffer);

      // Wait for buffer to drain if needed (event-driven backpressure)
      if (this.dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
        await this.waitForBufferDrain(this.dataChannel);
      }

      this.dataChannel.send(encrypted);
      this.bytesTransferred = end;
      this.updateProgress();
    }

    // Send done message
    this.dataChannel.send(JSON.stringify({ type: 'done' }));
    logger.info('Engine', 'Sent all chunks, waiting for receipt');

    // Note: State will be set to 'completed' when receipt is received
  }

  // Event-driven backpressure: wait for bufferedAmount to drop below threshold
  // instead of polling with setTimeout. Uses onbufferedamountlow event.
  private waitForBufferDrain(channel: RTCDataChannel): Promise<void> {
    return new Promise((resolve, reject) => {
      if (channel.readyState !== 'open') {
        reject(new Error('Data channel closed during transfer'));
        return;
      }

      channel.bufferedAmountLowThreshold = BUFFER_THRESHOLD;

      const cleanup = () => {
        clearTimeout(timeout);
        channel.onbufferedamountlow = null;
        channel.removeEventListener('close', onClose);
      };

      const onClose = () => {
        cleanup();
        reject(new Error('Data channel closed during backpressure wait'));
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Transfer stalled - backpressure timeout'));
      }, 30_000);

      channel.addEventListener('close', onClose);
      channel.onbufferedamountlow = () => {
        cleanup();
        resolve();
      };
    });
  }

  private async handleChunk(data: ArrayBuffer): Promise<void> {
    if (!this.writer) {
      logger.warn('Engine', 'No writer available for chunk');
      return;
    }

    try {
      // Decrypt chunk
      logger.debug('Engine', 'Decrypting chunk', { size: data.byteLength });
      const decrypted = await this.securityManager.decryptChunk(data);
      const chunk = new Uint8Array(decrypted);
      logger.debug('Engine', 'Chunk decrypted', { size: chunk.length });

      // Feed streaming hasher for incremental hash verification (constant memory)
      this.streamingHasher?.update(chunk);

      // Write to file stream
      await this.writer.write(chunk);

      this.bytesTransferred += decrypted.byteLength;
      this.updateProgress();
    } catch (error) {
      logger.error('Engine', 'Chunk handling error');
      this.handleError(new Error('Decryption failed - possible tampering'));
    }
  }

  private async finishReceiving(): Promise<void> {
    this.transferLogicallyComplete = true;

    if (this.writer) {
      try {
        await this.writer.close();
      } catch {
        logger.warn('Engine', 'Writer close error (file may still be saved)');
      }
      this.writer = null;
      this.writeStream = null;
    }

    // Verify hash using streaming hasher (works for all file sizes including 0-byte)
    let verified = true;
    if (this.fileMetadata?.hash && this.streamingHasher) {
      logger.info('Engine', 'Verifying file hash');

      const actualHash = this.streamingHasher.digest();
      verified = actualHash === this.fileMetadata.hash;

      if (verified) {
        logger.info('Engine', 'File hash verified successfully');
      } else {
        logger.error('Engine', 'Hash mismatch detected');
      }

      this.events.onHashVerified?.(verified);
    }

    // Send receipt confirmation — guard against channel already closing
    const receipt: DataMessage = {
      type: 'receipt',
      status: verified ? 'verified' : 'failed'
    };
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(receipt));
    } else {
      logger.warn('Engine', 'Data channel closed before receipt could be sent');
    }

    // Release hasher
    this.streamingHasher = null;

    if (verified) {
      this.setState('completed');
      logger.info('Engine', 'Transfer complete - verified');
    } else {
      this.handleError(new Error('File integrity check failed - hash mismatch'));
    }
  }

  private updateProgress(): void {
    const now = Date.now();
    const totalBytes = this.fileMetadata?.size ?? 0;

    // Only recalculate speed and emit progress every 200ms
    if (now - this.lastSpeedUpdate < 200) return;

    const bytesDelta = this.bytesTransferred - this.lastBytesForSpeed;
    const timeDelta = (now - this.lastSpeedUpdate) / 1000;
    const speed = timeDelta > 0 ? bytesDelta / timeDelta : 0;

    this.speedHistory.push(speed);
    this.speedSum += speed;
    if (this.speedHistory.length > 50) {
      this.speedSum -= this.speedHistory.shift()!;
    }

    this.lastSpeedUpdate = now;
    this.lastBytesForSpeed = this.bytesTransferred;

    const avgSpeed =
      this.speedHistory.length > 0
        ? this.speedSum / this.speedHistory.length
        : 0;

    const remaining = totalBytes - this.bytesTransferred;
    const eta = avgSpeed > 0 ? remaining / avgSpeed : 0;

    const progress: TransferProgress = {
      bytesTransferred: this.bytesTransferred,
      totalBytes,
      percentage: totalBytes > 0 ? (this.bytesTransferred / totalBytes) * 100 : 0,
      speed: avgSpeed,
      speedHistory: [...this.speedHistory],
      eta
    };

    this.events.onProgress?.(progress);
  }

  // === State Management ===

  private setState(state: TransferState): void {
    this.state = state;
    this.events.onStateChange?.(state);
    logger.debug('Engine', 'State transition', { state });
  }

  private handleError(error: Error): void {
    // Don't override completed state with error, or if transfer is logically complete
    if (this.state === 'completed' || this.transferLogicallyComplete) {
      logger.debug('Engine', 'Error after completion (ignored)', { error: error.message });
      return;
    }
    logger.error('Engine', 'Error', { error: error.message });
    this.setState('error');
    this.events.onError?.(error);
    this.cleanup();
  }

  private handleSignalingClose(): void {
    if (this.state === 'transferring' || this.state === 'completed') {
      // Signaling can close during active transfer or after completion — data flows via WebRTC
      return;
    }
    if (this.state === 'connecting' || this.state === 'handshaking') {
      // During setup, losing signaling is fatal — we can't complete negotiation
      this.handleError(new Error('Server connection lost during setup'));
      return;
    }
    if (this.state === 'ready') {
      // WebRTC is connected but signaling lost — late ICE candidates won't arrive
      logger.warn('Engine', 'Signaling lost in ready state - late ICE candidates cannot arrive');
      return;
    }
    if (this.state !== 'idle') {
      this.events.onPeerDisconnected?.();
    }
  }

  private cleanup(): void {
    this.clearConnectionTimeout();
    this.clearHandshakeTimeout();
    this.clearDataChannelTimeout();

    this.dataChannel?.close();
    this.dataChannel = null;

    this.peerConnection?.close();
    this.peerConnection = null;

    this.signalingClient?.disconnect();

    this.securityManager.destroy();

    if (this.writer) {
      this.writer.abort();
      this.writer = null;
      this.writeStream = null;
    }

    this.file = null;
    this.fileMetadata = null;
    this.bytesTransferred = 0;
    this.speedHistory = [];
    this.speedSum = 0;
    this.streamingHasher = null;
    this.pendingIceCandidates = [];
    this.remoteDescriptionSet = false;
  }

  // Cleanup on destroy
  destroy(): void {
    this.cleanup();
  }
}

// Re-export types from types/index.ts for convenience
export type { FileMetadata, TransferRole, TransferState, TransferProgress } from '../types';
export { MAX_FILE_SIZE, MAX_FILE_SIZE_DISPLAY, FileSizeError, formatFileSize } from '../types';
