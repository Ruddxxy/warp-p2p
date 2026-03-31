import { useCallback, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MAX_FILE_SIZE, formatFileSize } from "../types";

interface DropZoneProps {
  onFilesSelect: (files: File[]) => void;
  disabled?: boolean;
}

export function DropZone({ onFilesSelect, disabled }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validateAndSelect = useCallback(
    (fileList: FileList | File[]) => {
      const allFiles = Array.from(fileList);
      const errors: string[] = [];
      const valid: File[] = [];

      for (const file of allFiles) {
        if (file.size > MAX_FILE_SIZE) {
          errors.push(`${file.name} too large (${formatFileSize(file.size)})`);
        } else if (file.size === 0) {
          errors.push(`${file.name} is empty`);
        } else {
          valid.push(file);
        }
      }

      if (errors.length > 0 && valid.length === 0) {
        setError(errors.length === 1 ? errors[0] : `${errors.length} files skipped (empty files)`);
        setTimeout(() => setError(null), 5000);
        return;
      }

      if (errors.length > 0) {
        setError(`${errors.length} file(s) skipped (too large or empty)`);
        setTimeout(() => setError(null), 5000);
      } else {
        setError(null);
      }

      if (valid.length > 0) {
        onFilesSelect(valid);
      }
    },
    [onFilesSelect],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) setIsDragging(true);
    },
    [disabled],
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
      if (e.dataTransfer.files.length > 0) {
        validateAndSelect(e.dataTransfer.files);
      }
    },
    [disabled, validateAndSelect],
  );

  const handleClick = useCallback(() => {
    if (disabled) return;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files && files.length > 0) validateAndSelect(files);
    };
    input.click();
  }, [disabled, validateAndSelect]);

  return (
    <div className="w-full max-w-lg">
      <motion.div
        className={`
          relative w-full
          rounded-2xl border-2 border-dashed
          cursor-pointer
          flex flex-col items-center justify-center gap-4
          py-16 px-8
          transition-all duration-200
          ${
            isDragging
              ? "border-primary bg-primary-muted scale-[1.02]"
              : "border-border hover:border-border-hover bg-surface/30 hover:bg-surface/50"
          }
          ${disabled ? "opacity-50 cursor-not-allowed" : ""}
        `}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        role="button"
        aria-label="Drop files here or click to browse"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClick();
          }
        }}
        whileHover={disabled ? {} : { y: -2 }}
        whileTap={disabled ? {} : { scale: 0.99 }}
      >
        {/* Upload icon */}
        <motion.div
          animate={isDragging ? { y: -8, scale: 1.1 } : { y: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
          className={`
            w-14 h-14 rounded-xl flex items-center justify-center
            ${isDragging ? "bg-primary/20" : "bg-surface"}
            border transition-colors duration-200
            ${isDragging ? "border-primary/30" : "border-border"}
          `}
        >
          <svg
            className={`w-6 h-6 transition-colors duration-200 ${isDragging ? "text-primary" : "text-text-faint"}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </motion.div>

        {/* Text */}
        <div className="text-center">
          <p className="text-text text-base font-medium">
            {isDragging ? "Drop to send" : "Drop files or click to select"}
          </p>
          <p className="text-text-faint text-sm mt-1">Any file size — streamed directly</p>
        </div>
      </motion.div>

      {/* Error message */}
      <AnimatePresence>
        {error && (
          <motion.div
            className="mt-3"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
          >
            <div className="bg-error-muted border border-error/30 rounded-xl py-3 px-4 flex items-center gap-3">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#EF4444"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <p className="text-error text-sm" role="alert">
                {error}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
