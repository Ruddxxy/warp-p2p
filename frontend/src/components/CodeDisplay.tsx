import { motion } from 'framer-motion';
import { useState } from 'react';
import { formatFileSize } from '../types';

interface CodeDisplayProps {
  code: string;
  fileName: string;
  fileSize: number;
  peerConnected: boolean;
}

export function CodeDisplay({ code, fileName, fileSize, peerConnected }: CodeDisplayProps) {
  const [copied, setCopied] = useState(false);

  const copyCode = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);

    // Vibration feedback on mobile
    if ('vibrate' in navigator) {
      navigator.vibrate(50);
    }

    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <motion.div
      className="relative w-full max-w-md glass-panel glass-glow rounded-2xl p-8"
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
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#00ff41"
            strokeWidth="2"
            className="drop-shadow-[0_0_4px_rgba(0,255,65,0.5)]"
          >
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
            <polyline points="13 2 13 9 20 9" />
          </svg>
          <span className="text-[#00ff41] text-sm truncate max-w-[200px]">{fileName}</span>
          <span className="text-[#00ff41]/60 text-sm">{formatFileSize(fileSize)}</span>
        </motion.div>
      </div>

      {/* Code display */}
      <div className="text-center mb-6">
        <p className="text-[#00ff41]/60 text-sm mb-4 uppercase tracking-wider">Share this code</p>

        <motion.div
          className="relative inline-block cursor-pointer group"
          onClick={copyCode}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
        >
          <div
            className={`
              text-5xl font-mono font-bold text-[#00ff41] tracking-[0.3em]
              py-4 px-8 glass-panel rounded-xl
              border-2 transition-all duration-300 text-glow
              ${copied ? 'border-[#00ff41] neon-border' : 'border-[#00ff41]/30 group-hover:border-[#00ff41]/70'}
            `}
          >
            {code}
          </div>

          {/* Copy indicator */}
          <motion.div
            className="absolute -bottom-8 left-1/2 transform -translate-x-1/2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            <span className={`text-xs transition-colors ${copied ? 'text-[#00ff41]' : 'text-[#00ff41]/50'}`}>
              {copied ? 'Copied!' : 'Click to copy'}
            </span>
          </motion.div>
        </motion.div>
      </div>

      {/* Status */}
      <div className="mt-12 text-center">
        <motion.div
          className="inline-flex items-center gap-3 px-4 py-2 glass-panel rounded-full"
          animate={peerConnected ? {} : { opacity: [0.6, 1, 0.6] }}
          transition={{ duration: 1.5, repeat: Infinity }}
        >
          <motion.div
            className={`w-2 h-2 rounded-full ${peerConnected ? 'bg-[#00ff41]' : 'bg-[#00ff41]/50'}`}
            animate={
              peerConnected
                ? {
                    boxShadow: [
                      '0 0 4px rgba(0, 255, 65, 0.5)',
                      '0 0 12px rgba(0, 255, 65, 0.8)',
                      '0 0 4px rgba(0, 255, 65, 0.5)'
                    ]
                  }
                : {}
            }
            transition={{ duration: 1, repeat: Infinity }}
          />
          <span className="text-[#00ff41]/80 text-sm">
            {peerConnected ? 'Peer connected - verifying...' : 'Waiting for receiver...'}
          </span>
        </motion.div>
      </div>

      {/* Decorative corners */}
      <div className="absolute top-2 left-2 w-5 h-5 border-l-2 border-t-2 border-[#00ff41]/40 rounded-tl pointer-events-none" />
      <div className="absolute top-2 right-2 w-5 h-5 border-r-2 border-t-2 border-[#00ff41]/40 rounded-tr pointer-events-none" />
      <div className="absolute bottom-2 left-2 w-5 h-5 border-l-2 border-b-2 border-[#00ff41]/40 rounded-bl pointer-events-none" />
      <div className="absolute bottom-2 right-2 w-5 h-5 border-r-2 border-b-2 border-[#00ff41]/40 rounded-br pointer-events-none" />
    </motion.div>
  );
}
