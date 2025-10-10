const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'], // client forces polling; fallback allowed
  path: '/socket.io',
  cors: { origin: '*', methods: ['GET','POST'], credentials: true },
  pingInterval: 25000,
  pingTimeout: 120000
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Robust JSON loader (will tolerate commented JSON too)
function loadCampusJSON(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const cleaned = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')   // /* ... */
    .replace(/(^|\s)\/\/[^\n\r]*/g, ''); // // ...
  return JSON.parse(cleaned);
}
const WORLD = loadCampusJSON(path.join(__dirname, 'public', 'campus.json'));

const TICK_RATE = 20;
const DT = 1 / TICK_RATE;
const SPEED = 180;
const PLAYER_RADIUS = 18;
const NAME_MAX = 16;
const CHAT_MAX_LEN = 140;
const CHAT_COOLDOWN_MS = 600;

const players = new Map(); // id -> player
const inputs  = new Map(); // id -> { up,down,left,right }

function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Student';
  let s = raw.trim();
  if (!s) s = 'Student';
  s = s.replace(/[^\w\s\-'.]/g, '');
  return s.slice(0, NAME_MAX);
}
function sanitizeChat(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/[^\p{L}\p{N}\p{P}\p{Zs}]/gu, '');
  return s.slice(0, CHAT_MAX_LEN);
}
function randomColor() { const h = Math.floor(Math.random() * 360); return `hsl(${h} 70% 60%)`; }
function clamp(val, lo, hi) { return Math.max(lo, Math.min(hi, val)); }

io.on('connection', (socket) => {
  socket.on('join', (rawName) => {
    let name = sanitizeName(rawName) || 'Student';
    const taken = new Set(Array.from(players.values()).map(p => p.name));
    if (taken.has(name)) { let i = 2; while (taken.has(`${name} ${i}`)) i++; name = `${name} ${i}`; }

    const p = {
      id: socket.id,
      name,
      x: WORLD.spawn?.x ?? 1600,
      y: WORLD.spawn?.y ?? 1000,
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
    if (now - p._lastChatAt < CHAT_COOLDOWN_MS) return;
    const text = sanitizeChat(raw);
    if (!text) return;
    p.chat = { text, ts: now };
    p._lastChatAt = now;
  });

  socket.on('disconnect', () => { players.delete(socket.id); inputs.delete(socket.id); });
});

// World-bounds-only movement (NO obstacle collision so you can stand on buildings)
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
      const W = WORLD.width  || 3200;
      const H = WORLD.height || 2000;
      p.x = clamp(p.x + dx * SPEED * DT, PLAYER_RADIUS, W - PLAYER_RADIUS);
      p.y = clamp(p.y + dy * SPEED * DT, PLAYER_RADIUS, H - PLAYER_RADIUS);
    }
  }
  const snapshot = Array.from(players.values()).map(p => ({
    id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y),
    color: p.color, chatText: p.chat?.text || null, chatTs: p.chat?.ts || 0
  }));
  io.emit('state', { t: Date.now(), players: snapshot });
}, 1000 / TICK_RATE);

server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
