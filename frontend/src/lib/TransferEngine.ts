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
import {
  MAX_FILE_SIZE,
  FileSizeError,
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

// ICE Server configuration with optional TURN support
const getIceServers = (): RTCIceServer[] => {
  const servers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ];

  // Add TURN server if configured via environment
  const turnUrl = import.meta.env.VITE_TURN_URL as string | undefined;
  const turnUsername = import.meta.env.VITE_TURN_USERNAME as string | undefined;
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL as string | undefined;

  if (turnUrl && turnUsername && turnCredential) {
    servers.push({
      urls: turnUrl,
      username: turnUsername,
      credential: turnCredential
    });
    console.log('[Engine] TURN server configured');
  }

  return servers;
};

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

  constructor(signalingUrl: string, events: TransferEngineEvents = {}) {
    this.events = events;
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
      console.log('[Engine] Peer joined:', msg.clientId);
      this.peerId = msg.clientId ?? '';
      this.events.onPeerConnected?.(this.peerId);

      // Sender initiates handshake
      if (this.role === 'sender') {
        this.initiateHandshake();
      }
    });

    // Handle peer leaving
    this.signalingClient.on('peer-left', () => {
      console.log('[Engine] Peer left');
      this.events.onPeerDisconnected?.();
      if (this.state === 'transferring') {
        this.handleError(new Error('Peer disconnected during transfer'));
      }
    });

    // Handle room expired
    this.signalingClient.on('room-expired', () => {
      console.log('[Engine] Room expired');
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
    console.log('[Engine] Computing file hash...');
    const hash = await computeFileHash(file);
    console.log('[Engine] File hash:', hash.slice(0, 16) + '...');

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

    this.events.onRoomCode?.(this.roomCode);
    console.log('[Engine] Room created:', this.roomCode);

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

    console.log('[Engine] Joining room:', this.roomCode);
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

    const handshakeMsg = await this.securityManager.createHandshakeMessage();
    this.signalingClient!.sendHandshakeVerify(handshakeMsg, this.peerId);

    console.log('[Engine] Sent handshake message');
  }

  private async handleHandshakeVerify(msg: SignalingMessage): Promise<void> {
    const payload = msg.payload as HandshakeMessage;
    this.peerId = msg.from ?? '';

    console.log('[Engine] Received handshake from:', this.peerId);

    const verified = await this.securityManager.processHandshakeMessage(payload);

    if (!verified) {
      this.handleError(new Error('Handshake failed - wrong code'));
      return;
    }

    console.log('[Engine] Handshake verified');

    // If we haven't sent our handshake yet, send it now
    if (this.role === 'receiver') {
      const handshakeMsg = await this.securityManager.createHandshakeMessage();
      this.signalingClient!.sendHandshakeVerify(handshakeMsg, this.peerId);
    }

    // Sender creates WebRTC connection
    if (this.role === 'sender') {
      await this.createPeerConnection();
      await this.createOffer();
    }
  }

  // === WebRTC Logic ===

  private async createPeerConnection(): Promise<void> {
    const config: RTCConfiguration = {
      iceServers: getIceServers(),
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
      console.log('[Engine] Connection state:', connState);

      if (connState === 'connected') {
        this.setState('ready');
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
  }

  private setupDataChannel(): void {
    if (!this.dataChannel) return;

    this.dataChannel.binaryType = 'arraybuffer';

    this.dataChannel.onopen = () => {
      console.log('[Engine] Data channel open');

      if (this.role === 'sender') {
        // Send file metadata first
        this.sendMetadata();
      }
    };

    this.dataChannel.onclose = () => {
      console.log('[Engine] Data channel closed');
      // Don't treat as error if transfer completed successfully
    };

    this.dataChannel.onerror = (error) => {
      // Ignore errors after successful completion or logical completion (cleanup race condition)
      if (this.state === 'completed' || this.transferLogicallyComplete) {
        console.log('[Engine] Data channel error after completion (ignored):', error);
        return;
      }
      console.error('[Engine] Data channel error:', error);
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

    this.signalingClient!.sendOffer(offer, this.peerId);
    console.log('[Engine] Sent offer');
  }

  private async handleOffer(msg: SignalingMessage): Promise<void> {
    this.peerId = msg.from ?? '';

    await this.createPeerConnection();

    const offer = msg.payload as RTCSessionDescriptionInit;
    await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(offer));

    const answer = await this.peerConnection!.createAnswer();
    await this.peerConnection!.setLocalDescription(answer);

    this.signalingClient!.sendAnswer(answer, this.peerId);
    console.log('[Engine] Sent answer');
  }

  private async handleAnswer(msg: SignalingMessage): Promise<void> {
    const answer = msg.payload as RTCSessionDescriptionInit;
    await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(answer));
    console.log('[Engine] Received answer');
  }

  private async handleIceCandidate(msg: SignalingMessage): Promise<void> {
    const candidate = msg.payload as RTCIceCandidateInit;
    await this.peerConnection!.addIceCandidate(new RTCIceCandidate(candidate));
  }

  // === File Transfer Logic ===

  private sendMetadata(): void {
    if (!this.fileMetadata) return;

    const msg: DataMessage = {
      type: 'metadata',
      metadata: this.fileMetadata
    };

    this.dataChannel!.send(JSON.stringify(msg));
    console.log('[Engine] Sent metadata with hash:', this.fileMetadata.hash?.slice(0, 16) + '...');
  }

  private async handleDataMessage(data: ArrayBuffer | string): Promise<void> {
    console.log('[Engine] Received data, type:', typeof data, 'size:', typeof data === 'string' ? data.length : data.byteLength);

    if (typeof data === 'string') {
      const msg: DataMessage = JSON.parse(data);
      console.log('[Engine] Received message type:', msg.type);

      if (msg.type === 'metadata') {
        this.fileMetadata = msg.metadata!;
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
          console.log('[Engine] Receipt confirmed - transfer verified');
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

      // Wait for buffer to drain if needed (backpressure)
      const backpressureStart = Date.now();
      while (this.dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
        if (this.dataChannel.readyState !== 'open') {
          throw new Error('Data channel closed during transfer');
        }
        if (Date.now() - backpressureStart > 30_000) {
          throw new Error('Transfer stalled - backpressure timeout');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      this.dataChannel.send(encrypted);
      this.bytesTransferred = end;
      this.updateProgress();
    }

    // Send done message
    this.dataChannel.send(JSON.stringify({ type: 'done' }));
    console.log('[Engine] Sent all chunks, waiting for receipt...');

    // Note: State will be set to 'completed' when receipt is received
  }

  private async handleChunk(data: ArrayBuffer): Promise<void> {
    if (!this.writer) {
      console.warn('[Engine] No writer available for chunk');
      return;
    }

    try {
      // Decrypt chunk
      console.log('[Engine] Decrypting chunk, size:', data.byteLength);
      const decrypted = await this.securityManager.decryptChunk(data);
      const chunk = new Uint8Array(decrypted);
      console.log('[Engine] Chunk decrypted, size:', chunk.length);

      // Feed streaming hasher for incremental hash verification (constant memory)
      this.streamingHasher?.update(chunk);

      // Write to file stream
      await this.writer.write(chunk);

      this.bytesTransferred += decrypted.byteLength;
      this.updateProgress();
    } catch (error) {
      console.error('[Engine] Chunk handling error:', error);
      this.handleError(new Error('Decryption failed - possible tampering'));
    }
  }

  private async finishReceiving(): Promise<void> {
    this.transferLogicallyComplete = true;

    if (this.writer) {
      await this.writer.close();
      this.writer = null;
      this.writeStream = null;
    }

    // Verify hash using streaming hasher (works for all file sizes including 0-byte)
    let verified = true;
    if (this.fileMetadata?.hash && this.streamingHasher) {
      console.log('[Engine] Verifying file hash...');

      const actualHash = this.streamingHasher.digest();
      verified = actualHash === this.fileMetadata.hash;

      if (verified) {
        console.log('[Engine] File hash verified successfully');
      } else {
        console.error('[Engine] Hash mismatch! Expected:', this.fileMetadata.hash.slice(0, 16), 'Got:', actualHash.slice(0, 16));
      }

      this.events.onHashVerified?.(verified);
    }

    // Send receipt confirmation
    const receipt: DataMessage = {
      type: 'receipt',
      status: verified ? 'verified' : 'failed'
    };
    this.dataChannel!.send(JSON.stringify(receipt));

    // Release hasher
    this.streamingHasher = null;

    if (verified) {
      this.setState('completed');
      console.log('[Engine] Transfer complete - verified');
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
    console.log('[Engine] State:', state);
  }

  private handleError(error: Error): void {
    // Don't override completed state with error, or if transfer is logically complete
    if (this.state === 'completed' || this.transferLogicallyComplete) {
      console.log('[Engine] Error after completion (ignored):', error.message);
      return;
    }
    console.error('[Engine] Error:', error.message);
    this.setState('error');
    this.events.onError?.(error);
    this.cleanup();
  }

  private handleSignalingClose(): void {
    if (this.state === 'transferring') {
      // Signaling can close during transfer, that's okay
      return;
    }
    if (this.state !== 'completed' && this.state !== 'idle') {
      this.events.onPeerDisconnected?.();
    }
  }

  private cleanup(): void {
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
  }

  // Cleanup on destroy
  destroy(): void {
    this.cleanup();
  }
}

// Re-export types from types/index.ts for convenience
export type { FileMetadata, TransferRole, TransferState, TransferProgress } from '../types';
export { MAX_FILE_SIZE, MAX_FILE_SIZE_DISPLAY, FileSizeError, formatFileSize } from '../types';
