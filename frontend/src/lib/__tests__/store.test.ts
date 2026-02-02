/**
 * Store Tests - Zustand state management
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useTransferStore } from '../store';

// Mock TransferEngine
vi.mock('../TransferEngine', () => ({
  TransferEngine: vi.fn().mockImplementation((_url, events) => ({
    createRoom: vi.fn().mockImplementation(async () => {
      events.onRoomCode?.('42-69');
      return '42-69';
    }),
    joinRoom: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    getState: vi.fn().mockReturnValue('idle'),
    getRole: vi.fn().mockReturnValue('sender')
  }))
}));

describe('useTransferStore', () => {
  beforeEach(() => {
    useTransferStore.getState().reset();
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('has correct initial values', () => {
      const state = useTransferStore.getState();

      expect(state.engine).toBeNull();
      expect(state.state).toBe('idle');
      expect(state.role).toBeNull();
      expect(state.roomCode).toBe('');
      expect(state.peerConnected).toBe(false);
      expect(state.error).toBeNull();
      expect(state.file).toBeNull();
      expect(state.fileMetadata).toBeNull();
      expect(state.progress).toBeNull();
    });
  });

  describe('initEngine', () => {
    it('creates new engine instance', () => {
      const { initEngine } = useTransferStore.getState();

      initEngine('ws://test:8080/ws');

      expect(useTransferStore.getState().engine).not.toBeNull();
    });

    it('destroys existing engine before creating new one', () => {
      const { initEngine } = useTransferStore.getState();

      initEngine('ws://test:8080/ws');
      const firstEngine = useTransferStore.getState().engine;

      initEngine('ws://test:8080/ws');

      expect(firstEngine?.destroy).toHaveBeenCalled();
    });
  });

  describe('createRoom', () => {
    it('creates room and sets state', async () => {
      const file = new File(['test'], 'test.txt', { type: 'text/plain' });
      const { createRoom } = useTransferStore.getState();

      const code = await createRoom(file);

      const state = useTransferStore.getState();
      expect(code).toBe('42-69');
      expect(state.file).toBe(file);
      expect(state.role).toBe('sender');
      expect(state.error).toBeNull();
    });

    it('initializes engine if not present', async () => {
      const file = new File(['test'], 'test.txt');
      const { createRoom } = useTransferStore.getState();

      expect(useTransferStore.getState().engine).toBeNull();

      await createRoom(file);

      expect(useTransferStore.getState().engine).not.toBeNull();
    });

    it('saves session to localStorage', async () => {
      const file = new File(['test'], 'test.txt');
      const { createRoom } = useTransferStore.getState();

      await createRoom(file);

      const stored = JSON.parse(localStorage.getItem('warp-lan-session') ?? '{}');
      expect(stored.roomCode).toBe('42-69');
      expect(stored.role).toBe('sender');
    });

    it('handles errors and sets error state', async () => {
      const { TransferEngine } = await import('../TransferEngine');
      (TransferEngine as ReturnType<typeof vi.fn>).mockImplementationOnce((_url, _events) => ({
        createRoom: vi.fn().mockRejectedValue(new Error('Test error')),
        destroy: vi.fn()
      }));

      const { initEngine, createRoom } = useTransferStore.getState();
      initEngine('ws://test:8080/ws');

      const file = new File(['test'], 'test.txt');
      await expect(createRoom(file)).rejects.toThrow('Test error');

      expect(useTransferStore.getState().error).toBe('Test error');
      expect(useTransferStore.getState().state).toBe('error');
    });
  });

  describe('joinRoom', () => {
    it('joins room and sets state', async () => {
      const { joinRoom } = useTransferStore.getState();

      await joinRoom('12-34');

      const state = useTransferStore.getState();
      expect(state.role).toBe('receiver');
      expect(state.roomCode).toBe('12-34');
    });

    it('saves session to localStorage', async () => {
      const { joinRoom } = useTransferStore.getState();

      await joinRoom('12-34');

      const stored = JSON.parse(localStorage.getItem('warp-lan-session') ?? '{}');
      expect(stored.roomCode).toBe('12-34');
      expect(stored.role).toBe('receiver');
    });
  });

  describe('reset', () => {
    it('resets all state to initial values', async () => {
      const file = new File(['test'], 'test.txt');
      const { createRoom, reset } = useTransferStore.getState();

      await createRoom(file);

      reset();

      const state = useTransferStore.getState();
      expect(state.engine).toBeNull();
      expect(state.state).toBe('idle');
      expect(state.role).toBeNull();
      expect(state.roomCode).toBe('');
      expect(state.file).toBeNull();
    });

    it('clears localStorage session', async () => {
      const file = new File(['test'], 'test.txt');
      const { createRoom, reset } = useTransferStore.getState();

      await createRoom(file);
      expect(localStorage.getItem('warp-lan-session')).not.toBeNull();

      reset();

      expect(localStorage.getItem('warp-lan-session')).toBeNull();
    });
  });

  describe('restoreSession', () => {
    it('restores session from localStorage', () => {
      const session = {
        roomCode: '99-88',
        role: 'sender',
        timestamp: Date.now()
      };
      localStorage.setItem('warp-lan-session', JSON.stringify(session));

      const { restoreSession } = useTransferStore.getState();
      const restored = restoreSession();

      expect(restored?.roomCode).toBe('99-88');
      expect(useTransferStore.getState().roomCode).toBe('99-88');
      expect(useTransferStore.getState().role).toBe('sender');
    });

    it('returns null for expired session', () => {
      const session = {
        roomCode: '99-88',
        role: 'sender',
        timestamp: Date.now() - 15 * 60 * 1000 // 15 minutes ago
      };
      localStorage.setItem('warp-lan-session', JSON.stringify(session));

      const { restoreSession } = useTransferStore.getState();
      const restored = restoreSession();

      expect(restored).toBeNull();
    });

    it('returns null when no session exists', () => {
      const { restoreSession } = useTransferStore.getState();
      const restored = restoreSession();

      expect(restored).toBeNull();
    });
  });

  describe('event callbacks', () => {
    it('onStateChange updates state', async () => {
      const { TransferEngine } = await import('../TransferEngine');
      let capturedEvents: Record<string, unknown> = {};

      (TransferEngine as ReturnType<typeof vi.fn>).mockImplementationOnce((_url, events) => {
        capturedEvents = events;
        return {
          createRoom: vi.fn().mockResolvedValue('42-69'),
          destroy: vi.fn()
        };
      });

      const { initEngine } = useTransferStore.getState();
      initEngine('ws://test:8080/ws');

      (capturedEvents.onStateChange as (s: string) => void)?.('connecting');

      expect(useTransferStore.getState().state).toBe('connecting');
    });

    it('onProgress updates progress', async () => {
      const { TransferEngine } = await import('../TransferEngine');
      let capturedEvents: Record<string, unknown> = {};

      (TransferEngine as ReturnType<typeof vi.fn>).mockImplementationOnce((_url, events) => {
        capturedEvents = events;
        return {
          createRoom: vi.fn().mockResolvedValue('42-69'),
          destroy: vi.fn()
        };
      });

      const { initEngine } = useTransferStore.getState();
      initEngine('ws://test:8080/ws');

      const progress = { bytesTransferred: 100, totalBytes: 1000, percentage: 10, speed: 50, speedHistory: [], eta: 18 };
      (capturedEvents.onProgress as (p: typeof progress) => void)?.(progress);

      expect(useTransferStore.getState().progress).toEqual(progress);
    });

    it('onPeerConnected sets peerConnected true', async () => {
      const { TransferEngine } = await import('../TransferEngine');
      let capturedEvents: Record<string, unknown> = {};

      (TransferEngine as ReturnType<typeof vi.fn>).mockImplementationOnce((_url, events) => {
        capturedEvents = events;
        return {
          createRoom: vi.fn().mockResolvedValue('42-69'),
          destroy: vi.fn()
        };
      });

      const { initEngine } = useTransferStore.getState();
      initEngine('ws://test:8080/ws');

      (capturedEvents.onPeerConnected as () => void)?.();

      expect(useTransferStore.getState().peerConnected).toBe(true);
    });

    it('onFileMetadata sets fileMetadata', async () => {
      const { TransferEngine } = await import('../TransferEngine');
      let capturedEvents: Record<string, unknown> = {};

      (TransferEngine as ReturnType<typeof vi.fn>).mockImplementationOnce((_url, events) => {
        capturedEvents = events;
        return {
          createRoom: vi.fn().mockResolvedValue('42-69'),
          destroy: vi.fn()
        };
      });

      const { initEngine } = useTransferStore.getState();
      initEngine('ws://test:8080/ws');

      const metadata = { name: 'test.txt', size: 1000, type: 'text/plain' };
      (capturedEvents.onFileMetadata as (m: typeof metadata) => void)?.(metadata);

      expect(useTransferStore.getState().fileMetadata).toEqual(metadata);
    });
  });
});
