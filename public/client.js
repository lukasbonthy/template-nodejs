(() => {
  const socket = io();

  // Canvas setup
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });

  function resize() {
    canvas.width = Math.floor(window.innerWidth);
    canvas.height = Math.floor(window.innerHeight);
  }
  window.addEventListener('resize', resize);
  resize();

  // UI elements
  const nameModal = document.getElementById('nameModal');
  const nameForm = document.getElementById('nameForm');
  const nameInput = document.getElementById('nameInput');

  const dpad = document.getElementById('dpad');

  let me = null;
  let world = { width: 2000, height: 1200, obstacles: [] };
  let radius = 18;

  // State snapshots (for smoother rendering)
  let lastState = { t: 0, players: [] };
  let currentState = { t: 0, players: [] };
  let interpTime = 0; // ms
  const SERVER_TICK_MS = 50;

  // Input
  const input = { up: false, down: false, left: false, right: false };
  const keys = new Map([
    ['ArrowUp', 'up'], ['KeyW', 'up'],
    ['ArrowDown', 'down'], ['KeyS', 'down'],
    ['ArrowLeft', 'left'], ['KeyA', 'left'],
    ['ArrowRight', 'right'], ['KeyD', 'right']
  ]);

  function sendInput() {
    socket.emit('input', input);
  }

  document.addEventListener('keydown', (e) => {
    const dir = keys.get(e.code);
    if (!dir) return;
    if (!input[dir]) {
      input[dir] = true;
      sendInput();
    }
  });

  document.addEventListener('keyup', (e) => {
    const dir = keys.get(e.code);
    if (!dir) return;
    if (input[dir]) {
      input[dir] = false;
      sendInput();
    }
  });

  // D-pad touch handlers
  dpad.querySelectorAll('button').forEach(btn => {
    const dir = btn.dataset.dir;
    const on = (e) => { e.preventDefault(); if (!input[dir]) { input[dir] = true; sendInput(); } };
    const off = (e) => { e.preventDefault(); if (input[dir]) { input[dir] = false; sendInput(); } };
    btn.addEventListener('touchstart', on, { passive: false });
    btn.addEventListener('touchend', off, { passive: false });
    btn.addEventListener('touchcancel', off, { passive: false });
    btn.addEventListener('mousedown', on);
    btn.addEventListener('mouseup', off);
    btn.addEventListener('mouseleave', off);
  });

  // Modal submit
  nameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = nameInput.value || '';
    socket.emit('join', raw);
  });

  // Persist suggested name between reloads
  nameInput.value = localStorage.getItem('campusName') || '';

  socket.on('init', (payload) => {
    me = payload.id;
    world = payload.world;
    radius = payload.radius || 18;
    // store name suggestion
    const val = nameInput.value.trim();
    if (val) localStorage.setItem('campusName', val);
    nameModal.style.display = 'none';
  });

  socket.on('state', (s) => {
    lastState = currentState;
    currentState = s;
    interpTime = 0;
  });

  function findMe(state) {
    return state.players.find(p => p.id === me);
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpPlayer(pa, pb, t) {
    if (!pa) return pb;
    if (!pb) return pa;
    return {
      id: pb.id,
      name: pb.name,
      color: pb.color,
      x: lerp(pa.x, pb.x, t),
      y: lerp(pa.y, pb.y, t)
    };
  }

  function drawGrid(camX, camY) {
    const grid = 80;
    ctx.lineWidth = 1;
    const startX = -((camX % grid) + grid) % grid;
    const startY = -((camY % grid) + grid) % grid;
    ctx.strokeStyle = '#0f1725';
    for (let x = startX; x < canvas.width; x += grid) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = startY; y < canvas.height; y += grid) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
  }

  function drawObstacles(camX, camY) {
    ctx.fillStyle = '#1a2132';
    ctx.strokeStyle = '#2b3550';
    ctx.lineWidth = 2;
    for (const o of world.obstacles) {
      const sx = Math.round(o.x - camX);
      const sy = Math.round(o.y - camY);
      ctx.fillRect(sx, sy, o.w, o.h);
      ctx.strokeRect(sx, sy, o.w, o.h);

      // label
      ctx.fillStyle = '#aab6e5';
      ctx.font = '600 14px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(o.label || '', sx + o.w / 2, sy + 18);
      ctx.fillStyle = '#1a2132';
    }
  }

  function drawPlayer(p, camX, camY, isMe) {
    const screenX = Math.round(p.x - camX);
    const screenY = Math.round(p.y - camY);
    // body
    ctx.beginPath();
    ctx.arc(screenX, screenY, radius, 0, Math.PI * 2);
    ctx.fillStyle = isMe ? '#ffffff' : p.color || '#7dafff';
    ctx.fill();
    // outline
    ctx.lineWidth = isMe ? 3 : 2;
    ctx.strokeStyle = isMe ? '#3b82f6' : '#111827';
    ctx.stroke();

    // nameplate
    ctx.font = '600 14px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e8ecff';
    ctx.fillText(p.name, screenX, screenY - radius - 10);
  }

  function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

  function render(dt) {
    // Clear background
    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Interpolation factor between last/current states
    // We try to render slightly behind to smooth jitter
    interpTime += dt;
    const alpha = clamp(interpTime / SERVER_TICK_MS, 0, 1);

    // Build an interpolated state
    const interPlayers = [];
    for (const pb of currentState.players) {
      const pa = lastState.players.find((x) => x.id === pb.id);
      interPlayers.push(lerpPlayer(pa, pb, alpha));
    }

    // Camera centered on me
    const meP = interPlayers.find(p => p.id === me);
    let camX = 0, camY = 0;
    if (meP) {
      camX = clamp(meP.x - canvas.width / 2, 0, world.width - canvas.width);
      camY = clamp(meP.y - canvas.height / 2, 0, world.height - canvas.height);
    }

    drawGrid(camX, camY);
    drawObstacles(camX, camY);

    // Draw players
    for (const p of interPlayers) {
      drawPlayer(p, camX, camY, p.id === me);
    }

    requestAnimationFrame((t) => {
      const now = performance.now();
      render(now - (render.lastTime || now));
      render.lastTime = now;
    });
  }

  // Kick off render loop
  requestAnimationFrame((t) => {
    render.lastTime = t;
    render(16);
  });
})();
