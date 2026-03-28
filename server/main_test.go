package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRateLimiter_Allow(t *testing.T) {
	rl := NewRateLimiter(3, time.Minute)
	defer rl.Stop()

	ip := "192.168.1.1"

	// First 3 requests should pass
	for i := 0; i < 3; i++ {
		if !rl.Allow(ip) {
			t.Errorf("Request %d should be allowed", i+1)
		}
	}

	// 4th request should be blocked
	if rl.Allow(ip) {
		t.Error("4th request should be blocked")
	}
}

func TestRateLimiter_DifferentIPs(t *testing.T) {
	rl := NewRateLimiter(2, time.Minute)
	defer rl.Stop()

	// Different IPs should have independent limits
	if !rl.Allow("10.0.0.1") {
		t.Error("First IP first request should be allowed")
	}
	if !rl.Allow("10.0.0.2") {
		t.Error("Second IP first request should be allowed")
	}
	if !rl.Allow("10.0.0.1") {
		t.Error("First IP second request should be allowed")
	}
	if !rl.Allow("10.0.0.2") {
		t.Error("Second IP second request should be allowed")
	}

	// Both should now be at limit
	if rl.Allow("10.0.0.1") {
		t.Error("First IP third request should be blocked")
	}
	if rl.Allow("10.0.0.2") {
		t.Error("Second IP third request should be blocked")
	}
}

func TestRateLimiter_WindowExpiry(t *testing.T) {
	rl := NewRateLimiter(1, 50*time.Millisecond)
	defer rl.Stop()

	ip := "192.168.1.1"

	if !rl.Allow(ip) {
		t.Error("First request should be allowed")
	}
	if rl.Allow(ip) {
		t.Error("Second request should be blocked")
	}

	// Wait for window to expire
	time.Sleep(60 * time.Millisecond)

	if !rl.Allow(ip) {
		t.Error("Request after window expiry should be allowed")
	}
}

func TestRateLimiter_Concurrent(t *testing.T) {
	rl := NewRateLimiter(100, time.Minute)
	defer rl.Stop()

	var wg sync.WaitGroup
	allowed := make(chan bool, 200)

	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			allowed <- rl.Allow("concurrent-test")
		}()
	}

	wg.Wait()
	close(allowed)

	count := 0
	for a := range allowed {
		if a {
			count++
		}
	}

	if count != 100 {
		t.Errorf("Expected exactly 100 allowed, got %d", count)
	}
}

func TestGetClientIP(t *testing.T) {
	tests := []struct {
		name     string
		headers  map[string]string
		remote   string
		expected string
	}{
		{
			name:     "X-Forwarded-For single",
			headers:  map[string]string{"X-Forwarded-For": "203.0.113.1"},
			remote:   "127.0.0.1:8080",
			expected: "203.0.113.1",
		},
		{
			name:     "X-Forwarded-For multiple",
			headers:  map[string]string{"X-Forwarded-For": "203.0.113.1, 70.41.3.18"},
			remote:   "127.0.0.1:8080",
			expected: "70.41.3.18",
		},
		{
			name:     "X-Real-IP",
			headers:  map[string]string{"X-Real-IP": "203.0.113.2"},
			remote:   "127.0.0.1:8080",
			expected: "203.0.113.2",
		},
		{
			name:     "RemoteAddr fallback",
			headers:  map[string]string{},
			remote:   "192.168.1.100:54321",
			expected: "192.168.1.100",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/", nil)
			req.RemoteAddr = tt.remote
			for k, v := range tt.headers {
				req.Header.Set(k, v)
			}

			got := getClientIP(req)
			if got != tt.expected {
				t.Errorf("getClientIP() = %v, want %v", got, tt.expected)
			}
		})
	}
}

func TestHealthEndpoint(t *testing.T) {
	hub := NewHub()

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		setSecurityHeaders(w)
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(metrics.GetMetrics(hub))
	})

	req := httptest.NewRequest("GET", "/health", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", rec.Code)
	}

	var result map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatalf("Failed to parse JSON: %v", err)
	}

	if result["status"] != "healthy" {
		t.Errorf("Expected status 'healthy', got %v", result["status"])
	}
	if result["service"] != "warp-lan-signaling" {
		t.Errorf("Expected service 'warp-lan-signaling', got %v", result["service"])
	}
}

func TestSecurityHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	setSecurityHeaders(rec)

	expectedHeaders := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"X-XSS-Protection":       "1; mode=block",
		"Referrer-Policy":        "strict-origin-when-cross-origin",
	}

	for header, expected := range expectedHeaders {
		if got := rec.Header().Get(header); got != expected {
			t.Errorf("Header %s = %v, want %v", header, got, expected)
		}
	}

	if rec.Header().Get("Content-Security-Policy") == "" {
		t.Error("Content-Security-Policy header not set")
	}
}

func TestCSPConnectSrc_Dynamic(t *testing.T) {
	t.Run("default without env var", func(t *testing.T) {
		t.Setenv("CSP_CONNECT_SRC", "")
		initCSPConnectSrc()

		rec := httptest.NewRecorder()
		setSecurityHeaders(rec)

		csp := rec.Header().Get("Content-Security-Policy")
		if !strings.Contains(csp, "connect-src 'self'") {
			t.Error("CSP should contain connect-src 'self'")
		}
		if strings.Contains(csp, "b4a.run") {
			t.Error("CSP should not contain hardcoded b4a.run")
		}
		if strings.Contains(csp, "fly.dev") {
			t.Error("CSP should not contain hardcoded fly.dev")
		}
	})

	t.Run("custom domains from env var", func(t *testing.T) {
		t.Setenv("CSP_CONNECT_SRC", "wss://*.fly.dev wss://*.b4a.run")
		initCSPConnectSrc()

		rec := httptest.NewRecorder()
		setSecurityHeaders(rec)

		csp := rec.Header().Get("Content-Security-Policy")
		if !strings.Contains(csp, "wss://*.fly.dev") {
			t.Error("CSP should contain fly.dev wildcard")
		}
		if !strings.Contains(csp, "wss://*.b4a.run") {
			t.Error("CSP should contain b4a.run wildcard")
		}
		if !strings.Contains(csp, "wss://localhost:*") {
			t.Error("CSP should always contain localhost")
		}
	})
}

func TestCORSHeaders(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Origin", "http://localhost:3000")
	rec := httptest.NewRecorder()

	setCORSHeaders(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %v, want *", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); got != "GET, POST, OPTIONS" {
		t.Errorf("Access-Control-Allow-Methods = %v, want 'GET, POST, OPTIONS'", got)
	}
}

func TestServerMetrics(t *testing.T) {
	hub := NewHub()

	m := &ServerMetrics{StartTime: time.Now()}
	m.IncrementConnections()
	m.IncrementConnections()

	result := m.GetMetrics(hub)

	if result["total_connections"].(int64) != 2 {
		t.Errorf("Expected 2 connections, got %v", result["total_connections"])
	}
	if result["active_rooms"].(int) != 0 {
		t.Errorf("Expected 0 active rooms, got %v", result["active_rooms"])
	}
}

func TestTurnCredentialsEndpoint(t *testing.T) {
	rl := NewRateLimiter(100, time.Minute)
	defer rl.Stop()

	handler := NewTurnHandler(rl)

	t.Run("returns empty iceServers when env vars are not set", func(t *testing.T) {
		// t.Setenv ensures TURN_URL and TURN_SECRET are unset for this subtest
		// and restores original values when the subtest completes
		t.Setenv("TURN_URL", "")
		t.Setenv("TURN_SECRET", "")

		req := httptest.NewRequest("GET", "/turn-credentials", nil)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("Expected status 200, got %d", rec.Code)
		}

		body := strings.TrimSpace(rec.Body.String())
		expected := `{"iceServers":[]}`
		if body != expected {
			t.Errorf("Expected %s, got %s", expected, body)
		}
	})

	t.Run("returns valid HMAC-SHA1 credentials when env vars are set", func(t *testing.T) {
		turnURL := "turn:my-turn-server.example.com:3478"
		turnSecret := "test-shared-secret"

		t.Setenv("TURN_URL", turnURL)
		t.Setenv("TURN_SECRET", turnSecret)

		req := httptest.NewRequest("GET", "/turn-credentials", nil)
		rec := httptest.NewRecorder()

		beforeRequest := time.Now()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("Expected status 200, got %d", rec.Code)
		}

		type iceServer struct {
			URLs       string `json:"urls"`
			Username   string `json:"username"`
			Credential string `json:"credential"`
		}
		type response struct {
			IceServers []iceServer `json:"iceServers"`
		}

		var resp response
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("Failed to parse response JSON: %v", err)
		}

		if len(resp.IceServers) != 1 {
			t.Fatalf("Expected 1 iceServer, got %d", len(resp.IceServers))
		}

		server := resp.IceServers[0]

		// Verify URL matches the configured TURN_URL
		if server.URLs != turnURL {
			t.Errorf("Expected URLs %q, got %q", turnURL, server.URLs)
		}

		// Verify username format: {timestamp}:warp-lan
		parts := strings.SplitN(server.Username, ":", 2)
		if len(parts) != 2 {
			t.Fatalf("Username should be in format 'timestamp:warp-lan', got %q", server.Username)
		}
		if parts[1] != "warp-lan" {
			t.Errorf("Username suffix should be 'warp-lan', got %q", parts[1])
		}

		// Verify the timestamp is approximately 12 hours in the future
		expiryTimestamp, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			t.Fatalf("Username timestamp is not a valid integer: %v", err)
		}
		expectedExpiry := beforeRequest.Add(12 * time.Hour).Unix()
		// Allow 5 seconds of drift for test execution time
		if expiryTimestamp < expectedExpiry-5 || expiryTimestamp > expectedExpiry+5 {
			t.Errorf("Expiry timestamp %d not within expected range around %d", expiryTimestamp, expectedExpiry)
		}

		// Verify credential is valid base64
		credentialBytes, err := base64.StdEncoding.DecodeString(server.Credential)
		if err != nil {
			t.Fatalf("Credential is not valid base64: %v", err)
		}

		// Verify credential matches HMAC-SHA1(secret, username)
		mac := hmac.New(sha1.New, []byte(turnSecret))
		mac.Write([]byte(server.Username))
		expectedMAC := mac.Sum(nil)

		if !hmac.Equal(credentialBytes, expectedMAC) {
			t.Error("Credential does not match expected HMAC-SHA1 value")
		}
	})
}
