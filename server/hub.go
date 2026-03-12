package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"regexp"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// roomIDPattern validates room codes: 3 digits, dash, 3 digits
var roomIDPattern = regexp.MustCompile(`^\d{3}-\d{3}$`)

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
	ID        string
	RoomID    string
	Conn      *websocket.Conn
	Hub       *Hub
	Send      chan []byte
	mu        sync.Mutex
	closeSend sync.Once
	// Per-client message rate limiting
	msgCount  int
	msgWindow time.Time
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
		register:   make(chan *Client, 64),
		unregister: make(chan *Client, 64),
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
				client.closeSend.Do(func() { close(client.Send) })
				// Drain buffered messages to prevent goroutine leaks
				for range client.Send {
				}
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
						data, err := json.Marshal(msg)
						if err != nil {
							slog.Error("Failed to marshal room-expired message",
								slog.String("error", err.Error()))
							continue
						}
						client.trySend(data)
						client.setRoomID("")
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
	data, err := json.Marshal(msg)
	if err != nil {
		slog.Error("Failed to marshal connected message",
			slog.String("error", err.Error()))
		return
	}
	client.trySend(data)
}

func (h *Hub) handleUnregister(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if _, ok := h.clients[client.ID]; ok {
		delete(h.clients, client.ID)
		client.closeSend.Do(func() { close(client.Send) })

		// Remove from room if in one
		roomID := client.getRoomID()
		if roomID != "" {
			if room, ok := h.rooms[roomID]; ok {
				room.mu.Lock()
				delete(room.Clients, client.ID)

				// Notify other peers in room
				for _, peer := range room.Clients {
					msg := SignalingMessage{
						Type:     MsgTypePeerLeft,
						From:     client.ID,
						RoomID:   roomID,
						ClientID: client.ID,
					}
					data, err := json.Marshal(msg)
					if err != nil {
						slog.Error("Failed to marshal peer-left message",
							slog.String("error", err.Error()))
						continue
					}
					peer.trySend(data)
				}

				// Clean up empty rooms
				if len(room.Clients) == 0 {
					delete(h.rooms, roomID)
					slog.Info("Room deleted (empty)",
						slog.String("roomId", roomID))
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
		// SECURITY: verify target client is in the same room as the sender
		if client, ok := h.clients[message.To]; ok {
			if message.RoomID == "" || client.getRoomID() != message.RoomID {
				slog.Warn("Cross-room direct message blocked",
					slog.String("from", message.From),
					slog.String("to", message.To),
					slog.String("senderRoom", message.RoomID),
					slog.String("targetRoom", client.getRoomID()))
				return
			}
			data, err := json.Marshal(message)
			if err != nil {
				slog.Error("Failed to marshal direct message",
					slog.String("error", err.Error()))
				return
			}
			if !client.trySend(data) {
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
			data, err := json.Marshal(message)
			if err != nil {
				slog.Error("Failed to marshal broadcast message",
					slog.String("error", err.Error()))
				room.mu.RUnlock()
				return
			}
			for id, client := range room.Clients {
				if id != message.From { // Don't echo back to sender
					if !client.trySend(data) {
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
	currentRoomID := client.getRoomID()
	if currentRoomID != "" && currentRoomID != roomID {
		if oldRoom, ok := h.rooms[currentRoomID]; ok {
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

	// Enforce room capacity: P2P transfer is strictly 2 peers
	room.mu.Lock()
	if len(room.Clients) >= 2 {
		room.mu.Unlock()
		client.sendError("Room is full")
		slog.Warn("Room capacity exceeded",
			slog.String("roomId", roomID),
			slog.String("clientId", client.ID))
		return
	}

	// Notify existing peers
	for _, peer := range room.Clients {
		msg := SignalingMessage{
			Type:     MsgTypePeerJoined,
			From:     client.ID,
			RoomID:   roomID,
			ClientID: client.ID,
		}
		data, err := json.Marshal(msg)
		if err != nil {
			slog.Error("Failed to marshal peer-joined message",
				slog.String("error", err.Error()))
			continue
		}
		peer.trySend(data)
	}

	room.Clients[client.ID] = client
	client.setRoomID(roomID)
	room.mu.Unlock()

	slog.Info("Client joined room",
		slog.String("clientId", client.ID),
		slog.String("roomId", roomID),
		slog.Int("totalClients", len(room.Clients)))
}

// NewClient creates a new client with unique ID
func NewClient(conn *websocket.Conn, hub *Hub) *Client {
	return &Client{
		ID:   uuid.New().String(),
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

		// Per-client message rate limiting: max 50 messages per second
		now := time.Now()
		if now.Sub(c.msgWindow) > time.Second {
			c.msgCount = 0
			c.msgWindow = now
		}
		c.msgCount++
		if c.msgCount > 50 {
			slog.Warn("Client exceeded message rate limit",
				slog.String("clientId", c.ID))
			c.sendError("Rate limit exceeded")
			break // disconnect flooding client
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
			if !roomIDPattern.MatchString(msg.RoomID) {
				c.sendError("Invalid room ID format")
				continue
			}
			c.Hub.JoinRoom(c, msg.RoomID)

		case MsgTypeOffer, MsgTypeAnswer, MsgTypeICECandidate, MsgTypeHandshakeVerify:
			// Always stamp the sender's room to prevent cross-room injection
			senderRoom := c.getRoomID()
			if senderRoom == "" {
				c.sendError("Must join a room before sending messages")
				continue
			}
			msg.RoomID = senderRoom
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

// getRoomID returns the client's room ID in a thread-safe manner.
func (c *Client) getRoomID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.RoomID
}

// setRoomID updates the client's room ID in a thread-safe manner.
func (c *Client) setRoomID(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.RoomID = id
}

// trySend safely sends data to the client's Send channel.
// Returns false if the channel is closed or full, preventing panics
// from the race between cleanupExpiredRooms and handleUnregister.
func (c *Client) trySend(data []byte) (sent bool) {
	defer func() {
		if r := recover(); r != nil {
			sent = false
		}
	}()
	select {
	case c.Send <- data:
		return true
	default:
		return false
	}
}

func (c *Client) sendError(errMsg string) {
	payloadBytes, err := json.Marshal(errMsg)
	if err != nil {
		slog.Error("Failed to marshal error payload",
			slog.String("error", err.Error()))
		return
	}
	msg := SignalingMessage{
		Type:    MsgTypeError,
		Payload: json.RawMessage(payloadBytes),
	}
	data, err := json.Marshal(msg)
	if err != nil {
		slog.Error("Failed to marshal error message",
			slog.String("error", err.Error()))
		return
	}
	c.trySend(data)
}
