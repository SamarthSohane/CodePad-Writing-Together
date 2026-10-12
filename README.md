# ⚡ Live Collaborative Workspace and Code Pad

A multi-user real-time web workspace where users can join persistent virtual rooms, collaborate on code or technical notes simultaneously, and track participant presence without data collisions or UI freezing.

Built for **Technical Web Development (WEB-02)**.

---

## 🌟 Key Features

1. **Synchronized Editor Interface**:
   - Modern split-layout workspace featuring Monaco Code Editor (VS Code core engine).
   - Real-time active room participant list with custom avatar colors and host badges.
   - Live activity audit feed logging joins, leaves, role handovers, language switches, and system alerts with timestamps.
   - Multi-language syntax support (JavaScript, TypeScript, Python, HTML, CSS, JSON, Markdown, C++).

2. **Room Management & Security**:
   - Custom alphanumeric Room IDs (or instant 1-click random room ID generator).
   - Optional room passcodes to lock private sessions.
   - Pre-admission handshake validation: unauthorized clients or incorrect passcodes are rejected before entering the active session.

3. **Real-Time Broadcast Protocol & Presence**:
   - Real-time character insertions and deletions across all connected peers.
   - Remote cursor carets with user name tags floating in the editor.
   - Active line highlights showing where peers are currently typing.
   - Real-time presence indicators (active status dots) and animated typing status badges.

4. **Connection & Spam Throttling**:
   - Server-side sliding-window rate limiter restricting traffic from any connection emitting rapid bursts exceeding **5 updates/second**.
   - Offending connections receive a throttle warning banner while maintaining room socket stability.

5. **Dynamic Role Reassignment**:
   - The room creator is designated as the initial `HOST`.
   - Host has administrative privileges (e.g., clearing the entire workspace for all peers).
   - If the host abruptly disconnects, administrative privileges **transfer automatically to the oldest active remaining member** (based on entry timestamp FIFO ordering).

6. **Abrupt Disconnection & Smooth Reconnect Resilience**:
   - Socket.IO heartbeat ping/pong protocol (10s intervals) for instant drop detection.
   - Automatic exponential backoff reconnects on network blips.
   - Visual connection status pill (🟢 Connected / 🟡 Reconnecting / 🔴 Disconnected).
   - Full workspace state hydration upon reconnection.

7. **Zero-Configuration Persistence**:
   - Clean in-memory room management backed by debounced local JSON persistence (`rooms.json`). No external databases or Docker required.

---

## 🛠️ Architecture & Technology Stack

```
┌────────────────────────────────────────────────────────┐
│                   CLIENT (React + Vite)                │
│  • Monaco Code Editor (@monaco-editor/react)           │
│  • Remote Cursor & Selection Decorations               │
│  • Split Workspace Layout + Activity Audit Feed        │
│  • Lucide React Icons                                  │
│  • Socket.io Client (Auto-reconnection + State Sync)   │
└───────────────────────────▲────────────────────────────┘
                            │ WebSocket Protocol (ws://localhost:4000)
┌───────────────────────────▼────────────────────────────┐
│                  SERVER (Node.js + Express)            │
│  • Socket.io Server with Room Namespaces               │
│  • Pre-Admission Passcode Security Handshake           │
│  • 5 ops/sec Anti-Flooding Rate Limiter                │
│  • FIFO Host Succession & Dynamic Role Engine          │
│  • In-Memory Store + Auto-saved rooms.json             │
└────────────────────────────────────────────────────────┘
```

---

## 📋 Prerequisites

- **Node.js**: `v18.0.0` or higher (Tested on Node `v24.x`)
- **npm**: `v9.0.0` or higher

---

## 🚀 Getting Started

### 1. Clone & Install Dependencies

```bash
# Clone the repository
git clone https://github.com/devanupriyj-code/aws.git
cd aws

# Install all backend and frontend dependencies in one command
npm run install:all
```

*(Alternatively, run `npm install` in the root folder, and `npm install` inside the `client/` folder).*

---

### 2. Run in Development Mode (Live Hot Reload)

To start both the Node.js backend server and the Vite React frontend concurrently:

```bash
npm run dev
```

- **Frontend Client**: [http://localhost:5173](http://localhost:5173)
- **Backend WebSocket Server**: [http://localhost:4000](http://localhost:4000)

---

### 3. Run in Production Mode

To build the optimized client bundle and serve everything from a single server port (`4000`):

```bash
npm run build
npm start
```

Now open [http://localhost:4000](http://localhost:4000) in your browser.

## GitHub deployment readiness

This repository includes `.github/workflows/ci.yml`. Every push to `main` or `master`, and every pull request, validates the project by installing dependencies, linting the frontend, and creating a production build.

### Deploy the full application

The production Node server serves `client/dist` and the Socket.IO backend from one process. Use a Node-capable host such as Render, Railway, Fly.io, a VPS, or similar:

```bash
npm ci
npm ci --prefix client
npm run build
npm start
```

Set `PORT` if your host provides one. The frontend uses a same-origin Socket.IO URL by default. If the backend is hosted separately, define `VITE_SOCKET_URL` before building:

```bash
VITE_SOCKET_URL=https://your-api.example.com npm run build
```

### Deploying Frontend to Vercel

The React/Vite frontend can be deployed directly to [Vercel](https://vercel.com):

1. **Import the repository into Vercel**:
   - The root `vercel.json` is pre-configured to automatically install client dependencies and build the Vite bundle (`client/dist`).
   - If importing with root directory `./` (default), no custom build settings are needed.
   - If setting Root Directory to `client`, Vite is auto-detected and works out of the box.

2. **Configure Backend URL**:
   - In Vercel Project Settings ➔ **Environment Variables**, add:
     - **Name**: `VITE_SOCKET_URL`
     - **Value**: `https://<your-backend-app-url>` (e.g., your deployed Render, Railway, or Fly.io URL).
   - Redeploy so the build picks up the environment variable.

> **Note**: Vercel functions are serverless and cannot maintain persistent stateful WebSocket connections across peers. Deploy the companion Node.js server (`server.js`) to a persistent Node host (such as Render or Railway) and point `VITE_SOCKET_URL` to it.

---

## 🧪 Automated Testing

An automated end-to-end architectural test suite is included (`test_collaboration.js`). It programmatically verifies:
- Health endpoint responsiveness
- Room creation and passcode security validation
- Incorrect passcode rejection
- Spam throttling (>5 updates/second burst detection)
- Dynamic host role handover to the oldest active member upon disconnect

To run the test suite:

```bash
# 1. Start the server (in one terminal)
npm run server

# 2. Run the test suite (in another terminal)
node test_collaboration.js
```

---

## 🔌 Socket Protocol Reference

| Event | Direction | Payload | Description |
| :--- | :--- | :--- | :--- |
| `join_room` | Client ➔ Server | `{ roomId, passcode, username, color }` | Validates credentials & admits client into session |
| `code_change` | Bi-directional | `{ change, fullCode }` | Synchronizes code edits across peers (subject to rate limit) |
| `cursor_move` | Client ➔ Server | `{ cursor, selection }` | Transmits line number, column, and text selection |
| `peer_cursor_update` | Server ➔ Client | `{ socketId, cursor, selection }` | Renders peer cursor caret & line highlight |
| `typing_status` | Client ➔ Server | `{ isTyping: boolean }` | Emits active typing state (cleared after 1.2s idle) |
| `throttle_warning` | Server ➔ Client | `{ message }` | Warns client when update burst exceeds 5 ops/sec |
| `host_reassigned` | Server ➔ Client | `{ newHostSocketId, newHostUsername }` | Reassigns administrative role to oldest remaining peer |
| `host_clear_pad` | Client ➔ Server | *none* | Host-only privilege to clear editor for all members |
| `audit_log_entry` | Server ➔ Client | `{ id, timestamp, text, type }` | Broadcasts real-time events to room audit feed |

---

## 📂 Project Structure

```
.
├── server.js               # Express + Socket.IO server (auth, throttle, host transfer, persistence)
├── test_collaboration.js   # Automated integration test suite
├── package.json            # Root configuration and run scripts
├── vercel.json             # Vercel deployment configuration
├── .gitignore              # Git ignore rules
├── .env.example            # Environment variables template
├── client/                 # React (Vite) Frontend
│   ├── vercel.json         # Client-level Vercel configuration
│   ├── src/
│   │   ├── App.jsx         # Monaco editor, presence indicators, split sidebar & audit feed
│   │   ├── App.css         # Dark theme layout & custom cursor overlays
│   │   ├── index.css       # Global styles & Monaco decoration styles
│   │   └── main.jsx        # React application entry point
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
└── README.md               # Documentation & setup instructions
```
