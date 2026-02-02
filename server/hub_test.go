package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestNewHub(t *testing.T) {
	hub := NewHub()

	if hub.rooms == nil {
		t.Error("rooms map not initialized")
	}
	if hub.clients == nil {
		t.Error("clients map not initialized")
	}
	if hub.register == nil {
		t.Error("register channel not initialized")
	}
	if hub.unregister == nil {
		t.Error("unregister channel not initialized")
	}
	if hub.broadcast == nil {
		t.Error("broadcast channel not initialized")
	}
}

func TestHub_RegisterClient(t *testing.T) {
	hub := NewHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go hub.Run(ctx)

	client := &Client{
		ID:   "test-client",
		Hub:  hub,
		Send: make(chan []byte, 256),
	}

	hub.register <- client

	// Wait for processing
	time.Sleep(10 * time.Millisecond)

	hub.mu.RLock()
	_, exists := hub.clients[client.ID]
	hub.mu.RUnlock()

	if !exists {
		t.Error("Client not registered")
	}

	// Should receive connected message
	select {
	case msg := <-client.Send:
		var sm SignalingMessage
		if err := json.Unmarshal(msg, &sm); err != nil {
			t.Fatalf("Failed to unmarshal: %v", err)
		}
		if sm.Type != MsgTypeConnected {
			t.Errorf("Expected 'connected', got %v", sm.Type)
		}
		if sm.ClientID != client.ID {
			t.Errorf("Expected clientId %v, got %v", client.ID, sm.ClientID)
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("No connected message received")
	}
}

func TestHub_UnregisterClient(t *testing.T) {
	hub := NewHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go hub.Run(ctx)

	client := &Client{
		ID:   "test-client",
		Hub:  hub,
		Send: make(chan []byte, 256),
	}

	hub.register <- client
	time.Sleep(10 * time.Millisecond)

	hub.unregister <- client
	time.Sleep(10 * time.Millisecond)

	hub.mu.RLock()
	_, exists := hub.clients[client.ID]
	hub.mu.RUnlock()

	if exists {
		t.Error("Client still registered after unregister")
	}
}

func TestHub_JoinRoom(t *testing.T) {
	hub := NewHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go hub.Run(ctx)

	client := &Client{
		ID:   "test-client",
		Hub:  hub,
		Send: make(chan []byte, 256),
	}

	hub.register <- client
	time.Sleep(10 * time.Millisecond)
	<-client.Send // drain connected message

	hub.JoinRoom(client, "room-123")

	hub.mu.RLock()
	room, roomExists := hub.rooms["room-123"]
	hub.mu.RUnlock()

	if !roomExists {
		t.Fatal("Room not created")
	}

	room.mu.RLock()
	_, clientInRoom := room.Clients[client.ID]
	room.mu.RUnlock()

	if !clientInRoom {
		t.Error("Client not in room")
	}

	if client.RoomID != "room-123" {
		t.Errorf("Client RoomID = %v, want room-123", client.RoomID)
	}
}

func TestHub_PeerJoinedNotification(t *testing.T) {
	hub := NewHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go hub.Run(ctx)

	client1 := &Client{ID: "client-1", Hub: hub, Send: make(chan []byte, 256)}
	client2 := &Client{ID: "client-2", Hub: hub, Send: make(chan []byte, 256)}

	hub.register <- client1
	hub.register <- client2
	time.Sleep(10 * time.Millisecond)
	<-client1.Send // drain connected
	<-client2.Send // drain connected

	hub.JoinRoom(client1, "room-123")
	hub.JoinRoom(client2, "room-123")

	// Client1 should receive peer-joined for client2
	select {
	case msg := <-client1.Send:
		var sm SignalingMessage
		json.Unmarshal(msg, &sm)
		if sm.Type != MsgTypePeerJoined {
			t.Errorf("Expected peer-joined, got %v", sm.Type)
		}
		if sm.ClientID != "client-2" {
			t.Errorf("Expected clientId client-2, got %v", sm.ClientID)
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("No peer-joined notification")
	}
}

func TestHub_BroadcastToRoom(t *testing.T) {
	hub := NewHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go hub.Run(ctx)

	client1 := &Client{ID: "client-1", Hub: hub, Send: make(chan []byte, 256)}
	client2 := &Client{ID: "client-2", Hub: hub, Send: make(chan []byte, 256)}

	hub.register <- client1
	hub.register <- client2
	time.Sleep(10 * time.Millisecond)
	<-client1.Send
	<-client2.Send

	hub.JoinRoom(client1, "room-123")
	hub.JoinRoom(client2, "room-123")
	<-client1.Send // drain peer-joined

	// Broadcast from client1
	hub.broadcast <- &SignalingMessage{
		Type:   MsgTypeOffer,
		From:   client1.ID,
		RoomID: "room-123",
	}

	// Client2 should receive, client1 should not
	select {
	case msg := <-client2.Send:
		var sm SignalingMessage
		json.Unmarshal(msg, &sm)
		if sm.Type != MsgTypeOffer {
			t.Errorf("Expected offer, got %v", sm.Type)
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("Client2 didn't receive broadcast")
	}

	select {
	case <-client1.Send:
		t.Error("Sender should not receive their own broadcast")
	case <-time.After(50 * time.Millisecond):
		// Good - no echo
	}
}

func TestHub_DirectMessage(t *testing.T) {
	hub := NewHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go hub.Run(ctx)

	client1 := &Client{ID: "client-1", Hub: hub, Send: make(chan []byte, 256)}
	client2 := &Client{ID: "client-2", Hub: hub, Send: make(chan []byte, 256)}

	hub.register <- client1
	hub.register <- client2
	time.Sleep(10 * time.Millisecond)
	<-client1.Send
	<-client2.Send

	// Direct message to client2
	hub.broadcast <- &SignalingMessage{
		Type: MsgTypeAnswer,
		From: client1.ID,
		To:   client2.ID,
	}

	select {
	case msg := <-client2.Send:
		var sm SignalingMessage
		json.Unmarshal(msg, &sm)
		if sm.Type != MsgTypeAnswer {
			t.Errorf("Expected answer, got %v", sm.Type)
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("Direct message not received")
	}
}

func TestHub_CleanupEmptyRoom(t *testing.T) {
	hub := NewHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go hub.Run(ctx)

	client := &Client{ID: "test-client", Hub: hub, Send: make(chan []byte, 256)}

	hub.register <- client
	time.Sleep(10 * time.Millisecond)
	<-client.Send

	hub.JoinRoom(client, "room-123")

	hub.mu.RLock()
	_, exists := hub.rooms["room-123"]
	hub.mu.RUnlock()
	if !exists {
		t.Fatal("Room should exist")
	}

	hub.unregister <- client
	time.Sleep(10 * time.Millisecond)

	hub.mu.RLock()
	_, exists = hub.rooms["room-123"]
	hub.mu.RUnlock()
	if exists {
		t.Error("Empty room should be deleted")
	}
}

func TestHub_PeerLeftNotification(t *testing.T) {
	hub := NewHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go hub.Run(ctx)

	client1 := &Client{ID: "client-1", Hub: hub, Send: make(chan []byte, 256)}
	client2 := &Client{ID: "client-2", Hub: hub, Send: make(chan []byte, 256)}

	hub.register <- client1
	hub.register <- client2
	time.Sleep(10 * time.Millisecond)
	<-client1.Send
	<-client2.Send

	hub.JoinRoom(client1, "room-123")
	hub.JoinRoom(client2, "room-123")
	<-client1.Send // drain peer-joined

	hub.unregister <- client2
	time.Sleep(10 * time.Millisecond)

	select {
	case msg := <-client1.Send:
		var sm SignalingMessage
		json.Unmarshal(msg, &sm)
		if sm.Type != MsgTypePeerLeft {
			t.Errorf("Expected peer-left, got %v", sm.Type)
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("No peer-left notification")
	}
}

func TestHub_GracefulShutdown(t *testing.T) {
	hub := NewHub()
	ctx, cancel := context.WithCancel(context.Background())

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		hub.Run(ctx)
	}()

	client := &Client{ID: "test-client", Hub: hub, Send: make(chan []byte, 256)}
	hub.register <- client
	time.Sleep(10 * time.Millisecond)

	cancel()
	wg.Wait()

	// Send channel should be closed
	_, ok := <-client.Send
	if ok {
		// Channel might have buffered messages, drain them
		for range client.Send {
		}
	}
}

func TestWebSocketIntegration(t *testing.T) {
	hub := NewHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go hub.Run(ctx)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveWs(hub, w, r)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")

	ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("Failed to connect: %v", err)
	}
	defer ws.Close()

	// Should receive connected message
	var msg SignalingMessage
	if err := ws.ReadJSON(&msg); err != nil {
		t.Fatalf("Failed to read: %v", err)
	}

	if msg.Type != MsgTypeConnected {
		t.Errorf("Expected connected, got %v", msg.Type)
	}
	if msg.ClientID == "" {
		t.Error("ClientID should not be empty")
	}
}

func TestWebSocket_JoinRoom(t *testing.T) {
	hub := NewHub()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go hub.Run(ctx)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveWs(hub, w, r)
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")

	ws, _, _ := websocket.DefaultDialer.Dial(wsURL, nil)
	defer ws.Close()

	// Drain connected message
	var msg SignalingMessage
	ws.ReadJSON(&msg)

	// Join room
	joinMsg := SignalingMessage{
		Type:   MsgTypeHandshakeInit,
		RoomID: "test-room",
	}
	ws.WriteJSON(joinMsg)

	time.Sleep(50 * time.Millisecond)

	hub.mu.RLock()
	_, exists := hub.rooms["test-room"]
	hub.mu.RUnlock()

	if !exists {
		t.Error("Room should be created after handshake-init")
	}
}

func TestMessageType_Constants(t *testing.T) {
	// Verify message type constants match expected values
	tests := []struct {
		msgType  MessageType
		expected string
	}{
		{MsgTypeOffer, "offer"},
		{MsgTypeAnswer, "answer"},
		{MsgTypeICECandidate, "ice-candidate"},
		{MsgTypeHandshakeInit, "handshake-init"},
		{MsgTypeHandshakeVerify, "handshake-verify"},
		{MsgTypeConnected, "connected"},
		{MsgTypeError, "error"},
		{MsgTypePeerJoined, "peer-joined"},
		{MsgTypePeerLeft, "peer-left"},
		{MsgTypeRoomExpired, "room-expired"},
	}

	for _, tt := range tests {
		if string(tt.msgType) != tt.expected {
			t.Errorf("MessageType %v = %v, want %v", tt.msgType, string(tt.msgType), tt.expected)
		}
	}
}
