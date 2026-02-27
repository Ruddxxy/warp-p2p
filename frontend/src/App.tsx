import { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Header } from './components/Header';
import { DropZone } from './components/DropZone';
import { CodeDisplay } from './components/CodeDisplay';
import { CodeInput } from './components/CodeInput';
import { TransferView } from './components/TransferView';
import { useTransferStore } from './lib/store';

type Screen = 'landing' | 'send' | 'receive' | 'transfer';

export default function App() {
  const [screen, setScreen] = useState<Screen>('landing');
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  const {
    state,
    role,
    roomCode,
    error,
    appError,
    connectionPhase,
    file,
    fileMetadata,
    progress,
    createRoom,
    joinRoom,
    reset
  } = useTransferStore();

  // Online/Offline detection
  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Screen transitions based on state
  useEffect(() => {
    if (state === 'transferring' || state === 'completed') {
      setScreen('transfer');
    }
  }, [state]);

  // Request wake lock on mobile
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;

    const requestWakeLock = async () => {
      if ('wakeLock' in navigator && (state === 'transferring' || state === 'connecting')) {
        try {
          wakeLock = await navigator.wakeLock.request('screen');
          console.log('[App] Wake lock acquired');
        } catch (err) {
          console.log('[App] Wake lock failed:', err);
        }
      }
    };

    requestWakeLock();

    return () => {
      wakeLock?.release();
    };
  }, [state]);

  const handleFileSelect = useCallback(
    async (selectedFile: File) => {
      setScreen('send');
      try {
        await createRoom(selectedFile);
      } catch {
        // Error state managed by store
      }
    },
    [createRoom]
  );

  const handleCodeSubmit = useCallback(
    async (code: string) => {
      try {
        await joinRoom(code);
      } catch {
        // Error state managed by store
      }
    },
    [joinRoom]
  );

  const handleReset = useCallback(() => {
    reset();
    setScreen('landing');
  }, [reset]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-950 via-black to-gray-900">
      {/* Animated background grid */}
      <div className="fixed inset-0 opacity-[0.15] pointer-events-none">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: `
              linear-gradient(to right, #00ff41 1px, transparent 1px),
              linear-gradient(to bottom, #00ff41 1px, transparent 1px)
            `,
            backgroundSize: '60px 60px'
          }}
        />
      </div>

      {/* Enhanced glow orbs */}
      <motion.div
        className="fixed top-1/4 left-1/4 w-[500px] h-[500px] bg-[#00ff41]/[0.06] rounded-full blur-[100px] pointer-events-none"
        animate={{
          scale: [1, 1.1, 1],
          opacity: [0.06, 0.08, 0.06]
        }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="fixed bottom-1/4 right-1/4 w-[500px] h-[500px] bg-[#00ff41]/[0.05] rounded-full blur-[120px] pointer-events-none"
        animate={{
          scale: [1.1, 1, 1.1],
          opacity: [0.05, 0.07, 0.05]
        }}
        transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-[#00ff41]/[0.02] rounded-full blur-[150px] pointer-events-none" />

      <Header />

      {/* Offline indicator */}
      <AnimatePresence>
        {isOffline && (
          <motion.div
            className="fixed top-20 left-1/2 transform -translate-x-1/2 z-50"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
          >
            <div className="flex items-center gap-2 px-4 py-2 glass-panel border-yellow-500/30 bg-yellow-500/10 rounded-lg">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#eab308" strokeWidth="2">
                <line x1="1" y1="1" x2="23" y2="23" />
                <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
                <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
                <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
                <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                <line x1="12" y1="20" x2="12.01" y2="20" />
              </svg>
              <span className="text-yellow-400 text-sm font-medium">You are offline</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="relative pt-20 pb-8 px-4 md:pt-24 md:pb-12 md:px-6 min-h-screen flex items-center justify-center">
        <AnimatePresence mode="wait">
          {screen === 'landing' && (
            <motion.div
              key="landing"
              className="w-full max-w-4xl flex flex-col items-center gap-8"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.3 }}
            >
              {/* Title */}
              <div className="text-center mb-8">
                <h2 className="text-3xl md:text-4xl font-bold text-[#00ff41] mb-4 text-glow">
                  Secure File Transfer
                </h2>
                <p className="text-[#00ff41]/50 max-w-md mx-auto">
                  End-to-end encrypted P2P transfer. No servers, no limits, no tracking.
                </p>
              </div>

              {/* Drop zone */}
              <DropZone onFileSelect={handleFileSelect} disabled={isOffline} />

              {/* Receive option */}
              <div className="flex items-center gap-4 mt-8">
                <div className="h-px w-12 bg-gradient-to-r from-transparent to-[#00ff41]/30" />
                <span className="text-[#00ff41]/50 text-sm">or</span>
                <div className="h-px w-12 bg-gradient-to-l from-transparent to-[#00ff41]/30" />
              </div>

              <motion.button
                onClick={() => setScreen('receive')}
                disabled={isOffline}
                className="px-6 py-3 glass-button rounded-lg text-[#00ff41] disabled:opacity-50 disabled:cursor-not-allowed"
                whileHover={isOffline ? {} : { scale: 1.02 }}
                whileTap={isOffline ? {} : { scale: 0.98 }}
              >
                I have a code
              </motion.button>
            </motion.div>
          )}

          {screen === 'send' && (
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
                fileName={file?.name ?? ''}
                fileSize={file?.size ?? 0}
                connectionPhase={connectionPhase}
              />

              <motion.button
                onClick={handleReset}
                className="mt-4 px-4 py-2 text-[#00ff41]/50 hover:text-[#00ff41] text-sm transition-colors"
                whileHover={{ scale: 1.02 }}
              >
                Cancel
              </motion.button>
            </motion.div>
          )}

          {screen === 'receive' && (
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
                disabled={state === 'connecting' || state === 'handshaking'}
                error={error}
              />

              <motion.button
                onClick={handleReset}
                className="mt-4 px-4 py-2 text-[#00ff41]/50 hover:text-[#00ff41] text-sm transition-colors"
                whileHover={{ scale: 1.02 }}
              >
                Back
              </motion.button>
            </motion.div>
          )}

          {screen === 'transfer' && (
            <motion.div
              key="transfer"
              className="w-full flex flex-col items-center gap-6"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.3 }}
            >
              <TransferView state={state} progress={progress} fileMetadata={fileMetadata} role={role ?? 'sender'} />

              {state === 'completed' && (
                <motion.button
                  onClick={handleReset}
                  className="mt-4 px-6 py-3 glass-button rounded-lg text-[#00ff41]"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.5 }}
                >
                  Transfer Another File
                </motion.button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Error toast */}
      <AnimatePresence>
        {error && screen !== 'receive' && (
          <motion.div
            className="fixed bottom-6 left-4 right-4 md:left-1/2 md:right-auto md:transform md:-translate-x-1/2 max-w-md mx-auto px-5 py-4 glass-panel border-red-500/30 bg-red-500/10 rounded-lg z-50"
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 50 }}
          >
            <p className="text-red-400 text-sm font-medium">
              {appError?.message ?? error}
            </p>
            {appError?.suggestion && (
              <p className="text-red-400/60 text-xs mt-1">{appError.suggestion}</p>
            )}
            {appError?.recoverable && (
              <motion.button
                onClick={handleReset}
                className="mt-3 px-4 py-1.5 text-xs glass-button rounded text-red-400 border-red-500/30 hover:border-red-400/50"
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
              >
                Try Again
              </motion.button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
