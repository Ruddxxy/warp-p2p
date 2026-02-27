import { useCallback, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MAX_FILE_SIZE, MAX_FILE_SIZE_DISPLAY, formatFileSize } from '../types';

interface DropZoneProps {
  onFileSelect: (file: File) => void;
  disabled?: boolean;
}

export function DropZone({ onFileSelect, disabled }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validateAndSelect = useCallback(
    (file: File) => {
      if (file.size > MAX_FILE_SIZE) {
        setError(`File too large (${formatFileSize(file.size)}). Maximum size is ${MAX_FILE_SIZE_DISPLAY}`);
        setTimeout(() => setError(null), 5000);
        return;
      }
      setError(null);
      onFileSelect(file);
    },
    [onFileSelect]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) setIsDragging(true);
    },
    [disabled]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      if (disabled) return;

      const files = e.dataTransfer.files;
      if (files.length > 0) {
        validateAndSelect(files[0]);
      }
    },
    [disabled, validateAndSelect]
  );

  const handleClick = useCallback(() => {
    if (disabled) return;

    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) validateAndSelect(file);
    };
    input.click();
  }, [disabled, validateAndSelect]);

  return (
    <motion.div
      className={`
        relative w-full max-w-2xl h-[200px] md:h-auto md:aspect-video
        rounded-2xl border-2 border-dashed
        cursor-pointer
        glass-panel glass-panel-interactive glass-glow
        flex flex-col items-center justify-center gap-4 md:gap-6
        ${isDragging ? 'border-[#00ff41] !bg-[#00ff41]/15' : 'border-[#00ff41]/30 hover:border-[#00ff41]/60'}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      `}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
      whileHover={disabled ? {} : { scale: 1.01 }}
      whileTap={disabled ? {} : { scale: 0.99 }}
    >
      {/* Animated glow effect */}
      <motion.div
        className="absolute inset-0 rounded-2xl pointer-events-none"
        animate={{
          boxShadow: isDragging
            ? '0 0 40px rgba(0, 255, 65, 0.4), inset 0 0 40px rgba(0, 255, 65, 0.1)'
            : '0 0 20px rgba(0, 255, 65, 0.15), inset 0 0 20px rgba(0, 255, 65, 0.03)'
        }}
        transition={{ duration: 0.3 }}
      />

      {/* Pulsing ring animation */}
      <AnimatePresence>
        {!disabled && (
          <motion.div
            className="absolute inset-4 rounded-xl border border-[#00ff41]/20 pointer-events-none"
            animate={{
              opacity: [0.2, 0.5, 0.2],
              scale: [1, 1.01, 1]
            }}
            transition={{
              duration: 3,
              repeat: Infinity,
              ease: 'easeInOut'
            }}
          />
        )}
      </AnimatePresence>

      {/* Icon */}
      <motion.div
        className="relative z-10"
        animate={isDragging ? { y: -10, scale: 1.1 } : { y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
      >
        <svg
          className="w-12 h-12 md:w-16 md:h-16 drop-shadow-[0_0_10px_rgba(0,255,65,0.5)]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#00ff41"
          strokeWidth="1.5"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      </motion.div>

      {/* Text */}
      <div className="relative z-10 text-center px-4 md:px-8">
        <p className="text-[#00ff41] text-lg font-medium mb-2 text-glow">
          {isDragging ? 'Drop file here' : 'Drop file or click to select'}
        </p>
        <p className="text-[#00ff41]/50 text-sm">
          Supports files up to {MAX_FILE_SIZE_DISPLAY} (streamed transfer)
        </p>
      </div>

      {/* Error message */}
      <AnimatePresence>
        {error && (
          <motion.div
            className="absolute bottom-6 left-6 right-6 z-20"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
          >
            <div className="glass-panel border-red-500/30 bg-red-500/10 rounded-lg py-3 px-4 flex items-center gap-3">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Corner decorations */}
      <div className="absolute top-3 left-3 w-6 h-6 border-l-2 border-t-2 border-[#00ff41]/40 rounded-tl pointer-events-none" />
      <div className="absolute top-3 right-3 w-6 h-6 border-r-2 border-t-2 border-[#00ff41]/40 rounded-tr pointer-events-none" />
      <div className="absolute bottom-3 left-3 w-6 h-6 border-l-2 border-b-2 border-[#00ff41]/40 rounded-bl pointer-events-none" />
      <div className="absolute bottom-3 right-3 w-6 h-6 border-r-2 border-b-2 border-[#00ff41]/40 rounded-br pointer-events-none" />
    </motion.div>
  );
}
