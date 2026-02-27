/**
 * SignalingClient handles WebSocket communication with the signaling server
 * Used to exchange WebRTC offer/answer/ICE candidates and PAKE handshake messages
 */

export type MessageType =
  | 'offer'
  | 'answer'
  | 'ice-candidate'
  | 'handshake-init'
  | 'handshake-verify'
  | 'connected'
  | 'error'
  | 'peer-joined'
  | 'peer-left'
  | 'room-expired';

export interface SignalingMessage {
  type: MessageType;
  from?: string;
  to?: string;
  roomId?: string;
  payload?: unknown;
  clientId?: string;
}

type MessageHandler = (message: SignalingMessage) => void;

export interface SignalingClientConfig {
  url: string;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
  onMessage?: MessageHandler;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private clientId: string = '';
  private roomId: string = '';
  private messageHandlers: Map<MessageType, Set<MessageHandler>> = new Map();
  private config: SignalingClientConfig;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private isReconnecting = false;

  constructor(config: SignalingClientConfig) {
    this.config = config;
  }

  private static CONNECTION_TIMEOUT_MS = 10_000;

  // Connect to signaling server
  async connect(): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const settle = (fn: (value: never) => void, value: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value as never);
      };

      const timer = setTimeout(() => {
        settle(reject, new Error('Connection timeout: server did not respond within 10 seconds'));
        this.ws?.close();
      }, SignalingClient.CONNECTION_TIMEOUT_MS);

      try {
        this.ws = new WebSocket(this.config.url);

        this.ws.onopen = () => {
          console.log('[Signaling] Connected to server');
          this.reconnectAttempts = 0;
          this.isReconnecting = false;
          this.config.onOpen?.();
        };

        this.ws.onclose = () => {
          console.log('[Signaling] Disconnected from server');
          this.config.onClose?.();
          if (!settled) {
            settle(reject, new Error('Connection closed before server acknowledged the connection'));
          } else {
            this.attemptReconnect();
          }
        };

        this.ws.onerror = (event) => {
          console.error('[Signaling] WebSocket error:', event);
          this.config.onError?.(event);
          const error = this.ws?.readyState === WebSocket.CONNECTING
            ? new Error('Could not connect to server. Check your internet connection.')
            : new Error('Connection to server lost unexpectedly');
          settle(reject, error);
        };

        this.ws.onmessage = (event) => {
          try {
            const message: SignalingMessage = JSON.parse(event.data);
            // Always assign clientId so reconnects and late messages still work
            if (message.type === 'connected' && message.clientId) {
              this.clientId = message.clientId;
              console.log('[Signaling] Received client ID:', this.clientId);
              settle(resolve, this.clientId);
            }
            this.handleMessage(message);
          } catch (e) {
            console.error('[Signaling] Failed to parse message:', e);
          }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create WebSocket connection';
        settle(reject, new Error(message));
      }
    });
  }

  private handleMessage(message: SignalingMessage) {
    // Notify specific type handlers
    const handlers = this.messageHandlers.get(message.type);
    if (handlers) {
      handlers.forEach((handler) => handler(message));
    }

    // Notify global handler
    this.config.onMessage?.(message);
  }

  // Attempt to reconnect on disconnect
  private attemptReconnect() {
    if (this.isReconnecting || this.reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    const baseDelay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    const delay = Math.round(baseDelay * (0.5 + Math.random() * 0.5));
    console.log(`[Signaling] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        this.connect()
          .then(() => {
            // Rejoin room if we were in one
            if (this.roomId) {
              this.joinRoom(this.roomId);
            }
          })
          .catch(() => {
            this.isReconnecting = false;
          });
      }
    }, delay);
  }

  // Join a room
  joinRoom(roomId: string): void {
    this.roomId = roomId;
    this.send({
      type: 'handshake-init',
      roomId
    });
    console.log('[Signaling] Joining room:', roomId);
  }

  // Send a message
  send(message: Partial<SignalingMessage>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[Signaling] Cannot send - not connected');
      return;
    }

    const fullMessage: SignalingMessage = {
      type: message.type || 'error',
      ...message,
      roomId: message.roomId || this.roomId
    };

    this.ws.send(JSON.stringify(fullMessage));
  }

  // Send offer to peer
  sendOffer(offer: RTCSessionDescriptionInit, peerId?: string): void {
    this.send({
      type: 'offer',
      to: peerId,
      payload: offer
    });
  }

  // Send answer to peer
  sendAnswer(answer: RTCSessionDescriptionInit, peerId: string): void {
    this.send({
      type: 'answer',
      to: peerId,
      payload: answer
    });
  }

  // Send ICE candidate
  sendIceCandidate(candidate: RTCIceCandidate, peerId?: string): void {
    this.send({
      type: 'ice-candidate',
      to: peerId,
      payload: candidate.toJSON()
    });
  }

  // Send handshake verification message
  sendHandshakeVerify(payload: unknown, peerId?: string): void {
    this.send({
      type: 'handshake-verify',
      to: peerId,
      payload
    });
  }

  // Register handler for specific message type
  on(type: MessageType, handler: MessageHandler): () => void {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set());
    }
    this.messageHandlers.get(type)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.messageHandlers.get(type)?.delete(handler);
    };
  }

  // Get client ID
  getClientId(): string {
    return this.clientId;
  }

  // Get room ID
  getRoomId(): string {
    return this.roomId;
  }

  // Check if connected
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // Disconnect
  disconnect(): void {
    this.maxReconnectAttempts = 0; // Prevent reconnection
    this.ws?.close();
    this.ws = null;
    this.clientId = '';
    this.roomId = '';
    this.messageHandlers.clear();
  }
}
