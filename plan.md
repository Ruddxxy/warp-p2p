# Warp-LAN P2P Transfer - Implementation Plan

## Overview
Comprehensive implementation of remaining features including glassmorphism UX, 25GB file limit, security hardening, reliability features, and operational improvements.

## Technology Stack & Syntax Standards

### Backend (Go 1.21+)
- **Structured Logging:** `log/slog` package (not `log.Printf`)
- **Slices/Maps:** `slices` and `maps` packages for operations
- **Generics:** Where applicable for type-safe utilities
- **Context:** Context-first function signatures
- **Error Handling:** `errors.Join`, wrapped errors with `%w`

### Frontend (React 18 + TypeScript 5 + ES2024)
- **TypeScript 5:** `satisfies` operator, const type parameters
- **ES2024:** `Array.at()`, `Object.groupBy()`, `Promise.withResolvers()`
- **React 18:** `useId`, `useSyncExternalStore`, concurrent features
- **Async/Await:** Modern async patterns with `using` keyword where applicable

### Styling (Tailwind CSS v4)
- **CSS Variables:** Native CSS custom properties
- **Modern Utilities:** `@starting-style`, `text-wrap: balance`
- **Container Queries:** `@container` for responsive components
- **Logical Properties:** `margin-inline`, `padding-block`

---

## Phase 1: Security Hardening
**Status:** Pending

### 1.1 Rate Limiting Adjustment
- [ ] **File:** `server/main.go` (line 124)
- [ ] Change limit from 10 to 5 per minute
- [ ] Optimize O(n) complexity in `Allow()` using binary search

### 1.2 CSP Headers Middleware
- [ ] **File:** `server/main.go`
- [ ] Add `setSecurityHeaders()` function with CSP, X-Frame-Options, X-Content-Type-Options
- [ ] Apply to WebSocket upgrade handler

### 1.3 TURN Server Fallback
- [ ] **File:** `frontend/src/lib/TransferEngine.ts`
- [ ] Add configurable ICE servers via environment variables
- [ ] Support VITE_TURN_URL, VITE_TURN_USERNAME, VITE_TURN_CREDENTIAL

---

## Phase 2: 25GB File Size Limit
**Status:** Pending

### 2.1 Add Constants & Validation
- [ ] **File:** `frontend/src/lib/TransferEngine.ts`
- [ ] Add `MAX_FILE_SIZE = 25 * 1024 * 1024 * 1024`
- [ ] Add `FileSizeError` class
- [ ] Validate in `createRoom()` method

### 2.2 DropZone Validation
- [ ] **File:** `frontend/src/components/DropZone.tsx`
- [ ] Add file size check on drop/select
- [ ] Show error message for oversized files

---

## Phase 3: Reliability Features
**Status:** Pending

### 3.1 Room Expiry (10 minutes)
- [ ] **File:** `server/hub.go`
- [ ] Add `CreatedAt` field to Room struct
- [ ] Add `cleanupExpiredRooms()` goroutine
- [ ] Notify clients when room expires

### 3.2 File Hash Verification (SHA-256)
- [ ] **File:** `frontend/src/types/index.ts` - Add `hash` field to FileMetadata
- [ ] **File:** `frontend/src/lib/TransferEngine.ts`
  - [ ] Add `computeFileHash()` function
  - [ ] Compute hash before sending
  - [ ] Verify hash after receiving
  - [ ] Show error on hash mismatch

### 3.3 Transfer Receipt Confirmation
- [ ] **File:** `frontend/src/lib/TransferEngine.ts`
- [ ] Add `receipt` message type
- [ ] Receiver sends confirmation after file saved
- [ ] Sender waits for receipt before showing complete

---

## Phase 4: Operations & Monitoring
**Status:** Pending

### 4.1 Health Metrics Endpoint
- [ ] **File:** `server/main.go`
- [ ] Add `ServerMetrics` struct with uptime, connections, rooms
- [ ] Return detailed JSON from `/health` endpoint

### 4.2 Structured JSON Logging (Go 1.21 slog)
- [ ] **File:** `server/main.go` and `server/hub.go`
- [ ] Use `log/slog` package with JSON handler
- [ ] Replace all `log.Printf` with `slog.Info()`, `slog.Warn()`, `slog.Error()`
- [ ] Add structured attributes: `slog.String()`, `slog.Int()`, `slog.Any()`

### 4.3 Graceful Shutdown
- [ ] **File:** `server/main.go`
- [ ] Add signal handling (SIGINT, SIGTERM)
- [ ] Add context cancellation for hub
- [ ] **File:** `server/hub.go`
- [ ] Update `Run()` to accept context
- [ ] Clean up connections on shutdown

---

## Phase 5: UX/Mobile Enhancements
**Status:** Pending

### 5.1 Offline Detection
- [ ] **File:** `frontend/src/App.tsx`
- [ ] Add `isOffline` state with navigator.onLine
- [ ] Show offline indicator banner

### 5.2 Room Code Persistence
- [ ] **File:** `frontend/src/lib/store.ts`
- [ ] Add localStorage save/load functions
- [ ] Persist room code and role
- [ ] Auto-restore on page load (10 min TTL)

### 5.3 Mobile Improvements
- [ ] **File:** `frontend/src/components/CodeDisplay.tsx`
- [ ] Add vibration feedback on code copy

---

## Phase 6: Glassmorphism UX Enhancement
**Status:** Pending

### 6.1 Global Glass Styles
- [ ] **File:** `frontend/src/index.css`
- [ ] Add `.glass-panel` class with gradient background, blur, shadows
- [ ] Add `.glass-panel-hover` for interactive states
- [ ] Add `.glass-glow` with animated border gradient
- [ ] Add `.glow-button` with hover glow effect
- [ ] Add depth layer utilities

### 6.2 Update Tailwind Config
- [ ] **File:** `frontend/tailwind.config.js`
- [ ] Add matrix color variants
- [ ] Add glow-pulse animation
- [ ] Add extended backdrop blur values

### 6.3 Update Components
- [ ] **File:** `frontend/src/components/Header.tsx` - Apply glass-panel
- [ ] **File:** `frontend/src/components/DropZone.tsx` - Apply glass-panel, glass-glow
- [ ] **File:** `frontend/src/components/CodeDisplay.tsx` - Apply glass-panel, glass-glow
- [ ] **File:** `frontend/src/components/CodeInput.tsx` - Apply glass-panel, glass-glow
- [ ] **File:** `frontend/src/components/TransferView.tsx` - Apply glass-panel, glass-glow
- [ ] **File:** `frontend/src/App.tsx` - Enhanced background glow orbs

---

## Phase 7: Testing (Outline)
**Status:** Pending

### 7.1 Frontend Tests
- [ ] `frontend/src/lib/__tests__/Security.test.ts`
- [ ] `frontend/src/lib/__tests__/TransferEngine.test.ts`

### 7.2 Backend Tests
- [ ] `server/hub_test.go`
- [ ] `server/main_test.go`

---

## Implementation Order

```
1. Phase 1: Security Hardening (no dependencies)
2. Phase 2: File Size Limit (no dependencies)
3. Phase 6: Glassmorphism (no dependencies, visual changes)
4. Phase 3: Reliability Features (builds on Phase 2)
5. Phase 5: UX Enhancements (no dependencies)
6. Phase 4: Operations (backend cleanup)
7. Phase 7: Testing (after all features)
```

---

## Files to Modify

| File | Phases |
|------|--------|
| `server/main.go` | 1.1, 1.2, 4.1, 4.2, 4.3 |
| `server/hub.go` | 3.1, 4.2, 4.3 |
| `frontend/src/lib/TransferEngine.ts` | 1.3, 2.1, 3.2, 3.3 |
| `frontend/src/lib/store.ts` | 5.2 |
| `frontend/src/types/index.ts` | 3.2 |
| `frontend/src/index.css` | 6.1 |
| `frontend/tailwind.config.js` | 6.2 |
| `frontend/src/components/DropZone.tsx` | 2.2, 6.3 |
| `frontend/src/components/CodeDisplay.tsx` | 5.3, 6.3 |
| `frontend/src/components/CodeInput.tsx` | 6.3 |
| `frontend/src/components/TransferView.tsx` | 6.3 |
| `frontend/src/components/Header.tsx` | 6.3 |
| `frontend/src/App.tsx` | 5.1, 6.3 |

---

---

## Code Examples (Latest Syntax)

### Go 1.21+ slog Example
```go
import "log/slog"

// Setup JSON logger
logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
    Level: slog.LevelInfo,
}))
slog.SetDefault(logger)

// Usage
slog.Info("Client connected",
    slog.String("clientId", client.ID),
    slog.String("roomId", roomID),
    slog.Int("totalClients", len(clients)))
```

### Go 1.21+ slices Package
```go
import "slices"

// Binary search for rate limiter optimization
idx, found := slices.BinarySearchFunc(attempts, cutoff, func(t time.Time, cutoff time.Time) int {
    return t.Compare(cutoff)
})
```

### TypeScript 5 satisfies
```typescript
const MAX_FILE_SIZE = 25 * 1024 * 1024 * 1024 satisfies number;

const config = {
    iceServers: getIceServers(),
} satisfies RTCConfiguration;
```

### ES2024 Features
```typescript
// Array.at() for safe indexing
const lastSpeed = speedHistory.at(-1) ?? 0;

// Promise.withResolvers()
const { promise, resolve, reject } = Promise.withResolvers<string>();
```

### Tailwind v4 CSS Variables
```css
.glass-panel {
  --glass-bg: color-mix(in srgb, var(--color-matrix) 8%, transparent);
  background: var(--glass-bg);
  backdrop-filter: blur(20px) saturate(180%);
}
```

---

## Verification

After implementation, verify:
1. **Security:** Rate limiting blocks after 5 requests/minute
2. **File Limit:** Files >25GB show error, cannot be sent
3. **Glassmorphism:** All panels have glass effect with glow
4. **Room Expiry:** Rooms auto-delete after 10 minutes
5. **Hash Verification:** Transfer completes with "verified" status
6. **Offline:** Yellow banner appears when network disconnects
7. **Graceful Shutdown:** Server logs shutdown, closes connections cleanly
