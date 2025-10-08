const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  path: '/socket.io',
  cors: { origin: '*', methods: ['GET','POST'], credentials: true },
  pingInterval: 25000,
  pingTimeout: 120000
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ---- World config (matches public/campus.png) ----
const WORLD = {
  width: 2600,
  height: 1950,
  obstacles: [], // Using the map image as background only; no wall collisions yet
  spawn: { x: 1300, y: 1000 }
};

const TICK_RATE = 20;
const DT = 1 / TICK_RATE;
const SPEED = 180;
const PLAYER_RADIUS = 18;
const NAME_MAX = 16;

const CHAT_MAX_LEN = 140;
const CHAT_COOLDOWN_MS = 600;

// playerId -> player
const players = new Map();
// socketId -> input state
const inputs = new Map();

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
  s = s.replace(/[^\p{L}\p{N}\p{P}\p{Zs}]/gu, '');
  if (s.length > CHAT_MAX_LEN) s = s.slice(0, CHAT_MAX_LEN);
  return s;
}
function randomColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue} 70% 60%)`;
}

io.on('connection', (socket) => {
  console.log('[io] connection', socket.id);

  socket.on('join', (rawName) => {
    let name = sanitizeName(rawName);
    // enforce unique
    const taken = new Set(Array.from(players.values()).map(p => p.name));
    if (taken.has(name)) { let i = 2; while (taken.has(`${name} ${i}`)) i++; name = `${name} ${i}`; }

    const p = {
      id: socket.id,
      name,
      x: WORLD.spawn.x + (Math.random() * 100 - 50),
      y: WORLD.spawn.y + (Math.random() * 100 - 50),
      color: randomColor(),
      chat: null,
      _lastChatAt: 0
    };
    players.set(socket.id, p);
    inputs.set(socket.id, { up: false, down: false, left: false, right: false });
    console.log('[join]', socket.id, name);

    socket.emit('init', { id: socket.id, world: WORLD, radius: PLAYER_RADIUS });
  });

  socket.on('input', (state) => {
    const inp = inputs.get(socket.id);
    if (!inp) return;
    inp.up = !!state.up;
    inp.down = !!state.down;
    inp.left = !!state.left;
    inp.right = !!state.right;
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
    console.log('[chat]', p.name, ':', text);
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    inputs.delete(socket.id);
    console.log('[io] disconnect', socket.id);
  });
});

setInterval(() => {
  for (const [id, p] of players) {
    const inp = inputs.get(id);
    if (!inp) continue;
    let dx = 0, dy = 0;
    if (inp.left) dx -= 1; if (inp.right) dx += 1;
    if (inp.up) dy -= 1;   if (inp.down) dy += 1;
    if (dx || dy) {
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      let nx = p.x + dx * SPEED * DT;
      let ny = p.y + dy * SPEED * DT;
      // clamp to world bounds
      nx = Math.max(18, Math.min(WORLD.width - 18, nx));
      ny = Math.max(18, Math.min(WORLD.height - 18, ny));
      p.x = nx; p.y = ny;
    }
  }
  const snapshot = Array.from(players.values()).map(p => ({ id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y), color: p.color, chatText: p.chat?.text || null, chatTs: p.chat?.ts || 0 }));
  io.emit('state', { t: Date.now(), players: snapshot });
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`School world server on http://localhost:${PORT}`);
});
