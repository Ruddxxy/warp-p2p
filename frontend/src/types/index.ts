export type TransferRole = 'sender' | 'receiver';

export type TransferState =
  | 'idle'
  | 'connecting'
  | 'handshaking'
  | 'ready'
  | 'transferring'
  | 'completed'
  | 'error';

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
}

// File size constants
export const MAX_FILE_SIZE = 25 * 1024 * 1024 * 1024 satisfies number; // 25GB
export const MAX_FILE_SIZE_DISPLAY = '25 GB' as const;

// Custom error for file size validation
export class FileSizeError extends Error {
  constructor(fileSize: number) {
    const sizeDisplay = formatFileSize(fileSize);
    super(`File size (${sizeDisplay}) exceeds maximum allowed size of ${MAX_FILE_SIZE_DISPLAY}`);
    this.name = 'FileSizeError';
  }
}

// Utility function to format file size
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
