import { motion } from 'framer-motion';
import { formatFileSize, type TransferProgress, type FileMetadata, type TransferState } from '../types';

interface TransferViewProps {
  state: TransferState;
  progress: TransferProgress | null;
  fileMetadata: FileMetadata | null;
  role: 'sender' | 'receiver';
}

function formatSpeed(bytesPerSec: number): string {
  return `${formatFileSize(bytesPerSec)}/s`;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function TransferView({ state, progress, fileMetadata, role }: TransferViewProps) {
  const isComplete = state === 'completed';
  const percentage = progress?.percentage ?? 0;

  return (
    <motion.div
      className="w-full max-w-lg bg-surface border border-border rounded-2xl p-5 md:p-8"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div
            className={`w-2.5 h-2.5 rounded-full ${isComplete ? 'bg-success' : 'bg-primary animate-pulse'}`}
          />
          <span className="text-text font-medium">
            {isComplete ? 'Transfer complete' : role === 'sender' ? 'Sending...' : 'Receiving...'}
          </span>
        </div>

        {progress && !isComplete && (
          <span className="text-text-faint text-sm">ETA {formatTime(progress.eta)}</span>
        )}
      </div>

      {/* File info */}
      {fileMetadata && (
        <div className="flex items-center gap-3 mb-6 px-4 py-3 bg-bg rounded-lg border border-border">
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-text-muted flex-shrink-0"
            aria-hidden="true"
          >
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
            <polyline points="13 2 13 9 20 9" />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-text text-sm truncate">{fileMetadata.name}</p>
            <p className="text-text-faint text-xs">{formatFileSize(fileMetadata.size)}</p>
          </div>
          {fileMetadata.hash && (
            <div className="flex items-center gap-1 text-success text-xs flex-shrink-0">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>Verified</span>
            </div>
          )}
        </div>
      )}

      {/* Progress bar */}
      <div className="relative h-2 bg-bg rounded-full overflow-hidden mb-3">
        <motion.div
          className={`absolute inset-y-0 left-0 rounded-full ${isComplete ? 'bg-success' : 'bg-primary'}`}
          style={{ width: `${percentage}%` }}
          initial={{ width: 0 }}
          animate={{ width: `${percentage}%` }}
          transition={{ duration: 0.3 }}
        />
      </div>

      {/* Stats row */}
      <div className="flex flex-col gap-1 md:flex-row md:justify-between text-sm mb-2">
        <span className="text-text font-mono">{percentage.toFixed(1)}%</span>
        {progress && (
          <div className="flex gap-3 text-text-faint font-mono text-xs">
            <span>{formatFileSize(progress.bytesTransferred)} / {formatFileSize(progress.totalBytes)}</span>
            {progress.speed > 0 && <span>{formatSpeed(progress.speed)}</span>}
          </div>
        )}
      </div>

      {/* Completion message */}
      {isComplete && (
        <motion.div className="mt-6 text-center" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="inline-flex items-center gap-2 px-5 py-3 bg-success-muted border border-success/30 rounded-xl">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#22C55E"
              strokeWidth="2"
              aria-hidden="true"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span className="text-success font-medium text-sm">
              {role === 'receiver' ? 'File saved!' : 'File sent successfully!'}
            </span>
          </div>
        </motion.div>
      )}
    </motion.div>
  );
}
