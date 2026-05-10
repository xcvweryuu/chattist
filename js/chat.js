/**
 * chat.js — Chat logic refactored for production
 */

var currentMode     = null;
var currentId       = null;
var currentName     = null;
var pendingGroupId  = null;
var allUsers        = [];
var typingHideTimer = null;
var typingTimer     = null;
var replyTo         = null; // { id, author, preview }
var blockedUsers    = new Set(); // set of blocked user IDs
var currentInviteLink = '';
var currentGroupCreatedBy = null;

function prefsTypingEnabled() { return localStorage.getItem('chattist_typing') === '1'; }
function prefsReadReceiptsEnabled() { return localStorage.getItem('chattist_read_receipts') === '1'; }

// ── SOUND ──
var soundEnabled = localStorage.getItem('chattist_sound') !== 'false';
function playNotif() {
  if (!soundEnabled) return;
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var o = ctx.createOscillator(); var g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; o.type = 'sine';
    g.gain.setValueAtTime(.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + .3);
    o.start(ctx.currentTime); o.stop(ctx.currentTime + .3);
  } catch(e) {}
}

var currentGroupSalt = null; // Salt for current group
var currentDmSalt    = null; // Salt for current DM
var messageMap       = new Map(); // BUG FIX: Map to track rendered messages (Fix 10)

document.addEventListener('DOMContentLoaded', async function() {
  // SECURITY FIX: Silent refresh on load
  const ok = await silentRefresh();
  var user = getCurrentUser();
  if (!ok || !user) { window.location.href = 'index.html'; return; }

  const avatarEl = document.getElementById('user-avatar');
  const nameEl = document.getElementById('user-name-display');
  if (avatarEl) avatarEl.textContent = user.username[0].toUpperCase();
  if (nameEl) nameEl.textContent = user.username;

  wsOn('auth_ok',           function() { setWsStatus(true); loadGroups(); loadDmList(); });
  wsOn('disconnected',      function() { setWsStatus(false); });
  wsOn('new_group_message', onWsGroupMessage);
  wsOn('new_dm_message',    onWsDmMessage);
  wsOn('message_burned',    onWsBurnMessage);
  wsOn('typing',            onWsTyping);
  wsOn('message_edited',    onWsMessageEdited);
  wsOn('dm_message_edited', onWsDmMessageEdited);
  wsOn('dm_read',           onWsDmRead);
  wsOn('rate_limited',      function(m) { showToast(m.error); }); // BUG FIX: Handle rate limit event

  connectWebSocket();
  loadGroups(); loadDmList(); loadBlockedUsers(); initPrivacy(); checkInviteParam();

  var optT = document.getElementById('opt-typing');
  var optR = document.getElementById('opt-read');
  if (optT) {
    optT.checked = prefsTypingEnabled();
    optT.addEventListener('change', function() { localStorage.setItem('chattist_typing', optT.checked ? '1' : '0'); });
  }
  if (optR) {
    optR.checked = prefsReadReceiptsEnabled();
    optR.addEventListener('change', function() { localStorage.setItem('chattist_read_receipts', optR.checked ? '1' : '0'); });
  }

  var ta = document.getElementById('msg-input');
  if (ta) {
    ta.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
      if (currentMode === 'group' && currentId && prefsTypingEnabled()) {
        clearTimeout(typingTimer);
        typingTimer = setTimeout(function() { wsTyping(currentId); }, 400);
      }
    });
    ta.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSendMessage(); }
      if (e.key === 'Escape') cancelReply();
    });
  }

  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) sendBtn.addEventListener('click', doSendMessage);

  // Modal propagation stop
  ['group-pw-modal-content', 'modal-content', 'delete-account-modal-content', 'dm-users-modal-content', 'invite-modal-content'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', function(e) { e.stopPropagation(); });
  });

  // Button Click Listeners
  const btnMap = {
    'lock-logout-btn':       doLogout,
    'group-pw-cancel':       closeGroupPwModal,
    'group-pw-submit':       submitGroupPassword,
    'create-group-cancel':   closeModal,
    'create-group-submit':   doCreateGroup,
    'delete-account-cancel': function() { document.getElementById('delete-account-modal').classList.add('hidden'); },
    'delete-account-submit': doDeleteAccount,
    'dm-users-close':        function() { document.getElementById('dm-users-modal').classList.add('hidden'); },
    'invite-close':          function() { document.getElementById('invite-modal').classList.add('hidden'); },
    'copy-invite-btn':       copyInviteLink,
    'logout-btn':            doLogout,
    'clear-msgs-btn':        doDeleteMyMsgs,
    'new-group-btn-sidebar': openCreateGroup,
    'new-dm-btn-sidebar':    openDmUserModal,
    'mobile-menu-btn':       toggleSidebar,
    'block-btn':             toggleBlock,
    'invite-btn':            doCreateInvite,
    'delete-group-btn':      doDeleteGroup,
    'search-toggle-btn':     toggleSearch,
    'search-close-btn':      toggleSearch,
    'reply-bar-close':       cancelReply
  };

  Object.keys(btnMap).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', btnMap[id]);
  });

  const groupPwInput = document.getElementById('group-pw-input');
  if (groupPwInput) groupPwInput.addEventListener('keydown', function(e) { if(e.key==='Enter') submitGroupPassword(); });

  const newGroupName = document.getElementById('new-group-name');
  if (newGroupName) newGroupName.addEventListener('keydown', function(e) { if(e.key==='Enter') doCreateGroup(); });

  const dmSearch = document.getElementById('dm-search');
  if (dmSearch) dmSearch.addEventListener('input', filterUsers);

  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.addEventListener('input', doSearch);

  var roCheck = document.getElementById('read-once-check');
  var roLabel = document.getElementById('read-once-label');
  if (roCheck && roLabel) {
    roCheck.addEventListener('change', function() {
      roLabel.classList.toggle('active', roCheck.checked);
      if (roCheck.checked) showToast('View once: message will be deleted after reading.');
    });
  }
});

function setWsStatus(ok) {
  var el = document.getElementById('ws-status');
  if (!el) return;
  el.textContent = ok ? 'Online' : 'Connecting…';
  el.classList.toggle('user-status--online', ok);
}

// ── REPLY ──
function setReply(id, author, preview) {
  replyTo = { id, author, preview };
  const bar = document.getElementById('reply-bar');
  const authEl = document.getElementById('reply-bar-author');
  const textEl = document.getElementById('reply-bar-text');
  if (bar) bar.classList.remove('hidden');
  if (authEl) authEl.textContent = author;
  if (textEl) textEl.textContent = preview;
  const input = document.getElementById('msg-input');
  if (input) input.focus();
}
function cancelReply() {
  replyTo = null;
  const bar = document.getElementById('reply-bar');
  if (bar) bar.classList.add('hidden');
}

// ── SEARCH ──
var searchVisible = false;
function toggleSearch() {
  searchVisible = !searchVisible;
  const bar = document.getElementById('search-bar');
  const input = document.getElementById('search-input');
  if (bar) bar.classList.toggle('hidden', !searchVisible);
  if (searchVisible && input) { 
    setTimeout(function() { input.focus(); }, 50); 
  } else if (input) { 
    input.value = ''; doSearch(); 
  }
}
function doSearch() {
  const input = document.getElementById('search-input');
  if (!input) return;
  var q = input.value.trim().toLowerCase();
  var rows = document.querySelectorAll('.msg-row');
  var count = 0;
  rows.forEach(function(row) {
    var text = (row.querySelector('.msg-text') || {}).textContent || '';
    var match = q && text.toLowerCase().includes(q);
    row.classList.toggle('search-highlight', match);
    if (match) { count++; row.scrollIntoView({ block: 'nearest' }); }
  });
  const countEl = document.getElementById('search-count');
  if (countEl) countEl.textContent = q ? count + ' found' : '';
}

function updateDeleteGroupBtn() {
  var btn = document.getElementById('delete-group-btn');
  if (!btn) return;
  var user = getCurrentUser();
  
  // LOGIC FIX: Ensure we only show delete for groups owned by the user
  var isGroup = currentMode === 'group';
  var isOwner = user && currentGroupCreatedBy === user.id;
  
  var show = isGroup && currentId && isOwner;
  btn.classList.toggle('hidden', !show);
}

function selectNoChat() {
  if (currentMode === 'group' && currentId) wsLeaveGroup(currentId);
  currentMode = null;
  currentId = null;
  currentName = null;
  currentGroupCreatedBy = null;
  document.getElementById('current-group-name').textContent = 'Select a chat';
  document.getElementById('current-group-meta').textContent = 'Pick a group or contact from the list';
  document.getElementById('empty-state').style.display = 'flex';
  document.getElementById('msg-input').disabled = true;
  document.getElementById('send-btn').disabled = true;
  document.getElementById('msg-input').placeholder = 'Message…';
  document.getElementById('messages-area').querySelectorAll('.msg-row').forEach(function(el) { el.remove(); });
  document.getElementById('block-btn').classList.add('hidden');
  document.getElementById('invite-btn').classList.add('hidden');
  updateDeleteGroupBtn();
}

// ── GROUPS ──
async function loadGroups() {
  var list = document.getElementById('group-list');
  if (!list) return;
  try {
    var groupsData = await getGroups();
    list.innerHTML = '';
    if (!groupsData.length) {
      const div = document.createElement('div');
      div.className = 'no-groups';
      div.textContent = 'No groups yet. Tap + to create one.';
      list.appendChild(div);
    } else {
      groupsData.forEach(function(g) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sidebar-item' + (currentMode==='group' && currentId===g.id ? ' is-active' : '');
        
        var av = document.createElement('span');
        av.className = 'peer-avatar peer-avatar--sm';
        av.textContent = (g.name && g.name[0]) ? g.name[0].toUpperCase() : '#';
        
        var meta = document.createElement('div');
        meta.className = 'peer-meta';
        var title = document.createElement('span');
        title.className = 'peer-title';
        title.textContent = g.name;
        meta.appendChild(title);
        
        btn.appendChild(av);
        btn.appendChild(meta);
        if (g.has_password) {
          var lock = document.createElement('span');
          lock.className = 'peer-lock';
          lock.textContent = '\uD83D\uDD12';
          lock.title = 'Password protected';
          btn.appendChild(lock);
        }
        btn.addEventListener('click', function(){ tryOpenGroup(g); });
        list.appendChild(btn);
      });
    }
    if (currentMode === 'group' && currentId) {
      var cur = groupsData.find(function(x) { return x.id === currentId; });
      if (!cur) selectNoChat();
      else {
        currentGroupCreatedBy = cur.created_by || null;
        updateDeleteGroupBtn();
      }
    }
  } catch(e) { 
    list.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'no-groups no-groups--error';
    div.textContent = 'Could not load groups.';
    list.appendChild(div);
  }
}

async function tryOpenGroup(g) {
  if (g.has_password) {
    pendingGroupId = g.id;
    document.getElementById('group-pw-msg').textContent = '';
    document.getElementById('group-pw-input').value = '';
    document.getElementById('group-pw-modal').classList.remove('hidden');
    setTimeout(function() { document.getElementById('group-pw-input').focus(); }, 50);
  } else { openGroup(g.id, g.name, g.created_by); }
}

async function submitGroupPassword() {
  var pw = document.getElementById('group-pw-input').value;
  var msg = document.getElementById('group-pw-msg');
  if (!pw) { msg.className='form-msg error'; msg.textContent='Enter password.'; return; }
  var result = await verifyGroupPassword(pendingGroupId, pw);
  if (result.valid) {
    closeGroupPwModal();
    var groupsData = await getGroups();
    var g = groupsData.find(function(x){ return x.id===pendingGroupId; });
    if (g) openGroup(g.id, g.name, g.created_by, result.salt);
  } else {
    msg.className='form-msg error'; msg.textContent='Wrong password.';
    document.getElementById('group-pw-input').value='';
  }
}
function closeGroupPwModal() {
  document.getElementById('group-pw-modal').classList.add('hidden');
  pendingGroupId=null;
}

function openGroup(id, name, createdBy, salt) {
  if (currentMode==='group' && currentId) wsLeaveGroup(currentId);
  currentMode='group'; currentId=id; currentName=name;
  currentGroupCreatedBy = createdBy !== undefined ? (createdBy || null) : null;
  // BUG FIX: Store salt for encryption
  currentGroupSalt = salt || null;
  messageMap.clear(); // Clear map on chat switch
  
  document.getElementById('current-group-name').textContent='#'+name;
  document.getElementById('current-group-meta').textContent='AES-256 encrypted';
  document.getElementById('empty-state').style.display='none';
  document.getElementById('msg-input').disabled=false;
  document.getElementById('send-btn').disabled=false;
  document.getElementById('msg-input').placeholder='Message #'+name+'...';
  document.getElementById('block-btn').classList.add('hidden');
  document.getElementById('invite-btn').classList.remove('hidden');
  
  wsJoinGroup(id); loadGroups(); renderMessages();
  updateDeleteGroupBtn();
  
  if (createdBy === undefined || !salt) {
    getGroups().then(function(arr) {
      var g = Array.isArray(arr) && arr.find(function(x) { return x.id === id; });
      if (g && currentId === id) {
        currentGroupCreatedBy = g.created_by || null;
        currentGroupSalt = g.salt || null;
        updateDeleteGroupBtn();
      }
    });
  }
}

function openCreateGroup() {
  document.getElementById('modal-overlay').classList.remove('hidden');
  setTimeout(function() { document.getElementById('new-group-name').focus(); }, 50);
}
function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('new-group-name').value='';
  document.getElementById('new-group-pw').value='';
  document.getElementById('modal-msg').textContent='';
}
async function doCreateGroup() {
  var name=document.getElementById('new-group-name').value.trim();
  var pw=document.getElementById('new-group-pw').value;
  var msg=document.getElementById('modal-msg');
  if (!name) { msg.className='form-msg error'; msg.textContent='Enter a name.'; return; }
  var result=await createNewGroup(name, pw);
  if (result.success) {
    closeModal();
    var u = getCurrentUser();
    loadGroups();
    openGroup(result.id, result.name, u ? u.id : null);
  }
  else { msg.className='form-msg error'; msg.textContent=result.error; }
}

// ── DM ──
async function loadDmList() {
  var list=document.getElementById('dm-list');
  if (!list) return;
  try {
    var convos=await getDmConversations();
    list.innerHTML='';
    if (!convos||!convos.length) { 
      const div = document.createElement('div');
      div.className = 'no-groups';
      div.textContent = 'No direct messages yet.';
      list.appendChild(div);
      return; 
    }
    convos.forEach(function(c) {
      var btn=document.createElement('button');
      btn.type='button';
      btn.className='sidebar-item'+(currentMode==='dm'&&currentId===c.other_id?' is-active':'');
      var av=document.createElement('span'); av.className='peer-avatar peer-avatar--sm'; av.textContent=c.other_name[0].toUpperCase();
      var meta=document.createElement('div'); meta.className='peer-meta';
      var title=document.createElement('span'); title.className='peer-title'; title.textContent=c.other_name;
      meta.appendChild(title);
      btn.appendChild(av); btn.appendChild(meta);
      btn.addEventListener('click', function(){ openDm(c.other_id, c.other_name); });
      list.appendChild(btn);
    });
  } catch(e) { 
    list.innerHTML='';
    const div = document.createElement('div');
    div.className = 'no-groups';
    div.textContent = 'No direct messages yet.';
    list.appendChild(div);
  }
}

function openDm(userId, username) {
  currentMode='dm'; currentId=userId; currentName=username;
  currentDmSalt = null; // Will be loaded by renderMessages -> getDmMessages
  messageMap.clear();

  var isBlocked = blockedUsers.has(userId);
  document.getElementById('current-group-name').textContent='@ '+username;
  document.getElementById('current-group-meta').textContent= isBlocked ? 'Blocked' : 'E2E encrypted direct message';
  document.getElementById('empty-state').style.display='none';
  document.getElementById('msg-input').disabled = isBlocked;
  document.getElementById('send-btn').disabled = isBlocked;
  document.getElementById('block-btn').classList.remove('hidden');
  document.getElementById('block-btn').title = isBlocked ? 'Unblock user' : 'Block user';
  document.getElementById('block-btn').style.color = isBlocked ? 'var(--danger)' : '';
  document.getElementById('invite-btn').classList.add('hidden');
  updateDeleteGroupBtn();
  wsJoinDm(userId); loadDmList(); renderMessages();
}

// ── USER MODAL ──
async function openDmUserModal() {
  const modal = document.getElementById('dm-users-modal');
  const list = document.getElementById('users-list');
  const search = document.getElementById('dm-search');
  if (!modal || !list) return;

  modal.classList.remove('hidden');
  if (search) {
    search.value = '';
    setTimeout(() => search.focus(), 50);
  }

  list.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'no-groups';
  loading.textContent = 'Loading users...';
  list.appendChild(loading);

  try {
    allUsers = await getUsers();
    renderUserList(allUsers);
  } catch (e) {
    list.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'no-groups';
    err.textContent = 'Could not load users.';
    list.appendChild(err);
  }
}

function renderUserList(users) {
  const list = document.getElementById('users-list');
  if (!list) return;
  list.innerHTML = '';
  
  const me = getCurrentUser();
  const filtered = users.filter(u => me && u.id !== me.id);

  if (filtered.length === 0) {
    const none = document.createElement('div');
    none.className = 'no-groups';
    none.textContent = 'No other users found.';
    list.appendChild(none);
    return;
  }

  filtered.forEach(u => {
    const btn = document.createElement('button');
    btn.className = 'user-row';
    
    const avatar = document.createElement('span');
    avatar.className = 'peer-avatar peer-avatar--sm';
    avatar.textContent = u.username[0].toUpperCase();
    
    const name = document.createElement('span');
    name.className = 'user-row-name';
    name.textContent = u.username;
    
    btn.appendChild(avatar);
    btn.appendChild(name);

    btn.onclick = () => {
      document.getElementById('dm-users-modal').classList.add('hidden');
      openDm(u.id, u.username);
    };
    list.appendChild(btn);
  });
}

function filterUsers() {
  const q = document.getElementById('dm-search').value.trim().toLowerCase();
  if (!q) {
    renderUserList(allUsers);
    return;
  }
  const filtered = allUsers.filter(u => u.username.toLowerCase().includes(q));
  renderUserList(filtered);
}

// ── RENDER MESSAGES ──
async function renderMessages() {
  if (!currentId) return;
  var user=getCurrentUser();
  var msgs;
  try {
    const data = currentMode==='group' ? await getMessages(currentId) : await getDmMessages(currentId);
    if (currentMode === 'group') {
      msgs = data;
    } else {
      msgs = data.messages;
      currentDmSalt = data.salt;
    }
  } catch(e) { return; }

  var area=document.getElementById('messages-area');
  if (!area) return;
  
  var isBottom=area.scrollHeight-area.clientHeight<=area.scrollTop+80;
  
  // BUG FIX: Efficient rendering (Fix 10)
  if (!msgs||!msgs.length) {
    area.querySelectorAll('.msg-row').forEach(function(el){ el.remove(); });
    messageMap.clear();
    var el=document.createElement('div'); el.className='msg-row no-messages';
    var span = document.createElement('span');
    span.textContent = 'No messages yet. Start the conversation!';
    el.appendChild(span);
    area.appendChild(el); 
    return;
  }

  // Remove empty state if messages exist
  var emptyRow = area.querySelector('.no-messages');
  if (emptyRow) emptyRow.remove();

  for (var i=0; i<msgs.length; i++) {
    var m = msgs[i];
    if (!messageMap.has(m.id)) {
      var row = await buildMsgRow(m, user);
      area.appendChild(row);
      messageMap.set(m.id, row);
    }
  }

  // Remove any rendered messages that are no longer in the list (burned)
  const currentIds = new Set(msgs.map(m => m.id));
  for (const [mid, el] of messageMap.entries()) {
    if (!currentIds.has(mid)) {
      el.remove();
      messageMap.delete(mid);
    }
  }
  
  if (isBottom) area.scrollTop=area.scrollHeight;
  // Notify sender that we've read their DMs
  if (currentMode==='dm' && prefsReadReceiptsEnabled()) wsDmViewed(currentId);
}

async function buildMsgRow(msg, user) {
  if (!user) user=getCurrentUser();
  var senderId  = msg.user_id||msg.sender_id;
  var senderName= msg.username||msg.sender_name;
  var isMine    = senderId===user.id;
  var decrypted;
  try {
    if (currentMode==='dm') {
      decrypted = await decryptDmMessage(msg.content, user.id, currentId, currentDmSalt);
    } else {
      decrypted = await decryptMessage(msg.content, currentId, currentGroupSalt);
    }
  } catch(e) { decrypted='[decryption failed]'; }

  var row=document.createElement('div');
  row.className='msg-row'+(isMine?' mine':'');
  row.dataset.msgId=msg.id;

  var bubble=document.createElement('div');
  bubble.className='msg-bubble'+(msg.read_once?' msg-read-once':'');

  // Author
  if (!isMine) {
    var author=document.createElement('span'); author.className='msg-author'; author.textContent=senderName;
    bubble.appendChild(author);
  }

  // Reply quote
  if (msg.reply_to_id && msg.reply_author) {
    var rq=document.createElement('div'); rq.className='reply-quote';
    var ra=document.createElement('div'); ra.className='reply-quote-author'; ra.textContent=msg.reply_author;
    var rt=document.createElement('div'); rt.className='reply-quote-text'; rt.textContent=msg.reply_preview||'…';
    rq.appendChild(ra); rq.appendChild(rt);
    bubble.appendChild(rq);
  }

  // Text
  var textEl=document.createElement('p'); textEl.className='msg-text'; textEl.textContent=decrypted;
  bubble.appendChild(textEl);

  // Footer
  var footer=document.createElement('div'); footer.className='msg-footer';
  if (msg.read_once) {
    var badge=document.createElement('span'); badge.className='read-once-badge'; badge.textContent='VIEW ONCE';
    footer.appendChild(badge);
  }
  var meta=document.createElement('span'); meta.className='msg-meta';
  var expiryText = msg.expires_at ? fmtExpiry(null, msg.expires_at) : fmtExpiry(msg.created_at, null);
  meta.textContent=fmtTime(msg.created_at)+' · '+expiryText;
  footer.appendChild(meta);
  if (msg.edited) {
    var editedLbl=document.createElement('span'); editedLbl.className='msg-edited'; editedLbl.textContent='edited';
    footer.appendChild(editedLbl);
  }
  // Read receipt (DM only, own messages)
  if (currentMode==='dm' && isMine) {
    var receipt=document.createElement('span');
    receipt.className='read-receipt'+(msg.is_read?' read':' sent');
    receipt.dataset.receipt=msg.id;
    receipt.textContent=msg.is_read?'✓✓':'✓';
    footer.appendChild(receipt);
  }
  bubble.appendChild(footer);

  row.appendChild(bubble);
  
  // Mark as read if it's a read-once message from someone else
  if (msg.read_once && !isMine && !msg.is_read) {
    const endpoint = currentMode === 'group' ? '/messages/' + msg.id + '/read' : '/dm/read/' + msg.id;
    apiFetch(endpoint, { method: 'POST' }).catch(() => {});
  }
  
  return row;
}

// ── SEND ──
async function doSendMessage() {
  var input=document.getElementById('msg-input');
  if (!input) return;
  var text=input.value.trim();
  if (!text||!currentId) return;
  var readOnce=document.getElementById('read-once-check').checked;
  var ttlMinutes=document.getElementById('expiry-select').value || null;
  var rId=replyTo?replyTo.id:null, rAuthor=replyTo?replyTo.author:null, rPreview=replyTo?replyTo.preview:null;
  try {
    var user=getCurrentUser();
    var encrypted;
    if (currentMode==='group') {
      encrypted=await encryptMessage(text, currentId, currentGroupSalt);
    } else {
      encrypted=await encryptDmMessage(text, user.id, currentId, currentDmSalt);
    }
    input.value=''; input.style.height='auto'; cancelReply();
    var msg;
    if (currentMode==='group') {
      msg=await postMessage(currentId, encrypted, readOnce, rId, rPreview, rAuthor, ttlMinutes);
      wsSendGroupMessage(msg.id, currentId, encrypted, msg.created_at);
    } else {
      msg=await postDmMessage(currentId, encrypted, readOnce, rId, rPreview, rAuthor, ttlMinutes);
      wsSendDmMessage(msg.id, currentId, currentName, encrypted, msg.created_at);
      loadDmList();
    }
    renderMessages();
  } catch(e) { showToast('Error: '+e.message); }
}

async function doBurnMessage(msgId) {
  if (!confirm('Delete this message for everyone?')) return;
  var result=currentMode==='group'?await burnMessage(msgId):await burnDmMessage(msgId);
  if (result.success) {
    if (currentMode==='group') wsBurnMessage(msgId, currentId);
    renderMessages(); showToast('Deleted.');
  } else showToast('Error: '+result.error);
}

async function doDeleteMyMsgs() {
  if (currentMode!=='group'||!currentId) { showToast('Select a group first.'); return; }
  if (!confirm('Delete ALL your messages from #'+currentName+'?')) return;
  var result=await deleteMyMessages(currentId);
  if (result.success) { renderMessages(); showToast('Deleted.'); }
  else showToast('Error: '+result.error);
}

async function doDeleteAccount() {
  var pw=document.getElementById('delete-pw-input').value;
  var msg=document.getElementById('delete-account-msg');
  if (!pw) { msg.className='form-msg error'; msg.textContent='Enter password.'; return; }
  var result=await deleteAccount(pw);
  if (result.success) window.location.href='index.html';
  else { msg.className='form-msg error'; msg.textContent=result.error; }
}

// ── WS EVENTS ──
function onWsGroupMessage(msg) {
  var user=getCurrentUser();
  if (currentMode!=='group'||currentId!==msg.groupId) return;
  if (msg.userId===user.id||msg.user_id===user.id) return;
  playNotif(); renderMessages();
}
function onWsDmMessage(msg) {
  var user=getCurrentUser();
  if (currentMode!=='dm') { loadDmList(); playNotif(); return; }
  var other=msg.senderId===user.id?msg.receiverId:msg.senderId;
  if (other!==currentId) { loadDmList(); playNotif(); return; }
  playNotif(); renderMessages(); loadDmList();
}
function onWsBurnMessage(msg) {
  if (currentMode!=='group'||currentId!==msg.groupId) return;
  renderMessages(); showToast('Message was deleted.');
}
function onWsTyping(msg) {
  if (currentMode!=='group'||currentId!==msg.groupId) return;
  var el=document.getElementById('typing-indicator');
  if (el) {
    el.textContent=msg.username+' is typing...'; el.classList.remove('hidden');
    clearTimeout(typingHideTimer);
    typingHideTimer=setTimeout(function(){ el.classList.add('hidden'); }, 2500);
  }
}
async function onWsMessageEdited(msg) {
  var row=document.querySelector('[data-msg-id="'+msg.id+'"]');
  if (!row) return;
  var decrypted; try { decrypted=await decryptMessage(msg.content, currentId, currentGroupSalt); } catch(e) { return; }
  var textEl=row.querySelector('.msg-text'); if (textEl) textEl.textContent=decrypted;
  var footer=row.querySelector('.msg-footer');
  if (footer&&!footer.querySelector('.msg-edited')) {
    var lbl=document.createElement('span'); lbl.className='msg-edited'; lbl.textContent='edited'; footer.appendChild(lbl);
  }
}
async function onWsDmMessageEdited(msg) {
  var row=document.querySelector('[data-msg-id="'+msg.id+'"]');
  if (!row) return;
  var user=getCurrentUser();
  var decrypted;
  try { decrypted=await decryptDmMessage(msg.content, user.id, currentId, currentDmSalt); } catch(e) { return; }
  var textEl=row.querySelector('.msg-text'); if (textEl) textEl.textContent=decrypted;
  var footer=row.querySelector('.msg-footer');
  if (footer&&!footer.querySelector('.msg-edited')) {
    var lbl=document.createElement('span'); lbl.className='msg-edited'; lbl.textContent='edited'; footer.appendChild(lbl);
  }
}
function onWsDmRead() {
  document.querySelectorAll('.read-receipt.sent').forEach(function(el) {
    el.classList.remove('sent'); el.classList.add('read'); el.textContent='✓✓';
  });
}

// ── BLOCK / UNBLOCK ──
async function loadBlockedUsers() {
  var list = await getBlockedUsers();
  blockedUsers = new Set(list.map(function(u){ return u.id; }));
}
async function toggleBlock() {
  if (!currentId || currentMode!=='dm') return;
  if (blockedUsers.has(currentId)) {
    await unblockUser(currentId);
    blockedUsers.delete(currentId);
    showToast('User unblocked.');
  } else {
    if (!confirm('Block @'+currentName+'? They will not be able to send you messages.')) return;
    await blockUser(currentId);
    blockedUsers.add(currentId);
    showToast('User blocked.');
  }
  openDm(currentId, currentName);
}

// ── INVITE LINKS ──
async function doDeleteGroup() {
  if (currentMode !== 'group' || !currentId) return;
  var user = getCurrentUser();
  if (!user || currentGroupCreatedBy !== user.id) return;
  if (!confirm('Delete #' + currentName + ' permanently? All messages and invite links will be removed. This cannot be undone.')) return;
  try {
    await deleteGroup(currentId);
    selectNoChat();
    loadGroups();
    showToast('Group deleted.');
  } catch (e) {
    showToast(e.message || 'Could not delete group.');
  }
}

async function doCreateInvite() {
  if (!currentId || currentMode!=='group') return;
  var result = await createGroupInvite(currentId);
  if (result.token) {
    currentInviteLink = location.origin + '/?invite=' + result.token;
    document.getElementById('invite-link-box').textContent = currentInviteLink;
    document.getElementById('invite-modal').classList.remove('hidden');
  } else {
    showToast('Could not generate invite link.');
  }
}
function copyInviteLink() {
  navigator.clipboard.writeText(currentInviteLink).then(function() {
    showToast('Invite link copied!');
  }).catch(function() {
    showToast('Copy failed — select the link manually.');
  });
}

// ── HANDLE INVITE ON LOAD ──
async function checkInviteParam() {
  var params = new URLSearchParams(location.search);
  var token = params.get('invite');
  if (!token) return;
  var info = await validateInvite(token);
  if (!info.valid) { showToast('Invite link is invalid or expired.'); return; }
  history.replaceState(null, '', location.pathname);
  showToast('Joining #'+info.groupName+'…');
  setTimeout(async function() {
    openGroup(info.groupId, info.groupName);
  }, 800);
}

function doLogout() { logoutUser().then(function() { window.location.href = 'index.html'; }); }
function toggleSidebar() {
  var sb = document.getElementById('sidebar');
  if (sb) sb.classList.toggle('collapsed');
  var btn = document.getElementById('mobile-menu-btn');
  if (btn && sb) btn.setAttribute('aria-expanded', sb.classList.contains('collapsed') ? 'false' : 'true');
}
function fmtTime(ts)     { return new Date(ts).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}); }
function fmtExpiry(created_at, expires_at) {
  var d;
  if (expires_at) { d = expires_at - Date.now(); }
  else { d = 24*3600*1000 - (Date.now() - created_at); }
  if (d<=0) return 'expired';
  var h=Math.floor(d/3600000), m=Math.floor((d%3600000)/60000);
  if (h >= 24) return '24h';
  return h>0?h+'h '+m+'m':m+'m';
}
