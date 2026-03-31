export type TransferRole = "sender" | "receiver";

export type TransferState =
  | "idle"
  | "connecting"
  | "handshaking"
  | "ready"
  | "preparing" // computing hashes for batch before transfer
  | "transferring"
  | "paused" // user-initiated pause (connection alive)
  | "resuming" // reconnecting after pause/disconnect
  | "completed"
  | "error";

export interface FileMetadata {
  name: string;
  size: number;
  type: string;
  hash?: string; // SHA-256 hash for integrity verification
}

export interface TransferProgress {
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
  speed: number;
  speedHistory: number[];
  eta: number;
  // Batch context — always present (single file = batch of 1)
  fileIndex: number;
  totalFiles: number;
  batchBytesTransferred: number;
  batchTotalBytes: number;
  batchPercentage: number;
}

// --- Batch transfer types ---

export interface BatchFileInfo {
  id: string; // crypto.randomUUID()
  name: string;
  size: number;
  type: string;
}

export interface BatchInfo {
  totalFiles: number;
  totalBytes: number;
  files: BatchFileInfo[];
}

export type FileTransferStatusValue =
  | "pending"
  | "transferring"
  | "completed"
  | "failed"
  | "skipped";

export interface FileTransferStatus {
  id: string;
  name: string;
  size: number;
  status: FileTransferStatusValue;
  bytesTransferred: number;
  hash?: string;
  verified?: boolean;
  error?: string;
}

// No hard file size limit — streaming architecture handles any size.
// Practical limit is disk space + browser tab lifetime.
export const MAX_FILE_SIZE = Number.MAX_SAFE_INTEGER;
export const MAX_FILE_SIZE_DISPLAY = "unlimited" as const;

// Custom error for file size validation
export class FileSizeError extends Error {
  constructor(fileSize: number) {
    const sizeDisplay = formatFileSize(fileSize);
    super(`File size (${sizeDisplay}) exceeds maximum allowed size of ${MAX_FILE_SIZE_DISPLAY}`);
    this.name = "FileSizeError";
  }
}

// Utility function to format file size
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"] as const;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

// --- File category detection ---

export type FileCategory = "image" | "video" | "audio" | "document" | "archive" | "code" | "other";

const extensionToCategory: Record<string, FileCategory> = {
  // Image
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  bmp: "image",
  ico: "image",
  tiff: "image",
  avif: "image",
  // Video
  mp4: "video",
  mkv: "video",
  avi: "video",
  mov: "video",
  webm: "video",
  flv: "video",
  wmv: "video",
  m4v: "video",
  // Audio
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  flac: "audio",
  aac: "audio",
  wma: "audio",
  m4a: "audio",
  opus: "audio",
  // Document
  pdf: "document",
  doc: "document",
  docx: "document",
  xls: "document",
  xlsx: "document",
  ppt: "document",
  pptx: "document",
  txt: "document",
  csv: "document",
  rtf: "document",
  odt: "document",
  ods: "document",
  // Archive
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
  bz2: "archive",
  xz: "archive",
  dmg: "archive",
  iso: "archive",
  // Code
  js: "code",
  ts: "code",
  jsx: "code",
  tsx: "code",
  py: "code",
  rb: "code",
  go: "code",
  rs: "code",
  java: "code",
  c: "code",
  cpp: "code",
  h: "code",
  css: "code",
  html: "code",
  json: "code",
  xml: "code",
  yaml: "code",
  yml: "code",
  sh: "code",
  sql: "code",
};

export function getFileCategory(fileName: string): FileCategory {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return extensionToCategory[ext] ?? "other";
}

// --- Transfer time estimate ---

const ASSUMED_WIFI_SPEED_BYTES = 5 * 1024 * 1024; // ~5 MB/s

export function getEstimatedTransferTime(bytes: number): string {
  if (bytes <= 0) return "instant";
  const seconds = bytes / ASSUMED_WIFI_SPEED_BYTES;
  if (seconds < 1) return "< 1 sec";
  if (seconds < 60) return `~${Math.ceil(seconds)} sec`;
  const minutes = Math.ceil(seconds / 60);
  return `~${minutes} min`;
}

// --- Structured errors ---

export interface AppError {
  code: string;
  message: string;
  suggestion: string;
  recoverable: boolean;
}

interface ErrorMapping {
  match: string;
  error: AppError;
}

const errorMappings: ErrorMapping[] = [
  {
    match: "No one joined",
    error: {
      code: "PEER_NOT_FOUND",
      message: "No one is sharing with this code",
      suggestion: "The sender may have disconnected. Ask them for a new code.",
      recoverable: true,
    },
  },
  {
    match: "wrong code",
    error: {
      code: "WRONG_CODE",
      message: "Invalid transfer code",
      suggestion: "Double-check the 6-digit code and try again.",
      recoverable: true,
    },
  },
  {
    match: "Room expired",
    error: {
      code: "ROOM_EXPIRED",
      message: "Session expired",
      suggestion: "The sender needs to share a new code. Ask them to start again.",
      recoverable: true,
    },
  },
  {
    match: "Peer disconnected",
    error: {
      code: "PEER_DISCONNECTED",
      message: "Peer disconnected",
      suggestion: "The other device left. Make sure both devices stay on the same network.",
      recoverable: true,
    },
  },
  {
    match: "Peer connection failed",
    error: {
      code: "CONNECTION_FAILED",
      message: "Could not connect to peer",
      suggestion:
        "Both devices must be on the same WiFi network. Check your connection and try again.",
      recoverable: true,
    },
  },
  {
    match: "Data channel error",
    error: {
      code: "CHANNEL_ERROR",
      message: "Connection dropped",
      suggestion: "The transfer was interrupted. Try again — it usually works on a second attempt.",
      recoverable: true,
    },
  },
  {
    match: "Connection timeout",
    error: {
      code: "CONNECTION_TIMEOUT",
      message: "Server is not responding",
      suggestion: "The signaling server may be down. Try again in a moment.",
      recoverable: true,
    },
  },
  {
    match: "Could not connect to server",
    error: {
      code: "SERVER_UNREACHABLE",
      message: "Cannot reach the server",
      suggestion:
        "Check your internet connection. A firewall may be blocking WebSocket connections.",
      recoverable: true,
    },
  },
  {
    match: "Connection closed before",
    error: {
      code: "CONNECTION_REJECTED",
      message: "Connection was rejected",
      suggestion: "The server closed the connection. Wait a minute and try again.",
      recoverable: true,
    },
  },
  {
    match: "Signaling error",
    error: {
      code: "SIGNALING_ERROR",
      message: "Server connection lost",
      suggestion: "Check your internet connection and try again.",
      recoverable: true,
    },
  },
  {
    match: "Room is full",
    error: {
      code: "ROOM_FULL",
      message: "Room is full",
      suggestion: "This room already has two peers connected. Check your code and try again.",
      recoverable: true,
    },
  },
  {
    match: "Room ID required",
    error: {
      code: "INVALID_REQUEST",
      message: "Invalid request",
      suggestion: "Something went wrong. Please try again.",
      recoverable: true,
    },
  },
  {
    match: "Must join a room",
    error: {
      code: "INVALID_REQUEST",
      message: "Connection error",
      suggestion: "Messages were sent before joining a room. Please try again.",
      recoverable: true,
    },
  },
  {
    match: "Failed to join room",
    error: {
      code: "JOIN_FAILED",
      message: "Could not join room",
      suggestion: "Server connection was lost. Check your internet and try again.",
      recoverable: true,
    },
  },
  {
    match: "Failed to send offer",
    error: {
      code: "SIGNALING_LOST_SETUP",
      message: "Lost connection to server",
      suggestion:
        "The signaling server disconnected during setup. Check your internet and try again.",
      recoverable: true,
    },
  },
  {
    match: "Failed to send answer",
    error: {
      code: "SIGNALING_LOST_SETUP",
      message: "Lost connection to server",
      suggestion:
        "The signaling server disconnected during setup. Check your internet and try again.",
      recoverable: true,
    },
  },
  {
    match: "Failed to send handshake",
    error: {
      code: "SIGNALING_LOST_SETUP",
      message: "Lost connection to server",
      suggestion:
        "The signaling server disconnected during setup. Check your internet and try again.",
      recoverable: true,
    },
  },
  {
    match: "WebRTC connection timed out",
    error: {
      code: "WEBRTC_TIMEOUT",
      message: "Connection timed out",
      suggestion:
        "Could not establish a direct connection. A firewall or strict network may be blocking WebRTC. Try a different network.",
      recoverable: true,
    },
  },
  {
    match: "Server connection lost during setup",
    error: {
      code: "SIGNALING_LOST_SETUP",
      message: "Lost connection to server",
      suggestion:
        "The signaling server disconnected during setup. Check your internet and try again.",
      recoverable: true,
    },
  },
  {
    match: "Decryption failed",
    error: {
      code: "DECRYPTION_FAILED",
      message: "Decryption failed",
      suggestion: "The data was corrupted in transit. Try the transfer again.",
      recoverable: true,
    },
  },
  {
    match: "integrity check failed",
    error: {
      code: "INTEGRITY_FAILED",
      message: "File verification failed",
      suggestion: "The file was corrupted during transfer. Please try again.",
      recoverable: true,
    },
  },
  {
    match: "hash verification failed",
    error: {
      code: "HASH_FAILED",
      message: "File verification failed",
      suggestion: "The received file does not match the original. Try sending again.",
      recoverable: true,
    },
  },
];

export function mapErrorToAppError(rawMessage: string): AppError {
  const lower = rawMessage.toLowerCase();
  for (const mapping of errorMappings) {
    if (lower.includes(mapping.match.toLowerCase())) {
      return mapping.error;
    }
  }
  return {
    code: "UNKNOWN",
    message: "Something went wrong",
    suggestion: "Try again. If the problem persists, refresh the page.",
    recoverable: true,
  };
}

// --- Connection phase ---

export type ConnectionPhase = "waiting-for-peer" | "peer-connected" | "securing" | "ready";
