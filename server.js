const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'], // client will force polling; this keeps fallback flexible
  path: '/socket.io',
  cors: { origin: '*', methods: ['GET','POST'], credentials: true },
  pingInterval: 25000,
  pingTimeout: 120000
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Load campus layout (shared with client)
const campusPath = path.join(__dirname, 'public', 'campus.json');
const WORLD = JSON.parse(fs.readFileSync(campusPath, 'utf-8'));

const TICK_RATE = 20;
const DT = 1 / TICK_RATE;
const SPEED = 180;
const PLAYER_RADIUS = 18;
const NAME_MAX = 16;
const CHAT_MAX_LEN = 140;
const CHAT_COOLDOWN_MS = 600;

const players = new Map(); // id -> player
const inputs = new Map();  // id -> {up,down,left,right}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Student';
  let s = raw.trim();
  if (s.length === 0) s = 'Student';
  s = s.replace(/[^\w\s\-'.]/g, '');
  if (s.length > NAME_MAX) s = s.slice(0, NAME_MAX);
  return s;
}
function sanitizeChat(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  // Unicode-safe: keep letters/numbers/punct/space
  s = s.replace(/[^\p{L}\p{N}\p{P}\p{Zs}]/gu, '');
  if (s.length > CHAT_MAX_LEN) s = s.slice(0, CHAT_MAX_LEN);
  return s;
}
function randomColor() { const h = Math.floor(Math.random() * 360); return `hsl(${h} 70% 60%)`; }

function rectsIntersectCircle(rx, ry, rw, rh, cx, cy, cr) {
  const clampedX = Math.max(rx, Math.min(cx, rx + rw));
  const clampedY = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - clampedX;
  const dy = cy - clampedY;
  return (dx * dx + dy * dy) < (cr * cr);
}

function collideWithWorld(p, nx, ny) {
  // Clamp to world bounds first
  nx = Math.max(PLAYER_RADIUS, Math.min(WORLD.width  - PLAYER_RADIUS, nx));
  ny = Math.max(PLAYER_RADIUS, Math.min(WORLD.height - PLAYER_RADIUS, ny));

  // Separate axis resolution vs. obstacles (treat buildings as solid)
  let x = nx, y = p.y;
  for (const o of WORLD.obstacles) {
    if (rectsIntersectCircle(o.x, o.y, o.w, o.h, x, y, PLAYER_RADIUS)) {
      if (x > o.x + o.w / 2) x = o.x + o.w + PLAYER_RADIUS;
      else x = o.x - PLAYER_RADIUS;
    }
  }
  let fx = x, fy = ny;
  for (const o of WORLD.obstacles) {
    if (rectsIntersectCircle(o.x, o.y, o.w, o.h, fx, fy, PLAYER_RADIUS)) {
      if (fy > o.y + o.h / 2) fy = o.y + o.h + PLAYER_RADIUS;
      else fy = o.y - PLAYER_RADIUS;
    }
  }
  fx = Math.max(PLAYER_RADIUS, Math.min(WORLD.width  - PLAYER_RADIUS, fx));
  fy = Math.max(PLAYER_RADIUS, Math.min(WORLD.height - PLAYER_RADIUS, fy));
  return { x: fx, y: fy };
}

function uniqueName(name) {
  const taken = new Set(Array.from(players.values()).map(p => p.name));
  if (!taken.has(name)) return name;
  let i = 2; while (taken.has(`${name} ${i}`)) i++; return `${name} ${i}`;
}

io.on('connection', (socket) => {
  socket.on('join', (rawName) => {
    let name = uniqueName(sanitizeName(rawName));
    const p = {
      id: socket.id,
      name,
      x: WORLD.spawn.x + (Math.random() * 120 - 60),
      y: WORLD.spawn.y + (Math.random() * 120 - 60),
      color: randomColor(),
      chat: null,
      _lastChatAt: 0
    };
    players.set(socket.id, p);
    inputs.set(socket.id, { up: false, down: false, left: false, right: false });

    socket.emit('init', { id: socket.id, world: WORLD, radius: PLAYER_RADIUS });
  });

  socket.on('input', (state) => {
    const inp = inputs.get(socket.id);
    if (!inp) return;
    inp.up = !!state.up; inp.down = !!state.down; inp.left = !!state.left; inp.right = !!state.right;
  });

  socket.on('chat', (raw) => {
    const p = players.get(socket.id);
    if (!p) return;
    const now = Date.now();
    if (now - p._lastChatAt < CHAT_COOLDOWN_MS) return; // basic anti-spam
    const text = sanitizeChat(raw);
    if (!text) return;
    p.chat = { text, ts: now };
    p._lastChatAt = now;
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    inputs.delete(socket.id);
  });
});

// Authoritative tick
setInterval(() => {
  for (const [id, p] of players) {
    const inp = inputs.get(id);
    if (!inp) continue;
    let dx = 0, dy = 0;
    if (inp.left)  dx -= 1;
    if (inp.right) dx += 1;
    if (inp.up)    dy -= 1;
    if (inp.down)  dy += 1;
    if (dx || dy) {
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const nextX = p.x + dx * SPEED * DT;
      const nextY = p.y + dy * SPEED * DT;
      const res = collideWithWorld(p, nextX, nextY);
      p.x = res.x; p.y = res.y;
    }
  }
  const snapshot = Array.from(players.values()).map(p => ({
    id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y),
    color: p.color, chatText: p.chat?.text || null, chatTs: p.chat?.ts || 0
  }));
  io.emit('state', { t: Date.now(), players: snapshot });
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});
