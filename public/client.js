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
    const dir = keys.ge
