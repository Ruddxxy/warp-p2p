# WARP-LAN

Secure, end-to-end encrypted peer-to-peer file transfer. No servers, no limits, no tracking.

## Features

### Security
- **PAKE Handshake** - Password Authenticated Key Exchange using room codes
- **AES-256-GCM Encryption** - All file data encrypted with authenticated encryption
- **ECDH Key Exchange** - Ephemeral P-256 keys for perfect forward secrecy
- **SHA-256 Integrity** - File hash verification ensures data integrity
- **No Server Storage** - Files transfer directly between peers via WebRTC

### Transfer
- **Large File Support** - Transfer files up to 25GB
- **Streaming Download** - Uses StreamSaver for memory-efficient large file downloads
- **Chunked Transfer** - 64KB chunks with backpressure handling
- **Progress Tracking** - Real-time speed, percentage, and ETA
- **Speed Graph** - Visual transfer speed history

### User Experience
- **Simple Room Codes** - 4-digit codes (XX-XX format) for easy sharing
- **Drag & Drop** - Drop files directly onto the page
- **Copy to Clipboard** - One-click code copying with haptic feedback
- **Session Recovery** - Resume sessions after page refresh (10 min expiry)
- **Mobile Support** - Wake lock keeps screen on during transfers
- **Offline Detection** - Graceful handling of network changes

## Getting Started

### Prerequisites
- Node.js 18+
- A signaling server running (see backend setup)

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

The app runs at http://localhost:3000

### Build

```bash
npm run build
```

### Testing

```bash
npm test           # Run tests in watch mode
npm run test:run   # Run tests once
npm run test:coverage  # Run with coverage report
```

## Configuration

Environment variables (set in `.env` or environment):

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_SIGNALING_URL` | WebSocket signaling server URL | `ws://localhost:8080/ws` |
| `VITE_TURN_URL` | TURN server URL for NAT traversal | - |
| `VITE_TURN_USERNAME` | TURN server username | - |
| `VITE_TURN_CREDENTIAL` | TURN server credential | - |
| `VITE_ICE_TRANSPORT_POLICY` | ICE policy (`all` or `relay`) | `all` |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    React UI Components                   │
│  (DropZone, CodeDisplay, CodeInput, TransferView)       │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    Zustand Store                         │
│  (state, progress, roomCode, peerConnected)             │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                   TransferEngine                         │
│  (orchestrates signaling, security, WebRTC)             │
└─────────────────────────────────────────────────────────┘
         │                 │                    │
         ▼                 ▼                    ▼
┌─────────────┐   ┌─────────────────┐   ┌─────────────┐
│  Signaling  │   │ SecurityManager │   │   WebRTC    │
│   Client    │   │  (PAKE + AES)   │   │ DataChannel │
└─────────────┘   └─────────────────┘   └─────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────┐
│              WebSocket Signaling Server                  │
└─────────────────────────────────────────────────────────┘
```

## How It Works

### Sender Flow
1. Select file via drag-drop or file picker
2. App generates room code and computes file hash
3. Displays code for receiver
4. When receiver joins, PAKE handshake verifies both have same code
5. WebRTC connection established
6. File sent in encrypted 64KB chunks
7. Waits for receiver's integrity verification

### Receiver Flow
1. Enter 4-digit room code
2. PAKE handshake verifies code matches sender
3. Receive file metadata (name, size, hash)
4. Download begins via StreamSaver
5. Compute hash and verify against sender's hash
6. Report verification status to sender

## Tech Stack

- **React 18** - UI framework
- **TypeScript** - Type safety
- **Zustand** - State management
- **Vite** - Build tool
- **Tailwind CSS** - Styling
- **Framer Motion** - Animations
- **StreamSaver** - Large file streaming
- **Vitest** - Testing
- **Web Crypto API** - Cryptographic operations
- **WebRTC** - Peer-to-peer data transfer

## Security Details

### Key Derivation
1. Room code → PBKDF2 (100,000 iterations, SHA-256) → Code Key
2. ECDH key exchange → Shared Secret
3. Shared Secret → HKDF (SHA-256) → Session Key

### Encryption
- Algorithm: AES-256-GCM
- IV: 12 random bytes per chunk
- Authentication: Built into GCM mode

### Integrity
- SHA-256 hash computed over entire file
- Hash included in metadata
- Receiver verifies after transfer completes

## License

MIT
