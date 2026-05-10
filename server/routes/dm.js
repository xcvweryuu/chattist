const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, MSG_TTL }  = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET conversations list
router.get('/', authMiddleware, (req, res) => {
  const now = Date.now();
  const defaultCutoff = now - MSG_TTL;
  const convos = db.prepare(`
    SELECT
      CASE WHEN sender_id = ? THEN receiver_id   ELSE sender_id   END AS other_id,
      CASE WHEN sender_id = ? THEN receiver_name ELSE sender_name END AS other_name,
      MAX(created_at) as last_msg_time
    FROM dm_messages
    WHERE (sender_id = ? OR receiver_id = ?)
      AND ((expires_at IS NOT NULL AND expires_at > ?) OR (expires_at IS NULL AND created_at > ?))
    GROUP BY other_id, other_name
    ORDER BY last_msg_time DESC
  `).all(req.user.id, req.user.id, req.user.id, req.user.id, now, defaultCutoff);
  res.json(convos);
});

function getOrCreateDmSalt(id1, id2) {
  const [a, b] = [id1, id2].sort();
  let row = db.prepare('SELECT salt FROM dm_salts WHERE user_a = ? AND user_b = ?').get(a, b);
  if (!row) {
    const salt = require('crypto').randomBytes(16).toString('hex');
    db.prepare('INSERT INTO dm_salts (user_a, user_b, salt) VALUES (?, ?, ?)').run(a, b, salt);
    return salt;
  }
  return row.salt;
}

// GET DM messages
router.get('/:userId', authMiddleware, (req, res) => {
  try {
    const now = Date.now();
    const defaultCutoff = now - MSG_TTL;
    const msgs = db.prepare(`
      SELECT id, sender_id, sender_name, receiver_id, receiver_name, content,
             read_once, is_read, edited, edited_at, reply_to_id, reply_preview, reply_author, expires_at, created_at
      FROM dm_messages
      WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
        AND ((expires_at IS NOT NULL AND expires_at > ?) OR (expires_at IS NULL AND created_at > ?))
      ORDER BY created_at ASC LIMIT 200
    `).all(req.user.id, req.params.userId, req.params.userId, req.user.id, now, defaultCutoff);

    // Side-effect free GET: filter messages that are read-once and already read by the receiver
    const userId = req.user.id;
    const filtered = msgs.filter(m => {
      if (!m.read_once) return true;
      if (m.sender_id === userId) return true;
      return !m.is_read;
    });

    // BUG FIX: Include DM-specific salt
    const salt = getOrCreateDmSalt(req.user.id, req.params.userId);
    res.json({ messages: filtered, salt });
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// POST mark DM as read (for read-once logic)
router.post('/read/:id', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const msg = db.prepare('SELECT id, sender_id, receiver_id, read_once FROM dm_messages WHERE id = ?').get(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found.' });

    if (msg.receiver_id !== userId && msg.sender_id !== userId) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    if (msg.read_once && msg.receiver_id === userId) {
      db.prepare('UPDATE dm_messages SET is_read = 1 WHERE id = ?').run(msg.id);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// GET blocked users list
router.get('/blocked', authMiddleware, (req, res) => {
  const rows = db.prepare(
    'SELECT u.id, u.username FROM blocked_users b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ?'
  ).all(req.user.id);
  res.json(rows);
});

// POST block a user
router.post('/block/:userId', authMiddleware, (req, res) => {
  try {
    if (req.params.userId === req.user.id) return res.status(400).json({ error: 'Cannot block yourself.' });
    db.prepare('INSERT OR IGNORE INTO blocked_users (blocker_id, blocked_id) VALUES (?, ?)').run(req.user.id, req.params.userId);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Server error.' }); }
});

// DELETE unblock a user
router.delete('/block/:userId', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?').run(req.user.id, req.params.userId);
  res.json({ success: true });
});

// POST new DM
router.post('/:userId', authMiddleware, (req, res) => {
  try {
    const { content, read_once, reply_to_id, reply_preview, reply_author, ttl_minutes } = req.body;
    if (!content) return res.status(400).json({ error: 'Message cannot be empty.' });
    const receiver = db.prepare('SELECT id, username FROM users WHERE id = ?').get(req.params.userId);
    if (!receiver) return res.status(404).json({ error: 'User not found.' });
    // Check if either party has blocked the other
    const blocked = db.prepare(
      'SELECT 1 FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)'
    ).get(req.user.id, receiver.id, receiver.id, req.user.id);
    if (blocked) return res.status(403).json({ error: 'This conversation is blocked.' });
    const id = uuidv4();
    const now = Date.now();
    const readOnce = read_once ? 1 : 0;
    const expiresAt = ttl_minutes ? now + ttl_minutes * 60 * 1000 : null;
    db.prepare(`
      INSERT INTO dm_messages (id, sender_id, sender_name, receiver_id, receiver_name, content, read_once, reply_to_id, reply_preview, reply_author, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.user.id, req.user.username, receiver.id, receiver.username, content, readOnce,
           reply_to_id || null, reply_preview || null, reply_author || null, expiresAt, now);
    res.json({ id, sender_id: req.user.id, sender_name: req.user.username,
               receiver_id: receiver.id, receiver_name: receiver.username,
               content, read_once: readOnce, reply_to_id, reply_preview, reply_author, expires_at: expiresAt, created_at: now });
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// PATCH edit DM
router.patch('/:id', authMiddleware, (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Content cannot be empty.' });
    const msg = db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found.' });
    if (msg.sender_id !== req.user.id) return res.status(403).json({ error: 'Not your message.' });
    const now = Date.now();
    db.prepare('UPDATE dm_messages SET content = ?, edited = 1, edited_at = ? WHERE id = ?').run(content, now, req.params.id);
    res.json({ success: true, id: req.params.id, content, edited: 1, edited_at: now });
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// DELETE burn DM
router.delete('/:id', authMiddleware, (req, res) => {
  const msg = db.prepare('SELECT * FROM dm_messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found.' });
  if (msg.sender_id !== req.user.id) return res.status(403).json({ error: 'Not your message.' });
  db.prepare('DELETE FROM dm_messages WHERE id = ?').run(req.params.id);
  res.json({ success: true, id: req.params.id });
});

module.exports = router;
