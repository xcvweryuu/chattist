/**
 * api.js — HTTP API client
 */

const API_BASE = window.location.origin + '/api';

// SECURITY FIX: Access token stored in memory ONLY (protected from XSS extraction)
let ACCESS_TOKEN = null;

function getToken() {
  return ACCESS_TOKEN;
}
function setToken(token) {
  ACCESS_TOKEN = token;
}
function clearToken() {
  ACCESS_TOKEN = null;
  localStorage.removeItem('chattist_current_user');
}

/** 
 * SECURITY FIX: Silent refresh on page load or when token is missing.
 * Uses HttpOnly refresh cookie which is automatically sent by browser.
 */
async function silentRefresh() {
  try {
    const res = await fetch(API_BASE + '/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.token) {
        setToken(data.token);
        return true;
      }
    }
  } catch (e) {}
  return false;
}
function setCurrentUser(user) {
  localStorage.setItem('chattist_current_user', JSON.stringify(user));
}
function getCurrentUser() {
  try { return JSON.parse(localStorage.getItem('chattist_current_user') || 'null'); }
  catch { return null; }
}

async function apiFetch(path, options) {
  options = options || {};
  var token   = getToken();
  var headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if (token) headers['Authorization'] = 'Bearer ' + token;

  if (typeof window !== 'undefined' && window.CHATTIST_DEBUG === true) {
    console.log('[api]', (options.method || 'GET'), path);
  }

  var res  = await fetch(API_BASE + path, Object.assign({}, options, { credentials: 'same-origin', headers: headers }));
  var data = await res.json().catch(function() { return {}; });

  if (!res.ok) {
    console.error('[api] Error', res.status, path, data);
    throw new Error(data.error || ('HTTP ' + res.status));
  }
  return data;
}

// ── AUTH ──
async function registerUser(username, password) {
  try {
    var data = await apiFetch('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) });
    setToken(data.token);
    setCurrentUser({ username: data.username, id: data.id });
    return { success: true };
  } catch(e) { return { success: false, error: e.message }; }
}

async function loginUser(username, password) {
  try {
    var data = await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    setToken(data.token);
    setCurrentUser({ username: data.username, id: data.id });
    return { success: true };
  } catch(e) { return { success: false, error: e.message }; }
}

async function logoutUser() {
  try {
    await fetch(API_BASE + '/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) { /* offline */ }
  clearToken();
}

async function deleteAccount(password) {
  try {
    await apiFetch('/auth/account', { method: 'DELETE', body: JSON.stringify({ password }) });
    clearToken();
    return { success: true };
  } catch(e) { return { success: false, error: e.message }; }
}

async function getUsers() {
  try { return await apiFetch('/auth/users'); }
  catch(e) { console.error('[api] getUsers error:', e); return []; }
}

// ── GROUPS ──
async function getGroups() {
  try { return await apiFetch('/groups'); }
  catch(e) { console.error('[api] getGroups error:', e); return []; }
}

async function createNewGroup(name, password) {
  try {
    var body = { name: name };
    if (password) body.password = password;
    var data = await apiFetch('/groups', { method: 'POST', body: JSON.stringify(body) });
    return { success: true, id: data.id, name: data.name };
  } catch(e) { return { success: false, error: e.message }; }
}

async function verifyGroupPassword(groupId, password) {
  try {
    return await apiFetch('/groups/' + groupId + '/verify', { method: 'POST', body: JSON.stringify({ password: password }) });
  } catch { return { valid: false }; }
}

async function deleteGroup(groupId) {
  return await apiFetch('/groups/' + groupId, { method: 'DELETE' });
}

// ── GROUP MESSAGES ──
async function getMessages(groupId) {
  try { return await apiFetch('/messages/' + groupId); }
  catch(e) { console.error('[api] getMessages error:', e); return []; }
}

async function postMessage(groupId, encryptedContent, readOnce, replyToId, replyPreview, replyAuthor, ttlMinutes) {
  try {
    var data = await apiFetch('/messages/' + groupId, {
      method: 'POST',
      body: JSON.stringify({ content: encryptedContent, read_once: !!readOnce,
        reply_to_id: replyToId || null, reply_preview: replyPreview || null,
        reply_author: replyAuthor || null, ttl_minutes: ttlMinutes || null })
    });
    return data;
  } catch(e) {
    console.error('[api] postMessage error:', e);
    throw e;
  }
}

async function editMessage(messageId, encryptedContent) {
  try {
    return await apiFetch('/messages/' + messageId, { method: 'PATCH', body: JSON.stringify({ content: encryptedContent }) });
  } catch(e) { return { success: false, error: e.message }; }
}

async function burnMessage(messageId) {
  try {
    await apiFetch('/messages/' + messageId, { method: 'DELETE' });
    return { success: true };
  } catch(e) { return { success: false, error: e.message }; }
}

async function deleteMyMessages(groupId) {
  try {
    await apiFetch('/messages/my/' + groupId, { method: 'DELETE' });
    return { success: true };
  } catch(e) { return { success: false, error: e.message }; }
}

// ── DM ──
async function getDmConversations() {
  try { return await apiFetch('/dm'); }
  catch(e) { console.error('[api] getDmConversations error:', e); return []; }
}

async function getDmMessages(userId) {
  try { return await apiFetch('/dm/' + userId); }
  catch(e) { console.error('[api] getDmMessages error:', e); return []; }
}

async function postDmMessage(userId, encryptedContent, readOnce, replyToId, replyPreview, replyAuthor, ttlMinutes) {
  try {
    var data = await apiFetch('/dm/' + userId, {
      method: 'POST',
      body: JSON.stringify({ content: encryptedContent, read_once: !!readOnce,
        reply_to_id: replyToId || null, reply_preview: replyPreview || null,
        reply_author: replyAuthor || null, ttl_minutes: ttlMinutes || null })
    });
    return data;
  } catch(e) {
    console.error('[api] postDmMessage error:', e);
    throw e;
  }
}

async function editDmMessage(messageId, encryptedContent) {
  try {
    return await apiFetch('/dm/' + messageId, { method: 'PATCH', body: JSON.stringify({ content: encryptedContent }) });
  } catch(e) { return { success: false, error: e.message }; }
}

async function burnDmMessage(messageId) {
  try {
    await apiFetch('/dm/' + messageId, { method: 'DELETE' });
    return { success: true };
  } catch(e) { return { success: false, error: e.message }; }
}

// ── DM BLOCKING ──
async function blockUser(userId) {
  try { return await apiFetch('/dm/block/' + userId, { method: 'POST' }); }
  catch(e) { return { success: false, error: e.message }; }
}

async function unblockUser(userId) {
  try { return await apiFetch('/dm/block/' + userId, { method: 'DELETE' }); }
  catch(e) { return { success: false, error: e.message }; }
}

async function getBlockedUsers() {
  try { return await apiFetch('/dm/blocked'); }
  catch(e) { return []; }
}

// ── GROUP INVITES ──
async function createGroupInvite(groupId) {
  try { return await apiFetch('/groups/' + groupId + '/invite', { method: 'POST' }); }
  catch(e) { return { success: false, error: e.message }; }
}

async function validateInvite(token) {
  try { return await apiFetch('/groups/invite/' + token); }
  catch(e) { return { valid: false, error: e.message }; }
}
