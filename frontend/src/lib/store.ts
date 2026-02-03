import { create } from 'zustand';
import { TransferEngine, TransferProgress, TransferState, FileMetadata, TransferRole } from './TransferEngine';

// Session persistence for room code recovery
const STORAGE_KEY = 'warp-lan-session' as const;
const SESSION_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

interface PersistedSession {
  roomCode: string;
  role: TransferRole | null;
  timestamp: number;
}

function saveSession(roomCode: string, role: TransferRole | null): void {
  if (!roomCode) return;
  try {
    const session: PersistedSession = {
      roomCode,
      role,
      timestamp: Date.now()
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // localStorage not available
  }
}

function loadSession(): PersistedSession | null {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    if (!data) return null;

    const session: PersistedSession = JSON.parse(data);

    // Session expires after 10 minutes
    if (Date.now() - session.timestamp > SESSION_EXPIRY_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

    return session;
  } catch {
    return null;
  }
}

function clearSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage not available
  }
}

interface TransferStore {
  // Engine instance
  engine: TransferEngine | null;

  // State
  state: TransferState;
  role: TransferRole | null;
  roomCode: string;
  peerConnected: boolean;
  error: string | null;

  // File info
  file: File | null;
  fileMetadata: FileMetadata | null;

  // Progress
  progress: TransferProgress | null;

  // Actions
  initEngine: (signalingUrl: string) => void;
  createRoom: (file: File) => Promise<string>;
  joinRoom: (code: string) => Promise<void>;
  reset: () => void;
  restoreSession: () => PersistedSession | null;
}

// Get signaling URL from environment - MUST be set in production
function getSignalingUrl(): string {
  const url = import.meta.env.VITE_SIGNALING_URL as string | undefined;

  if (!url) {
    // Check if we're in production (not localhost)
    const isProduction = typeof window !== 'undefined' &&
      !window.location.hostname.includes('localhost') &&
      !window.location.hostname.includes('127.0.0.1');

    if (isProduction) {
      console.error('[Store] VITE_SIGNALING_URL not configured! Set this environment variable in your deployment platform.');
    }
    return 'ws://localhost:8080/ws';
  }

  return url;
}

const SIGNALING_URL = getSignalingUrl();

export const useTransferStore = create<TransferStore>((set, get) => ({
  engine: null,
  state: 'idle',
  role: null,
  roomCode: '',
  peerConnected: false,
  error: null,
  file: null,
  fileMetadata: null,
  progress: null,

  initEngine: (signalingUrl: string = SIGNALING_URL) => {
    const existing = get().engine;
    if (existing) {
      existing.destroy();
    }

    const engine = new TransferEngine(signalingUrl, {
      onStateChange: (state) => set({ state }),
      onProgress: (progress) => set({ progress }),
      onError: (error) => set({ error: error.message, state: 'error' }),
      onPeerConnected: () => set({ peerConnected: true }),
      onPeerDisconnected: () => set({ peerConnected: false }),
      onFileMetadata: (metadata) => set({ fileMetadata: metadata }),
      onRoomCode: (code) => set({ roomCode: code }),
      onHashVerified: (verified) => {
        if (!verified) {
          set({ error: 'File integrity check failed' });
        }
      }
    });

    set({ engine });
  },

  createRoom: async (file: File) => {
    const { engine, initEngine } = get();

    if (!engine) {
      initEngine(SIGNALING_URL);
    }

    const currentEngine = get().engine!;
    set({ file, role: 'sender', error: null });

    try {
      const code = await currentEngine.createRoom(file);
      saveSession(code, 'sender');
      return code;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create room';
      set({ error: message, state: 'error' });
      throw error;
    }
  },

  joinRoom: async (code: string) => {
    const { engine, initEngine } = get();

    if (!engine) {
      initEngine(SIGNALING_URL);
    }

    const currentEngine = get().engine!;
    set({ role: 'receiver', roomCode: code, error: null });
    saveSession(code, 'receiver');

    try {
      await currentEngine.joinRoom(code);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to join room';
      set({ error: message, state: 'error' });
      throw error;
    }
  },

  reset: () => {
    const { engine } = get();
    if (engine) {
      engine.destroy();
    }

    clearSession();

    set({
      engine: null,
      state: 'idle',
      role: null,
      roomCode: '',
      peerConnected: false,
      error: null,
      file: null,
      fileMetadata: null,
      progress: null
    });
  },

  restoreSession: () => {
    const session = loadSession();
    if (session) {
      set({ roomCode: session.roomCode, role: session.role });
    }
    return session;
  }
}));
