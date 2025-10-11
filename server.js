// server.js
// Simple multiplayer “Virtual Campus” server with rooms, subrooms, toys,
// synced action FX, and bat hit/knockback logic. Works with polling-only clients.

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

// ------------------------------ World ------------------------------
// Default in-memory world (used if campus.json is missing/invalid).
let world = {
  width: 3200,
  height: 2000,
  obstacles: [
    // keep it sparse; you can swap this by providing a campus.json file
    { x: 200,  y: 180,  w: 260, h: 180, label: 'A Wing' },
    { x: 650,  y: 140,  w: 280, h: 210, label: 'B Wing' },
    { x: 1100, y: 220,  w: 320, h: 180, label: 'C Wing' },
    { x: 1650, y: 220,  w: 360, h: 200, label: 'D Wing' },
    { x: 2200, y: 260,  w: 380, h: 220, label: 'Gym' },
  ],
  rooms: [
    {
      id: 'a',
      name: 'A Wing',
      enter: { x: 200, y: 180, w: 260, h: 180 },
      interior: {
        w: 1100, h: 700, bg: '#1c2538',
        spawn: { x: 240, y: 340 },
        objects: [
          { x: 120, y: 120, w: 220, h: 120, label: 'Tables' },
          { x: 420, y: 280, w: 180, h: 90,  label: 'Sofa'   },
        ]
      },
      subrooms: [
        {
          id: 'a1', name: 'Classroom 1',
          interior: { w: 1000, h: 680, bg: '#1f2a44',
            spawn: { x: 200, y: 320 },
            objects: [
              { x: 120, y: 120, w: 200, h: 120, label: 'Desks' },
              { x: 520, y: 200, w: 160, h: 100, label: 'Lab' },
            ]
          }
        },
        {
          id: 'a2', name: 'Classroom 2',
          interior: { w: 1000, h: 680, bg: '#22304f',
            spawn: { x: 240, y: 360 },
            objects: [
              { x: 140, y: 160, w: 180, h: 120, label: 'Desks' },
              { x: 520, y: 240, w: 200, h: 100, label: 'Project' },
            ]
          }
        }
      ]
    },
    {
      id: 'c',
      name: 'C Wing',
      enter: { x: 1100, y: 220, w: 320, h: 180 },
      interior: {
        w: 1200, h: 720, bg: '#192238',
        spawn: { x: 260, y: 360 },
        objects: [
          { x: 160, y: 160, w: 260, h: 140, label: 'Benches' },
          { x: 560, y: 260, w: 190, h: 100, label: 'Whiteboard' },
        ]
      },
      subrooms: [
        {
          id: 'c1', name: 'Classroom 1',
          interior: { w: 1000, h: 680, bg: '#233456',
            spawn: { x: 220, y: 340 },
            objects: [
              { x: 120, y: 130, w: 220, h: 120, label: 'Desks' },
              { x: 520, y: 220, w: 180, h: 100, label: 'Lab' },
            ]
          }
        }
      ]
    },
  ]
};

// Try to load ./campus.json if present (must be valid JSON, no comments)
try {
  const raw = fs.readFileSync(path.join(__dirname, 'campus.json'), 'utf8');
  const parsed = JSON.parse(raw);
  // Shallow-merge onto defaults
  world = { ...world, ...parsed };
} catch (e) {
  console.log('[server] campus.json not loaded (using defaults):', e.message);
}

// ------------------------------ App & IO ------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Allow polling (client forces it), but keep websockets if clients allow
  transports: ['polling', 'websocket'],
  cors: { origin: '*', methods: ['GET','POST'] },
  path: '/socket.io'
});

// Serve static files (index.html, client.js, style.css, campus.json)
app.use(express.static(__dirname, { fallthrough: true }));

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ------------------------------ Players ------------------------------
/**
 * Player model
 * - campus position: x, y
 * - room position:   rx, ry
 * - user input:      input = { up,down,left,right }
 * - color:           for avatar
 * - velocities:      kvx/kvy (campus knockback), rkvx/rkvy (room knockback)
 * - chat bubble:     chatText, chatTs
 */
const players = new Map();

function safeName(s = '') {
  s = String(s).slice(0, 16);
  // letters, numbers, spaces, - ' .
  s = s.replace(/[^A-Za-z0-9 \-'.]/g, '').trim();
  return s || 'Penguin';
}
function randomColor() {
  const hues = [200, 215, 225, 240, 260];
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

// ------------------------------ Socket handlers ------------------------------
io.on('connection', (socket) => {
  // Create a stub player; becomes "active" on 'join'
  players.set(socket.id, {
    id: socket.id,
    name: 'Penguin',
    color: randomColor(),
    x: 120 + Math.random()*220, y: 140 + Math.random()*180,
    rx: 240, ry: 340,
    // knockback velocities only; movement uses direct base speed from input
    kvx: 0, kvy: 0,     // campus knockback velocity (px/s)
    rkvx: 0, rkvy: 0,   // room knockback velocity
    roomId: null,
    subroomId: null,
    equippedKind: null,
    input: { up:false, down:false, left:false, right:false },
    chatText: null,
    chatTs: 0,
    lastHitTs: 0
  });

  // Send init snapshot
  socket.emit('init', {
    id: socket.id,
    radius: 18,
    world,
    toys: TOYS
  });

  // Join (set name/color fresh)
  socket.on('join', (rawName) => {
    const p = players.get(socket.id);
    if (!p) return;
    p.name = safeName(rawName);
    if (!p.color) p.color = randomColor();
  });

  // Input
  socket.on('input', (inp) => {
    const p = players.get(socket.id);
    if (!p) return;
    // Coerce booleans
    p.input = {
      up: !!inp.up, down: !!inp.down,
      left: !!inp.left, right: !!inp.right
    };
  });

  // Chat
  socket.on('chat', (txt) => {
    const p = players.get(socket.id);
    if (!p) return;
    const t = String(txt || '').slice(0, 140);
    p.chatText = t;
    p.chatTs = Date.now();
  });

  // Equip toy
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

  // Rooms
  socket.on('enterRoom', ({ roomId }) => {
    const p = players.get(socket.id);
    const r = roomById(roomId);
    if (!p || !r) return;
    p.roomId = r.id;
    p.subroomId = null;
    const spawn = r?.interior?.spawn || { x: (r?.interior?.w || 1000)/2, y: (r?.interior?.h || 600)/2 };
    p.rx = spawn.x; p.ry = spawn.y;
    // clear momentum between spaces
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
    const tgt = clampTarget(kind, target, inRoom ? a.roomId : null, a.subroomId);

    const payload = {
      id: a.id,
      kind,
      aid,                   // echo back client action id for reconciliation
      space: inRoom ? 'room' : 'campus',
      roomId: a.roomId || null,
      subroomId: a.subroomId || null,
      origin,
      target: tgt,
      ts: Date.now()        // server time for clock sync
    };

    io.emit('action', payload);

    // Only the bat causes a “hit” + knockback. Add others later if desired.
    if (kind === 'bat') doBatHit(a, payload);
  });

  // Disconnect
  socket.on('disconnect', () => {
    players.delete(socket.id);
  });
});

// ------------------------------ Helpers (server) ------------------------------
function clampTarget(kind, target, roomId, subroomId) {
  // We’ll just clamp to campus bounds (or room interior bounds if we had them on server).
  // Since effects are mostly cosmetic, light clamping is fine.
  const t = target || { x: 0, y: 0 };
  if (!roomId) {
    return {
      x: Math.max(0, Math.min(world.width,  t.x|0)),
      y: Math.max(0, Math.min(world.height, t.y|0))
    };
  } else {
    // If we know room interior size, clamp to that. Otherwise just sanitize numbers.
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
    if (!inRoom) {
      if (v.roomId) continue;
      var px = v.x,  py = v.y, kvx = 'kvx', kvy = 'kvy';
    } else {
      if (v.roomId !== attacker.roomId) continue;
      if (!!v.subroomId !== !!attacker.subroomId) continue;
      if (v.subroomId && v.subroomId !== attacker.subroomId) continue;
      var px = v.rx, py = v.ry, kvx = 'rkvx', kvy = 'rkvy';
    }

    const dx = px - ax, dy = py - ay;
    const dist = Math.hypot(dx, dy);
    if (dist > BAT_RANGE_PX) continue;

    // within arc?
    const toVictim = Math.atan2(dy, dx);
    let dAng = Math.abs(((toVictim - ang + Math.PI) % (2*Math.PI)) - Math.PI);
    if (dAng > BAT_ARC_RAD * 0.5) continue;

    // per-victim i-frames
    if (now - (v.lastHitTs || 0) < BAT_HIT_COOLDOWN_MS) continue;
    v.lastHitTs = now;

    // knockback direction (from attacker -> victim)
    const nx = dist > 0 ? dx / dist : Math.cos(ang);
    const ny = dist > 0 ? dy / dist : Math.sin(ang);

    // apply knockback
    v[kvx] += nx * BAT_KNOCK_PXPS;
    v[kvy] += ny * BAT_KNOCK_PXPS;

    // notify clients for hit flash / shake
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
    // Base movement from input (no inertia)
    let ix = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
    let iy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
    if (ix || iy) {
      const n = Math.hypot(ix, iy);
      ix /= n; iy /= n;
    }

    if (!p.roomId) {
      // campus coords
      const baseVx = ix * CAMPUS_SPEED;
      const baseVy = iy * CAMPUS_SPEED;
      p.x  += (baseVx + p.kvx) * DT;
      p.y  += (baseVy + p.kvy) * DT;

      // world bounds
      p.x = Math.max(0, Math.min(world.width,  p.x));
      p.y = Math.max(0, Math.min(world.height, p.y));

      // decay knockback velocity
      p.kvx *= FRICTION;
      p.kvy *= FRICTION;
    } else {
      // room coords
      const baseVx = ix * ROOM_SPEED;
      const baseVy = iy * ROOM_SPEED;
      p.rx += (baseVx + p.rkvx) * DT;
      p.ry += (baseVy + p.rkvy) * DT;

      // interior bounds clamp (use room or subroom size)
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

  // Broadcast snapshot with server timestamp for client clock sync
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
  console.log(`✅ Virtual Campus server running on http://localhost:${PORT}`);
});
