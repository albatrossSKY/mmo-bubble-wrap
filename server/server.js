const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const GRID_W = 1000;
const GRID_H = 1000;
const TOTAL = GRID_W * GRID_H; // 1,000,000
const GRID_BYTES = Math.ceil(TOTAL / 8); // 6,250
const DATA_DIR = path.join(__dirname, '..', 'data');
const GRID_FILE = path.join(DATA_DIR, 'grid.bin');
const SAVE_INTERVAL_MS = 5000;
const RATE_LIMIT_PER_SEC = 30;
const STATS_INTERVAL_MS = 2000;

// ─── Ensure data directory ──────────────────────────────────
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── Grid State ─────────────────────────────────────────────
// Bitfield: 1 bit per bubble. 0 = unpopped, 1 = popped.
let grid;
let totalPops = 0;
let dirty = false;

function countPops() {
  let count = 0;
  for (let i = 0; i < TOTAL; i++) {
    if (grid[Math.floor(i / 8)] & (1 << (i % 8))) count++;
  }
  return count;
}

function loadGrid() {
  try {
    if (fs.existsSync(GRID_FILE)) {
      const data = fs.readFileSync(GRID_FILE);
      if (data.length === GRID_BYTES) {
        grid = new Uint8Array(data);
        totalPops = countPops();
        console.log(`  Loaded grid: ${totalPops.toLocaleString()} / ${TOTAL.toLocaleString()} popped`);
        return;
      }
      console.warn('  Grid file size mismatch — starting fresh');
    }
  } catch (e) {
    console.error('  Failed to load grid:', e.message);
  }
  grid = new Uint8Array(GRID_BYTES);
  totalPops = 0;
  console.log('  Created new grid');
}

function saveGrid() {
  try {
    fs.writeFileSync(GRID_FILE, grid);
  } catch (e) {
    console.error('Failed to save grid:', e.message);
  }
}

loadGrid();

// Periodic save
setInterval(() => {
  if (dirty) {
    saveGrid();
    dirty = false;
  }
}, SAVE_INTERVAL_MS);

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down — saving grid...');
  saveGrid();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Grid helpers ───────────────────────────────────────────
function isPopped(x, y) {
  const idx = y * GRID_W + x;
  return (grid[Math.floor(idx / 8)] & (1 << (idx % 8))) !== 0;
}

function popBubble(x, y) {
  const idx = y * GRID_W + x;
  grid[Math.floor(idx / 8)] |= (1 << (idx % 8));
  totalPops++;
  dirty = true;
}

// ─── Express ────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);

// ─── WebSocket Server ───────────────────────────────────────
const wss = new WebSocketServer({ server });

// Rate limiting: track pops per client per second
const rateLimits = new Map();

function checkRateLimit(ws) {
  const now = Date.now();
  let rl = rateLimits.get(ws);
  if (!rl || now > rl.reset) {
    rl = { count: 0, reset: now + 1000 };
    rateLimits.set(ws, rl);
  }
  rl.count++;
  return rl.count <= RATE_LIMIT_PER_SEC;
}

function broadcastStats() {
  const msg = JSON.stringify({
    t: 's',
    o: wss.clients.size,
    p: totalPops
  });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on('connection', (ws) => {
  // Send full grid state + stats on connect
  const gridB64 = Buffer.from(grid).toString('base64');
  ws.send(JSON.stringify({
    t: 'init',
    g: gridB64,
    w: GRID_W,
    h: GRID_H,
    s: { o: wss.clients.size, p: totalPops }
  }));

  // Notify everyone of new online count
  broadcastStats();

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.t === 'pop') {
        const { x, y } = msg;
        // Validate coordinates
        if (typeof x !== 'number' || typeof y !== 'number') return;
        if (!Number.isInteger(x) || !Number.isInteger(y)) return;
        if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
        if (isPopped(x, y)) return;
        if (!checkRateLimit(ws)) return;

        // Pop it
        popBubble(x, y);

        // Broadcast to ALL connected clients
        const popMsg = JSON.stringify({ t: 'pop', x, y });
        for (const client of wss.clients) {
          if (client.readyState === 1) client.send(popMsg);
        }
      }
    } catch (_) {
      // Ignore malformed messages
    }
  });

  ws.on('close', () => {
    rateLimits.delete(ws);
    broadcastStats();
  });

  ws.on('error', () => {
    rateLimits.delete(ws);
  });
});

// Periodic stats broadcast
setInterval(broadcastStats, STATS_INTERVAL_MS);

// ─── Start ──────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🫧 MMO Bubble Wrap`);
  console.log(`  Port:    ${PORT}`);
  console.log(`  Grid:    ${GRID_W}×${GRID_H} (${TOTAL.toLocaleString()} bubbles)`);
  console.log(`  Popped:  ${totalPops.toLocaleString()} / ${TOTAL.toLocaleString()}`);
  console.log(`  Status:  Ready\n`);
});
