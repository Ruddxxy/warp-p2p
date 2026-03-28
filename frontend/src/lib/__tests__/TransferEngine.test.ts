/**
 * TransferEngine Tests
 *
 * Covers critical fixes:
 * - Fix 1.1: ICE candidate queuing before setRemoteDescription
 * - Fix 1.2: 30-second WebRTC connection timeout
 * - Fix 2.1: Receiver enters handshaking state
 * - Fix 2.2: Peer disconnect during setup phases triggers error
 * - Fix 4.1: File metadata validation (size, name, path traversal)
 * - Fix 2.4: Event-driven backpressure via bufferedAmountLowThreshold
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { SignalingMessage, MessageType } from '../SignalingClient';

// ---------------------------------------------------------------------------
// Mocks — declared before imports so vi.mock hoisting works
// ---------------------------------------------------------------------------

// Capture the handlers registered on the mock SignalingClient so tests can
// invoke them directly (simulating signaling server messages).
type Handler = (msg: SignalingMessage) => void;
const signalingHandlers = new Map<MessageType, Set<Handler>>();

const mockSignalingClient = {
  connect: vi.fn().mockResolvedValue('mock-client-id'),
  joinRoom: vi.fn(),
  on: vi.fn((type: MessageType, handler: Handler) => {
    if (!signalingHandlers.has(type)) {
      signalingHandlers.set(type, new Set());
    }
    signalingHandlers.get(type)!.add(handler);
    return () => signalingHandlers.get(type)?.delete(handler);
  }),
  sendOffer: vi.fn().mockReturnValue(true),
  sendAnswer: vi.fn().mockReturnValue(true),
  sendIceCandidate: vi.fn().mockReturnValue(true),
  sendHandshakeVerify: vi.fn().mockReturnValue(true),
  disconnect: vi.fn(),
  allowReconnect: true,
};

vi.mock('../SignalingClient', () => ({
  SignalingClient: vi.fn().mockImplementation(
    function(_config: { onClose?: () => void; onError?: () => void }) {
      return mockSignalingClient;
    }
  ),
}));

vi.mock('../Security', () => ({
  SecurityManager: vi.fn().mockImplementation(function() {
    return {
      init: vi.fn().mockResolvedValue(undefined),
      createHandshakeMessage: vi.fn().mockResolvedValue({
        publicKey: 'mockPubKey',
        signature: 'mockSig',
        nonce: 'mockNonce',
      }),
      processHandshakeMessage: vi.fn().mockResolvedValue(true),
      encryptChunk: vi.fn().mockImplementation(async (buf: ArrayBuffer) => buf),
      decryptChunk: vi.fn().mockImplementation(async (buf: ArrayBuffer) => buf),
      destroy: vi.fn(),
    };
  }),
  generateRoomCode: vi.fn().mockReturnValue('123-456'),
}));

vi.mock('../StreamingHasher', () => ({
  StreamingHasher: vi.fn().mockImplementation(function() {
    return {
      update: vi.fn(),
      digest: vi.fn().mockReturnValue('mockhash'),
      reset: vi.fn(),
    };
  }),
}));

vi.mock('streamsaver', () => ({
  default: {
    mitm: '',
    createWriteStream: vi.fn().mockReturnValue({
      getWriter: vi.fn().mockReturnValue({
        write: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn(),
      }),
    }),
  },
}));

vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock WebRTC globals
// ---------------------------------------------------------------------------

let mockPcConnectionState = 'new';
let mockPcOnConnectionStateChange: (() => void) | null = null;
let mockPcOnDataChannel: ((e: { channel: MockDataChannel }) => void) | null = null;
let mockPcOnIceCandidate: ((e: { candidate?: unknown }) => void) | null = null;

class MockDataChannel {
  binaryType = 'arraybuffer';
  readyState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;

  private _listeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();

  addEventListener = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event)!.add(handler);
  });

  removeEventListener = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    this._listeners.get(event)?.delete(handler);
  });

  dispatchEvent(event: string) {
    this._listeners.get(event)?.forEach(fn => fn());
  }

  send = vi.fn();
  close = vi.fn();
}

let latestDataChannel: MockDataChannel;
let latestPeerConnection: MockRTCPeerConnection;

class MockRTCPeerConnection {
  connectionState = 'new';
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((e: { channel: MockDataChannel }) => void) | null = null;
  onicecandidate: ((e: { candidate?: unknown }) => void) | null = null;

  addIceCandidate = vi.fn().mockResolvedValue(undefined);
  createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'mock-sdp' });
  createAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'mock-sdp' });
  setLocalDescription = vi.fn().mockResolvedValue(undefined);
  setRemoteDescription = vi.fn().mockResolvedValue(undefined);
  close = vi.fn();

  createDataChannel = vi.fn((_label: string, _opts?: unknown) => {
    latestDataChannel = new MockDataChannel();
    return latestDataChannel;
  });

  constructor() {
    latestPeerConnection = this;
    mockPcConnectionState = 'new';
    // Wire up proxy getters/setters so tests can change state and trigger
    // callbacks externally while the engine interacts with the real instance.
    Object.defineProperty(this, 'connectionState', {
      get: () => mockPcConnectionState,
    });
    Object.defineProperty(this, 'onconnectionstatechange', {
      get: () => mockPcOnConnectionStateChange,
      set: (fn: (() => void) | null) => { mockPcOnConnectionStateChange = fn; },
    });
    Object.defineProperty(this, 'ondatachannel', {
      get: () => mockPcOnDataChannel,
      set: (fn: ((e: { channel: MockDataChannel }) => void) | null) => { mockPcOnDataChannel = fn; },
    });
    Object.defineProperty(this, 'onicecandidate', {
      get: () => mockPcOnIceCandidate,
      set: (fn: ((e: { candidate?: unknown }) => void) | null) => { mockPcOnIceCandidate = fn; },
    });
  }
}

class MockRTCSessionDescription {
  type: string;
  sdp: string;
  constructor(init: RTCSessionDescriptionInit) {
    this.type = init.type ?? 'offer';
    this.sdp = init.sdp ?? '';
  }
}

class MockRTCIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  constructor(init: RTCIceCandidateInit) {
    this.candidate = init.candidate ?? '';
    this.sdpMid = init.sdpMid ?? null;
    this.sdpMLineIndex = init.sdpMLineIndex ?? null;
  }
  toJSON() {
    return { candidate: this.candidate, sdpMid: this.sdpMid, sdpMLineIndex: this.sdpMLineIndex };
  }
}

// Stub global fetch for TURN credentials
const originalFetch = globalThis.fetch;
const originalRTCPeerConnection = globalThis.RTCPeerConnection;
const originalRTCSessionDescription = globalThis.RTCSessionDescription;
const originalRTCIceCandidate = globalThis.RTCIceCandidate;

// ---------------------------------------------------------------------------
// Import under test (after mocks are declared)
// ---------------------------------------------------------------------------
import { TransferEngine, type TransferEngineEvents } from '../TransferEngine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Emit a signaling event as if the server sent it. */
function emitSignaling(type: MessageType, msg: Partial<SignalingMessage> = {}): void {
  const handlers = signalingHandlers.get(type);
  if (handlers) {
    handlers.forEach((h) => h({ type, ...msg } as SignalingMessage));
  }
}

/** Create a small File object for testing. */
function createTestFile(name = 'test.txt', sizeBytes = 128): File {
  const content = new Uint8Array(sizeBytes);
  return new File([content], name, { type: 'text/plain' });
}

/** Convenience: advance to the point where peer has joined and handshake is verified. */
async function advanceThroughHandshake(engine: TransferEngine, role: 'sender' | 'receiver'): Promise<void> {
  if (role === 'sender') {
    // Sender creates room, then peer joins, then handshake-verify comes back
    await engine.createRoom(createTestFile());
    emitSignaling('peer-joined', { clientId: 'peer-1' });
    // Give the async initiateHandshake time to settle
    await vi.advanceTimersByTimeAsync(0);
    // Simulate receiver responding with handshake-verify
    emitSignaling('handshake-verify', {
      from: 'peer-1',
      payload: { publicKey: 'pk', signature: 'sig', nonce: 'n' },
    });
    await vi.advanceTimersByTimeAsync(0);
  } else {
    await engine.joinRoom('123-456');
    // Sender's handshake-verify arrives
    emitSignaling('handshake-verify', {
      from: 'peer-1',
      payload: { publicKey: 'pk', signature: 'sig', nonce: 'n' },
    });
    await vi.advanceTimersByTimeAsync(0);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TransferEngine', () => {
  let events: Required<TransferEngineEvents>;

  beforeEach(() => {
    vi.useFakeTimers();

    // Reset per-test state
    signalingHandlers.clear();
    mockPcConnectionState = 'new';
    mockPcOnConnectionStateChange = null;
    mockPcOnDataChannel = null;
    mockPcOnIceCandidate = null;
    mockSignalingClient.allowReconnect = true;

    // Install WebRTC globals
    globalThis.RTCPeerConnection = MockRTCPeerConnection as unknown as typeof RTCPeerConnection;
    globalThis.RTCSessionDescription = MockRTCSessionDescription as unknown as typeof RTCSessionDescription;
    globalThis.RTCIceCandidate = MockRTCIceCandidate as unknown as typeof RTCIceCandidate;

    // Polyfill Blob.prototype.arrayBuffer for test environment (happy-dom/jsdom).
    // Uses a synchronous approach to avoid conflicts with fake timers.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Blob.prototype as any).arrayBuffer = function (this: Blob) {
      // Return a zero-filled buffer matching the blob size
      return Promise.resolve(new ArrayBuffer(this.size));
    };

    // Stub fetch to return STUN-only (no TURN)
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;

    // Build event spies
    events = {
      onStateChange: vi.fn(),
      onProgress: vi.fn(),
      onError: vi.fn(),
      onPeerConnected: vi.fn(),
      onPeerDisconnected: vi.fn(),
      onFileMetadata: vi.fn(),
      onRoomCode: vi.fn(),
      onHashVerified: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    globalThis.RTCPeerConnection = originalRTCPeerConnection;
    globalThis.RTCSessionDescription = originalRTCSessionDescription;
    globalThis.RTCIceCandidate = originalRTCIceCandidate;
  });

  // -----------------------------------------------------------------------
  // Fix 1.1 — ICE candidate queuing
  // -----------------------------------------------------------------------
  describe('Fix 1.1 — ICE candidate queuing', () => {
    it('queues ICE candidates received before setRemoteDescription and flushes after', async () => {
      const engine = new TransferEngine('ws://test/ws', events);
      await engine.joinRoom('123-456');

      // Before any offer is received, send ICE candidates via signaling.
      // Since there is no peer connection yet, these must be queued internally.
      emitSignaling('ice-candidate', {
        from: 'peer-1',
        payload: { candidate: 'c1', sdpMid: '0', sdpMLineIndex: 0 },
      });
      emitSignaling('ice-candidate', {
        from: 'peer-1',
        payload: { candidate: 'c2', sdpMid: '0', sdpMLineIndex: 0 },
      });
      await vi.advanceTimersByTimeAsync(0);

      // Now simulate the handshake completing
      emitSignaling('handshake-verify', {
        from: 'peer-1',
        payload: { publicKey: 'pk', signature: 'sig', nonce: 'n' },
      });
      await vi.advanceTimersByTimeAsync(0);

      // Offer arrives — this creates the peer connection and calls setRemoteDescription,
      // then flushes the two queued candidates.
      emitSignaling('offer', {
        from: 'peer-1',
        payload: { type: 'offer', sdp: 'mock-sdp' },
      });
      await vi.advanceTimersByTimeAsync(0);

      // Verify the peer connection was created and addIceCandidate was called
      // for both queued candidates.
      const pc = latestPeerConnection;
      expect(pc).toBeDefined();
      expect(pc.addIceCandidate).toHaveBeenCalledTimes(2);
    });

    it('adds ICE candidates directly when remote description is already set', async () => {
      const engine = new TransferEngine('ws://test/ws', events);
      await engine.joinRoom('123-456');

      // Complete handshake and offer so remote description is set
      emitSignaling('handshake-verify', {
        from: 'peer-1',
        payload: { publicKey: 'pk', signature: 'sig', nonce: 'n' },
      });
      await vi.advanceTimersByTimeAsync(0);

      emitSignaling('offer', {
        from: 'peer-1',
        payload: { type: 'offer', sdp: 'mock-sdp' },
      });
      await vi.advanceTimersByTimeAsync(0);

      const pc = latestPeerConnection;
      const callsBefore = pc.addIceCandidate.mock.calls.length;

      // Now send an ICE candidate — it should be added immediately (not queued)
      emitSignaling('ice-candidate', {
        from: 'peer-1',
        payload: { candidate: 'c-late', sdpMid: '0', sdpMLineIndex: 0 },
      });
      await vi.advanceTimersByTimeAsync(0);

      // addIceCandidate should have been called once more for the late candidate
      expect(pc.addIceCandidate).toHaveBeenCalledTimes(callsBefore + 1);
      expect(events.onError).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Fix 1.2 — WebRTC connection timeout (30s)
  // -----------------------------------------------------------------------
  describe('Fix 1.2 — WebRTC connection timeout', () => {
    it('fires an error after 30 seconds if WebRTC does not connect', async () => {
      const engine = new TransferEngine('ws://test/ws', events);

      // Sender creates room, peer joins, handshake completes, offer is sent
      await advanceThroughHandshake(engine, 'sender');

      // At this point createPeerConnection has been called and timeout started.
      // Do NOT simulate a successful connection — let the timeout fire.
      expect(events.onError).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);

      expect(events.onError).toHaveBeenCalledTimes(1);
      const errorArg = (events.onError as Mock).mock.calls[0][0] as Error;
      expect(errorArg.message).toContain('WebRTC connection timed out');
    });

    it('does NOT fire the timeout if WebRTC connects within 30s', async () => {
      const engine = new TransferEngine('ws://test/ws', events);
      await advanceThroughHandshake(engine, 'sender');

      // Simulate successful connection before timeout
      mockPcConnectionState = 'connected';
      mockPcOnConnectionStateChange?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(events.onStateChange).toHaveBeenCalledWith('ready');

      // Also open the data channel to clear the data channel timeout
      const dc = latestDataChannel ?? new MockDataChannel();
      dc.onopen?.();
      await vi.advanceTimersByTimeAsync(0);

      // Advance past the 30s mark — no error should appear
      await vi.advanceTimersByTimeAsync(30_000);

      expect(events.onError).not.toHaveBeenCalled();
    });

    it('clears the timeout on stop/cleanup', async () => {
      const engine = new TransferEngine('ws://test/ws', events);
      await advanceThroughHandshake(engine, 'sender');

      engine.stop();

      // Advance past 30s — timeout should have been cleared
      await vi.advanceTimersByTimeAsync(30_000);

      // onError should not have been called with the timeout error (only state
      // change to idle from stop is expected)
      const errorCalls = (events.onError as Mock).mock.calls;
      const hasTimeoutError = errorCalls.some(
        (call: unknown[]) => (call[0] as Error).message.includes('timed out')
      );
      expect(hasTimeoutError).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Fix 2.1 — Receiver enters handshaking state
  // -----------------------------------------------------------------------
  describe('Fix 2.1 — Receiver enters handshaking state', () => {
    it('transitions the receiver to handshaking when handshake-verify is received', async () => {
      const engine = new TransferEngine('ws://test/ws', events);
      await engine.joinRoom('123-456');

      // State should be connecting after joinRoom
      expect(events.onStateChange).toHaveBeenCalledWith('connecting');

      // Simulate handshake-verify from sender
      emitSignaling('handshake-verify', {
        from: 'peer-1',
        payload: { publicKey: 'pk', signature: 'sig', nonce: 'n' },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(events.onStateChange).toHaveBeenCalledWith('handshaking');
    });

    it('transitions the sender to handshaking when peer joins', async () => {
      const engine = new TransferEngine('ws://test/ws', events);
      await engine.createRoom(createTestFile());

      emitSignaling('peer-joined', { clientId: 'peer-1' });
      await vi.advanceTimersByTimeAsync(0);

      expect(events.onStateChange).toHaveBeenCalledWith('handshaking');
    });
  });

  // -----------------------------------------------------------------------
  // Fix 2.2 — Peer disconnect during setup phases
  // -----------------------------------------------------------------------
  describe('Fix 2.2 — Peer disconnect during setup phases', () => {
    it.each(['connecting', 'handshaking', 'ready'] as const)(
      'triggers an error when peer-left fires during "%s" state',
      async (phase) => {
        const engine = new TransferEngine('ws://test/ws', events);

        // Move the engine to the target phase
        if (phase === 'connecting') {
          await engine.joinRoom('123-456');
        } else if (phase === 'handshaking') {
          await engine.joinRoom('123-456');
          emitSignaling('handshake-verify', {
            from: 'peer-1',
            payload: { publicKey: 'pk', signature: 'sig', nonce: 'n' },
          });
          await vi.advanceTimersByTimeAsync(0);
        } else if (phase === 'ready') {
          await engine.joinRoom('123-456');
          emitSignaling('handshake-verify', {
            from: 'peer-1',
            payload: { publicKey: 'pk', signature: 'sig', nonce: 'n' },
          });
          await vi.advanceTimersByTimeAsync(0);
          emitSignaling('offer', {
            from: 'peer-1',
            payload: { type: 'offer', sdp: 'mock-sdp' },
          });
          await vi.advanceTimersByTimeAsync(0);
          // Simulate WebRTC connected
          mockPcConnectionState = 'connected';
          mockPcOnConnectionStateChange?.();
          await vi.advanceTimersByTimeAsync(0);
        }

        // Verify the engine is in the expected state
        expect(engine.getState()).toBe(phase);

        // Now simulate peer leaving
        emitSignaling('peer-left', {});

        expect(events.onPeerDisconnected).toHaveBeenCalled();
        expect(events.onError).toHaveBeenCalled();
        const errorArg = (events.onError as Mock).mock.calls[0][0] as Error;
        expect(errorArg.message).toContain('Peer disconnected');
        expect(engine.getState()).toBe('error');
      }
    );

    it('does NOT trigger an error when peer-left fires during "transferring" state (data via WebRTC)', async () => {
      const engine = new TransferEngine('ws://test/ws', events);
      await engine.joinRoom('123-456');

      // Advance to handshaking
      emitSignaling('handshake-verify', {
        from: 'peer-1',
        payload: { publicKey: 'pk', signature: 'sig', nonce: 'n' },
      });
      await vi.advanceTimersByTimeAsync(0);

      // Receive offer
      emitSignaling('offer', {
        from: 'peer-1',
        payload: { type: 'offer', sdp: 'mock-sdp' },
      });
      await vi.advanceTimersByTimeAsync(0);

      // WebRTC connects
      mockPcConnectionState = 'connected';
      mockPcOnConnectionStateChange?.();
      await vi.advanceTimersByTimeAsync(0);

      // Data channel opens — receiver gets metadata and transitions to transferring
      const dc = latestDataChannel ?? new MockDataChannel();
      if (mockPcOnDataChannel) {
        mockPcOnDataChannel({ channel: dc });
      }
      dc.onopen?.();
      await vi.advanceTimersByTimeAsync(0);

      // Simulate receiving metadata via data channel
      const metadata = JSON.stringify({
        type: 'metadata',
        metadata: { name: 'test.txt', size: 100, type: 'text/plain', hash: 'mockhash' },
      });
      dc.onmessage?.({ data: metadata });
      await vi.advanceTimersByTimeAsync(0);

      expect(engine.getState()).toBe('transferring');

      // peer-left during transferring should be ignored — data flows via WebRTC
      emitSignaling('peer-left', {});
      expect(events.onError).not.toHaveBeenCalled();
      expect(engine.getState()).toBe('transferring');
    });

    it('does NOT trigger an error when peer-left fires during "idle" state', () => {
      const engine = new TransferEngine('ws://test/ws', events);
      // Engine is idle
      expect(engine.getState()).toBe('idle');

      emitSignaling('peer-left', {});

      expect(events.onError).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Fix 4.1 — File metadata validation
  // -----------------------------------------------------------------------
  describe('Fix 4.1 — File metadata validation', () => {
    /** Helper: build a receiver engine with data channel ready for metadata messages. */
    async function setupReceiverWithDataChannel(): Promise<{
      engine: TransferEngine;
      dc: MockDataChannel;
    }> {
      const engine = new TransferEngine('ws://test/ws', events);
      await engine.joinRoom('123-456');

      emitSignaling('handshake-verify', {
        from: 'peer-1',
        payload: { publicKey: 'pk', signature: 'sig', nonce: 'n' },
      });
      await vi.advanceTimersByTimeAsync(0);

      emitSignaling('offer', {
        from: 'peer-1',
        payload: { type: 'offer', sdp: 'mock-sdp' },
      });
      await vi.advanceTimersByTimeAsync(0);

      mockPcConnectionState = 'connected';
      mockPcOnConnectionStateChange?.();
      await vi.advanceTimersByTimeAsync(0);

      const dc = new MockDataChannel();
      mockPcOnDataChannel?.({ channel: dc });
      dc.onopen?.();
      await vi.advanceTimersByTimeAsync(0);

      return { engine, dc };
    }

    it('rejects metadata with size <= 0', async () => {
      const { dc } = await setupReceiverWithDataChannel();

      dc.onmessage?.({
        data: JSON.stringify({
          type: 'metadata',
          metadata: { name: 'test.txt', size: 0, type: 'text/plain' },
        }),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(events.onError).toHaveBeenCalled();
      const errorArg = (events.onError as Mock).mock.calls[0][0] as Error;
      expect(errorArg.message).toContain('exceeds maximum');
    });

    it('rejects metadata with size exceeding MAX_FILE_SIZE', async () => {
      const { dc } = await setupReceiverWithDataChannel();

      // 26 GB — above the 25 GB limit
      const hugeSize = 26 * 1024 * 1024 * 1024;
      dc.onmessage?.({
        data: JSON.stringify({
          type: 'metadata',
          metadata: { name: 'huge.bin', size: hugeSize, type: 'application/octet-stream' },
        }),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(events.onError).toHaveBeenCalled();
      const errorArg = (events.onError as Mock).mock.calls[0][0] as Error;
      expect(errorArg.message).toContain('exceeds maximum');
    });

    it('rejects metadata with empty filename', async () => {
      const { dc } = await setupReceiverWithDataChannel();

      dc.onmessage?.({
        data: JSON.stringify({
          type: 'metadata',
          metadata: { name: '', size: 100, type: 'text/plain' },
        }),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(events.onError).toHaveBeenCalled();
      const errorArg = (events.onError as Mock).mock.calls[0][0] as Error;
      expect(errorArg.message).toContain('missing name');
    });

    it('sanitizes path traversal characters in filename', async () => {
      const { dc } = await setupReceiverWithDataChannel();

      dc.onmessage?.({
        data: JSON.stringify({
          type: 'metadata',
          metadata: { name: '../../etc/passwd', size: 100, type: 'text/plain' },
        }),
      });
      await vi.advanceTimersByTimeAsync(0);

      // Should NOT error — the name is sanitized instead
      expect(events.onError).not.toHaveBeenCalled();
      expect(events.onFileMetadata).toHaveBeenCalled();
      const sanitised = (events.onFileMetadata as Mock).mock.calls[0][0];
      // Path separators and ".." should be replaced with underscores
      expect(sanitised.name).not.toContain('/');
      expect(sanitised.name).not.toContain('\\');
      expect(sanitised.name).not.toContain('..');
    });

    it('sanitizes backslash path separators in filename', async () => {
      const { dc } = await setupReceiverWithDataChannel();

      dc.onmessage?.({
        data: JSON.stringify({
          type: 'metadata',
          metadata: { name: '..\\..\\windows\\system32\\evil.exe', size: 100, type: 'application/octet-stream' },
        }),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(events.onError).not.toHaveBeenCalled();
      expect(events.onFileMetadata).toHaveBeenCalled();
      const sanitised = (events.onFileMetadata as Mock).mock.calls[0][0];
      expect(sanitised.name).not.toContain('\\');
      expect(sanitised.name).not.toContain('..');
    });

    it('sanitizes null bytes in filename', async () => {
      const { dc } = await setupReceiverWithDataChannel();

      dc.onmessage?.({
        data: JSON.stringify({
          type: 'metadata',
          metadata: { name: 'file\0name.txt', size: 100, type: 'text/plain' },
        }),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(events.onError).not.toHaveBeenCalled();
      expect(events.onFileMetadata).toHaveBeenCalled();
      const sanitised = (events.onFileMetadata as Mock).mock.calls[0][0];
      expect(sanitised.name).not.toContain('\0');
    });

    it('accepts valid metadata with a normal filename', async () => {
      const { dc } = await setupReceiverWithDataChannel();

      dc.onmessage?.({
        data: JSON.stringify({
          type: 'metadata',
          metadata: { name: 'photo.jpg', size: 5000, type: 'image/jpeg', hash: 'abc123' },
        }),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(events.onError).not.toHaveBeenCalled();
      expect(events.onFileMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'photo.jpg', size: 5000 })
      );
    });
  });

  // -----------------------------------------------------------------------
  // Fix 2.4 — Event-driven backpressure
  // -----------------------------------------------------------------------
  describe('Fix 2.4 — Event-driven backpressure', () => {
    const BUFFER_THRESHOLD = 16 * 1024 * 1024; // 16MB — must match TransferEngine constant

    it('sets bufferedAmountLowThreshold and waits for onbufferedamountlow', async () => {
      const engine = new TransferEngine('ws://test/ws', events);
      await advanceThroughHandshake(engine, 'sender');

      // Simulate WebRTC connected
      mockPcConnectionState = 'connected';
      mockPcOnConnectionStateChange?.();
      await vi.advanceTimersByTimeAsync(0);

      // Get the data channel created by the sender
      const dc = latestDataChannel;
      expect(dc).toBeDefined();

      // Open the channel — this triggers sendMetadata
      dc.onopen?.();
      await vi.advanceTimersByTimeAsync(0);

      // Before triggering ack (which starts file sending), set bufferedAmount
      // above the threshold so the loop hits waitForBufferDrain on the first chunk.
      Object.defineProperty(dc, 'bufferedAmount', {
        get: () => BUFFER_THRESHOLD + 1,
        configurable: true,
      });

      // Trigger ack to begin startSending — it will iterate through chunks,
      // hit the bufferedAmount check, and call waitForBufferDrain.
      dc.onmessage?.({ data: JSON.stringify({ type: 'ack' }) });

      // Let the async startSending proceed through awaits until it hits
      // waitForBufferDrain (which returns a pending Promise).
      await vi.advanceTimersByTimeAsync(0);

      // Verify the engine set the threshold (event-driven, not polling)
      expect(dc.bufferedAmountLowThreshold).toBe(BUFFER_THRESHOLD);
      // Verify that onbufferedamountlow was assigned as a handler
      expect(dc.onbufferedamountlow).toBeTypeOf('function');

      // Now resolve the backpressure by lowering the buffer and firing the event
      Object.defineProperty(dc, 'bufferedAmount', {
        get: () => 0,
        configurable: true,
      });
      dc.onbufferedamountlow!();

      await vi.advanceTimersByTimeAsync(0);

      // The sending loop should have completed without errors
      // (A polling-based approach would never resolve under fake timers)
      expect(events.onError).not.toHaveBeenCalled();
    });

    it('rejects if channel is closed when backpressure check runs', async () => {
      const engine = new TransferEngine('ws://test/ws', events);
      await advanceThroughHandshake(engine, 'sender');

      mockPcConnectionState = 'connected';
      mockPcOnConnectionStateChange?.();
      await vi.advanceTimersByTimeAsync(0);

      const dc = latestDataChannel;
      dc.onopen?.();
      await vi.advanceTimersByTimeAsync(0);

      // Set high buffer AND closed state before triggering ack
      dc.readyState = 'closed';
      Object.defineProperty(dc, 'bufferedAmount', {
        get: () => BUFFER_THRESHOLD + 1,
        configurable: true,
      });

      // Trigger ack to start sending
      dc.onmessage?.({ data: JSON.stringify({ type: 'ack' }) });
      await vi.advanceTimersByTimeAsync(0);

      // waitForBufferDrain should reject because readyState !== 'open',
      // which propagates as an error through startSending
      expect(events.onError).toHaveBeenCalled();
      const errorArg = (events.onError as Mock).mock.calls[0][0] as Error;
      expect(errorArg.message).toContain('closed during transfer');
    });
  });

  // -----------------------------------------------------------------------
  // Handshake timeout
  // -----------------------------------------------------------------------
  describe('Handshake timeout', () => {
    it('fires error after 10s if handshake-verify never arrives (sender)', async () => {
      const engine = new TransferEngine('ws://test/ws', events);
      await engine.createRoom(createTestFile());

      // Peer joins — sender initiates handshake and starts timeout
      emitSignaling('peer-joined', { clientId: 'peer-1' });
      await vi.advanceTimersByTimeAsync(0);

      expect(engine.getState()).toBe('handshaking');

      // Advance 10s — handshake timeout fires
      await vi.advanceTimersByTimeAsync(10_000);

      expect(events.onError).toHaveBeenCalled();
      const errorArg = (events.onError as Mock).mock.calls[0][0] as Error;
      expect(errorArg.message).toContain('Handshake timeout');
    });

    it('does NOT fire if handshake completes within 10s', async () => {
      const engine = new TransferEngine('ws://test/ws', events);
      await advanceThroughHandshake(engine, 'sender');

      // Advance past 10s — no error
      await vi.advanceTimersByTimeAsync(10_000);

      expect(events.onError).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Data channel open timeout
  // -----------------------------------------------------------------------
  describe('Data channel open timeout', () => {
    it('fires error after 15s if data channel never opens', async () => {
      const engine = new TransferEngine('ws://test/ws', events);
      await advanceThroughHandshake(engine, 'sender');

      // WebRTC connects — state = ready, data channel timeout starts
      mockPcConnectionState = 'connected';
      mockPcOnConnectionStateChange?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(engine.getState()).toBe('ready');

      // DO NOT open data channel — advance 15s
      await vi.advanceTimersByTimeAsync(15_000);

      expect(events.onError).toHaveBeenCalled();
      const errorArg = (events.onError as Mock).mock.calls[0][0] as Error;
      expect(errorArg.message).toContain('Data channel failed to open');
    });

    it('does NOT fire if data channel opens within 15s', async () => {
      const engine = new TransferEngine('ws://test/ws', events);
      await advanceThroughHandshake(engine, 'sender');

      mockPcConnectionState = 'connected';
      mockPcOnConnectionStateChange?.();
      await vi.advanceTimersByTimeAsync(0);

      // Open data channel before timeout
      const dc = latestDataChannel ?? new MockDataChannel();
      dc.onopen?.();
      await vi.advanceTimersByTimeAsync(0);

      // Advance past 15s — no error
      await vi.advanceTimersByTimeAsync(15_000);

      expect(events.onError).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Backpressure: channel close during wait
  // -----------------------------------------------------------------------
  describe('Backpressure channel close', () => {
    const BUFFER_THRESHOLD = 16 * 1024 * 1024;

    it('rejects immediately when channel closes during backpressure wait', async () => {
      const engine = new TransferEngine('ws://test/ws', events);
      await advanceThroughHandshake(engine, 'sender');

      mockPcConnectionState = 'connected';
      mockPcOnConnectionStateChange?.();
      await vi.advanceTimersByTimeAsync(0);

      const dc = latestDataChannel;
      dc.onopen?.();
      await vi.advanceTimersByTimeAsync(0);

      // Set high buffer to trigger backpressure
      Object.defineProperty(dc, 'bufferedAmount', {
        get: () => BUFFER_THRESHOLD + 1,
        configurable: true,
      });

      // Trigger ack to start sending — will hit waitForBufferDrain
      dc.onmessage?.({ data: JSON.stringify({ type: 'ack' }) });
      await vi.advanceTimersByTimeAsync(0);

      // Simulate channel close during backpressure wait
      dc.dispatchEvent('close');
      await vi.advanceTimersByTimeAsync(0);

      expect(events.onError).toHaveBeenCalled();
      const errorArg = (events.onError as Mock).mock.calls[0][0] as Error;
      expect(errorArg.message).toContain('closed during backpressure');
    });
  });

  // -----------------------------------------------------------------------
  // Public API basics
  // -----------------------------------------------------------------------
  describe('Public API', () => {
    it('starts in idle state with sender role', () => {
      const engine = new TransferEngine('ws://test/ws', events);
      expect(engine.getState()).toBe('idle');
      expect(engine.getRole()).toBe('sender');
    });

    it('createRoom transitions to connecting and emits room code', async () => {
      const engine = new TransferEngine('ws://test/ws', events);
      const code = await engine.createRoom(createTestFile());

      expect(code).toBe('123-456');
      expect(engine.getState()).toBe('connecting');
      expect(engine.getRole()).toBe('sender');
      expect(events.onRoomCode).toHaveBeenCalledWith('123-456');
    });

    it('joinRoom transitions to connecting with receiver role', async () => {
      const engine = new TransferEngine('ws://test/ws', events);
      await engine.joinRoom('123-456');

      expect(engine.getState()).toBe('connecting');
      expect(engine.getRole()).toBe('receiver');
    });

    it('stop resets to idle', async () => {
      const engine = new TransferEngine('ws://test/ws', events);
      await engine.joinRoom('123-456');

      engine.stop();

      expect(engine.getState()).toBe('idle');
    });
  });
});
