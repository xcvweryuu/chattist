/**
 * index.js — Auth page logic
 */
document.addEventListener('DOMContentLoaded', function () {
  var quotes = [
    'privacy is power',
    'encrypt everything',
    'no logs is a feature',
    'your keys stay in the browser',
    'metadata matters — roadmap: sealed sender + tor',
    'trust the math not the server'
  ];
  var qi = 0;
  var qEl = document.getElementById('privacy-quote');
  function rotateQuote() {
    if (!qEl) return;
    qEl.textContent = quotes[qi % quotes.length];
    qi++;
  }
  rotateQuote();
  setInterval(rotateQuote, 7000);

  // Reason for logout
  var reason = new URLSearchParams(window.location.search).get('reason');
  if (reason) {
    var bar = document.getElementById('reason-bar');
    if (bar) {
      bar.textContent = reason === 'inactivity'
        ? 'You were logged out due to inactivity.'
        : 'Session expired. Please log in again.';
      bar.classList.remove('hidden');
    }
  }

  // Tab
  function switchTab(tab) {
    const tabLogin = document.getElementById('tab-login');
    const tabReg = document.getElementById('tab-register');
    const panelLogin = document.getElementById('panel-login');
    const panelReg = document.getElementById('panel-register');
    const indicator = document.getElementById('tab-indicator');
    
    if (tabLogin) tabLogin.classList.toggle('active', tab==='login');
    if (tabReg) tabReg.classList.toggle('active', tab==='register');
    if (panelLogin) panelLogin.style.display    = tab==='login'    ? 'flex' : 'none';
    if (panelReg) panelReg.style.display = tab==='register' ? 'flex' : 'none';
    if (indicator) indicator.style.left     = tab==='login'    ? '4px'  : '50%';
  }
  
  const tabLoginBtn = document.getElementById('tab-login');
  const tabRegBtn = document.getElementById('tab-register');
  if (tabLoginBtn) tabLoginBtn.addEventListener('click', function() { switchTab('login'); });
  if (tabRegBtn) tabRegBtn.addEventListener('click', function() { switchTab('register'); });

  // Handle direct /register path by switching tab on load
  if (window.location.pathname === '/register' || window.location.pathname === '/register/') {
    switchTab('register');
  }

  // Password show/hide
  function togglePwd(id, btn) {
    var inp = document.getElementById(id);
    if (!inp) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
    btn.style.opacity = inp.type === 'text' ? '1' : '0.4';
  }
  
  const eyeLogin = document.getElementById('eye-login');
  const eyeReg = document.getElementById('eye-reg');
  if (eyeLogin) eyeLogin.addEventListener('click', function() { togglePwd('login-password', this); });
  if (eyeReg) eyeReg.addEventListener('click', function() { togglePwd('reg-password', this); });

  // Password strength
  const regPassword = document.getElementById('reg-password');
  if (regPassword) {
    regPassword.addEventListener('input', function() {
      var v = this.value, s = 0;
      if(v.length>=8)s++; if(v.length>=12)s++;
      if(/[A-Z]/.test(v))s++; if(/[0-9]/.test(v))s++; if(/[^A-Za-z0-9]/.test(v))s++;
      var f = document.getElementById('strength-fill');
      if (f) {
        f.style.width = (s*20)+'%';
        f.style.background = ['#e85d5d','#e85d5d','#e4a542','#5dc965','#5dc965'][s-1]||'#242f3d';
      }
    });
  }

  function showMsg(id, text, type) {
    var el = document.getElementById(id);
    if (el) {
      el.textContent = text; el.className = 'form-msg '+(type||'');
    }
  }

  function showRedirect(title) {
    const overlay = document.getElementById('redirect-overlay');
    const titleEl = document.getElementById('redirect-title');
    if (overlay && titleEl) {
      titleEl.textContent = title;
      overlay.classList.remove('hidden');
    }
  }

  async function handleLogin() {
    var uEl = document.getElementById('login-username');
    var pEl = document.getElementById('login-password');
    if (!uEl || !pEl) return;
    var u = uEl.value.trim().toLowerCase();
    var p = pEl.value;
    if(!u||!p){showMsg('login-msg','Please fill in all fields.','error');return;}
    showMsg('login-msg','Checking...','');
    var result = await loginUser(u, p);
    if(result.success){
      showRedirect('Welcome back!');
      setTimeout(function(){window.location.href='chat.html';}, 1500);
    } else { showMsg('login-msg', result.error, 'error'); }
  }

  async function handleRegister() {
    var uEl = document.getElementById('reg-username');
    var pEl = document.getElementById('reg-password');
    var cEl = document.getElementById('reg-confirm');
    if (!uEl || !pEl || !cEl) return;
    var u = uEl.value.trim().toLowerCase();
    var p = pEl.value;
    var c = cEl.value;
    if(!u||!p||!c){showMsg('reg-msg','Please fill in all fields.','error');return;}
    if(!/^[a-z0-9_]{3,20}$/.test(u)){showMsg('reg-msg','username: 3-20 chars, lowercase letters, numbers, underscore.','error');return;}
    if(p.length<8){showMsg('reg-msg','passcode must be at least 8 characters.','error');return;}
    if(p!==c){showMsg('reg-msg','Passwords do not match.','error');return;}
    showMsg('reg-msg','Creating account...','');
    var result = await registerUser(u, p);
    if(result.success){
      showRedirect('Account created!');
      setTimeout(function(){window.location.href='chat.html';}, 1500);
    } else { showMsg('reg-msg', result.error, 'error'); }
  }

  const btnLogin = document.getElementById('btn-login');
  const btnReg = document.getElementById('btn-register');
  if (btnLogin) btnLogin.addEventListener('click', handleLogin);
  if (btnReg) btnReg.addEventListener('click', handleRegister);
  
  document.addEventListener('keydown', function(e) {
    if(e.key!=='Enter') return;
    const panelLogin = document.getElementById('panel-login');
    if(panelLogin && panelLogin.style.display!=='none') handleLogin();
    else handleRegister();
  });
});
