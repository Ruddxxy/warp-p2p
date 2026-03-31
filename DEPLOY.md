# Warp — Deployment Guide

## Architecture

- **Frontend:** React/TypeScript SPA on Vercel
- **Backend:** Go WebSocket signaling server on Render (or Back4app)

---

## Backend — Render (Recommended)

### Setup

1. Sign up at [render.com](https://render.com)
2. **New > Web Service** > connect your GitHub repo
3. Configure:
   - **Runtime:** Docker
   - **Health Check Path:** `/health`
4. Set environment variables:
   - `ALLOWED_ORIGINS` = `https://warp-p2p.vercel.app`
   - `CSP_CONNECT_SRC` = `wss://*.onrender.com wss://*.vercel.app`
5. Deploy

Or use the Blueprint: click **New > Blueprint** and select this repo — Render reads `render.yaml` automatically.

### After deployment

```bash
curl https://warp-lan-signaling.onrender.com/health
```

Your WebSocket endpoint: `wss://warp-lan-signaling.onrender.com/ws`

### Notes

- Render sets `PORT=10000` automatically — the server reads it
- Free tier: 512MB RAM, 0.1 CPU (spins down after inactivity, ~30s cold start)
- WebSocket connections are natively supported over `wss://`

---

## Backend — Back4app Containers (Alternative)

### Setup

1. Sign up at [back4app.com](https://back4app.com)
2. Go to **Containers** section, connect your GitHub repo
3. Configure:
   - **Root Directory:** `/`
   - **Port:** `8080`
   - **Health check:** `/health`
4. Set environment variables:
   - `ALLOWED_ORIGINS` = `https://warp-p2p.vercel.app`
   - `CSP_CONNECT_SRC` = `wss://*.b4a.run wss://*.vercel.app`
5. Deploy

### After deployment

```bash
curl https://your-app.b4a.run/health
```

---

## Frontend — Vercel

Set in Vercel dashboard under **Settings > Environment Variables**:

| Variable | Value |
|----------|-------|
| `VITE_SIGNALING_URL` | `wss://warp-lan-signaling.onrender.com/ws` |

Redeploy after setting the variable — Vite bakes env vars into the build.

---

## Verification

```bash
# Backend health
curl https://your-signaling-server/health

# Frontend build
cd frontend && npx tsc --noEmit && npx vite build

# Tests
cd frontend && npx vitest run
cd server && go test -race ./...
```
