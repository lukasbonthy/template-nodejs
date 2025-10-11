(() => {
  // ================== Socket.IO (force polling for school Wi-Fi) ==================
  const socket = io('/', {
    transports: ['polling'],
    upgrade: false,
    path: '/socket.io',
    withCredentials: true
  });

  // ================== DOM ==================
  const canvas   = document.getElementById('game');
  const ctx      = canvas.getContext('2d', { alpha: false });
  const statusEl = document.getElementById('status');

  const nameModal = document.getElementById('nameModal');
  const nameForm  = document.getElementById('nameForm');
  const nameInput = document.getElementById('nameInput');

  const chatForm  = document.getElementById('chatForm');
  const chatInput = document.getElementById('chatInput');

  const dpad = document.getElementById('dpad');

  // Helper: is the name modal open?
  function nameModalOpen() {
    return getComputedStyle(nameModal).display !== 'none';
  }

  // ================== Canvas sizing ==================
  function resize() {
    canvas.width  = Math.floor(window.innerWidth);
    canvas.height = Math.floor(window.innerHeight);
  }
  window.addEventListener('resize', resize, { passive: true });
  resize();

  // ================== World / State ==================
  let meId = null;
  let radius = 18;

  // Active world used for rendering/logic on the client
  let world = { width: 3200, height: 2000, obstacles: [], rooms: [] };

  // If campus.json loads, we keep it here so it can override any server defaults
  let campusWorld = null;

  // Toys list (server may override)
  let TOYS = ['bat','cake','pizza','mic','book','flag','laptop','ball','paint'];

  // Server snapshots for interpolation
  let lastState = { t: 0, players: [] };
  let currState = { t: 0, players: [] };
  let interpTime = 0;
  const SERVER_TICK_MS = 50;

  // Spaces
  let currentRoomId = null;
  let currentSubroomId = null;

  // Cameras
  let camX = 0, camY = 0;                 // campus camera
  let roomCamX = 0, roomCamY = 0;         // interior camera

  // Mouse + clicks (for hover, subroom dock, hotbar)
  let mouseX = 0, mouseY = 0;
  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouseX = (e.clientX - r.left) * (canvas.width / r.width);
    mouseY = (e.clientY - r.top)  * (canvas.height / r.height);
  });
  let clickZones = []; // {x,y,w,h,onClick, tag}
  canvas.addEventListener('click', (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = (e.clientX - r.left) * (canvas.width / r.width);
    const sy = (e.clientY - r.top)  * (canvas.height / r.height);
    for (const cz of clickZones) {
      if (sx >= cz.x && sx <= cz.x + cz.w && sy >= cz.y && sy <= cz.y + cz.h) {
        cz.onClick?.();
        break;
      }
    }
  });

  // ================== Connection status ==================
  const setStatus = (ok, msg) => {
    statusEl.textContent = (ok ? '🟢 ' : '🔴 ') + (msg || (ok ? 'Connected (polling)' : 'Disconnected'));
    statusEl.classList.toggle('ok', ok);
    statusEl.classList.toggle('err', !ok);
  };

  socket.on('connect', () => {
    setStatus(true, 'Connected (polling)');
    // Auto-join with saved name on every connect (fixes "everyone is Penguin")
    const saved = (localStorage.getItem('campusName') || '').trim();
    if (saved) {
      nameInput.value = saved;
      socket.emit('join', saved);
      nameModal.style.display = 'none';
    } else {
      nameModal.style.display = 'flex';
    }
  });
  socket.on('disconnect',   () => setStatus(false, 'Disconnected'));
  socket.on('connect_error',() => setStatus(false, 'Connect error'));

  // ================== Load campus.json (authoritative for map layout) ==================
  // If this loads, we prefer its obstacles/rooms over any server defaults.
  fetch('campus.json')
    .then(r => r.json())
    .then(j => {
      campusWorld = j;
      world = { ...world, ...j };
    })
    .catch(() => { /* ignore if missing */ });

  // ================== Input (keyboard + dpad) ==================
  const input = { up:false, down:false, left:false, right:false };
  const keyMap = new Map([
    ['ArrowUp','up'], ['KeyW','up'],
    ['ArrowDown','down'], ['KeyS','down'],
    ['ArrowLeft','left'], ['KeyA','left'],
    ['ArrowRight','right'], ['KeyD','right']
  ]);
  function sendInput(){ socket.emit('input', input); }

  document.addEventListener('keydown', (e) => {
    // Don't hijack keys while name modal is open
    if (nameModalOpen()) return;

    // Enter: attempt to enter building OR focus chat
    if (e.code === 'Enter' && document.activeElement !== chatInput) {
      if (!currentRoomId) {
        const rect = rectUnderMouse();
        if (rect) {
          const rm = roomForRect(rect);
          if (rm) {
            e.preventDefault();
            socket.emit('enterRoom', { roomId: rm.id });
            return;
          }
        }
      }
      chatInput.focus();
      return;
    }
    // Make chat capture clicks only while focused
    chatInput.addEventListener('focus', () => {
      chatForm.classList.add('open');
    });
    chatInput.addEventListener('blur', () => {
      chatForm.classList.remove('open');
    });
    chatInput.addEventListener('focus', () => chatForm.classList.add('open'));
    chatInput.addEventListener('blur',  () => chatForm.classList.remove('open'));

    // Space / E: USE toy
    if ((e.code === 'Space' || e.code === 'KeyE') && document.activeElement !== chatInput) {
      e.preventDefault();
      useToy();
      return;
    }

    // Escape / Q: leave room to campus
    if (e.code === 'Escape' || e.code === 'KeyQ') {
      socket.emit('leaveRoom');
      return;
    }

    // Digits:
    // - If in a room with subrooms: 0 = Lobby, 1..9 = subroom select
    // - Else: 0 = clear toy, 1..9 = equip toy
    if (e.key >= '0' && e.key <= '9') {
      const digit = Number(e.key);
      const room = currentRoomId ? getRoomById(currentRoomId) : null;
      const hasSubrooms = !!(room && room.subrooms && room.subrooms.length);
      e.preventDefault();
      if (hasSubrooms) {
        if (digit === 0) socket.emit('enterRoom', { roomId: room.id });
        else {
          const idx = digit - 1;
          const sr = room.subrooms[idx];
          if (sr) socket.emit('enterSubroom', { roomId: room.id, subroomId: sr.id });
        }
      } else {
        if (digit === 0) socket.emit('clearEquip');
        else {
          const kind = TOYS[digit - 1];
          if (kind) socket.emit('equipKind', { kind });
        }
      }
      return;
    }

    // Movement
    const dir = keyMap.get(e.code);
    if (dir) {
      if (!input[dir]) { input[dir] = true; sendInput(); }
      return;
    }
  });

  document.addEventListener('keyup', (e) => {
    const dir = keyMap.get(e.code);
    if (dir && input[dir]) { input[dir] = false; sendInput(); }
  });

  // D-pad (mouse + touch)
  if (dpad) {
    dpad.querySelectorAll('button').forEach(btn => {
      const dir = btn.dataset.dir;
      const on  = (ev) => { ev.preventDefault(); if (!input[dir]) { input[dir] = true; sendInput(); } };
      const off = (ev) => { ev.preventDefault(); if ( input[dir]) { input[dir] = false; sendInput(); } };
      btn.addEventListener('touchstart', on, { passive:false });
      btn.addEventListener('touchend',   off, { passive:false });
      btn.addEventListener('touchcancel',off, { passive:false });
      btn.addEventListener('mousedown',  on);
      btn.addEventListener('mouseup',    off);
      btn.addEventListener('mouseleave', off);
    });
  }

  // ================== Name join ==================
  // Show modal by default; auto-join will hide it on connect if a name is saved.
  nameModal.style.display = 'flex';
  nameInput.value = localStorage.getItem('campusName') || '';

  nameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    e.stopPropagation(); // avoid bubbling to document keydown
    const nm = (nameInput.value || '').trim();
    if (!nm) return;
    socket.emit('join', nm);                 // send name to server
    localStorage.setItem('campusName', nm);  // persist
    // Hide now; server will also confirm via 'profile'
    nameModal.style.display = 'none';
  });

  // Receive server confirmation of my profile (name)
  socket.on('profile', (p) => {
    if (!p || p.id !== meId) return;
    if (p.name) {
      localStorage.setItem('campusName', p.name);
      nameInput.value = p.name;
      nameModal.style.display = 'none';
    }
  });

  // ================== Chat ==================
  const CHAT_DURATION_MS = 5000;
  let localEcho = null; // show my chat instantly while waiting for echo back
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const txt = (chatInput.value || '').trim();
    if (txt.length) {
      socket.emit('chat', txt);
      localEcho = { text: txt, ts: Date.now() };
      chatInput.value = '';
    }
    chatInput.blur();
  });

  // ================== Clock sync (align animations across clients) ==================
  const clock = (() => {
    // Maintain rolling offset estimate: clientNow - serverNow
    const N = 20;
    const samples = [];
    let offsetMs = 0;
    function pushServerStamp(serverT) {
      if (typeof serverT !== 'number' || !isFinite(serverT)) return;
      const now = Date.now();
      const off = now - serverT;
      samples.push(off);
      if (samples.length > N) samples.shift();
      const sorted = samples.slice().sort((a,b)=>a-b);
      const mid = Math.floor(sorted.length/2);
      offsetMs = sorted.length ? (sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2) : off;
    }
    function toClientTime(serverTs) { return (serverTs ?? Date.now()) + offsetMs; }
    return { pushServerStamp, toClientTime };
  })();

  // ================== Server events ==================
  socket.on('init', (payload) => {
    meId = payload.id;
    radius = payload.radius || 18;

    // Merge worlds carefully:
    // - If campus.json loaded, we prefer its obstacles/rooms (fixes "custom buildings")
    // - We still accept width/height from the server if present.
    if (payload.world) {
      if (campusWorld) {
        const { width, height } = payload.world;
        world = {
          ...campusWorld,
          ...(typeof width === 'number' ? { width } : {}),
          ...(typeof height === 'number' ? { height } : {})
        };
      } else {
        // No campus.json yet → take server world for now (will be overridden once campus.json loads)
        world = { ...payload.world };
      }
    }

    if (Array.isArray(payload.toys)) TOYS = payload.toys;
  });

  socket.on('roomChanged', ({ roomId, subroomId }) => {
    currentRoomId = roomId || null;
    currentSubroomId = subroomId || null;
  });

  socket.on('state', (s) => {
    // s.t should be a server timestamp; use it for clock sync
    if (typeof s.t === 'number') clock.pushServerStamp(s.t);
    lastState = currState;
    currState = s;
    interpTime = 0;
  });

  // ================== Toys / Actions (synced animations) ==================
  const ACTION_DUR = { bat:350, cake:900, pizza:900, mic:1100, book:800, flag:800, laptop:800, ball:1100, paint:800 };
  const effects = []; // {id, kind, space, roomId, subroomId, origin, target, ts, aid?, authoritative?}

  const hits = []; // {victimId, fromId, space, roomId, subroomId, dir:{x,y}, ts}
  socket.on('hit', (h) => {
    if (typeof h.ts === 'number') h.ts = clock.toClientTime(h.ts);
    else h.ts = Date.now();
    hits.push(h);
  });

  function isHurt(id) {
    const now = Date.now();
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i];
      if (now - h.ts > 2200) { hits.splice(i,1); continue; }
      if (h.victimId === id && now - h.ts < 170) return true;
    }
    return false;
  }

  function lastHitOfMine() {
    for (let i = hits.length - 1; i >= 0; i--) {
      if (hits[i].victimId === meId) return hits[i];
    }
    return null;
  }

  function shakeOffset() {
    const h = lastHitOfMine();
    if (!h) return { x: 0, y: 0 };
    const t = Date.now() - h.ts;
    if (t > 160) return { x: 0, y: 0 };
    const a = (1 - t/160) * 6;
    return { x: Math.sin(t/20) * a, y: Math.cos(t/23) * a };
  }

  // Generate a local action id to de-dupe local echo vs server echo
  let aidSeq = 1;
  function newAid() { return `${meId || 'me'}-${Date.now()}-${aidSeq++}`; }

  function getMe() { return currState.players.find(p => p.id === meId); }

  function useToy() {
    const me = getMe();
    if (!me || !me.equippedKind) return;

    const kind = me.equippedKind;
    const inRoom = !!currentRoomId;
    const origin = inRoom ? { x: me.rx || 0, y: me.ry || 0 } : { x: me.x || 0, y: me.y || 0 };
    const target = inRoom
      ? { x: mouseX + roomCamX, y: mouseY + roomCamY }
      : { x: mouseX + camX,     y: mouseY + camY };
    const aid = newAid();

    // Local optimistic effect (instant feedback)
    effects.push({
      id: me.id, kind,
      space: inRoom ? 'room' : 'campus',
      roomId: currentRoomId || null,
      subroomId: currentSubroomId || null,
      origin, target,
      ts: Date.now(),
      aid,
      authoritative: false
    });

    socket.emit('action', { kind, target, aid });
  }

  // Right-click / context menu use
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); useToy(); });
  canvas.addEventListener('mouseup', (e) => { if (e.button === 2) useToy(); });

  socket.on('action', (e) => {
    const alignedTs = (typeof e.ts === 'number') ? clock.toClientTime(e.ts) : Date.now();

    if (e.id === meId) {
      let matched = null;
      if (e.aid) matched = effects.find(x => x.aid === e.aid && x.id === meId && x.kind === e.kind);
      if (!matched) {
        const near = effects
          .filter(x => x.id === meId && x.kind === e.kind && !x.authoritative)
          .sort((a,b)=>Math.abs(alignedTs - a.ts) - Math.abs(alignedTs - b.ts));
        if (near.length && Math.abs(alignedTs - near[0].ts) < 600) matched = near[0];
      }
      if (matched) {
        matched.space       = e.space;
        matched.roomId      = e.roomId || null;
        matched.subroomId   = e.subroomId || null;
        matched.origin      = e.origin || matched.origin;
        matched.target      = e.target || matched.target;
        matched.ts          = alignedTs;
        matched.authoritative = true;
        matched.aid         = e.aid || matched.aid;
        return;
      }
    }

    effects.push({
      id: e.id, kind: e.kind,
      space: e.space,
      roomId: e.roomId || null,
      subroomId: e.subroomId || null,
      origin: e.origin,
      target: e.target,
      ts: alignedTs,
      aid: e.aid,
      authoritative: true
    });
  });

  // ================== Helpers ==================
  function lerp(a,b,t){ return a + (b-a)*t; }
  function clamp(v,lo,hi){ return Math.max(lo, Math.min(hi, v)); }

  function interpPlayer(pa, pb, t) {
    if (!pa) return pb;
    if (!pb) return pa;
    if (pa.roomId !== pb.roomId || pa.subroomId !== pb.subroomId) return pb;
    return {
      id: pb.id, name: pb.name, color: pb.color,
      x: lerp(pa.x, pb.x, t), y: lerp(pa.y, pb.y, t),
      rx: lerp(pa.rx ?? pb.rx, pb.rx, t), ry: lerp(pa.ry ?? pb.ry, pb.ry, t),
      roomId: pb.roomId, subroomId: pb.subroomId,
      equippedKind: pb.equippedKind || null,
      chatText: pb.chatText, chatTs: pb.chatTs
    };
  }

  function getRoomById(id){
    return (world.rooms || []).find(r => r.id === id) || null;
  }

  // Map an obstacle rect to a room (by matching enter rect)
  function roomForRect(rect){
    return (world.rooms || []).find(r => r.enter &&
      r.enter.x === rect.x && r.enter.y === rect.y &&
      r.enter.w === rect.w && r.enter.h === rect.h) || null;
  }

  function rectUnderMouse(){
    const mxW = mouseX + camX;
    const myW = mouseY + camY;
    for (const o of (world.obstacles || [])) {
      if (mxW >= o.x && mxW <= o.x + o.w && myW >= o.y && myW <= o.y + o.h) return o;
    }
    return null;
  }

  function occupancyByRoom() {
    const m = new Map();
    for (const p of currState.players) {
      if (!p.roomId) continue;
      m.set(p.roomId, (m.get(p.roomId) || 0) + 1);
    }
    return m;
  }
  function occupancyBySubroom(roomId) {
    const m = new Map();
    for (const p of currState.players) {
      if (p.roomId !== roomId) continue;
      const key = p.subroomId || 'lobby';
      m.set(key, (m.get(key) || 0) + 1);
    }
    return m;
  }

  // ================== Drawing utilities ==================
  function drawCampusGrid() {
    const grid = 120;
    const startX = -((camX % grid) + grid) % grid;
    const startY = -((camY % grid) + grid) % grid;
    ctx.strokeStyle = '#0f1725';
    ctx.lineWidth = 1;
    for (let x = startX; x < canvas.width; x += grid) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke(); }
    for (let y = startY; y < canvas.height; y += grid) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); ctx.stroke(); }
  }

  function drawOccupancyBadge(x, y, count) {
    const txt = `👥 ${count}`;
    ctx.font = '600 12px Inter, "Apple Color Emoji", "Segoe UI Emoji", system-ui';
    const padX = 8, w = Math.ceil(ctx.measureText(txt).width) + padX*2, h = 20;
    ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#e8ecff'; ctx.textAlign = 'left'; ctx.fillText(txt, x + padX, y + h - 6);
  }

  function drawBuildingsAndHover() {
    const mxW = mouseX + camX, myW = mouseY + camY;
    const occ = occupancyByRoom();
    let hover = null;

    for (const o of (world.obstacles || [])) {
      const sx = Math.round(o.x - camX), sy = Math.round(o.y - camY);
      // body
      ctx.fillStyle = '#1d2536'; ctx.fillRect(sx, sy, o.w, o.h);
      ctx.strokeStyle = '#2f3c5a'; ctx.lineWidth = 2; ctx.strokeRect(sx, sy, o.w, o.h);
      // label
      ctx.fillStyle = '#aab6e5'; ctx.font = '600 14px Inter, sans-serif'; ctx.textAlign = 'center';
      (String(o.label || '')).split('\n').forEach((line, i) => {
        ctx.fillText(line, sx + o.w/2, sy + 18 + i*18);
      });
      // occupancy
      const rm = roomForRect(o);
      const count = rm ? (occ.get(rm.id) || 0) : 0;
      if (count > 0) drawOccupancyBadge(sx + o.w - 60, sy + 6, count);
      // hover detect
      if (mxW >= o.x && mxW <= o.x + o.w && myW >= o.y && myW <= o.y + o.h) hover = o;
    }

    if (hover) {
      const sx = Math.round(hover.x - camX), sy = Math.round(hover.y - camY);
      ctx.strokeStyle = '#67a8ff'; ctx.lineWidth = 3; ctx.strokeRect(sx-2, sy-2, hover.w+4, hover.h+4);
      // hint
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(canvas.width/2 - 280, 16, 560, 36);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.strokeRect(canvas.width/2 - 280, 16, 560, 36);
      ctx.fillStyle = '#e8ecff'; ctx.font = '600 14px Inter, sans-serif'; ctx.textAlign = 'center';
      const name = hover.label || 'Room';
      ctx.fillText(`Press Enter to enter ${name}`, canvas.width/2, 38);
    }
  }

  function drawAvatarAndName(x, y, name, color, isMe) {
    // shadow ring
    ctx.beginPath(); ctx.arc(x+2, y+2, radius+1, 0, Math.PI*2); ctx.fillStyle='rgba(0,0,0,0.25)'; ctx.fill();
    // body
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI*2);
    ctx.fillStyle = isMe ? '#ffffff' : (color || '#7dafff');
    ctx.fill();
    ctx.lineWidth = isMe ? 3 : 2;
    ctx.strokeStyle = isMe ? '#3b82f6' : '#111827';
    ctx.stroke();
    // name
    ctx.font='600 14px Inter, sans-serif'; ctx.textAlign='center';
    ctx.lineWidth = 4; ctx.strokeStyle='rgba(0,0,0,0.6)';
    ctx.strokeText(name, x, y - radius - 10);
    ctx.fillStyle='#e8ecff'; ctx.fillText(name, x, y - radius - 10);
  }

  function wrapLines(text, maxWidth) {
    ctx.font='600 14px Inter, "Apple Color Emoji", "Segoe UI Emoji", system-ui';
    const words = String(text||'').split(/\s+/);
    const lines = []; let line = '';
    for (const w of words) {
      const test = line ? (line + ' ' + w) : w;
      if (ctx.measureText(test).width <= maxWidth) line = test;
      else { if (line) lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    return lines.slice(0, 4);
  }

  function roundRect(x,y,w,h,r){ const rr=Math.min(r,w/2,h/2);
    ctx.beginPath(); ctx.moveTo(x+rr,y);
    ctx.arcTo(x+w,y,x+w,y+h,rr); ctx.arcTo(x+w,y+h,x,y+h,rr);
    ctx.arcTo(x,y+h,x,y,rr); ctx.arcTo(x,y,x+w,y,rr); ctx.closePath();
  }

  function drawChatBubble(px,py,text,alpha){
    ctx.save(); ctx.globalAlpha = Math.max(0,Math.min(1,alpha));
    const lines = wrapLines(text, 240), lh=18, padX=10, padY=8;
    const contentW = Math.ceil(Math.max(...lines.map(l=>ctx.measureText(l).width), 30));
    const contentH = lines.length * lh;
    const bw = contentW + padX*2, bh = contentH + padY*2;
    let bx = px + radius + 12, by = py - radius - Math.floor(bh/2);
    if (bx + bw > canvas.width - 8) bx = px - radius - 12 - bw;
    if (bx < 8) bx = 8;
    if (by < 8) by = 8;
    if (by + bh > canvas.height - 8) by = canvas.height - 8 - bh;

    ctx.fillStyle='rgba(16,20,32,0.92)'; ctx.strokeStyle='#2b3550'; ctx.lineWidth=2;
    roundRect(bx,by,bw,bh,10); ctx.fill(); ctx.stroke();
    const tailX = bx < px ? bx + bw : bx;
    const dir = (bx < px) ? 1 : -1;
    const tailY = Math.max(by+8, Math.min(by+bh-8, py-6));
    ctx.beginPath(); ctx.moveTo(tailX, tailY-6); ctx.lineTo(tailX+10*dir, py-4); ctx.lineTo(tailX, tailY+6); ctx.closePath(); ctx.fill();

    ctx.fillStyle='#e8ecff'; ctx.textAlign='left';
    let tx = bx + padX, ty = by + padY + 13;
    for (const l of lines) { ctx.fillText(l, tx, ty); ty += lh; }
    ctx.restore();
  }

  const TOY_EMOJI = { bat:'🏏', cake:'🎂', pizza:'🍕', mic:'🎤', book:'📕', flag:'🚩', laptop:'💻', ball:'⚽', paint:'🎨' };
  function drawHeldItem(kind, x, y) {
    if (!kind) return;
    const offR = radius + 6;
    let ix = x + offR, iy = y + 2;
    if (x > canvas.width - 120) ix = x - offR - 12;
    const emoji = TOY_EMOJI[kind] || '🧸';
    ctx.font = '24px "Apple Color Emoji", "Segoe UI Emoji", system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(emoji, ix, iy + 8);
  }

  function drawChatAt(x,y,p){
    const now = Date.now();
    let text = p.chatText, ts = p.chatTs;
    if (p.id === meId && localEcho) {
      if (!ts || localEcho.ts >= ts) { text = localEcho.text; ts = localEcho.ts; }
      if (now - localEcho.ts > 2000) localEcho = null;
    }
    if (text && ts && now - ts < CHAT_DURATION_MS) {
      const t = (now - ts) / CHAT_DURATION_MS;
      const alpha = t < 0.8 ? 1 : (1 - (t - 0.8) / 0.2);
      drawChatBubble(x, y, text, alpha);
    }
  }

  // ================== Room scene ==================
  function drawRoomGrid() {
    const grid = 100;
    const startX = -((roomCamX % grid) + grid) % grid;
    const startY = -((roomCamY % grid) + grid) % grid;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let x = startX; x < canvas.width; x += grid) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke(); }
    for (let y = startY; y < canvas.height; y += grid) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); ctx.stroke(); }
  }

  function drawDockItem(x, y, w, h, label, count, active, onClick) {
    ctx.fillStyle = active ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.35)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = active ? 'rgba(103,168,255,0.6)' : 'rgba(255,255,255,0.12)';
    ctx.strokeRect(x, y, w, h);
    ctx.font = '600 14px Inter, sans-serif'; ctx.textAlign='left'; ctx.fillStyle='#e8ecff';
    ctx.fillText(label, x + 12, y + 28);
    // count badge
    const txt = `👥 ${count}`; const padX=8;
    const bw = Math.ceil(ctx.measureText(txt).width) + padX*2; const bh = 20;
    const bx = x + w - bw - 8, by = y + (h - bh)/2;
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = '#e8ecff'; ctx.textAlign='left'; ctx.fillText(txt, bx + padX, by + bh - 6);

    clickZones.push({ x, y, w, h, onClick, tag: 'dock' });
  }

  function drawRoomScene(room) {
    const titleRoom = room.name;
    const interior = (() => {
      if (currentSubroomId) {
        const sr = (room.subrooms || []).find(s => s.id === currentSubroomId);
        if (sr) return sr.interior;
      }
      return room.interior;
    })();
    const iw = interior?.w || 1100, ih = interior?.h || 700;

    // bg + grid
    ctx.fillStyle = interior?.bg || '#1c2538';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    drawRoomGrid();

    // objects
    for (const o of (interior?.objects || [])) {
      const x = Math.round((o.x || 0) - roomCamX);
      const y = Math.round((o.y || 0) - roomCamY);
      const w = o.w || 100, h = o.h || 60;
      ctx.fillStyle = o.fill || 'rgba(255,255,255,0.1)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = o.stroke || 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h);
      if (o.label) {
        ctx.fillStyle = '#dbe3ff'; ctx.font='600 14px Inter, sans-serif'; ctx.textAlign='center';
        ctx.fillText(o.label, x + w/2, y + h/2 + 5);
      }
    }

    // Top bar
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, 0, canvas.width, 48);
    ctx.fillStyle = '#e8ecff'; ctx.font = '700 18px Inter, sans-serif'; ctx.textAlign = 'left';
    const srName = (() => {
      if (!currentSubroomId) return '';
      const sr = (room.subrooms || []).find(s => s.id === currentSubroomId);
      return sr ? ` → ${sr.name}` : '';
    })();
    ctx.fillText(`Inside: ${titleRoom}${srName}`, 16, 30);
    ctx.fillStyle = '#c8d0ff'; ctx.font = '600 14px Inter, sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('Esc/Q to exit • 0 Lobby • 1..9 Subrooms', canvas.width - 16, 30);

    // Dock (left)
    clickZones = clickZones.filter(z => z.tag !== 'dock'); // clear old dock zones
    const occ = occupancyBySubroom(room.id);
    const dockX = 16, dockY = 64, itemW = 220, itemH = 44, gap = 8;

    let y = dockY;
    // Lobby
    drawDockItem(dockX, y, itemW, itemH, '0. Lobby', occ.get('lobby') || 0, !currentSubroomId, () => {
      socket.emit('enterRoom', { roomId: room.id });
    });
    y += itemH + gap;
    // Subrooms
    for (let i = 0; i < (room.subrooms || []).length; i++) {
      const s = room.subrooms[i];
      drawDockItem(dockX, y, itemW, itemH, `${i+1}. ${s.name}`, occ.get(s.id) || 0, currentSubroomId === s.id, () => {
        socket.emit('enterSubroom', { roomId: room.id, subroomId: s.id });
      });
      y += itemH + gap;
    }

    return { iw, ih };
  }

  // ================== Action FX (draw) ==================
  function drawEffects(whichSpace){
    const now = Date.now();
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      const dur = ACTION_DUR[e.kind] || 800;
      const t = (now - e.ts) / dur;
      if (t >= 1) { effects.splice(i, 1); continue; }

      // Only draw effects for the space you're in
      if (whichSpace === 'campus' && e.space !== 'campus') continue;
      if (whichSpace === 'room') {
        if (e.space !== 'room') continue;
        if (e.roomId !== currentRoomId) continue;
        const myInSub = !!currentSubroomId, theirInSub = !!e.subroomId;
        if (myInSub !== theirInSub) continue;
        if (e.subroomId && e.subroomId !== currentSubroomId) continue;
      }

      // Screen coords
      const p = currState.players.find(p => p.id === e.id);
      let sx, sy, tx, ty;
      if (whichSpace === 'campus') {
        sx = (p ? p.x : e.origin.x) - camX; sy = (p ? p.y : e.origin.y) - camY;
        tx = e.target.x - camX;             ty = e.target.y - camY;
      } else {
        sx = (p ? p.rx : e.origin.x) - roomCamX; sy = (p ? p.ry : e.origin.y) - roomCamY;
        tx = e.target.x - roomCamX;             ty = e.target.y - roomCamY;
      }

      // Per-toy visuals
      switch (e.kind) {
        case 'bat': {
          const ang = Math.atan2(ty - sy, tx - sx);
          const sweep = Math.PI * 0.9;
          const start = ang - sweep * 0.6 + sweep * t;
          const end   = start + Math.PI * 0.35;
          ctx.save(); ctx.translate(sx, sy);
          ctx.beginPath(); ctx.arc(0, 0, radius + 14, start, end);
          ctx.lineWidth = 10; ctx.strokeStyle = `rgba(255,255,255,${0.35*(1-t)})`; ctx.stroke();
          ctx.restore();
          // smack sparkle
          ctx.font='18px "Apple Color Emoji","Segoe UI Emoji",system-ui'; ctx.textAlign='center';
          ctx.globalAlpha = 1 - t;
          ctx.fillText('💥', sx + Math.cos(ang)*(radius+18), sy + Math.sin(ang)*(radius+18));
          ctx.globalAlpha = 1;
          break;
        }
        case 'ball': {
          const dx = tx - sx, dy = ty - sy; const dist = Math.hypot(dx,dy) || 1;
          const travel = Math.min(dist, 900 * (now - e.ts) / 1000);
          const px = sx + dx/dist * travel, py = sy + dy/dist * travel;
          ctx.font='22px "Apple Color Emoji","Segoe UI Emoji",system-ui'; ctx.textAlign='center';
          ctx.fillText('⚽', px, py+8);
          ctx.globalAlpha = 0.5*(1-t); ctx.fillText('💨', sx-6, sy+10); ctx.globalAlpha=1;
          break;
        }
        case 'cake': case 'pizza': {
          const emoji = e.kind === 'cake' ? '🎂' : '🍕';
          const lift = 24 * t;
          ctx.font='22px "Apple Color Emoji","Segoe UI Emoji",system-ui'; ctx.textAlign='center';
          ctx.globalAlpha = 1 - t; ctx.fillText(emoji, sx+6, sy - radius - 12 - lift);
          ctx.fillText('✨', sx-10, sy - radius - 24 - lift*1.2);
          ctx.globalAlpha = 1;
          break;
        }
        case 'mic': {
          const lift=28*t; ctx.font='22px "Apple Color Emoji","Segoe UI Emoji",system-ui'; ctx.textAlign='center';
          ctx.globalAlpha=1-t; ctx.fillText(t<0.5?'🎵':'🎶', sx+10, sy - radius - 10 - lift); ctx.globalAlpha=1;
          break;
        }
        case 'flag': {
          const wob = Math.sin(t*Math.PI*2)*6; ctx.save(); ctx.translate(sx,sy); ctx.rotate(wob*Math.PI/180);
          ctx.font='22px "Apple Color Emoji","Segoe UI Emoji",system-ui'; ctx.textAlign='center';
          ctx.fillText('🚩', radius+12, 8); ctx.restore();
          break;
        }
        case 'book': {
          const lift=20*t; ctx.font='20px "Apple Color Emoji","Segoe UI Emoji",system-ui'; ctx.textAlign='center';
          ctx.globalAlpha=1-t; ctx.fillText('📖', sx + radius+10, sy + 6);
          ctx.fillText('✨', sx + radius+22, sy - 12 - lift);
          ctx.globalAlpha=1; break;
        }
        case 'laptop': {
          const s=1+0.25*Math.sin(t*Math.PI*2); ctx.save(); ctx.translate(sx+radius+12, sy+6); ctx.scale(s,s);
          ctx.font='20px "Apple Color Emoji","Segoe UI Emoji",system-ui'; ctx.textAlign='center'; ctx.fillText('💻', 0, 8);
          ctx.restore(); break;
        }
        case 'paint': {
          const r=8+24*t, a=1-t; ctx.beginPath(); ctx.arc(tx, ty, r, 0, Math.PI*2);
          ctx.fillStyle = `rgba(103,168,255,${a*0.35})`; ctx.fill();
          ctx.font='18px "Apple Color Emoji","Segoe UI Emoji",system-ui'; ctx.textAlign='center';
          ctx.globalAlpha=a; ctx.fillText('🎨', tx, ty+6); ctx.globalAlpha=1; break;
        }
      }
    }
  }

  // ================== Hotbar (toys) ==================
  function drawHotbar(myEquippedKind) {
    const items = TOYS;
    const pad = 10, slot = 40, gap = 8;
    const totalW = items.length * slot + (items.length - 1) * gap + pad * 2;
    const x = Math.floor((canvas.width - totalW) / 2);
    const y = canvas.height - 68;

    // frame
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x, y, totalW, 56);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.strokeRect(x, y, totalW, 56);

    // clear old hotbar zones
    clickZones = clickZones.filter(z => z.tag !== 'hotbar');

    let cx = x + pad;
    for (const kind of items) {
      const active = myEquippedKind === kind;
      ctx.fillStyle = active ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.04)';
      ctx.fillRect(cx, y + 8, slot, slot);
      ctx.strokeStyle = active ? 'rgba(103,168,255,0.8)' : 'rgba(255,255,255,0.12)';
      ctx.strokeRect(cx, y + 8, slot, slot);

      const emoji = (TOY_EMOJI[kind] || '🧸');
      ctx.font = '24px "Apple Color Emoji", "Segoe UI Emoji", system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(emoji, cx + slot/2, y + 8 + slot/2 + 8);

      clickZones.push({
        x: cx, y: y + 8, w: slot, h: slot, tag: 'hotbar',
        onClick: () => {
          const meP = currState.players.find(p => p.id === meId);
          const already = meP && meP.equippedKind === kind;
          if (already) socket.emit('clearEquip');
          else socket.emit('equipKind', { kind });
        }
      });

      cx += slot + gap;
    }

    // hint
    ctx.fillStyle = '#cbd5ff'; ctx.font = '600 12px Inter, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Right-click / Space / E to use • 0 clears • 1–9 equips (unless used for subrooms)', x + totalW/2, y - 6);
  }

  // ================== Render loop ==================
  function render(dt) {
    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0,0,canvas.width,canvas.height);

    interpTime += dt;
    const t = Math.max(0, Math.min(1, interpTime / SERVER_TICK_MS));

    // Interpolated players
    const players = [];
    for (const pb of currState.players) {
      const pa = lastState.players.find(p => p.id === pb.id);
      players.push(interpPlayer(pa, pb, t));
    }

    const me = players.find(p => p.id === meId);

    if (!currentRoomId) {
      // Campus camera follow (+ shake if hurt)
      if (me) {
        const sh = shakeOffset();
        camX = clamp(me.x - canvas.width / 2, 0, Math.max(0, (world.width || 3200) - canvas.width)) + sh.x;
        camY = clamp(me.y - canvas.height/ 2, 0, Math.max(0, (world.height|| 2000) - canvas.height)) + sh.y;
      } else { camX = 0; camY = 0; }

      drawCampusGrid();
      drawBuildingsAndHover();

      // draw players on campus
      for (const p of players) if (!p.roomId) {
        const x = Math.round(p.x - camX);
        const y = Math.round(p.y - camY);

        if (isHurt(p.id)) {
          ctx.beginPath();
          ctx.arc(x, y, radius + 8, 0, Math.PI*2);
          ctx.strokeStyle = 'rgba(255,80,80,0.75)';
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.save();
          ctx.globalCompositeOperation = 'multiply';
          ctx.fillStyle = 'rgba(255,80,80,0.25)';
          ctx.beginPath(); ctx.arc(x, y, radius+1, 0, Math.PI*2); ctx.fill();
          ctx.restore();
        }

        drawAvatarAndName(x, y, p.name, p.color, p.id === meId);
        drawHeldItem(p.equippedKind, x, y);
        drawChatAt(x, y, p);
      }

      drawEffects('campus');
      drawHotbar(me?.equippedKind || null);

    } else {
      const room = getRoomById(currentRoomId);
      const { iw, ih } = room ? drawRoomScene(room) : { iw:1100, ih:700 };

      if (me) {
        const sh = shakeOffset();
        roomCamX = clamp((me.rx || 0) - canvas.width/2, 0, Math.max(0, iw - canvas.width)) + sh.x;
        roomCamY = clamp((me.ry || 0) - canvas.height/2, 0, Math.max(0, ih - canvas.height)) + sh.y;
      } else { roomCamX = 0; roomCamY = 0; }

      for (const p of players) {
        if (p.roomId !== currentRoomId) continue;
        if (!!p.subroomId !== !!currentSubroomId) continue;
        if (p.subroomId && p.subroomId !== currentSubroomId) continue;
        const x = Math.round((p.rx || 0) - roomCamX);
        const y = Math.round((p.ry || 0) - roomCamY);

        if (isHurt(p.id)) {
          ctx.beginPath();
          ctx.arc(x, y, radius + 8, 0, Math.PI*2);
          ctx.strokeStyle = 'rgba(255,80,80,0.75)';
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.save();
          ctx.globalCompositeOperation = 'multiply';
          ctx.fillStyle = 'rgba(255,80,80,0.25)';
          ctx.beginPath(); ctx.arc(x, y, radius+1, 0, Math.PI*2); ctx.fill();
          ctx.restore();
        }

        drawAvatarAndName(x, y, p.name, p.color, p.id === meId);
        drawHeldItem(p.equippedKind, x, y);
        drawChatAt(x, y, p);
      }

      drawEffects('room');
      drawHotbar(me?.equippedKind || null);
    }

    requestAnimationFrame((now) => {
      const prev = render.last || now;
      render.last = now;
      render(now - prev);
    });
  }
  requestAnimationFrame((now) => { render.last = now; render(16); });

})();
