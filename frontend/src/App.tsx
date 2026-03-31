import { useState, useCallback, useEffect, useMemo, lazy, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Header } from "./components/Header";
import { DropZone } from "./components/DropZone";
import { CodeDisplay } from "./components/CodeDisplay";
import { CodeInput } from "./components/CodeInput";
import { TransferView } from "./components/TransferView";
import { useTransferStore } from "./lib/store";
import { logger } from "./lib/logger";

const WarpScene = lazy(() =>
  import("./components/WarpScene").then((m) => ({ default: m.WarpScene })),
);

type Screen = "landing" | "send" | "receive" | "transfer";

export default function App() {
  // User-initiated navigation (landing, send, receive)
  // Transfer state overrides this when active
  const [userScreen, setUserScreen] = useState<Screen>("landing");
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  const {
    state,
    role,
    roomCode,
    error,
    appError,
    connectionPhase,
    files,
    fileMetadata,
    fileStatuses,
    progress,
    createRoom,
    joinRoom,
    pauseTransfer,
    resumeTransfer,
    reset,
  } = useTransferStore();

  // Derive active screen: transfer state overrides user navigation
  const screen: Screen = useMemo(() => {
    if (state === "transferring" || state === "completed" || state === "paused") return "transfer";
    if (state === "preparing") return "send";
    return userScreen;
  }, [state, userScreen]);

  // Online/Offline detection
  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Request wake lock on mobile
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;

    const requestWakeLock = async () => {
      if (
        "wakeLock" in navigator &&
        (state === "transferring" || state === "connecting" || state === "preparing")
      ) {
        try {
          wakeLock = await navigator.wakeLock.request("screen");
          logger.debug("App", "Wake lock acquired");
        } catch {
          logger.debug("App", "Wake lock not available");
        }
      }
    };

    requestWakeLock();

    return () => {
      wakeLock?.release();
    };
  }, [state]);

  const handleFilesSelect = useCallback(
    async (selectedFiles: File[]) => {
      setUserScreen("send");
      try {
        await createRoom(selectedFiles);
      } catch {
        // Error state managed by store
      }
    },
    [createRoom],
  );

  const handleCodeSubmit = useCallback(
    async (code: string) => {
      try {
        await joinRoom(code);
      } catch {
        // Error state managed by store
      }
    },
    [joinRoom],
  );

  const handleReset = useCallback(() => {
    reset();
    setUserScreen("landing");
  }, [reset]);

  // Derive 3D scene phase from transfer state
  const scenePhase = useMemo(() => {
    if (state === "transferring") return "transferring" as const;
    if (state === "completed") return "completed" as const;
    if (state === "error") return "error" as const;
    if (state === "paused") return "idle" as const;
    if (
      state === "connecting" ||
      state === "handshaking" ||
      state === "ready" ||
      state === "preparing"
    )
      return "connecting" as const;
    return "idle" as const;
  }, [state]);

  return (
    <div className="min-h-screen bg-bg">
      {/* 3D Warp tunnel + ambient particles (lazy-loaded) */}
      <Suspense fallback={null}>
        <WarpScene phase={scenePhase} />
      </Suspense>

      <Header />

      {/* Offline indicator */}
      <AnimatePresence>
        {isOffline && (
          <motion.div
            className="fixed top-20 left-1/2 -translate-x-1/2 z-50"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            role="alert"
          >
            <div className="flex items-center gap-2 px-4 py-2 bg-warning-muted border border-warning/30 rounded-lg backdrop-blur-sm">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#eab308"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="1" y1="1" x2="23" y2="23" />
                <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
                <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
                <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
                <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                <line x1="12" y1="20" x2="12.01" y2="20" />
              </svg>
              <span className="text-warning text-sm font-medium">You are offline</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="relative pt-20 pb-8 px-4 md:pt-24 md:pb-12 md:px-6 min-h-screen flex items-center justify-center">
        <AnimatePresence mode="wait">
          {screen === "landing" && (
            <motion.div
              key="landing"
              className="w-full max-w-xl flex flex-col items-center gap-8"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
            >
              {/* Title */}
              <div className="text-center mb-4">
                <h2 className="text-3xl md:text-4xl font-semibold text-text mb-3 tracking-tight">
                  Send files, instantly
                </h2>
                <p className="text-text-muted max-w-sm mx-auto">
                  Peer-to-peer. Encrypted. No signup.
                </p>
              </div>

              {/* Drop zone */}
              <DropZone onFilesSelect={handleFilesSelect} disabled={isOffline} />

              {/* Divider */}
              <div className="flex items-center gap-4">
                <div className="h-px w-12 bg-border" aria-hidden="true" />
                <span className="text-text-faint text-sm select-none">or</span>
                <div className="h-px w-12 bg-border" aria-hidden="true" />
              </div>

              {/* Receive button */}
              <motion.button
                onClick={() => setUserScreen("receive")}
                disabled={isOffline}
                className="px-6 py-3 rounded-xl text-text-muted border border-border hover:border-primary/40 hover:text-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                whileHover={isOffline ? {} : { scale: 1.02 }}
                whileTap={isOffline ? {} : { scale: 0.98 }}
              >
                I have a code
              </motion.button>
            </motion.div>
          )}

          {screen === "send" && (
            <motion.div
              key="send"
              className="w-full flex flex-col items-center gap-6"
              initial={{ opacity: 0, x: 50 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -50 }}
              transition={{ duration: 0.3 }}
            >
              <CodeDisplay
                code={roomCode}
                files={files}
                connectionPhase={connectionPhase}
                fileStatuses={fileStatuses}
              />

              <motion.button
                onClick={handleReset}
                className="mt-2 px-4 py-2 text-text-faint hover:text-text-muted text-sm transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded-lg"
                whileHover={{ scale: 1.02 }}
              >
                Cancel
              </motion.button>
            </motion.div>
          )}

          {screen === "receive" && (
            <motion.div
              key="receive"
              className="w-full flex flex-col items-center gap-6"
              initial={{ opacity: 0, x: 50 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -50 }}
              transition={{ duration: 0.3 }}
            >
              <CodeInput
                onSubmit={handleCodeSubmit}
                disabled={state === "connecting" || state === "handshaking"}
                error={error}
              />

              <motion.button
                onClick={handleReset}
                className="mt-2 px-4 py-2 text-text-faint hover:text-text-muted text-sm transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded-lg"
                whileHover={{ scale: 1.02 }}
              >
                Back
              </motion.button>
            </motion.div>
          )}

          {screen === "transfer" && (
            <motion.div
              key="transfer"
              className="w-full flex flex-col items-center gap-6"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.3 }}
            >
              <TransferView
                state={state}
                progress={progress}
                fileMetadata={fileMetadata}
                role={role ?? "sender"}
                fileStatuses={fileStatuses}
                onPause={pauseTransfer}
                onResume={resumeTransfer}
              />

              {state === "completed" && (
                <motion.button
                  onClick={handleReset}
                  className="mt-4 px-6 py-3 rounded-xl bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.5 }}
                >
                  Send More Files
                </motion.button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Error toast */}
      <AnimatePresence>
        {error && screen !== "receive" && (
          <motion.div
            className="fixed bottom-6 left-4 right-4 md:left-1/2 md:right-auto md:-translate-x-1/2 max-w-md mx-auto z-50"
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
            role="alert"
          >
            <div className="px-5 py-4 bg-surface border border-error/30 rounded-xl shadow-lg">
              <p className="text-error text-sm font-medium">{appError?.message ?? error}</p>
              {appError?.suggestion && (
                <p className="text-text-faint text-xs mt-1">{appError.suggestion}</p>
              )}
              {appError?.recoverable && (
                <motion.button
                  onClick={handleReset}
                  className="mt-3 px-4 py-1.5 text-xs rounded-lg text-error border border-error/30 hover:bg-error/10 transition-colors focus-visible:ring-2 focus-visible:ring-error"
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                >
                  Try Again
                </motion.button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
