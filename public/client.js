(() => {
  // Force polling so it works on school Wi-Fi that blocks websockets
  const socket = io('/', { transports: ['polling'], upgrade: false, path: '/socket.io', withCredentials: true });

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });
  function resize(){ canvas.width = Math.floor(window.innerWidth); canvas.height = Math.floor(window.innerHeight); }
  window.addEventListener('resize', resize); resize();

  const statusEl = document.getElementById('status');
  const nameModal = document.getElementById('nameModal');
  const nameForm  = document.getElementById('nameForm');
  const nameInput = document.getElementById('nameInput');
  const dpad      = document.getElementById('dpad');
  const chatForm  = document.getElementById('chatForm');
  const chatInput = document.getElementById('chatInput');

  let me = null, radius = 18;
  let world = { width: 3200, height: 2000, obstacles: [], rooms: [] };
  let TOYS = ['bat','cake','pizza','mic','book','flag','laptop','ball','paint']; // server overwrites via init

  let lastState = { t: 0, players: [] };
  let currentState = { t: 0, players: [] };
  let interpTime = 0;
  const SERVER_TICK_MS = 50;

  const CHAT_DURATION_MS = 5000;
  let localEcho = null;

  // Cameras
  let camX = 0, camY = 0;          // campus
  let roomCamX = 0, roomCamY = 0;  // room/subroom

  // Mouse hover (for buildings + hotbar clicks)
  let mouseX = 0, mouseY = 0;
  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouseX = (e.clientX - r.left) * (canvas.width / r.width);
    mouseY = (e.clientY - r.top)  * (canvas.height / r.height);
  });

  // Click handling (subroom dock + hotbar)
  let clickable = []; // [{x,y,w,h, onClick}]
  canvas.addEventListener('click', (e) => {
    const r = canvas.getBoundingClientRect();
    const sx = (e.clientX - r.left) * (canvas.width / r.width);
    const sy = (e.clientY - r.top)  * (canvas.height / r.height);
    for (const c of clickable) {
      if (sx >= c.x && sx <= c.x + c.w && sy >= c.y && sy <= c.y + c.h) {
        c.onClick?.();
        break;
      }
    }
  });

  // Current space
  let currentRoomId = null;
  let currentSubroomId = null;

  // Load layout fallback (server sends rooms in init anyway)
  fetch('campus.json').then(r => r.json()).then(json => { world = { ...world, ...json }; });

  // Input state
  const input = { up:false, down:false, left:false, right:false };
  const keys = new Map([
    ['ArrowUp','up'], ['KeyW','up'], ['ArrowDown','down'], ['KeyS','down'],
    ['ArrowLeft','left'], ['KeyA','left'], ['ArrowRight','right'], ['KeyD','right']
  ]);

  const setStatus = (ok,msg) => { statusEl.textContent = ok ? `🟢 ${msg||'Connected'}` : `🔴 ${msg||'Disconnected'}`; };
  socket.on('connect', ()=> setStatus(true,'Connected (polling)'));
  socket.on('disconnect', ()=> setStatus(false,'Disconnected'));
  socket.on('connect_error', ()=> setStatus(false,'Connect error'));

  function sendInput(){ socket.emit('input', input); }

  document.addEventListener('keydown', (e) => {
    // ENTER: enter hovered building on campus (else focus chat)
    if (e.code === 'Enter' && document.activeElement !== chatInput) {
      if (!currentRoomId) {
        const rect = rectUnderMouse();
        if (rect) {
          const room = roomForRect(rect);
          if (room) { e.preventDefault(); socket.emit('enterRoom', { roomId: room.id }); }
          return;
        }
      }
      chatInput.focus(); return;
    }

    if (e.code === 'Escape' || e.code === 'KeyQ') { socket.emit('leaveRoom'); return; }

    // Movement
    const dir = keys.get(e.code);
    if (dir) { if (!input[dir]) { input[dir] = true; sendInput(); } return; }
  });
  document.addEventListener('keyup', (e) => {
    const dir = keys.get(e.code); if (!dir) return;
    if (input[dir]) { input[dir] = false; sendInput(); }
  });

  // D-pad
  dpad.querySelectorAll('button').forEach(btn => {
    const dir = btn.dataset.dir;
    const on  = (ev) => { ev.preventDefault(); if (!input[dir]) { input[dir] = true; sendInput(); } };
    const off = (ev) => { ev.preventDefault(); if (input[dir]) { input[dir] = false; sendInput(); } };
    btn.addEventListener('touchstart', on, { passive:false });
    btn.addEventListener('touchend',   off, { passive:false });
    btn.addEventListener('touchcancel',off, { passive:false });
    btn.addEventListener('mousedown', on);
    btn.addEventListener('mouseup',   off);
    btn.addEventListener('mouseleave',off);
  });

  // Join / init
  nameForm.addEventListener('submit', (e) => { e.preventDefault(); socket.emit('join', nameInput.value || ''); });
  nameInput.value = localStorage.getItem('campusName') || '';
  socket.on('init', (payload) => {
    me = payload.id;
    radius = payload.radius || 18;
    world = { ...world, ...payload.world }; // authoritative rooms with subrooms
    if (Array.isArray(payload.toys)) TOYS = payload.toys;
    const val = nameInput.value.trim(); if (val) localStorage.setItem('campusName', val);
    nameModal.style.display = 'none';
  });

  socket.on('roomChanged', ({ roomId, subroomId }) => {
    currentRoomId = roomId || null;
    currentSubroomId = subroomId || null;
  });

  // Chat
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (text.length) { socket.emit('chat', text); localEcho = { text, ts: Date.now() }; chatInput.value = ''; }
    chatInput.blur();
  });

  socket.on('state', (s) => { lastState = currentState; currentState = s; interpTime = 0; });

  // ---------- Helpers ----------
  function lerp(a,b,t){ return a + (b-a)*t; }
  function clamp(v,lo,hi){ return Math.max(lo, Math.min(hi, v)); }
  function lerpPlayer(pa,pb,t){
    if (!pa) return pb; if (!pb) return pa;
    if (pa.roomId !== pb.roomId || pa.subroomId !== pb.subroomId) return pb; // snap on space change
    return {
      id: pb.id, name: pb.name, color: pb.color,
      x: lerp(pa.x, pb.x, t), y: lerp(pa.y, pb.y, t),
      rx: lerp(pa.rx ?? pb.rx, pb.rx, t), ry: lerp(pa.ry ?? pb.ry, pb.ry, t),
      roomId: pb.roomId, subroomId: pb.subroomId,
      equippedKind: pb.equippedKind || null,
      chatText: pb.chatText, chatTs: pb.chatTs
    };
  }

  function getRoomById(id){ return (world.rooms || []).find(r => r.id === id) || null; }
  function roomForRect(rect){
    return (world.rooms || []).find(r => r.enter &&
      r.enter.x === rect.x && r.enter.y === rect.y &&
      r.enter.w === rect.w && r.enter.h === rect.h) || null;
  }

  // Occupancy
  function occupancyByRoom() {
    const map = new Map();
    for (const p of currentState.players) {
      if (!p.roomId) continue;
      map.set(p.roomId, (map.get(p.roomId) || 0) + 1);
    }
    return map;
  }
  function occupancyBySubroom(roomId) {
    const map = new Map();
    for (const p of currentState.players) {
      if (p.roomId !== roomId) continue;
      const key = p.subroomId || 'lobby';
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  }

  // Drawing (Campus)
  function drawGridCampus(){
    const grid = 120;
    const startX = -((camX % grid) + grid) % grid;
    const startY = -((camY % grid) + grid) % grid;
    ctx.strokeStyle = '#0f1725'; ctx.lineWidth = 1;
    for (let x = startX; x < canvas.width; x += grid) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke(); }
    for (let y = startY; y < canvas.height; y += grid) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); ctx.stroke(); }
  }

  function drawOccupancyBadge(x, y, count) {
    const txt = `👥 ${count}`;
    ctx.font = '600 12px Inter, "Apple Color Emoji", "Segoe UI Emoji", system-ui';
    const padX = 8, padY = 4;
    const w = Math.ceil(ctx.measureText(txt).width) + padX*2;
    const h = 20;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#e8ecff';
    ctx.textAlign = 'left';
    ctx.fillText(txt, x + padX, y + h - 6);
  }

  function drawBuildingsAndHover(){
    const mxW = mouseX + camX, myW = mouseY + camY;
    let hover = null;
    const occ = occupancyByRoom();

    ctx.lineWidth = 2;
    for (const o of (world.obstacles || [])) {
      const sx = Math.round(o.x - camX), sy = Math.round(o.y - camY);
      ctx.fillStyle = '#1d2536'; ctx.fillRect(sx, sy, o.w, o.h);
      ctx.strokeStyle = '#2f3c5a'; ctx.strokeRect(sx, sy, o.w, o.h);

      // label
      ctx.fillStyle = '#aab6e5'; ctx.font = '600 14px Inter, sans-serif'; ctx.textAlign = 'center';
      for (const [i,line] of String(o.label||'').split('\n').entries()) {
        ctx.fillText(line, sx + o.w/2, sy + 18 + i*18);
      }

      // occupancy
      const rm = roomForRect(o);
      const count = rm ? (occ.get(rm.id) || 0) : 0;
      if (count > 0) drawOccupancyBadge(sx + o.w - 60, sy + 6, count);

      // hover detection
      if (mxW >= o.x && mxW <= o.x + o.w && myW >= o.y && myW <= o.y + o.h) hover = o;
    }

    if (hover) {
      const sx = Math.round(hover.x - camX), sy = Math.round(hover.y - camY);
      ctx.lineWidth = 3; ctx.strokeStyle = '#67a8ff';
      ctx.strokeRect(sx-2, sy-2, hover.w+4, hover.h+4);

      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(canvas.width/2 - 260, 16, 520, 36);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.strokeRect(canvas.width/2 - 260, 16, 520, 36);
      ctx.fillStyle = '#e8ecff'; ctx.font = '600 14px Inter, sans-serif'; ctx.textAlign = 'center';
      const name = hover.label || 'Room';
      ctx.fillText(`Press Enter to enter ${name}`, canvas.width/2, 38);
    }
    return hover;
  }

  // Drawing (Players + Chat + Toys)
  function drawAvatarAndName(x, y, name, color, isMe){
    ctx.beginPath(); ctx.arc(x+2, y+2, radius+1, 0, Math.PI*2); ctx.fillStyle='rgba(0,0,0,0.25)'; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI*2);
    ctx.fillStyle = isMe ? '#ffffff' : (color || '#7dafff'); ctx.fill();
    ctx.lineWidth = isMe ? 3 : 2; ctx.strokeStyle = isMe ? '#3b82f6' : '#111827'; ctx.stroke();
    ctx.font='600 14px Inter, sans-serif'; ctx.textAlign='center'; ctx.lineWidth='4'; ctx.strokeStyle='rgba(0,0,0,0.6)';
    ctx.strokeText(name, x, y - radius - 10); ctx.fillStyle='#e8ecff'; ctx.fillText(name, x, y - radius - 10);
  }
  function wrapLines(text, maxWidth){
    const words = text.split(/\s+/), lines=[]; let line='';
    ctx.font='600 14px Inter, "Apple Color Emoji", "Segoe UI Emoji", system-ui';
    for (const w of words) { const test = line ? line+' '+w : w;
      if (ctx.measureText(test).width <= maxWidth) { line=test; } else { if (line) lines.push(line); line = w; } }
    if (line) lines.push(line); return lines.slice(0,4);
  }
  function roundRect(x,y,w,h,r){ const rr=Math.min(r,w/2,h/2);
    ctx.beginPath(); ctx.moveTo(x+rr,y);
    ctx.arcTo(x+w,y,x+w,y+h,rr); ctx.arcTo(x+w,y+h,x,y+h,rr);
    ctx.arcTo(x,y+h,x,y,rr); ctx.arcTo(x,y,x+w,y,rr); ctx.closePath();
  }
  function drawChatBubble(px,py,text,alpha){
    ctx.save(); ctx.globalAlpha=Math.max(0,Math.min(1,alpha));
    const lines=wrapLines(text,240), lh=18, padX=10, padY=8;
    const contentW=Math.ceil(Math.max(...lines.map(l=>ctx.measureText(l).width),30));
    const contentH=lines.length*lh;
    const bw=contentW+padX*2, bh=contentH+padY*2;
    let bx=px+radius+12, by=py-radius-Math.floor(bh/2);
    if (bx+bw>canvas.width-8) bx=px-radius-12-bw;
    if (bx<8) bx=8; if (by<8) by=8; if (by+bh>canvas.height-8) by=canvas.height-8-bh;
    ctx.fillStyle='rgba(16,20,32,0.92)'; ctx.strokeStyle='#2b3550'; ctx.lineWidth=2; roundRect(bx,by,bw,bh,10); ctx.fill(); ctx.stroke();
    const tailX = bx<px ? bx+bw : bx, dir = (bx<px)?1:-1, tailY = Math.max(by+8, Math.min(by+bh-8, py-6));
    ctx.beginPath(); ctx.moveTo(tailX, tailY-6); ctx.lineTo(tailX+10*dir, py-4); ctx.lineTo(tailX, tailY+6); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#e8ecff'; let tx=bx+padX, ty=by+padY+13; for (const l of lines){ ctx.fillText(l, tx, ty); ty+=lh; }
    ctx.restore();
  }
  function drawChatAt(x,y,p){
    const now=Date.now(); let text=p.chatText, ts=p.chatTs;
    if (p.id===me && localEcho) { if (!ts || localEcho.ts >= ts) { text=localEcho.text; ts=localEcho.ts; } if (now-localEcho.ts>2000) localEcho=null; }
    if (text && ts && now-ts<CHAT_DURATION_MS) {
      const t=(now-ts)/CHAT_DURATION_MS, alpha=t<0.8?1:(1-(t-0.8)/0.2); drawChatBubble(x,y,text,alpha);
    }
  }

  // --- TOYS ---
  const TOY_EMOJI = {
    bat: '🏏', cake: '🎂', pizza: '🍕', mic: '🎤', book: '📕', flag: '🚩', laptop: '💻', ball: '⚽', paint: '🎨'
  };
  function drawHeldItem(kind, x, y, isMe){
    if (!kind) return;
    const offR = radius + 6;
    // place to the right of avatar; if near right edge, flip to left
    let ix = x + offR, iy = y + 2;
    if (x > canvas.width - 120) ix = x - offR - 12;

    // Emoji toys
    if (TOY_EMOJI[kind]) {
      ctx.font = '24px "Apple Color Emoji", "Segoe UI Emoji", system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(TOY_EMOJI[kind], ix, iy + 8);
      return;
    }
    // fallback bat drawing
    if (kind === 'bat') {
      ctx.save();
      ctx.translate(ix, iy);
      ctx.rotate(-0.6);
      ctx.fillStyle = '#a0713d'; roundRect(-4, -20, 8, 40, 4); ctx.fill();
      ctx.fillStyle = '#c58a4a'; roundRect(-6, -8, 12, 20, 6); ctx.fill();
      ctx.restore();
    }
  }

  // Hotbar
  function drawHotbar(myEquipped){
    // bottom-center bar
    const items = TOYS;
    const pad = 10, slot = 40, gap = 8;
    const totalW = items.length * slot + (items.length - 1) * gap + pad*2;
    const x = Math.floor((canvas.width - totalW)/2);
    const y = canvas.height - 68;

    // frame
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x, y, totalW, 56);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.strokeRect(x, y, totalW, 56);

    clickable = clickable.filter(c => !c._hotbar); // remove old hotbar clicks

    let cx = x + pad;
    for (const kind of items) {
      const isActive = myEquipped === kind;
      // slot bg
      ctx.fillStyle = isActive ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.04)';
      ctx.fillRect(cx, y + 8, slot, slot);
      ctx.strokeStyle = isActive ? 'rgba(103,168,255,0.8)' : 'rgba(255,255,255,0.12)';
      ctx.strokeRect(cx, y + 8, slot, slot);
      // icon
      const emoji = TOY_EMOJI[kind] || '🧸';
      ctx.font = '24px "Apple Color Emoji", "Segoe UI Emoji", system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(emoji, cx + slot/2, y + 8 + slot/2 + 8);

      clickable.push({ x: cx, y: y + 8, w: slot, h: slot, onClick: () => {
        const meP = currentState.players.find(p=>p.id===me);
        const already = meP?.equippedKind === kind;
        if (already) socket.emit('clearEquip'); else socket.emit('equipKind', { kind });
      }, _hotbar: true });

      cx += slot + gap;
    }

    // hint
    ctx.fillStyle = '#cbd5ff'; ctx.font = '600 12px Inter, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('Click a toy to hold it • Click again to put it away', x + totalW/2, y - 6);
  }

  function rectUnderMouse(){
    const mxW = mouseX + camX, myW = mouseY + camY;
    for (const o of (world.obstacles || [])) {
      if (mxW >= o.x && mxW <= o.x + o.w && myW >= o.y && myW <= o.y + o.h) return o;
    }
    return null;
  }

  // Room UI
  function drawGridRoom(iw, ih){
    const grid = 100;
    const startX = -((roomCamX % grid) + grid) % grid;
    const startY = -((roomCamY % grid) + grid) % grid;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    for (let x = startX; x < canvas.width; x += grid) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke(); }
    for (let y = startY; y < canvas.height; y += grid) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); ctx.stroke(); }
  }

  function drawDockItem(x, y, w, h, label, count, active, onClick){
    ctx.fillStyle = active ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.35)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = active ? 'rgba(103,168,255,0.6)' : 'rgba(255,255,255,0.12)';
    ctx.strokeRect(x, y, w, h);
    ctx.font = '600 14px Inter, sans-serif'; ctx.textAlign='left'; ctx.fillStyle='#e8ecff';
    ctx.fillText(label, x + 12, y + 28);
    const txt = `👥 ${count}`; const padX=8; const bw = Math.ceil(ctx.measureText(txt).width) + padX*2; const bh = 20;
    const bx = x + w - bw - 8, by = y + (h - bh)/2;
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = '#e8ecff'; ctx.textAlign='left'; ctx.fillText(txt, bx + padX, by + bh - 6);

    clickable.push({ x, y, w, h, onClick });
  }

  function occupancyBySubroom(roomId) {
    const map = new Map();
    for (const p of currentState.players) {
      if (p.roomId !== roomId) continue;
      const key = p.subroomId || 'lobby';
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  }

  function drawRoomScene(rm){
    const iw = rm.interior?.w || 1100, ih = rm.interior?.h || 700;
    ctx.fillStyle = rm.interior?.bg || '#1c2538'; ctx.fillRect(0,0,canvas.width,canvas.height);
    drawGridRoom(iw, ih);

    // objects
    for (const o of (rm.interior?.objects || [])) {
      const x = Math.round((o.x || 0) - roomCamX), y = Math.round((o.y || 0) - roomCamY);
      const w = o.w || 100, h = o.h || 60;
      ctx.fillStyle = o.fill || 'rgba(255,255,255,0.1)'; ctx.fillRect(x,y,w,h);
      ctx.strokeStyle = o.stroke || 'rgba(0,0,0,0.25)'; ctx.lineWidth=2; ctx.strokeRect(x,y,w,h);
      if (o.label) { ctx.fillStyle='#dbe3ff'; ctx.font='600 14px Inter, sans-serif'; ctx.textAlign='center';
        ctx.fillText(o.label, x + w/2, y + h/2 + 5); }
    }

    // top bar
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, 0, canvas.width, 48);
    ctx.fillStyle = '#e8ecff'; ctx.font = '700 18px Inter, sans-serif'; ctx.textAlign='left';
    const sr = currentSubroomId ? (rm.subrooms || []).find(s => s.id === currentSubroomId) : null;
    ctx.fillText(`Inside: ${rm.name}${sr ? ' → ' + sr.name : ''}`, 16, 30);
    ctx.fillStyle = '#c8d0ff'; ctx.font = '600 14px Inter, sans-serif'; ctx.textAlign='right';
    ctx.fillText('Esc/Q to exit room • 0 = Lobby • 1..9 = Subrooms', canvas.width - 16, 30);

    // Subroom dock (left)
    clickable = clickable.filter(c => !c._dock && !c._hotbar); // keep hotbar entries; clear old dock
    const occ = occupancyBySubroom(rm.id); // keys: 'lobby' or subroomId
    const dockX = 16, dockY = 64, itemW = 220, itemH = 44, gap = 8;

    // Lobby item (0)
    let y = dockY;
    drawDockItem(dockX, y, itemW, itemH, '0. Lobby', occ.get('lobby') || 0, !currentSubroomId, () => {
      socket.emit('enterRoom', { roomId: rm.id });
    });
    y += itemH + gap;

    // Subrooms (1..9)
    for (let i=0;i<(rm.subrooms||[]).length;i++) {
      const s = rm.subrooms[i];
      drawDockItem(dockX, y, itemW, itemH, `${i+1}. ${s.name}`, occ.get(s.id) || 0, currentSubroomId === s.id, () => {
        socket.emit('enterSubroom', { roomId: rm.id, subroomId: s.id });
      });
      y += itemH + gap;
    }
  }

  // ---------- Render loop ----------
  function render(dt){
    ctx.fillStyle = '#0b0f14'; ctx.fillRect(0,0,canvas.width,canvas.height);
    interpTime += dt; const t = Math.max(0, Math.min(1, interpTime / SERVER_TICK_MS));

    // Interpolated players
    const interPlayers = [];
    for (const pb of currentState.players) {
      const pa = lastState.players.find(x=>x.id===pb.id);
      interPlayers.push(lerpPlayer(pa, pb, t));
    }
    const meP = interPlayers.find(p=>p.id===me);

    if (!currentRoomId) {
      // Campus
      if (meP) {
        camX = clamp(meP.x - canvas.width/2, 0, (world.width||3200) - canvas.width);
        camY = clamp(meP.y - canvas.height/2, 0, (world.height||2000) - canvas.height);
      } else { camX = camY = 0; }

      drawGridCampus();
      drawBuildingsAndHover();
      for (const p of interPlayers) if (!p.roomId) {
        const x = Math.round(p.x - camX), y = Math.round(p.y - camY);
        drawAvatarAndName(x, y, p.name, p.color, p.id === me);
        drawHeldItem(p.equippedKind, x, y, p.id === me);
        drawChatAt(x, y, p);
      }

      // Hotbar (always visible)
      drawHotbar(meP?.equippedKind || null);

    } else {
      // Inside room or subroom
      const rm = getRoomById(currentRoomId);
      const targetInterior = (() => {
        if (!rm) return null;
        if (currentSubroomId) {
          const sr = (rm.subrooms || []).find(s => s.id === currentSubroomId);
          if (sr) return sr.interior;
        }
        return rm.interior;
      })();

      const iw = targetInterior?.w || 1100, ih = targetInterior?.h || 700;
      if (meP) {
        roomCamX = clamp((meP.rx||0) - canvas.width/2, 0, Math.max(0, iw - canvas.width));
        roomCamY = clamp((meP.ry||0) - canvas.height/2, 0, Math.max(0, ih - canvas.height));
      } else { roomCamX = roomCamY = 0; }

      // Draw room scene + dock
      const drawRm = { ...rm, interior: targetInterior, name: rm?.name, subrooms: rm?.subrooms || [] };
      if (drawRm) drawRoomScene(drawRm);

      // Players in this exact space
      for (const p of interPlayers) {
        if (p.roomId !== currentRoomId) continue;
        if (!!p.subroomId !== !!currentSubroomId) continue;
        if (p.subroomId && p.subroomId !== currentSubroomId) continue;
        const x = Math.round((p.rx || 0) - roomCamX), y = Math.round((p.ry || 0) - roomCamY);
        drawAvatarAndName(x, y, p.name, p.color, p.id === me);
        drawHeldItem(p.equippedKind, x, y, p.id === me);
        drawChatAt(x, y, p);
      }

      // Hotbar also visible inside rooms
      drawHotbar(meP?.equippedKind || null);
    }

    requestAnimationFrame((now)=>{ const prev = render.lastTime || now; render.lastTime = now; render(now - prev); });
  }
  requestAnimationFrame((now)=>{ render.lastTime = now; render(16); });
})();
