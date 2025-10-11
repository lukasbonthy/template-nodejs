// server.js
// Virtual Campus server: serves your campus.json, reliable naming,
// synced toys/FX, bat knockback — and KICKS duplicate-name "copy" users.

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// ------------------------------ Config ------------------------------
const PORT = process.env.PORT || 3000;
const TICK_MS = 50;                 // 20 FPS server tick
const DT = TICK_MS / 1000;          // seconds per tick

const CAMPUS_SPEED = 210;           // user-controlled movement (px/s)
const ROOM_SPEED   = 220;

const FRICTION = 0.90;              // decay for knockback velocity each tick

// Bat combat tuning
const BAT_ARC_RAD            = Math.PI * 0.75;  // 135° arc
const BAT_RANGE_PX           = 70;              // swing reach
const BAT_KNOCK_PXPS         = 520;             // knockback initial speed
const BAT_HIT_COOLDOWN_MS    = 350;             // per-victim i-frames

// Toys available (order matters: matches client)
const TOYS = ['bat','cake','pizza','mic','book','flag','laptop','ball','paint'];

// Duplicate-name policy:
// Keep the earliest-connected user with a given name; kick all later copies.
const ENFORCE_UNIQUE_NAMES = true;

// ------------------------------ Campus loading ------------------------------
/** Strip // and /* *\/ comments from JSON for leniency */
function stripJsonComments(str) {
  if (typeof str !== 'string') return str;
  let s = str.replace(/\/\*[\s\S]*?\*\//g, '');
  s = s.replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  return s.trim();
}

/** Load campus.json from ./public/campus.json or ./campus.json (prefer public) */
function loadCampusFile() {
  const publicPath = path.join(__dirname, 'public', 'campus.json');
  const rootPath   = path.join(__dirname, 'campus.json');
  let filePath = null;

  if (fs.existsSync(publicPath)) filePath = publicPath;
  else if (fs.existsSync(rootPath)) filePath = rootPath;

  if (!filePath) return null;

  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(stripJsonComments(raw));
    return parsed;
  } catch (e) {
    console.error('[server] Failed to parse campus.json:', e.message);
    return null;
  }
}

// Fallback world if no campus.json present/valid
const DEFAULT_WORLD = {
  width: 3200,
  height: 2000,
  obstacles: [
    { x: 200,  y: 180,  w: 260, h: 180, label: 'A Wing' },
    { x: 650,  y: 140,  w: 280, h: 210, label: 'B Wing' },
    { x: 1100, y: 220,  w: 320, h: 180, label: 'C Wing' },
    { x: 1650, y: 220,  w: 360, h: 200, label: 'D Wing' },
    { x: 2200, y: 260,  w: 380, h: 220, label: 'Gym' },
  ],
  rooms: []
};

let world = loadCampusFile() || DEFAULT_WORLD;
console.log('[server] Campus source:', world === DEFAULT_WORLD ? 'DEFAULT (no campus.json found/valid)' : 'campus.json loaded');

// ------------------------------ App & IO ------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['polling', 'websocket'],
  cors: { origin: '*', methods: ['GET','POST'] },
  path: '/socket.io'
});

// Static: serve from ./public (if exists) and the project root
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) app.use(express.static(publicDir, { fallthrough: true }));
app.use(express.static(__dirname, { fallthrough: true }));

// Endpoint to provide the exact campus map the server is using
app.get('/campus.json', (req, res) => res.json(world));

// Root → serve index.html if present, else a minimal fallback page
app.get('/', (req, res) => {
  const publicIndex = path.join(publicDir, 'index.html');
  const rootIndex   = path.join(__dirname, 'index.html');
  if (fs.existsSync(publicIndex)) return res.sendFile(publicIndex);
  if (fs.existsSync(rootIndex))   return res.sendFile(rootIndex);
  res
    .status(200)
    .type('html')
    .send(`<!doctype html><meta charset="utf-8">
<title>Virtual Campus</title>
<style>body{margin:0;background:#0b0f14;color:#e8ecff;font:14px/1.45 system-ui;padding:24px}</style>
<h1>Virtual Campus</h1>
<p>No <code>index.html</code> found. Place it in <code>./public</code> or next to <code>server.js</code>.</p>`);
});

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ------------------------------ Utilities ------------------------------
const players = new Map();

function safeName(s = '') {
  s = String(s).slice(0, 16).trim();
  // Allow letters/numbers/space/underscore/hyphen/period/apostrophe (including unicode L/N)
  s = s.replace(/[^\p{L}\p{N} _\-'.]/gu, '').trim();
  return s || 'Penguin';
}

function normName(s = '') {
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

function randomColor() {
  const hues = [200, 210, 220, 235, 250, 260];
  const h = hues[Math.floor(Math.random()*hues.length)];
  return `hsl(${h}deg 70% 70%)`;
}
function roomById(id) {
  return (world.rooms || []).find(r => r.id === id) || null;
}
function subroomById(room, subId) {
  if (!room) return null;
  return (room.subrooms || []).find(s => s.id === subId) || null;
}

// Kick a socket by id with a reason (sends 'kicked' first)
function kickSocket(id, reason) {
  const s = io.sockets.sockets.get(id);
  if (!s) return;
  try { s.emit('kicked', { reason }); } catch {}
  setTimeout(() => { try { s.disconnect(true); } catch {} }, 10);
}

// Enforce unique names: keep earliest-connected, kick later copies
function enforceUniqueNames() {
  if (!ENFORCE_UNIQUE_NAMES) return;
  const by = new Map(); // normName -> [{id, connectedAt}]
  for (const [, p] of players) {
    const key = normName(p.name);
    if (!key) continue;
    if (!by.has(key)) by.set(key, []);
    by.get(key).push({ id: p.id, connectedAt: p.connectedAt || 0 });
  }
  for (const [key, arr] of by) {
    if (arr.length <= 1) continue;
    arr.sort((a,b) => a.connectedAt - b.connectedAt);
    const keep = arr[0].id;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].id !== keep) {
        kickSocket(arr[i].id, `duplicate_name:${key}`);
      }
    }
  }
}

// Sweep every 15s to catch duplicates that slipped in earlier
setInterval(enforceUniqueNames, 15000);

// ------------------------------ Socket handlers ------------------------------
io.on('connection', (socket) => {
  // Create player; name stays 'Penguin' until client sends 'join'
  players.set(socket.id, {
    id: socket.id,
    name: 'Penguin',
    color: randomColor(),
    x: 120 + Math.random()*220, y: 140 + Math.random()*180,
    rx: 240, ry: 340,
    kvx: 0, kvy: 0,
    rkvx: 0, rkvy: 0,
    roomId: null,
    subroomId: null,
    equippedKind: null,
    input: { up:false, down:false, left:false, right:false },
    chatText: null,
    chatTs: 0,
    lastHitTs: 0,
    connectedAt: Date.now()
  });

  // Send authoritative world (the same one served at /campus.json)
  socket.emit('init', {
    id: socket.id,
    radius: 18,
    world,
    toys: TOYS
  });

  // Client sets their name here (and we confirm back).
  // If another user already has this name (case/space-insensitive),
  // we KEEP the earliest-connected user and KICK the later "copy".
  socket.on('join', (rawName) => {
    const p = players.get(socket.id);
    if (!p) return;
    const desired = safeName(rawName);
    const key = normName(desired);

    // Find all users currently holding that name (normalized)
    const holders = [];
    for (const [, q] of players) if (normName(q.name) === key) {
      holders.push(q);
    }

    // If no one has it (or only me), set & confirm
    if (holders.length === 0 || (holders.length === 1 && holders[0].id === socket.id)) {
      p.name = desired;
      io.to(socket.id).emit('profile', { id: p.id, name: p.name });
      return;
    }

    // Some have it already → keep earliest-connected holder, kick others
    holders.sort((a,b) => (a.connectedAt||0) - (b.connectedAt||0));
    const owner = holders[0];

    if (owner.id !== socket.id) {
      // I'm a copy → kick me
      io.to(socket.id).emit('nameError', { code: 'duplicate', name: desired });
      kickSocket(socket.id, `duplicate_name:${key}`);
      return;
    }

    // I am the owner already; set name (if I hadn't yet) and kick any later copies
    p.name = desired;
    for (let i = 1; i < holders.length; i++) {
      if (holders[i].id !== owner.id) {
        kickSocket(holders[i].id, `duplicate_name:${key}`);
      }
    }
    io.to(socket.id).emit('profile', { id: p.id, name: p.name });
  });

  // (optional alias)
  socket.on('setName', (rawName) => {
    // Delegate to same logic as 'join'
    io.of('/').adapter.emit('join', rawName); // no-op; kept for compatibility
    // Simpler: call join handler body directly
    const p = players.get(socket.id);
    if (!p) return;
    const desired = safeName(rawName);
    const key = normName(desired);

    const holders = [];
    for (const [, q] of players) if (normName(q.name) === key) holders.push(q);

    holders.sort((a,b) => (a.connectedAt||0) - (b.connectedAt||0));
    const owner = holders[0];

    if (owner && owner.id !== socket.id) {
      io.to(socket.id).emit('nameError', { code: 'duplicate', name: desired });
      kickSocket(socket.id, `duplicate_name:${key}`);
      return;
    }

    p.name = desired;
    for (let i = 1; i < holders.length; i++) {
      if (holders[i].id !== socket.id) kickSocket(holders[i].id, `duplicate_name:${key}`);
    }
    io.to(socket.id).emit('profile', { id: p.id, name: p.name });
  });

  // Input movement
  socket.on('input', (inp) => {
    const p = players.get(socket.id);
    if (!p) return;
    p.input = {
      up: !!inp.up, down: !!inp.down,
      left: !!inp.left, right: !!inp.right
    };
  });

  // Chat bubble
  socket.on('chat', (txt) => {
    const p = players.get(socket.id);
    if (!p) return;
    const t = String(txt || '').slice(0, 140);
    p.chatText = t;
    p.chatTs = Date.now();
  });

  // Toys
  socket.on('equipKind', ({ kind }) => {
    const p = players.get(socket.id);
    if (!p) return;
    if (!TOYS.includes(kind)) return;
    p.equippedKind = kind;
  });
  socket.on('clearEquip', () => {
    const p = players.get(socket.id);
    if (!p) return;
    p.equippedKind = null;
  });

  // Rooms / Subrooms
  socket.on('enterRoom', ({ roomId }) => {
    const p = players.get(socket.id);
    const r = roomById(roomId);
    if (!p || !r) return;
    p.roomId = r.id;
    p.subroomId = null;
    const spawn = r?.interior?.spawn || { x: (r?.interior?.w || 1000)/2, y: (r?.interior?.h || 600)/2 };
    p.rx = spawn.x; p.ry = spawn.y;
    p.kvx = p.kvy = 0; p.rkvx = p.rkvy = 0;
    socket.emit('roomChanged', { roomId: p.roomId, subroomId: p.subroomId });
  });

  socket.on('enterSubroom', ({ roomId, subroomId }) => {
    const p = players.get(socket.id);
    const r = roomById(roomId);
    const sr = subroomById(r, subroomId);
    if (!p || !r || !sr) return;
    p.roomId = r.id;
    p.subroomId = sr.id;
    const spawn = sr?.interior?.spawn || { x: (sr?.interior?.w || 1000)/2, y: (sr?.interior?.h || 600)/2 };
    p.rx = spawn.x; p.ry = spawn.y;
    p.kvx = p.kvy = 0; p.rkvx = p.rkvy = 0;
    socket.emit('roomChanged', { roomId: p.roomId, subroomId: p.subroomId });
  });

  socket.on('leaveRoom', () => {
    const p = players.get(socket.id);
    if (!p) return;
    p.roomId = null;
    p.subroomId = null;
    p.kvx = p.kvy = 0; p.rkvx = p.rkvy = 0;
    socket.emit('roomChanged', { roomId: null, subroomId: null });
  });

  // Actions (right-click / space / E)
  socket.on('action', ({ kind, target, aid }) => {
    const a = players.get(socket.id);
    if (!a) return;
    if (a.equippedKind !== kind) return;

    const inRoom = !!a.roomId;
    const origin = inRoom ? { x: a.rx, y: a.ry } : { x: a.x, y: a.y };
    const tgt = clampTarget(target, inRoom ? a.roomId : null, a.subroomId);

    const payload = {
      id: a.id,
      kind,
      aid,
      space: inRoom ? 'room' : 'campus',
      roomId: a.roomId || null,
      subroomId: a.subroomId || null,
      origin,
      target: tgt,
      ts: Date.now()
    };

    io.emit('action', payload);

    if (kind === 'bat') doBatHit(a, payload);
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
  });
});

// ------------------------------ Helpers ------------------------------
function clampTarget(target, roomId, subroomId) {
  const t = target || { x: 0, y: 0 };
  if (!roomId) {
    return {
      x: Math.max(0, Math.min((world.width  || 3200), t.x|0)),
      y: Math.max(0, Math.min((world.height || 2000), t.y|0))
    };
  } else {
    const r = roomById(roomId);
    let w = r?.interior?.w || 1200, h = r?.interior?.h || 720;
    if (subroomId) {
      const sr = subroomById(r, subroomId);
      w = sr?.interior?.w || w;
      h = sr?.interior?.h || h;
    }
    return {
      x: Math.max(0, Math.min(w, t.x|0)),
      y: Math.max(0, Math.min(h, t.y|0))
    };
  }
}

function doBatHit(attacker, swing) {
  const inRoom = !!attacker.roomId;
  const ax = swing.origin.x, ay = swing.origin.y;
  const ang = Math.atan2(swing.target.y - ay, swing.target.x - ax);
  const now = Date.now();

  for (const [sid, v] of players) {
    if (sid === attacker.id) continue;

    // same space filter
    let px, py, kvx, kvy;
    if (!inRoom) {
      if (v.roomId) continue;
      px = v.x; py = v.y; kvx = 'kvx'; kvy = 'kvy';
    } else {
      if (v.roomId !== attacker.roomId) continue;
      if (!!v.subroomId !== !!attacker.subroomId) continue;
      if (v.subroomId && v.subroomId !== attacker.subroomId) continue;
      px = v.rx; py = v.ry; kvx = 'rkvx'; kvy = 'rkvy';
    }

    const dx = px - ax, dy = py - ay;
    const dist = Math.hypot(dx, dy);
    if (dist > BAT_RANGE_PX) continue;

    const toVictim = Math.atan2(dy, dx);
    let dAng = Math.abs(((toVictim - ang + Math.PI) % (2*Math.PI)) - Math.PI);
    if (dAng > BAT_ARC_RAD * 0.5) continue;

    if (now - (v.lastHitTs || 0) < BAT_HIT_COOLDOWN_MS) continue;
    v.lastHitTs = now;

    const nx = dist > 0 ? dx / dist : Math.cos(ang);
    const ny = dist > 0 ? dy / dist : Math.sin(ang);

    v[kvx] += nx * BAT_KNOCK_PXPS;
    v[kvy] += ny * BAT_KNOCK_PXPS;

    io.emit('hit', {
      victimId: v.id,
      fromId: attacker.id,
      space: swing.space,
      roomId: swing.roomId,
      subroomId: swing.subroomId,
      dir: { x: nx, y: ny },
      ts: now
    });
  }
}

// ------------------------------ Simulation tick ------------------------------
function step() {
  for (const [, p] of players) {
    let ix = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
    let iy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
    if (ix || iy) {
      const n = Math.hypot(ix, iy);
      ix /= n; iy /= n;
    }

    if (!p.roomId) {
      const baseVx = ix * CAMPUS_SPEED;
      const baseVy = iy * CAMPUS_SPEED;
      p.x  += (baseVx + p.kvx) * DT;
      p.y  += (baseVy + p.kvy) * DT;

      p.x = Math.max(0, Math.min((world.width  || 3200), p.x));
      p.y = Math.max(0, Math.min((world.height || 2000), p.y));

      p.kvx *= FRICTION;
      p.kvy *= FRICTION;
    } else {
      const baseVx = ix * ROOM_SPEED;
      const baseVy = iy * ROOM_SPEED;
      p.rx += (baseVx + p.rkvx) * DT;
      p.ry += (baseVy + p.rkvy) * DT;

      const r  = roomById(p.roomId);
      const sr = subroomById(r, p.subroomId);
      const w = (sr?.interior?.w) || (r?.interior?.w) || 1200;
      const h = (sr?.interior?.h) || (r?.interior?.h) || 720;
      p.rx = Math.max(0, Math.min(w, p.rx));
      p.ry = Math.max(0, Math.min(h, p.ry));

      p.rkvx *= FRICTION;
      p.rkvy *= FRICTION;
    }
  }

  const snap = {
    t: Date.now(),
    players: Array.from(players.values()).map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      x: Math.round(p.x), y: Math.round(p.y),
      rx: Math.round(p.rx), ry: Math.round(p.ry),
      roomId: p.roomId,
      subroomId: p.subroomId,
      equippedKind: p.equippedKind || null,
      chatText: p.chatText,
      chatTs: p.chatTs
    }))
  };
  io.emit('state', snap);
}
setInterval(step, TICK_MS);

// ------------------------------ Start ------------------------------
server.listen(PORT, () => {
  console.log(`✅ Virtual Campus running on http://localhost:${PORT}`);
});
