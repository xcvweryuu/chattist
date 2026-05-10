/**
 * server.js — Chattist server
 * Express REST API + WebSocket for real-time updates
 */

const express      = require('express');
const http         = require('http');
const path         = require('path');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const jwt        = require('jsonwebtoken');

const { JWT_SECRET } = require('./middleware/auth');
const { db } = require('./db'); // BUG FIX: Moved to top level

// ── App ──
const app    = express();
app.set('revokeSession', revokeSession); // SECURITY FIX: Expose for routes
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;
app.disable('x-powered-by');

// ── Security headers (Helmet) ──
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"], // SECURITY FIX: Removed 'unsafe-inline'
      styleSrc:   ["'self'", "'unsafe-inline'"],
      fontSrc:    ["'self'"],
      connectSrc: ["'self'", "ws:", "wss:"],
      imgSrc:     ["'self'", "data:"],
      frameSrc:   ["'none'"],
      objectSrc:  ["'none'"],
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: { maxAge: 31536000, includeSubDomains: true },
  frameguard: { action: 'deny' },
  noSniff: true,
}));

// ── Middleware ──
app.use(cors({ origin: 'https://yourdomain.com', credentials: true }));
app.use(cookieParser());
app.use(express.json());

// ── Rate Limiting ──
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,                   // Max 10 attempts
  message: { error: 'Too many requests. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/login',    authLimiter);
app.use('/api/auth/register', authLimiter);

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,  // 1 min
  max: 120,                  // 120 requests per minute
  message: { error: 'Too many requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// Serve frontend static files
app.use(express.static(path.join(__dirname, '..')));

// ── API routes ──
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/groups',   require('./routes/groups'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/dm',       require('./routes/dm'));

// All other requests → index.html (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// ════════════════════════════════════════════
// WEBSOCKET SERVER
// ════════════════════════════════════════════
const wss = new WebSocketServer({ server });

// All active connections: Map<ws, { userId, username, rooms: Set<string>, isAlive: boolean }>
const clients = new Map();
// Room management: Map<roomId, Set<ws>>
const rooms = new Map();

function addToRoom(roomId, ws) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId).add(ws);
  const info = clients.get(ws);
  if (info) info.rooms.add(roomId);
}

function removeFromRoom(roomId, ws) {
  const roomSet = rooms.get(roomId);
  if (roomSet) {
    roomSet.delete(ws);
    if (roomSet.size === 0) rooms.delete(roomId);
  }
  const info = clients.get(ws);
  if (info) info.rooms.delete(roomId);
}

function broadcast(roomId, data, excludeWs = null) {
  const roomSet = rooms.get(roomId);
  if (!roomSet) return;
  const json = JSON.stringify(data);
  for (const ws of roomSet) {
    if (ws === excludeWs) continue;
    if (ws.readyState === ws.OPEN) ws.send(json);
  }
}

function sendTo(userId, data) {
  const json = JSON.stringify(data);
  for (const [ws, info] of clients.entries()) {
    if (info.userId === userId && ws.readyState === ws.OPEN) {
      ws.send(json);
    }
  }
}

// Heartbeat
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    const info = clients.get(ws);
    if (!info) return;
    if (info.isAlive === false) return ws.terminate();
    info.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(interval));

wss.on('connection', (ws) => {
  let authed = false;
  // SECURITY FIX: WS rate limiting
  const quota = { count: 0, reset: Date.now() + 5000 };
  clients.set(ws, { userId: null, username: null, rooms: new Set(), isAlive: true });

  ws.on('pong', () => {
    const info = clients.get(ws);
    if (info) info.isAlive = true;
  });

  // Auth timeout: 10s
  const authTimeout = setTimeout(() => {
    if (!authed) {
      ws.send(JSON.stringify({ type: 'error', message: 'Authentication timed out.' }));
      ws.close();
    }
  }, 10000);

  ws.on('message', (raw) => {
    // SECURITY FIX: Rate limiting (max 20 events per 5s)
    if (Date.now() > quota.reset) {
      quota.count = 0;
      quota.reset = Date.now() + 5000;
    }
    quota.count++;
    if (quota.count > 20) {
      return ws.send(JSON.stringify({ type: 'rate_limited', error: 'Too many events. Please wait.' }));
    }

    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    // ── AUTH ──
    if (msg.type === 'auth') {
      try {
        const payload = jwt.verify(msg.token, JWT_SECRET);
        if (payload.typ === 'refresh') throw new Error('no refresh over ws');
        
        // SECURITY FIX: Token blacklisting check
        const blacklisted = db.prepare('SELECT 1 FROM jti_blacklist WHERE jti = ?').get(payload.jti);
        if (blacklisted) throw new Error('token blacklisted');

        const info = clients.get(ws);
        info.userId = payload.id;
        info.username = payload.username;
        info.jti = payload.jti; // Store jti to enable revocation
        authed = true;
        
        clearTimeout(authTimeout);
        ws.send(JSON.stringify({ type: 'auth_ok', username: payload.username }));
        if (process.env.CHATTIST_DEBUG === '1') console.log('[ws] auth ok');
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid token.' }));
        ws.close();
      }
      return;
    }

    if (!authed || !clients.has(ws)) return;
    const clientInfo = clients.get(ws);

    // ── JOIN GROUP ──
    if (msg.type === 'join_group') {
      const groupId = msg.groupId;
      const group = db.prepare('SELECT id, password_hash FROM groups WHERE id = ?').get(groupId);
      if (!group) {
        return ws.send(JSON.stringify({ type: 'error', message: 'Group not found.' }));
      }

      // Verify membership
      let membership = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, clientInfo.userId);
      
      // If not a member but group is public, auto-join
      if (!membership && !group.password_hash) {
        db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(groupId, clientInfo.userId);
        membership = true;
      }

      if (membership) {
        addToRoom('group:' + groupId, ws);
        broadcast('group:' + groupId, {
          type: 'user_joined',
          username: clientInfo.username,
          groupId: groupId
        }, ws);
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Not a member of this group. Password required.' }));
      }
    }

    // ── LEAVE GROUP ──
    if (msg.type === 'leave_group') {
      removeFromRoom('group:' + msg.groupId, ws);
    }

    // ── JOIN DM ROOM ──
    if (msg.type === 'join_dm') {
      // SECURITY FIX: DM IDOR protection
      if (!msg.otherId || msg.otherId === clientInfo.userId) {
        return ws.send(JSON.stringify({ type: 'error', message: 'Invalid DM target.' }));
      }
      const other = db.prepare('SELECT 1 FROM users WHERE id = ?').get(msg.otherId);
      if (!other) return ws.send(JSON.stringify({ type: 'error', message: 'User not found.' }));

      const dmRoom = getDmRoom(clientInfo.userId, msg.otherId);
      addToRoom(dmRoom, ws);
    }

    // ── GROUP MESSAGE ──
    if (msg.type === 'group_message') {
      if (!msg.id || !msg.groupId || !msg.content) return;
      // Double check membership for message broadcasting
      if (clientInfo.rooms.has('group:' + msg.groupId)) {
        broadcast('group:' + msg.groupId, {
          type:       'group_message',
          id:         msg.id,
          groupId:    msg.groupId,
          userId:     clientInfo.userId,
          username:   clientInfo.username,
          content:    msg.content,
          created_at: msg.created_at || Date.now()
        }, ws);
      }
    }

    // ── DM MESSAGE ──
    if (msg.type === 'dm_message') {
      if (!msg.id || !msg.receiverId || !msg.content) return;
      
      // SECURITY FIX: Block check before DM
      const blocked = db.prepare(
        'SELECT 1 FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)'
      ).get(clientInfo.userId, msg.receiverId, msg.receiverId, clientInfo.userId);
      
      if (blocked) {
        return ws.send(JSON.stringify({ type: 'error', message: 'Cannot send message: User blocked.' }));
      }

      const dmRoom = getDmRoom(clientInfo.userId, msg.receiverId);
      const data = {
        type:          'dm_message',
        id:            msg.id,
        senderId:      clientInfo.userId,
        senderName:    clientInfo.username,
        receiverId:    msg.receiverId,
        receiverName:  msg.receiverName || '',
        content:       msg.content,
        created_at:    msg.created_at || Date.now()
      };
      sendTo(msg.receiverId, data);
      broadcast(dmRoom, data, ws);
    }

    // ── BURN MESSAGE ──
    if (msg.type === 'burn_message') {
      // SECURITY FIX: Authorization check for message burning
      const msgRow = db.prepare('SELECT user_id, group_id FROM messages WHERE id = ?').get(msg.id) 
                  || db.prepare('SELECT sender_id as user_id FROM dm_messages WHERE id = ?').get(msg.id);
      
      if (!msgRow) return;
      
      let isAuthorized = (msgRow.user_id === clientInfo.userId);
      if (!isAuthorized && msgRow.group_id) {
        const group = db.prepare('SELECT created_by FROM groups WHERE id = ?').get(msgRow.group_id);
        if (group && group.created_by === clientInfo.userId) isAuthorized = true;
      }

      if (isAuthorized) {
        const targetRoom = msgRow.group_id ? 'group:' + msgRow.group_id : getDmRoom(clientInfo.userId, msg.receiverId);
        broadcast(targetRoom, {
          type:    'burn_message',
          id:      msg.id,
          groupId: msg.groupId
        });
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized to delete this message.' }));
      }
    }

    // ── MESSAGE EDITED ──
    if (msg.type === 'message_edited') {
      if (!msg.id || !msg.groupId || !msg.content) return;
      if (clientInfo.rooms.has('group:' + msg.groupId)) {
        broadcast('group:' + msg.groupId, {
          type:      'message_edited',
          id:        msg.id,
          groupId:   msg.groupId,
          content:   msg.content,
          edited_at: msg.edited_at
        }, ws);
      }
    }

    // ── DM EDITED ──
    if (msg.type === 'dm_message_edited') {
      if (!msg.id || !msg.receiverId || !msg.content) return;
      const dmRoom = getDmRoom(clientInfo.userId, msg.receiverId);
      // BUG FIX: Broadcast to all participant sessions
      broadcast(dmRoom, {
        type:      'dm_message_edited',
        id:        msg.id,
        content:   msg.content,
        edited_at: msg.edited_at
      });
    }

    // ── DM VIEWED (read receipt) ──
    if (msg.type === 'dm_viewed') {
      if (!msg.otherId) return;
      db.prepare('UPDATE dm_messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ?')
        .run(msg.otherId, clientInfo.userId);
      sendTo(msg.otherId, { type: 'dm_read', receiverId: clientInfo.userId });
    }

    // ── TYPING INDICATOR ──
    if (msg.type === 'typing') {
      if (clientInfo.rooms.has('group:' + msg.groupId)) {
        broadcast('group:' + msg.groupId, {
          type:     'typing',
          username: clientInfo.username,
          groupId:  msg.groupId
        }, ws);
      }
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info) {
      if (process.env.CHATTIST_DEBUG === '1') console.log('[ws] closed');
      for (const roomId of info.rooms) {
        if (roomId.startsWith('group:')) {
          broadcast(roomId, { type: 'user_left', username: info.username });
        }
        removeFromRoom(roomId, ws);
      }
    }
    clients.delete(ws);
    clearTimeout(authTimeout);
  });

  ws.on('error', (e) => {
    if (process.env.CHATTIST_DEBUG === '1') console.error('[ws] error:', e.message);
  });
});

function getDmRoom(id1, id2) {
  return 'dm:' + [id1, id2].sort().join(':');
}

function revokeSession(jti) {
  for (const [ws, info] of clients.entries()) {
    if (info.jti === jti) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session revoked.' }));
      ws.terminate();
    }
  }
}

// ── Start ──
server.listen(PORT, () => {
  console.log(`chattist listening on ${PORT} (set CHATTIST_DEBUG=1 for verbose logs)`);
});

module.exports = { app, server, revokeSession };
