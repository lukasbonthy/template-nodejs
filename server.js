const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ---- World config ----
const WORLD = {
  width: 2400,
  height: 1800,
  obstacles: [
    // x, y are top-left
    { x: 600, y: 300, w: 500, h: 260, label: 'Cafeteria' },
    { x: 1200, y: 700, w: 300, h: 300, label: 'Library' },
    { x: 300, y: 1100, w: 700, h: 220, label: 'Gym' },
    { x: 1500, y: 300, w: 200, h: 800, label: 'Hall' }
  ],
  spawn: { x: 200, y: 200 }
};

const TICK_RATE = 20;           // 20 updates per second
const DT = 1 / TICK_RATE;
const SPEED = 180;              // px/sec
const PLAYER_RADIUS = 18;
const NAME_MAX = 16;

// playerId -> player
const players = new Map();
// socketId -> input state
const inputs = new Map();

function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Student';
  let s = raw.trim();
  if (s.length === 0) s = 'Student';
  s = s.replace(/[^\w\s\-'.]/g, ''); // basic allowlist
  if (s.length > NAME_MAX) s = s.slice(0, NAME_MAX);
  return s;
}

function randomColor() {
  // pleasant pastel-ish
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue} 70% 60%)`;
}

function rectsIntersectCircle(rx, ry, rw, rh, cx, cy, cr) {
  // clamp circle center to rect
  const clampedX = Math.max(rx, Math.min(cx, rx + rw));
  const clampedY = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - clampedX;
  const dy = cy - clampedY;
  return (dx * dx + dy * dy) < (cr * cr);
}

function collideWithWorld(p, nx, ny) {
  // Clamp to world bounds
  nx = Math.max(PLAYER_RADIUS, Math.min(WORLD.width - PLAYER_RADIUS, nx));
  ny = Math.max(PLAYER_RADIUS, Math.min(WORLD.height - PLAYER_RADIUS, ny));

  // Resolve rect collisions by separating axes (x then y)
  // Try move x
  let tryX = nx, tryY = p.y;
  for (const o of WORLD.obstacles) {
    if (rectsIntersectCircle(o.x, o.y, o.w, o.h, tryX, tryY, PLAYER_RADIUS)) {
      // try to resolve on x axis by stepping back
      // Move back along x
      if (tryX > o.x + o.w / 2) {
        tryX = o.x + o.w + PLAYER_RADIUS; // push to right
      } else {
        tryX = o.x - PLAYER_RADIUS;       // push to left
      }
    }
  }

  // Then move y
  let finalX = tryX, finalY = ny;
  for (const o of WORLD.obstacles) {
    if (rectsIntersectCircle(o.x, o.y, o.w, o.h, finalX, finalY, PLAYER_RADIUS)) {
      if (finalY > o.y + o.h / 2) {
        finalY = o.y + o.h + PLAYER_RADIUS; // push down
      } else {
        finalY = o.y - PLAYER_RADIUS;       // push up
      }
    }
  }

  // Clamp again just in case
  finalX = Math.max(PLAYER_RADIUS, Math.min(WORLD.width - PLAYER_RADIUS, finalX));
  finalY = Math.max(PLAYER_RADIUS, Math.min(WORLD.height - PLAYER_RADIUS, finalY));
  return { x: finalX, y: finalY };
}

// Assign unique-ish name if duplicate
function enforceUniqueName(name) {
  const taken = new Set(Array.from(players.values()).map(p => p.name));
  if (!taken.has(name)) return name;
  let i = 2;
  while (taken.has(`${name} ${i}`)) i++;
  return `${name} ${i}`;
}

io.on('connection', (socket) => {
  // Receive join with name
  socket.on('join', (rawName) => {
    let name = sanitizeName(rawName);
    name = enforceUniqueName(name);

    const p = {
      id: socket.id,
      name,
      x: WORLD.spawn.x + Math.random() * 200,
      y: WORLD.spawn.y + Math.random() * 200,
      color: randomColor()
    };
    players.set(socket.id, p);
    inputs.set(socket.id, { up: false, down: false, left: false, right: false });

    socket.emit('init', {
      id: socket.id,
      world: WORLD,
      radius: PLAYER_RADIUS
    });

    // Announce new player to others? Not necessary—state broadcast handles it.
  });

  socket.on('input', (state) => {
    const inp = inputs.get(socket.id);
    if (!inp) return;
    // Basic coercion
    inp.up = !!state.up;
    inp.down = !!state.down;
    inp.left = !!state.left;
    inp.right = !!state.right;
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    inputs.delete(socket.id);
  });
});

// Server tick (authoritative movement)
setInterval(() => {
  for (const [id, p] of players) {
    const inp = inputs.get(id);
    if (!inp) continue;
    let dx = 0, dy = 0;
    if (inp.left) dx -= 1;
    if (inp.right) dx += 1;
    if (inp.up) dy -= 1;
    if (inp.down) dy += 1;

    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const nextX = p.x + dx * SPEED * DT;
      const nextY = p.y + dy * SPEED * DT;
      const resolved = collideWithWorld(p, nextX, nextY);
      p.x = resolved.x;
      p.y = resolved.y;
    }
  }

  const snapshot = Array.from(players.values()).map(p => ({
    id: p.id, name: p.name, x: Math.round(p.x), y: Math.round(p.y), color: p.color
  }));
  io.emit('state', { t: Date.now(), players: snapshot });
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`School world server on http://localhost:${PORT}`);
});
