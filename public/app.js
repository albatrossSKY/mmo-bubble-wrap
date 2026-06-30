/**
 * MMO Bubble Wrap — Client
 *
 * Canvas-rendered, WebSocket-synced, audio-popping, 50K-bubble sheet
 * shared by everyone on the internet.
 */
(() => {
  'use strict';

  // ═══════════════════════════════════════════════════════════
  // Constants
  // ═══════════════════════════════════════════════════════════
  const GRID_W = 1000;
  const GRID_H = 1000;
  const TOTAL  = GRID_W * GRID_H; // 1 000 000
  const BYTES  = Math.ceil(TOTAL / 8);

  const BUBBLE_R     = 13;   // visual radius (world px)
  const BUBBLE_PITCH = 30;   // centre-to-centre (world px)
  const WORLD_W = GRID_W * BUBBLE_PITCH;
  const WORLD_H = GRID_H * BUBBLE_PITCH;

  const SPRITE_PAD = 6;
  const SPRITE_SZ  = BUBBLE_R * 2 + SPRITE_PAD * 2;

  const MIN_ZOOM = 0.08;
  const MAX_ZOOM = 5;
  const ZOOM_SPEED = 1.12;

  const POP_ANIM_MS   = 420;
  const PARTICLE_COUNT = 8;

  const DPR = window.devicePixelRatio || 1;

  // ═══════════════════════════════════════════════════════════
  // DOM handles
  // ═══════════════════════════════════════════════════════════
  const canvas   = document.getElementById('bubbleCanvas');
  const ctx      = canvas.getContext('2d', { alpha: false });
  const $online  = document.getElementById('onlineCount');
  const $popped  = document.getElementById('poppedCount');
  const $remain  = document.getElementById('remainingCount');
  const $progBar = document.getElementById('progressFill');
  const $progPct = document.getElementById('progressPct');
  const $sDot    = document.getElementById('statusDot');
  const $cPanel  = document.getElementById('connPanel');
  const $cDot    = document.getElementById('connDot');
  const $cLabel  = document.getElementById('connLabel');
  const $hint    = document.getElementById('hint');

  // ═══════════════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════════════
  let grid        = new Uint8Array(BYTES);
  let cam         = { x: 0, y: 0, z: 1 };
  let camT        = { x: 0, y: 0, z: 1 };   // target (smoothed)
  let ws          = null;
  let isConnected = false;
  let retryMs     = 1000;
  let online      = 0;
  let pops        = 0;
  let hovered     = null;   // { gx, gy } or null
  let dragging    = false;
  let dragOrigin  = null;
  let poppedFirst = false;  // hide hint after first pop
  let anims       = [];     // pop animations
  let audioCtx    = null;
  let lastSoundT  = 0;

  // ═══════════════════════════════════════════════════════════
  // Grid helpers (bitfield)
  // ═══════════════════════════════════════════════════════════
  function isPopped(x, y) {
    const i = y * GRID_W + x;
    return (grid[i >> 3] & (1 << (i & 7))) !== 0;
  }
  function setPopped(x, y) {
    const i = y * GRID_W + x;
    grid[i >> 3] |= (1 << (i & 7));
  }

  // ═══════════════════════════════════════════════════════════
  // Sprite factory (offscreen canvases at DPR resolution)
  // ═══════════════════════════════════════════════════════════
  let sprites = {};

  function mkSprite(fn) {
    const px = Math.ceil(SPRITE_SZ * DPR);
    const c  = document.createElement('canvas');
    c.width = c.height = px;
    const x  = c.getContext('2d');
    x.scale(DPR, DPR);
    fn(x, SPRITE_SZ / 2, SPRITE_SZ / 2, BUBBLE_R);
    return c;
  }

  function buildSprites() {
    // ── Unpopped bubble ──
    sprites.normal = mkSprite((c, mx, my, r) => {
      // soft shadow
      c.beginPath(); c.arc(mx + 0.8, my + 1, r, 0, Math.PI * 2);
      c.fillStyle = 'rgba(0,0,0,0.13)'; c.fill();

      // body radial gradient
      const g = c.createRadialGradient(mx - r * 0.3, my - r * 0.35, r * 0.08, mx, my, r);
      g.addColorStop(0,    'rgba(175,240,255,0.82)');
      g.addColorStop(0.35, 'rgba(85,190,225,0.6)');
      g.addColorStop(0.7,  'rgba(40,110,175,0.4)');
      g.addColorStop(1,    'rgba(18,55,115,0.22)');
      c.beginPath(); c.arc(mx, my, r, 0, Math.PI * 2);
      c.fillStyle = g; c.fill();

      // rim stroke
      c.strokeStyle = 'rgba(110,200,240,0.22)';
      c.lineWidth = 0.7; c.stroke();

      // primary specular highlight
      c.beginPath();
      c.ellipse(mx - r * 0.22, my - r * 0.32, r * 0.34, r * 0.16, -0.45, 0, Math.PI * 2);
      c.fillStyle = 'rgba(255,255,255,0.52)'; c.fill();

      // tiny secondary dot
      c.beginPath(); c.arc(mx + r * 0.18, my + r * 0.28, r * 0.055, 0, Math.PI * 2);
      c.fillStyle = 'rgba(255,255,255,0.22)'; c.fill();
    });

    // ── Hovered bubble ──
    sprites.hover = mkSprite((c, mx, my, r) => {
      r += 1.5;
      // outer glow
      c.beginPath(); c.arc(mx, my, r + 4, 0, Math.PI * 2);
      const glowG = c.createRadialGradient(mx, my, r, mx, my, r + 4);
      glowG.addColorStop(0, 'rgba(0,245,212,0.18)');
      glowG.addColorStop(1, 'rgba(0,245,212,0)');
      c.fillStyle = glowG; c.fill();

      // shadow
      c.beginPath(); c.arc(mx + 0.8, my + 1, r, 0, Math.PI * 2);
      c.fillStyle = 'rgba(0,0,0,0.13)'; c.fill();

      // body
      const g = c.createRadialGradient(mx - r * 0.3, my - r * 0.35, r * 0.08, mx, my, r);
      g.addColorStop(0,    'rgba(200,250,255,0.9)');
      g.addColorStop(0.35, 'rgba(100,210,240,0.7)');
      g.addColorStop(0.7,  'rgba(50,130,190,0.5)');
      g.addColorStop(1,    'rgba(25,70,140,0.32)');
      c.beginPath(); c.arc(mx, my, r, 0, Math.PI * 2);
      c.fillStyle = g; c.fill();

      // rim
      c.strokeStyle = 'rgba(0,245,212,0.38)';
      c.lineWidth = 1.1; c.stroke();

      // specular
      c.beginPath();
      c.ellipse(mx - r * 0.22, my - r * 0.32, r * 0.34, r * 0.16, -0.45, 0, Math.PI * 2);
      c.fillStyle = 'rgba(255,255,255,0.62)'; c.fill();
    });

    // ── Popped bubble ──
    sprites.popped = mkSprite((c, mx, my, r) => {
      const pr = r * 0.78;
      // indent shadow
      c.beginPath(); c.arc(mx, my, pr, 0, Math.PI * 2);
      c.fillStyle = 'rgba(0,0,0,0.09)'; c.fill();
      // subtle ring
      c.beginPath(); c.arc(mx, my, pr, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(255,255,255,0.028)';
      c.lineWidth = 0.5; c.stroke();
    });
  }

  // ═══════════════════════════════════════════════════════════
  // WebSocket
  // ═══════════════════════════════════════════════════════════
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.onopen = () => {
      isConnected = true;
      retryMs = 1000;
      setConnUI(true);
    };

    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);

      if (m.t === 'init') {
        // Decode base64 → Uint8Array
        const raw = atob(m.g);
        grid = new Uint8Array(BYTES);
        for (let i = 0; i < raw.length; i++) grid[i] = raw.charCodeAt(i);
        online = m.s.o;
        pops   = m.s.p;
        updateHUD();
        fitView();
        return;
      }

      if (m.t === 'pop') {
        if (!isPopped(m.x, m.y)) {
          setPopped(m.x, m.y);
          pops++;
          spawnAnim(m.x, m.y);
          popSound();
          updateHUD();
        }
        return;
      }

      if (m.t === 's') {  // stats
        online = m.o;
        pops   = m.p;
        updateHUD();
      }
    };

    ws.onclose = () => {
      isConnected = false;
      setConnUI(false);
      setTimeout(() => {
        retryMs = Math.min(retryMs * 1.5, 12000);
        connect();
      }, retryMs);
    };

    ws.onerror = () => ws.close();
  }

  function send(x, y) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'pop', x, y }));
  }

  // ═══════════════════════════════════════════════════════════
  // Camera
  // ═══════════════════════════════════════════════════════════
  function fitView() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const z  = Math.min(vw / WORLD_W, vh / WORLD_H) * 0.92;
    cam.z = camT.z = z;
    cam.x = camT.x = (vw - WORLD_W * z) / 2;
    cam.y = camT.y = (vh - WORLD_H * z) / 2;
  }

  function screenToWorld(sx, sy) {
    return { wx: (sx - cam.x) / cam.z, wy: (sy - cam.y) / cam.z };
  }

  function worldToGrid(wx, wy) {
    const gx = Math.floor(wx / BUBBLE_PITCH);
    const gy = Math.floor(wy / BUBBLE_PITCH);
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return null;
    // Check distance to bubble centre
    const cx = (gx + 0.5) * BUBBLE_PITCH;
    const cy = (gy + 0.5) * BUBBLE_PITCH;
    const d  = Math.hypot(wx - cx, wy - cy);
    return d <= BUBBLE_R + 2 ? { gx, gy } : null;
  }

  // ═══════════════════════════════════════════════════════════
  // Pop animations (ring + particles)
  // ═══════════════════════════════════════════════════════════
  const COLORS = ['0,245,212','100,200,255','247,37,133','67,97,238','255,255,255'];

  function spawnAnim(gx, gy) {
    const parts = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const a = (Math.PI * 2 * i) / PARTICLE_COUNT + (Math.random() - 0.5) * 0.6;
      parts.push({
        vx: Math.cos(a) * (0.4 + Math.random() * 0.6),
        vy: Math.sin(a) * (0.4 + Math.random() * 0.6),
        r:  1.2 + Math.random() * 2,
        c:  COLORS[Math.floor(Math.random() * COLORS.length)]
      });
    }
    anims.push({ gx, gy, t0: performance.now(), parts });
  }

  // ═══════════════════════════════════════════════════════════
  // Audio (synthesised pop via Web Audio API)
  // ═══════════════════════════════════════════════════════════
  function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  function popSound() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    if (now - lastSoundT < 0.025) return; // debounce
    lastSoundT = now;

    const len   = Math.floor(audioCtx.sampleRate * 0.07);
    const buf   = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const data  = buf.getChannelData(0);
    const decay = len * (0.12 + Math.random() * 0.06);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / decay);

    const src = audioCtx.createBufferSource();
    src.buffer = buf;

    const filt = audioCtx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = 700 + Math.random() * 700;
    filt.Q.value = 1.2 + Math.random() * 0.6;

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.13 + Math.random() * 0.05, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);

    src.connect(filt).connect(gain).connect(audioCtx.destination);
    src.start(now);
    src.stop(now + 0.1);
  }

  // ═══════════════════════════════════════════════════════════
  // Canvas resize (DPR-aware)
  // ═══════════════════════════════════════════════════════════
  function resize() {
    canvas.width  = window.innerWidth * DPR;
    canvas.height = window.innerHeight * DPR;
    canvas.style.width  = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  // ═══════════════════════════════════════════════════════════
  // Render loop
  // ═══════════════════════════════════════════════════════════
  function render() {
    // ── Smooth camera interpolation ──
    const L = 0.14;
    cam.x += (camT.x - cam.x) * L;
    cam.y += (camT.y - cam.y) * L;
    cam.z += (camT.z - cam.z) * L;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const z  = cam.z;
    const p  = BUBBLE_PITCH * z;
    const ss = SPRITE_SZ * z;       // sprite draw size (CSS px)

    // ── Background ──
    ctx.fillStyle = '#080c22';
    ctx.fillRect(0, 0, vw, vh);

    // wrap area fill
    const wx = cam.x, wy = cam.y;
    const ww = WORLD_W * z, wh = WORLD_H * z;
    const clipL = Math.max(0, wx), clipT = Math.max(0, wy);
    const clipR = Math.min(vw, wx + ww), clipB = Math.min(vh, wy + wh);
    if (clipR > clipL && clipB > clipT) {
      ctx.fillStyle = '#0b0f2a';
      ctx.fillRect(clipL, clipT, clipR - clipL, clipB - clipT);
    }

    // ── Viewport-culled bubble range ──
    const c0 = Math.max(0, Math.floor(-cam.x / p - 0.5));
    const c1 = Math.min(GRID_W, Math.ceil((vw - cam.x) / p + 0.5));
    const r0 = Math.max(0, Math.floor(-cam.y / p - 0.5));
    const r1 = Math.min(GRID_H, Math.ceil((vh - cam.y) / p + 0.5));

    // ── Draw bubbles ──
    const halfSS = ss / 2;
    const hx = hovered ? hovered.gx : -1;
    const hy = hovered ? hovered.gy : -1;

    for (let row = r0; row < r1; row++) {
      for (let col = c0; col < c1; col++) {
        const sx = (col + 0.5) * p + cam.x;
        const sy = (row + 0.5) * p + cam.y;

        let spr;
        if (isPopped(col, row)) {
          spr = sprites.popped;
        } else if (col === hx && row === hy) {
          spr = sprites.hover;
        } else {
          spr = sprites.normal;
        }

        ctx.drawImage(spr, sx - halfSS, sy - halfSS, ss, ss);
      }
    }

    // ── Pop animations ──
    const now = performance.now();
    for (let i = anims.length - 1; i >= 0; i--) {
      const a  = anims[i];
      const dt = now - a.t0;
      const t  = dt / POP_ANIM_MS;
      if (t >= 1) { anims.splice(i, 1); continue; }

      const ax = (a.gx + 0.5) * p + cam.x;
      const ay = (a.gy + 0.5) * p + cam.y;

      // expanding ring
      const ringR = BUBBLE_R * z * (1 + t * 2.5);
      ctx.beginPath();
      ctx.arc(ax, ay, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(0,245,212,${(1 - t) * 0.45})`;
      ctx.lineWidth   = Math.max(0.5, 2 * (1 - t));
      ctx.stroke();

      // flash
      if (t < 0.15) {
        const flash = 1 - t / 0.15;
        ctx.beginPath();
        ctx.arc(ax, ay, BUBBLE_R * z * 1.2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${flash * 0.25})`;
        ctx.fill();
      }

      // particles
      for (const pt of a.parts) {
        const px = ax + pt.vx * t * BUBBLE_R * z * 3.5;
        const py = ay + pt.vy * t * BUBBLE_R * z * 3.5;
        const pr = pt.r * z * (1 - t * 0.7);
        ctx.beginPath();
        ctx.arc(px, py, Math.max(0.3, pr), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${pt.c},${(1 - t) * 0.75})`;
        ctx.fill();
      }
    }

    requestAnimationFrame(render);
  }

  // ═══════════════════════════════════════════════════════════
  // User input: mouse
  // ═══════════════════════════════════════════════════════════
  let pointerDown = false;

  canvas.addEventListener('mousedown', (e) => {
    pointerDown = true;
    dragging = false;
    dragOrigin = { sx: e.clientX, sy: e.clientY, cx: camT.x, cy: camT.y };
  });

  canvas.addEventListener('mousemove', (e) => {
    // Hover
    const { wx, wy } = screenToWorld(e.clientX, e.clientY);
    const cell = worldToGrid(wx, wy);
    if (cell && !isPopped(cell.gx, cell.gy)) {
      hovered = cell;
      canvas.style.cursor = 'pointer';
    } else {
      hovered = null;
      canvas.style.cursor = 'crosshair';
    }

    // Drag to pan
    if (pointerDown && dragOrigin) {
      const dx = e.clientX - dragOrigin.sx;
      const dy = e.clientY - dragOrigin.sy;
      if (!dragging && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) dragging = true;
      if (dragging) {
        camT.x = dragOrigin.cx + dx;
        camT.y = dragOrigin.cy + dy;
        canvas.style.cursor = 'grabbing';
      }
    }
  });

  canvas.addEventListener('mouseup', (e) => {
    if (!dragging && pointerDown) {
      const { wx, wy } = screenToWorld(e.clientX, e.clientY);
      const cell = worldToGrid(wx, wy);
      if (cell && !isPopped(cell.gx, cell.gy)) {
        // Optimistic local update
        setPopped(cell.gx, cell.gy);
        pops++;
        spawnAnim(cell.gx, cell.gy);
        ensureAudio();
        popSound();
        updateHUD();
        send(cell.gx, cell.gy);
        dismissHint();
      }
    }
    pointerDown = false;
    dragging = false;
    dragOrigin = null;
  });

  canvas.addEventListener('mouseleave', () => {
    hovered = null;
    pointerDown = false;
    canvas.style.cursor = 'crosshair';
  });

  // Wheel zoom (toward cursor)
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dir  = e.deltaY < 0 ? ZOOM_SPEED : 1 / ZOOM_SPEED;
    const newZ = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camT.z * dir));
    const mx   = e.clientX, my = e.clientY;
    camT.x = mx - (mx - camT.x) * (newZ / camT.z);
    camT.y = my - (my - camT.y) * (newZ / camT.z);
    camT.z = newZ;
  }, { passive: false });

  // ═══════════════════════════════════════════════════════════
  // User input: touch
  // ═══════════════════════════════════════════════════════════
  let touchDist = 0;
  let touchMid  = { x: 0, y: 0 };
  let touchMoved = false;

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    touchMoved = false;
    const t = e.touches;
    if (t.length === 1) {
      dragOrigin = { sx: t[0].clientX, sy: t[0].clientY, cx: camT.x, cy: camT.y };
    } else if (t.length === 2) {
      touchDist = Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY);
      touchMid  = { x: (t[0].clientX + t[1].clientX) / 2,
                     y: (t[0].clientY + t[1].clientY) / 2 };
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    touchMoved = true;
    const t = e.touches;
    if (t.length === 1 && dragOrigin) {
      const dx = t[0].clientX - dragOrigin.sx;
      const dy = t[0].clientY - dragOrigin.sy;
      camT.x = dragOrigin.cx + dx;
      camT.y = dragOrigin.cy + dy;
    } else if (t.length === 2) {
      const d   = Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY);
      const mid = { x: (t[0].clientX + t[1].clientX) / 2,
                     y: (t[0].clientY + t[1].clientY) / 2 };
      const s   = d / touchDist;
      const nz  = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camT.z * s));
      camT.x = mid.x - (mid.x - camT.x) * (nz / camT.z);
      camT.y = mid.y - (mid.y - camT.y) * (nz / camT.z);
      camT.z = nz;
      camT.x += mid.x - touchMid.x;
      camT.y += mid.y - touchMid.y;
      touchDist = d;
      touchMid  = mid;
    }
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    if (!touchMoved && e.changedTouches.length === 1) {
      const tc = e.changedTouches[0];
      const { wx, wy } = screenToWorld(tc.clientX, tc.clientY);
      const cell = worldToGrid(wx, wy);
      if (cell && !isPopped(cell.gx, cell.gy)) {
        setPopped(cell.gx, cell.gy);
        pops++;
        spawnAnim(cell.gx, cell.gy);
        ensureAudio();
        popSound();
        updateHUD();
        send(cell.gx, cell.gy);
        dismissHint();
      }
    }
    dragOrigin = null;
  });

  // ═══════════════════════════════════════════════════════════
  // HUD buttons
  // ═══════════════════════════════════════════════════════════
  document.getElementById('btnZoomIn').addEventListener('click', () => {
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    const nz = Math.min(MAX_ZOOM, camT.z * 1.4);
    camT.x = cx - (cx - camT.x) * (nz / camT.z);
    camT.y = cy - (cy - camT.y) * (nz / camT.z);
    camT.z = nz;
  });
  document.getElementById('btnZoomOut').addEventListener('click', () => {
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    const nz = Math.max(MIN_ZOOM, camT.z / 1.4);
    camT.x = cx - (cx - camT.x) * (nz / camT.z);
    camT.y = cy - (cy - camT.y) * (nz / camT.z);
    camT.z = nz;
  });
  document.getElementById('btnReset').addEventListener('click', fitView);

  // ═══════════════════════════════════════════════════════════
  // HUD updates
  // ═══════════════════════════════════════════════════════════
  function updateHUD() {
    $online.textContent  = online.toLocaleString();
    $popped.textContent  = pops.toLocaleString();
    $remain.textContent  = Math.max(0, TOTAL - pops).toLocaleString();
    const pct = ((pops / TOTAL) * 100);
    $progBar.style.width = pct + '%';
    $progPct.textContent = pct.toFixed(1) + '%';
  }

  function setConnUI(ok) {
    $cPanel.className = 'hud-panel hud-conn ' + (ok ? 'connected' : 'disconnected');
    $cLabel.textContent = ok ? 'Connected' : 'Reconnecting…';
    $sDot.className = 'stat-dot' + (ok ? '' : ' offline');
  }

  function dismissHint() {
    if (!poppedFirst) {
      poppedFirst = true;
      $hint.classList.add('hidden');
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Resize handler
  // ═══════════════════════════════════════════════════════════
  window.addEventListener('resize', () => { resize(); fitView(); });

  // ═══════════════════════════════════════════════════════════
  // Boot
  // ═══════════════════════════════════════════════════════════
  resize();
  buildSprites();
  connect();
  requestAnimationFrame(render);
})();
