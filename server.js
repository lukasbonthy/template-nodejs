import express from "express";
import http from "http";
import compression from "compression";
import helmet from "helmet";
import nocache from "nocache";
import { WebSocketServer } from "ws";

const app = express();
const PORT = process.env.PORT || 3000;

// Basic hardening + perf
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "script-src": ["'self'", "https://cdn.tailwindcss.com", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'"],
    }
  }
}));
app.use(compression());
app.use(nocache());
app.use(express.static("public", { extensions: ["html"] }));

// SPA fallback (optional)
app.get("*", (req, res, next) => {
  if (req.accepts("html")) return res.sendFile(process.cwd() + "/public/index.html");
  return next();
});

const server = http.createServer(app);

// ========== WebSocket ==========
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

// keep a small in-memory buffer (optional)
const HISTORY_LIMIT = 200;
let history = [];

function broadcast(obj, except=null) {
  const data = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws !== except && ws.readyState === ws.OPEN) ws.send(data);
  }
}

function addToHistory(evt) {
  history.push(evt);
  if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
}

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  ws.isAlive = true;
  clients.add(ws);

  // send hello + history
  ws.send(JSON.stringify({ type: "hello", payload: { serverTime: Date.now() } }));
  if (history.length) ws.send(JSON.stringify({ type: "history", payload: history }));

  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    // Expected shapes:
    // {type:"message", payload:{id,user,text,ts}}
    // {type:"typing", payload:{user}}
    if (msg?.type === "message" && msg.payload?.text) {
      const clean = {
        id: String(msg.payload.id || Date.now()),
        user: String(msg.payload.user || "Guest").slice(0, 32),
        text: String(msg.payload.text).slice(0, 2000),
        ts: Number(msg.payload.ts || Date.now())
      };
      const evt = { type: "message", payload: clean };
      addToHistory(evt);
      broadcast(evt); // to all
    } else if (msg?.type === "typing") {
      broadcast({ type: "typing", payload: { user: String(msg.payload?.user || "Guest").slice(0, 32) } }, ws);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
  });
});

// Heartbeat (keep connections fresh)
setInterval(() => {
  for (const ws of clients) {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket at ws://localhost:${PORT}/ws`);
});
