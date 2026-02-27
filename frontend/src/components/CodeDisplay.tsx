import { motion, AnimatePresence } from 'framer-motion';
import { useState, useCallback } from 'react';
import QRCode from 'qrcode';
import { formatFileSize, getFileCategory, getEstimatedTransferTime, type FileCategory, type ConnectionPhase } from '../types';

interface CodeDisplayProps {
  code: string;
  fileName: string;
  fileSize: number;
  connectionPhase: ConnectionPhase | null;
}

// --- File type icon per category ---

function FileTypeIcon({ category }: { category: FileCategory }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: '#00ff41',
    strokeWidth: 2,
    className: 'drop-shadow-[0_0_4px_rgba(0,255,65,0.5)]',
  } as const;

  switch (category) {
    case 'image':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      );
    case 'video':
      return (
        <svg {...common}>
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
      );
    case 'audio':
      return (
        <svg {...common}>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      );
    case 'document':
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      );
    case 'archive':
      return (
        <svg {...common}>
          <path d="M21 8v13H3V8" />
          <path d="M1 3h22v5H1z" />
          <path d="M10 12h4" />
        </svg>
      );
    case 'code':
      return (
        <svg {...common}>
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <polyline points="13 2 13 9 20 9" />
        </svg>
      );
  }
}

// --- Connection phase stepper ---

const PHASE_ORDER: ConnectionPhase[] = ['waiting-for-peer', 'peer-connected', 'securing', 'ready'];
const PHASE_LABELS: Record<ConnectionPhase, string> = {
  'waiting-for-peer': 'Waiting for peer',
  'peer-connected': 'Peer connected',
  'securing': 'Encrypting',
  'ready': 'Ready to send',
};

function PhaseStepper({ currentPhase }: { currentPhase: ConnectionPhase | null }) {
  const currentIdx = currentPhase ? PHASE_ORDER.indexOf(currentPhase) : -1;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex items-center gap-1">
        {PHASE_ORDER.map((phase, i) => {
          const isCompleted = i < currentIdx;
          const isActive = i === currentIdx;
          return (
            <div key={phase} className="flex items-center">
              <motion.div
                className={`w-2.5 h-2.5 rounded-full ${
                  isCompleted
                    ? 'bg-[#00ff41]'
                    : isActive
                      ? 'bg-[#00ff41]'
                      : 'bg-[#00ff41]/20'
                }`}
                animate={
                  isActive
                    ? {
                        boxShadow: [
                          '0 0 4px rgba(0,255,65,0.4)',
                          '0 0 12px rgba(0,255,65,0.8)',
                          '0 0 4px rgba(0,255,65,0.4)',
                        ],
                      }
                    : isCompleted
                      ? { boxShadow: '0 0 6px rgba(0,255,65,0.5)' }
                      : {}
                }
                transition={isActive ? { duration: 1.2, repeat: Infinity } : {}}
              />
              {i < PHASE_ORDER.length - 1 && (
                <div
                  className={`w-6 h-px mx-0.5 ${
                    i < currentIdx ? 'bg-[#00ff41]/60' : 'bg-[#00ff41]/15'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>
      {currentPhase && (
        <motion.span
          key={currentPhase}
          className="text-[#00ff41]/70 text-xs"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          {PHASE_LABELS[currentPhase]}
        </motion.span>
      )}
    </div>
  );
}

// --- Main component ---

export function CodeDisplay({ code, fileName, fileSize, connectionPhase }: CodeDisplayProps) {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const shareUrl = typeof window !== 'undefined'
    ? `${window.location.origin}?code=${code.replace('-', '')}`
    : '';

  const category = getFileCategory(fileName);
  const estimatedTime = getEstimatedTransferTime(fileSize);

  const copyCode = useCallback(async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    if ('vibrate' in navigator) navigator.vibrate(50);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  const handleShare = useCallback(async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Warp-LAN File Transfer',
          text: `Receive my file with code: ${code}`,
          url: shareUrl,
        });
        return;
      } catch {
        // User cancelled or share failed — fall through to clipboard
      }
    }
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code, shareUrl]);

  const toggleQr = useCallback(async () => {
    if (!showQr && !qrDataUrl) {
      const url = await QRCode.toDataURL(shareUrl, {
        width: 200,
        margin: 2,
        color: { dark: '#00ff41', light: '#00000000' },
      });
      setQrDataUrl(url);
    }
    setShowQr((prev) => !prev);
  }, [showQr, qrDataUrl, shareUrl]);

  return (
    <motion.div
      className="relative w-full max-w-md glass-panel glass-glow rounded-2xl p-6 md:p-8"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      {/* File info */}
      <div className="mb-8 text-center">
        <motion.div
          className="inline-flex items-center gap-3 px-4 py-2 glass-button rounded-lg"
          whileHover={{ scale: 1.02 }}
        >
          <FileTypeIcon category={category} />
          <span className="text-[#00ff41] text-sm truncate max-w-[200px]">{fileName}</span>
          <span className="text-[#00ff41]/60 text-sm">{formatFileSize(fileSize)}</span>
        </motion.div>
        {fileSize > 0 && (
          <p className="text-[#00ff41]/40 text-xs mt-2">{estimatedTime}</p>
        )}
      </div>

      {/* Code display */}
      <div className="text-center mb-6">
        <p className="text-[#00ff41]/60 text-sm mb-4 uppercase tracking-wider">Share this code</p>

        <div
          className={`
            text-3xl md:text-5xl font-mono font-bold text-[#00ff41] tracking-[0.2em] md:tracking-[0.3em]
            py-4 px-6 md:px-8 glass-panel rounded-xl inline-block
            border-2 transition-all duration-300 text-glow
            ${copied ? 'border-[#00ff41] neon-border' : 'border-[#00ff41]/30'}
          `}
        >
          {code}
        </div>
      </div>

      {/* Share buttons row */}
      <div className="flex items-center justify-center gap-3 mb-8">
        {/* Copy */}
        <motion.button
          onClick={copyCode}
          className="flex items-center gap-2 px-4 py-2 glass-button rounded-lg text-[#00ff41] text-sm"
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          {copied ? 'Copied!' : 'Copy'}
        </motion.button>

        {/* Share */}
        <motion.button
          onClick={handleShare}
          className="flex items-center gap-2 px-4 py-2 glass-button rounded-lg text-[#00ff41] text-sm"
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
          Share
        </motion.button>

        {/* QR */}
        <motion.button
          onClick={toggleQr}
          className={`flex items-center gap-2 px-4 py-2 glass-button rounded-lg text-[#00ff41] text-sm ${showQr ? 'neon-border' : ''}`}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="3" height="3" />
            <rect x="18" y="18" width="3" height="3" />
            <rect x="18" y="14" width="3" height="1" />
            <rect x="14" y="18" width="1" height="3" />
          </svg>
          QR
        </motion.button>
      </div>

      {/* QR code expandable section */}
      <AnimatePresence>
        {showQr && qrDataUrl && (
          <motion.div
            className="flex justify-center mb-6"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
          >
            <div className="p-4 glass-panel rounded-xl">
              <img src={qrDataUrl} alt="QR code for transfer" width={180} height={180} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Connection status */}
      <div className="text-center">
        <PhaseStepper currentPhase={connectionPhase} />
      </div>

      {/* Decorative corners */}
      <div className="absolute top-2 left-2 w-5 h-5 border-l-2 border-t-2 border-[#00ff41]/40 rounded-tl pointer-events-none" />
      <div className="absolute top-2 right-2 w-5 h-5 border-r-2 border-t-2 border-[#00ff41]/40 rounded-tr pointer-events-none" />
      <div className="absolute bottom-2 left-2 w-5 h-5 border-l-2 border-b-2 border-[#00ff41]/40 rounded-bl pointer-events-none" />
      <div className="absolute bottom-2 right-2 w-5 h-5 border-r-2 border-b-2 border-[#00ff41]/40 rounded-br pointer-events-none" />
    </motion.div>
  );
}
