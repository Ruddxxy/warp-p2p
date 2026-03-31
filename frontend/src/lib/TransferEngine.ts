/**
 * TransferEngine - Core P2P file transfer logic
 *
 * Handles:
 * - WebRTC peer connection and data channel
 * - Multi-file batch transfer (sequential, ordered)
 * - File chunking and streaming with backpressure
 * - Per-chunk AES-256-GCM encryption via SecurityManager
 * - Per-file SHA-256 streaming hash verification
 * - Pause/resume support (connection-alive pause)
 * - Receipt confirmation per file
 */

import streamSaver from "streamsaver";
import { SignalingClient, SignalingMessage } from "./SignalingClient";
import { SecurityManager, HandshakeMessage, generateRoomCode } from "./Security";
import { StreamingHasher } from "./StreamingHasher";
import { logger } from "./logger";
import {
  MAX_FILE_SIZE,
  MAX_FILE_SIZE_DISPLAY,
  FileSizeError,
  formatFileSize,
  type FileMetadata,
  type TransferRole,
  type TransferState,
  type TransferProgress,
  type BatchFileInfo,
  type BatchInfo,
  type FileTransferStatus,
} from "../types";

// Configure StreamSaver (use local service worker for better compatibility)
streamSaver.mitm = "/mitm.html";

// Transfer constants — optimized for throughput
// Chrome's data channel max message size is 256KB (262,144 bytes).
// Each message = chunk + 12-byte IV + 16-byte GCM tag + 4-byte file index = chunk + 32 bytes.
// So max chunk = 256KB - 32 = 262,112 bytes. Use 248KB for safe headroom.
const CHUNK_SIZE = 248 * 1024;
// 64MB: keeps the SCTP pipe full. Modern devices have 4-8GB RAM.
const BUFFER_THRESHOLD = 64 * 1024 * 1024;

// Default STUN servers (always included)
const DEFAULT_STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
];

// Fetch ICE servers including TURN credentials from the signaling server.
async function getIceServers(signalingUrl: string): Promise<RTCIceServer[]> {
  try {
    const httpUrl = signalingUrl
      .replace("wss://", "https://")
      .replace("ws://", "http://")
      .replace(/\/ws\/?$/, "/turn-credentials");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    const response = await fetch(httpUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) return [...DEFAULT_STUN_SERVERS];

    const data = (await response.json()) as { iceServers?: RTCIceServer[] };
    if (data.iceServers && data.iceServers.length > 0) {
      logger.info("Engine", "TURN server configured via signaling server");
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
  onBatchInfo?: (batch: BatchInfo) => void;
  onFileStatusChange?: (statuses: FileTransferStatus[]) => void;
}

// --- Data Channel Protocol Messages ---

interface BatchMessage {
  type: "batch";
  batch: BatchInfo;
}

interface BatchAckMessage {
  type: "batch-ack";
}

interface FileStartMessage {
  type: "file-start";
  fileId: string;
  fileIndex: number;
  metadata: FileMetadata;
}

interface FileAckMessage {
  type: "file-ack";
  fileId: string;
}

interface FileEndMessage {
  type: "file-end";
  fileId: string;
  hash?: string; // Sender's computed hash (computed while sending, not before)
}

interface FileReceiptMessage {
  type: "file-receipt";
  fileId: string;
  status: "verified" | "failed";
}

interface BatchDoneMessage {
  type: "batch-done";
}

interface PauseMessage {
  type: "pause";
  fileId: string;
  lastChunkIndex: number;
}

interface PauseAckMessage {
  type: "pause-ack";
  fileId: string;
  lastChunkIndex: number;
}

interface ResumeMessage {
  type: "resume";
  fileId: string;
  fromChunkIndex: number;
}

// Legacy single-file messages (backward compat with old receivers)
interface LegacyMetadataMessage {
  type: "metadata";
  metadata: FileMetadata;
}

interface LegacyAckMessage {
  type: "ack";
}

interface LegacyDoneMessage {
  type: "done";
}

interface LegacyReceiptMessage {
  type: "receipt";
  status: "verified" | "failed";
}

type DataMessage =
  | BatchMessage
  | BatchAckMessage
  | FileStartMessage
  | FileAckMessage
  | FileEndMessage
  | FileReceiptMessage
  | BatchDoneMessage
  | PauseMessage
  | PauseAckMessage
  | ResumeMessage
  | LegacyMetadataMessage
  | LegacyAckMessage
  | LegacyDoneMessage
  | LegacyReceiptMessage;

export class TransferEngine {
  private signalingClient: SignalingClient | null = null;
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private securityManager: SecurityManager;
  private role: TransferRole = "sender";
  private state: TransferState = "idle";
  private events: TransferEngineEvents;
  private signalingUrl: string;
  private roomCode = "";
  private peerId = "";

  // Batch state
  private files: File[] = [];
  private batchInfo: BatchInfo | null = null;
  private fileStatuses: FileTransferStatus[] = [];
  private currentFileIndex = 0;
  private batchBytesTransferred = 0;

  // Current-file transfer state (reset per file)
  private currentFileBytesTransferred = 0;
  private speedHistory: number[] = [];
  private speedSum = 0;
  private lastSpeedUpdate = 0;
  private lastBytesForSpeed = 0;

  // Receiver streaming & verification (per-file)
  private writeStream: WritableStream | null = null;
  private writer: WritableStreamDefaultWriter | null = null;
  private streamingHasher: StreamingHasher | null = null;
  private currentFileMetadata: FileMetadata | null = null;

  // Flag to track when transfer is logically complete
  private transferLogicallyComplete = false;

  // Pause state
  private paused = false;
  private pauseResolve: (() => void) | null = null;

  // Message processing queue: serializes async chunk handling
  private messageQueue: (ArrayBuffer | string)[] = [];
  private queueHead = 0;
  private drainingQueue = false;

  // ICE candidate queue: buffer candidates until remote description is set
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;

  // Timeouts
  private connectionTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly CONNECTION_TIMEOUT_MS = 30_000;
  private handshakeTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly HANDSHAKE_TIMEOUT_MS = 10_000;
  private dataChannelTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly DATA_CHANNEL_TIMEOUT_MS = 15_000;
  private peerJoinTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly PEER_JOIN_TIMEOUT_MS = 30_000;

  // Promise resolvers for waiting on peer ack
  private ackResolve: (() => void) | null = null;
  private receiptResolve: ((status: "verified" | "failed") => void) | null = null;

  constructor(signalingUrl: string, events: TransferEngineEvents = {}) {
    this.events = events;
    this.signalingUrl = signalingUrl;
    this.securityManager = new SecurityManager();

    this.signalingClient = new SignalingClient({
      url: signalingUrl,
      onClose: () => this.handleSignalingClose(),
      onError: () => this.handleError(new Error("Signaling error")),
    });

    this.setupSignalingHandlers();
  }

  private setupSignalingHandlers(): void {
    if (!this.signalingClient) return;

    this.signalingClient.on("peer-joined", (msg) => {
      logger.info("Engine", "Peer joined", { clientId: msg.clientId });
      this.clearPeerJoinTimeout();
      this.peerId = msg.clientId ?? "";
      this.events.onPeerConnected?.(this.peerId);
      if (this.role === "sender") {
        this.initiateHandshake();
      }
    });

    this.signalingClient.on("peer-left", () => {
      logger.info("Engine", "Peer left");
      this.events.onPeerDisconnected?.();
      if (this.state === "transferring") {
        logger.info("Engine", "Peer-left during transfer (ignored — data flows via WebRTC)");
        return;
      }
      const activeStates: TransferState[] = ["connecting", "handshaking", "ready"];
      if (activeStates.includes(this.state)) {
        this.handleError(new Error("Peer disconnected during transfer"));
      }
    });

    this.signalingClient.on("room-expired", () => {
      logger.info("Engine", "Room expired");
      this.handleError(new Error("Room expired after 10 minutes"));
    });

    this.signalingClient.on("handshake-verify", async (msg) => {
      await this.handleHandshakeVerify(msg);
    });

    this.signalingClient.on("offer", async (msg) => {
      await this.handleOffer(msg);
    });

    this.signalingClient.on("answer", async (msg) => {
      await this.handleAnswer(msg);
    });

    this.signalingClient.on("ice-candidate", async (msg) => {
      await this.handleIceCandidate(msg);
    });

    this.signalingClient.on("error", (msg) => {
      const errorMessage = typeof msg.payload === "string" ? msg.payload : "Server error";
      logger.warn("Engine", "Server error", { error: errorMessage });
      this.handleError(new Error(errorMessage));
    });
  }

  // === Public API ===

  async createRoom(files: File[]): Promise<string> {
    if (files.length === 0) {
      throw new Error("No files selected");
    }

    // Validate all files
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        throw new FileSizeError(file.size);
      }
      if (file.size === 0) {
        throw new Error(`File "${file.name}" is empty`);
      }
    }

    this.role = "sender";
    this.files = files;

    // No pre-hashing — hash is computed while sending (streaming).
    // Transfer starts immediately regardless of file size.
    const batchFiles: BatchFileInfo[] = [];
    const statuses: FileTransferStatus[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const id = crypto.randomUUID();

      batchFiles.push({
        id,
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
      });

      statuses.push({
        id,
        name: file.name,
        size: file.size,
        status: "pending",
        bytesTransferred: 0,
        // hash computed during transfer, not before
      });
    }

    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    this.batchInfo = {
      totalFiles: files.length,
      totalBytes,
      files: batchFiles,
    };
    this.fileStatuses = statuses;
    this.currentFileIndex = 0;
    this.batchBytesTransferred = 0;

    this.events.onBatchInfo?.(this.batchInfo);
    this.events.onFileStatusChange?.([...this.fileStatuses]);

    this.setState("connecting");

    // Generate room code and connect
    this.roomCode = generateRoomCode();
    await this.securityManager.init(this.roomCode);

    await this.signalingClient!.connect();
    this.signalingClient!.joinRoom(this.roomCode);
    this.signalingClient!.allowReconnect = false;

    this.events.onRoomCode?.(this.roomCode);
    logger.info("Engine", "Room created", {
      roomCode: this.roomCode,
      files: files.length,
    });

    return this.roomCode;
  }

  async joinRoom(code: string): Promise<void> {
    this.role = "receiver";
    this.roomCode = code.trim().toUpperCase();

    this.setState("connecting");

    await this.securityManager.init(this.roomCode);

    await this.signalingClient!.connect();
    this.signalingClient!.joinRoom(this.roomCode);
    this.signalingClient!.allowReconnect = false;

    // Start timeout for peer to join — if no one arrives in 30s, show error
    this.startPeerJoinTimeout();

    logger.info("Engine", "Joining room", { roomCode: this.roomCode });
  }

  pause(): void {
    if (this.state !== "transferring") return;
    this.paused = true;
    logger.info("Engine", "Transfer paused");

    // Notify peer
    if (this.dataChannel?.readyState === "open") {
      const currentFile = this.fileStatuses[this.currentFileIndex];
      const totalChunks = currentFile ? Math.ceil(currentFile.size / CHUNK_SIZE) : 0;
      const lastChunk =
        totalChunks > 0 ? Math.floor(this.currentFileBytesTransferred / CHUNK_SIZE) - 1 : 0;

      const msg: PauseMessage = {
        type: "pause",
        fileId: currentFile?.id ?? "",
        lastChunkIndex: Math.max(0, lastChunk),
      };
      this.dataChannel.send(JSON.stringify(msg));
    }

    this.setState("paused");
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.paused = false;
    logger.info("Engine", "Transfer resumed");

    // Notify peer
    if (this.dataChannel?.readyState === "open") {
      const currentFile = this.fileStatuses[this.currentFileIndex];
      const fromChunk = Math.floor(this.currentFileBytesTransferred / CHUNK_SIZE);
      const msg: ResumeMessage = {
        type: "resume",
        fileId: currentFile?.id ?? "",
        fromChunkIndex: fromChunk,
      };
      this.dataChannel.send(JSON.stringify(msg));
    }

    this.setState("transferring");

    // Unblock the sending loop if it's waiting
    if (this.pauseResolve) {
      this.pauseResolve();
      this.pauseResolve = null;
    }
  }

  stop(): void {
    this.cleanup();
    this.setState("idle");
  }

  getState(): TransferState {
    return this.state;
  }

  getRole(): TransferRole {
    return this.role;
  }

  getBatchInfo(): BatchInfo | null {
    return this.batchInfo;
  }

  getFileStatuses(): FileTransferStatus[] {
    return [...this.fileStatuses];
  }

  // === Handshake Logic ===

  private async initiateHandshake(): Promise<void> {
    this.setState("handshaking");
    this.startHandshakeTimeout();

    const handshakeMsg = await this.securityManager.createHandshakeMessage();
    if (!this.signalingClient!.sendHandshakeVerify(handshakeMsg, this.peerId)) {
      this.handleError(new Error("Failed to send handshake: signaling connection lost"));
      return;
    }
    logger.info("Engine", "Sent handshake message");
  }

  private startHandshakeTimeout(): void {
    this.clearHandshakeTimeout();
    this.handshakeTimeout = setTimeout(() => {
      if (this.state === "handshaking") {
        this.handleError(new Error("Handshake timeout - peer did not respond"));
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
    if (!this.validatePayload(msg, ["publicKey"])) return;

    this.clearHandshakeTimeout();
    this.setState("handshaking");

    const payload = msg.payload as HandshakeMessage;
    this.peerId = msg.from ?? "";

    logger.info("Engine", "Received handshake", { peerId: this.peerId });

    const verified = await this.securityManager.processHandshakeMessage(payload);
    if (!verified) {
      this.handleError(new Error("Handshake failed - wrong code"));
      return;
    }

    logger.info("Engine", "Handshake verified");

    if (this.role === "receiver") {
      const handshakeMsg = await this.securityManager.createHandshakeMessage();
      if (!this.signalingClient!.sendHandshakeVerify(handshakeMsg, this.peerId)) {
        this.handleError(new Error("Failed to send handshake: signaling connection lost"));
        return;
      }
    }

    if (this.role === "sender") {
      await this.createPeerConnection();
      await this.createOffer();
    }
  }

  private validatePayload(msg: SignalingMessage, requiredFields: string[]): boolean {
    if (!msg.payload || typeof msg.payload !== "object") {
      logger.warn("Engine", "Missing or invalid payload", { type: msg.type });
      return false;
    }
    const payload = msg.payload as Record<string, unknown>;
    for (const field of requiredFields) {
      if (!(field in payload)) {
        logger.warn("Engine", "Missing required field in payload", {
          type: msg.type,
          field,
        });
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
      iceTransportPolicy:
        (import.meta.env.VITE_ICE_TRANSPORT_POLICY as RTCIceTransportPolicy) || "all",
    };

    this.peerConnection = new RTCPeerConnection(config);

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalingClient!.sendIceCandidate(event.candidate, this.peerId);
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const connState = this.peerConnection?.connectionState;
      logger.debug("Engine", "Connection state", { state: connState });

      if (connState === "connected") {
        this.clearConnectionTimeout();
        this.setState("ready");
        this.startDataChannelTimeout();
      } else if (connState === "failed") {
        if (this.state !== "completed") {
          this.handleError(new Error("Peer connection failed"));
        }
      } else if (connState === "disconnected") {
        if (this.state !== "completed") {
          this.events.onPeerDisconnected?.();
        }
      }
    };

    if (this.role === "sender") {
      this.dataChannel = this.peerConnection.createDataChannel("file-transfer", {
        ordered: true,
      });
      this.setupDataChannel();
    } else {
      this.peerConnection.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.setupDataChannel();
      };
    }

    this.connectionTimeout = setTimeout(() => {
      if (this.state !== "ready" && this.state !== "transferring" && this.state !== "completed") {
        this.handleError(
          new Error("WebRTC connection timed out - check network or firewall settings"),
        );
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
      if (this.state === "ready") {
        this.handleError(new Error("Data channel failed to open - connection may be blocked"));
      }
    }, TransferEngine.DATA_CHANNEL_TIMEOUT_MS);
  }

  private clearDataChannelTimeout(): void {
    if (this.dataChannelTimeout) {
      clearTimeout(this.dataChannelTimeout);
      this.dataChannelTimeout = null;
    }
  }

  private startPeerJoinTimeout(): void {
    this.clearPeerJoinTimeout();
    this.peerJoinTimeout = setTimeout(() => {
      if (this.state === "connecting" && this.role === "receiver") {
        this.handleError(
          new Error(
            "No one joined with this code. The sender may have disconnected or the code may be wrong.",
          ),
        );
      }
    }, TransferEngine.PEER_JOIN_TIMEOUT_MS);
  }

  private clearPeerJoinTimeout(): void {
    if (this.peerJoinTimeout) {
      clearTimeout(this.peerJoinTimeout);
      this.peerJoinTimeout = null;
    }
  }

  private setupDataChannel(): void {
    if (!this.dataChannel) return;

    this.dataChannel.binaryType = "arraybuffer";

    this.dataChannel.onopen = () => {
      logger.info("Engine", "Data channel open");
      this.clearDataChannelTimeout();

      if (this.role === "sender") {
        this.startBatchSend().catch((err) => {
          this.handleError(err instanceof Error ? err : new Error("Batch send failed"));
        });
      }
    };

    this.dataChannel.onclose = () => {
      logger.debug("Engine", "Data channel closed");
    };

    this.dataChannel.onerror = () => {
      if (this.state === "completed" || this.transferLogicallyComplete) {
        logger.debug("Engine", "Data channel error after completion (ignored)");
        return;
      }
      logger.error("Engine", "Data channel error");
      this.handleError(new Error("Data channel error"));
    };

    this.dataChannel.onmessage = (event) => {
      this.enqueueMessage(event.data);
    };
  }

  private enqueueMessage(data: ArrayBuffer | string): void {
    // M4: Prevent unbounded memory growth from a flooding peer
    if (this.messageQueue.length - this.queueHead > 4096) {
      this.handleError(new Error("Message queue overflow — peer sending too fast"));
      return;
    }
    this.messageQueue.push(data);
    if (!this.drainingQueue) {
      this.drainMessageQueue();
    }
  }

  private async drainMessageQueue(): Promise<void> {
    this.drainingQueue = true;
    try {
      while (this.queueHead < this.messageQueue.length) {
        const data = this.messageQueue[this.queueHead];
        this.queueHead++;

        if (this.queueHead > 1024) {
          this.messageQueue = this.messageQueue.slice(this.queueHead);
          this.queueHead = 0;
        }

        try {
          await this.handleDataMessage(data);
        } catch (error) {
          this.handleError(
            error instanceof Error ? error : new Error("Failed to handle data message"),
          );
        }
      }
    } finally {
      this.drainingQueue = false;
    }
  }

  private async createOffer(): Promise<void> {
    if (!this.peerConnection) return;

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);

    if (!this.signalingClient!.sendOffer(offer, this.peerId)) {
      this.handleError(new Error("Failed to send offer: signaling connection lost"));
      return;
    }
    logger.info("Engine", "Sent offer");
  }

  private async handleOffer(msg: SignalingMessage): Promise<void> {
    if (!this.validatePayload(msg, ["type", "sdp"])) return;

    this.peerId = msg.from ?? "";
    await this.createPeerConnection();

    const offer = msg.payload as RTCSessionDescriptionInit;
    await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(offer));
    this.remoteDescriptionSet = true;
    this.flushPendingIceCandidates();

    const answer = await this.peerConnection!.createAnswer();
    await this.peerConnection!.setLocalDescription(answer);

    if (!this.signalingClient!.sendAnswer(answer, this.peerId)) {
      this.handleError(new Error("Failed to send answer: signaling connection lost"));
      return;
    }
    logger.info("Engine", "Sent answer");
  }

  private async handleAnswer(msg: SignalingMessage): Promise<void> {
    if (!this.validatePayload(msg, ["type", "sdp"])) return;

    const answer = msg.payload as RTCSessionDescriptionInit;
    await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(answer));
    this.remoteDescriptionSet = true;
    this.flushPendingIceCandidates();
    logger.info("Engine", "Received answer");
  }

  private async handleIceCandidate(msg: SignalingMessage): Promise<void> {
    if (!this.validatePayload(msg, ["candidate"])) return;

    const candidate = msg.payload as RTCIceCandidateInit;

    if (!this.remoteDescriptionSet || !this.peerConnection) {
      this.pendingIceCandidates.push(candidate);
      return;
    }

    try {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      logger.warn("Engine", "Failed to add ICE candidate");
    }
  }

  private flushPendingIceCandidates(): void {
    if (!this.peerConnection || this.pendingIceCandidates.length === 0) return;

    logger.info("Engine", "Flushing queued ICE candidates", {
      count: this.pendingIceCandidates.length,
    });
    const candidates = this.pendingIceCandidates;
    this.pendingIceCandidates = [];

    for (const candidate of candidates) {
      this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {
        logger.warn("Engine", "Failed to add queued ICE candidate");
      });
    }
  }

  // === Batch Transfer Logic (Sender) ===

  private async startBatchSend(): Promise<void> {
    if (!this.batchInfo || !this.dataChannel) return;

    // Step 1: Send batch info
    const batchMsg: BatchMessage = {
      type: "batch",
      batch: this.batchInfo,
    };
    this.dataChannel.send(JSON.stringify(batchMsg));
    logger.info("Engine", "Sent batch info", {
      files: this.batchInfo.totalFiles,
    });

    // Step 2: Wait for batch-ack
    await this.waitForAck();

    this.setState("transferring");

    // Step 3: Send each file sequentially
    for (let i = 0; i < this.files.length; i++) {
      if (this.getState() === "error") return;

      this.currentFileIndex = i;
      const file = this.files[i];
      const status = this.fileStatuses[i];

      // Update status
      this.updateFileStatus(i, "transferring");

      // Reset per-file state
      this.currentFileBytesTransferred = 0;
      this.speedHistory = [];
      this.speedSum = 0;
      this.lastSpeedUpdate = Date.now();
      this.lastBytesForSpeed = 0;

      // Send file-start
      const fileStartMsg: FileStartMessage = {
        type: "file-start",
        fileId: status.id,
        fileIndex: i,
        metadata: {
          name: file.name,
          size: file.size,
          type: file.type || "application/octet-stream",
          hash: status.hash,
        },
      };
      this.dataChannel.send(JSON.stringify(fileStartMsg));
      logger.info("Engine", `Sending file ${i + 1}/${this.files.length}`, {
        name: file.name,
      });

      // Wait for file-ack
      await this.waitForAck();

      // Notify UI of current file metadata
      this.events.onFileMetadata?.({
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        hash: status.hash,
      });

      // Send chunks
      await this.sendFileChunks(file, i);

      if (this.getState() === "error") return;

      // Compute final hash from sender-side streaming hasher
      const senderHash = this.senderHasher?.digest() ?? "";
      this.senderHasher = null;

      // Update file status with computed hash
      this.fileStatuses[i] = { ...this.fileStatuses[i], hash: senderHash };

      // Send file-end with hash (hash computed while sending, not before)
      const fileEndMsg: FileEndMessage = {
        type: "file-end",
        fileId: status.id,
        hash: senderHash,
      };
      this.dataChannel.send(JSON.stringify(fileEndMsg));

      // Wait for file-receipt
      const receiptStatus = await this.waitForReceipt();

      if (receiptStatus === "verified") {
        this.updateFileStatus(i, "completed");
        this.events.onHashVerified?.(true);
        logger.info("Engine", `File ${i + 1} verified`);
      } else {
        this.updateFileStatus(i, "failed", "Hash verification failed");
        this.events.onHashVerified?.(false);
        logger.error("Engine", `File ${i + 1} hash mismatch`);
        // Continue with remaining files — don't abort batch
      }
    }

    // Step 4: Send batch-done
    this.transferLogicallyComplete = true;
    const batchDoneMsg: BatchDoneMessage = { type: "batch-done" };
    this.dataChannel.send(JSON.stringify(batchDoneMsg));

    // Force a final progress emission (small files may never trigger the 200ms throttle)
    this.emitFinalProgress();

    this.setState("completed");
    logger.info("Engine", "Batch transfer complete");
  }

  // Sender-side streaming hasher (computed while sending, not before)
  private senderHasher: StreamingHasher | null = null;

  private async sendFileChunks(file: File, fileIndex: number): Promise<void> {
    if (!this.dataChannel) return;

    // Initialize sender-side streaming hasher for this file
    this.senderHasher = new StreamingHasher();

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    for (let i = 0; i < totalChunks; i++) {
      // Check for pause
      if (this.paused) {
        await this.waitForResume();
      }

      if (this.getState() === "error") return;

      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);
      const buffer = await chunk.arrayBuffer();

      // Hash the raw chunk data (before encryption) for integrity verification
      this.senderHasher.update(new Uint8Array(buffer));

      // Encrypt chunk
      const encrypted = await this.securityManager.encryptChunk(buffer);

      // Prepend 4-byte file index for receiver validation
      const prefixed = new Uint8Array(4 + encrypted.byteLength);
      new DataView(prefixed.buffer).setUint32(0, fileIndex, true); // little-endian
      prefixed.set(new Uint8Array(encrypted), 4);

      // Backpressure
      if (this.dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
        await this.waitForBufferDrain(this.dataChannel);
      }

      this.dataChannel.send(prefixed.buffer);

      this.currentFileBytesTransferred = end;
      this.batchBytesTransferred =
        this.fileStatuses.slice(0, fileIndex).reduce((sum, s) => sum + s.size, 0) + end;

      this.fileStatuses[fileIndex] = {
        ...this.fileStatuses[fileIndex],
        bytesTransferred: end,
      };

      this.updateProgress();
    }

    logger.info("Engine", `All chunks sent for file ${fileIndex + 1}`);
  }

  private waitForResume(): Promise<void> {
    return new Promise((resolve) => {
      this.pauseResolve = resolve;
    });
  }

  private static readonly ACK_TIMEOUT_MS = 60_000;

  private waitForAck(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ackResolve = null;
        reject(new Error("Ack timeout — peer did not respond within 60 seconds"));
      }, TransferEngine.ACK_TIMEOUT_MS);
      this.ackResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private waitForReceipt(): Promise<"verified" | "failed"> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.receiptResolve = null;
        reject(new Error("Receipt timeout — peer did not verify within 60 seconds"));
      }, TransferEngine.ACK_TIMEOUT_MS);
      this.receiptResolve = (status) => {
        clearTimeout(timer);
        resolve(status);
      };
    });
  }

  private waitForBufferDrain(channel: RTCDataChannel): Promise<void> {
    return new Promise((resolve, reject) => {
      if (channel.readyState !== "open") {
        reject(new Error("Data channel closed during transfer"));
        return;
      }

      channel.bufferedAmountLowThreshold = BUFFER_THRESHOLD;

      const cleanup = () => {
        clearTimeout(timeout);
        channel.onbufferedamountlow = null;
        channel.removeEventListener("close", onClose);
      };

      const onClose = () => {
        cleanup();
        reject(new Error("Data channel closed during backpressure wait"));
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Transfer stalled - backpressure timeout"));
      }, 30_000);

      channel.addEventListener("close", onClose);
      channel.onbufferedamountlow = () => {
        cleanup();
        resolve();
      };
    });
  }

  // === Data Message Handler (Receiver + Sender receipt handling) ===

  private async handleDataMessage(data: ArrayBuffer | string): Promise<void> {
    if (typeof data === "string") {
      const msg = JSON.parse(data) as DataMessage;

      switch (msg.type) {
        // --- Batch protocol (new) ---
        case "batch":
          await this.handleBatchInfo(msg);
          break;

        case "batch-ack":
        case "file-ack":
          this.ackResolve?.();
          this.ackResolve = null;
          break;

        case "file-start":
          await this.handleFileStart(msg);
          break;

        case "file-end":
          await this.handleFileEnd(msg);
          break;

        case "file-receipt":
          this.receiptResolve?.(msg.status);
          this.receiptResolve = null;
          break;

        case "batch-done":
          this.transferLogicallyComplete = true;
          this.emitFinalProgress();
          this.setState("completed");
          logger.info("Engine", "Batch transfer complete (receiver)");
          break;

        case "pause":
          this.paused = true;
          this.setState("paused");
          if (this.dataChannel?.readyState === "open") {
            const ack: PauseAckMessage = {
              type: "pause-ack",
              fileId: msg.fileId,
              lastChunkIndex: msg.lastChunkIndex,
            };
            this.dataChannel.send(JSON.stringify(ack));
          }
          break;

        case "pause-ack":
          // Sender received ack — pause confirmed
          break;

        case "resume":
          this.paused = false;
          this.setState("transferring");
          if (this.pauseResolve) {
            this.pauseResolve();
            this.pauseResolve = null;
          }
          break;

        // --- Legacy single-file protocol (backward compat) ---
        case "metadata":
          await this.handleLegacyMetadata(msg);
          break;

        case "ack":
          this.ackResolve?.();
          this.ackResolve = null;
          break;

        case "done":
          await this.finishCurrentFile();
          this.transferLogicallyComplete = true;
          this.setState("completed");
          break;

        case "receipt":
          this.transferLogicallyComplete = true;
          if (msg.status === "verified") {
            this.setState("completed");
          } else {
            this.handleError(new Error("Receiver reported hash verification failed"));
          }
          break;
      }
    } else {
      // Binary chunk data
      await this.handleChunk(data);
    }
  }

  // --- Batch receiver handlers ---

  private async handleBatchInfo(msg: BatchMessage): Promise<void> {
    // H5: Validate batch bounds to prevent memory DoS from malicious peer
    const MAX_FILES_PER_BATCH = 1000;
    if (!msg.batch || !Array.isArray(msg.batch.files)) {
      this.handleError(new Error("Invalid batch: missing file list"));
      return;
    }
    if (msg.batch.files.length === 0 || msg.batch.files.length > MAX_FILES_PER_BATCH) {
      this.handleError(
        new Error(`Invalid batch: file count out of range (${msg.batch.files.length})`),
      );
      return;
    }
    for (const f of msg.batch.files) {
      if (!f.name || typeof f.name !== "string" || f.name.length > 1024) {
        this.handleError(new Error("Invalid batch: bad file name"));
        return;
      }
      if (typeof f.size !== "number" || f.size <= 0 || f.size > MAX_FILE_SIZE) {
        this.handleError(new Error(`Invalid batch: file size out of range`));
        return;
      }
    }

    this.batchInfo = msg.batch;

    // Initialize file statuses for receiver
    this.fileStatuses = msg.batch.files.map((f) => ({
      id: f.id,
      name: f.name,
      size: f.size,
      status: "pending" as const,
      bytesTransferred: 0,
    }));

    this.events.onBatchInfo?.(this.batchInfo);
    this.events.onFileStatusChange?.([...this.fileStatuses]);

    logger.info("Engine", "Received batch info", {
      files: msg.batch.totalFiles,
      totalBytes: msg.batch.totalBytes,
    });

    // Ack
    if (this.dataChannel?.readyState === "open") {
      const ack: BatchAckMessage = { type: "batch-ack" };
      this.dataChannel.send(JSON.stringify(ack));
    }
  }

  private async handleFileStart(msg: FileStartMessage): Promise<void> {
    this.currentFileIndex = msg.fileIndex;
    this.currentFileBytesTransferred = 0;
    this.currentFileMetadata = msg.metadata;

    // Sanitize filename
    this.currentFileMetadata.name = (this.currentFileMetadata.name || "")
      .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/[/\\:]/g, "_")
      .replace(/\.\./g, "_")
      .trim();

    // Validate
    if (!this.currentFileMetadata.name || this.currentFileMetadata.name.length === 0) {
      this.handleError(new Error("Invalid file: missing name"));
      return;
    }
    if (this.currentFileMetadata.size <= 0 || this.currentFileMetadata.size > MAX_FILE_SIZE) {
      this.handleError(
        new Error(
          `File size (${formatFileSize(this.currentFileMetadata.size)}) exceeds maximum allowed size of ${MAX_FILE_SIZE_DISPLAY}`,
        ),
      );
      return;
    }

    // Update status
    this.updateFileStatus(msg.fileIndex, "transferring");
    this.events.onFileMetadata?.(this.currentFileMetadata);

    // Setup download stream for this file
    this.writeStream = streamSaver.createWriteStream(this.currentFileMetadata.name, {
      size: this.currentFileMetadata.size,
    });
    this.writer = this.writeStream.getWriter();
    this.streamingHasher = new StreamingHasher();

    if (this.state !== "transferring") {
      this.setState("transferring");
    }

    // Ack
    if (this.dataChannel?.readyState === "open") {
      const ack: FileAckMessage = { type: "file-ack", fileId: msg.fileId };
      this.dataChannel.send(JSON.stringify(ack));
    }

    logger.info("Engine", `Receiving file ${msg.fileIndex + 1}`, {
      name: this.currentFileMetadata.name,
    });
  }

  private async handleFileEnd(msg: FileEndMessage): Promise<void> {
    await this.finishCurrentFile();

    // Verify hash — sender's hash may come in file-end (new) or file-start metadata (legacy)
    let verified = true;
    const expectedHash = msg.hash ?? this.currentFileMetadata?.hash;
    if (expectedHash && this.streamingHasher) {
      const actualHash = this.streamingHasher.digest();
      verified = actualHash === expectedHash;
    }

    // Update status
    if (verified) {
      this.updateFileStatus(this.currentFileIndex, "completed");
      this.events.onHashVerified?.(true);
    } else {
      this.updateFileStatus(this.currentFileIndex, "failed", "Hash verification failed");
      this.events.onHashVerified?.(false);
    }

    // Send receipt
    if (this.dataChannel?.readyState === "open") {
      const receipt: FileReceiptMessage = {
        type: "file-receipt",
        fileId: msg.fileId,
        status: verified ? "verified" : "failed",
      };
      this.dataChannel.send(JSON.stringify(receipt));
    }

    // Cleanup per-file state
    this.streamingHasher = null;
    this.currentFileMetadata = null;

    logger.info("Engine", `File ${this.currentFileIndex + 1} ${verified ? "verified" : "FAILED"}`);
  }

  private async finishCurrentFile(): Promise<void> {
    if (this.writer) {
      try {
        await this.writer.close();
      } catch {
        logger.warn("Engine", "Writer close error (file may still be saved)");
      }
      this.writer = null;
      this.writeStream = null;
    }
  }

  // --- Legacy single-file handler (backward compat) ---

  private async handleLegacyMetadata(msg: LegacyMetadataMessage): Promise<void> {
    // Wrap single file as a batch of 1
    const fileId = crypto.randomUUID();
    const metadata = msg.metadata!;

    // Sanitize filename
    metadata.name = (metadata.name || "")
      .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/[/\\:]/g, "_")
      .replace(/\.\./g, "_")
      .trim();

    if (!metadata.name || metadata.name.length === 0) {
      this.handleError(new Error("Invalid file: missing name"));
      return;
    }
    if (metadata.size <= 0 || metadata.size > MAX_FILE_SIZE) {
      this.handleError(
        new Error(
          `File size (${formatFileSize(metadata.size)}) exceeds maximum allowed size of ${MAX_FILE_SIZE_DISPLAY}`,
        ),
      );
      return;
    }

    // Create synthetic batch
    this.batchInfo = {
      totalFiles: 1,
      totalBytes: metadata.size,
      files: [
        {
          id: fileId,
          name: metadata.name,
          size: metadata.size,
          type: metadata.type,
        },
      ],
    };
    this.fileStatuses = [
      {
        id: fileId,
        name: metadata.name,
        size: metadata.size,
        status: "transferring",
        bytesTransferred: 0,
        hash: metadata.hash,
      },
    ];
    this.currentFileIndex = 0;
    this.currentFileBytesTransferred = 0;
    this.currentFileMetadata = metadata;

    this.events.onBatchInfo?.(this.batchInfo);
    this.events.onFileMetadata?.(metadata);

    // Setup download stream
    this.writeStream = streamSaver.createWriteStream(metadata.name, {
      size: metadata.size,
    });
    this.writer = this.writeStream.getWriter();
    this.streamingHasher = new StreamingHasher();

    this.setState("transferring");

    // Ack
    this.dataChannel!.send(JSON.stringify({ type: "ack" }));
  }

  // --- Chunk handler (both batch and legacy) ---

  private async handleChunk(data: ArrayBuffer): Promise<void> {
    if (!this.writer) {
      logger.warn("Engine", "No writer available for chunk");
      return;
    }

    try {
      let encrypted: ArrayBuffer;

      // Batch protocol: sender always prepends 4-byte fileIndex (LE).
      // Legacy protocol (no batchInfo from 'batch' message): no prefix.
      if (this.batchInfo && data.byteLength > 4) {
        // Validate file index matches current file (L2)
        const receivedIndex = new DataView(data).getUint32(0, true);
        if (receivedIndex !== this.currentFileIndex) {
          this.handleError(
            new Error(
              `Chunk file index mismatch: expected ${this.currentFileIndex}, got ${receivedIndex}`,
            ),
          );
          return;
        }
        // Strip the 4-byte prefix
        encrypted = data.slice(4);
      } else {
        // Legacy format — entire buffer is the encrypted chunk
        encrypted = data;
      }

      const decrypted = await this.securityManager.decryptChunk(encrypted);
      const chunk = new Uint8Array(decrypted);

      this.streamingHasher?.update(chunk);
      await this.writer.write(chunk);

      this.currentFileBytesTransferred += decrypted.byteLength;

      // Update batch bytes
      const completedBytes = this.fileStatuses
        .slice(0, this.currentFileIndex)
        .reduce((sum, s) => sum + (s.status === "completed" ? s.size : 0), 0);
      this.batchBytesTransferred = completedBytes + this.currentFileBytesTransferred;

      if (this.fileStatuses[this.currentFileIndex]) {
        this.fileStatuses[this.currentFileIndex] = {
          ...this.fileStatuses[this.currentFileIndex],
          bytesTransferred: this.currentFileBytesTransferred,
        };
      }

      this.updateProgress();
    } catch {
      logger.error("Engine", "Chunk handling error");
      this.handleError(new Error("Decryption failed - possible tampering"));
    }
  }

  // === Progress ===

  private updateProgress(): void {
    const now = Date.now();
    const currentFileSize =
      this.currentFileMetadata?.size ?? this.fileStatuses[this.currentFileIndex]?.size ?? 0;
    const batchTotalBytes = this.batchInfo?.totalBytes ?? currentFileSize;

    if (now - this.lastSpeedUpdate < 200) return;

    const bytesDelta = this.batchBytesTransferred - this.lastBytesForSpeed;
    const timeDelta = (now - this.lastSpeedUpdate) / 1000;
    const speed = timeDelta > 0 ? bytesDelta / timeDelta : 0;

    this.speedHistory.push(speed);
    this.speedSum += speed;
    if (this.speedHistory.length > 50) {
      this.speedSum -= this.speedHistory.shift()!;
    }

    this.lastSpeedUpdate = now;
    this.lastBytesForSpeed = this.batchBytesTransferred;

    const avgSpeed = this.speedHistory.length > 0 ? this.speedSum / this.speedHistory.length : 0;
    const remaining = batchTotalBytes - this.batchBytesTransferred;
    const eta = avgSpeed > 0 ? remaining / avgSpeed : 0;

    const progress: TransferProgress = {
      bytesTransferred: this.currentFileBytesTransferred,
      totalBytes: currentFileSize,
      percentage:
        currentFileSize > 0 ? (this.currentFileBytesTransferred / currentFileSize) * 100 : 0,
      speed: avgSpeed,
      speedHistory: [...this.speedHistory],
      eta,
      fileIndex: this.currentFileIndex,
      totalFiles: this.batchInfo?.totalFiles ?? 1,
      batchBytesTransferred: this.batchBytesTransferred,
      batchTotalBytes,
      batchPercentage:
        batchTotalBytes > 0 ? (this.batchBytesTransferred / batchTotalBytes) * 100 : 0,
    };

    this.events.onProgress?.(progress);
  }

  // Emit a final progress snapshot ignoring the 200ms throttle.
  // Needed because very small files (<64KB) transfer in <200ms and
  // updateProgress never fires, leaving the UI with stale batch fields.
  private emitFinalProgress(): void {
    const batchTotalBytes = this.batchInfo?.totalBytes ?? 0;
    const progress: TransferProgress = {
      bytesTransferred: this.currentFileBytesTransferred,
      totalBytes:
        this.currentFileMetadata?.size ?? this.fileStatuses[this.currentFileIndex]?.size ?? 0,
      percentage: 100,
      speed: 0,
      speedHistory: [...this.speedHistory],
      eta: 0,
      fileIndex: this.currentFileIndex,
      totalFiles: this.batchInfo?.totalFiles ?? 1,
      batchBytesTransferred: batchTotalBytes,
      batchTotalBytes,
      batchPercentage: 100,
    };
    this.events.onProgress?.(progress);
  }

  // === File Status Updates ===

  private updateFileStatus(
    index: number,
    status: FileTransferStatus["status"],
    error?: string,
  ): void {
    if (!this.fileStatuses[index]) return;
    this.fileStatuses[index] = {
      ...this.fileStatuses[index],
      status,
      ...(error ? { error } : {}),
    };
    this.events.onFileStatusChange?.([...this.fileStatuses]);
  }

  // === State Management ===

  private setState(state: TransferState): void {
    this.state = state;
    this.events.onStateChange?.(state);
    logger.debug("Engine", "State transition", { state });
  }

  private handleError(error: Error): void {
    if (this.state === "completed" || this.transferLogicallyComplete) {
      logger.debug("Engine", "Error after completion (ignored)", {
        error: error.message,
      });
      return;
    }
    logger.error("Engine", "Error", { error: error.message });
    this.setState("error");
    this.events.onError?.(error);
    this.cleanup();
  }

  private handleSignalingClose(): void {
    if (this.state === "transferring" || this.state === "completed" || this.state === "paused") {
      return;
    }
    if (this.state === "connecting" || this.state === "handshaking") {
      this.handleError(new Error("Server connection lost during setup"));
      return;
    }
    if (this.state === "ready") {
      logger.warn("Engine", "Signaling lost in ready state - late ICE candidates cannot arrive");
      return;
    }
    if (this.state !== "idle") {
      this.events.onPeerDisconnected?.();
    }
  }

  private cleanup(): void {
    this.clearConnectionTimeout();
    this.clearHandshakeTimeout();
    this.clearDataChannelTimeout();
    this.clearPeerJoinTimeout();

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

    this.files = [];
    this.batchInfo = null;
    this.fileStatuses = [];
    this.currentFileIndex = 0;
    this.batchBytesTransferred = 0;
    this.currentFileBytesTransferred = 0;
    this.currentFileMetadata = null;
    this.speedHistory = [];
    this.speedSum = 0;
    this.streamingHasher = null;
    this.pendingIceCandidates = [];
    this.remoteDescriptionSet = false;
    this.messageQueue = [];
    this.queueHead = 0;
    this.drainingQueue = false;
    this.paused = false;
    this.pauseResolve = null;
    this.ackResolve = null;
    this.receiptResolve = null;
  }

  destroy(): void {
    this.cleanup();
  }
}

// Re-export types from types/index.ts for convenience
export type {
  FileMetadata,
  TransferRole,
  TransferState,
  TransferProgress,
  BatchInfo,
  FileTransferStatus,
} from "../types";
export { MAX_FILE_SIZE, MAX_FILE_SIZE_DISPLAY, FileSizeError, formatFileSize } from "../types";
