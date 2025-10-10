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

  // Camera
  let camX = 0, camY = 0;
  let roomCamX = 0, roomCamY = 0;

  // Mouse hover (screen coords -> world coords)
  let mouseX = 0, mouseY = 0;
  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouseX = (e.clientX - r.left) * (canvas.width / r.width);
    mouseY = (e.clientY - r.top)  * (canvas.height / r.height);
  });

  // Interior state
  let currentRoomId = null;

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
    // ENTER -> if hovering a building on campus, enter that room; otherwise focus chat
    if (e.code === 'Enter' && document.activeElement !== chatInput) {
      if (!currentRoomId) {
        const rect = rectUnderMouse();
        if (rect) { const room = roomForRect(rect); if (room) { e.preventDefault(); socket.emit('enterRoom', { roomId: room.id }); } return; }
      }
      chatInput.focus(); return;
    }
    if (e.code === 'Escape' || e.code === 'KeyQ') { socket.emit('leaveRoom'); return; }

    const dir = keys.get(e.code); if (!dir) return;
    if (!input[dir]) { input[dir] = true; sendInput(); }
  });
  document.addEventListener('keyup', (e) => {
    const dir = keys.get(e.code); if (!dir) return;
    if (input[dir]) { input[dir] = false; sendInput(); }
  });

  // D-pad (always active; movement works in campus and rooms)
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
    // authoritative world+rooms from server
    world = { ...world, ...payload.world };
    const val = nameInput.value.trim(); if (val) localStorage.setItem('campusName', val);
    nameModal.style.display = 'none';
  });

  socket.on('roomChanged', ({ roomId }) => { currentRoomId = roomId || null; });

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
    // room switch? snap to new space
    if (pa.roomId !== pb.roomId) return pb;
    return {
      id: pb.id, name: pb.name, color: pb.color,
      x: lerp(pa.x, pb.x, t), y: lerp(pa.y, pb.y, t),
      rx: lerp(pa.rx ?? pb.rx, pb.rx, t), ry: lerp(pa.ry ?? pb.ry, pb.ry, t),
      roomId: pb.roomId,
      chatText: pb.chatText, chatTs: pb.chatTs
    };
  }

  function drawGridCampus(){
    const grid = 120;
    const startX = -((camX % grid) + grid) % grid;
    const startY = -((camY % grid) + grid) % grid;
    ctx.strokeStyle = '#0f1725'; ctx.lineWidth = 1;
    for (let x = startX; x < canvas.width; x += grid) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke(); }
    for (let y = startY; y < canvas.height; y += grid) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); ctx.stroke(); }
  }
  function drawBuildingsAndHover(){
    const mxW = mouseX + camX, myW = mouseY + camY;
    let hover = null;
    ctx.lineWidth = 2;
    for (const o of (world.obstacles || [])) {
      const sx = Math.round(o.x - camX), sy = Math.round(o.y - camY);
      ctx.fillStyle = '#1d2536'; ctx.fillRect(sx, sy, o.w, o.h);
      ctx.strokeStyle = '#2f3c5a'; ctx.strokeRect(sx, sy, o.w, o.h);
      if (mxW >= o.x && mxW <= o.x + o.w && myW >= o.y && myW <= o.y + o.h) hover = o;
      ctx.fillStyle = '#aab6e5'; ctx.font = '600 14px Inter, sans-serif'; ctx.textAlign = 'center';
      for (const [i,line] of String(o.label||'').split('\n').entries()) ctx.fillText(line, sx + o.w/2, sy + 18 + i*18);
    }
    if (hover) {
      const sx = Math.round(hover.x - camX), sy = Math.round(hover.y - camY);
      ctx.lineWidth = 3; ctx.strokeStyle = '#67a8ff'; ctx.strokeRect(sx-2, sy-2, hover.w+4, hover.h+4);
      // hint
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(canvas.width/2 - 220, 16, 440, 36);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.strokeRect(canvas.width/2 - 220, 16, 440, 36);
      ctx.fillStyle = '#e8ecff'; ctx.font = '600 14px Inter, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(`Press Enter to enter ${hover.label || 'Room'}`, canvas.width/2, 38);
    }
    return hover;
  }
  function drawPlayerCampus(p){
    const x = Math.round(p.x - camX), y = Math.round(p.y - camY);
    drawAvatarAndName(x, y, p.name, p.color, p.id === me);
    drawChatAt(x, y, p);
  }

  function getRoomById(id){ return (world.rooms || []).find(r => r.id === id) || null; }
  function roomForRect(rect){
    // match enter rectangle to a room
    return (world.rooms || []).find(r => r.enter && r.enter.x===rect.x && r.enter.y===rect.y && r.enter.w===rect.w && r.enter.h===rect.h) || null;
  }
  function drawGridRoom(rm){
    const grid = 100;
    const startX = -((roomCamX % grid) + grid) % grid;
    const startY = -((roomCamY % grid) + grid) % grid;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    for (let x = startX; x < canvas.width; x += grid) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke(); }
    for (let y = startY; y < canvas.height; y += grid) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); ctx.stroke(); }
  }
  function drawRoomScene(rm){
    const iw = rm.interior?.w || 1100, ih = rm.interior?.h || 700;
    // room bg
    ctx.fillStyle = rm.interior?.bg || '#1c2538';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    drawGridRoom(rm);
    // interior objects
    const objs = rm.interior?.objects || [];
    for (const o of objs) {
      const x = Math.round((o.x || 0) - roomCamX), y = Math.round((o.y || 0) - roomCamY);
      ctx.fillStyle = o.fill || 'rgba(255,255,255,0.1)'; ctx.fillRect(x, y, o.w || 100, o.h || 60);
      ctx.strokeStyle = o.stroke || 'rgba(0,0,0,0.25)'; ctx.lineWidth = 2; ctx.strokeRect(x, y, o.w || 100, o.h || 60);
      if (o.label) { ctx.fillStyle='#dbe3ff'; ctx.font='600 14px Inter, sans-serif'; ctx.textAlign='center';
        ctx.fillText(o.label, x + (o.w||100)/2, y + (o.h||60)/2 + 5); }
    }
    // title
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, 0, canvas.width, 48);
    ctx.fillStyle = '#e8ecff'; ctx.font = '700 18px Inter, sans-serif'; ctx.textAlign='left';
    ctx.fillText(`Inside: ${rm.name}`, 16, 30);
    ctx.fillStyle = '#c8d0ff'; ctx.font = '600 14px Inter, sans-serif'; ctx.textAlign='right';
    ctx.fillText('Esc/Q to exit', canvas.width - 16, 30);
  }
  function drawPlayerRoom(p){
    const x = Math.round((p.rx || 0) - roomCamX), y = Math.round((p.ry || 0) - roomCamY);
    drawAvatarAndName(x, y, p.name, p.color, p.id === me);
    drawChatAt(x, y, p);
  }

  function drawAvatarAndName(x, y, name, color, isMe){
    ctx.beginPath(); ctx.arc(x+2, y+2, radius+1, 0, Math.PI*2); ctx.fillStyle='rgba(0,0,0,0.25)'; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI*2);
    ctx.fillStyle = isMe ? '#ffffff' : (color || '#7dafff'); ctx.fill();
    ctx.lineWidth = isMe ? 3 : 2; ctx.strokeStyle = isMe ? '#3b82f6' : '#111827'; ctx.stroke();
    ctx.font='600 14px Inter, sans-serif'; ctx.textAlign='center'; ctx.lineWidth = 4; ctx.strokeStyle='rgba(0,0,0,0.6)';
    ctx.strokeText(name, x, y - radius - 10); ctx.fillStyle='#e8ecff'; ctx.fillText(name, x, y - radius - 10);
  }
  function drawChatAt(x,y,p){
    const now=Date.now();
    let text=p.chatText, ts=p.chatTs;
    if (p.id === me && localEcho) { if (!ts || localEcho.ts >= ts) { text=localEcho.text; ts=localEcho.ts; } if (now-localEcho.ts>2000) localEcho=null; }
    if (text && ts && now-ts<CHAT_DURATION_MS) {
      const t=(now-ts)/CHAT_DURATION_MS, alpha = t<0.8 ? 1 : (1-(t-0.8)/0.2);
      drawChatBubble(x,y,text,alpha);
    }
  }
  function wrapLines(text, maxWidth){
    const words = text.split(/\s+/), lines=[]; let line='';
    ctx.font='600 14px Inter, sans-serif';
    for (const w of words) { const test = line ? line+' '+w : w;
      if (ctx.measureText(test).width <= maxWidth) { line=test; }
      else { if (line) lines.push(line); line = w; } }
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

  function rectUnderMouse(){
    const mxW = mouseX + camX, myW = mouseY + camY;
    for (const o of (world.obstacles || [])) {
      if (mxW >= o.x && mxW <= o.x + o.w && myW >= o.y && myW <= o.y + o.h) return o;
    }
    return null;
  }

  // ---------- Render loop ----------
  function render(dt){
    ctx.fillStyle = '#0b0f14'; ctx.fillRect(0,0,canvas.width,canvas.height);
    interpTime += dt; const t = Math.max(0, Math.min(1, interpTime / SERVER_TICK_MS));

    // Build interpolated players with room info
    const interPlayers = [];
    for (const pb of currentState.players) {
      const pa = lastState.players.find(x=>x.id===pb.id);
      interPlayers.push(lerpPlayer(pa, pb, t));
    }

    // me
    const meP = interPlayers.find(p=>p.id===me);

    if (!currentRoomId) {
      // Campus camera follows campus coords
      if (meP) {
        camX = clamp(meP.x - canvas.width/2, 0, (world.width||3200) - canvas.width);
        camY = clamp(meP.y - canvas.height/2, 0, (world.height||2000) - canvas.height);
      } else { camX = 0; camY = 0; }

      drawGridCampus();
      const hover = drawBuildingsAndHover();
      for (const p of interPlayers) if (!p.roomId) drawPlayerCampus(p);
    } else {
      // Room scene
      const rm = getRoomById(currentRoomId);
      const iw = rm?.interior?.w || 1100, ih = rm?.interior?.h || 700;
      // Camera follows room coords
      if (meP) {
        roomCamX = clamp((meP.rx||0) - canvas.width/2, 0, Math.max(0, iw - canvas.width));
        roomCamY = clamp((meP.ry||0) - canvas.height/2, 0, Math.max(0, ih - canvas.height));
      } else { roomCamX = roomCamY = 0; }

      drawRoomScene(rm);
      for (const p of interPlayers) if (p.roomId === currentRoomId) drawPlayerRoom(p);
    }

    requestAnimationFrame((now)=>{ const prev = render.lastTime || now; render.lastTime = now; render(now - prev); });
  }
  requestAnimationFrame((now)=>{ render.lastTime = now; render(16); });
})();
