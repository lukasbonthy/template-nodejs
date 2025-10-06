import express from "express";
import http from "http";
import compression from "compression";
import helmet from "helmet";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server as SocketIO } from "socket.io";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, {
  path: "/socket.io",               // client matches this
  cors: { origin: true, credentials: true }
});

const PORT = process.env.PORT || 3000;

// Keep CSP off (we use inline scripts & CDN)
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());

// Serve static
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// In-memory history
const HISTORY_LIMIT = 200;
let history = [];

// Socket.IO
io.on("connection", (socket) => {
  console.log("✅ connected:", socket.id);

  socket.emit("hello", { serverTime: Date.now() });
  if (history.length) socket.emit("history", history);

  socket.on("message", (m) => {
    if (!m || typeof m.text !== "string") return;
    const msg = {
      id: String(m.id || Date.now()),
      user: String(m.user || "Guest").slice(0, 32),
      text: m.text.slice(0, 2000),
      ts: Number(m.ts || Date.now())
    };
    history.push(msg);
    if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
    io.emit("message", msg);
  });

  socket.on("typing", (u) => {
    const user = String(u?.user || "Guest").slice(0, 32);
    socket.broadcast.emit("typing", { user });
  });

  socket.on("disconnect", (r) => {
    console.log("❌ disconnected:", socket.id, r);
  });
});

// SPA fallback that does NOT intercept /socket.io/*
app.get(/^\/(?!socket\.io\/).*/, (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, () => {
  console.log(`🚀 http://localhost:${PORT}`);
});
