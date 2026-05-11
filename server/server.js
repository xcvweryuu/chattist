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

require('dotenv').config();

const { JWT_SECRET } = require('./middleware/auth');
const { db } = require('./db');
const sanitizeMiddleware = require('./middleware/sanitize');

// ── App ──
const app    = express();
app.set('revokeSession', revokeSession);
app.set('trust proxy', 1); // Trust first proxy
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;
app.disable('x-powered-by');

// ── Security headers (Helmet) ──
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
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
const corsOrigin = process.env.CORS_ORIGIN || true;
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(sanitizeMiddleware);

// ── Rate Limiting ──
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many requests. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/login',    authLimiter);
app.use('/api/auth/register', authLimiter);

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  message: { error: 'Too many requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// ── API routes ──
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/groups',   require('./routes/groups'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/dm',       require('./routes/dm'));

// Serve frontend static files
app.use(express.static(path.join(__dirname, '..')));

// Specific route for /register to avoid 404 (handled by index.html tabs)
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// All other requests → index.html (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    console.error('[error]', err);
  }
  res.status(500).json({ error: 'Internal server error.' });
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
  const quota = { count: 0, reset: Date.now() + 5000 };
  clients.set(ws, { userId: null, username: null, rooms: new Set(), isAlive: true });

  ws.on('pong', () => {
    const info = clients.get(ws);
    if (info) info.isAlive = true;
  });

  const authTimeout = setTimeout(() => {
    if (!authed) {
      ws.send(JSON.stringify({ type: 'error', message: 'Authentication timed out.' }));
      ws.close();
    }
  }, 10000);

  ws.on('message', (raw) => {
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

    if (msg.type === 'auth') {
      try {
        const payload = jwt.verify(msg.token, JWT_SECRET);
        if (payload.typ === 'refresh') throw new Error('no refresh over ws');
        
        const blacklisted = db.prepare('SELECT 1 FROM jti_blacklist WHERE jti = ?').get(payload.jti);
        if (blacklisted) throw new Error('token blacklisted');

        const info = clients.get(ws);
        info.userId = payload.id;
        info.username = payload.username;
        info.jti = payload.jti;
        authed = true;
        
        clearTimeout(authTimeout);
        ws.send(JSON.stringify({ type: 'auth_ok', username: payload.username }));
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid token.' }));
        ws.close();
      }
      return;
    }

    if (!authed || !clients.has(ws)) return;
    const clientInfo = clients.get(ws);

    if (msg.type === 'join_group') {
      const groupId = msg.groupId;
      const group = db.prepare('SELECT id, password_hash FROM groups WHERE id = ?').get(groupId);
      if (!group) return ws.send(JSON.stringify({ type: 'error', message: 'Group not found.' }));

      let membership = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, clientInfo.userId);
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

    if (msg.type === 'leave_group') {
      removeFromRoom('group:' + msg.groupId, ws);
    }

    if (msg.type === 'join_dm') {
      if (!msg.otherId || msg.otherId === clientInfo.userId) {
        return ws.send(JSON.stringify({ type: 'error', message: 'Invalid DM target.' }));
      }
      const other = db.prepare('SELECT 1 FROM users WHERE id = ?').get(msg.otherId);
      if (!other) return ws.send(JSON.stringify({ type: 'error', message: 'User not found.' }));

      const dmRoom = getDmRoom(clientInfo.userId, msg.otherId);
      addToRoom(dmRoom, ws);
    }

    if (msg.type === 'group_message') {
      if (!msg.id || !msg.groupId || !msg.content) return;
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

    if (msg.type === 'dm_message') {
      if (!msg.id || !msg.receiverId || !msg.content) return;
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

    if (msg.type === 'burn_message') {
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
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized.' }));
      }
    }

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

    if (msg.type === 'dm_message_edited') {
      if (!msg.id || !msg.receiverId || !msg.content) return;
      const dmRoom = getDmRoom(clientInfo.userId, msg.receiverId);
      broadcast(dmRoom, {
        type:      'dm_message_edited',
        id:        msg.id,
        content:   msg.content,
        edited_at: msg.edited_at
      });
    }

    if (msg.type === 'dm_viewed') {
      if (!msg.otherId) return;
      db.prepare('UPDATE dm_messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ?')
        .run(msg.otherId, clientInfo.userId);
      sendTo(msg.otherId, { type: 'dm_read', receiverId: clientInfo.userId });
    }

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

  ws.on('error', (e) => {});
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
  if (process.env.NODE_ENV !== 'production') {
    console.log(`chattist listening on ${PORT}`);
  }
});

module.exports = { app, server, revokeSession };
