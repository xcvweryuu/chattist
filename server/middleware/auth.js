/**
 * middleware/auth.js — JWT token verification
 */

const jwt = require('jsonwebtoken');
const { db } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('FATAL: JWT_SECRET environment variable is not set in production.');
}
const ACTUAL_SECRET = process.env.JWT_SECRET;
if (!ACTUAL_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is not set.');
}

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, ACTUAL_SECRET);
    if (payload.typ === 'refresh') {
      return res.status(401).json({ error: 'Invalid token type.' });
    }

    // SECURITY FIX: JWT Token Blacklisting check
    const blacklisted = db.prepare('SELECT 1 FROM jti_blacklist WHERE jti = ?').get(payload.jti);
    if (blacklisted) {
      return res.status(401).json({ error: 'Session has been revoked. Please log in again.' });
    }

    req.user = { id: payload.id, username: payload.username, jti: payload.jti };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }
}

/**
 * Middleware to verify user is a member of a group.
 * Assumes authMiddleware has already run and req.params.groupId is set.
 */
function checkGroupAccess(req, res, next) {
  const groupId = req.params.groupId;
  const userId = req.user.id;

  if (!groupId) return res.status(400).json({ error: 'Group ID is required.' });

  try {
    const membership = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
    if (membership) return next();

    // Not a member? Check if the group is public (no password)
    const group = db.prepare('SELECT password_hash FROM groups WHERE id = ?').get(groupId);
    if (!group) return res.status(404).json({ error: 'Group not found.' });

    if (!group.password_hash) {
      // Auto-join public group
      db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)').run(groupId, userId);
      return next();
    }

    return res.status(403).json({ error: 'Access denied. You are not a member of this group.' });
  } catch (e) {
    res.status(500).json({ error: 'Server error during authorization.' });
  }
}

module.exports = { authMiddleware, checkGroupAccess, JWT_SECRET: ACTUAL_SECRET };
