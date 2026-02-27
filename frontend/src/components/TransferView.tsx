import { useMemo } from 'react';
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

function SpeedGraph({ speedHistory }: { speedHistory: number[] }) {
  const { points, areaPath } = useMemo(() => {
    if (speedHistory.length < 2) return { points: '', areaPath: '' };

    const maxSpeed = Math.max(...speedHistory, 1);
    const width = 300;
    const height = 80;
    const padding = 10;
    const usableHeight = height - 2 * padding;
    const xStep = (width - 2 * padding) / (speedHistory.length - 1);

    let linePath = '';
    let area = `M ${padding} ${height - padding}`;

    for (let i = 0; i < speedHistory.length; i++) {
      const x = padding + i * xStep;
      const y = height - padding - (speedHistory[i] / maxSpeed) * usableHeight;
      linePath += `${i === 0 ? 'M' : ' L'} ${x} ${y}`;
      area += ` L ${x} ${y}`;
    }

    area += ` L ${padding + (speedHistory.length - 1) * xStep} ${height - padding} Z`;

    return { points: linePath, areaPath: area };
  }, [speedHistory]);

  return (
    <div className="relative w-full h-20 mt-4 rounded-lg glass-panel overflow-hidden">
      <svg width="100%" height="100%" viewBox="0 0 300 80" preserveAspectRatio="none">
        {/* Grid lines */}
        <line x1="10" y1="25" x2="290" y2="25" stroke="#00ff41" strokeOpacity="0.1" strokeWidth="1" />
        <line x1="10" y1="50" x2="290" y2="50" stroke="#00ff41" strokeOpacity="0.1" strokeWidth="1" />

        {/* Area fill */}
        {areaPath && (
          <motion.path d={areaPath} fill="url(#speedGradient)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} />
        )}

        {/* Line */}
        {points && (
          <motion.path
            d={points}
            fill="none"
            stroke="#00ff41"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter="drop-shadow(0 0 4px rgba(0, 255, 65, 0.5))"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.3 }}
          />
        )}

        {/* Gradient definition */}
        <defs>
          <linearGradient id="speedGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#00ff41" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#00ff41" stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>

      {/* Speed label */}
      <div className="absolute top-1 right-2 text-[#00ff41]/60 text-xs font-mono">
        {formatSpeed(speedHistory.at(-1) ?? 0)}
      </div>
    </div>
  );
}

export function TransferView({ state, progress, fileMetadata, role }: TransferViewProps) {
  const isComplete = state === 'completed';
  const percentage = progress?.percentage ?? 0;

  return (
    <motion.div
      className="relative w-full max-w-lg glass-panel glass-glow rounded-2xl p-5 md:p-8"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <motion.div
            className={`w-3 h-3 rounded-full ${isComplete ? 'bg-[#00ff41]' : 'bg-[#00ff41]/50'}`}
            animate={
              isComplete
                ? {
                    boxShadow: [
                      '0 0 4px rgba(0, 255, 65, 0.5)',
                      '0 0 12px rgba(0, 255, 65, 0.8)',
                      '0 0 4px rgba(0, 255, 65, 0.5)'
                    ]
                  }
                : { opacity: [0.5, 1, 0.5] }
            }
            transition={{ duration: 1, repeat: Infinity }}
          />
          <span className="text-[#00ff41] font-medium text-glow">
            {isComplete ? 'Transfer Complete' : role === 'sender' ? 'Sending...' : 'Receiving...'}
          </span>
        </div>

        {progress && !isComplete && <span className="text-[#00ff41]/60 text-sm">ETA: {formatTime(progress.eta)}</span>}
      </div>

      {/* File info */}
      {fileMetadata && (
        <div className="flex items-center gap-3 mb-6 px-4 py-3 glass-panel rounded-lg">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#00ff41"
            strokeWidth="1.5"
            className="drop-shadow-[0_0_4px_rgba(0,255,65,0.5)]"
          >
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
            <polyline points="13 2 13 9 20 9" />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-[#00ff41] text-sm truncate">{fileMetadata.name}</p>
            <p className="text-[#00ff41]/50 text-xs">{formatFileSize(fileMetadata.size)}</p>
          </div>
          {fileMetadata.hash && (
            <div className="flex items-center gap-1 text-[#00ff41]/40 text-xs" title={`SHA-256: ${fileMetadata.hash}`}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span>Verified</span>
            </div>
          )}
        </div>
      )}

      {/* Progress bar */}
      <div className="relative h-4 glass-panel rounded-full overflow-hidden mb-2">
        <motion.div
          className="absolute inset-y-0 left-0 bg-gradient-to-r from-[#00ff41]/70 to-[#00ff41] rounded-full"
          style={{ width: `${percentage}%` }}
          initial={{ width: 0 }}
          animate={{ width: `${percentage}%` }}
          transition={{ duration: 0.3 }}
        />

        {/* Glow effect */}
        <motion.div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${percentage}%`,
            boxShadow: '0 0 20px rgba(0, 255, 65, 0.5), 0 0 40px rgba(0, 255, 65, 0.3)'
          }}
        />

        {/* Shimmer effect */}
        {!isComplete && (
          <motion.div
            className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent"
            animate={{ x: ['-100%', '200%'] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
          />
        )}
      </div>

      {/* Stats row */}
      <div className="flex flex-col gap-1 md:flex-row md:justify-between text-sm mb-4">
        <span className="text-[#00ff41] font-mono text-glow">{percentage.toFixed(1)}%</span>
        {progress && (
          <span className="text-[#00ff41]/50 font-mono">
            {formatFileSize(progress.bytesTransferred)} / {formatFileSize(progress.totalBytes)}
          </span>
        )}
      </div>

      {/* Speed graph */}
      {progress && progress.speedHistory.length > 1 && <SpeedGraph speedHistory={progress.speedHistory} />}

      {/* Completion message */}
      {isComplete && (
        <motion.div className="mt-6 text-center" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <motion.div
            className="inline-flex items-center gap-2 px-6 py-3 glass-button rounded-lg neon-border"
            initial={{ scale: 0.9 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 200 }}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#00ff41"
              strokeWidth="2"
              className="drop-shadow-[0_0_6px_rgba(0,255,65,0.8)]"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span className="text-[#00ff41] font-medium text-glow">
              {role === 'receiver' ? 'File saved!' : 'File sent successfully!'}
            </span>
          </motion.div>
        </motion.div>
      )}

      {/* Decorative corners */}
      <div className="absolute top-2 left-2 w-5 h-5 border-l-2 border-t-2 border-[#00ff41]/40 rounded-tl pointer-events-none" />
      <div className="absolute top-2 right-2 w-5 h-5 border-r-2 border-t-2 border-[#00ff41]/40 rounded-tr pointer-events-none" />
      <div className="absolute bottom-2 left-2 w-5 h-5 border-l-2 border-b-2 border-[#00ff41]/40 rounded-bl pointer-events-none" />
      <div className="absolute bottom-2 right-2 w-5 h-5 border-r-2 border-b-2 border-[#00ff41]/40 rounded-br pointer-events-none" />
    </motion.div>
  );
}
