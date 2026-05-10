const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const db = new Database(path.join(__dirname, 'chattist.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
    last_login_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS groups (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    password_hash TEXT,
    created_by    TEXT,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    joined_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
    PRIMARY KEY (group_id, user_id),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS messages (
    id           TEXT PRIMARY KEY,
    group_id     TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    username     TEXT NOT NULL,
    content      TEXT NOT NULL,
    read_once    INTEGER NOT NULL DEFAULT 0,
    read_by      TEXT NOT NULL DEFAULT '',
    edited       INTEGER NOT NULL DEFAULT 0,
    edited_at    INTEGER,
    reply_to_id  TEXT,
    reply_preview TEXT,
    reply_author TEXT,
    expires_at   INTEGER,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );
  CREATE TABLE IF NOT EXISTS dm_messages (
    id            TEXT PRIMARY KEY,
    sender_id     TEXT NOT NULL,
    sender_name   TEXT NOT NULL,
    receiver_id   TEXT NOT NULL,
    receiver_name TEXT NOT NULL,
    content       TEXT NOT NULL,
    read_once     INTEGER NOT NULL DEFAULT 0,
    is_read       INTEGER NOT NULL DEFAULT 0,
    edited        INTEGER NOT NULL DEFAULT 0,
    edited_at     INTEGER,
    reply_to_id   TEXT,
    reply_preview TEXT,
    reply_author  TEXT,
    expires_at    INTEGER,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );
  CREATE TABLE IF NOT EXISTS blocked_users (
    blocker_id  TEXT NOT NULL,
    blocked_id  TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
    PRIMARY KEY (blocker_id, blocked_id)
  );
  CREATE TABLE IF NOT EXISTS message_reads (
    message_id TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    read_at    INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
    PRIMARY KEY (message_id, user_id),
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS dm_salts (
    user_a TEXT NOT NULL,
    user_b TEXT NOT NULL,
    salt   TEXT NOT NULL,
    PRIMARY KEY (user_a, user_b)
  );
  CREATE TABLE IF NOT EXISTS jti_blacklist (
    jti        TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invite_links (
    token      TEXT PRIMARY KEY,
    group_id   TEXT NOT NULL,
    created_by TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    one_time   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_dm_messages_pair ON dm_messages(sender_id, receiver_id, created_at);
`);

// Migrations for existing tables
const groupCols = db.pragma('table_info(groups)').map(c => c.name);
if (!groupCols.includes('created_by')) {
  db.exec('ALTER TABLE groups ADD COLUMN created_by TEXT');
}
if (!groupCols.includes('salt')) {
  // BUG FIX: Add salt column for per-group encryption
  db.exec('ALTER TABLE groups ADD COLUMN salt TEXT');
  const groups = db.prepare('SELECT id FROM groups WHERE salt IS NULL').all();
  const crypto = require('crypto');
  const updateSalt = db.prepare('UPDATE groups SET salt = ? WHERE id = ?');
  for (const g of groups) {
    updateSalt.run(crypto.randomBytes(16).toString('hex'), g.id);
  }
}

const inviteCols = db.pragma('table_info(invite_links)').map(c => c.name);
if (!inviteCols.includes('one_time')) {
  // BUG FIX: Add one_time column for invite links
  db.exec('ALTER TABLE invite_links ADD COLUMN one_time INTEGER NOT NULL DEFAULT 0');
}

const userCols = db.pragma('table_info(users)').map(c => c.name);
if (!userCols.includes('last_login_at')) {
  db.exec('ALTER TABLE users ADD COLUMN last_login_at INTEGER');
  db.prepare('UPDATE users SET last_login_at = created_at WHERE last_login_at IS NULL').run();
}

const msgCols = db.pragma('table_info(messages)').map(c => c.name);
const dmCols  = db.pragma('table_info(dm_messages)').map(c => c.name);

if (!msgCols.includes('read_once'))   db.exec("ALTER TABLE messages ADD COLUMN read_once INTEGER NOT NULL DEFAULT 0");
if (!msgCols.includes('read_by'))     db.exec("ALTER TABLE messages ADD COLUMN read_by TEXT NOT NULL DEFAULT ''");
if (!msgCols.includes('edited'))      db.exec("ALTER TABLE messages ADD COLUMN edited INTEGER NOT NULL DEFAULT 0");
if (!msgCols.includes('edited_at'))   db.exec("ALTER TABLE messages ADD COLUMN edited_at INTEGER");
if (!msgCols.includes('reply_to_id')) db.exec("ALTER TABLE messages ADD COLUMN reply_to_id TEXT");
if (!msgCols.includes('reply_preview')) db.exec("ALTER TABLE messages ADD COLUMN reply_preview TEXT");
if (!msgCols.includes('reply_author')) db.exec("ALTER TABLE messages ADD COLUMN reply_author TEXT");
if (!msgCols.includes('expires_at'))  db.exec("ALTER TABLE messages ADD COLUMN expires_at INTEGER");

if (!dmCols.includes('read_once'))    db.exec("ALTER TABLE dm_messages ADD COLUMN read_once INTEGER NOT NULL DEFAULT 0");
if (!dmCols.includes('is_read'))      db.exec("ALTER TABLE dm_messages ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0");
if (!dmCols.includes('edited'))       db.exec("ALTER TABLE dm_messages ADD COLUMN edited INTEGER NOT NULL DEFAULT 0");
if (!dmCols.includes('edited_at'))    db.exec("ALTER TABLE dm_messages ADD COLUMN edited_at INTEGER");
if (!dmCols.includes('reply_to_id'))  db.exec("ALTER TABLE dm_messages ADD COLUMN reply_to_id TEXT");
if (!dmCols.includes('reply_preview')) db.exec("ALTER TABLE dm_messages ADD COLUMN reply_preview TEXT");
if (!dmCols.includes('reply_author'))  db.exec("ALTER TABLE dm_messages ADD COLUMN reply_author TEXT");
if (!dmCols.includes('expires_at'))   db.exec("ALTER TABLE dm_messages ADD COLUMN expires_at INTEGER");

// Ensure default "general" group exists
const defaultGroup = db.prepare("SELECT id FROM groups WHERE name = 'general' LIMIT 1").get();
if (!defaultGroup) {
  db.prepare("INSERT INTO groups (id, name, password_hash, created_by) VALUES (?, 'general', NULL, NULL)")
    .run(uuidv4());
  if (process.env.CHATTIST_DEBUG === '1') console.log('[db] default group "general" created.');
}

const MSG_TTL = 24 * 60 * 60 * 1000;

function cleanOldMessages() {
  const now = Date.now();
  const defaultCutoff = now - MSG_TTL;
  
  const deleteExpired = db.transaction(() => {
    const r1 = db.prepare(`
      DELETE FROM messages WHERE
        (expires_at IS NOT NULL AND expires_at < ?) OR
        (expires_at IS NULL AND created_at < ?)
    `).run(now, defaultCutoff);
    const r2 = db.prepare(`
      DELETE FROM dm_messages WHERE
        (expires_at IS NOT NULL AND expires_at < ?) OR
        (expires_at IS NULL AND created_at < ?)
    `).run(now, defaultCutoff);
    return r1.changes + r2.changes;
  });

  const totalChanges = deleteExpired();
  if (totalChanges > 0) {
    console.log(`[db] Deleted ${totalChanges} expired messages.`);
  }
}

const INACTIVE_MS = 90 * 24 * 60 * 60 * 1000;

function purgeInactiveAccounts() {
  const cutoff = Date.now() - INACTIVE_MS;
  const stale = db.prepare('SELECT id FROM users WHERE last_login_at IS NOT NULL AND last_login_at < ?').all(cutoff);
  
  if (stale.length === 0) return;

  const deleteStale = db.transaction((users) => {
    let n = 0;
    for (const u of users) {
      db.prepare('DELETE FROM messages WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM dm_messages WHERE sender_id = ? OR receiver_id = ?').run(u.id, u.id);
      db.prepare('DELETE FROM blocked_users WHERE blocker_id = ? OR blocked_id = ?').run(u.id, u.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      n++;
    }
    return n;
  });

  try {
    const n = deleteStale(stale);
    if (n > 0 && process.env.CHATTIST_DEBUG === '1') {
      console.log('[db] Purged inactive accounts:', n);
    }
  } catch (e) {
    console.error('[db] Error purging inactive accounts:', e.message);
  }
}

cleanOldMessages();
setInterval(cleanOldMessages, 60 * 60 * 1000);
purgeInactiveAccounts();
setInterval(purgeInactiveAccounts, 24 * 60 * 60 * 1000);

module.exports = { db, cleanOldMessages, purgeInactiveAccounts, MSG_TTL };
