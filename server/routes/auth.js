const express      = require('express');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { db }       = require('../db');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

const REFRESH_COOKIE = 'chattist_refresh';
const ACCESS_EXPIRES = '1h';
const REFRESH_MS     = 7 * 24 * 60 * 60 * 1000;

function accessToken(id, username) {
  // SECURITY FIX: Added jti (JWT ID) for revocation
  const jti = uuidv4();
  return jwt.sign({ id, username, jti, typ: 'access' }, JWT_SECRET, { expiresIn: ACCESS_EXPIRES });
}

function refreshToken(id, username) {
  // SECURITY FIX: Added jti for revocation
  const jti = uuidv4();
  return jwt.sign({ id, username, jti, typ: 'refresh' }, JWT_SECRET, { expiresIn: '7d' });
}

/** Blacklist a JTI until its expiry (approx 7 days for safety) */
function blacklistToken(jti) {
  if (!jti) return;
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  db.prepare('INSERT OR IGNORE INTO jti_blacklist (jti, expires_at) VALUES (?, ?)').run(jti, expiresAt);
}

function setRefreshCookie(res, id, username) {
  const token = refreshToken(id, username);
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: REFRESH_MS,
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { path: '/', sameSite: 'strict' });
}

function touchLogin(userId) {
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), userId);
}

router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    const u = String(username).trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(u)) return res.status(400).json({ error: 'Username: 3–20 chars, lowercase letters, numbers, underscore only.' });
    if (password.length < 8) return res.status(400).json({ error: 'Passcode must be at least 8 characters.' });
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(u);
    if (existing) return res.status(409).json({ error: 'This username is already taken.' });
    const passwordHash = await bcrypt.hash(password, 12);
    const id = uuidv4();
    const now = Date.now();
    db.prepare('INSERT INTO users (id, username, password_hash, last_login_at) VALUES (?, ?, ?, ?)').run(id, u, passwordHash, now);
    const token = accessToken(id, u);
    setRefreshCookie(res, id, u);
    res.json({ token, username: u, id });
  } catch (e) {
    console.error('[auth] register error');
    res.status(500).json({ error: 'Server error.' });
  }
});

// Dummy hash for timing attack mitigation
const DUMMY_HASH = '$2a$12$K9vB1W/7lF4A6A8/X8y7.e7z7z7z7z7z7z7z7z7z7z7z7z7z7z7z7';

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    
    const u = String(username).trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(u);
    
    const hashToCompare = user ? user.password_hash : DUMMY_HASH;
    const valid = await bcrypt.compare(password, hashToCompare);
    
    if (!user || !valid) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    
    touchLogin(user.id);
    const token = accessToken(user.id, user.username);
    setRefreshCookie(res, user.id, user.username);
    res.json({ token, username: user.username, id: user.id });
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

/** New access token using HttpOnly refresh cookie (no Bearer required). */
router.post('/refresh', (req, res) => {
  try {
    const raw = req.cookies && req.cookies[REFRESH_COOKIE];
    if (!raw) return res.status(401).json({ error: 'No refresh session.' });
    const payload = jwt.verify(raw, JWT_SECRET);
    if (payload.typ !== 'refresh') return res.status(401).json({ error: 'Invalid refresh token.' });
    const row = db.prepare('SELECT id, username FROM users WHERE id = ?').get(payload.id);
    if (!row) {
      clearRefreshCookie(res);
      return res.status(401).json({ error: 'Account no longer exists.' });
    }
    touchLogin(row.id);
    const token = accessToken(row.id, row.username);
    setRefreshCookie(res, row.id, row.username);
    res.json({ token });
  } catch {
    clearRefreshCookie(res);
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
});

router.post('/logout', authMiddleware, (req, res) => {
  // SECURITY FIX: Blacklist JTI and revoke WS
  blacklistToken(req.user.jti);
  const revoke = req.app.get('revokeSession');
  if (revoke) revoke(req.user.jti);

  clearRefreshCookie(res);
  res.json({ ok: true });
});

router.get('/me', authMiddleware, (req, res) => {
  res.json({ username: req.user.username, id: req.user.id });
});

router.get('/users', authMiddleware, (req, res) => {
  try {
    // Only return users who share at least one group with the requester
    const users = db.prepare(`
      SELECT DISTINCT u.id, u.username 
      FROM users u
      JOIN group_members gm1 ON gm1.user_id = u.id
      JOIN group_members gm2 ON gm2.group_id = gm1.group_id
      WHERE gm2.user_id = ? AND u.id != ?
      ORDER BY u.username
    `).all(req.user.id, req.user.id);
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.post('/panic', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    // SECURITY FIX: Blacklist and revoke
    blacklistToken(req.user.jti);
    const revoke = req.app.get('revokeSession');
    if (revoke) revoke(req.user.jti);

    db.prepare('DELETE FROM messages WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM dm_messages WHERE sender_id = ? OR receiver_id = ?').run(userId, userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    clearRefreshCookie(res);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

router.delete('/account', authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Wrong password.' });

    // SECURITY FIX: Blacklist and revoke
    blacklistToken(req.user.jti);
    const revoke = req.app.get('revokeSession');
    if (revoke) revoke(req.user.jti);

    db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
    clearRefreshCookie(res);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = router;
