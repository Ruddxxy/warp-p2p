import { motion, AnimatePresence } from "framer-motion";
import { useState, useCallback } from "react";
import QRCode from "qrcode";
import {
  formatFileSize,
  getFileCategory,
  getEstimatedTransferTime,
  type FileCategory,
  type ConnectionPhase,
  type FileTransferStatus,
} from "../types";
import { FileList } from "./FileList";

interface CodeDisplayProps {
  code: string;
  files: File[];
  connectionPhase: ConnectionPhase | null;
  fileStatuses?: FileTransferStatus[];
}

// --- File type icon per category ---

function FileTypeIcon({ category }: { category: FileCategory }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "text-text-muted flex-shrink-0",
    "aria-hidden": true as const,
  };

  switch (category) {
    case "image":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      );
    case "video":
      return (
        <svg {...common}>
          <polygon points="23 7 16 12 23 17 23 7" />
          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
        </svg>
      );
    case "audio":
      return (
        <svg {...common}>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      );
    case "document":
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      );
    case "archive":
      return (
        <svg {...common}>
          <path d="M21 8v13H3V8" />
          <path d="M1 3h22v5H1z" />
          <path d="M10 12h4" />
        </svg>
      );
    case "code":
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

const PHASE_ORDER: ConnectionPhase[] = ["waiting-for-peer", "peer-connected", "securing", "ready"];
const PHASE_LABELS: Record<ConnectionPhase, string> = {
  "waiting-for-peer": "Waiting for peer...",
  "peer-connected": "Peer connected",
  securing: "Securing connection...",
  ready: "Ready to send",
};

function PhaseStepper({ currentPhase }: { currentPhase: ConnectionPhase | null }) {
  const currentIdx = currentPhase ? PHASE_ORDER.indexOf(currentPhase) : -1;

  return (
    <div className="flex flex-col items-center gap-3" role="status">
      <div className="flex items-center gap-1" aria-hidden="true">
        {PHASE_ORDER.map((phase, i) => {
          const isCompleted = i < currentIdx;
          const isActive = i === currentIdx;
          return (
            <div key={phase} className="flex items-center">
              <div
                className={`w-2.5 h-2.5 rounded-full transition-all duration-300 ${
                  isCompleted
                    ? "bg-success"
                    : isActive
                      ? "bg-primary animate-pulse-slow"
                      : "bg-border"
                }`}
              />
              {i < PHASE_ORDER.length - 1 && (
                <div
                  className={`w-6 h-px mx-0.5 transition-colors duration-300 ${
                    i < currentIdx ? "bg-success/60" : "bg-border"
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
          className="text-text-muted text-sm"
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          aria-live="polite"
        >
          {PHASE_LABELS[currentPhase]}
        </motion.span>
      )}
    </div>
  );
}

// --- Main component ---

export function CodeDisplay({ code, files, connectionPhase, fileStatuses }: CodeDisplayProps) {
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const shareUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}?code=${code.replaceAll("-", "")}`
      : "";

  const isSingleFile = files.length === 1;
  const firstFile = files[0];
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const category =
    isSingleFile && firstFile ? getFileCategory(firstFile.name) : ("other" as FileCategory);
  const estimatedTime = getEstimatedTransferTime(totalSize);

  const copyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if ("vibrate" in navigator) navigator.vibrate(50);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API blocked (HTTP, unfocused page, mobile browser restriction)
    }
  }, [code]);

  const handleShare = useCallback(async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Warp File Transfer",
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
        color: { dark: "#F4F4F5", light: "#00000000" },
      });
      setQrDataUrl(url);
    }
    setShowQr((prev) => !prev);
  }, [showQr, qrDataUrl, shareUrl]);

  return (
    <motion.div
      className="w-full max-w-md bg-surface border border-border rounded-2xl p-6 md:p-8"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      {/* File info */}
      <div className="mb-8 flex flex-col items-center">
        <div className="inline-flex items-center gap-2 px-3 py-2 bg-bg rounded-lg border border-border max-w-full">
          {isSingleFile && firstFile ? (
            <>
              <FileTypeIcon category={category} />
              <span className="text-text text-sm truncate max-w-[180px]">{firstFile.name}</span>
              <span className="text-text-faint text-xs" aria-hidden="true">
                ·
              </span>
              <span className="text-text-faint text-sm flex-shrink-0">
                {formatFileSize(firstFile.size)}
              </span>
            </>
          ) : (
            <>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-text-muted flex-shrink-0"
                aria-hidden="true"
              >
                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                <polyline points="13 2 13 9 20 9" />
              </svg>
              <span className="text-text text-sm">{files.length} files</span>
              <span className="text-text-faint text-xs" aria-hidden="true">
                ·
              </span>
              <span className="text-text-faint text-sm flex-shrink-0">
                {formatFileSize(totalSize)}
              </span>
            </>
          )}
        </div>
        {totalSize > 0 && <p className="text-text-faint text-xs mt-2">{estimatedTime}</p>}
        {/* File list for multi-file batches */}
        {files.length > 1 && (
          <div className="mt-3 w-full max-w-sm">
            <FileList files={files} fileStatuses={fileStatuses} compact />
          </div>
        )}
      </div>

      {/* Code display */}
      <div className="text-center mb-6">
        <p className="text-text-muted text-sm mb-4">Share this code</p>

        <div
          className={`
            text-3xl md:text-5xl font-mono font-bold text-text tracking-[0.2em] md:tracking-[0.3em]
            py-4 px-6 md:px-8 bg-bg rounded-xl inline-block
            border-2 transition-all duration-300
            ${copied ? "border-success" : "border-border"}
          `}
          aria-label={`Transfer code: ${code}`}
        >
          {code}
        </div>
      </div>

      {/* Share buttons row */}
      <div className="flex items-center justify-center gap-2 mb-8">
        <motion.button
          onClick={copyCode}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm bg-bg border border-border hover:border-primary/40 text-text-muted hover:text-text transition-colors"
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
          aria-label={copied ? "Code copied" : "Copy code"}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          {copied ? "Copied!" : "Copy"}
        </motion.button>

        <motion.button
          onClick={handleShare}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm bg-bg border border-border hover:border-primary/40 text-text-muted hover:text-text transition-colors"
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
          aria-label="Share transfer link"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
          Share
        </motion.button>

        <motion.button
          onClick={toggleQr}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm border transition-colors ${
            showQr
              ? "bg-primary/10 border-primary/30 text-primary"
              : "bg-bg border-border hover:border-primary/40 text-text-muted hover:text-text"
          }`}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.96 }}
          aria-label={showQr ? "Hide QR code" : "Show QR code"}
          aria-expanded={showQr}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
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
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
          >
            <div className="p-4 bg-bg rounded-xl border border-border">
              <img src={qrDataUrl} alt="QR code for transfer link" width={180} height={180} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Connection status */}
      <div className="text-center">
        <PhaseStepper currentPhase={connectionPhase} />
      </div>
    </motion.div>
  );
}
