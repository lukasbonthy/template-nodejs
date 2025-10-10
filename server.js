const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'], // client forces polling; keep fallback flexible
  path: '/socket.io',
  cors: { origin: '*', methods: ['GET','POST'], credentials: true },
  pingInterval: 25000,
  pingTimeout: 120000
});

app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;

// ---- Tolerant JSON loader (accepts // and /* */ comments) ----
function loadCampusJSON(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const cleaned = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')   // /* ... */
    .replace(/(^|\s)\/\/[^\n\r]*/g, ''); // // ...
  return JSON.parse(cleaned);
}
const WORLD = loadCampusJSON(path.join(__dirname, 'public', 'campus.json'));

function hashHue(str) { let h=0; for (let i=0;i<str.length;i++) h=(h*31+str.charCodeAt(i))|0; return Math.abs(h)%360; }
function normInterior(i, name) {
  const hue = hashHue(name || 'room');
  return {
    w: (i && (i.w || i.width)) || 1100,
    h: (i && (i.h || i.height)) || 700,
    bg: (i && i.bg) || `hsl(${hue} 35% 20%)`,
    objects: Array.isArray(i?.objects) ? i.objects : []
  };
}

// Build room list (with optional subrooms).
function buildRooms(world) {
  const explicit = Array.isArray(world.rooms) ? world.rooms : [];
  if (explicit.length) {
    return explicit.map((r, i) => ({
      id: r.id || `room_${i}`,
      name: r.name || r.id || `Room ${i+1}`,
      enter: r.enter, // {x,y,w,h}
      interior: normInterior(r.interior, r.name || r.id),
      subrooms: Array.isArray(r.subrooms) ? r.subrooms.map((s, j) => ({
        id: s.id || `sub_${j}`,
        name: s.name || s.id || `Subroom ${j+1}`,
        interior: normInterior(s.interior, (r.name || r.id || 'room') + '_' + (s.name || s.id || 'sub'))
      })) : []
    }));
  }

  // Implicit: every obstacle becomes a room, no subrooms by default.
  const obs = Array.isArray(world.obstacles) ? world.obstacles : [];
  return obs.map((o, i) => ({
    id: `auto_${i}`,
    name: o.label || `Room ${i+1}`,
    enter: { x: o.x, y: o.y, w: o.w, h: o.h },
    interior: normInterior(null, o.label || `Room ${i+1}`),
    subrooms: []
  }));
}
const ROOMS = buildRooms(WORLD);

function findRoomById(id) { return ROOMS.find(r => r.id === id) || null; }
function findSubroom(roomId, subId) {
  const r = findRoomById(roomId); if (!r) return null;
  return (r.subrooms || []).find(s => s.id === subId) || null;
}

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
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

io.on('connection', (socket) => {
  socket.on('join', (rawName) => {
    let name = sanitizeName(rawName) || 'Student';
    const taken = new Set(Array.from(players.values()).map(p => p.name));
    if (taken.has(name)) { let i = 2; while (taken.has(`${name} ${i}`)) i++; name = `${name} ${i}`; }

    const p = {
      id: socket.id,
      name,
      color: randomColor(),
      // campus coords
      x: WORLD.spawn?.x ?? 1600,
      y: WORLD.spawn?.y ?? 1000,
      // room state (null = on campus)
      roomId: null,
      subroomId: null,
      // in-room coords
      rx: 0, ry: 0,
      chat: null,
      _lastChatAt: 0
    };
    players.set(socket.id, p);
    inputs.set(socket.id, { up: false, down: false, left: false, right: false });

    // send authoritative rooms (with subrooms)
    socket.emit('init', { id: socket.id, world: { ...WORLD, rooms: ROOMS }, radius: PLAYER_RADIUS });
  });

  socket.on('input', (state) => {
    const inp = inputs.get(socket.id);
    if (!inp) return;
    inp.up = !!state.up; inp.down = !!state.down; inp.left = !!state.left; inp.right = !!state.right;
  });

  socket.on('chat', (raw) => {
    const p = players.get(socket.id); if (!p) return;
    const now = Date.now();
    if (now - p._lastChatAt < CHAT_COOLDOWN_MS) return;
    const text = sanitizeChat(raw);
    if (!text) return;
    p.chat = { text, ts: now };
    p._lastChatAt = now;
  });

  socket.on('enterRoom', ({ roomId }) => {
    const p = players.get(socket.id); if (!p) return;
    const rm = findRoomById(roomId); if (!rm) return;
    p.roomId = rm.id;
    p.subroomId = null; // lobby by default
    p.rx = Math.floor(rm.interior.w / 2);
    p.ry = Math.floor(rm.interior.h / 2);
    socket.emit('roomChanged', { roomId: p.roomId, subroomId: null });
  });

  socket.on('enterSubroom', ({ roomId, subroomId }) => {
    const p = players.get(socket.id); if (!p) return;
    const rm = findRoomById(roomId); if (!rm) return;
    const sr = findSubroom(rm.id, subroomId); if (!sr) return;
    p.roomId = rm.id;
    p.subroomId = sr.id;
    p.rx = Math.floor(sr.interior.w / 2);
    p.ry = Math.floor(sr.interior.h / 2);
    socket.emit('roomChanged', { roomId: p.roomId, subroomId: p.subroomId });
  });

  socket.on('leaveRoom', () => {
    const p = players.get(socket.id); if (!p) return;
    p.roomId = null;
    p.subroomId = null;
    socket.emit('roomChanged', { roomId: null, subroomId: null });
  });

  socket.on('disconnect', () => { players.delete(socket.id); inputs.delete(socket.id); });
});

// Authoritative tick: campus (x,y) vs room/subroom (rx,ry)
setInterval(() => {
  for (const [id, p] of players) {
    const inp = inputs.get(id); if (!inp) continue;
    let dx = 0, dy = 0;
    if (inp.left)  dx -= 1;
    if (inp.right) dx += 1;
    if (inp.up)    dy -= 1;
    if (inp.down)  dy += 1;

    if (dx || dy) {
      const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;

      if (p.roomId) {
        const rm = findRoomById(p.roomId);
        const sr = p.subroomId ? findSubroom(p.roomId, p.subroomId) : null;
        const W = (sr?.interior?.w) || (rm?.interior?.w) || 1100;
        const H = (sr?.interior?.h) || (rm?.interior?.h) || 700;
        p.rx = clamp(p.rx + dx * SPEED * DT, PLAYER_RADIUS, W - PLAYER_RADIUS);
        p.ry = clamp(p.ry + dy * SPEED * DT, PLAYER_RADIUS, H - PLAYER_RADIUS);
      } else {
        const W = WORLD.width  || 3200;
        const H = WORLD.height || 2000;
        p.x = clamp(p.x + dx * SPEED * DT, PLAYER_RADIUS, W - PLAYER_RADIUS);
        p.y = clamp(p.y + dy * SPEED * DT, PLAYER_RADIUS, H - PLAYER_RADIUS);
      }
    }
  }

  const snapshot = Array.from(players.values()).map(p => ({
    id: p.id,
    name: p.name,
    color: p.color,
    // campus coords
    x: Math.round(p.x), y: Math.round(p.y),
    // room/subroom
    roomId: p.roomId,
    subroomId: p.subroomId,
    rx: Math.round(p.rx), ry: Math.round(p.ry),
    // chat
    chatText: p.chat?.text || null,
    chatTs: p.chat?.ts || 0
  }));
  io.emit('state', { t: Date.now(), players: snapshot });
}, 1000 / TICK_RATE);

server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
