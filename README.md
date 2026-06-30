# 🫧 MMO Bubble Wrap

A single, massive sheet of 50,000 virtual bubbles shared by everyone on the internet. Pop a bubble in Tokyo and it pops on every screen worldwide at the exact same millisecond.

**Tech stack:** Node.js · Express · WebSockets (`ws`) · HTML5 Canvas · Web Audio API

---

## Quick Start (Local)

```bash
npm install
npm run dev        # starts on http://localhost:3000  (auto-restarts on changes)
```

Open two browser tabs to verify real-time sync.

---

## Deploy to Fly.io

```bash
# Install the Fly CLI: https://fly.io/docs/hands-on/install-flyctl/
fly auth login

# Launch (first time — creates app + Dockerfile build)
fly launch

# Create a persistent volume for bubble state
fly volumes create bubble_data --region iad --size 1

# Deploy
fly deploy
```

Grid state is saved to `/app/data/grid.bin` and persists across deploys via the Fly volume.

---

## Deploy with Docker (any host)

```bash
docker build -t mmo-bubble-wrap .
docker run -p 3000:3000 -v bubble_data:/app/data mmo-bubble-wrap
```

---

## Architecture

| Component | Description |
|-----------|-------------|
| **Server** (`server/server.js`) | Express serves static files; `ws` handles WebSocket connections. Grid is a 6.25 KB bitfield (1 bit per bubble). State saved to disk every 5 s and on shutdown. |
| **Client** (`public/app.js`) | HTML5 Canvas renderer with DPR-aware offscreen sprites, viewport culling, smooth camera (pan/zoom), optimistic updates, and synthesised pop sounds via Web Audio. |
| **Protocol** | Compact JSON over WebSocket. `init` sends base64 grid on connect; `pop` broadcasts individual pops; `s` sends periodic stats. |

---

## Licence

MIT
