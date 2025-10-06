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
  // Explicit path to avoid surprises; the client will match this.
  path: "/socket.io",
  cors: { origin: true, credentials: true }
});

const PORT = process.env.PORT || 3000;

/* Security + perf (keep CSP off since we use CDN + inline scripts) */
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());

/* Static files */
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

/* In-memory message store */
const HISTORY_LIMIT = 300;
let history = []; // [{id,user,text,ts}]

/* Socket.IO messaging */
io.on("connection", (socket) => {
  console.log("client connected:", socket.id);

  // send hello + history to the new client
  socket.emit("hello", { serverTime: Date.now() });
  if (history.length) socket.emit("history", history);

  socket.on("message", (m) => {
    if (!m || typeof m.text !== "string") return;
    const msg = {
      id: String(m.id || Date.now()),
      user: String(m.user || "Guest").slice(0, 32),
      text: m.text.slice(0, 2000),
      ts: Number(m.ts || Date.now()),
    };
    history.push(msg);
    if (history.length > HISTORY_LIMIT) history = history.slice(-HISTORY_LIMIT);
    io.emit("message", msg); // broadcast to everyone (including sender)
  });

  socket.on("typing", (u) => {
    const user = String((u && u.user) || "Guest").slice(0, 32);
    socket.broadcast.emit("typing", { user });
  });

  socket.on("disconnect", () => {
    console.log("client disconnected:", socket.id);
  });
});

/* SPA fallback — IMPORTANT: do NOT match /socket.io/* */
app.get(/^\/(?!socket\.io\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
