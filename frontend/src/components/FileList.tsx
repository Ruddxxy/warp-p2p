import { motion, AnimatePresence } from "framer-motion";
import { useState } from "react";
import {
  formatFileSize,
  getFileCategory,
  type FileTransferStatus,
  type FileCategory,
} from "../types";

interface FileListProps {
  files: File[];
  fileStatuses?: FileTransferStatus[];
  currentIndex?: number;
  onRemove?: (index: number) => void;
  compact?: boolean;
}

function FileIcon({ category }: { category: FileCategory }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-text-faint flex-shrink-0"
      aria-hidden="true"
    >
      {category === "image" ? (
        <>
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </>
      ) : category === "video" ? (
        <>
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </>
      ) : category === "audio" ? (
        <>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </>
      ) : category === "archive" ? (
        <>
          <path d="M21 8v13H3V8" />
          <path d="M1 3h22v5H1z" />
          <path d="M10 12h4" />
        </>
      ) : (
        <>
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <polyline points="13 2 13 9 20 9" />
        </>
      )}
    </svg>
  );
}

function StatusDot({ status }: { status?: FileTransferStatus["status"] }) {
  if (!status) return null;

  switch (status) {
    case "pending":
      return <div className="w-2 h-2 rounded-full bg-border flex-shrink-0" />;
    case "transferring":
      return (
        <div className="w-2 h-2 rounded-full bg-primary animate-pulse-slow flex-shrink-0" />
      );
    case "completed":
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#22C55E"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="flex-shrink-0"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      );
    case "failed":
      return (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#EF4444"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="flex-shrink-0"
          aria-hidden="true"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      );
    case "skipped":
      return <div className="w-3 h-0.5 bg-text-faint rounded flex-shrink-0" />;
  }
}

export function FileList({
  files,
  fileStatuses,
  currentIndex,
  onRemove,
  compact = false,
}: FileListProps) {
  const [expanded, setExpanded] = useState(false);

  const COMPACT_LIMIT = 3;
  const showAll = !compact || expanded || files.length <= COMPACT_LIMIT;
  const displayFiles = showAll ? files : files.slice(0, COMPACT_LIMIT);
  const hiddenCount = files.length - COMPACT_LIMIT;

  return (
    <div className="w-full">
      <ul className="space-y-1" role="list" aria-label="File list">
        <AnimatePresence initial={false}>
          {displayFiles.map((file, i) => {
            const status = fileStatuses?.[i];
            const isCurrent = currentIndex === i;
            const category = getFileCategory(file.name);

            return (
              <motion.li
                key={`${file.name}-${file.size}-${i}`}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isCurrent
                    ? "bg-primary/5 border border-primary/15"
                    : "bg-transparent"
                }`}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.15 }}
              >
                <FileIcon category={category} />
                <span className="text-text truncate flex-1 min-w-0">
                  {file.name}
                </span>
                <span className="text-text-faint text-xs flex-shrink-0">
                  {formatFileSize(file.size)}
                </span>
                {status && <StatusDot status={status.status} />}
                {onRemove && !fileStatuses && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(i);
                    }}
                    className="text-text-faint hover:text-error transition-colors p-0.5 rounded flex-shrink-0"
                    aria-label={`Remove ${file.name}`}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                )}
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>

      {compact && files.length > COMPACT_LIMIT && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="mt-1 px-3 py-1 text-xs text-text-faint hover:text-text-muted transition-colors"
        >
          +{hiddenCount} more
        </button>
      )}

      {compact && expanded && files.length > COMPACT_LIMIT && (
        <button
          onClick={() => setExpanded(false)}
          className="mt-1 px-3 py-1 text-xs text-text-faint hover:text-text-muted transition-colors"
        >
          Show less
        </button>
      )}
    </div>
  );
}
