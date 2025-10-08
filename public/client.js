(() => {
  const socket = io('/', {
    transports: ['polling'],
    upgrade: false,
    path: '/socket.io',
    withCredentials: true
  });

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });

  function resize() {
    canvas.width = Math.floor(window.innerWidth);
    canvas.height = Math.floor(window.innerHeight);
  }
  window.addEventListener('resize', resize);
  resize();

  const statusEl = document.getElementById('status');
  const nameModal = document.getElementById('nameModal');
  const nameForm = document.getElementById('nameForm');
  const nameInput = document.getElementById('nameInput');
  const dpad = document.getElementById('dpad');

  const chatForm = document.getElementById('chatForm');
  const chatInput = document.getElementById('chatInput');

  // Load campus image
  const bgImg = new Image();
  bgImg.src = 'campus.png';
  let bgReady = false;
  bgImg.onload = () => { bgReady = true; };

  let me = null;
  let world = { width: 2600, height: 1950, obstacles: [] };
  let radius = 18;

  let lastState = { t: 0, players: [] };
  let currentState = { t: 0, players: [] };
  let interpTime = 0;
  const SERVER_TICK_MS = 50;

  const CHAT_DURATION_MS = 5000;
  let localEcho = null;

  const input = { up: false, down: false, left: false, right: false };
  const keys = new Map([
    ['ArrowUp', 'up'], ['KeyW', 'up'],
    ['ArrowDown', 'down'], ['KeyS', 'down'],
    ['ArrowLeft', 'left'], ['KeyA', 'left'],
    ['ArrowRight', 'right'], ['KeyD', 'right']
  ]);

  const setStatus = (ok, msg) => {
    statusEl.textContent = ok ? `ð¢ ${msg || 'Connected'}` : `ð´ ${msg || 'Disconnected'}`;
  };
  socket.on('connect', () => setStatus(true, 'Connected (polling)'));
  socket.on('disconnect', () => setStatus(false, 'Disconnected'));
  socket.on('connect_error', () => setStatus(false, 'Connect error'));

  function sendInput() { socket.emit('input', input); }

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' && document.activeElement !== chatInput) {
      e.preventDefault();
      chatInput.focus();
      return;
    }
    const dir = keys.get(e.code);
    if (!dir) return;
    if (!input[dir]) { input[dir] = true; sendInput(); }
  });
  document.addEventListener('keyup', (e) => {
    const dir = keys.get(e.code);
    if (!dir) return;
    if (input[dir]) { input[dir] = false; sendInput(); }
  });

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

  nameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = nameInput.value || '';
    socket.emit('join', raw);
  });
  nameInput.value = localStorage.getItem('campusName') || '';

  socket.on('init', (payload) => {
    me = payload.id;
    world = payload.world;
    radius = payload.radius || 18;
    const val = nameInput.value.trim();
    if (val) localStorage.setItem('campusName', val);
    nameModal.style.display = 'none';
  });

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (text.length) {
      socket.emit('chat', text);
      localEcho = { text, ts: Date.now() };
      chatInput.value = '';
    }
    chatInput.blur();
  });

  socket.on('state', (s) => {
    lastState = currentState;
    currentState = s;
    interpTime = 0;
  });

  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpPlayer(pa, pb, t) {
    if (!pa) return pb;
    if (!pb) return pa;
    return {
      id: pb.id,
      name: pb.name,
      color: pb.color,
      x: lerp(pa.x, pb.x, t),
      y: lerp(pa.y, pb.y, t),
      chatText: pb.chatText,
      chatTs: pb.chatTs
    };
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function drawBackground(camX, camY) {
    if (!bgReady) return;
    const sx = Math.floor(camX);
    const sy = Math.floor(camY);
    const sw = Math.min(canvas.width, bgImg.width - sx);
    const sh = Math.min(canvas.height, bgImg.height - sy);
    if (sw > 0 && sh > 0) {
      ctx.drawImage(bgImg, sx, sy, sw, sh, 0, 0, sw, sh);
    } else {
      // fallback: fill background
      ctx.fillStyle = '#0b0f14';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  function drawPlayer(p, camX, camY, isMe) {
    const screenX = Math.round(p.x - camX);
    const screenY = Math.round(p.y - camY);

    // shadow for visibility on the map
    ctx.beginPath();
    ctx.arc(screenX + 2, screenY + 2, radius + 1, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fill();

    // body
    ctx.beginPath();
    ctx.arc(screenX, screenY, radius, 0, Math.PI * 2);
    ctx.fillStyle = isMe ? '#ffffff' : p.color || '#7dafff';
    ctx.fill();
    ctx.lineWidth = isMe ? 3 : 2;
    ctx.strokeStyle = isMe ? '#3b82f6' : '#111827';
    ctx.stroke();

    // nameplate (with outline for legibility)
    ctx.font = '600 14px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeText(p.name, screenX, screenY - radius - 10);
    ctx.fillStyle = '#e8ecff';
    ctx.fillText(p.name, screenX, screenY - radius - 10);

    // chat bubble
    const now = Date.now();
    let text = p.chatText;
    let ts = p.chatTs;
    if (isMe && localEcho) {
      if (!ts || localEcho.ts >= ts) { text = localEcho.text; ts = localEcho.ts; }
      if (now - localEcho.ts > 2000) localEcho = null;
    }
    if (text && ts && now - ts < CHAT_DURATION_MS) {
      const t = (now - ts) / CHAT_DURATION_MS;
      const alpha = t < 0.8 ? 1 : (1 - (t - 0.8) / 0.2);
      drawChatBubble(screenX, screenY, text, alpha);
    }
  }

  function wrapLines(text, maxWidth) {
    const words = text.split(/\s+/);
    const lines = [];
    let line = '';
    ctx.font = '600 14px Inter, sans-serif';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      const m = ctx.measureText(test).width;
      if (m <= maxWidth) line = test;
      else {
        if (line) lines.push(line);
        if (ctx.measureText(w).width > maxWidth) {
          let chunk = '';
          for (const ch of w) {
            const tryChunk = chunk + ch;
            if (ctx.measureText(tryChunk).width <= maxWidth) chunk = tryChunk;
            else { lines.push(chunk); chunk = ch; }
          }
          line = chunk;
        } else line = w;
      }
    }
    if (line) lines.push(line);
    return lines.slice(0, 4);
  }
  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
  function drawChatBubble(px, py, text, alpha) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.font = '600 14px Inter, sans-serif';
    ctx.textAlign = 'left';

    const maxTextWidth = 220;
    const lines = wrapLines(text, maxTextWidth);
    const lineHeight = 18;
    const paddingX = 10;
    const paddingY = 8;

    const contentW = Math.ceil(Math.max(...lines.map(l => ctx.measureText(l).width), 30));
    const contentH = lines.length * lineHeight;
    const bubbleW = contentW + paddingX * 2;
    const bubbleH = contentH + paddingY * 2;

    let bx = px + radius + 12;
    let by = py - radius - Math.floor(bubbleH / 2);
    if (bx + bubbleW > canvas.width - 8) bx = px - radius - 12 - bubbleW;
    if (bx < 8) bx = 8;
    if (by < 8) by = 8;
    if (by + bubbleH > canvas.height - 8) by = canvas.height - 8 - bubbleH;

    ctx.fillStyle = 'rgba(16,20,32,0.92)';
    ctx.strokeStyle = '#2b3550';
    ctx.lineWidth = 2;
    roundRect(bx, by, bubbleW, bubbleH, 10);
    ctx.fill();
    ctx.stroke();

    const tailX = bx < px ? bx + bubbleW : bx;
    const dir = (bx < px) ? 1 : -1;
    const tailBaseY = Math.max(by + 8, Math.min(by + bubbleH - 8, py - 6));
    ctx.beginPath();
    ctx.moveTo(tailX, tailBaseY - 6);
    ctx.lineTo(tailX + 10 * dir, py - 4);
    ctx.lineTo(tailX, tailBaseY + 6);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#e8ecff';
    let tx = bx + paddingX;
    let ty = by + paddingY + 13;
    for (const l of lines) { ctx.fillText(l, tx, ty); ty += lineHeight; }

    ctx.restore();
  }

  function render(dt) {
    // Camera follow
    interpTime += dt;
    const alpha = Math.max(0, Math.min(1, interpTime / SERVER_TICK_MS));

    const interPlayers = [];
    for (const pb of currentState.players) {
      const pa = lastState.players.find((x) => x.id === pb.id);
      interPlayers.push(lerpPlayer(pa, pb, alpha));
    }

    const meP = interPlayers.find(p => p.id === me);
    let camX = 0, camY = 0;
    if (meP) {
      camX = Math.max(0, Math.min(world.width - canvas.width, meP.x - canvas.width / 2));
      camY = Math.max(0, Math.min(world.height - canvas.height, meP.y - canvas.height / 2));
    }

    // Draw campus background
    drawBackground(camX, camY);

    // If bg not ready yet, ensure a base fill
    if (!bgReady) {
      ctx.fillStyle = '#0b0f14';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    for (const p of interPlayers) drawPlayer(p, camX, camY, p.id === me);

    requestAnimationFrame((t) => {
      const now = performance.now();
      render(now - (render.lastTime || now));
      render.lastTime = now;
    });
  }

  requestAnimationFrame((t) => { render.lastTime = t; render(16); });
})();
