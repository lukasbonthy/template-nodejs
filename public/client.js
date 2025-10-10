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

  let lastState = { t: 0, players: [] };
  let currentState = { t: 0, players: [] };
  let interpTime = 0;
  const SERVER_TICK_MS = 50;

  const CHAT_DURATION_MS = 5000;
  let localEcho = null;

  // Interior state
  let currentRoom = null; // { id, name, interior{bg,objects[]}, ... } or null

  // Load campus layout
  fetch('campus.json').then(r => r.json()).then(json => { world = json; });

  const input = { up:false, down:false, left:false, right:false };
  const keys = new Map([
    ['ArrowUp','up'], ['KeyW','up'], ['ArrowDown','down'], ['KeyS','down'],
    ['ArrowLeft','left'], ['KeyA','left'], ['ArrowRight','right'], ['KeyD','right']
  ]);

  const setStatus = (ok,msg) => { statusEl.textContent = ok ? `🟢 ${msg||'Connected'}` : `🔴 ${msg||'Disconnected'}`; };
  socket.on('connect', ()=> setStatus(true,'Connected (polling)'));
  socket.on('disconnect', ()=> setStatus(false,'Disconnected'));
  socket.on('connect_error', ()=> setStatus(false,'Connect error'));

  function sendInput(){ if (currentRoom) return; socket.emit('input', input); }

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' && document.activeElement !== chatInput) { e.preventDefault(); chatInput.focus(); return; }
    if (e.code === 'KeyE') { tryEnterRoomUnderMe(); return; }
    if (e.code === 'Escape' || e.code === 'KeyQ') { leaveRoom(); return; }

    const dir = keys.get(e.code); if (!dir) return;
    if (!input[dir]) { input[dir] = true; sendInput(); }
  });
  document.addEventListener('keyup', (e) => {
    const dir = keys.get(e.code); if (!dir) return;
    if (input[dir]) { input[dir] = false; sendInput(); }
  });

  // D-pad (disabled while inside a room)
  dpad.querySelectorAll('button').forEach(btn => {
    const dir = btn.dataset.dir;
    const on  = (ev) => { ev.preventDefault(); if (currentRoom) return; if (!input[dir]) { input[dir] = true; sendInput(); } };
    const off = (ev) => { ev.preventDefault(); if (currentRoom) return; if (input[dir]) { input[dir] = false; sendInput(); } };
    btn.addEventListener('touchstart', on, { passive:false });
    btn.addEventListener('touchend',   off, { passive:false });
    btn.addEventListener('touchcancel',off, { passive:false });
    btn.addEventListener('mousedown', on);
    btn.addEventListener('mouseup',   off);
    btn.addEventListener('mouseleave',off);
  });

  // Join
  nameForm.addEventListener('submit', (e) => { e.preventDefault(); socket.emit('join', nameInput.value || ''); });
  nameInput.value = localStorage.getItem('campusName') || '';
  socket.on('init', (payload) => {
    me = payload.id; radius = payload.radius || 18;
    const val = nameInput.value.trim(); if (val) localStorage.setItem('campusName', val);
    nameModal.style.display = 'none';
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
  function lerpPlayer(pa,pb,t){ if(!pa) return pb; if(!pb) return pa;
    return { id: pb.id, name: pb.name, color: pb.color,
      x: lerp(pa.x,pb.x,t), y: lerp(pa.y,pb.y,t),
      chatText: pb.chatText, chatTs: pb.chatTs }; }

  function drawGrid(camX, camY){
    const grid = 120;
    ctx.lineWidth = 1;
    const startX = -((camX % grid) + grid) % grid;
    const startY = -((camY % grid) + grid) % grid;
    ctx.strokeStyle = '#0f1725';
    for (let x = startX; x < canvas.width; x += grid) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke(); }
    for (let y = startY; y < canvas.height; y += grid) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); ctx.stroke(); }
  }

  function drawBuildings(camX, camY){
    ctx.lineWidth = 2;
    for (const o of (world.obstacles || [])) {
      const sx = Math.round(o.x - camX);
      const sy = Math.round(o.y - camY);
      ctx.fillStyle = '#1d2536';
      ctx.fillRect(sx, sy, o.w, o.h);
      ctx.strokeStyle = '#2f3c5a';
      ctx.strokeRect(sx, sy, o.w, o.h);
      // label
      ctx.fillStyle = '#aab6e5';
      ctx.font = '600 14px Inter, sans-serif';
      ctx.textAlign = 'center';
      for (const [i,line] of String(o.label||'').split('\n').entries()) {
        ctx.fillText(line, sx + o.w/2, sy + 18 + i*18);
      }
    }
  }

  function drawPlayer(p, camX, camY, isMe){
    const x = Math.round(p.x - camX);
    const y = Math.round(p.y - camY);
    ctx.beginPath(); ctx.arc(x+2, y+2, radius+1, 0, Math.PI*2); ctx.fillStyle='rgba(0,0,0,0.25)'; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI*2);
    ctx.fillStyle = isMe ? '#ffffff' : p.color || '#7dafff'; ctx.fill();
    ctx.lineWidth = isMe ? 3 : 2; ctx.strokeStyle = isMe ? '#3b82f6' : '#111827'; ctx.stroke();
    ctx.font='600 14px Inter, sans-serif'; ctx.textAlign='center'; ctx.lineWidth = 4; ctx.strokeStyle='rgba(0,0,0,0.6)';
    ctx.strokeText(p.name, x, y - radius - 10); ctx.fillStyle='#e8ecff'; ctx.fillText(p.name, x, y - radius - 10);

    const now=Date.now();
    let text=p.chatText, ts=p.chatTs;
    if (isMe && localEcho) { if (!ts || localEcho.ts >= ts) { text=localEcho.text; ts=localEcho.ts; } if (now-localEcho.ts>2000) localEcho=null; }
    if (text && ts && now-ts<CHAT_DURATION_MS) {
      const t=(now-ts)/CHAT_DURATION_MS, alpha = t<0.8 ? 1 : (1-(t-0.8)/0.2);
      drawChatBubble(x,y,text,alpha);
    }
  }

  function wrapLines(text, maxWidth){
    const words = text.split(/\s+/), lines=[]; let line='';
    ctx.font='600 14px Inter, sans-serif';
    for (const w of words) {
      const test = line ? line+' '+w : w;
      if (ctx.measureText(test).width <= maxWidth) { line=test; }
      else { if (line) lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    return lines.slice(0,4);
  }
  function roundRect(x,y,w,h,r){ const rr = Math.min(r, w/2, h/2);
    ctx.beginPath(); ctx.moveTo(x+rr,y);
    ctx.arcTo(x+w,y,x+w,y+h,rr); ctx.arcTo(x+w,y+h,x,y+h,rr);
    ctx.arcTo(x,y+h,x,y,rr); ctx.arcTo(x,y,x+w,y,rr); ctx.closePath();
  }
  function drawChatBubble(px,py,text,alpha){
    ctx.save(); ctx.globalAlpha = Math.max(0,Math.min(1,alpha));
    const lines = wrapLines(text, 240), lh=18, padX=10, padY=8;
    const contentW = Math.ceil(Math.max(...lines.map(l=>ctx.measureText(l).width),30));
    const contentH = lines.length * lh;
    const bw = contentW + padX*2, bh = contentH + padY*2;
    let bx = px + radius + 12, by = py - radius - Math.floor(bh/2);
    if (bx + bw > canvas.width - 8) bx = px - radius - 12 - bw;
    if (bx < 8) bx=8; if (by<8) by=8; if (by+bh>canvas.height-8) by=canvas.height-8-bh;
    ctx.fillStyle='rgba(16,20,32,0.92)'; ctx.strokeStyle='#2b3550'; ctx.lineWidth=2; roundRect(bx,by,bw,bh,10); ctx.fill(); ctx.stroke();
    const tailX = bx < px ? bx + bw : bx, dir = (bx < px) ? 1 : -1, tailY = Math.max(by+8, Math.min(by+bh-8, py-6));
    ctx.beginPath(); ctx.moveTo(tailX, tailY-6); ctx.lineTo(tailX+10*dir, py-4); ctx.lineTo(tailX, tailY+6); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#e8ecff'; let tx=bx+padX, ty=by+padY+13; for (const l of lines){ ctx.fillText(l, tx, ty); ty += lh; }
    ctx.restore();
  }

  // ---------- Rooms ----------
  function hashHue(str) {
    let h = 0; for (let i=0;i<str.length;i++) { h = (h*31 + str.charCodeAt(i))|0; }
    return Math.abs(h) % 360;
  }
  function implicitRoomFromObstacle(o, idx) {
    const name = o.label || `Room ${idx+1}`;
    const hue = hashHue(name);
    return {
      id: `auto_${idx}`,
      name,
      enter: { x: o.x, y: o.y, w: o.w, h: o.h },
      interior: {
        bg: `hsl(${hue} 35% 20%)`,
        objects: [
          { type: 'rect', x: 40,  y: 60,  w: 280, h: 120, fill: `hsl(${(hue+20)%360} 35% 28%)`, label: 'Tables' },
          { type: 'rect', x: 360, y: 60,  w: 260, h: 160, fill: `hsl(${(hue+40)%360} 35% 28%)`, label: 'Desks' },
          { type: 'rect', x: 640, y: 240, w: 220, h: 160, fill: `hsl(${(hue+60)%360} 35% 28%)`, label: 'Area' }
        ]
      }
    };
  }
  function roomsMerged() {
    const explicit = Array.isArray(world.rooms) ? world.rooms : [];
    if (explicit.length) return explicit;
    // No explicit rooms -> every building is enterable
    return (world.obstacles || []).map(implicitRoomFromObstacle);
  }
  function roomAtPoint(px, py) {
    for (const rm of roomsMerged()) {
      const e = rm.enter;
      if (px >= e.x && px <= e.x + e.w && py >= e.y && py <= e.y + e.h) return rm;
    }
    return null;
  }
  function tryEnterRoomUnderMe(){
    if (!me) return;
    const meP = currentState.players.find(p=>p.id===me); if (!meP) return;
    const rm = roomAtPoint(meP.x, meP.y);
    if (rm) currentRoom = rm;
  }
  function leaveRoom(){ currentRoom = null; }

  function drawInteriorOverlay(){
    if (!currentRoom) return;
    // dim world
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0,0,canvas.width,canvas.height);

    const pad = 24, boxW = Math.min(canvas.width - pad*2, 980), boxH = Math.min(canvas.height - pad*2, 660);
    const bx = Math.floor((canvas.width - boxW)/2), by = Math.floor((canvas.height - boxH)/2);

    // room background
    ctx.fillStyle = currentRoom.interior?.bg || '#1c2538';
    roundRect(bx, by, boxW, boxH, 16); ctx.fill();

    // title bar
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(bx, by, boxW, 44);
    ctx.fillStyle = '#e8ecff'; ctx.font='700 16px Inter, sans-serif'; ctx.textAlign='left';
    ctx.fillText(currentRoom.name, bx + 16, by + 28);

    // objects
    const objs = currentRoom.interior?.objects || [];
    for (const o of objs) {
      const rx = bx + o.x, ry = by + o.y, rw = o.w, rh = o.h;
      ctx.fillStyle = o.fill || 'rgba(255,255,255,0.1)'; ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = o.stroke || 'rgba(0,0,0,0.3)'; ctx.lineWidth = 2; ctx.strokeRect(rx, ry, rw, rh);
      if (o.label) { ctx.fillStyle = '#dbe3ff'; ctx.font = '600 14px Inter, sans-serif'; ctx.textAlign='center';
        ctx.fillText(o.label, rx + rw/2, ry + rh/2 + 5); }
    }

    // leave hint
    ctx.fillStyle='#c8d0ff'; ctx.font='600 13px Inter, sans-serif'; ctx.textAlign='right';
    ctx.fillText('Press Esc or Q to leave', bx + boxW - 14, by + boxH - 14);
  }

  // ---------- Render loop ----------
  function render(dt){
    // clear
    ctx.fillStyle = '#0b0f14'; ctx.fillRect(0,0,canvas.width,canvas.height);

    interpTime += dt; const t = Math.max(0, Math.min(1, interpTime / SERVER_TICK_MS));

    const interPlayers = []; for (const pb of currentState.players) { const pa = lastState.players.find(x=>x.id===pb.id); interPlayers.push(lerpPlayer(pa,pb,t)); }

    // camera follows me
    const meP = interPlayers.find(p=>p.id===me);
    let camX=0, camY=0;
    if (meP) { camX = clamp(meP.x - canvas.width/2, 0, (world.width||3200) - canvas.width); camY = clamp(meP.y - canvas.height/2, 0, (world.height||2000) - canvas.height); }

    drawGrid(camX, camY);
    drawBuildings(camX, camY);

    // “Press E” hint if standing on an enterable rectangle
    if (meP && !currentRoom) {
      const rm = roomAtPoint(meP.x, meP.y);
      if (rm) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(canvas.width/2 - 200, 18, 400, 34);
        ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.strokeRect(canvas.width/2 - 200, 18, 400, 34);
        ctx.fillStyle = '#e8ecff'; ctx.font = '600 14px Inter, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(`Press E to enter ${rm.name}`, canvas.width/2, 40);
      }
    }

    for (const p of interPlayers) drawPlayer(p, camX, camY, p.id === me);

    // interior overlay
    drawInteriorOverlay();

    requestAnimationFrame((now)=>{ const prev = render.lastTime || now; render.lastTime = now; render(now - prev); });
  }
  requestAnimationFrame((now)=>{ render.lastTime = now; render(16); });
})();
