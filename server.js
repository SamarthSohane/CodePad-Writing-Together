const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const DATA_FILE = path.join(__dirname, 'rooms.json');

// --- In-Memory Room Store & Persistence ---
// Structure:
// rooms[roomId] = {
//   id: string,
//   passcode: string | null,
//   language: string,
//   code: string,
//   createdAt: number,
//   hostSocketId: string,
//   members: [ { socketId, username, color, joinedAt } ],
//   auditLog: [ { id, timestamp, text, type } ]
// }
let rooms = {};

// Load saved rooms from disk on startup
function loadRooms() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const saved = JSON.parse(raw);
      // Clean up stale transient members from previous runs
      for (const id in saved) {
        saved[id].members = [];
        saved[id].hostSocketId = null;
      }
      rooms = saved;
      console.log(`[Storage] Loaded ${Object.keys(rooms).length} persistent rooms from disk.`);
    }
  } catch (err) {
    console.error('[Storage] Error loading rooms.json:', err.message);
    rooms = {};
  }
}

// Debounced disk persistence
let saveTimeout = null;
function persistRooms() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      // Persist metadata, code, passcode, audit logs (strip socket IDs)
      const dataToSave = {};
      for (const [id, room] of Object.entries(rooms)) {
        dataToSave[id] = {
          id: room.id,
          passcode: room.passcode,
          language: room.language,
          code: room.code,
          createdAt: room.createdAt,
          auditLog: room.auditLog.slice(-100) // keep last 100 entries
        };
      }
      fs.writeFileSync(DATA_FILE, JSON.stringify(dataToSave, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Storage] Error saving rooms.json:', err.message);
    }
  }, 1000);
}

loadRooms();

// --- Socket.IO Server Setup ---
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingInterval: 10000,
  pingTimeout: 5000
});

// Helper: Add audit log entry
function addAuditLog(room, text, type = 'info') {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    text,
    type
  };
  room.auditLog.push(entry);
  if (room.auditLog.length > 200) room.auditLog.shift();
  io.to(room.id).emit('audit_log_entry', entry);
  persistRooms();
}

// --- Connection Throttler (Leaky-Bucket / 1-second Sliding Window) ---
// Throttles broadcast updates from any individual socket emitting > 5 updates/second
const THROTTLE_LIMIT = 5; // max updates per second
const socketThrottlers = new Map();

function isThrottled(socketId) {
  const now = Date.now();
  let tracker = socketThrottlers.get(socketId);

  if (!tracker || now > tracker.resetTime) {
    tracker = { count: 1, resetTime: now + 1000, warned: false };
    socketThrottlers.set(socketId, tracker);
    return false;
  }

  tracker.count++;
  if (tracker.count > THROTTLE_LIMIT) {
    return true;
  }
  return false;
}

// --- REST Endpoint for Health & Diagnostics ---
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    activeRooms: Object.keys(rooms).length,
    timestamp: new Date().toISOString()
  });
});

// --- Socket Event Handlers ---
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  let currentRoomId = null;

  // 1. Join Room & Validation Handshake
  socket.on('join_room', ({ roomId, passcode, username, color }, callback) => {
    try {
      if (!roomId || !username) {
        return callback?.({ success: false, error: 'Room ID and Username are required.' });
      }

      const normalizedRoomId = roomId.trim().toLowerCase();
      let room = rooms[normalizedRoomId];

      if (room) {
        // Room exists - validate passcode if set
        if (room.passcode) {
          if (!passcode || room.passcode !== passcode.trim()) {
            return callback?.({
              success: false,
              error: 'Invalid room passcode. Access denied.'
            });
          }
        }
      } else {
        // New room creation
        room = {
          id: normalizedRoomId,
          passcode: passcode && passcode.trim().length > 0 ? passcode.trim() : null,
          language: 'javascript',
          code: `// Welcome to Collaborative Room: ${normalizedRoomId}\n// Start writing code or technical notes together!\n\nfunction helloWorld() {\n  console.log("Real-time collaboration active!");\n}\n\nhelloWorld();\n`,
          createdAt: Date.now(),
          hostSocketId: socket.id,
          members: [],
          auditLog: []
        };
        rooms[normalizedRoomId] = room;
        addAuditLog(room, `Room created by ${username}`, 'system');
      }

      currentRoomId = normalizedRoomId;
      socket.join(normalizedRoomId);

      // Determine Host role: If room has no active host, first member becomes host
      const isCreatorOrOnlyMember = room.members.length === 0 || !room.hostSocketId;
      if (isCreatorOrOnlyMember) {
        room.hostSocketId = socket.id;
      }

      // Add member with joinedAt timestamp for FIFO succession
      const newMember = {
        socketId: socket.id,
        username: username.trim(),
        color: color || '#3b82f6',
        joinedAt: Date.now(),
        isHost: room.hostSocketId === socket.id
      };

      room.members.push(newMember);

      // Welcome user and send initial state
      callback?.({
        success: true,
        room: {
          id: room.id,
          language: room.language,
          code: room.code,
          hasPasscode: !!room.passcode,
          isHost: newMember.isHost,
          hostSocketId: room.hostSocketId,
          members: room.members,
          auditLog: room.auditLog
        }
      });

      // Broadcast new participant to room
      io.to(normalizedRoomId).emit('members_updated', room.members);
      addAuditLog(room, `${username} joined the workspace.`, 'join');
      persistRooms();

    } catch (err) {
      console.error('[Socket] join_room error:', err);
      callback?.({ success: false, error: 'Internal server error during room admission.' });
    }
  });

  // 2. Real-Time Code Changes with Anti-Spam Throttling (>5 updates/sec)
  socket.on('code_change', ({ change, fullCode }) => {
    if (!currentRoomId || !rooms[currentRoomId]) return;

    if (isThrottled(socket.id)) {
      // Throttle packet and alert the offending connection
      socket.emit('throttle_warning', {
        message: 'Spam throttling: update burst exceeded 5 ops/second. Throttling active.'
      });
      return;
    }

    const room = rooms[currentRoomId];
    room.code = fullCode;

    // Broadcast change to other peers in room
    socket.to(currentRoomId).emit('code_change', {
      change,
      fullCode,
      senderSocketId: socket.id
    });

    persistRooms();
  });

  // 3. Cursor Position & Line Highlight Broadcast
  socket.on('cursor_move', ({ cursor, selection }) => {
    if (!currentRoomId || !rooms[currentRoomId]) return;

    // Broadcast cursor position and selected line ranges to peers
    socket.to(currentRoomId).emit('peer_cursor_update', {
      socketId: socket.id,
      cursor, // { lineNumber, column }
      selection // { startLineNumber, startColumn, endLineNumber, endColumn }
    });
  });

  // 4. Typing Indicator Badge
  socket.on('typing_status', ({ isTyping }) => {
    if (!currentRoomId || !rooms[currentRoomId]) return;

    socket.to(currentRoomId).emit('peer_typing_status', {
      socketId: socket.id,
      isTyping
    });
  });

  // 5. Language Change (Broadcasted to room)
  socket.on('language_change', ({ language }) => {
    if (!currentRoomId || !rooms[currentRoomId]) return;
    const room = rooms[currentRoomId];
    room.language = language;

    const member = room.members.find(m => m.socketId === socket.id);
    const actor = member ? member.username : 'A user';

    io.to(currentRoomId).emit('language_changed', { language });
    addAuditLog(room, `${actor} switched editor language to ${language.toUpperCase()}.`, 'info');
    persistRooms();
  });

  // 6. Host Actions (Host only: Clear workspace, Kick user)
  socket.on('host_clear_pad', () => {
    if (!currentRoomId || !rooms[currentRoomId]) return;
    const room = rooms[currentRoomId];
    if (room.hostSocketId !== socket.id) {
      return socket.emit('error_notification', 'Only the room host can clear the pad.');
    }

    room.code = '';
    io.to(currentRoomId).emit('code_cleared');
    addAuditLog(room, 'Workspace code was cleared by the host.', 'warning');
    persistRooms();
  });

  // 7. Disconnection & Dynamic Host Reassignment
  socket.on('disconnect', () => {
    socketThrottlers.delete(socket.id);

    if (!currentRoomId || !rooms[currentRoomId]) return;
    const room = rooms[currentRoomId];

    const leavingMember = room.members.find(m => m.socketId === socket.id);
    const wasHost = room.hostSocketId === socket.id;

    // Remove from active members
    room.members = room.members.filter(m => m.socketId !== socket.id);

    if (leavingMember) {
      addAuditLog(room, `${leavingMember.username} left the workspace.`, 'leave');
    }

    // Dynamic Role Reassignment:
    // If the departing client was host, transfer host to the oldest active remaining member (lowest joinedAt)
    if (wasHost && room.members.length > 0) {
      // Sort ascending by joinedAt to guarantee oldest active member
      room.members.sort((a, b) => a.joinedAt - b.joinedAt);
      const newHost = room.members[0];
      room.hostSocketId = newHost.socketId;

      // Update isHost flag on members list
      room.members.forEach(m => {
        m.isHost = m.socketId === newHost.socketId;
      });

      console.log(`[Host Transfer] In room "${room.id}", host transferred to ${newHost.username} (${newHost.socketId})`);

      // Notify the room
      io.to(currentRoomId).emit('host_reassigned', {
        newHostSocketId: newHost.socketId,
        newHostUsername: newHost.username
      });

      addAuditLog(
        room,
        `Host disconnected. Host privileges transferred to ${newHost.username} (oldest active member).`,
        'system'
      );
    } else if (room.members.length === 0) {
      room.hostSocketId = null;
    }

    io.to(currentRoomId).emit('members_updated', room.members);
    persistRooms();
  });
});

// Serve client dist build if present
const clientDistPath = path.join(__dirname, 'client', 'dist');
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.use((req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

// Start Server
server.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`  Collaborative Code Pad Server Running on Port ${PORT}`);
  console.log(`  WebSocket URL: ws://localhost:${PORT}`);
  console.log(`=================================================`);
});
