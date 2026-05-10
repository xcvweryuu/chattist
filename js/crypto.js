/**
 * crypto.js — AES-256-GCM message encryption (browser Web Crypto)
 */

// Uint8Array → Base64
function uint8ToBase64(bytes) {
  var binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Base64 → Uint8Array
function base64ToUint8(b64) {
  var binary = atob(b64);
  var bytes   = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Legacy plaintext-as-base64 (pre-GCM); used only when AES-GCM decrypt fails */
function tryLegacyBase64Utf8(ciphertext) {
  try {
    return decodeURIComponent(escape(atob(ciphertext)));
  } catch (e) {
    return null;
  }
}

// SECURITY FIX: Removed shared global salt. Salts are now per-group/per-DM and provided by server.

// AES-GCM key from group ID and salt
async function getGroupKey(groupId, salt) {
  var enc = new TextEncoder();
  var keyMat = await window.crypto.subtle.importKey(
    'raw', enc.encode('chattist-v1:' + salt),
    { name: 'PBKDF2' }, false, ['deriveKey']
  );
  return window.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(groupId + ':' + salt), iterations: 600000, hash: 'SHA-256' },
    keyMat,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt']
  );
}

// AES-GCM key for DMs — derived from sorted pair of user IDs and salt
async function getDmKey(userId1, userId2, salt) {
  var sorted = [userId1, userId2].sort().join(':');
  var enc = new TextEncoder();
  var keyMat = await window.crypto.subtle.importKey(
    'raw', enc.encode('chattist-v1:dm:' + salt),
    { name: 'PBKDF2' }, false, ['deriveKey']
  );
  return window.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('dm:' + sorted + ':' + salt), iterations: 600000, hash: 'SHA-256' },
    keyMat,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt']
  );
}

// Encrypt message
async function encryptMessage(text, groupId, salt) {
  var key = await getGroupKey(groupId, salt);
  var enc = new TextEncoder();
  var iv  = window.crypto.getRandomValues(new Uint8Array(12));
  var buf = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(text));
  var combined = new Uint8Array(12 + buf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(buf), 12);
  return uint8ToBase64(combined);
}

// Encrypt DM message (uses sorted pair key and salt)
async function encryptDmMessage(text, myId, otherId, salt) {
  var key = await getDmKey(myId, otherId, salt);
  var enc = new TextEncoder();
  var iv  = window.crypto.getRandomValues(new Uint8Array(12));
  var buf = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(text));
  var combined = new Uint8Array(12 + buf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(buf), 12);
  return uint8ToBase64(combined);
}

// Decrypt DM message
async function decryptDmMessage(ciphertext, myId, otherId, salt) {
  try {
    var key      = await getDmKey(myId, otherId, salt);
    var combined = base64ToUint8(ciphertext);
    if (combined.length < 13) throw new Error('short');
    var iv       = combined.slice(0, 12);
    var data     = combined.slice(12);
    var buf      = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data);
    return new TextDecoder().decode(buf);
  } catch (e) {
    var legacy = tryLegacyBase64Utf8(ciphertext);
    if (legacy !== null) return legacy;
    throw new Error('Could not decrypt message');
  }
}

// Decrypt message
async function decryptMessage(ciphertext, groupId, salt) {
  try {
    var key      = await getGroupKey(groupId, salt);
    var combined = base64ToUint8(ciphertext);
    if (combined.length < 13) throw new Error('short');
    var iv       = combined.slice(0, 12);
    var data     = combined.slice(12);
    var buf      = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data);
    return new TextDecoder().decode(buf);
  } catch (e) {
    var legacy = tryLegacyBase64Utf8(ciphertext);
    if (legacy !== null) return legacy;
    throw new Error('Could not decrypt message');
  }
}
