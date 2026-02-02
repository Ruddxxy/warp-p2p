/**
 * SignalingClient Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SignalingClient, SignalingMessage } from '../SignalingClient';

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;

  private sentMessages: string[] = [];

  constructor(public url: string) {
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  getSentMessages(): string[] {
    return this.sentMessages;
  }

  clearSentMessages(): void {
    this.sentMessages = [];
  }

  simulateMessage(data: SignalingMessage): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  simulateError(): void {
    this.onerror?.(new Event('error'));
  }
}

// Replace global WebSocket
const originalWebSocket = globalThis.WebSocket;

describe('SignalingClient', () => {
  let mockWs: MockWebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    // Create mock constructor with static properties matching real WebSocket
    const MockWebSocketConstructor = Object.assign(
      vi.fn((url: string) => {
        mockWs = new MockWebSocket(url);
        return mockWs;
      }),
      {
        CONNECTING: MockWebSocket.CONNECTING,
        OPEN: MockWebSocket.OPEN,
        CLOSING: MockWebSocket.CLOSING,
        CLOSED: MockWebSocket.CLOSED
      }
    );
    globalThis.WebSocket = MockWebSocketConstructor as unknown as typeof WebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
  });

  describe('connect', () => {
    it('connects to server and receives clientId', async () => {
      const client = new SignalingClient({ url: 'ws://test:8080/ws' });
      const connectPromise = client.connect();

      await vi.runAllTimersAsync();

      mockWs.simulateMessage({ type: 'connected', clientId: 'abc123' });

      const clientId = await connectPromise;
      expect(clientId).toBe('abc123');
      expect(client.getClientId()).toBe('abc123');
    });

    it('calls onOpen callback', async () => {
      const onOpen = vi.fn();
      const client = new SignalingClient({ url: 'ws://test:8080/ws', onOpen });

      client.connect();
      await vi.runAllTimersAsync();

      expect(onOpen).toHaveBeenCalled();
    });

    it('rejects on error', async () => {
      const client = new SignalingClient({ url: 'ws://test:8080/ws' });
      const connectPromise = client.connect();

      await vi.runAllTimersAsync();
      mockWs.simulateError();

      await expect(connectPromise).rejects.toBeDefined();
    });
  });

  describe('joinRoom', () => {
    it('sends handshake-init message', async () => {
      const client = new SignalingClient({ url: 'ws://test:8080/ws' });
      client.connect();
      await vi.runAllTimersAsync();
      mockWs.simulateMessage({ type: 'connected', clientId: 'test' });

      client.joinRoom('42-69');

      const sent = mockWs.getSentMessages();
      const msg = JSON.parse(sent[0]);
      expect(msg.type).toBe('handshake-init');
      expect(msg.roomId).toBe('42-69');
      expect(client.getRoomId()).toBe('42-69');
    });
  });

  describe('send methods', () => {
    let client: SignalingClient;

    beforeEach(async () => {
      client = new SignalingClient({ url: 'ws://test:8080/ws' });
      client.connect();
      await vi.runAllTimersAsync();
      mockWs.simulateMessage({ type: 'connected', clientId: 'test' });
      client.joinRoom('test-room');
      mockWs.clearSentMessages();
    });

    it('sendOffer sends offer message', () => {
      const offer = { type: 'offer', sdp: 'test-sdp' } as RTCSessionDescriptionInit;
      client.sendOffer(offer, 'peer1');

      const sent = JSON.parse(mockWs.getSentMessages()[0]);
      expect(sent.type).toBe('offer');
      expect(sent.to).toBe('peer1');
      expect(sent.payload).toEqual(offer);
    });

    it('sendAnswer sends answer message', () => {
      const answer = { type: 'answer', sdp: 'test-sdp' } as RTCSessionDescriptionInit;
      client.sendAnswer(answer, 'peer1');

      const sent = JSON.parse(mockWs.getSentMessages()[0]);
      expect(sent.type).toBe('answer');
      expect(sent.to).toBe('peer1');
    });

    it('sendIceCandidate sends ice-candidate message', () => {
      const candidate = {
        toJSON: () => ({ candidate: 'test', sdpMid: '0', sdpMLineIndex: 0 })
      } as RTCIceCandidate;
      client.sendIceCandidate(candidate, 'peer1');

      const sent = JSON.parse(mockWs.getSentMessages()[0]);
      expect(sent.type).toBe('ice-candidate');
    });

    it('sendHandshakeVerify sends handshake-verify message', () => {
      client.sendHandshakeVerify({ key: 'value' }, 'peer1');

      const sent = JSON.parse(mockWs.getSentMessages()[0]);
      expect(sent.type).toBe('handshake-verify');
      expect(sent.payload).toEqual({ key: 'value' });
    });
  });

  describe('message handlers', () => {
    it('registers and triggers type-specific handlers', async () => {
      const client = new SignalingClient({ url: 'ws://test:8080/ws' });
      client.connect();
      await vi.runAllTimersAsync();

      const handler = vi.fn();
      client.on('peer-joined', handler);

      mockWs.simulateMessage({ type: 'connected', clientId: 'test' });
      mockWs.simulateMessage({ type: 'peer-joined', clientId: 'peer1' });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'peer-joined' }));
    });

    it('unsubscribe removes handler', async () => {
      const client = new SignalingClient({ url: 'ws://test:8080/ws' });
      client.connect();
      await vi.runAllTimersAsync();

      const handler = vi.fn();
      const unsubscribe = client.on('peer-joined', handler);
      unsubscribe();

      mockWs.simulateMessage({ type: 'connected', clientId: 'test' });
      mockWs.simulateMessage({ type: 'peer-joined', clientId: 'peer1' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('calls global onMessage handler', async () => {
      const onMessage = vi.fn();
      const client = new SignalingClient({ url: 'ws://test:8080/ws', onMessage });
      client.connect();
      await vi.runAllTimersAsync();

      mockWs.simulateMessage({ type: 'connected', clientId: 'test' });

      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'connected' }));
    });
  });

  describe('isConnected', () => {
    it('returns true when connected', async () => {
      const client = new SignalingClient({ url: 'ws://test:8080/ws' });
      client.connect();
      await vi.runAllTimersAsync();

      expect(client.isConnected()).toBe(true);
    });

    it('returns false before connect', () => {
      const client = new SignalingClient({ url: 'ws://test:8080/ws' });
      expect(client.isConnected()).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('closes connection and clears state', async () => {
      const client = new SignalingClient({ url: 'ws://test:8080/ws' });
      client.connect();
      await vi.runAllTimersAsync();
      mockWs.simulateMessage({ type: 'connected', clientId: 'test' });
      client.joinRoom('room1');

      client.disconnect();

      expect(client.isConnected()).toBe(false);
      expect(client.getClientId()).toBe('');
      expect(client.getRoomId()).toBe('');
    });
  });

  describe('reconnection', () => {
    it('attempts reconnect on close with exponential backoff', async () => {
      const client = new SignalingClient({ url: 'ws://test:8080/ws' });
      client.connect();
      await vi.runAllTimersAsync();
      mockWs.simulateMessage({ type: 'connected', clientId: 'test' });

      const wsSpy = vi.spyOn(globalThis, 'WebSocket' as never);

      // Simulate disconnect
      mockWs.close();

      // First reconnect after 1s * 2^0 = 1s
      await vi.advanceTimersByTimeAsync(1000);
      expect(wsSpy).toHaveBeenCalledTimes(1);
    });
  });
});
