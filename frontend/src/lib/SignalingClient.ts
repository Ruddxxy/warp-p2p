/**
 * SignalingClient handles WebSocket communication with the signaling server
 * Used to exchange WebRTC offer/answer/ICE candidates and PAKE handshake messages
 */

import { logger } from "./logger";

export type MessageType =
  | "offer"
  | "answer"
  | "ice-candidate"
  | "handshake-init"
  | "handshake-verify"
  | "connected"
  | "error"
  | "peer-joined"
  | "peer-left"
  | "room-expired";

export interface SignalingMessage {
  type: MessageType;
  from?: string;
  to?: string;
  roomId?: string;
  payload?: unknown;
  clientId?: string;
}

type MessageHandler = (message: SignalingMessage) => void | Promise<void>;

export interface SignalingClientConfig {
  url: string;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
  onMessage?: MessageHandler;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private clientId: string = "";
  private roomId: string = "";
  private messageHandlers: Map<MessageType, Set<MessageHandler>> = new Map();
  private config: SignalingClientConfig;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private isReconnecting = false;

  // Set to false by TransferEngine once WebRTC is active to prevent
  // reconnection from corrupting the session (new clientId + stale peerId)
  public allowReconnect = true;

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
        settle(reject, new Error("Connection timeout: server did not respond within 10 seconds"));
        this.ws?.close();
      }, SignalingClient.CONNECTION_TIMEOUT_MS);

      try {
        this.ws = new WebSocket(this.config.url);

        this.ws.onopen = () => {
          logger.info("Signaling", "Connected to server");
          this.reconnectAttempts = 0;
          this.isReconnecting = false;
          this.config.onOpen?.();
        };

        this.ws.onclose = () => {
          logger.info("Signaling", "Disconnected from server");
          this.config.onClose?.();
          if (!settled) {
            settle(
              reject,
              new Error("Connection closed before server acknowledged the connection"),
            );
          } else {
            this.attemptReconnect();
          }
        };

        this.ws.onerror = (event) => {
          logger.error("Signaling", "WebSocket error");
          this.config.onError?.(event);
          const error =
            this.ws?.readyState === WebSocket.CONNECTING
              ? new Error("Could not connect to server. Check your internet connection.")
              : new Error("Connection to server lost unexpectedly");
          settle(reject, error);
        };

        this.ws.onmessage = (event) => {
          try {
            const message: SignalingMessage = JSON.parse(event.data);
            // Always assign clientId so reconnects and late messages still work
            if (message.type === "connected" && message.clientId) {
              this.clientId = message.clientId;
              logger.info("Signaling", "Received client ID", { clientId: this.clientId });
              settle(resolve, this.clientId);
            }
            this.handleMessage(message);
          } catch {
            logger.error("Signaling", "Failed to parse message");
          }
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to create WebSocket connection";
        settle(reject, new Error(message));
      }
    });
  }

  private handleMessage(message: SignalingMessage) {
    // Notify specific type handlers
    const handlers = this.messageHandlers.get(message.type);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          const result = handler(message);
          // Catch promise rejections from async handlers
          if (result && typeof (result as Promise<void>).catch === "function") {
            (result as Promise<void>).catch((err) => {
              logger.error("Signaling", "Handler error", {
                type: message.type,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        } catch (err) {
          logger.error("Signaling", "Sync handler error", {
            type: message.type,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }

    // Notify global handler
    this.config.onMessage?.(message);
  }

  // Attempt to reconnect on disconnect
  private attemptReconnect() {
    if (
      !this.allowReconnect ||
      this.isReconnecting ||
      this.reconnectAttempts >= this.maxReconnectAttempts
    ) {
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    const baseDelay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    const delay = Math.round(baseDelay * (0.5 + Math.random() * 0.5));
    logger.info("Signaling", "Reconnecting", { delayMs: delay, attempt: this.reconnectAttempts });

    setTimeout(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        this.connect()
          .then(() => {
            // Rejoin room if we were in one
            if (this.roomId) {
              try {
                this.joinRoom(this.roomId);
              } catch {
                logger.error("Signaling", "Failed to rejoin room after reconnect");
              }
            }
          })
          .catch(() => {
            this.isReconnecting = false;
          });
      }
    }, delay);
  }

  // Join a room. Throws if not connected.
  joinRoom(roomId: string): void {
    this.roomId = roomId;
    const sent = this.send({
      type: "handshake-init",
      roomId,
    });
    if (!sent) {
      throw new Error("Failed to join room: not connected to server");
    }
    logger.info("Signaling", "Joining room", { roomId });
  }

  // Send a message. Returns false if not connected.
  send(message: Partial<SignalingMessage>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.error("Signaling", "Cannot send - not connected", { type: message.type });
      return false;
    }

    const fullMessage: SignalingMessage = {
      type: message.type || "error",
      ...message,
      roomId: message.roomId || this.roomId,
    };

    this.ws.send(JSON.stringify(fullMessage));
    return true;
  }

  // Send offer to peer
  sendOffer(offer: RTCSessionDescriptionInit, peerId?: string): boolean {
    return this.send({
      type: "offer",
      to: peerId,
      payload: offer,
    });
  }

  // Send answer to peer
  sendAnswer(answer: RTCSessionDescriptionInit, peerId: string): boolean {
    return this.send({
      type: "answer",
      to: peerId,
      payload: answer,
    });
  }

  // Send ICE candidate
  sendIceCandidate(candidate: RTCIceCandidate, peerId?: string): boolean {
    return this.send({
      type: "ice-candidate",
      to: peerId,
      payload: candidate.toJSON(),
    });
  }

  // Send handshake verification message
  sendHandshakeVerify(payload: unknown, peerId?: string): boolean {
    return this.send({
      type: "handshake-verify",
      to: peerId,
      payload,
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
    this.clientId = "";
    this.roomId = "";
    this.messageHandlers.clear();
  }
}
