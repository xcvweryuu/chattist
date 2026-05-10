/**
 * socket.js — WebSocket client
 * Note: connectWebSocket() must be called MANUALLY after setting up wsOn listeners!
 */

let ws             = null;
let wsReady        = false;
let reconnectTimer = null;
let reconnectDelay = 2000;
const listeners    = {};

function wsOn(type, cb) {
  if (!listeners[type]) listeners[type] = [];
  listeners[type].push(cb);
}

function wsEmit(type, data) {
  if (listeners[type]) listeners[type].forEach(cb => { try { cb(data); } catch(e) { console.error('[ws] listener error:', e); } });
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function connectWebSocket() {
  const token = getToken();
  if (!token) { console.warn('[ws] No token, skipping connection.'); return; }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return; // Already connected
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url   = proto + '//' + location.host;

  console.log('[ws] Connecting:', url);
  ws = new WebSocket(url);

  ws.onopen = () => {
    wsReady = true;
    reconnectDelay = 2000;
    clearTimeout(reconnectTimer);
    console.log('[ws] Connection open, sending auth...');
    ws.send(JSON.stringify({ type: 'auth', token: getToken() }));
    wsEmit('connected', {});
  };

  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    console.log('[ws] Message:', msg.type);
    wsEmit(msg.type, msg);
    if (msg.type === 'group_message') wsEmit('new_group_message', msg);
    if (msg.type === 'dm_message')    wsEmit('new_dm_message', msg);
    if (msg.type === 'burn_message')  wsEmit('message_burned', msg);
  };

  ws.onclose = (evt) => {
    wsReady = false;
    console.log('[ws] Connection closed:', evt.code, evt.reason);
    wsEmit('disconnected', {});
    // Auto reconnect
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
      connectWebSocket();
    }, reconnectDelay);
  };

  ws.onerror = (e) => { console.error('[ws] Error:', e); };
}

// Helper functions
function wsJoinGroup(groupId)  { wsSend({ type: 'join_group', groupId }); }
function wsLeaveGroup(groupId) { wsSend({ type: 'leave_group', groupId }); }
function wsJoinDm(otherId)     { wsSend({ type: 'join_dm', otherId }); }
function wsSendGroupMessage(id, groupId, content, created_at) {
  wsSend({ type: 'group_message', id, groupId, content, created_at });
}
function wsSendDmMessage(id, receiverId, receiverName, content, created_at) {
  wsSend({ type: 'dm_message', id, receiverId, receiverName, content, created_at });
}
function wsBurnMessage(id, groupId) { wsSend({ type: 'burn_message', id, groupId }); }
function wsTyping(groupId)          { wsSend({ type: 'typing', groupId }); }
function wsMessageEdited(id, groupId, content, edited_at) { wsSend({ type: 'message_edited', id, groupId, content, edited_at }); }
function wsDmMessageEdited(id, receiverId, content, edited_at) { wsSend({ type: 'dm_message_edited', id, receiverId, content, edited_at }); }
function wsDmViewed(otherId) { wsSend({ type: 'dm_viewed', otherId }); }

// Reconnect when user returns to page
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (!ws || ws.readyState === WebSocket.CLOSED)) {
    connectWebSocket();
  }
});
