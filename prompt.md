# Project: Warp-LAN (P2P Secure File Transfer)

**Role:** Senior Systems Architect & Full Stack Engineer
**Objective:** Build "Warp-LAN," a production-ready, local-first file transfer web app (AirDrop alternative) using a "Systems Engineering" approach.
**Core Constraint:** Minimize token usage for explanations. Output high-density, production-ready code. Fail fast and self-correct.

## 1. Technical Architecture & Stack
* **Frontend:** React (Vite) + TypeScript.
* **Styling:** Tailwind CSS + Framer Motion.
    * **Design System:** "Cyber-Glass" (Dark Mode, `backdrop-blur-xl`, `#00ff41` accents, JetBrains Mono font).
* **Backend (Signaling):** Go (Golang) + `gorilla/websocket`.
    * *Constraint:* Must be deployable to Railway.
* **Networking:** WebRTC (Peer-to-Peer DataChannels) + WebSocket (Signaling only).
* **Security (Critical):**
    * **SPAKE2** (Password Authenticated Key Exchange) to prevent MITM attacks.
    * **End-to-End Encryption** (WebCrypto API or WASM).
* **Performance (Critical):**
    * **StreamSaver.js / Service Workers:** Must handle 10GB+ files by streaming directly to disk. DO NOT load the entire file into RAM (Blob) or the browser will crash.

## 2. Implementation Phases (Execute in Order)

### Phase A: The Signaling Engine (Go)
Create a highly efficient, stateless WebSocket signaling server.
* **Logic:**
    * Clients connect and receive a temporary `ClientID`.
    * Support message types: `offer`, `answer`, `ice-candidate`, `handshake-init`, `handshake-verify`.
    * **Strict Rule:** The server must NEVER store file data. It only routes JSON messages between peers.
* **Output:** `main.go`, `hub.go`, and a `Dockerfile` optimized for Railway (scratch image).

### Phase B: The Security & P2P Logic (TypeScript)
Implement the core `TransferEngine` class.
* **Handshake:** Implement SPAKE2 (or a PAKE equivalent) logic. Users exchange a short code (e.g., "74-29") to derive a session key.
* **Connection:** Establish WebRTC DataChannel using the derived key to authenticate the SDP exchange.
* **Streaming:** Implement the chunking logic (64KB chunks). Pipe the incoming stream directly to the file system to ensure zero-RAM impact.
* **Output:** `TransferEngine.ts`, `SignalingClient.ts`, and `Security.ts`.

### Phase C: The "Cyber-Glass" UI (React)
Build the visual interface with the "Glass Terminal" aesthetic.
* **Components:**
    1.  **Landing:** Large, animated Drop Zone (pulsing green border).
    2.  **Auth:** Split-screen view for Code Generation (Sender) and Code Input (Receiver).
    3.  **Active Transfer:** A real-time **Line Graph** (not just a bar) showing transfer speed (MB/s).
* **UX Details:** Use `framer-motion` for "snappy" transitions. If the network drops, show a "Reconnecting" glitch effect.

### Phase D: Resilience & Documentation
* **Mobile Support:** Add `navigator.wakeLock.request('screen')` to keep the connection alive on iOS/Android.
* **Documentation:** Generate a comprehensive `README.md` containing:
    * Architecture Diagram (Mermaid).
    * Security Threat Model (How MITM is prevented).
    * Deployment Guide for Railway (Backend) and Vercel (Frontend).

## 3. Interaction Rules for Claude
1.  **No Placeholders:** Do not write `// implement logic here`. Write the actual functional code.
2.  **Security First:** Every time you generate networking code, verify (in your thought process) that it does not leak IP addresses or metadata unnecessarily.
3.  **Step-by-Step:**
    * Step 1: Write the Go Backend.
    * Step 2: Write the Frontend Logic (Engines).
    * Step 3: Write the UI Components.
    * Step 4: Write the Docs.

**Action:** Begin Step 1 immediately by generating the Go Signaling Server.
