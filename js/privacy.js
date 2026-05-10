/**
 * privacy.js — Privacy features
 */

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 min → logout
const LOCK_TIMEOUT_MS =  2 * 60 * 1000; // 2 min in background → lock

// ─────────────────────────────────────────
// 1. AUTO LOGOUT ON IDLE
// ─────────────────────────────────────────
let idleTimer        = null;
let idleWarningTimer = null;

function resetIdleTimer() {
  clearTimeout(idleTimer);
  clearTimeout(idleWarningTimer);
  hideIdleWarning();

  idleWarningTimer = setTimeout(() => {
    showIdleWarning();
    startIdleCountdown(60);
  }, IDLE_TIMEOUT_MS - 60000);

  idleTimer = setTimeout(() => {
    forceLogout('inactivity');
  }, IDLE_TIMEOUT_MS);
}

function showIdleWarning() {
  const el = document.getElementById('idle-warning');
  if (el) el.classList.remove('hidden');
}
function hideIdleWarning() {
  const el = document.getElementById('idle-warning');
  if (el) el.classList.add('hidden');
}

let idleCountdownInterval = null;
function startIdleCountdown(seconds) {
  clearInterval(idleCountdownInterval);
  let s = seconds;
  const el = document.getElementById('idle-countdown');
  if (el) el.textContent = s;
  idleCountdownInterval = setInterval(() => {
    s--;
    if (el) el.textContent = s;
    if (s <= 0) clearInterval(idleCountdownInterval);
  }, 1000);
}

function initIdleDetection() {
  ['mousemove','keydown','mousedown','touchstart','scroll','click'].forEach(evt => {
    document.addEventListener(evt, resetIdleTimer, { passive: true });
  });
  resetIdleTimer();

  const stayBtn = document.getElementById('btn-stay-active');
  if (stayBtn) {
    stayBtn.addEventListener('click', () => {
      resetIdleTimer();
      hideIdleWarning();
    });
  }
}

// ─────────────────────────────────────────
// 2. SCREEN LOCK
// ─────────────────────────────────────────
let isLocked  = false;
let lockTimer = null;

function initScreenLock() {
  // Lock after 2 min in background
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      lockTimer = setTimeout(() => lockScreen(), LOCK_TIMEOUT_MS);
    } else {
      clearTimeout(lockTimer);
    }
  });

  const lockBtn = document.getElementById('lock-btn');
  if (lockBtn) lockBtn.addEventListener('click', lockScreen);

  const unlockBtn = document.getElementById('lock-unlock-btn');
  if (unlockBtn) unlockBtn.addEventListener('click', unlockScreen);

  const lockInput = document.getElementById('lock-input');
  if (lockInput) {
    lockInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') unlockScreen();
    });
  }
}

function lockScreen() {
  if (isLocked) return;
  isLocked = true;
  const overlay = document.getElementById('lock-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    setTimeout(() => {
      const inp = document.getElementById('lock-input');
      if (inp) { inp.value = ''; inp.focus(); }
    }, 100);
  }
}

async function unlockScreen() {
  const input = document.getElementById('lock-input');
  const err   = document.getElementById('lock-error');
  if (!input) return;

  const password = input.value;
  if (!password) {
    if (err) err.textContent = 'Enter password.';
    return;
  }

  const user = getCurrentUser();
  if (!user) { forceLogout('session'); return; }

  try {
    if (err) err.textContent = 'Checking...';

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user.username, password })
    });

    if (res.ok) {
      const data = await res.json();
      // SECURITY FIX: Use setToken instead of localStorage
      if (data.token) setToken(data.token);

      isLocked = false;
      document.getElementById('lock-overlay').classList.add('hidden');
      input.value = '';
      if (err) err.textContent = '';
      resetIdleTimer();
    } else {
      if (err) err.textContent = 'Wrong password.';
      input.value = '';
      input.classList.add('shake');
      setTimeout(() => input.classList.remove('shake'), 500);
    }
  } catch (e) {
    if (err) err.textContent = 'Connection error. Try again.';
  }
}

// ─────────────────────────────────────────
// 3. ANTI-SCREENSHOT PROTECTION
// ─────────────────────────────────────────
function initAntiScreenshot() {
  const area = document.getElementById('messages-area');
  if (!area) return;

  // Blur messages when tab loses focus
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      area.classList.add('privacy-blur');
    } else {
      area.classList.remove('privacy-blur');
    }
  });

  // Blur when window loses focus (alt-tab, screenshot tools)
  window.addEventListener('blur', () => {
    area.classList.add('privacy-blur');
  });
  window.addEventListener('focus', () => {
    area.classList.remove('privacy-blur');
  });

  // Block PrintScreen
  document.addEventListener('keyup', (e) => {
    if (e.key === 'PrintScreen') {
      area.classList.add('privacy-blur');
      showToast('Screenshot blocked.');
      navigator.clipboard.writeText('').catch(() => {});
      setTimeout(() => area.classList.remove('privacy-blur'), 1000);
    }
  });
  document.addEventListener('keydown', (e) => {
    // Cmd+Shift+3/4/5 (macOS screenshot), Win+Shift+S
    if ((e.metaKey && e.shiftKey && ['3','4','5'].includes(e.key)) ||
        (e.metaKey && e.key === 'p') ||
        (e.ctrlKey && e.key === 'p')) {
      e.preventDefault();
      showToast('Screenshot/print blocked.');
    }
  });
}

// ─────────────────────────────────────────
// 4. PANIC BUTTON (Ctrl+Shift+X)
// ─────────────────────────────────────────
function initPanicButton() {
  const panicBtn = document.getElementById('panic-btn');
  if (panicBtn) {
    panicBtn.addEventListener('click', () => {
      triggerPanic();
    });
  }
}

async function triggerPanic() {
  if (!confirm('PANIC: This will permanently delete ALL your data (messages, account). Continue?')) return;

  showToast('Deleting all data...');
  try {
    var token = getToken();
    await fetch('/api/auth/panic', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
    });
  } catch(e) {}

  localStorage.clear();
  sessionStorage.clear();

  try { await navigator.clipboard.writeText(''); } catch(e) {}

  window.location.href = 'index.html';
}

// ─────────────────────────────────────────
// 5. COPY BLOCKING
// ─────────────────────────────────────────
function initCopyBlock() {
  const area = document.getElementById('messages-area');
  if (!area) return;

  area.addEventListener('copy', (e) => {
    e.preventDefault();
    showToast('Copying messages is blocked.');
  });

  area.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showToast('Right-click is disabled.');
  });

  area.style.userSelect       = 'none';
  area.style.webkitUserSelect = 'none';
}

// ─────────────────────────────────────────
// 6. TOAST NOTIFICATIONS
// ─────────────────────────────────────────
let toastTimer = null;
function showToast(msg, duration = 3000) {
  const toast = document.getElementById('privacy-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove('hidden');
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.classList.add('hidden'), 300);
  }, duration);
}

// ─────────────────────────────────────────
// 7. KEYBOARD SHORTCUTS
// ─────────────────────────────────────────
function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'l') { e.preventDefault(); lockScreen(); }
    if (e.ctrlKey && e.shiftKey && e.key === 'X') { e.preventDefault(); triggerPanic(); }
    if (e.key === 'Escape') hideIdleWarning();
  });
}

// ─────────────────────────────────────────
// FORCE LOGOUT
// ─────────────────────────────────────────
async function forceLogout(reason) {
  clearTimeout(idleTimer);
  clearTimeout(idleWarningTimer);
  clearTimeout(lockTimer);
  clearInterval(idleCountdownInterval);
  await logoutUser();
  window.location.href = 'index.html' + (reason ? '?reason=' + encodeURIComponent(reason) : '');
}

// ─────────────────────────────────────────
// 8. AUTO TOKEN REFRESH
// ─────────────────────────────────────────
let tokenRefreshInterval = null;
function initTokenRefresh() {
  // Sliding session: HttpOnly refresh cookie + new access token every 40m (access = 1h)
  tokenRefreshInterval = setInterval(async () => {
    if (!getToken()) return;
    try {
      var res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        var data = await res.json();
        if (data.token) setToken(data.token);
      } else {
        forceLogout('session');
      }
    } catch (e) {}
  }, 40 * 60 * 1000);
}

// ─────────────────────────────────────────
// INIT
// ─────────────────────────────────────────
function initPrivacy() {
  initIdleDetection();
  initScreenLock();
  initAntiScreenshot();
  initPanicButton();
  initCopyBlock();
  initKeyboardShortcuts();
  initTokenRefresh();
}
