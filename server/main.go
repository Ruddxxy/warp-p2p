package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// RateLimiter limits connections per IP using Go 1.21+ slices package
type RateLimiter struct {
	mu       sync.Mutex
	attempts map[string][]time.Time
	limit    int
	window   time.Duration
	stopCh   chan struct{}
}

func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
	rl := &RateLimiter{
		attempts: make(map[string][]time.Time),
		limit:    limit,
		window:   window,
		stopCh:   make(chan struct{}),
	}
	// Cleanup old entries periodically
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				rl.cleanup()
			case <-rl.stopCh:
				return
			}
		}
	}()
	return rl
}

func (rl *RateLimiter) Stop() {
	close(rl.stopCh)
}

// Allow checks if IP is within rate limit using binary search (Go 1.21+)
func (rl *RateLimiter) Allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-rl.window)

	attempts := rl.attempts[ip]

	// Binary search for cutoff point using slices package (Go 1.21+)
	idx, _ := slices.BinarySearchFunc(attempts, cutoff, func(t, cutoff time.Time) int {
		return t.Compare(cutoff)
	})

	// Keep only recent attempts
	recent := attempts[idx:]

	if len(recent) >= rl.limit {
		rl.attempts[ip] = recent
		return false
	}

	rl.attempts[ip] = append(recent, now)
	return true
}

func (rl *RateLimiter) cleanup() {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	cutoff := time.Now().Add(-rl.window)
	for ip, times := range rl.attempts {
		// Use slices.DeleteFunc for efficient cleanup (Go 1.21+)
		recent := slices.DeleteFunc(times, func(t time.Time) bool {
			return t.Before(cutoff)
		})
		if len(recent) == 0 {
			delete(rl.attempts, ip)
		} else {
			rl.attempts[ip] = recent
		}
	}
}

// ServerMetrics tracks server statistics
type ServerMetrics struct {
	StartTime        time.Time
	TotalConnections atomic.Int64
}

var metrics = &ServerMetrics{
	StartTime: time.Now(),
}

func (m *ServerMetrics) IncrementConnections() {
	m.TotalConnections.Add(1)
}

func (m *ServerMetrics) GetMetrics(hub *Hub) map[string]any {
	hub.mu.RLock()
	activeRooms := len(hub.rooms)
	activeClients := len(hub.clients)
	hub.mu.RUnlock()

	return map[string]any{
		"status":            "healthy",
		"service":           "warp-lan-signaling",
		"uptime_seconds":    int(time.Since(m.StartTime).Seconds()),
		"total_connections": m.TotalConnections.Load(),
		"active_rooms":      activeRooms,
		"active_clients":    activeClients,
		"version":           "1.0.0",
		"timestamp":         time.Now().UTC().Format(time.RFC3339),
	}
}

// Extract client IP from request
func getClientIP(r *http.Request) string {
	// Check X-Forwarded-For for proxied requests (Railway, etc.)
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		parts := strings.Split(forwarded, ",")
		return strings.TrimSpace(parts[0])
	}
	// Check X-Real-IP
	if realIP := r.Header.Get("X-Real-IP"); realIP != "" {
		return realIP
	}
	// Fall back to RemoteAddr
	return strings.Split(r.RemoteAddr, ":")[0]
}

// Security headers middleware
func setSecurityHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy",
		"default-src 'self'; "+
			"script-src 'self' 'unsafe-inline'; "+
			"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "+
			"font-src 'self' https://fonts.gstatic.com; "+
			"connect-src 'self' wss://*.railway.app wss://localhost:* ws://localhost:*; "+
			"img-src 'self' data: blob:; "+
			"frame-ancestors 'none'; "+
			"base-uri 'self';")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("X-XSS-Protection", "1; mode=block")
	w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
	w.Header().Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
}

func setCORSHeaders(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	allowedOrigins := os.Getenv("ALLOWED_ORIGINS")

	if allowedOrigins == "" {
		w.Header().Set("Access-Control-Allow-Origin", "*")
	} else {
		origins := strings.Split(allowedOrigins, ",")
		for _, allowed := range origins {
			if strings.TrimSpace(allowed) == origin {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				break
			}
		}
	}

	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		allowedOrigins := os.Getenv("ALLOWED_ORIGINS")

		// Development mode: allow all if not set
		if allowedOrigins == "" {
			return true
		}

		// Production: check against whitelist
		origins := strings.Split(allowedOrigins, ",")
		for _, allowed := range origins {
			if strings.TrimSpace(allowed) == origin {
				return true
			}
		}
		return false
	},
}

// Global rate limiter: 5 connections per minute per IP (security audit recommendation)
var rateLimiter = NewRateLimiter(5, time.Minute)

func main() {
	// Setup structured logging with slog (Go 1.21+)
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	// Create context for graceful shutdown
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	hub := NewHub()
	go hub.Run(ctx)

	// WebSocket endpoint with rate limiting
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		clientIP := getClientIP(r)
		if !rateLimiter.Allow(clientIP) {
			slog.Warn("Rate limited client",
				slog.String("ip", clientIP))
			http.Error(w, "Too many requests", http.StatusTooManyRequests)
			return
		}
		serveWs(hub, w, r)
	})

	// Health check endpoint with metrics
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		setSecurityHeaders(w)
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(metrics.GetMetrics(hub))
	})

	// CORS middleware for preflight
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		setCORSHeaders(w, r)
		setSecurityHeaders(w)
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	server := &http.Server{
		Addr:         ":" + port,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Start server in goroutine
	go func() {
		slog.Info("Starting Warp-LAN Signaling Server",
			slog.String("port", port),
			slog.String("version", "1.0.0"))
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("Server error",
				slog.String("error", err.Error()))
			os.Exit(1)
		}
	}()

	// Wait for interrupt signal for graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	slog.Info("Shutting down gracefully...")

	// Stop rate limiter cleanup goroutine
	rateLimiter.Stop()

	// Cancel hub context
	cancel()

	// Give outstanding requests 30 seconds to complete
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		slog.Error("Forced shutdown",
			slog.String("error", err.Error()))
	}

	slog.Info("Server stopped")
}

func serveWs(hub *Hub, w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w, r)
	setSecurityHeaders(w)

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("WebSocket upgrade failed",
			slog.String("error", err.Error()))
		return
	}

	metrics.IncrementConnections()

	client := NewClient(conn, hub)
	hub.register <- client

	// Start client goroutines
	go client.WritePump()
	go client.ReadPump()
}
