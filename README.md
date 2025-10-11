# CHS Virtual Campus (PixelCHS)

A lightweight, Club-Penguin-style 2D web world for **Citrus High School (CHS)**. Walk around the campus, chat with classmates, enter wings/rooms/subrooms, and play with simple toys (bat, ball, cake, etc.). Built with **Node.js**, **Express**, and **Socket.IO**. Works even on restricted school Wi-Fi by using long-polling.

---

## ✨ Features

- **Open 2D campus:** Move freely on a top-down map.
- **Enterable interiors:** Buildings lead to **rooms** and **subrooms** (e.g., `C Wing → Classroom 1`).
- **Live multiplayer:** Positions, chat bubbles, toys, and actions are synced for everyone.
- **Chat bubbles:** Press **Enter**, type, and your message floats next to your avatar.
- **Toys & actions:** Equip toys from the hotbar, **right-click / Space / E** to use  
  - **Bat**: swing arc + hit FX + knockback
  - **Ball**: kick animation
  - **Cake / Pizza / Mic / Book / Flag / Laptop / Paint**: fun, cosmetic effects
- **Occupancy badges:** See how many people are in a room/subroom.
- **Mobile D-pad:** On phones, tap the built-in D-pad to move.
- **Name & identity:** Pick a name at entry. (Duplicate name protection included.)
- **Branding:** Includes modern **favicon** and **logo** for `pixelchs.com`.

---

## 🕹 Controls

- **Move:** `WASD` or arrow keys (mobile D-pad supported)
- **Enter building:** Hover building, press **Enter**
- **Chat:** **Enter** (open), type, **Enter** (send)
- **Leave room:** **Esc** or **Q**
- **Equip toy:** Number keys **1–9** (or click hotbar)
- **Clear toy:** **0**
- **Use toy:** **Right-click**, **Space**, or **E**
- **Subrooms:** Inside a room with subrooms, press **0** for Lobby, **1–9** to jump to subrooms

---

## 📁 Project structure

