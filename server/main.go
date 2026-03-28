package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
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

// cspConnectSrc is the CSP connect-src directive, computed once at startup.
// Set CSP_CONNECT_SRC env var to allow WebSocket domains (space-separated).
// Example: "wss://*.onrender.com wss://*.vercel.app"
var cspConnectSrc string

func initCSPConnectSrc() {
	extra := os.Getenv("CSP_CONNECT_SRC")
	if extra != "" {
		cspConnectSrc = "'self' " + extra + " wss://localhost:* ws://localhost:*"
	} else {
		cspConnectSrc = "'self' wss://localhost:* ws://localhost:*"
	}
}

func init() { initCSPConnectSrc() }

// RateLimiter limits connections per IP using Go 1.21+ slices package
type RateLimiter struct {
	mu             sync.Mutex
	attempts       map[string][]time.Time
	limit          int
	window         time.Duration
	maxTrackedIPs  int
	stopCh         chan struct{}
}

func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
	rl := &RateLimiter{
		attempts:      make(map[string][]time.Time),
		limit:         limit,
		window:        window,
		maxTrackedIPs: 50_000,
		stopCh:        make(chan struct{}),
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

	attempts, exists := rl.attempts[ip]

	// Reject unknown IPs when map is at capacity to prevent OOM under IP-spray attacks
	if !exists && len(rl.attempts) >= rl.maxTrackedIPs {
		return false
	}

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

// Extract client IP from request.
// Uses rightmost X-Forwarded-For entry (last proxy hop) to prevent client-side spoofing.
func getClientIP(r *http.Request) string {
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		parts := strings.Split(forwarded, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			ip := strings.TrimSpace(parts[i])
			if ip != "" {
				return ip
			}
		}
	}
	if realIP := r.Header.Get("X-Real-IP"); realIP != "" {
		return strings.TrimSpace(realIP)
	}
	return strings.Split(r.RemoteAddr, ":")[0]
}

// Security headers middleware
func setSecurityHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy",
		"default-src 'self'; "+
			"script-src 'self' 'unsafe-inline'; "+
			"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "+
			"font-src 'self' https://fonts.gstatic.com; "+
			"connect-src "+cspConnectSrc+"; "+
			"img-src 'self' data: blob:; "+
			"frame-ancestors 'none'; "+
			"base-uri 'self';")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("X-XSS-Protection", "1; mode=block")
	w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
	w.Header().Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
	w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
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

// NewTurnHandler creates the /turn-credentials handler. Generates time-limited
// HMAC-SHA1 credentials for Coturn (or any TURN server using shared-secret auth).
// Returns empty iceServers array if TURN_URL/TURN_SECRET are not configured.
func NewTurnHandler(rl *RateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		setCORSHeaders(w, r)
		setSecurityHeaders(w)
		w.Header().Set("Content-Type", "application/json")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		clientIP := getClientIP(r)
		if !rl.Allow(clientIP) {
			http.Error(w, "Too many requests", http.StatusTooManyRequests)
			return
		}

		turnURL := os.Getenv("TURN_URL")
		turnSecret := os.Getenv("TURN_SECRET")

		type iceServer struct {
			URLs       string `json:"urls"`
			Username   string `json:"username,omitempty"`
			Credential string `json:"credential,omitempty"`
		}
		type response struct {
			IceServers []iceServer `json:"iceServers"`
		}

		if turnURL == "" || turnSecret == "" {
			json.NewEncoder(w).Encode(response{IceServers: []iceServer{}})
			return
		}

		expiry := time.Now().Add(12 * time.Hour).Unix()
		username := fmt.Sprintf("%d:warp-lan", expiry)

		mac := hmac.New(sha1.New, []byte(turnSecret))
		mac.Write([]byte(username))
		credential := base64.StdEncoding.EncodeToString(mac.Sum(nil))

		json.NewEncoder(w).Encode(response{
			IceServers: []iceServer{
				{URLs: turnURL, Username: username, Credential: credential},
			},
		})
	}
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

// Global rate limiter: 20 connections per minute per IP
// 1 connection + 5 reconnects = 6 per session; two users behind same NAT = 12; with retry = 18
var rateLimiter = NewRateLimiter(20, time.Minute)

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

	http.HandleFunc("/turn-credentials", NewTurnHandler(rateLimiter))

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
		Addr:           ":" + port,
		ReadTimeout:    15 * time.Second,
		WriteTimeout:   15 * time.Second,
		IdleTimeout:    60 * time.Second,
		MaxHeaderBytes: 1 << 20, // 1 MB
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
