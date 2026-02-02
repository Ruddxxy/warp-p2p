package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

const (
	writeWait        = 10 * time.Second
	pongWait         = 60 * time.Second
	pingPeriod       = (pongWait * 9) / 10
	maxMessageSize   = 64 * 1024 // 64KB for signaling messages
	roomExpiryDuration = 10 * time.Minute
)

// MessageType defines the type of signaling message
type MessageType string

const (
	MsgTypeOffer           MessageType = "offer"
	MsgTypeAnswer          MessageType = "answer"
	MsgTypeICECandidate    MessageType = "ice-candidate"
	MsgTypeHandshakeInit   MessageType = "handshake-init"
	MsgTypeHandshakeVerify MessageType = "handshake-verify"
	MsgTypeConnected       MessageType = "connected"
	MsgTypeError           MessageType = "error"
	MsgTypePeerJoined      MessageType = "peer-joined"
	MsgTypePeerLeft        MessageType = "peer-left"
	MsgTypeRoomExpired     MessageType = "room-expired"
)

// SignalingMessage is the structure for all signaling messages
type SignalingMessage struct {
	Type     MessageType     `json:"type"`
	From     string          `json:"from,omitempty"`
	To       string          `json:"to,omitempty"`
	RoomID   string          `json:"roomId,omitempty"`
	Payload  json.RawMessage `json:"payload,omitempty"`
	ClientID string          `json:"clientId,omitempty"`
}

// Client represents a connected WebSocket client
type Client struct {
	ID     string
	RoomID string
	Conn   *websocket.Conn
	Hub    *Hub
	Send   chan []byte
	mu     sync.Mutex
}

// Room represents a transfer session between peers
type Room struct {
	ID        string
	Clients   map[string]*Client
	CreatedAt time.Time
	mu        sync.RWMutex
}

// Hub manages all rooms and clients
type Hub struct {
	rooms      map[string]*Room
	clients    map[string]*Client
	register   chan *Client
	unregister chan *Client
	broadcast  chan *SignalingMessage
	mu         sync.RWMutex
}

// NewHub creates a new Hub instance
func NewHub() *Hub {
	return &Hub{
		rooms:      make(map[string]*Room),
		clients:    make(map[string]*Client),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		broadcast:  make(chan *SignalingMessage, 256),
	}
}

// Run starts the hub's main event loop with context support for graceful shutdown
func (h *Hub) Run(ctx context.Context) {
	// Start room expiry cleanup goroutine
	go h.cleanupExpiredRooms(ctx)

	for {
		select {
		case <-ctx.Done():
			slog.Info("Hub shutting down")
			h.mu.Lock()
			for _, client := range h.clients {
				close(client.Send)
			}
			h.mu.Unlock()
			return
		case client := <-h.register:
			h.handleRegister(client)
		case client := <-h.unregister:
			h.handleUnregister(client)
		case message := <-h.broadcast:
			h.handleBroadcast(message)
		}
	}
}

// cleanupExpiredRooms removes rooms that have exceeded the expiry duration
func (h *Hub) cleanupExpiredRooms(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.mu.Lock()
			now := time.Now()

			for roomID, room := range h.rooms {
				if now.Sub(room.CreatedAt) > roomExpiryDuration {
					room.mu.Lock()
					// Notify clients that room is expiring
					for _, client := range room.Clients {
						msg := SignalingMessage{
							Type:   MsgTypeRoomExpired,
							RoomID: roomID,
						}
						data, _ := json.Marshal(msg)
						select {
						case client.Send <- data:
						default:
						}
						client.RoomID = ""
					}
					room.mu.Unlock()

					delete(h.rooms, roomID)
					slog.Info("Room expired and deleted",
						slog.String("roomId", roomID),
						slog.Duration("age", now.Sub(room.CreatedAt)))
				}
			}
			h.mu.Unlock()
		}
	}
}

func (h *Hub) handleRegister(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.clients[client.ID] = client
	slog.Info("Client registered",
		slog.String("clientId", client.ID))

	// Send connected message with client ID
	msg := SignalingMessage{
		Type:     MsgTypeConnected,
		ClientID: client.ID,
	}
	data, _ := json.Marshal(msg)
	client.Send <- data
}

func (h *Hub) handleUnregister(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if _, ok := h.clients[client.ID]; ok {
		delete(h.clients, client.ID)
		close(client.Send)

		// Remove from room if in one
		if client.RoomID != "" {
			if room, ok := h.rooms[client.RoomID]; ok {
				room.mu.Lock()
				delete(room.Clients, client.ID)

				// Notify other peers in room
				for _, peer := range room.Clients {
					msg := SignalingMessage{
						Type:     MsgTypePeerLeft,
						From:     client.ID,
						RoomID:   client.RoomID,
						ClientID: client.ID,
					}
					data, _ := json.Marshal(msg)
					select {
					case peer.Send <- data:
					default:
					}
				}

				// Clean up empty rooms
				if len(room.Clients) == 0 {
					delete(h.rooms, client.RoomID)
					slog.Info("Room deleted (empty)",
						slog.String("roomId", client.RoomID))
				}
				room.mu.Unlock()
			}
		}
		slog.Info("Client unregistered",
			slog.String("clientId", client.ID))
	}
}

func (h *Hub) handleBroadcast(message *SignalingMessage) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	// Direct message to specific client
	if message.To != "" {
		if client, ok := h.clients[message.To]; ok {
			data, _ := json.Marshal(message)
			select {
			case client.Send <- data:
			default:
				slog.Warn("Failed to send to client, buffer full",
					slog.String("clientId", message.To))
			}
		}
		return
	}

	// Broadcast to room
	if message.RoomID != "" {
		if room, ok := h.rooms[message.RoomID]; ok {
			room.mu.RLock()
			data, _ := json.Marshal(message)
			for id, client := range room.Clients {
				if id != message.From { // Don't echo back to sender
					select {
					case client.Send <- data:
					default:
						slog.Warn("Failed to broadcast to client",
							slog.String("clientId", id))
					}
				}
			}
			room.mu.RUnlock()
		}
	}
}

// JoinRoom adds a client to a room (creates room if needed)
func (h *Hub) JoinRoom(client *Client, roomID string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Leave current room if in one
	if client.RoomID != "" && client.RoomID != roomID {
		if oldRoom, ok := h.rooms[client.RoomID]; ok {
			oldRoom.mu.Lock()
			delete(oldRoom.Clients, client.ID)
			oldRoom.mu.Unlock()
		}
	}

	// Create room if it doesn't exist
	room, ok := h.rooms[roomID]
	if !ok {
		room = &Room{
			ID:        roomID,
			Clients:   make(map[string]*Client),
			CreatedAt: time.Now(),
		}
		h.rooms[roomID] = room
		slog.Info("Room created",
			slog.String("roomId", roomID))
	}

	// Add client to room
	room.mu.Lock()

	// Notify existing peers
	for _, peer := range room.Clients {
		msg := SignalingMessage{
			Type:     MsgTypePeerJoined,
			From:     client.ID,
			RoomID:   roomID,
			ClientID: client.ID,
		}
		data, _ := json.Marshal(msg)
		select {
		case peer.Send <- data:
		default:
		}
	}

	room.Clients[client.ID] = client
	client.RoomID = roomID
	room.mu.Unlock()

	slog.Info("Client joined room",
		slog.String("clientId", client.ID),
		slog.String("roomId", roomID),
		slog.Int("totalClients", len(room.Clients)))
}

// NewClient creates a new client with unique ID
func NewClient(conn *websocket.Conn, hub *Hub) *Client {
	return &Client{
		ID:   uuid.New().String()[:8], // Short ID for easier debugging
		Conn: conn,
		Hub:  hub,
		Send: make(chan []byte, 256),
	}
}

// ReadPump handles incoming messages from WebSocket
func (c *Client) ReadPump() {
	defer func() {
		c.Hub.unregister <- c
		c.Conn.Close()
	}()

	c.Conn.SetReadLimit(maxMessageSize)
	c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, data, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				slog.Warn("Client read error",
					slog.String("clientId", c.ID),
					slog.String("error", err.Error()))
			}
			break
		}

		var msg SignalingMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			slog.Warn("Invalid JSON from client",
				slog.String("clientId", c.ID),
				slog.String("error", err.Error()))
			c.sendError("Invalid message format")
			continue
		}

		msg.From = c.ID // Always set the from field to prevent spoofing

		// Handle message based on type
		switch msg.Type {
		case MsgTypeHandshakeInit:
			// Client wants to create/join a room
			if msg.RoomID == "" {
				c.sendError("Room ID required for handshake")
				continue
			}
			c.Hub.JoinRoom(c, msg.RoomID)

		case MsgTypeOffer, MsgTypeAnswer, MsgTypeICECandidate, MsgTypeHandshakeVerify:
			// Forward to specific peer or broadcast to room
			if msg.To == "" && msg.RoomID == "" {
				msg.RoomID = c.RoomID
			}
			c.Hub.broadcast <- &msg

		default:
			c.sendError("Unknown message type")
		}
	}
}

// WritePump handles outgoing messages to WebSocket
func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.Send:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			c.mu.Lock()
			err := c.Conn.WriteMessage(websocket.TextMessage, message)
			c.mu.Unlock()

			if err != nil {
				slog.Warn("Client write error",
					slog.String("clientId", c.ID),
					slog.String("error", err.Error()))
				return
			}

		case <-ticker.C:
			c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) sendError(errMsg string) {
	msg := SignalingMessage{
		Type:    MsgTypeError,
		Payload: json.RawMessage(`"` + errMsg + `"`),
	}
	data, _ := json.Marshal(msg)
	select {
	case c.Send <- data:
	default:
	}
}
