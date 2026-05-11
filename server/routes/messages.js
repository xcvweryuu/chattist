const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, MSG_TTL }  = require('../db');
const { authMiddleware, checkGroupAccess } = require('../middleware/auth');

const router = express.Router();

/**
 * Validation helper for message inputs
 */
function validateMessage(content, ttl_minutes) {
  if (!content || typeof content !== 'string') return 'Message content is required.';
  if (content.length > 5000) return 'Message is too long.';
  if (ttl_minutes && (isNaN(ttl_minutes) || ttl_minutes < 1 || ttl_minutes > 525600)) {
    return 'Invalid TTL value.';
  }
  return null;
}

// GET messages
router.get('/:groupId', authMiddleware, checkGroupAccess, (req, res) => {
  try {
    const now = Date.now();
    const defaultCutoff = now - MSG_TTL;
    const msgs = db.prepare(`
      SELECT id, group_id, user_id, username, content, read_once,
             edited, edited_at, reply_to_id, reply_preview, reply_author, expires_at, created_at
      FROM messages
      WHERE group_id = ?
        AND ((expires_at IS NOT NULL AND expires_at > ?) OR (expires_at IS NULL AND created_at > ?))
      ORDER BY created_at ASC LIMIT 200
    `).all(req.params.groupId, now, defaultCutoff);

    // BUG FIX: Efficient read tracking using JOIN table
    const userId = req.user.id;
    const filtered = msgs.filter(m => {
      if (!m.read_once) return true;
      if (m.user_id === userId) return true;
      const read = db.prepare('SELECT 1 FROM message_reads WHERE message_id = ? AND user_id = ?').get(m.id, userId);
      return !read;
    });

    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// POST mark message as read (for read-once logic)
router.post('/:id/read', authMiddleware, (req, res) => {
  try {
    const userId = req.user.id;
    const msg = db.prepare('SELECT id, group_id, user_id, read_once FROM messages WHERE id = ?').get(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found.' });

    // Check access to group
    const membership = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(msg.group_id, userId);
    if (!membership) return res.status(403).json({ error: 'Access denied.' });

    if (msg.read_once && msg.user_id !== userId) {
      // BUG FIX: Use message_reads table
      db.prepare('INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)').run(msg.id, userId);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// POST new message
router.post('/:groupId', authMiddleware, checkGroupAccess, (req, res) => {
  try {
    const { content, read_once, reply_to_id, reply_preview, reply_author, ttl_minutes } = req.body;
    
    const err = validateMessage(content, ttl_minutes);
    if (err) return res.status(400).json({ error: err });

    const id = uuidv4();
    const now = Date.now();
    const readOnce = read_once ? 1 : 0;
    const expiresAt = ttl_minutes ? now + ttl_minutes * 60 * 1000 : null;
    
    db.prepare(`
      INSERT INTO messages (id, group_id, user_id, username, content, read_once, reply_to_id, reply_preview, reply_author, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.params.groupId, req.user.id, req.user.username, content, readOnce,
           reply_to_id || null, reply_preview || null, reply_author || null, expiresAt, now);
           
    res.json({ id, group_id: req.params.groupId, user_id: req.user.id, username: req.user.username,
               content, read_once: readOnce, reply_to_id, reply_preview, reply_author, expires_at: expiresAt, created_at: now });
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// PATCH edit message
router.patch('/:id', authMiddleware, (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Content cannot be empty.' });
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found.' });
    if (msg.user_id !== req.user.id) return res.status(403).json({ error: 'Not your message.' });
    const now = Date.now();
    db.prepare('UPDATE messages SET content = ?, edited = 1, edited_at = ? WHERE id = ?').run(content, now, req.params.id);
    res.json({ success: true, id: req.params.id, content, edited: 1, edited_at: now });
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// DELETE burn message
router.delete('/my/:groupId', authMiddleware, (req, res) => {
  try {
    const result = db.prepare('DELETE FROM messages WHERE group_id = ? AND user_id = ?').run(req.params.groupId, req.user.id);
    res.json({ success: true, deleted: result.changes });
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found.' });
    if (msg.user_id !== req.user.id) return res.status(403).json({ error: 'Not your message.' });
    db.prepare('DELETE FROM messages WHERE id = ?').run(req.params.id);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
