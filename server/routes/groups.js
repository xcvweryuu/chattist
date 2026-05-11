const express  = require('express');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db }   = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.get('/', authMiddleware, (req, res) => {
  try {
    const groups = db.prepare(
      'SELECT id, name, (password_hash IS NOT NULL) as has_password, salt, created_at, created_by FROM groups ORDER BY created_at ASC'
    ).all();
    res.json(groups);
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Group name is required.' });
    const existing = db.prepare('SELECT id FROM groups WHERE name = ? COLLATE NOCASE').get(name.trim());
    if (existing) return res.status(409).json({ error: 'This group name already exists.' });
    const id = uuidv4();
    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    // SECURITY FIX: Generate unique salt for group E2EE
    const salt = crypto.randomBytes(16).toString('hex');
    
    db.transaction(() => {
      db.prepare('INSERT INTO groups (id, name, password_hash, created_by, salt) VALUES (?, ?, ?, ?, ?)').run(id, name.trim(), passwordHash, req.user.id, salt);
      db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(id, req.user.id);
    })();

    res.json({ id, name: name.trim(), has_password: !!password, salt });
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.post('/:id/verify', authMiddleware, async (req, res) => {
  try {
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found.' });
    
    let valid = true;
    if (group.password_hash) {
      valid = await bcrypt.compare(req.body.password || '', group.password_hash);
    }
    
    if (valid) {
      // Add to group_members if valid
      db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)')
        .run(group.id, req.user.id);
    }
    
    // BUG FIX: Include salt so client can derive correct E2EE key
    res.json({ valid, salt: valid ? group.salt : null });
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

// POST generate invite link for a group (24h expiry)
router.post('/:id/invite', authMiddleware, (req, res) => {
  try {
    const { one_time } = req.body; // BUG FIX: Read one_time flag
    const group = db.prepare('SELECT id, created_by FROM groups WHERE id = ?').get(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found.' });
    
    // Authorization: Must be creator or existing member
    const membership = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(group.id, req.user.id);
    if (!membership && group.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied. You must be a member to invite others.' });
    }

    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    // BUG FIX: Save one_time flag
    db.prepare('INSERT INTO invite_links (token, group_id, created_by, expires_at, one_time) VALUES (?, ?, ?, ?, ?)')
      .run(token, group.id, req.user.id, expiresAt, one_time ? 1 : 0);
    res.json({ token, expires_at: expiresAt });
  } catch(e) { res.status(500).json({ error: 'Server error.' }); }
});

// GET validate invite token (no auth required so anyone can join)
router.get('/invite/:token', authMiddleware, (req, res) => {
  const link = db.prepare('SELECT * FROM invite_links WHERE token = ?').get(req.params.token);
  if (!link || link.expires_at < Date.now()) {
    return res.status(404).json({ error: 'Invite link is invalid or expired.' });
  }
  const group = db.prepare('SELECT id, name, salt, (password_hash IS NOT NULL) as has_password FROM groups WHERE id = ?').get(link.group_id);
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  
  // Automatically join the user if they are authenticated
  try {
    db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)')
      .run(group.id, req.user.id);

    // BUG FIX: Delete link if it's one-time
    if (link.one_time) {
      db.prepare('DELETE FROM invite_links WHERE token = ?').run(req.params.token);
    }
  } catch (e) {
    // ignore
  }

  res.json({ valid: true, groupId: group.id, groupName: group.name, hasPassword: group.has_password, salt: group.salt });
});

router.delete('/:id', authMiddleware, (req, res) => {
  try {
    const group = db.prepare('SELECT created_by FROM groups WHERE id = ?').get(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found.' });

    // Authorization: Only the creator can delete the group
    if (group.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Only the group creator can delete this group.' });
    }

    db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
