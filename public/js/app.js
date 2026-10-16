// iM4 Health Management System (Smart Hub) - v5 frontend
// Full-replacement SPA: hash routing, JWT auth, parent/child cards, hamburger nav.
// v5 adds: Dashboard landing page, Billing, role switcher, 2FA login + Security
// page, new password-reset flow (legacy flow kept).

(function () {
'use strict';

var STAGES = ['Initiation', 'Data Gathering', 'Implementation', 'Go Live', 'Complete'];

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(d) {
  if (!d) return '';
  var dt = new Date(d);
  return isNaN(dt.getTime()) ? '' : dt.toLocaleDateString();
}

function fmtDateTime(d) {
  if (!d) return '';
  var dt = new Date(d);
  return isNaN(dt.getTime()) ? '' : dt.toLocaleString();
}

function fmtMoney(v) {
  var n = Number(v || 0);
  if (isNaN(n)) n = 0;
  return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function personName(p) {
  var full = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
  return full || p.name || p.email || '';
}

function num(v) {
  return (v === null || v === undefined) ? null : v;
}

function roleLabel(r) {
  if (r === 'admin') return 'Admin';
  if (r === 'top_dog') return 'Top Dog';
  if (r === 'onboarding') return 'Onboarding';
  if (r === 'service') return 'Service';
  if (r === 'client') return 'Client';
  return 'Steward';
}

function hasRole(r) {
  var u = state.user;
  return !!u && ((u.roles || []).indexOf(r) !== -1);
}
function canOnboard() { var r = activeRole(); return r === 'onboarding' || r === 'admin' || r === 'top_dog'; }

// POST a FormData body (file uploads) with the auth token.
function uploadFile(url, formData) {
  var headers = {};
  if (api.token) headers['Authorization'] = 'Bearer ' + api.token;
  return fetch(url, { method: 'POST', headers: headers, body: formData }).then(function (resp) {
    if (resp.status === 401 && api.token) {
      api.setToken(null);
      location.hash = '#/login';
      throw new Error('signed out');
    }
    return resp.json().then(function (data) {
      if (!resp.ok) throw new Error((data && data.error) || ('Request failed: ' + resp.status));
      return data;
    });
  });
}

function downloadOnboardingDoc(clientId, docId, fileName) {
  var headers = {};
  if (api.token) headers['Authorization'] = 'Bearer ' + api.token;
  fetch('/api/onboarding/' + clientId + '/documents/' + docId + '/download', { headers: headers }).then(function (resp) {
    if (!resp.ok) throw new Error('Download failed');
    return resp.blob();
  }).then(function (blob) {
    var el = document.createElement('a');
    el.href = URL.createObjectURL(blob);
    el.download = fileName;
    document.body.appendChild(el);
    el.click();
    setTimeout(function () { URL.revokeObjectURL(el.href); el.remove(); }, 1500);
  }).catch(function (err) { alert(err.message); });
}

// Card numbers line (v6.4, Leroy): enrolled when known; otherwise the
// eligible count from the latest payroll data; otherwise "Eligible TBD"
// (replaces the old "No payroll data yet").
function enrolledLine(enrolled, eligible, hasPayroll) {
  if (enrolled !== null && enrolled !== undefined) return '<span><b>' + enrolled + '</b> enrolled</span>';
  if (eligible !== null && eligible !== undefined) return '<span>Eligible <b>' + eligible + '</b></span>';
  return '<span class="muted">Eligible TBD</span>';
}

function rollLine(total, eligible, enrolled, hasPayroll) {
  var parts = [];
  if (total !== null && total !== undefined) parts.push('<span><b>' + total + '</b> total</span>');
  if (eligible !== null && eligible !== undefined) parts.push('<span><b>' + eligible + '</b> eligible</span>');
  if (enrolled !== null && enrolled !== undefined) parts.push('<span><b>' + enrolled + '</b> enrolled</span>');
  if (parts.length > 0) return parts.join(' ');
  // "No payroll data yet" only when there is genuinely no payroll data at all —
  // never alongside numbers.
  if (hasPayroll) return '';
  return '<span class="muted">No payroll data yet</span>';
}

// True when a company row has any payroll data in any payroll column.
function hasPayrollData(c) {
  return ['payroll_total', 'payroll_qualified', 'payroll_ineligible', 'payroll_opted_out',
    'payroll_enrolled', 'payroll_not_enrolled', 'payroll_new_qualified', 'payroll_bill_premium',
    'payroll_bill_claims', 'payroll_bill_admin', 'payroll_bill_savings', 'payroll_pay_schedule',
    'payroll_ein', 'payroll_dataset_date']
    .some(function (k) { return c[k] !== null && c[k] !== undefined; });
}

// Arrears from the oldest open invoice: yellow at 30+ days, red at 60+.
function arrearsInfo(oldestOpen) {
  if (!oldestOpen) return { days: 0, level: '' };
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var d = new Date(String(oldestOpen).slice(0, 10) + 'T00:00:00');
  var days = Math.round((today - d) / 86400000);
  if (days < 0) days = 0;
  return { days: days, level: days >= 60 ? 'red' : (days >= 30 ? 'yellow' : '') };
}

function invoiceLine(openCount, openTotal, oldestOpen) {
  var ai = arrearsInfo(oldestOpen);
  var badge = ai.level
    ? ' <span class="badge ' + (ai.level === 'red' ? 'badge-overdue' : 'badge-warn') + '">' + ai.days + 'd overdue</span>'
    : '';
  if (openCount > 0) {
    return '<div class="card-invoices"><b>' + openCount + '</b> open invoice' + (openCount === 1 ? '' : 's') +
      ' &mdash; <b>' + fmtMoney(openTotal) + '</b>' + badge + '</div>';
  }
  return '<div class="muted">No open invoices</div>';
}

// One shared company card: payroll line + invoice line + arrears marking.
// Used for parent cards (aggregates) and child cards (per-company).
function companyCard(o) {
  var ai = arrearsInfo(o.oldestOpen);
  var cls = 'card' + (ai.level === 'red' ? ' arrears-red' : ai.level === 'yellow' ? ' arrears-yellow' : '');
  return '<a class="' + cls + '" href="' + o.link + '">' +
    '<div class="card-code">' + esc(o.code) + '</div>' +
    '<div class="card-title">' + esc(o.name) + '</div>' +
    '<div class="card-numbers">' + enrolledLine(o.enrolled, o.eligible, o.hasPayroll) + '</div>' +
    invoiceLine(o.openCount, o.openTotal, o.oldestOpen) +
    (o.sub ? '<div class="muted">' + o.sub + '</div>' : '') + '</a>';
}

// ---------------------------------------------------------------- api
var api = {
  token: null,
  init: function () { this.token = localStorage.getItem('im4_token') || null; },
  setToken: function (t) {
    this.token = t;
    if (t) localStorage.setItem('im4_token', t); else localStorage.removeItem('im4_token');
  },
  call: function (method, url, body) {
    var self = this;
    var headers = { 'Content-Type': 'application/json' };
    if (self.token) headers['Authorization'] = 'Bearer ' + self.token;
    var opts = { method: method, headers: headers };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(url, opts).then(function (resp) {
      if (resp.status === 401 && self.token) {
        self.setToken(null);
        location.hash = '#/login';
        throw new Error('signed out');
      }
      return resp.json().then(function (data) {
        if (!resp.ok) throw new Error((data && data.error) || ('Request failed: ' + resp.status));
        return data;
      });
    });
  },
  get: function (url) { return this.call('GET', url); },
  post: function (url, body) { return this.call('POST', url, body); },
  put: function (url, body) { return this.call('PUT', url, body); },
  patch: function (url, body) { return this.call('PATCH', url, body); },
  delete: function (url) { return this.call('DELETE', url); }
};

var state = { user: null };

// ---------------------------------------------------------------- header (same on every page)
function logoHtml(size) {
  size = size || 34;
  // Uploaded logo first (/api/logo 404s when none is uploaded -> fall back to the built-in logo).
  return '<img src="/api/logo" onerror="this.onerror=null;this.src=\'logo.webp\'" class="brand-logo" ' +
    'style="max-height:' + size + 'px;width:auto;" alt="iM4 Health">';
}

function activeRole() {
  var u = state.user;
  return u ? (u.activeRole || u.role || '') : '';
}

// Screens per role:
// admin: everything
// top_dog: everything except Jobs, Tickets (Stewards page is view-only)
// onboarding: Onboarding, Implementation, Stewards (with steward maintenance), Companies (with company maintenance), Billing
// steward: Dashboard, Companies, Billing, Implementation, Tickets
// service: Tickets, Companies, Implementation, Billing (assigned companies only)
// client: Tickets (own company only), Billing (own company only)
// Billing (v6.1, Leroy): every role; scoped roles see only their assigned companies (server-enforced)
function navLinks() {
  var role = activeRole();
  var links = [];
  if (role === 'admin' || role === 'top_dog' || role === 'steward') {
    links.push(['#/dashboard', 'Dashboard']);
    links.push(['#/clients', 'Companies']);
  }
  links.push(['#/billing', 'Billing']);
  if (role === 'service') {
    links.push(['#/clients', 'Companies']);
  }
  links.push(['#/implementations', 'Implementation']);
  if (role === 'admin') {
    links.push(['#/tickets', 'Tickets']);
  }
  if (role === 'admin' || role === 'top_dog' || role === 'onboarding') {
    links.push(['#/onboarding', 'Onboarding']);
  }
  if (role === 'admin' || role === 'top_dog') {
    links.push(['#/forms', 'Forms']);
  }
  if (role === 'admin' || role === 'top_dog' || role === 'onboarding') {
    links.push(['#/admin/stewards', 'Stewards']);
  }
  if (role === 'admin' || role === 'top_dog' || role === 'onboarding') {
    links.push(['#/admin/companies', 'Companies']);
    links.push(['#/admin/commissions', 'Commissions']);
    links.push(['#/parent-page', 'Parent']);
  }
  if (role === 'admin' || role === 'top_dog') {
    links.push(['#/admin/assignments', 'Assignments']);
  }
  if (role === 'admin') {
    links.push(['#/admin/jobs', 'Jobs']);
  }
  return links;
}

function shell(inner, active) {
  var u = state.user;
  var menu = '';
  if (u) {
    var items = navLinks().map(function (l) {
      var on = active === l[0];
      return '<a class="menu-item' + (on ? ' active' : '') + '" href="' + l[0] + '">' + l[1] + '</a>';
    }).join('');
    menu = '<div class="hamb-wrap"><button class="hamb" id="hamb" aria-label="Menu">&#9776;</button>' +
      '<div class="hamb-menu" id="hambmenu">' + items + '</div></div>';
  }
  // Role switcher: only when the user actually has more than one role.
  var roleSwitcher = '';
  if (u && u.roles && u.roles.length > 1) {
    var opts = u.roles.map(function (r) {
      return '<option value="' + esc(r) + '"' + (r === u.activeRole ? ' selected' : '') + '>' + esc(roleLabel(r)) + '</option>';
    }).join('');
    roleSwitcher = '<label class="role-switch">Viewing as: <select id="roleswitch">' + opts + '</select></label>';
  }
  var userBox = u
    ? roleSwitcher +
      '<span class="user-email">' + esc(u.name || u.email) + ' <em>(' + esc(roleLabel(u.activeRole || u.role)) + ')</em></span>' +
      '<a class="btn btn-link" href="#/security">Security</a>' +
      '<button class="btn btn-link" id="signout">Sign out</button>'
    : '';
  return '<header class="topbar"><div class="topbar-left">' + menu + '</div>' +
    '<a class="brand" href="#" id="brandlink">' + logoHtml(34) + '<span class="brand-text">Success Management System</span></a>' +
    '<div class="userbox">' + userBox + '</div></header>' +
    '<main class="main">' + inner + '</main>';
}

function render(html) {
  document.getElementById('app').innerHTML = html;
  var so = document.getElementById('signout');
  if (so) so.onclick = function () { api.setToken(null); state.user = null; location.hash = '#/login'; };
  // Logo click: dashboard when signed in, login screen when not.
  var brand = document.getElementById('brandlink');
  if (brand) brand.onclick = function (e) {
    e.preventDefault();
    if (!api.token) { location.hash = '#/login'; return; }
    location.hash = activeRole() === 'onboarding' ? '#/onboarding' : '#/dashboard';
  };
  var rs = document.getElementById('roleswitch');
  if (rs) rs.onchange = function () {
    api.post('/api/auth/switch-role', { role: rs.value }).then(function (d) {
      api.setToken(d.token);
      state.user = d.user;
      if (location.hash === '#/dashboard') { route(); } else { location.hash = '#/dashboard'; }
    }).catch(function (err) {
      alert('Could not switch role: ' + err.message);
    });
  };
  var hamb = document.getElementById('hamb');
  var hm = document.getElementById('hambmenu');
  if (hamb && hm) {
    hamb.onclick = function (e) {
      e.stopPropagation();
      hm.classList.toggle('open');
    };
    document.addEventListener('click', function () { hm.classList.remove('open'); });
    var links = hm.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      links[i].onclick = function () { hm.classList.remove('open'); };
    }
  }
  windowTables();
  syncTopScrollbars();
  window.scrollTo(0, 0);
}

// Re-run the table enhancements after a view paints rows itself (the
// Parent page fills its table after render). v6.9.0.
function enhanceTables() { windowTables(); syncTopScrollbars(); }

// v6.8.3 (Leroy): any table with more than 15 rows becomes a scrollable
// window showing 15 rows; the column headings stay fixed at the top of
// the window while scrolling (CSS makes thead sticky inside scroll
// containers).
function windowTables() {
  document.querySelectorAll('table.data-table').forEach(function (tbl) {
    var body = tbl.tBodies[0];
    if (!body || body.rows.length <= 15) return;
    var rowH = (body.rows[0] && body.rows[0].offsetHeight) || 32;
    var headH = tbl.tHead ? tbl.tHead.offsetHeight : 34;
    var sc = tbl.closest('.table-scroll, .comm-scroll');
    if (!sc) {
      sc = document.createElement('div');
      sc.className = 'table-scroll';
      tbl.parentNode.insertBefore(sc, tbl);
      sc.appendChild(tbl);
    }
    sc.style.maxHeight = (headH + rowH * 15 + 4) + 'px';
    sc.style.overflowY = 'auto';
  });
  // Commissions window: size it to the frozen columns plus exactly two
  // steward/% pairs, measured from the real rendered columns (v6.9.4) so
  // the second % is never cut off.
  var comm = document.querySelector('.comm-scroll');
  if (comm) {
    var pcts = comm.querySelectorAll('thead th.cm-pct');
    if (pcts.length >= 2) {
      var cellR = pcts[1].getBoundingClientRect().right - comm.getBoundingClientRect().left + comm.scrollLeft;
      var vAllowance = comm.offsetWidth - comm.clientWidth;
      comm.style.width = (Math.ceil(cellR) + vAllowance + 2) + 'px';
      comm.style.maxWidth = '100%';
    }
  }
}

// v6.8.2 (Leroy): every horizontally scrollable table also gets a scrollbar
// at the TOP, attached above its column headings, synced both ways with
// the container's own bottom scrollbar.
function syncTopScrollbars() {
  document.querySelectorAll('.table-scroll, .comm-scroll').forEach(function (sc) {
    var prev = sc.previousElementSibling;
    var bar = (prev && prev.classList && prev.classList.contains('top-scroll')) ? prev : null;
    if (!bar) {
      if (sc.scrollWidth <= sc.clientWidth + 1) return;
      bar = document.createElement('div');
      bar.className = 'top-scroll';
      var inner = document.createElement('div');
      inner.style.height = '1px';
      bar.appendChild(inner);
      sc.parentNode.insertBefore(bar, sc);
      var lock = false;
      bar.onscroll = function () { if (!lock) { lock = true; sc.scrollLeft = bar.scrollLeft; lock = false; } };
      sc.onscroll = function () { if (!lock) { lock = true; bar.scrollLeft = sc.scrollLeft; lock = false; } };
    }
    // The top bar is exactly as wide as the table window it mirrors, and
    // aligned with it (v6.8.4) — never wider than the table. Refreshed on
    // every pass so late layout changes are picked up (v6.9.3).
    var cs = window.getComputedStyle(sc);
    bar.firstChild.style.width = sc.scrollWidth + 'px';
    bar.style.width = sc.clientWidth + 'px';
    bar.style.marginLeft = cs.marginLeft;
    bar.style.marginRight = cs.marginRight;
  });
}

function errorHtml(msg) {
  return msg ? '<div class="alert alert-error">' + esc(msg) + '</div>' : '';
}

function okHtml(msg) {
  return msg ? '<div class="alert alert-ok">' + esc(msg) + '</div>' : '';
}

function filterBar(searchVal, extra) {
  return '<div class="filterbar"><input id="fq" type="search" placeholder="Search..." value="' + esc(searchVal || '') + '">' +
    '<button class="btn btn-small" id="fqreset" type="button" style="margin-left:2px;">Reset</button>' +
    (extra || '') + '</div>';
}

// ---------------------------------------------------------------- auth views
function viewLogin() {
  render('<div class="auth-wrap"><div class="auth-card">' + logoHtml(52) +
    '<h1>Sign in</h1><div id="err"></div>' +
    '<form id="f"><label>Email<input type="email" id="email" required autocomplete="username"></label>' +
    '<label>Password<input type="password" id="password" required autocomplete="current-password"></label>' +
    '<button class="btn btn-primary" type="submit">Sign in</button></form>' +
    '<p class="muted"><a href="#/reset-password">Forgot your password?</a></p></div></div>');
  document.getElementById('f').onsubmit = function (e) {
    e.preventDefault();
    var email = document.getElementById('email').value;
    var password = document.getElementById('password').value;
    doLogin(email, password);
  };
}

function doLogin(email, password) {
  api.post('/api/auth/login', { email: email, password: password }).then(function (d) {
    if (d.need2fa) {
      view2fa(d.tmpToken, email, password);
      return;
    }
    api.setToken(d.token);
    state.user = d.user;
    location.hash = '#/dashboard';
  }).catch(function (err) {
    var el = document.getElementById('err');
    if (el) el.innerHTML = errorHtml(err.message);
  });
}

// Second step of login when the account has 2FA enabled.
function view2fa(tmpToken, email, password) {
  render('<div class="auth-wrap"><div class="auth-card">' + logoHtml(52) +
    '<h1>Check your email</h1><div id="err"></div>' +
    '<p class="muted">We sent a 6-digit code to your email. Enter it below.</p>' +
    '<form id="f"><label>Code<input id="code" inputmode="numeric" autocomplete="one-time-code" ' +
    'placeholder="123456" required maxlength="6"></label>' +
    '<button class="btn btn-primary" type="submit">Verify</button></form>' +
    '<p class="muted"><a href="#" id="resend">Resend code</a></p></div></div>');
  document.getElementById('f').onsubmit = function (e) {
    e.preventDefault();
    var code = document.getElementById('code').value;
    api.post('/api/auth/2fa/verify-login', { tmpToken: tmpToken, code: code }).then(function (d) {
      api.setToken(d.token);
      state.user = d.user;
      location.hash = '#/dashboard';
    }).catch(function (err) {
      document.getElementById('err').innerHTML = errorHtml(err.message);
    });
  };
  document.getElementById('resend').onclick = function (e) {
    e.preventDefault();
    document.getElementById('err').innerHTML = '<p class="muted">Sending a new code...</p>';
    doLogin(email, password);
  };
}

// v5 password reset: email step, or new-password step when a token is present.
function viewResetPassword(token) {
  if (token) {
    render('<div class="auth-wrap"><div class="auth-card">' + logoHtml(52) +
      '<h1>Set a new password</h1><div id="msg"></div>' +
      '<form id="f"><label>New password (8+ characters)<input type="password" id="pw" required minlength="8" autocomplete="new-password"></label>' +
      '<button class="btn btn-primary" type="submit">Set password</button></form></div></div>');
    document.getElementById('f').onsubmit = function (e) {
      e.preventDefault();
      api.post('/api/auth/reset-password', { token: token, newPassword: document.getElementById('pw').value }).then(function () {
        document.getElementById('msg').innerHTML = okHtml('Password updated. <a href="#/login">Sign in</a>.');
        document.getElementById('f').style.display = 'none';
      }).catch(function (err) {
        document.getElementById('msg').innerHTML = errorHtml(err.message);
      });
    };
    return;
  }
  render('<div class="auth-wrap"><div class="auth-card">' + logoHtml(52) +
    '<h1>Reset password</h1><div id="msg"></div>' +
    '<form id="f"><label>Email<input type="email" id="email" required autocomplete="username"></label>' +
    '<button class="btn btn-primary" type="submit">Send reset link</button></form>' +
    '<p class="muted"><a href="#/login">Back to sign in</a></p></div></div>');
  document.getElementById('f').onsubmit = function (e) {
    e.preventDefault();
    api.post('/api/auth/forgot-password', { email: document.getElementById('email').value }).then(function () {
      document.getElementById('msg').innerHTML = okHtml('If that email has an account, a reset link is on its way.');
      document.getElementById('f').style.display = 'none';
    }).catch(function (err) {
      document.getElementById('msg').innerHTML = errorHtml(err.message);
    });
  };
}

// Legacy reset flow (kept working).
function viewForgot() {
  render('<div class="auth-wrap"><div class="auth-card">' + logoHtml(52) +
    '<h1>Reset password</h1><div id="msg"></div>' +
    '<form id="f"><label>Email<input type="email" id="email" required></label>' +
    '<button class="btn btn-primary" type="submit">Send reset link</button></form>' +
    '<p class="muted"><a href="#/login">Back to sign in</a></p></div></div>');
  document.getElementById('f').onsubmit = function (e) {
    e.preventDefault();
    api.post('/api/auth/forgot', { email: document.getElementById('email').value }).then(function (d) {
      document.getElementById('msg').innerHTML = okHtml(d.message);
    }).catch(function (err) {
      document.getElementById('msg').innerHTML = errorHtml(err.message);
    });
  };
}

function viewReset(token) {
  render('<div class="auth-wrap"><div class="auth-card">' + logoHtml(52) +
    '<h1>Set a new password</h1><div id="msg"></div>' +
    '<form id="f"><label>New password (8+ characters)<input type="password" id="pw" required minlength="8"></label>' +
    '<button class="btn btn-primary" type="submit">Set password</button></form></div></div>');
  document.getElementById('f').onsubmit = function (e) {
    e.preventDefault();
    api.post('/api/auth/reset', { token: token, password: document.getElementById('pw').value }).then(function () {
      document.getElementById('msg').innerHTML = okHtml('Password updated. <a href="#/login">Sign in</a>.');
      document.getElementById('f').style.display = 'none';
    }).catch(function (err) {
      document.getElementById('msg').innerHTML = errorHtml(err.message);
    });
  };
}

function requireUser(next) {
  if (!api.token) { location.hash = '#/login'; return; }
  if (state.user) { next(); return; }
  api.get('/api/me').then(function (u) { state.user = u; next(); })
    .catch(function () { location.hash = '#/login'; });
}

// ---------------------------------------------------------------- dashboard (landing page after login)
function viewDashboard() {
  requireUser(function () {
    if (activeRole() === 'onboarding') { location.hash = '#/onboarding'; return; }
    api.get('/api/dashboard').then(function (d) {
      return api.get('/api/accountability').then(function (a) { return { d: d, a: a }; });
    }).then(function (both) {
      var d = both.d, a = both.a;
      var stageOrder = ['Initiation', 'Data Gathering', 'Implementation', 'Go Live', 'Complete'];
      var stageMap = {};
      d.clientsByStage.forEach(function (s) { stageMap[s.stage] = s.count; });
      var stageRows = stageOrder.map(function (st) {
        if (!stageMap[st]) return '';
        return '<div class="stat-row"><span>' + esc(st) + '</span><b>' + stageMap[st] + '</b></div>';
      }).join('');
      // Any stages not in the canonical order go at the end.
      d.clientsByStage.forEach(function (s) {
        if (stageOrder.indexOf(s.stage) === -1) {
          stageRows += '<div class="stat-row"><span>' + esc(s.stage || 'No stage') + '</span><b>' + s.count + '</b></div>';
        }
      });
      render(shell(
        '<h2>Dashboard</h2><div id="err"></div>' +
        '<div class="card-grid">' +
        '<div class="card"><div class="card-title">Total Clients</div><div class="stat-big">' + d.totalClients + '</div></div>' +
        '<div class="card"><div class="card-title">Total Enrolled</div><div class="stat-big">' + (d.totalEnrolled || 0) + '</div></div>' +
        '<div class="card"><div class="card-title">Open Invoices</div><div class="stat-big">' + d.billingOpen.count + '</div></div>' +
        '<div class="card"><div class="card-title">$ Outstanding</div><div class="stat-big">' + fmtMoney(d.billingOpen.total) + '</div></div>' +
        '</div>' +
        '<h3>Implementation Stage</h3>' +
        '<div class="card">' + (stageRows || '<p class="muted">No implementations on the kanban yet.</p>') + '</div>' +
        '<h3>Service Tickets</h3>' +
        '<div class="card-grid">' +
        '<div class="card"><div class="card-title">My Open Tickets</div><div class="stat-big">' + (a.my_open_tickets || 0) + '</div></div>' +
        '<div class="card"><div class="card-title">Resolved (30d)</div><div class="stat-big">' + (a.my_resolved_30d || 0) + '</div></div>' +
        '</div>' +
        (a.team && a.team.length ? '<h3>Team Accountability</h3><div class="card"><table class="data-table"><thead><tr><th>Person</th><th>Open Tickets</th><th>Resolved (30d)</th></tr></thead><tbody>' +
        a.team.map(function (m) {
          var nm = ((m.first_name || '') + ' ' + (m.last_name || '')).trim() || m.email;
          return '<tr><td>' + esc(nm) + '</td><td><b>' + m.open_tickets + '</b></td><td>' + m.resolved_30d + '</td></tr>';
        }).join('') + '</tbody></table></div>' : '') +
        // Accountability (v6.3, Leroy): placeholder. Tasks assigned to the
        // signed-in person will be listed here with a checkmark; checking
        // one grays it out and it disappears 48 hours later. Tasks will be
        // created from the Implementation Kanban boards (details TBD).
        '<h3>Accountability</h3>' +
        '<div class="card"><p class="muted">Tasks assigned to you will be listed here. Check a task when it is done — it grays out and disappears after 48 hours. Tasks will be created from the Implementation Kanban boards. (Coming soon.)</p></div>',
        '#/dashboard'));
    }).catch(function (err) { render(shell(errorHtml(err.message), '#/dashboard')); });
  });
}

// ---------------------------------------------------------------- billing
function viewBilling() {
  requireUser(function () {
    function load() {
      api.get('/api/billing?status=open').then(function (openRows) {
        api.get('/api/billing?status=paid').then(function (paidRows) {
          function firstVal(list, field) {
            for (var i = 0; i < list.length; i++) { if (list[i][field]) return list[i][field]; }
            return '';
          }
          var MODE_NAMES = { '1': 'Weekly', '2': 'Bi-weekly', '3': 'Semi-monthly', '4': 'Monthly', 'M': 'Monthly' };
          function fmtMode(v) {
            if (!v) return '';
            var k = String(v).toUpperCase().trim();
            return MODE_NAMES[k] || v;
          }
          function latestOf(rows) {
            var best = null;
            rows.forEach(function (r) {
              if (!best) { best = r; return; }
              var rk = String(r.paid_date || r.payroll_date || ''), bk = String(best.paid_date || best.payroll_date || '');
              if (rk > bk) best = r;
            });
            return best;
          }
          var today = new Date(); today.setHours(0, 0, 0, 0);
          function daysPast(dstr) {
            if (!dstr) return 0;
            var d = new Date(String(dstr).slice(0, 10) + 'T00:00:00');
            var n = Math.round((today - d) / 86400000);
            return n < 0 ? 0 : n;
          }
          function cell(v) { return '<td>' + (v === null || v === undefined || v === '' ? '&mdash;' : esc(v)) + '</td>'; }
          // Group bills by company.
          var openByCo = {}, paidByCo = {};
          openRows.forEach(function (r) {
            var k = String(r.company_code);
            if (!openByCo[k]) openByCo[k] = [];
            openByCo[k].push(r);
          });
          paidRows.forEach(function (r) {
            var k = String(r.company_code);
            if (!paidByCo[k]) paidByCo[k] = [];
            paidByCo[k].push(r);
          });
          // ---- Top box: one row per company with open bills, aged in buckets.
          var topCodes = Object.keys(openByCo).sort();
          var topBody = topCodes.map(function (code) {
            var bills = openByCo[code];
            var all = bills.concat(paidByCo[code] || []);
            var b030 = 0, b3160 = 0, b61 = 0, tot61 = 0;
            bills.forEach(function (r) {
              var n = daysPast(r.payroll_date);
              if (n <= 30) b030++;
              else if (n <= 60) b3160++;
              else { b61++; tot61 += Number(r.total_invoice) || 0; }
            });
            var lastPaid = paidByCo[code] ? latestOf(paidByCo[code]) : null;
            var paidTo = lastPaid ? (lastPaid.payroll_end_date || lastPaid.payroll_date || null) : null;
            var status = '<span class="dot ' + (b61 > 0 ? 'dot-red' : (b3160 > 0 ? 'dot-yellow' : 'dot-green')) + '"></span>';
            return '<tr><td><b>' + esc(code) + '</b></td>' +
              cell(firstVal(all, 'company_name')) +
              cell(firstVal(all, 'ein')) +
              cell(fmtMode(firstVal(all, 'bill_mode'))) +
              '<td>' + (paidTo ? fmtDate(paidTo) : '&mdash;') + '</td>' +
              '<td>' + b030 + '</td><td>' + b3160 + '</td><td>' + b61 + '</td>' +
              '<td><b>' + fmtMoney(tot61) + '</b></td>' +
              '<td>' + status + '</td></tr>';
          }).join('');
          // ---- Bottom box: each company's last invoice paid, full bill data.
          var botCodes = Object.keys(paidByCo).sort();
          var botBody = botCodes.map(function (code) {
            var r = latestOf(paidByCo[code]);
            return '<tr><td><b>' + esc(r.company_code) + '</b></td>' +
              cell(r.company_name) +
              cell(r.ein) +
              cell(fmtMode(r.bill_mode)) +
              cell(fmtDate(r.payroll_date)) +
              cell(fmtDate(r.payroll_end_date)) +
              cell(fmtDate(r.paid_date)) +
              cell(r.lives_count) +
              '<td><b>' + fmtMoney(r.total_invoice) + '</b></td>' +
              '<td>Paid</td></tr>';
          }).join('');
          render(shell(
            '<h2>Billing</h2><div id="msg"></div>' +
            '<h3>Open Bills (' + topCodes.length + ' companies)</h3>' +
            '<p class="muted">Open bills only being reported by new billing system.</p>' +
            (topCodes.length === 0
              ? '<p class="muted">No open bills.</p>'
              : '<div class="table-scroll" style="max-height:430px;overflow-y:auto;"><table class="data-table"><thead>' +
                '<tr><th>Company Code</th><th>Company Name</th><th>EIN</th><th>Pay Frequency</th>' +
                '<th>Paid-to-Date</th><th># Bills 0-30 days</th><th># Bills 31-60 days</th>' +
                '<th># Bills 61+ days</th><th>Total $ 61+ days</th><th>Status</th></tr>' +
                '</thead><tbody>' + topBody + '</tbody></table></div>') +
            '<h3 style="margin-top:22px;">Paid Bills — Last Invoice Paid (' + botCodes.length + ' companies)</h3>' +
            '<p class="muted">Paid bills reported by both old and new billing systems. Only the most recent paid bill for each company is displayed.</p>' +
            (botCodes.length === 0
              ? '<p class="muted">No paid bills.</p>'
              : '<div class="table-scroll" style="max-height:340px;overflow-y:auto;"><table class="data-table"><thead>' +
                '<tr><th>Company Code</th><th>Company Name</th><th>EIN</th><th>Pay Frequency</th>' +
                '<th>Payroll Begin Date</th><th>Payroll End Date</th><th>Check Date</th>' +
                '<th>Lives</th><th>Total $</th><th>Status</th></tr>' +
                '</thead><tbody>' + botBody + '</tbody></table></div>'),
            '#/billing'));
        }).catch(function (err) { render(shell(errorHtml(err.message), '#/billing')); });
      }).catch(function (err) { render(shell(errorHtml(err.message), '#/billing')); });
    }
    load();
  });
}

// ---------------------------------------------------------------- security (2FA management)
function viewSecurity() {
  requireUser(function () {
    api.get('/api/auth/2fa/status').then(function (s) {
      var enabled = !!s.enabled;
      render(shell(
        '<h2>Security</h2><div id="msg"></div>' +
        '<div class="card"><div class="card-title">Two-factor authentication</div>' +
        '<p class="muted">When enabled, signing in sends a 6-digit code to your email that you enter after your password.</p>' +
        '<p>Status: <b>' + (enabled ? 'On' : 'Off') + '</b></p>' +
        (enabled
          ? '<button class="btn btn-danger" id="disable2fa">Turn off 2FA</button>'
          : '<button class="btn btn-primary" id="enable2fa">Turn on 2FA</button>') +
        '<div id="codebox"></div></div>',
        '#/security'));
      var en = document.getElementById('enable2fa');
      if (en) en.onclick = function () {
        api.post('/api/auth/2fa/enable', {}).then(function () {
          document.getElementById('codebox').innerHTML =
            '<h3>Enter the code we emailed you</h3><form id="codef" class="form-inline">' +
            '<input id="code-in" placeholder="6-digit code" required maxlength="6" inputmode="numeric"> ' +
            '<button class="btn btn-primary" type="submit">Verify and enable</button></form><div id="codemsg"></div>';
          document.getElementById('codef').onsubmit = function (e) {
            e.preventDefault();
            api.post('/api/auth/2fa/confirm', { code: document.getElementById('code-in').value }).then(function () {
              document.getElementById('msg').innerHTML = okHtml('Two-factor authentication is now on.');
              viewSecurity();
            }).catch(function (err) {
              document.getElementById('codemsg').innerHTML = errorHtml(err.message);
            });
          };
        }).catch(function (err) {
          document.getElementById('msg').innerHTML = errorHtml(err.message);
        });
      };
      var dis = document.getElementById('disable2fa');
      if (dis) dis.onclick = function () {
        if (!window.confirm('Turn off two-factor authentication?')) return;
        api.post('/api/auth/2fa/disable', {}).then(function () { viewSecurity(); })
          .catch(function (err) { document.getElementById('msg').innerHTML = errorHtml(err.message); });
      };
    }).catch(function (err) { render(shell(errorHtml(err.message), '#/security')); });
  });
}

// ---------------------------------------------------------------- clients (parent cards, rolled-up payroll)
function viewClients() {
  requireUser(function () {
    if (activeRole() === 'onboarding') { location.hash = '#/onboarding'; return; }
    var q = '';
    function load() {
      var url = '/api/clients' + (q ? '?q=' + encodeURIComponent(q) : '');
      api.get(url).then(function (groups) {
        var cards = groups.map(function (g) {
          var sub = g.children.length > 1 ? g.children.length + ' companies' : '1 company';
          return companyCard({
            link: '#/parent/' + esc(g.code),
            code: g.code, name: g.name,
            total: g.total, eligible: g.eligible, enrolled: g.enrolled, hasPayroll: g.has_payroll,
            openCount: g.open_invoices, openTotal: g.open_total, oldestOpen: g.oldest_open,
            sub: sub
          });
        }).join('');
        render(shell(
          '<h2>Companies</h2>' + filterBar(q) + '<div id="err"></div>' +
          (groups.length === 0
            ? '<p class="muted">No companies found. Ask your administrator to import companies and assign them to you.</p>'
            : '<div class="card-grid">' + cards + '</div>'),
          '#/clients'));
        var fq = document.getElementById('fq');
        fq.onchange = function () { q = fq.value; load(); };
        fq.onkeydown = function (e) { if (e.key === 'Enter') { q = fq.value; load(); } };
        document.getElementById('fqreset').onclick = function () { q = ''; fq.value = ''; load(); };
      }).catch(function (err) { render(shell(errorHtml(err.message), '#/clients')); });
    }
    load();
  });
}

function statusBadge(status) {
  var cls = 'badge';
  if (status === 'RUSH') cls += ' badge-rush';
  return '<span class="' + cls + '">' + esc(status || '') + '</span>';
}

// The status shown on tiles and the project view is the latest update's RAG judgment
// (RED/YELLOW/GREEN); the GitHub Priority badge is only a fallback when no
// update exists yet.
function statusHtml(i) {
  var src = i.latest_update || i.latest_summary;
  var rag = parseRag(src);
  if (rag) return ragBadge(src);
  return statusBadge(i.status);
}

function miniPipeline(current) {
  var idx = STAGES.indexOf(current);
  var html = '<div class="mini-pipe">';
  STAGES.forEach(function (s, i) {
    var cls = 'mp-step';
    if (i < idx) cls += ' done';
    if (i === idx) cls += ' current';
    html += '<span class="' + cls + '" title="' + esc(s) + '"></span>';
  });
  return html + '</div>';
}

function implCard(i) {
  var lvl = STAGES.indexOf(i.stage);
  var lvlText = lvl === -1 ? 'Level —' : 'Level ' + (lvl + 1) + ' of ' + STAGES.length;
  var totalEE = (i.total_employees === null || i.total_employees === undefined) ? '—' : Number(i.total_employees).toLocaleString('en-US');
  var qualEE = (i.qualified_employee_count === null || i.qualified_employee_count === undefined) ? '—' : Number(i.qualified_employee_count).toLocaleString('en-US');
  return '<a class="card" href="#/project/' + i.id + '">' +
    '<div class="card-code">' + esc(i.company_code) + '</div>' +
    '<div class="card-title">' + esc(i.company_name) + '</div>' +
    miniPipeline(i.stage) +
    '<div class="card-line">' + statusHtml(i) + '</div>' +
    '<div class="card-line"><b>' + esc(i.stage || '') + '</b></div>' +
    '<div class="card-line muted">' + lvlText + '</div>' +
    '<div class="card-line">Total EE: ' + totalEE + ' &nbsp; Qualified EE: ' + qualEE + '</div>' +
    '</a>';
}

// Parent detail: one card per child + stewards + implementations.
function viewParent(code) {
  requireUser(function () {
    api.get('/api/parents/' + encodeURIComponent(code)).then(function (d) {
      var p = d.parent;
      var childCards = d.children.map(function (c) {
        var elig = (c.payroll_qualified !== null && c.payroll_qualified !== undefined) ? c.payroll_qualified
          : (c.payroll_total !== null && c.payroll_total !== undefined ? (c.payroll_total || 0) - (c.payroll_ineligible || 0) - (c.payroll_opted_out || 0) : null);
        return companyCard({
          link: '#/child/' + c.id,
          code: c.company_code, name: c.company_name,
          total: c.payroll_total, eligible: elig, enrolled: c.payroll_enrolled, hasPayroll: hasPayrollData(c),
          openCount: c.open_invoices, openTotal: c.open_total, oldestOpen: c.oldest_open
        });
      }).join('');
      var stewardList = d.stewards.map(function (s) { return esc(personName(s)); }).join(', ');
      var implCards = d.implementations.map(implCard).join('');
      render(shell(
        '<p><a href="#/clients">&larr; Companies</a></p>' +
        '<h2><span class="code-chip">' + esc(p.code) + '</span> ' + esc(p.name) + '</h2>' +
        '<div class="rollup"><b>Roll-up:</b> ' + enrolledLine(p.enrolled, p.eligible, p.has_payroll) + '</div>' +
        (stewardList ? '<p class="muted">Stewards: ' + stewardList + '</p>' : '') +
        '<h3>Companies</h3><div class="card-grid">' + childCards + '</div>' +
        '<h3>Implementations</h3>' +
        (implCards ? '<div class="card-grid">' + implCards + '</div>' : '<p class="muted">No implementations on the kanban for this client yet.</p>'),
        '#/clients'));
    }).catch(function (err) { render(shell(errorHtml(err.message), '#/clients')); });
  });
}

function payrollTable(c) {
  function elig() {
    if (c.payroll_qualified !== null && c.payroll_qualified !== undefined) return c.payroll_qualified;
    if (c.payroll_total === null || c.payroll_total === undefined) return null;
    return (c.payroll_total || 0) - (c.payroll_ineligible || 0) - (c.payroll_opted_out || 0);
  }
  function row(label, v) {
    return '<tr><td>' + label + '</td><td><b>' + (v === null || v === undefined ? '&mdash;' : esc(v)) + '</b></td></tr>';
  }
  function moneyRow(label, v) {
    return '<tr><td>' + label + '</td><td><b>' + (v === null || v === undefined ? '&mdash;' : esc(fmtMoney(v))) + '</b></td></tr>';
  }
  var prem = c.payroll_bill_premium, claims = c.payroll_bill_claims,
      admin = c.payroll_bill_admin, savings = c.payroll_bill_savings;
  var hasBill = prem !== null && prem !== undefined;
  var premLessClaims = hasBill ? (+prem - +claims) : null;
  var netSavings = (hasBill && admin !== null && admin !== undefined) ? (+savings - +admin) : null;
  var totalDue = (premLessClaims !== null && admin !== null && admin !== undefined) ? (premLessClaims + +admin) : null;
  var html = '<h3>Last Payroll Summary</h3><table class="data-table"><tbody>' +
    row('Employer Name', c.company_name) +
    row('Payroll Frequency', c.payroll_pay_schedule) +
    row('Total Employees', c.payroll_total) +
    row('Ineligible', c.payroll_ineligible) +
    row('Opted-Out', c.payroll_opted_out) +
    row('Eligible', elig()) +
    row('New Qualified', c.payroll_new_qualified) +
    row('Enrolled', c.payroll_enrolled) +
    row('Not Enrolled', c.payroll_not_enrolled) +
    '</tbody></table>';
  if (hasBill) {
    html += '<h3>Bill and Savings Summary</h3><table class="data-table"><tbody>' +
      moneyRow('Total Premium', prem) +
      moneyRow('Total Claims', claims) +
      moneyRow('Premium Less Claims', premLessClaims) +
      moneyRow('Total Admin Fees', admin) +
      moneyRow('Employer Savings', savings) +
      moneyRow('Net Employer Savings', netSavings) +
      moneyRow('Total Due this Payroll', totalDue) +
      '</tbody></table>';
  }
  html += (c.payroll_dataset_date ? '<p class="muted">Last payroll data: ' + fmtDate(c.payroll_dataset_date) + '</p>' : '');
  return html;
}

// Child detail: payroll + stewards + implementation cards.
function viewChild(id) {
  requireUser(function () {
    api.get('/api/clients/' + id).then(function (d) {
      var c = d.company;
      var implCards = d.implementations.map(implCard).join('');
      var stewardList = d.stewards.map(function (s) { return esc(personName(s)); }).join(', ');
      var eeCode = c.parent_company_code;
      var eeName = c.parent_company_name || eeCode;
      var parentLink = (eeCode && eeCode !== c.company_code)
        ? '<p><a href="#/parent/' + esc(eeCode) + '">&larr; ' + esc(eeName) + '</a></p>'
        : '<p><a href="#/clients">&larr; Companies</a></p>';
      render(shell(parentLink +
        '<h2><span class="code-chip">' + esc(c.company_code) + '</span> ' + esc(c.company_name) + '</h2>' +
        payrollTable(c) +
        (stewardList ? '<p class="muted">Stewards: ' + stewardList + '</p>' : '') +
        '<h3>Implementations</h3>' +
        (implCards ? '<div class="card-grid">' + implCards + '</div>' : '<p class="muted">No implementations on the kanban for this company yet.</p>'),
        '#/clients'));
    }).catch(function (err) { render(shell(errorHtml(err.message), '#/clients')); });
  });
}

// ---------------------------------------------------------------- implementations (grouped by stage)
function viewImplementations() {
  requireUser(function () {
    var q = '';
    var stage = '';
    function load() {
      var params = [];
      if (q) params.push('q=' + encodeURIComponent(q));
      if (stage) params.push('stage=' + encodeURIComponent(stage));
      api.get('/api/implementations' + (params.length ? '?' + params.join('&') : '')).then(function (list) {
        var stageOpts = '<option value="">All stages</option>' + STAGES.map(function (s) {
          return '<option value="' + esc(s) + '"' + (s === stage ? ' selected' : '') + '>' + esc(s) + '</option>';
        }).join('');
        var body;
        if (list.length === 0) {
          body = '<p class="muted">No implementations found.</p>';
        } else if (stage) {
          body = '<div class="card-grid">' + list.map(implCard).join('') + '</div>';
        } else {
          body = STAGES.map(function (s) {
            var inStage = list.filter(function (i) { return i.stage === s; });
            if (inStage.length === 0) return '';
            return '<h3 class="stage-group">' + esc(s) + ' <span class="muted">(' + inStage.length + ')</span></h3>' +
              '<div class="card-grid">' + inStage.map(implCard).join('') + '</div>';
          }).join('');
          var other = list.filter(function (i) { return STAGES.indexOf(i.stage) === -1; });
          if (other.length > 0) {
            body += '<h3 class="stage-group">Other <span class="muted">(' + other.length + ')</span></h3>' +
              '<div class="card-grid">' + other.map(implCard).join('') + '</div>';
          }
        }
        render(shell(
          '<h2>Implementation</h2>' + filterBar(q, '<select id="fstage">' + stageOpts + '</select>') +
          '<div id="err"></div>' + body,
          '#/implementations'));
        var fq = document.getElementById('fq');
        var fs = document.getElementById('fstage');
        fq.onchange = function () { q = fq.value; load(); };
        fq.onkeydown = function (e) { if (e.key === 'Enter') { q = fq.value; load(); } };
        document.getElementById('fqreset').onclick = function () { q = ''; fq.value = ''; load(); };
        fs.onchange = function () { stage = fs.value; load(); };
      }).catch(function (err) { render(shell(errorHtml(err.message), '#/implementations')); });
    }
    load();
  });
}

// ---------------------------------------------------------------- 12-week plan timeline
function timelineHtml(t) {
  if (!t || !t.started) return '<div class="card" style="border:2px solid #c0392b;">' +
    '<h3 style="color:#c0392b;margin-top:0;">Missing Start Date</h3>' +
    '<p>No dates are assigned to this plan yet. Add the <b>Implementation Start Date</b> on the GitHub Kanban board and the 12-week schedule will be dated from that day.</p></div>';
  var blocks = t.blocks.map(function (b) {
    var cls = 'tl-block' + (b.current ? ' tl-current' : '') + (b.done ? ' tl-done' : '');
    return '<div class="' + cls + '">' +
      '<div class="tl-title">' + esc(b.stage) + ' <span class="muted">(' + esc(b.block) + ')</span></div>' +
      '<ul class="tl-duties">' + b.duties.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul>' +
      '<div class="tl-dates muted">Weeks ' + b.startWeek + '-' + b.endWeek + ' &middot; ' + fmtDate(b.startDate) + ' &ndash; ' + fmtDate(b.endDate) + '</div></div>';
  }).join('');
  return '<div class="timeline">' + blocks + '</div>';
}

// ---------------------------------------------------------------- project view: lifecycle visual + updates | messaging
function lifecycleVisual(current, daysInStage, stageEnteredAt, rag) {
  var idx = STAGES.indexOf(current);
  var ringCls = '';
  var rl = String(rag || '').toUpperCase();
  if (rl === 'RED') ringCls = ' rag-ring-red';
  else if (rl === 'YELLOW') ringCls = ' rag-ring-yellow';
  else if (rl === 'GREEN') ringCls = ' rag-ring-green';
  var html = '<div class="lifecycle">';
  STAGES.forEach(function (s, i) {
    var cls = 'lc-step';
    if (i < idx) cls += ' done';
    if (i === idx) cls += ' current';
    var nodeCls = 'lc-node' + (i === idx ? ringCls : '');
    var daysLabel = '';
    if (i === idx) {
      var d = null;
      if (stageEnteredAt) {
        var enteredMs = new Date(stageEnteredAt).getTime();
        if (!isNaN(enteredMs)) d = Math.max(0, Math.floor((Date.now() - enteredMs) / 86400000));
      } else if (daysInStage !== null && daysInStage !== undefined) {
        d = daysInStage;
      }
      if (d !== null && d !== undefined) daysLabel = '<div class="lc-days">In Stage ' + d + ' Days</div>';
    }
    html += '<div class="' + cls + '">' +
      '<div class="' + nodeCls + '">' + (i < idx ? '&#10003;' : (i + 1)) + '</div>' +
      '<div class="lc-label">' + esc(s) + '</div>' +
      daysLabel +
      '</div>';
    if (i < STAGES.length - 1) html += '<div class="lc-link' + (i < idx ? ' done' : '') + '"></div>';
  });
  html += '</div>';
  if (idx === -1 && current) html += '<p class="muted">Stage: ' + esc(current) + '</p>';
  return html;
}

function parseRag(body) {
  if (!body) return null;
  var up = String(body).toUpperCase();
  var at = up.indexOf('STATUS:');
  if (at === -1) return null;
  var tail = up.slice(at + 7, at + 24);
  if (tail.indexOf('RED') !== -1) return 'RED';
  if (tail.indexOf('YELLOW') !== -1) return 'YELLOW';
  if (tail.indexOf('GREEN') !== -1) return 'GREEN';
  return null;
}

function stripStatusLine(body) {
  var lines = String(body).split(String.fromCharCode(10));
  var kept = [];
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].toUpperCase().indexOf('STATUS:') === 0) continue;
    kept.push(lines[i]);
  }
  return kept.join(String.fromCharCode(10));
}

function ragBadge(body) {
  var s = parseRag(body);
  if (!s) return '';
  var cls = s === 'RED' ? 'rag-red' : (s === 'YELLOW' ? 'rag-yellow' : 'rag-green');
  return '<span class="rag ' + cls + '">' + s + '</span>';
}

function updatesHtml(list) {
  if (!list || list.length === 0) return '<p class="muted">No updates yet. Updates are generated nightly when the day\u2019s messages contain something worth noting.</p>';
  return list.map(function (u) {
    return '<div class="summary">' + ragBadge(u.body) +
      '<div class="muted">Update &middot; ' + fmtDate(u.update_date) + '</div>' +
      '<div class="summary-body">' + stripStatusLine(esc(u.body)) + '</div></div>';
  }).join('');
}

function viewProject(id) {
  requireUser(function () {
    api.get('/api/implementations/' + id).then(function (d) {
      var i = d.implementation;
      var msgs = d.messages.map(function (m) {
        var out = m.direction === 'out';
        var who = out ? (m.author_name || 'unknown') : (m.author_name || m.author_login || 'unknown');
        return '<div class="msg' + (out ? ' msg-out' : '') + '">' +
          '<div class="msg-head"><b>' + esc(who) + '</b>' +
          ' <span class="muted">' + fmtDateTime(m.github_created_at || m.created_at) + '</span></div>' +
          '<div class="msg-body">' + esc(m.body) + '</div></div>';
      }).join('');
      var latest = d.updates && d.updates.length > 0 ? d.updates[0] : null;
      var rag = latest ? parseRag(latest.body) : null;
      render(shell(
        '<p><a href="#/implementations">&larr; Implementation</a></p>' +
        '<h2><span class="code-chip">' + esc(i.company_code) + '</span> ' + esc(i.company_name) + '</h2>' +
        (i.parent_company_name ? '<p class="muted">' + esc(i.parent_company_name) + '</p>' : '') +
        '<div class="proj-grid"><div>' +
        '<h3>Project lifecycle</h3>' + lifecycleVisual(i.stage, i.days_in_stage, i.stage_entered_at, rag) +
        '<h3>Updates</h3>' + updatesHtml(d.updates) +
        '<h3>Plan</h3>' + timelineHtml(d.timeline) +
        '</div><div>' +
        '<h3>Messaging <span class="muted">(' + d.messages.length + ')</span></h3>' +
        '<form id="mform"><label>Post a message (goes to the GitHub card too)<textarea id="mbody" rows="3" required></textarea></label>' +
        '<button class="btn btn-primary" type="submit">Send message</button></form>' +
        '<div id="merr"></div><div id="msglist">' +
        (msgs || '<p class="muted">No messages yet. Start the conversation above.</p>') +
        '</div></div></div>',
        '#/implementations'));
      document.getElementById('mform').onsubmit = function (e) {
        e.preventDefault();
        var body = document.getElementById('mbody').value;
        api.post('/api/implementations/' + id + '/messages', { body: body }).then(function () {
          viewProject(id);
        }).catch(function (err) {
          document.getElementById('merr').innerHTML = errorHtml(err.message);
        });
      };
    }).catch(function (err) { render(shell(errorHtml(err.message), '#/implementations')); });
  });
}

// ---------------------------------------------------------------- admin: stewards (import only; password + roles set here)
function viewAdminStewards() {
  requireUser(function () {
    var ar = activeRole();
    if (ar !== 'admin' && ar !== 'top_dog' && ar !== 'onboarding') { location.hash = '#/dashboard'; return; }
    var isAdmin = ar === 'admin';
    var canEdit = ar === 'admin' || ar === 'onboarding';
    var canDocs = canEdit; // W9/ACH columns: admin + onboarding only; top_dog never sees them
    var docStatus = {};
    var ROLE_OPTS = ['admin', 'top_dog', 'onboarding', 'steward'];
    var editId = null;
    var adding = false;
    var nextId = null;

    function rolesOf(s) {
      if (s.roles && s.roles.length) return s.roles;
      return s.role ? [s.role] : [];
    }
    function roleChecks(selected) {
      return ROLE_OPTS.map(function (r) {
        var on = selected.indexOf(r) !== -1;
        return '<label style="margin-right:10px;"><input type="checkbox" class="stw-role" value="' + r + '"' + (on ? ' checked' : '') + '> ' + roleLabel(r) + '</label>';
      }).join('');
    }
    function editorRow(idDisplay, s) {
      var idCell = isAdmin
        ? '<input id="stw-id" type="number" value="' + idDisplay + '" style="width:100px;">'
        : '<b>' + idDisplay + '</b>';
      var rolesCell = isAdmin
        ? roleChecks(s ? rolesOf(s) : ['steward'])
        : esc(s ? (rolesOf(s).map(roleLabel).join(', ') || 'Steward') : 'Steward');
      return '<tr><td>' + idCell + '</td>' +
        '<td><input id="stw-first" value="' + esc(s ? (s.first_name || '') : '') + '" style="width:100%;"></td>' +
        '<td><input id="stw-last" value="' + esc(s ? (s.last_name || '') : '') + '" style="width:100%;"></td>' +
        '<td><input id="stw-email" value="' + esc(s ? (s.email || '') : '') + '" style="width:100%;"><input id="stw-password" type="password" placeholder="' + (s ? 'New password (blank = keep current)' : 'Password (optional)') + '" style="width:100%;margin-top:4px;"></td>' +
        '<td><input id="stw-phone" value="' + esc(s ? (s.phone || '') : '') + '" style="width:100%;"></td>' +
        '<td><input id="stw-stmt" value="' + esc(s ? (s.statement_email || '') : '') + '" style="width:100%;"></td>' +
        '<td>' + rolesCell + '</td>' +
        (canDocs ? '<td></td><td></td>' : '') +
        '<td style="white-space:nowrap;"><button class="btn btn-small" id="stw-save">Save &amp; close</button> ' +
        '<button class="btn btn-small" id="stw-cancel">Cancel</button></td></tr>';
    }
    function showErr(msg) { var e = document.getElementById('err'); if (e) e.innerHTML = errorHtml(msg); }
    function docCell(s, type) {
      var fn = docStatus[s.id] ? docStatus[s.id][type] : null;
      var h = '<span style="white-space:nowrap;"><button class="btn btn-small" data-doc-up="' + type + '" data-id="' + s.id + '">' + (fn ? 'Replace' : 'Upload') + '</button>';
      if (fn) {
        h += ' <button class="btn btn-small" data-doc-dl="' + type + '" data-id="' + s.id + '" data-fn="' + esc(fn) + '">Download</button>' +
          ' <button class="btn btn-small btn-danger" data-doc-del="' + type + '" data-id="' + s.id + '">Delete</button>';
      }
      h += '</span>';
      if (fn) h += '<div class="muted" style="font-size:11px;">' + esc(fn) + '</div>';
      return '<td>' + h + '</td>';
    }
    function pickedRoles() {
      return Array.prototype.map.call(document.querySelectorAll('.stw-role:checked'), function (x) { return x.value; });
    }
    function load() {
      api.get('/api/admin/stewards').then(function (list) {
        if (!canDocs) { renderList(list); return; }
        api.get('/api/admin/stewards/documents-status').then(function (st) {
          docStatus = st || {};
          renderList(list);
        }).catch(function () { docStatus = {}; renderList(list); });
      }).catch(function (err) { render(shell(errorHtml(err.message), '#/admin/stewards')); });
    }
    function renderList(list) {
        var bodyRows = '';
        if (adding) bodyRows += editorRow(nextId, null);
        bodyRows += list.map(function (s) {
          if (editId === s.id) return editorRow(s.id, s);
          var roles = rolesOf(s).map(roleLabel).join(', ');
          var actions = canEdit ? '<button class="btn btn-small" data-edit="' + s.id + '">Edit</button>' : '';
          if (isAdmin) actions += ' <button class="btn btn-small" data-del="' + s.id + '" data-name="' + esc(((s.first_name || '') + ' ' + (s.last_name || '')).trim()) + '">Delete</button>';
          return '<tr><td><b>' + s.id + '</b></td><td>' + esc(s.first_name || '') + '</td><td>' + esc(s.last_name || '') + '</td>' +
            '<td>' + esc(s.email) + '</td><td>' + esc(s.phone || '') + '</td><td>' + esc(s.statement_email || '') + '</td><td>' + esc(roles || s.role || '') + '</td>' +
            (canDocs ? docCell(s, 'w9') + docCell(s, 'ach') : '') +
            '<td style="white-space:nowrap;">' + actions + '</td></tr>';
        }).join('');
        var note = '<p class="muted">Onboarding can add a Steward and add (or later update) First Name, Last Name, Email, Phone, Password, and Statement Email. Phone and Statement Email are optional. Password is empty by default but must be updated for the Steward to get access to the system, it can be updated at anytime (Steward should manage their own password, this feature is meant to start a new Steward or rescue an existing one). Admin has additional rights including deleting a Steward, changing the Steward ID and adding additional roles. If anyone else needs access to an account, they must be a Steward first, then associated on the Assignments page.</p>';
        render(shell(
          '<h2>Stewards</h2>' + note +
          '<div id="err"></div>' +
          (canEdit ? '<p><button class="btn" id="stw-add">Add Steward</button></p>' : '') +
          '<table class="data-table"><thead><tr><th>Steward ID</th><th>First name</th><th>Last name</th><th>Email</th><th>Phone</th><th>Statement Email</th><th>Roles</th>' + (canDocs ? '<th>W9</th><th>ACH</th>' : '') + '<th>Edit</th></tr></thead>' +
          '<tbody>' + bodyRows + '</tbody></table>',
          '#/admin/stewards'));
        wire();
    }
    function wire() {
      var addBtn = document.getElementById('stw-add');
      if (addBtn) addBtn.onclick = function () {
        api.get('/api/admin/stewards/next-id').then(function (r) {
          nextId = r.next_id; adding = true; editId = null; load();
        }).catch(function (err) { showErr(err.message); });
      };
      Array.prototype.forEach.call(document.querySelectorAll('[data-edit]'), function (b) {
        b.onclick = function () { editId = parseInt(b.getAttribute('data-edit'), 10); adding = false; load(); };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-del]'), function (b) {
        b.onclick = function () {
          var id = b.getAttribute('data-del');
          var nm = b.getAttribute('data-name') || '';
          var msg = 'Delete steward ' + id + (nm ? ' (' + nm + ')' : '') + '?' + NL + NL +
            'Warning - this also removes:' + NL +
            '- their login and all of their roles' + NL +
            '- ALL of their company assignments' + NL +
            'Messages, documents, forms, and tickets they created stay, but lose their name as the author. ' +
            'Commissions keep the steward number but lose the name behind it. This cannot be undone.';
          if (!window.confirm(msg)) return;
          api.delete('/api/admin/stewards/' + id).then(function () { load(); })
            .catch(function (err) { showErr(err.message); });
        };
      });
      document.querySelectorAll('[data-doc-up]').forEach(function (b) {
        b.onclick = function () {
          var id = b.getAttribute('data-id');
          var type = b.getAttribute('data-doc-up');
          var inp = document.createElement('input');
          inp.type = 'file';
          inp.onchange = function () {
            if (!inp.files || !inp.files[0]) return;
            var fd = new FormData();
            fd.append('file', inp.files[0]);
            uploadFile('/api/admin/stewards/' + id + '/documents/' + type, fd).then(function () { load(); })
              .catch(function (err) { showErr(err.message); });
          };
          inp.click();
        };
      });
      document.querySelectorAll('[data-doc-dl]').forEach(function (b) {
        b.onclick = function () {
          var headers = {};
          if (api.token) headers['Authorization'] = 'Bearer ' + api.token;
          fetch('/api/admin/stewards/' + b.getAttribute('data-id') + '/documents/' + b.getAttribute('data-doc-dl') + '/download', { headers: headers }).then(function (resp) {
            if (!resp.ok) throw new Error('Download failed');
            return resp.blob();
          }).then(function (blob) {
            var url = URL.createObjectURL(blob);
            var aEl = document.createElement('a');
            aEl.href = url;
            aEl.download = b.getAttribute('data-fn');
            document.body.appendChild(aEl);
            aEl.click();
            setTimeout(function () { URL.revokeObjectURL(url); aEl.remove(); }, 500);
          }).catch(function (err) { showErr(err.message); });
        };
      });
      document.querySelectorAll('[data-doc-del]').forEach(function (b) {
        b.onclick = function () {
          var label = b.getAttribute('data-doc-del') === 'w9' ? 'W9' : 'ACH';
          if (!confirm('Delete the ' + label + ' document on file for this steward?')) return;
          api.delete('/api/admin/stewards/' + b.getAttribute('data-id') + '/documents/' + b.getAttribute('data-doc-del'))
            .then(function () { load(); })
            .catch(function (err) { showErr(err.message); });
        };
      });
      var cancel = document.getElementById('stw-cancel');
      if (cancel) cancel.onclick = function () { adding = false; editId = null; load(); };
      var save = document.getElementById('stw-save');
      if (!save) return;
      save.onclick = function () {
        var first = document.getElementById('stw-first').value.trim();
        var last = document.getElementById('stw-last').value.trim();
        var email = document.getElementById('stw-email').value.trim();
        var phone = document.getElementById('stw-phone').value.trim();
        var stmtEmail = document.getElementById('stw-stmt').value.trim();
        var pw = document.getElementById('stw-password').value;
        if (!first) { showErr('First name is required'); return; }
        if (!last) { showErr('Last name is required'); return; }
        if (!email || email.indexOf('@') === -1) { showErr('A valid email is required'); return; }
        if (stmtEmail && stmtEmail.indexOf('@') === -1) { showErr('Statement Email must be a valid email address'); return; }
        if (pw && pw.length < 8) { showErr('Password must be at least 8 characters'); return; }
        var fields = { first_name: first, last_name: last, email: email, phone: phone || null, statement_email: stmtEmail || null };
        if (pw) fields.password = pw;
        if (adding) {
          var payload = fields;
          if (isAdmin) {
            var idEl = document.getElementById('stw-id');
            var wantId = idEl ? parseInt(idEl.value, 10) : NaN;
            if (wantId && wantId !== nextId) payload.id = wantId;
          }
          api.post('/api/admin/stewards', payload).then(function (res) {
            if (isAdmin) {
              var roles = pickedRoles();
              if (roles.length > 1 || (roles.length === 1 && roles[0] !== 'steward')) {
                return api.post('/api/admin/set-roles', { steward_id: res.id, roles: roles }).then(function () { adding = false; load(); });
              }
            }
            adding = false; load();
          }).catch(function (err) { showErr(err.message); });
          return;
        }
        var curId = editId;
        function after(id) {
          if (isAdmin) {
            var roles = pickedRoles();
            if (roles.length === 0) { showErr('Pick at least one role'); return; }
            api.post('/api/admin/set-roles', { steward_id: id, roles: roles }).then(function () { editId = null; load(); })
              .catch(function (err) { showErr(err.message); });
          } else { editId = null; load(); }
        }
        if (isAdmin) {
          var idEl2 = document.getElementById('stw-id');
          var wantId2 = idEl2 ? parseInt(idEl2.value, 10) : curId;
          if (wantId2 && wantId2 !== curId) {
            api.post('/api/admin/stewards/' + curId + '/renumber', { new_id: wantId2 })
              .then(function () { return api.put('/api/admin/stewards/' + wantId2, fields); })
              .then(function () { after(wantId2); })
              .catch(function (err) { showErr(err.message); });
            return;
          }
        }
        api.put('/api/admin/stewards/' + curId, fields).then(function () { after(curId); })
          .catch(function (err) { showErr(err.message); });
      };
    }
    load();
  });
}

// ---------------------------------------------------------------- admin: commissions (cards per company)
function viewAdminCommissions() {
  requireUser(function () {
    var ar = activeRole();
    if (ar !== 'admin' && ar !== 'top_dog' && ar !== 'onboarding') { location.hash = '#/dashboard'; return; }
    var canEdit = ar === 'admin' || ar === 'onboarding';
    var isAdmin = ar === 'admin';
    var SLOTS = 7;
    var cmQuery = '';
    var cmExact = null;
    var cmStatusFilter = 'active';
    function fmtDec(p) { return String(Math.round((Number(p) / 100) * 1000000) / 1000000); }
    function fmtTotal(sum) { return String(Math.round(sum * 100) / 100) + '%'; }
    var schedStatus = {};
    function load() {
      api.get('/api/admin/commissions-by-company').then(function (list) {
        if (canEdit) {
          api.get('/api/admin/companies/commission-schedules-status').then(function (st) {
            schedStatus = st || {};
            renderList(list);
          }).catch(function () { schedStatus = {}; renderList(list); });
        } else {
          renderList(list);
        }
      }).catch(function (err) { render(shell(errorHtml(err.message), '#/admin/commissions')); });
    }
    function renderList(list) {
        var byCode = {};
        list.forEach(function (c) { byCode[c.company_code] = c; });
        var head = '<tr><th class="frz frz1 cm-code">COMPANY_CODE</th><th class="frz frz2 cm-name">COMPANY_NAME</th><th class="frz frz3 cm-ein">EIN</th>';
        for (var i = 0; i < SLOTS; i++) {
          head += '<th class="cm-id">STEWARD #' + (i + 1) + '</th><th class="cm-pct">#' + (i + 1) + ' %</th>';
        }
        head += '<th class="cm-total">Total %</th><th class="cm-status">Company Status</th>' +
          (canEdit ? '<th class="cm-sched">Commission Schedule</th><th class="cm-act">Edit</th>' : '') +
          (isAdmin ? '<th class="cm-act">Delete</th>' : '') + '</tr>';
        var rows = list.map(function (c) {
          var cells = '<td class="frz frz1"><b>' + esc(c.company_code) + '</b></td><td class="frz frz2">' + esc(c.company_name) + '</td><td class="frz frz3">' + esc(c.ein || '') + '</td>';
          for (var i = 0; i < SLOTS; i++) {
            var s = c.stewards[i];
            if (s) {
              cells += '<td class="cm-id">' + esc(s.steward_code + (s.name ? ' - ' + s.name : '')) + '</td><td class="cm-pct">' + esc(fmtDec(s.pct)) + '</td>';
            } else {
              cells += '<td class="cm-id"></td><td class="cm-pct"></td>';
            }
          }
          var sum = c.stewards.reduce(function (a, s) { return a + Number(s.pct); }, 0);
          var totalCell;
          if (c.stewards.length === 0) totalCell = '<td class="cm-total muted">&mdash;</td>';
          else if (Math.abs(sum - 100) <= 0.01) totalCell = '<td class="cm-total" style="color:#137333;"><b>' + esc(fmtTotal(sum)) + '</b></td>';
          else totalCell = '<td class="cm-total" style="color:#b3261e;"><b>' + esc(fmtTotal(sum)) + '</b></td>';
          cells += totalCell;
          cells += '<td class="cm-status">' + (c.company_status === 'TERMED' ? '<b>TERMED</b>' : esc(c.company_status || '')) + '</td>';
          if (canEdit) {
            var sfn = schedStatus[c.company_code];
            var sc = '<span style="white-space:nowrap;"><button class="btn btn-small" data-sched-up="' + esc(c.company_code) + '">' + (sfn ? 'Replace' : 'Upload') + '</button>';
            if (sfn) {
              sc += ' <button class="btn btn-small" data-sched-dl="' + esc(c.company_code) + '" data-fn="' + esc(sfn) + '">Download</button>' +
                ' <button class="btn btn-small btn-danger" data-sched-del="' + esc(c.company_code) + '">Delete</button>';
            }
            sc += '</span>';
            if (sfn) sc += '<div class="muted" style="font-size:11px;">' + esc(sfn) + '</div>';
            cells += '<td class="cm-sched">' + sc + '</td>';
            cells += '<td class="cm-act"><button class="btn btn-small" data-editcm="' + esc(c.company_code) + '">Edit</button></td>';
          }
          if (isAdmin) {
            cells += '<td class="cm-act"><button class="btn btn-small btn-danger" data-delcm="' + esc(c.company_code) + '">Delete</button></td>';
          }
          return '<tr data-status="' + esc(c.company_status || '') + '" data-name="' + esc(String(c.company_name || '').toLowerCase()) + '" data-code="' + esc(c.company_code) + '">' + cells + '</tr>';
        }).join('');
        var slotRow = function (i) {
          return '<div class="form-inline" style="margin-bottom:6px;">' +
            '<label>Steward #' + (i + 1) + ' ID<br><input id="cm-s-' + i + '" type="text" size="10"></label> ' +
            '<span id="cm-n-' + i + '" class="muted" style="min-width:180px;"></span> ' +
            '<label>% (decimal)<br><input id="cm-p-' + i + '" type="text" size="8" placeholder="0.125"></label></div>';
        };
        var slotRows = '';
        for (var si2 = 0; si2 < SLOTS + 3; si2++) slotRows += slotRow(si2);
        var editor =
          '<div class="card" id="cm-editor" style="display:none;"><div class="card-title" id="cm-title">Edit Commissions</div>' +
          '<p class="muted" id="cm-co-line"></p>' + slotRows +
          '<p id="cm-total-line" style="font-weight:bold;"></p>' +
          '<div id="cm-out"></div>' +
          '<button class="btn btn-primary" id="cm-save">Save</button> ' +
          '<button class="btn" id="cm-cancel">Cancel</button></div>';
        render(shell(
          '<h2>Commissions</h2>' +
          '<p class="muted">Companies appear as they are added to the Company table. Onboarding and Admin can edit Steward IDs and Percentages. An Admin can delete a company\'s commission row (all of its splits) &mdash; the company itself is not deleted. No one can delete a company from this page.</p>' +
          '<div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap;margin-top:14px;">' +
            '<div style="position:relative;flex:1;min-width:260px;">' +
              '<label>Search</label> <span style="display:inline-flex;gap:2px;align-items:center;"><input id="cmSearch" type="text" placeholder="Start typing a company name..." autocomplete="off"><button class="btn btn-small" id="cmReset" type="button">Reset</button></span>' +
              '<div id="cmSuggest" style="position:absolute;left:0;right:0;top:100%;background:#fff;border:1px solid #ccc;z-index:5;display:none;"></div>' +
            '</div>' +
            '<div><label>Status <select id="cmStatusFilter">' +
              '<option value="active" selected>Active</option>' +
              '<option value="pending">Pending</option>' +
              '<option value="termed">Termed</option>' +
              '<option value="active_pending">Active &amp; Pending</option>' +
              '<option value="all">All</option>' +
            '</select></label></div>' +
          '</div>' +
          (canEdit ? editor : '') +
          '<div id="cm-sched-out"></div>' +
          '<div class="fullwidth"><div class="comm-scroll"><table class="data-table commissions-table"><thead>' + head + '</thead>' +
          '<tbody id="cmrows">' + rows + '</tbody></table></div></div>',
          '#/admin/commissions'));
        // Search + status filter (Parent-page style, v6.8). Rows are hidden
        // in place so the editor and button wiring are untouched.
        (function () {
          var searchEl = document.getElementById('cmSearch');
          var statusEl = document.getElementById('cmStatusFilter');
          searchEl.value = cmQuery;
          statusEl.value = cmStatusFilter;
          var cmSuggestClosed = false;
          function paintSuggest() {
            var box = document.getElementById('cmSuggest');
            if (!cmQuery || cmExact || cmSuggestClosed) { box.style.display = 'none'; box.innerHTML = ''; return; }
            var q = cmQuery.toLowerCase();
            var matches = list.filter(function (c) { return String(c.company_name || '').toLowerCase().indexOf(q) !== -1; }).slice(0, 10);
            if (!matches.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
            box.innerHTML = matches.map(function (c) {
              return '<div data-cmsuggest="' + esc(c.company_code) + '" style="padding:6px 8px;cursor:pointer;border-bottom:1px solid #eee;">' +
                esc(c.company_name) + ' <span class="muted">(' + esc(c.company_code) + ')</span></div>';
            }).join('');
            box.style.display = 'block';
            box.querySelectorAll('[data-cmsuggest]').forEach(function (el) {
              el.onclick = function () {
                cmExact = el.getAttribute('data-cmsuggest');
                var cc = byCode[cmExact] || {};
                cmQuery = cc.company_name || cmExact;
                searchEl.value = cmQuery;
                apply();
              };
            });
          }
          function apply() {
            document.querySelectorAll('#cmrows tr').forEach(function (tr) {
              var s = tr.getAttribute('data-status');
              var show = cmStatusFilter === 'all' ||
                (cmStatusFilter === 'active' && s === 'ACTIVE') ||
                (cmStatusFilter === 'pending' && s === 'PENDING') ||
                (cmStatusFilter === 'termed' && s === 'TERMED') ||
                (cmStatusFilter === 'active_pending' && s !== 'TERMED');
              if (show && cmExact) show = tr.getAttribute('data-code') === cmExact;
              else if (show && cmQuery) {
                var q = cmQuery.toLowerCase();
                show = (tr.getAttribute('data-name') || '').indexOf(q) !== -1 || (tr.getAttribute('data-code') || '').toLowerCase().indexOf(q) !== -1;
              }
              tr.style.display = show ? '' : 'none';
            });
            paintSuggest();
          }
          searchEl.addEventListener('input', function (e) { cmQuery = e.target.value; cmExact = null; cmSuggestClosed = false; apply(); });
          searchEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); cmSuggestClosed = true; apply(); }
          });
          document.getElementById('cmReset').onclick = function () {
            cmExact = null; cmQuery = ''; cmSuggestClosed = false; searchEl.value = ''; apply();
          };
          statusEl.onchange = function (e) { cmStatusFilter = e.target.value; apply(); };
          apply();
        })();
        if (isAdmin) {
          document.querySelectorAll('[data-delcm]').forEach(function (b) {
            b.onclick = function () {
              var code = b.getAttribute('data-delcm');
              var c = byCode[code] || {};
              if (!window.confirm('Delete the commission row for ' + code + ' — ' + (c.company_name || '') + '? All of its steward splits are removed. The company itself stays.')) return;
              api.delete('/api/admin/commissions/' + encodeURIComponent(code)).then(function () { load(); })
                .catch(function (err) { alert(err.message); });
            };
          });
        }
        if (canEdit) {
          var stewardNames = {};
          api.get('/api/admin/stewards').then(function (sts) {
            sts.forEach(function (s) {
              stewardNames[s.id] = ((s.first_name || '') + ' ' + (s.last_name || '')).trim() || s.email || '';
            });
          }).catch(function () {});
          var editingCode = null;
          var editorEl = document.getElementById('cm-editor');
          var slotCount = SLOTS;
          function readSlots() {
            var entries = [];
            var bad = [];
            for (var i = 0; i < slotCount; i++) {
              var sidRaw = document.getElementById('cm-s-' + i).value.trim();
              var pctRaw = document.getElementById('cm-p-' + i).value.trim();
              if (!sidRaw && !pctRaw) continue;
              var sid = parseInt(sidRaw, 10);
              var dec = parseFloat(pctRaw);
              if (isNaN(sid) || sid <= 0 || isNaN(dec)) { bad.push(i + 1); continue; }
              entries.push({ steward_code: sid, pct: dec, slot: i + 1 });
            }
            return { entries: entries, bad: bad };
          }
          function refreshTotal() {
            var r = readSlots();
            var totalLine = document.getElementById('cm-total-line');
            var saveBtn = document.getElementById('cm-save');
            var sumDec = r.entries.reduce(function (a, x) { return a + x.pct; }, 0);
            var sumPct = Math.round(sumDec * 10000) / 100;
            var seen = {};
            var dup = false;
            r.entries.forEach(function (x) { if (seen[x.steward_code]) dup = true; seen[x.steward_code] = true; });
            r.entries.forEach(function (x) {
              var hint = document.getElementById('cm-n-' + (x.slot - 1));
              if (hint) {
                if (stewardNames[x.steward_code]) { hint.textContent = stewardNames[x.steward_code]; hint.style.color = ''; }
                else { hint.textContent = 'not on the steward list'; hint.style.color = '#b3261e'; }
              }
            });
            if (r.entries.length === 0 && r.bad.length === 0) {
              totalLine.textContent = 'All rows are blank - saving clears this company\'s commissions.';
              totalLine.style.color = '';
              saveBtn.disabled = false;
            } else if (r.bad.length) {
              totalLine.textContent = 'Row(s) ' + r.bad.join(', ') + ' need both a Steward ID and a %.';
              totalLine.style.color = '#b3261e';
              saveBtn.disabled = true;
            } else if (dup) {
              totalLine.textContent = 'The same steward is listed twice - combine their share into one row.';
              totalLine.style.color = '#b3261e';
              saveBtn.disabled = true;
            } else {
              totalLine.textContent = 'Total: ' + sumPct + '%' + (Math.abs(sumDec - 1) <= 0.0001 ? ' - ready to save.' : ' - must equal 100% to save.');
              totalLine.style.color = Math.abs(sumDec - 1) <= 0.0001 ? '#137333' : '#b3261e';
              saveBtn.disabled = Math.abs(sumDec - 1) > 0.0001;
            }
          }
          function openEditor(c) {
            editingCode = c.company_code;
            slotCount = Math.min(SLOTS + 3, Math.max(SLOTS, c.stewards.length));
            for (var i = 0; i < SLOTS + 3; i++) {
              var rowEl = document.getElementById('cm-s-' + i).closest('.form-inline');
              rowEl.style.display = i < slotCount ? '' : 'none';
              document.getElementById('cm-s-' + i).value = '';
              document.getElementById('cm-p-' + i).value = '';
              document.getElementById('cm-n-' + i).textContent = '';
            }
            c.stewards.forEach(function (s, i) {
              document.getElementById('cm-s-' + i).value = s.steward_code;
              document.getElementById('cm-p-' + i).value = fmtDec(s.pct);
              document.getElementById('cm-n-' + i).textContent = s.name || '';
            });
            document.getElementById('cm-title').textContent = 'Edit Commissions - ' + c.company_code;
            document.getElementById('cm-co-line').textContent = c.company_name + (c.ein ? ' - EIN ' + c.ein : '') + ' (company code, name, and EIN come from the Companies page and are not editable here). Enter each steward\'s ID and their % as a decimal (0.125 = 12.5%). The % column must add up to 100% before you can save; Cancel always works.';
            document.getElementById('cm-out').innerHTML = '';
            editorEl.style.display = '';
            editorEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
            refreshTotal();
          }
          document.querySelectorAll('[data-editcm]').forEach(function (b) {
            b.onclick = function () { openEditor(byCode[b.getAttribute('data-editcm')]); };
          });
          document.querySelectorAll('[data-sched-up]').forEach(function (b) {
            b.onclick = function () {
              var code = b.getAttribute('data-sched-up');
              var out = document.getElementById('cm-sched-out');
              var inp = document.createElement('input');
              inp.type = 'file';
              inp.onchange = function () {
                if (!inp.files || !inp.files[0]) return;
                out.innerHTML = '<p class="muted">Reading the Commission Schedule for ' + esc(code) + '...</p>';
                var fd = new FormData();
                fd.append('file', inp.files[0]);
                uploadFile('/api/admin/companies/' + encodeURIComponent(code) + '/commission-schedule', fd).then(function (r) {
                  out.innerHTML = '<p style="color:#137333;">Commission Schedule saved for ' + esc(code) + ' - ' + r.entries + ' steward(s) loaded from the file. Check the row, and use Edit if anything needs fixing.</p>';
                  load();
                }).catch(function (err) { out.innerHTML = errorHtml(err.message); });
              };
              inp.click();
            };
          });
          document.querySelectorAll('[data-sched-dl]').forEach(function (b) {
            b.onclick = function () {
              var headers = {};
              if (api.token) headers['Authorization'] = 'Bearer ' + api.token;
              fetch('/api/admin/companies/' + encodeURIComponent(b.getAttribute('data-sched-dl')) + '/commission-schedule/download', { headers: headers }).then(function (resp) {
                if (!resp.ok) throw new Error('Download failed');
                return resp.blob();
              }).then(function (blob) {
                var url = URL.createObjectURL(blob);
                var aEl = document.createElement('a');
                aEl.href = url;
                aEl.download = b.getAttribute('data-fn');
                document.body.appendChild(aEl);
                aEl.click();
                setTimeout(function () { URL.revokeObjectURL(url); aEl.remove(); }, 500);
              }).catch(function (err) { document.getElementById('cm-sched-out').innerHTML = errorHtml(err.message); });
            };
          });
          document.querySelectorAll('[data-sched-del]').forEach(function (b) {
            b.onclick = function () {
              var code = b.getAttribute('data-sched-del');
              if (!confirm('Delete the Commission Schedule file for company ' + code + '? The commission percentages in the row stay as they are.')) return;
              api.delete('/api/admin/companies/' + encodeURIComponent(code) + '/commission-schedule')
                .then(function () { load(); })
                .catch(function (err) { document.getElementById('cm-sched-out').innerHTML = errorHtml(err.message); });
            };
          });
          for (var ii = 0; ii < SLOTS + 3; ii++) {
            document.getElementById('cm-s-' + ii).oninput = refreshTotal;
            document.getElementById('cm-p-' + ii).oninput = refreshTotal;
          }
          document.getElementById('cm-cancel').onclick = function () { editorEl.style.display = 'none'; };
          document.getElementById('cm-save').onclick = function () {
            var out = document.getElementById('cm-out');
            var r = readSlots();
            var entries = r.entries.map(function (x) { return { steward_code: x.steward_code, pct: x.pct }; });
            out.innerHTML = '<p class="muted">Saving...</p>';
            api.put('/api/admin/commissions/' + encodeURIComponent(editingCode), { entries: entries })
              .then(function () { viewAdminCommissions(); })
              .catch(function (err) { out.innerHTML = errorHtml(err.message); });
          };
        }
    }
    load();
  });
}

// ---------------------------------------------------------------- tickets
var TICKET_STATUSES = ['open', 'in_progress', 'waiting_customer', 'resolved'];
var TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'];
var TICKET_CATEGORIES = ['billing', 'onboarding', 'technical', 'general'];

function ticketStatusLabel(s) {
  if (s === 'in_progress') return 'In Progress';
  if (s === 'waiting_customer') return 'Waiting on Customer';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function canManageTicketsUI() {
  var r = activeRole();
  return r === 'admin' || r === 'top_dog' || r === 'service';
}

function viewTickets() {
  requireUser(function () {
    var r = activeRole();
    if (r !== 'admin') { location.hash = '#/dashboard'; return; }
    var fStatus = '', fPriority = '', fCategory = '', q = '';
    function load() {
      var params = [];
      if (fStatus) params.push('status=' + encodeURIComponent(fStatus));
      if (fPriority) params.push('priority=' + encodeURIComponent(fPriority));
      if (fCategory) params.push('category=' + encodeURIComponent(fCategory));
      if (q) params.push('q=' + encodeURIComponent(q));
      api.get('/api/tickets' + (params.length ? '?' + params.join('&') : '')).then(function (list) {
        api.get('/api/tickets-oncall').then(function (oc) {
          var ocHtml = oc && !oc.none
            ? '<p class="muted">On call now: <b>' + esc((oc.first_name || '') + ' ' + (oc.last_name || '')) + '</b> — new tickets auto-assign here.</p>'
            : '<p class="muted">No one is on call right now — new tickets will wait for manual assignment.</p>';
          var statusOpts = '<option value="">All statuses</option>' + TICKET_STATUSES.map(function (s) {
            return '<option value="' + s + '"' + (s === fStatus ? ' selected' : '') + '>' + ticketStatusLabel(s) + '</option>';
          }).join('');
          var priOpts = '<option value="">All priorities</option>' + TICKET_PRIORITIES.map(function (p) {
            return '<option value="' + p + '"' + (p === fPriority ? ' selected' : '') + '>' + p.charAt(0).toUpperCase() + p.slice(1) + '</option>';
          }).join('');
          var catOpts = '<option value="">All categories</option>' + TICKET_CATEGORIES.map(function (c) {
            return '<option value="' + c + '"' + (c === fCategory ? ' selected' : '') + '>' + c.charAt(0).toUpperCase() + c.slice(1) + '</option>';
          }).join('');
          var rows = list.map(function (t) {
            var creator = ((t.creator_first || '') + ' ' + (t.creator_last || '')).trim() || 'Unknown';
            var assignee = ((t.assignee_first || '') + ' ' + (t.assignee_last || '')).trim() || '<span class="muted">Unassigned</span>';
            var priClass = t.priority === 'urgent' ? 'pill-danger' : (t.priority === 'high' ? 'pill-warn' : 'pill');
            return '<tr><td><a href="#/tickets/' + t.id + '"><b>#' + t.id + '</b></a></td>' +
              '<td><a href="#/tickets/' + t.id + '">' + esc(t.title) + '</a><div class="muted">' + esc(t.company_code) +
              (t.company_name ? ' — ' + esc(t.company_name) : '') + '</div></td>' +
              '<td><span class="pill">' + ticketStatusLabel(t.status) + '</span></td>' +
              '<td><span class="' + priClass + '">' + esc(t.priority) + '</span></td>' +
              '<td>' + esc(t.category) + '</td>' +
              '<td>' + assignee + '</td>' +
              '<td class="muted">' + (t.reply_count || 0) + ' replies</td></tr>';
          }).join('');
          var body = list.length === 0
            ? '<p class="muted">No tickets found.</p>'
            : '<div class="table-scroll"><table class="data-table"><thead><tr>' +
              '<th>ID</th><th>Title</th><th>Status</th><th>Priority</th><th>Category</th><th>Assignee</th><th></th>' +
              '</tr></thead><tbody>' + rows + '</tbody></table></div>';
          render(shell(
            '<h2>Tickets</h2>' + ocHtml +
            '<div class="filterbar">' +
            '<input id="tq" type="search" placeholder="Search..." value="' + esc(q) + '"> ' +
            '<select id="tstatus">' + statusOpts + '</select> ' +
            '<select id="tpri">' + priOpts + '</select> ' +
            '<select id="tcat">' + catOpts + '</select> ' +
            '<a class="btn btn-primary" href="#/tickets/new">New ticket</a></div>' +
            '<div id="err"></div>' + body,
            '#/tickets'));
          document.getElementById('tq').oninput = function (e) { q = e.target.value; load(); };
          document.getElementById('tstatus').onchange = function (e) { fStatus = e.target.value; load(); };
          document.getElementById('tpri').onchange = function (e) { fPriority = e.target.value; load(); };
          document.getElementById('tcat').onchange = function (e) { fCategory = e.target.value; load(); };
        });
      }).catch(function (err) { render(shell(errorHtml(err.message), '#/tickets')); });
    }
    load();
  });
}

function viewNewTicket() {
  requireUser(function () {
    var r = activeRole();
    if (r !== 'admin') { location.hash = '#/dashboard'; return; }
    // Companies the user can file for.
    var coUrl = (r === 'admin' || r === 'top_dog' || r === 'service') ? '/api/admin/companies' : '/api/clients';
    api.get(coUrl).then(function (cos) {
      var list = Array.isArray(cos) ? cos : (cos.companies || []);
      var opts = list.map(function (c) {
        var code = c.company_code || c.code;
        var name = c.company_name || c.name || code;
        return '<option value="' + esc(code) + '">' + esc(code) + ' — ' + esc(name) + '</option>';
      }).join('');
      var catOpts = TICKET_CATEGORIES.map(function (c) {
        return '<option value="' + c + '">' + c.charAt(0).toUpperCase() + c.slice(1) + '</option>';
      }).join('');
      var priOpts = TICKET_PRIORITIES.map(function (p) {
        return '<option value="' + p + '"' + (p === 'medium' ? ' selected' : '') + '>' + p.charAt(0).toUpperCase() + p.slice(1) + '</option>';
      }).join('');
      render(shell(
        '<h2>New ticket</h2><div id="err"></div>' +
        '<form id="ntf" class="form">' +
        '<label>Company<select id="nt-co" required>' + opts + '</select></label>' +
        '<label>Title<input id="nt-title" required maxlength="200"></label>' +
        '<label>Description<textarea id="nt-desc" rows="6" required></textarea></label>' +
        '<label>Category<select id="nt-cat">' + catOpts + '</select></label>' +
        '<label>Priority<select id="nt-pri">' + priOpts + '</select></label>' +
        '<button class="btn btn-primary" type="submit">File ticket</button> ' +
        '<a class="btn" href="#/tickets">Cancel</a></form>',
        '#/tickets'));
      document.getElementById('ntf').onsubmit = function (e) {
        e.preventDefault();
        var data = {
          company_code: document.getElementById('nt-co').value,
          title: document.getElementById('nt-title').value,
          description: document.getElementById('nt-desc').value,
          category: document.getElementById('nt-cat').value,
          priority: document.getElementById('nt-pri').value
        };
        api.post('/api/tickets', data).then(function (r) {
          location.hash = '#/tickets/' + r.id;
        }).catch(function (err) {
          document.getElementById('err').innerHTML = errorHtml(err.message);
        });
      };
    }).catch(function (err) { render(shell(errorHtml(err.message), '#/tickets')); });
  });
}

function viewTicketDetail(id) {
  requireUser(function () {
    var r = activeRole();
    if (r !== 'admin') { location.hash = '#/dashboard'; return; }
    var manage = canManageTicketsUI();
    api.get('/api/tickets/' + id).then(function (t) {
      function nameOf(pref) {
        return ((t[pref + '_first'] || '') + ' ' + (t[pref + '_last'] || '')).trim() || 'Unknown';
      }
      var replies = (t.replies || []).map(function (rp) {
        var an = ((rp.first_name || '') + ' ' + (rp.last_name || '')).trim() || rp.email || 'Unknown';
        var tag = rp.is_internal ? ' <span class="pill-warn">internal</span>' : '';
        return '<div class="reply' + (rp.is_internal ? ' reply-internal' : '') + '">' +
          '<div class="reply-head"><b>' + esc(an) + '</b>' + tag +
          ' <span class="muted">' + esc(rp.created_at || '') + '</span></div>' +
          '<div class="reply-body">' + esc(rp.body).replace(/\n/g, '<br>') + '</div></div>';
      }).join('') || '<p class="muted">No replies yet.</p>';
      var mgmtHtml = '';
      if (manage) {
        mgmtHtml = '<div class="card"><div class="card-title">Manage</div><div class="form-inline">' +
          '<label>Status<select id="tm-status">' + TICKET_STATUSES.map(function (s) {
            return '<option value="' + s + '"' + (s === t.status ? ' selected' : '') + '>' + ticketStatusLabel(s) + '</option>';
          }).join('') + '</select></label> ' +
          '<label>Priority<select id="tm-pri">' + TICKET_PRIORITIES.map(function (p) {
            return '<option value="' + p + '"' + (p === t.priority ? ' selected' : '') + '>' + p + '</option>';
          }).join('') + '</select></label> ' +
          '<label>Assignee<select id="tm-assignee"><option value="">Unassigned</option></select></label> ' +
          '<button class="btn btn-primary" id="tm-save">Save</button></div><div id="tm-msg"></div></div>';
      }
      render(shell(
        '<h2>Ticket #' + t.id + '</h2><div id="err"></div>' +
        '<div class="card"><div class="card-title">' + esc(t.title) + '</div>' +
        '<p><span class="pill">' + ticketStatusLabel(t.status) + '</span> ' +
        '<span class="pill">' + esc(t.priority) + '</span> ' +
        '<span class="pill">' + esc(t.category) + '</span></p>' +
        '<p class="muted">' + esc(t.company_code) + (t.company_name ? ' — ' + esc(t.company_name) : '') +
        ' · Filed by ' + esc(nameOf('creator')) + ' · ' + esc(t.created_at || '') + '</p>' +
        '<p>' + esc(t.description).replace(/\n/g, '<br>') + '</p></div>' +
        mgmtHtml +
        '<h3>Replies</h3>' + replies +
        '<div class="card"><div class="card-title">Reply</div>' +
        '<form id="trf"><textarea id="tr-body" rows="4" required placeholder="Write a reply..."></textarea>' +
        (manage ? '<label><input type="checkbox" id="tr-internal"> Internal note (not visible to client)</label><br>' : '') +
        '<button class="btn btn-primary" type="submit">Send reply</button></form><div id="tr-msg"></div></div>',
        '#/tickets'));
      document.getElementById('trf').onsubmit = function (e) {
        e.preventDefault();
        var data = { body: document.getElementById('tr-body').value };
        var ichk = document.getElementById('tr-internal');
        if (ichk) data.is_internal = ichk.checked;
        api.post('/api/tickets/' + id + '/replies', data).then(function () { route(); })
          .catch(function (err) { document.getElementById('tr-msg').innerHTML = errorHtml(err.message); });
      };
      if (manage) {
        api.get('/api/tickets-service-team').then(function (team) {
          var sel = document.getElementById('tm-assignee');
          team.forEach(function (m) {
            var nm = ((m.first_name || '') + ' ' + (m.last_name || '')).trim() || m.email;
            var opt = document.createElement('option');
            opt.value = m.id; opt.textContent = nm;
            if (String(m.id) === String(t.assigned_to)) opt.selected = true;
            sel.appendChild(opt);
          });
        });
        document.getElementById('tm-save').onclick = function () {
          var data = {
            status: document.getElementById('tm-status').value,
            priority: document.getElementById('tm-pri').value,
            assigned_to: document.getElementById('tm-assignee').value || null
          };
          api.patch('/api/tickets/' + id, data).then(function () { route(); })
            .catch(function (err) { document.getElementById('tm-msg').innerHTML = errorHtml(err.message); });
        };
      }
    }).catch(function (err) { render(shell(errorHtml(err.message), '#/tickets')); });
  });
}

// ---------------------------------------------------------------- accounts receivable
function viewAR() {
  requireUser(function () {
    var r = activeRole();
    if (['admin', 'top_dog', 'service', 'steward'].indexOf(r) === -1) { location.hash = '#/dashboard'; return; }
    var manage = (r === 'admin' || r === 'top_dog' || r === 'service');
    api.get('/api/ar/watchlist').then(function (list) {
      api.get('/api/ar/summary').then(function (sum) {
        function tierBadge(t) {
          if (t === 3) return '<span class="pill-danger">30+ days</span>';
          if (t === 2) return '<span class="pill-warn">20+ days</span>';
          return '<span class="pill">10+ days</span>';
        }
        var rows = list.map(function (b) {
          var amt = fmtMoney(b.total_invoice || 0);
          var emailCell = b.billing_email
            ? esc(b.billing_email)
            : '<span class="muted">none</span> <button class="btn btn-link" data-setemail="' + esc(b.company_code) + '">set</button>';
          var holdBtn = manage
            ? ' <button class="btn btn-link" data-hold="' + b.id + '">hold</button>'
            : '';
          return '<tr>' +
            '<td><b>' + esc(b.company_code) + '</b><div class="muted">' + esc(b.company_name || '') + '</div></td>' +
            '<td>' + esc(String(b.payroll_date).slice(0, 10)) + '</td>' +
            '<td><b>' + amt + '</b></td>' +
            '<td><b>' + b.days_overdue + '</b></td>' +
            '<td>' + tierBadge(b.tier) + '</td>' +
            '<td>' + emailCell + '</td>' +
            '<td class="muted">' + (b.touch_count || 0) + ' touches' +
            (b.last_touch ? '<br>' + esc(String(b.last_touch).slice(0, 10)) : '') + '</td>' +
            '<td><button class="btn btn-link" data-detail="' + b.id + '">follow-ups</button>' +
            (manage ? ' <button class="btn btn-link" data-ticket="' + b.id + '">ticket</button>' + holdBtn : '') +
            '</td></tr>';
        }).join('');
        var body = list.length === 0
          ? '<p class="muted">No overdue bills. Everything is current.</p>'
          : '<div class="table-scroll"><table class="data-table"><thead><tr>' +
            '<th>Company</th><th>Payroll date</th><th>Amount</th><th>Days late</th><th>Tier</th>' +
            '<th>Billing email</th><th>Follow-ups</th><th></th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>';
        render(shell(
          '<h2>Accounts Receivable</h2>' +
          '<p class="muted">Bills are due upon receipt. ' +
          '<span class="pill">' + (sum.tier1 || 0) + ' at 10+ days</span> ' +
          '<span class="pill-warn">' + (sum.tier2 || 0) + ' at 20+ days</span> ' +
          '<span class="pill-danger">' + (sum.tier3 || 0) + ' at 30+ days</span> — ' +
          '<b>' + fmtMoney(sum.total_amount || 0) + '</b> outstanding.</p>' +
          '<div id="err"></div>' + body + '<div id="ardetail"></div>',
          '#/ar'));
        // Follow-up detail expander.
        document.querySelectorAll('[data-detail]').forEach(function (btn) {
          btn.onclick = function () {
            var invId = btn.getAttribute('data-detail');
            var bill = list.filter(function (b) { return String(b.id) === invId; })[0];
            api.get('/api/ar/followups/' + invId).then(function (fl) {
              var items = fl.map(function (f) {
                var an = ((f.first_name || '') + ' ' + (f.last_name || '')).trim() || 'system';
                var extra = f.promise_date ? ' <span class="muted">promise: ' + esc(f.promise_date.slice(0, 10)) + '</span>' : '';
                var tierTag = f.tier ? ' <span class="pill">tier ' + f.tier + '</span>' : '';
                return '<div class="reply"><div class="reply-head"><b>' + esc(f.action_type) + '</b>' + tierTag +
                  ' by ' + esc(an) + ' <span class="muted">' + esc(String(f.created_at).slice(0, 16).replace('T', ' ')) + '</span>' + extra + '</div>' +
                  (f.notes ? '<div class="reply-body">' + esc(f.notes).replace(/\n/g, '<br>') + '</div>' : '') + '</div>';
              }).join('') || '<p class="muted">No follow-ups logged yet.</p>';
              var logForm = manage ?
                '<div class="card"><div class="card-title">Log follow-up</div>' +
                '<form id="ar-logf" class="form-inline">' +
                '<select id="ar-action"><option value="call">Call</option><option value="email">Email</option>' +
                '<option value="note">Note</option><option value="promise">Promise to pay</option></select> ' +
                '<input id="ar-notes" placeholder="Notes" style="width: 260px;"> ' +
                '<input id="ar-promise" type="date" title="Promise date"> ' +
                '<button class="btn btn-primary" type="submit">Log</button></form><div id="ar-logmsg"></div></div>' : '';
              document.getElementById('ardetail').innerHTML =
                '<h3>Follow-ups: ' + esc(bill.company_code) + ' — ' + fmtMoney(bill.total_invoice || 0) + '</h3>' +
                items + logForm;
              var lf = document.getElementById('ar-logf');
              if (lf) lf.onsubmit = function (e) {
                e.preventDefault();
                api.post('/api/ar/followups', {
                  invoice_id: invId,
                  action_type: document.getElementById('ar-action').value,
                  notes: document.getElementById('ar-notes').value,
                  promise_date: document.getElementById('ar-promise').value || null
                }).then(function () { route(); })
                  .catch(function (err) { document.getElementById('ar-logmsg').innerHTML = errorHtml(err.message); });
              };
              document.getElementById('ardetail').scrollIntoView();
            });
          };
        });
        // Set billing email.
        document.querySelectorAll('[data-setemail]').forEach(function (btn) {
          btn.onclick = function () {
            var code = btn.getAttribute('data-setemail');
            var em = prompt('Billing email for ' + code + ':');
            if (em === null) return;
            api.patch('/api/ar/billing-email', { company_code: code, billing_email: em.trim() || null })
              .then(function () { route(); })
              .catch(function (err) { document.getElementById('err').innerHTML = errorHtml(err.message); });
          };
        });
        // Hold a bill.
        document.querySelectorAll('[data-hold]').forEach(function (btn) {
          btn.onclick = function () {
            var reason = prompt('Reason for putting this bill on hold (disputed, payment plan, etc.):');
            if (reason === null) return;
            api.patch('/api/ar/hold/' + btn.getAttribute('data-hold'), { hold: true, notes: reason })
              .then(function () { route(); })
              .catch(function (err) { document.getElementById('err').innerHTML = errorHtml(err.message); });
          };
        });
        // Open a ticket from a bill.
        document.querySelectorAll('[data-ticket]').forEach(function (btn) {
          btn.onclick = function () {
            var invId = btn.getAttribute('data-ticket');
            var bill = list.filter(function (b) { return String(b.id) === invId; })[0];
            api.post('/api/tickets', {
              company_code: bill.company_code,
              title: 'Overdue bill: ' + bill.company_code + ' ' + fmtMoney(bill.total_invoice || 0) + ' (' + bill.days_overdue + ' days)',
              description: 'Invoice #' + bill.id + ' for ' + (bill.company_name || bill.company_code) +
                ' is ' + bill.days_overdue + ' days overdue. Amount: ' + fmtMoney(bill.total_invoice || 0) +
                ', payroll date: ' + String(bill.payroll_date).slice(0, 10) + '.',
              category: 'billing',
              priority: bill.tier === 3 ? 'high' : 'medium'
            }).then(function (t) { location.hash = '#/tickets/' + t.id; })
              .catch(function (err) { document.getElementById('err').innerHTML = errorHtml(err.message); });
          };
        });
      });
    }).catch(function (err) { render(shell(errorHtml(err.message), '#/ar')); });
  });
}

// ---------------------------------------------------------------- admin: on-call schedule

// ---------------------------------------------------------------- admin: on-call schedule

// ---------------------------------------------------------------- admin: companies (the 10 values, with maintenance)
// Access (Leroy, v6.0): only an Admin can add a company, change a Parent
// Code or Company Code, or delete a company. Onboarding edits the other
// fields. Top Dog views only. Companies also arrive from Onboarding.
function viewAdminCompanies() {
  requireUser(function () {
    var ar = activeRole();
    if (ar !== 'admin' && ar !== 'top_dog' && ar !== 'onboarding') { location.hash = '#/dashboard'; return; }
    var canMaintain = ar === 'admin' || ar === 'onboarding';
    var isAdmin = ar === 'admin';
    api.get('/api/admin/companies').then(function (list) {
      function cell(v) { return '<td>' + (v === null || v === undefined || v === '' ? '&mdash;' : esc(v)) + '</td>'; }
      function parentCode(c) { return c.parent_company_code; }
      function parentName(c) { return c.parent_company_name; }
      function statusOf(c) { return c.company_status || (c.active === false ? 'TERMED' : 'ACTIVE'); }
      var byCode = {};
      list.forEach(function (c) { byCode[c.company_code] = c; });
      var rows = list.map(function (c) {
        var status = statusOf(c);
        var statusHtml = status === 'TERMED' ? '<b>TERMED</b>' : esc(status);
        var actions = '';
        if (canMaintain) {
          actions = '<td style="white-space:nowrap;"><button class="btn btn-small" data-edit="' + esc(c.company_code) + '">Edit</button>' +
            (isAdmin ? ' <button class="btn btn-small" data-del="' + esc(c.company_code) + '">Delete</button>' : '') + '</td>';
        }
        return '<tr data-status="' + status + '" data-name="' + esc(String(c.company_name || '').toLowerCase()) + '" data-code="' + esc(c.company_code) + '">' + cell(parentCode(c)) + cell(parentName(c)) +
          '<td><b>' + esc(c.company_code) + '</b></td>' + '<td style="white-space:nowrap;min-width:100px;">' + esc(c.ein || '') + '</td>' + '<td>' + esc(c.company_name) + '</td>' +
          cell(c.address_1) + cell(c.city) + cell(c.state) + cell(c.zip) +
          '<td>' + statusHtml + '</td>' +
          '<td id="ach-' + esc(c.company_code) + '"><span class="muted">...</span></td>' + actions + '</tr>';
      }).join('');
      var fld = function (id, label, val, ph) {
        return '<label style="display:block;margin:0 10px 8px 0;">' + label + '<br>' +
          '<input id="' + id + '" type="text" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '" style="min-width:170px;"></label>';
      };
      var editor =
        '<div class="card" id="co-editor" style="display:none;"><div class="card-title" id="co-editor-title">Add Company</div>' +
        '<div style="display:flex;flex-wrap:wrap;">' +
        '<label style="display:block;margin:0 10px 8px 0;">Parent Code<br>' +
        '<select id="co-f-parent-code" style="min-width:170px;"></select></label>' +
        '<label style="display:block;margin:0 10px 8px 0;">Parent Name (from the Parent page)<br>' +
        '<input id="co-f-parent-name" type="text" value="" readonly style="min-width:170px;background:#f2f2f2;"></label>' +
        fld('co-f-code', 'Company Code', '', 'four numbers') +
        fld('co-f-ein', 'EIN', '', '47-5096437') +
        fld('co-f-name', 'Company Name', '') +
        fld('co-f-addr', 'Company Address 1', '') +
        fld('co-f-city', 'Company City', '') +
        fld('co-f-state', 'Company State', '') +
        fld('co-f-zip', 'Company Zip', '') +
        '<label style="display:block;margin:0 10px 8px 0;">Company Status<br>' +
        '<select id="co-f-status"><option value="ACTIVE">ACTIVE</option><option value="PENDING">PENDING</option><option value="TERMED">TERMED</option></select></label>' +
        '</div>' +
        '<p class="muted">All fields are required. Parent: pick an existing Parent Code &mdash; the Parent Name comes from the Parent page and cannot be changed here. To add, rename, or delete a Parent, use the Parent page. Company Code is four numbers and must be unique. EIN is two numbers, a dash, and seven more numbers. EIN and Zip are stored as text, so leading zeros are kept.</p>' +
        '<div id="co-editor-out"></div>' +
        '<button class="btn btn-primary" id="co-save">Save</button> ' +
        '<button class="btn" id="co-cancel">Cancel</button>' +
        '</div>';
      render(shell(
        '<h2>Companies</h2>' +
        '<p class="muted">Only an Admin can add a company, change a Company Code, or delete a company. Admin and Onboarding can reassign a company to another existing Parent by picking its Parent Code &mdash; Parent Codes and Parent Names themselves are managed on the Parent page, and the Parent Name shown here is the one from the Parent page. Top Dog can view only. New accounts also arrive automatically from the Onboarding process, with Parent and Company Codes assigned.</p>' +
        (isAdmin ? '<p><button class="btn btn-primary" id="co-add">Add Company</button></p>' : '') + (canMaintain ? editor : '') +
        '<div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap;margin-top:14px;">' +
          '<div style="position:relative;flex:1;min-width:260px;">' +
            '<label>Search</label> <span style="display:inline-flex;gap:2px;align-items:center;"><input id="coSearch" type="text" placeholder="Start typing a company name..." autocomplete="off"><button class="btn btn-small" id="coReset" type="button">Reset</button></span>' +
            '<div id="coSuggest" style="position:absolute;left:0;right:0;top:100%;background:#fff;border:1px solid #ccc;z-index:5;display:none;"></div>' +
          '</div>' +
          '<div><label>Status <select id="coStatusFilter">' +
            '<option value="active">Active</option>' +
            '<option value="pending">Pending</option>' +
            '<option value="termed">Termed</option>' +
            '<option value="active_pending" selected>Active &amp; Pending</option>' +
            '<option value="all">All</option>' +
          '</select></label></div>' +
        '</div>' +
        '<div class="table-scroll"><table class="data-table"><thead>' +
        '<tr><th>Parent Code</th><th>Parent Name</th><th>Company Code</th><th style="white-space:nowrap;min-width:100px;">EIN</th><th>Company Name</th>' +
        '<th>Company Address 1</th><th>Company City</th><th>Company State</th><th>Company Zip</th><th>Company Status</th><th>ACH</th>' +
        (canMaintain ? '<th>Actions</th>' : '') + '</tr></thead>' +
        '<tbody id="companyrows">' + rows + '</tbody></table></div>' +
        '<input type="file" id="coAchFile" style="display:none;">',
        '#/admin/companies'));
      // Search + status filter, operated like the Parent page (v6.7):
      // type-ahead suggestions on the left, status dropdown on the right.
      var coQuery = '';
      var coExact = null;
      var parentsList = [];
      var parentNameByCode = {};
      function applyCompanyFilter() {
        var v = document.getElementById('coStatusFilter').value;
        document.querySelectorAll('#companyrows tr').forEach(function (tr) {
          var s = tr.getAttribute('data-status');
          var show = v === 'all' || (v === 'active' && s === 'ACTIVE') || (v === 'pending' && s === 'PENDING') ||
            (v === 'termed' && s === 'TERMED') || (v === 'active_pending' && s !== 'TERMED');
          if (show && coExact) show = tr.getAttribute('data-code') === coExact;
          else if (show && coQuery) {
            var q = coQuery.toLowerCase();
            show = (tr.getAttribute('data-name') || '').indexOf(q) !== -1 || (tr.getAttribute('data-code') || '').toLowerCase().indexOf(q) !== -1;
          }
          tr.style.display = show ? '' : 'none';
        });
        paintCoSuggest();
      }
      var coSuggestClosed = false;
      function paintCoSuggest() {
        var box = document.getElementById('coSuggest');
        if (!coQuery || coExact || coSuggestClosed) { box.style.display = 'none'; box.innerHTML = ''; return; }
        var q = coQuery.toLowerCase();
        var matches = list.filter(function (c) { return String(c.company_name || '').toLowerCase().indexOf(q) !== -1; }).slice(0, 10);
        if (!matches.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
        box.innerHTML = matches.map(function (c) {
          return '<div data-cosuggest="' + esc(c.company_code) + '" style="padding:6px 8px;cursor:pointer;border-bottom:1px solid #eee;">' +
            esc(c.company_name) + ' <span class="muted">(' + esc(c.company_code) + ')</span></div>';
        }).join('');
        box.style.display = 'block';
        box.querySelectorAll('[data-cosuggest]').forEach(function (el) {
          el.onclick = function () {
            coExact = el.getAttribute('data-cosuggest');
            var cc = byCode[coExact] || {};
            coQuery = cc.company_name || coExact;
            document.getElementById('coSearch').value = coQuery;
            applyCompanyFilter();
          };
        });
      }
      document.getElementById('coSearch').addEventListener('input', function (e) {
        coQuery = e.target.value; coExact = null; coSuggestClosed = false; applyCompanyFilter();
      });
      document.getElementById('coSearch').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); coSuggestClosed = true; applyCompanyFilter(); }
      });
      document.getElementById('coReset').onclick = function () {
        coQuery = ''; coExact = null; coSuggestClosed = false;
        document.getElementById('coSearch').value = '';
        applyCompanyFilter();
      };
      document.getElementById('coStatusFilter').onchange = applyCompanyFilter;
      applyCompanyFilter();
      // Parents (for the editor's Parent Code dropdown) — the same list the
      // Parent page shows.
      api.get('/api/parent-page').then(function (ps) {
        parentsList = ps || [];
        parentsList.forEach(function (p) { parentNameByCode[p.parent_code] = p.parent_name; });
      }).catch(function () {});
      // ACH Authorization column: paint each cell from the status map.
      var pendingAch = null;
      function paintAch(achMap) {
        list.forEach(function (c) {
          var td = document.getElementById('ach-' + c.company_code);
          if (!td) return;
          var fname = achMap[c.company_code];
          if (fname) {
            var h = '<div>' + esc(fname) + '</div>' +
              '<button class="btn btn-small" data-ach-dl="' + esc(c.company_code) + '">Download</button>';
            if (canMaintain) {
              h += ' <button class="btn btn-small" data-ach-up="' + esc(c.company_code) + '">Replace</button>' +
                ' <button class="btn btn-small" data-ach-del="' + esc(c.company_code) + '">Delete</button>';
            }
            td.innerHTML = h;
          } else if (canMaintain) {
            td.innerHTML = '<button class="btn btn-small" data-ach-up="' + esc(c.company_code) + '">Upload</button>';
          } else {
            td.innerHTML = '<span class="muted">&mdash;</span>';
          }
        });
        tdWireAch();
      }
      function tdWireAch() {
        document.querySelectorAll('[data-ach-dl]').forEach(function (b) {
          b.onclick = function () { downloadFile('/api/admin/companies/' + encodeURIComponent(b.getAttribute('data-ach-dl')) + '/ach-document/download'); };
        });
        document.querySelectorAll('[data-ach-up]').forEach(function (b) {
          b.onclick = function () { pendingAch = b.getAttribute('data-ach-up'); document.getElementById('coAchFile').click(); };
        });
        document.querySelectorAll('[data-ach-del]').forEach(function (b) {
          b.onclick = function () {
            if (!window.confirm('Delete the ACH Authorization file for company ' + b.getAttribute('data-ach-del') + '?')) return;
            api.delete('/api/admin/companies/' + encodeURIComponent(b.getAttribute('data-ach-del')) + '/ach-document')
              .then(function () { viewAdminCompanies(); })
              .catch(function (err) { alert(err.message); });
          };
        });
      }
      document.getElementById('coAchFile').onchange = function (e) {
        var f = e.target.files[0];
        if (!f || !pendingAch) return;
        var fd = new FormData();
        fd.append('file', f);
        uploadFile('/api/admin/companies/' + encodeURIComponent(pendingAch) + '/ach-document', fd)
          .then(function () { pendingAch = null; e.target.value = ''; viewAdminCompanies(); })
          .catch(function (err) { alert(err.message); });
      };
      api.get('/api/admin/companies/ach-documents-status').then(paintAch)
        .catch(function () { paintAch({}); });
      if (canMaintain) {
        var editingCode = null;
        var editorEl = document.getElementById('co-editor');
        function fillParentName() {
          var sel = document.getElementById('co-f-parent-code');
          document.getElementById('co-f-parent-name').value = parentNameByCode[sel.value] || '';
        }
        function openEditor(c) {
          if (!parentsList.length) {
            api.get('/api/parent-page').then(function (ps) {
              parentsList = ps || [];
              parentsList.forEach(function (p) { parentNameByCode[p.parent_code] = p.parent_name; });
              openEditor(c);
            }).catch(function () { openEditor(c); });
            return;
          }
          editingCode = c ? c.company_code : null;
          document.getElementById('co-editor-title').textContent = c ? ('Edit Company ' + c.company_code) : 'Add Company';
          var sel = document.getElementById('co-f-parent-code');
          var cur = c ? (parentCode(c) || '') : '';
          var opts = '<option value="">Select a Parent Code</option>' + parentsList.map(function (p) {
            return '<option value="' + esc(p.parent_code) + '">' + esc(p.parent_code) + ' &mdash; ' + esc(p.parent_name) + '</option>';
          }).join('');
          if (cur && !parentNameByCode[cur]) {
            opts += '<option value="' + esc(cur) + '">' + esc(cur) + ' &mdash; ' + esc(parentName(c) || cur) + '</option>';
            parentNameByCode[cur] = parentName(c) || cur;
          }
          sel.innerHTML = opts;
          sel.value = cur;
          sel.onchange = fillParentName;
          fillParentName();
          document.getElementById('co-f-code').value = c ? c.company_code : '';
          document.getElementById('co-f-ein').value = c ? (c.ein || '') : '';
          document.getElementById('co-f-name').value = c ? c.company_name : '';
          document.getElementById('co-f-addr').value = c ? (c.address_1 || '') : '';
          document.getElementById('co-f-city').value = c ? (c.city || '') : '';
          document.getElementById('co-f-state').value = c ? (c.state || '') : '';
          document.getElementById('co-f-zip').value = c ? (c.zip || '') : '';
          document.getElementById('co-f-status').value = statusOf(c || {});
          // Parent Code: Admin and Onboarding both pick from existing
          // Parents (v6.7). Company Code stays Admin-only.
          document.getElementById('co-f-code').disabled = !isAdmin;
          document.getElementById('co-editor-out').innerHTML = '';
          editorEl.style.display = '';
          editorEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        var coAddBtn = document.getElementById('co-add');
        if (coAddBtn) coAddBtn.onclick = function () { openEditor(null); };
        document.getElementById('co-cancel').onclick = function () { editorEl.style.display = 'none'; };
        document.querySelectorAll('[data-edit]').forEach(function (b) {
          b.onclick = function () { openEditor(byCode[b.getAttribute('data-edit')]); };
        });
        document.getElementById('co-save').onclick = function () {
          var out = document.getElementById('co-editor-out');
          var v = {
            parent_code: document.getElementById('co-f-parent-code').value.trim(),
            parent_name: document.getElementById('co-f-parent-name').value.trim(),
            company_code: document.getElementById('co-f-code').value.trim(),
            ein: document.getElementById('co-f-ein').value.trim(),
            company_name: document.getElementById('co-f-name').value.trim(),
            address_1: document.getElementById('co-f-addr').value.trim(),
            city: document.getElementById('co-f-city').value.trim(),
            state: document.getElementById('co-f-state').value.trim(),
            zip: document.getElementById('co-f-zip').value.trim(),
            company_status: document.getElementById('co-f-status').value
          };
          var missing = Object.keys(v).filter(function (k) { return !v[k]; });
          if (missing.length) { out.innerHTML = errorHtml('All fields are required — some are still blank.'); return; }
          if (!/^\d{4}$/.test(v.company_code)) { out.innerHTML = errorHtml('Company Code must be four numbers.'); return; }
          if (!/^\d{2}-\d{7}$/.test(v.ein)) { out.innerHTML = errorHtml('EIN must be two numbers, a dash, and seven more numbers (for example 47-5096437).'); return; }
          out.innerHTML = '<p class="muted">Saving...</p>';
          var call = editingCode ? api.put('/api/admin/companies/' + encodeURIComponent(editingCode), v)
                                 : api.post('/api/admin/companies', v);
          call.then(function () { viewAdminCompanies(); })
            .catch(function (err) { out.innerHTML = errorHtml(err.message); });
        };
        if (isAdmin) {
          document.querySelectorAll('[data-del]').forEach(function (b) {
            b.onclick = function () {
              var code = b.getAttribute('data-del');
              var c = byCode[code] || {};
              var msg = 'Delete company ' + code + ' — ' + (c.company_name || '') + '?\n\n' +
                'This removes the company for good, along with its steward assignments, implementation record, commissions, and EIN cross-references. ' +
                'A company with bills on file cannot be deleted (the delete will be refused). This cannot be undone.';
              if (!confirm(msg)) return;
              api.delete('/api/admin/companies/' + encodeURIComponent(code)).then(function () { viewAdminCompanies(); })
                .catch(function (err) { alert(err.message); });
            };
          });
        }
      }
    }).catch(function (err) { render(shell(errorHtml(err.message), '#/admin/companies')); });
  });
}

// ---------------------------------------------------------------- admin: assignments (import only)
function viewAdminAssignments() {
  requireUser(function () {
    var ar = activeRole();
    if (ar !== 'admin' && ar !== 'top_dog') { location.hash = '#/dashboard'; return; }
    api.get('/api/admin/assignments').then(function (list) {
      var rows = list.map(function (a) {
        return '<tr><td><b>' + a.steward_id + '</b></td><td>' + esc(a.steward_name || '') + '</td>' +
          '<td><b>' + esc(a.company_code) + '</b></td><td>' + esc(a.company_name || '') + '</td></tr>';
      }).join('');
      render(shell(
        '<h2>Assignments</h2>' +
        '<div class="table-scroll"><table class="data-table"><thead><tr><th>Steward ID</th><th>Steward Name</th><th>Company Code</th><th>Company Name</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>',
        '#/admin/assignments'));
    }).catch(function (err) { render(shell(errorHtml(err.message), '#/admin/assignments')); });
  });
}
// ---------------------------------------------------------------- admin: import
function parseCSV(text) {
  var lines = String(text).split(String.fromCharCode(10));
  var rows = [];
  var headers = null;
  lines.forEach(function (line) {
    if (!line.trim()) return;
    var cells = [];
    var cur = '';
    var inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { cells.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    if (!headers) headers = cells.map(function (h) { return h.toLowerCase().trim(); });
    else {
      var obj = {};
      var vals = cells.slice();
      // Tolerate leading blank columns in data rows (common in Excel exports
      // with empty columns A/B): drop leading empties so values line up
      // under the headers instead of shifting everything right.
      while (vals.length > headers.length && vals[0] === '') vals.shift();
      headers.forEach(function (h, idx) { obj[h] = vals[idx] !== undefined ? vals[idx] : ''; });
      rows.push(obj);
    }
  });
  return rows;
}

var IMPORT_FORMATS = {
  stewards: 'steward_id, email, first_name, last_name, phone, password (8+ chars; blank keeps the existing password; everyone imported here is a steward)',
  companies: 'parent_code, parent_name, company_code, ein, company_name, company_address_1, company_city, company_state, company_zip, company_status. Only company_code and company_name are required; blank cells leave the current values unchanged (company_status: ACTIVE, TERMED, or PENDING; the old active Yes/No column still works). Headers are case-insensitive.',
  assignments: 'steward_id, company_code. The steward must already be on the Stewards table and the company on the Companies table, or the import is refused.',
  billing: 'company_code (required), company_name, ein, payroll_date (YYYY-MM-DD), payroll_end_date (YYYY-MM-DD), lives_count, total_invoice, status (open or paid), paid_date (YYYY-MM-DD), bill_type (F or S), bill_mode',
  commissions: 'Excel sheet: COMPANY_CODE, STEWARD #1, #1 %, STEWARD #2, #2 %, and so on. Agent cells look like "155026 - RLJAT" (the number is the Steward ID). % cells are decimals (0.125 = 12.5%) and each company must add up to 1.0 (100%). Every company must already be on the Companies table and every steward on the Stewards table, or the import is refused. A pasted CSV also works in the wide pair format (company_code, then steward_id,pct pairs with percents adding to 100). The import replaces the commissions for every company in the file.'
};

// ---------------------------------------------------------------- parent page (v6.6)
// Parent-level data only: Parent Code, Parent Name, a system-derived
// Parent Status, and two files per parent (Master Application,
// Pre-implementation Checklist). Admin edits; Top Dog + Onboarding view.
function viewParentPage() {
  requireUser(function () {
    var role = activeRole();
    if (role !== 'admin' && role !== 'top_dog' && role !== 'onboarding') { location.hash = '#/dashboard'; return; }
    var isAdmin = role === 'admin';
    var all = [];
    var statusFilter = 'active_pending';
    var query = '';
    var exactCode = null;
    var editingCode = null;
    var pendingDoc = null;

    function parentStatusHtml(s) {
      var color = s === 'ACTIVE' ? '#2e7d32' : (s === 'PENDING' ? '#b8860b' : '#888');
      return '<span class="dot" style="background:' + color + ';"></span> ' + esc(s);
    }
    function docCell(p, kind) {
      var doc = p[kind];
      if (doc) {
        var h = '<div>' + esc(doc.file_name) + '</div>' +
          '<button class="btn btn-small" data-doc-dl="' + kind + '" data-code="' + esc(p.parent_code) + '">Download</button>';
        if (isAdmin) {
          h += ' <button class="btn btn-small" data-doc-up="' + kind + '" data-code="' + esc(p.parent_code) + '">Replace</button>' +
            ' <button class="btn btn-small" data-doc-del="' + kind + '" data-code="' + esc(p.parent_code) + '">Delete</button>';
        }
        return h;
      }
      if (isAdmin) return '<button class="btn btn-small" data-doc-up="' + kind + '" data-code="' + esc(p.parent_code) + '">Upload</button>';
      return '<span class="muted">&mdash;</span>';
    }
    function visibleRows() {
      return all.filter(function (p) {
        if (statusFilter === 'active' && p.parent_status !== 'ACTIVE') return false;
        if (statusFilter === 'pending' && p.parent_status !== 'PENDING') return false;
        if (statusFilter === 'termed' && p.parent_status !== 'TERMED') return false;
        if (statusFilter === 'active_pending' && p.parent_status === 'TERMED') return false;
        if (exactCode) return p.parent_code === exactCode;
        if (query) {
          var q = query.toLowerCase();
          return p.parent_name.toLowerCase().indexOf(q) !== -1 || p.parent_code.toLowerCase().indexOf(q) !== -1;
        }
        return true;
      });
    }
    function rowHtml(p) {
      if (editingCode === p.parent_code) {
        return '<tr><td><input id="pe_code" value="' + esc(p.parent_code) + '"></td>' +
          '<td><input id="pe_name" value="' + esc(p.parent_name) + '" style="width:95%;"></td>' +
          '<td>' + parentStatusHtml(p.parent_status) + '</td><td>' + p.company_count + '</td>' +
          '<td colspan="2" class="muted">Editing &mdash; files are managed after saving.</td>' +
          '<td><button class="btn btn-small btn-primary" id="pe_save">Save</button> <button class="btn btn-small" id="pe_cancel">Cancel</button></td></tr>';
      }
      return '<tr><td><b>' + esc(p.parent_code) + '</b></td><td>' + esc(p.parent_name) + '</td>' +
        '<td>' + parentStatusHtml(p.parent_status) + '</td><td>' + p.company_count + '</td>' +
        '<td>' + docCell(p, 'master_application') + '</td>' +
        '<td>' + docCell(p, 'pre_implementation_checklist') + '</td>' +
        '<td>' + (isAdmin
          ? '<button class="btn btn-small" data-edit="' + esc(p.parent_code) + '">Edit</button> <button class="btn btn-small" data-del="' + esc(p.parent_code) + '">Delete</button>'
          : '<span class="muted">View only</span>') + '</td></tr>';
    }
    var suggestClosed = false;
    function paintSuggest() {
      var box = document.getElementById('parentSuggest');
      if (!box) return;
      if (!query || exactCode || suggestClosed) { box.style.display = 'none'; box.innerHTML = ''; return; }
      var q = query.toLowerCase();
      var matches = all.filter(function (p) { return p.parent_name.toLowerCase().indexOf(q) !== -1; }).slice(0, 10);
      if (!matches.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
      box.innerHTML = matches.map(function (p) {
        return '<div data-suggest="' + esc(p.parent_code) + '" style="padding:6px 8px;cursor:pointer;border-bottom:1px solid #eee;">' +
          esc(p.parent_name) + ' <span class="muted">(' + esc(p.parent_code) + ')</span></div>';
      }).join('');
      box.style.display = 'block';
      box.querySelectorAll('[data-suggest]').forEach(function (el) {
        el.onclick = function () {
          var code = el.getAttribute('data-suggest');
          var p = all.filter(function (x) { return x.parent_code === code; })[0];
          exactCode = code;
          query = p ? p.parent_name : code;
          document.getElementById('parentSearch').value = query;
          paint();
        };
      });
    }
    function paint() {
      var rows = visibleRows();
      var tbody = document.getElementById('parentRows');
      if (!tbody) return;
      tbody.innerHTML = rows.length ? rows.map(rowHtml).join('') : '<tr><td colspan="7" class="muted">No parents match.</td></tr>';
      document.getElementById('parentCount').textContent = rows.length + ' of ' + all.length + ' parents shown';
      wireRows();
      paintSuggest();
      enhanceTables();
    }
    function wireRows() {
      document.querySelectorAll('[data-edit]').forEach(function (b) {
        b.onclick = function () { editingCode = b.getAttribute('data-edit'); paint(); };
      });
      document.querySelectorAll('[data-del]').forEach(function (b) {
        b.onclick = function () {
          var code = b.getAttribute('data-del');
          var p = all.filter(function (x) { return x.parent_code === code; })[0];
          if (!window.confirm('Delete parent ' + (p ? p.parent_name : code) + ' (' + code + ')? This works only when no companies are tied to the parent.')) return;
          api.delete('/api/parent-page/' + encodeURIComponent(code)).then(function () { load(); })
            .catch(function (err) { document.getElementById('parentMsg').innerHTML = errorHtml(err.message); });
        };
      });
      document.querySelectorAll('[data-doc-dl]').forEach(function (b) {
        b.onclick = function () {
          downloadFile('/api/parent-page/' + encodeURIComponent(b.getAttribute('data-code')) + '/documents/' + b.getAttribute('data-doc-dl') + '/download');
        };
      });
      document.querySelectorAll('[data-doc-up]').forEach(function (b) {
        b.onclick = function () {
          pendingDoc = { code: b.getAttribute('data-code'), kind: b.getAttribute('data-doc-up') };
          document.getElementById('parentDocFile').click();
        };
      });
      document.querySelectorAll('[data-doc-del]').forEach(function (b) {
        b.onclick = function () {
          if (!window.confirm('Delete this file?')) return;
          api.delete('/api/parent-page/' + encodeURIComponent(b.getAttribute('data-code')) + '/documents/' + b.getAttribute('data-doc-del'))
            .then(function () { load(); })
            .catch(function (err) { document.getElementById('parentMsg').innerHTML = errorHtml(err.message); });
        };
      });
      var save = document.getElementById('pe_save');
      if (save) save.onclick = function () {
        var body = {
          parent_code: document.getElementById('pe_code').value.trim(),
          parent_name: document.getElementById('pe_name').value.trim()
        };
        api.put('/api/parent-page/' + encodeURIComponent(editingCode), body).then(function () {
          editingCode = null; load();
        }).catch(function (err) { document.getElementById('parentMsg').innerHTML = errorHtml(err.message); });
      };
      var cancel = document.getElementById('pe_cancel');
      if (cancel) cancel.onclick = function () { editingCode = null; paint(); };
    }
    function load() {
      api.get('/api/parent-page').then(function (rows) { all = rows; paint(); })
        .catch(function (err) { render(shell(errorHtml(err.message), '#/parent-page')); });
    }
    render(shell(
      '<h2>Parent</h2>' +
      '<p class="muted">Parent Codes are created during the Onboarding process (Highest Parent Code + 1). Only an Admin can add a Parent manually, or change a Parent Code or Parent Name, or delete a Parent. Onboarding and Top Dog can only view the Parent page.</p>' +
      '<div id="parentMsg"></div>' +
      (isAdmin
        ? '<p><button class="btn btn-primary" id="np_open">Add Parent</button></p>' +
          '<div class="card" id="np_card" style="display:none;"><h3>Add Parent</h3>' +
          '<label>Parent Code <input id="np_code" placeholder="Blank = next PC code"></label> ' +
          '<label>Parent Name <input id="np_name"></label> ' +
          '<button class="btn btn-primary" id="np_add">Add Parent</button> ' +
          '<button class="btn" id="np_cancel">Cancel</button></div>'
        : '') +
      '<div style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap;margin-top:14px;">' +
        '<div style="position:relative;flex:1;min-width:260px;">' +
          '<label>Search</label> <span style="display:inline-flex;gap:2px;align-items:center;"><input id="parentSearch" type="text" placeholder="Start typing a parent name..." autocomplete="off"><button class="btn btn-small" id="parentReset" type="button">Reset</button></span>' +
          '<div id="parentSuggest" style="position:absolute;left:0;right:0;top:100%;background:#fff;border:1px solid #ccc;z-index:5;display:none;"></div>' +
        '</div>' +
        '<div><label>Status <select id="parentStatusFilter">' +
          '<option value="active">Active</option>' +
          '<option value="pending">Pending</option>' +
          '<option value="termed">Termed</option>' +
          '<option value="active_pending" selected>Active &amp; Pending</option>' +
          '<option value="all">All</option>' +
        '</select></label></div>' +
      '</div>' +
      '<p class="muted" id="parentCount"></p>' +
      '<div class="table-scroll"><table class="data-table"><thead><tr>' +
      '<th>Parent Code</th><th>Parent Name</th><th>Parent Status</th><th>Companies</th>' +
      '<th>Master Application</th><th>Pre-implementation Checklist</th><th>Actions</th>' +
      '</tr></thead><tbody id="parentRows"><tr><td colspan="7" class="muted">Loading...</td></tr></tbody></table></div>' +
      '<input type="file" id="parentDocFile" style="display:none;">',
      '#/parent-page'));
    document.getElementById('parentSearch').addEventListener('input', function (e) {
      query = e.target.value; exactCode = null; suggestClosed = false; paint();
    });
    document.getElementById('parentSearch').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); suggestClosed = true; paint(); }
    });
    document.getElementById('parentReset').onclick = function () {
      query = ''; exactCode = null; suggestClosed = false;
      document.getElementById('parentSearch').value = '';
      paint();
    };
    document.getElementById('parentStatusFilter').onchange = function (e) { statusFilter = e.target.value; paint(); };
    document.getElementById('parentDocFile').onchange = function (e) {
      var f = e.target.files[0];
      if (!f || !pendingDoc) return;
      var fd = new FormData();
      fd.append('file', f);
      uploadFile('/api/parent-page/' + encodeURIComponent(pendingDoc.code) + '/documents/' + pendingDoc.kind, fd)
        .then(function () { pendingDoc = null; e.target.value = ''; load(); })
        .catch(function (err) { document.getElementById('parentMsg').innerHTML = errorHtml(err.message); });
    };
    if (isAdmin) {
      var npCard = document.getElementById('np_card');
      var npOpen = document.getElementById('np_open');
      function closeNpForm() {
        npCard.style.display = 'none';
        npOpen.style.display = '';
        document.getElementById('np_code').value = '';
        document.getElementById('np_name').value = '';
      }
      npOpen.onclick = function () {
        npCard.style.display = '';
        npOpen.style.display = 'none';
        document.getElementById('parentMsg').innerHTML = '';
        document.getElementById('np_name').focus();
      };
      document.getElementById('np_cancel').onclick = function () {
        document.getElementById('parentMsg').innerHTML = '';
        closeNpForm();
      };
      document.getElementById('np_add').onclick = function () {
        var body = {
          parent_code: document.getElementById('np_code').value.trim(),
          parent_name: document.getElementById('np_name').value.trim()
        };
        api.post('/api/parent-page', body).then(function () {
          document.getElementById('parentMsg').innerHTML = okHtml('Parent added.');
          closeNpForm();
          load();
        }).catch(function (err) { document.getElementById('parentMsg').innerHTML = errorHtml(err.message); });
      };
    }
    load();
  });
}

// ---------------------------------------------------------------- admin: jobs (run sync / summaries on demand)
function viewAdminJobs() {
  requireUser(function () {
    if (activeRole() !== 'admin') { location.hash = '#/dashboard'; return; }
    render(shell(
      '<h2>Jobs</h2><div id="msg"></div>' +
      '<p class="muted">Run the scheduled jobs on demand. The GitHub sync also runs every 6 hours; updates run Sunday through Thursday at 9:00 PM.</p>' +
      '<div class="card-grid">' +
      '<div class="card"><div class="card-title">GitHub kanban sync</div>' +
      '<p class="muted">Pulls board cards, links implementations, pulls comments, removes app copies of comments deleted on GitHub.</p>' +
      '<button class="btn btn-primary" id="runsync">Run sync now</button><div id="syncout"></div></div>' +
      '<div class="card"><div class="card-title">Message sync</div>' +
      '<p class="muted">Pulls GitHub comments and removes app copies of deleted comments. Lighter than the full sync.</p>' +
      '<button class="btn btn-primary" id="runmsg">Sync messages now</button><div id="msgout"></div></div>' +
      '<div class="card"><div class="card-title">Nightly project updates</div>' +
      '<p class="muted">Looks at each day\u2019s messages and records only meaningful milestones and progress. Quiet days record nothing.</p>' +
      '<button class="btn btn-primary" id="runsum">Run updates now</button><div id="sumout"></div></div>' +
      '<div class="card"><div class="card-title">Reopen onboarding card</div>' +
      '<p class="muted">Reopens an initiated (Complete) onboarding card so its documents can be added, changed, or deleted, then sent to GitHub again. Sending again creates a brand new GitHub card — have someone delete the old GitHub issue.</p>' +
      '<select id="reopencard" style="max-width: 100%;"><option value="">Loading...</option></select> ' +
      '<button class="btn btn-primary" id="doreopen">Reopen card</button><div id="reopenout"></div></div>' +
      '<div class="card"><div class="card-title">Weekly email</div>' +
      '<p class="muted">Claude writes a personalized Friday summary for each steward, top dog, and admin — week in review, their to-dos, company updates. Sends via Resend.</p>' +
      '<label>Days back: <input id="emaildays" type="number" value="7" min="1" max="30" style="width: 60px;"></label> ' +
      '<button class="btn btn-primary" id="runemail">Send weekly email now</button><div id="emailout"></div></div>' +
      '<div class="card"><div class="card-title">On-call schedule</div>' +
      '<p class="muted">Who auto-assignment sends new tickets to. Add a date range per person; the person covering today gets new tickets.</p>' +
      '<div id="oclist"><p class="muted">Loading...</p></div>' +
      '<form id="ocform" class="form-inline"><select id="ocperson"><option value="">Loading...</option></select> ' +
      '<input id="ocstart" type="date" required> <input id="ocend" type="date" required> ' +
      '<button class="btn btn-primary" type="submit">Add</button></form><div id="ocmsg"></div></div>' +
'<div class="card"><div class="card-title">Private message filters</div>' +
      '<p class="muted">Anyone on this list can be @mentioned privately: any message containing @their-github-username is hidden from the app, the nightly updates, and the weekly email.</p>' +
      '<div id="pmflist"><p class="muted">Loading...</p></div>' +
      '<form id="pmfform" class="form-inline"><input id="pmfname" placeholder="Name" required> ' +
      '<input id="pmfuser" placeholder="GitHub username" required> ' +
      '<button class="btn btn-primary" type="submit">Add</button></form><div id="pmfmsg"></div></div>' +
      '<div class="card"><div class="card-title">Site header logo</div>' +
      '<p class="muted">Upload the logo shown in the site header. Takes effect immediately for everyone. PNG, JPG, GIF, WebP, or SVG.</p>' +
      '<div id="logopreview" style="margin-bottom:8px;"><img id="logopreviewimg" src="/api/logo" ' +
      'onerror="this.onerror=null;this.src=\'logo.webp\'" style="max-height:60px;width:auto;" alt="Current logo"></div>' +
      '<input type="file" id="logofile" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"> ' +
      '<button class="btn btn-primary" id="logoupload">Upload logo</button> ' +
      '<button class="btn btn-small btn-danger" id="logodelete">Remove logo</button><div id="logoout"></div></div>' +
      '<div class="card"><div class="card-title">Edit stewards</div>' +
      '<p class="muted">Select a steward, then edit their details, password, roles, ID, or delete them. The Stewards page is view-only.</p>' +
      '<select id="editstewardsel" style="max-width: 100%;"><option value="">Loading...</option></select>' +
      '<div id="editstewardbox" style="margin-top:8px;"></div><div id="editstewardmsg"></div></div>' +
      '<div class="card"><div class="card-title">FTJ billing (F): Premium Applied Report</div>' +
      '<p class="muted">Upload the Premium Applied Report spreadsheet. It re-derives every paid F bill from the report: preview the bills first, then import to add new, update changed, and delete bills missing from the report.</p>' +
      '<input type="file" id="ftjfile" accept=".xlsx,.xls"> ' +
      '<button class="btn btn-primary" id="ftjpreview">Upload &amp; preview</button><div id="ftjout"></div>' +
      '<hr><p class="muted"><b>Unpaid estimates — retired.</b> The Billing page now reports only bills imported into the system, so estimates are no longer created or shown. Any estimates already in the system can be removed with Delete all estimates.</p>' +
      '<label>Only accounts paid within the last <input id="ftjestdays" type="number" value="90" min="1" max="3650" style="width: 70px;"> days</label> ' +
      '<button class="btn btn-primary" id="ftjest">Preview estimates</button> ' +
      '<button class="btn btn-small" id="ftjestclear">Delete all estimates</button><div id="ftjestout"></div></div>' +
      '<div class="card"><div class="card-title">Soluta billing (S): Soluta report</div>' +
      '<p class="muted">Upload the Soluta iM4H Invoice Report spreadsheet. It contains both paid and pending S bills \u2014 no estimating. Preview the bills first, then import to add new, update changed, and delete S bills missing from the report.</p>' +
      '<input type="file" id="solfile" accept=".xlsx,.xls,.csv"> ' +
      '<button class="btn btn-primary" id="solpreview">Upload &amp; preview</button> ' +
      '<button class="btn btn-small" id="soldltemplate">Download template</button> ' +
      '<button class="btn btn-small" id="soldelexport">Export current S bills</button><div id="solout"></div></div>' +
      '<div class="card"><div class="card-title">Payroll company summary (Power BI)</div>' +
      '<p class="muted">Upload the Power BI payroll export spreadsheet. It takes the latest done case per company (EIN) and stores the headcounts plus the Bill and Savings Summary, then pushes those numbers to the Companies page via the EIN cross-reference \u2014 no employee PII is stored. Preview first, then import.</p>' +
      '<input type="file" id="payfile" accept=".xlsx,.xls"> ' +
      '<button class="btn btn-primary" id="paypreview">Upload &amp; preview</button><div id="payout"></div></div>' +
      '<div class="card"><div class="card-title">EIN \u2194 Account cross-reference</div>' +
      '<p class="muted">Upload the account info spreadsheet (TIN/EIN \u2194 Acct/company code). Preview first, then import to replace the cross-reference table.</p>' +
      '<input type="file" id="xreffile" accept=".xlsx,.xls,.csv"> ' +
      '<button class="btn btn-primary" id="xrefpreview">Upload &amp; preview</button><div id="xrefout"></div></div>' +
      '</div>' +
      '<h3>Imports</h3>' +
      '<p class="muted">Paste CSV (first row = headers), validate, then confirm. Stewards and Companies can also be maintained one at a time on their own pages. Use "Download current" to get a CSV of what is on file now.</p>' +
      '<div class="card-grid">' +
      '<div class="card"><div class="card-title">Import stewards</div>' +
      '<p class="muted">Columns: ' + esc(IMPORT_FORMATS.stewards) + '</p>' +
      '<textarea id="imp-stewards-csv" rows="4" class="csvbox" placeholder="paste CSV here"></textarea>' +
      '<button class="btn btn-primary" id="imp-stewards-go">Validate</button> ' +
      '<button class="btn btn-small" id="dl-stewards">Download current</button><div id="imp-stewards-out"></div></div>' +
      '<div class="card"><div class="card-title">Import companies</div>' +
      '<p class="muted">Columns: ' + esc(IMPORT_FORMATS.companies) + '</p>' +
      '<textarea id="imp-companies-csv" rows="4" class="csvbox" placeholder="paste CSV here"></textarea>' +
      '<button class="btn btn-primary" id="imp-companies-go">Validate</button> ' +
      '<button class="btn btn-small" id="dl-companies">Download current</button><div id="imp-companies-out"></div></div>' +
      '<div class="card"><div class="card-title">Import assignments</div>' +
      '<p class="muted">Columns: ' + esc(IMPORT_FORMATS.assignments) + '</p>' +
      '<textarea id="imp-assignments-csv" rows="4" class="csvbox" placeholder="paste CSV here"></textarea>' +
      '<button class="btn btn-primary" id="imp-assignments-go">Validate</button> ' +
      '<button class="btn btn-small" id="dl-assignments">Download current</button><div id="imp-assignments-out"></div></div>' +
      '<div class="card"><div class="card-title">Import billing</div>' +
      '<p class="muted">Columns: ' + esc(IMPORT_FORMATS.billing) + '</p>' +
      '<textarea id="imp-billing-csv" rows="4" class="csvbox" placeholder="paste CSV here"></textarea>' +
      '<button class="btn btn-primary" id="imp-billing-go">Validate</button> ' +
      '<button class="btn btn-small" id="dl-billing">Download current</button><div id="imp-billing-out"></div></div>' +
      '<div class="card"><div class="card-title">Import commissions</div>' +
      '<p class="muted">Columns: ' + esc(IMPORT_FORMATS.commissions) + '</p>' +
      '<p class="muted">Or upload your commission schedule spreadsheet (XLSX) directly — it reads the ACCOUNT and AGENT/% columns automatically.</p>' +
      '<input type="file" id="imp-commissions-file" accept=".xlsx,.xls"> ' +
      '<button class="btn btn-primary" id="imp-commissions-upload">Upload &amp; validate</button><div id="imp-commissions-fileout"></div>' +
      '<hr><textarea id="imp-commissions-csv" rows="4" class="csvbox" placeholder="or paste CSV here"></textarea>' +
      '<button class="btn btn-primary" id="imp-commissions-go">Validate</button> ' +
      '<button class="btn btn-small" id="dl-commissions">Download current</button><div id="imp-commissions-out"></div></div>' +
      '</div>' +
      '<h3>Current commissions</h3><div id="commissionsnow"><p class="muted">Loading...</p></div>' +
      '<h3>Delete data</h3>' +
      '<p class="muted">Imports never delete. Use these to wipe a table or remove one record by its key. Deletions cannot be undone.</p>' +
      '<div class="card-grid">' +
      '<div class="card"><div class="card-title">Delete all stewards</div>' +
      '<p class="muted">Removes every non-admin steward and their assignments. Admins are kept.</p>' +
      '<button class="btn btn-danger" id="delstewards">Delete all stewards</button></div>' +
      '<div class="card"><div class="card-title">Delete one steward</div>' +
      '<p class="muted">By Steward ID or email. Admins cannot be deleted.</p>' +
      '<input id="delstewardkey" placeholder="Steward ID or email">' +
      '<button class="btn btn-danger" id="delstewardone">Delete steward</button></div>' +
      '<div class="card"><div class="card-title">Delete all companies</div>' +
      '<p class="muted">Removes every company plus their implementations, messages, summaries and assignments.</p>' +
      '<button class="btn btn-danger" id="delcompanies">Delete all companies</button></div>' +
      '<div class="card"><div class="card-title">Delete one company</div>' +
      '<p class="muted">By Company Code, with its implementations, messages, summaries and assignments.</p>' +
      '<input id="delcompanykey" placeholder="Company Code">' +
      '<button class="btn btn-danger" id="delcompanyone">Delete company</button></div>' +
      '<div class="card"><div class="card-title">Delete all assignments</div>' +
      '<p class="muted">Removes every steward to company link.</p>' +
      '<button class="btn btn-danger" id="delassignments">Delete all assignments</button></div>' +
      '<div class="card"><div class="card-title">Delete one assignment</div>' +
      '<p class="muted">By Steward ID and Company Code.</p>' +
      '<input id="delassignkey1" placeholder="Steward ID">' +
      '<input id="delassignkey2" placeholder="Company Code">' +
      '<button class="btn btn-danger" id="delassignone">Delete assignment</button></div>' +
      '<div class="card"><div class="card-title">Delete bills</div>' +
      '<p class="muted">Any combination of pending/paid and F/S, optionally limited to accounts. Deletions cannot be undone.</p>' +
      '<label>Accounts:<br><select id="delbillacct" multiple size="4" style="min-width:180px;"><option value="">Loading...</option></select></label><br>' +
      '<label><input type="checkbox" id="delbillopen" checked> Pending</label> ' +
      '<label><input type="checkbox" id="delbillpaid" checked> Paid</label><br>' +
      '<label><input type="checkbox" id="delbillf" checked> F - FTJ</label> ' +
      '<label><input type="checkbox" id="delbills" checked> S - Soluta</label><br>' +
      '<button class="btn btn-danger" id="dodelbills">Delete bills</button>' +
      '<p id="delbillcount" class="muted"></p><div id="delbillout"></div></div>' +
      '</div><div id="delout"></div>',
      '#/admin/jobs'));
    function pretty(d) {
      return '<pre class="muted">' + esc(JSON.stringify(d, null, 1)) + '</pre>';
    }
    document.getElementById('runsync').onclick = function () {
      var out = document.getElementById('syncout');
      out.innerHTML = '<p class="muted">Running...</p>';
      api.post('/api/admin/sync-now', {}).then(function (d) {
        out.innerHTML = okHtml('Sync finished.') + pretty(d);
      }).catch(function (err) {
        out.innerHTML = errorHtml(err.message);
      });
    };
    document.getElementById('runmsg').onclick = function () {
      var out = document.getElementById('msgout');
      out.innerHTML = '<p class="muted">Running...</p>';
      api.post('/api/admin/sync-messages-now', {}).then(function (d) {
        out.innerHTML = okHtml('Message sync finished.') + pretty(d);
      }).catch(function (err) {
        out.innerHTML = errorHtml(err.message);
      });
    };
    document.getElementById('runsum').onclick = function () {
      var out = document.getElementById('sumout');
      out.innerHTML = '<p class="muted">Running... this can take a minute.</p>';
      api.post('/api/admin/run-updates-now', {}).then(function (d) {
        out.innerHTML = okHtml('Updates finished.') + pretty(d);
      }).catch(function (err) {
        out.innerHTML = errorHtml(err.message);
      });
    };
    document.getElementById('runemail').onclick = function () {
      var out = document.getElementById('emailout');
      var days = parseInt(document.getElementById('emaildays').value, 10) || 7;
      if (!window.confirm('Send the weekly email to all stewards, top dogs, and admins?')) return;
      out.innerHTML = '<p class="muted">Writing and sending emails... this can take a few minutes.</p>';
      api.post('/api/admin/run-weekly-email', { days: days }).then(function (d) {
        out.innerHTML = okHtml('Sent ' + d.sent + ' of ' + d.total + ' emails.') + pretty(d);
      }).catch(function (err) {
        out.innerHTML = errorHtml(err.message);
      });
    };
    function loadPmf() {
      var box = document.getElementById('pmflist');
      api.get('/api/admin/private-filters').then(function (list) {
        if (!list.length) { box.innerHTML = '<p class="muted">Nobody on the list — every message is shown.</p>'; return; }
        var rows = list.map(function (f) {
          return '<tr><td>' + esc(f.name) + '</td><td>@' + esc(f.github_username) + '</td>' +
            '<td class="row-actions"><button class="btn btn-small" data-pmfedit="' + f.id + '">Edit</button> ' +
            '<button class="btn btn-small btn-danger" data-pmfdel="' + f.id + '">Delete</button></td></tr>';
        }).join('');
        box.innerHTML = '<table class="data-table"><thead><tr><th>Name</th><th>GitHub username</th><th></th></tr></thead><tbody>' +
          rows + '</tbody></table><div id="pmfeditbox"></div>';
        var delBtns = box.querySelectorAll('[data-pmfdel]');
        for (var d = 0; d < delBtns.length; d++) {
          (function (b) {
            b.onclick = function () {
              if (!window.confirm('Remove this person from the private list? Their @-mentioned messages will become visible again.')) return;
              api.delete('/api/admin/private-filters/' + b.getAttribute('data-pmfdel')).then(loadPmf).catch(function (err) {
                document.getElementById('pmfmsg').innerHTML = errorHtml(err.message);
              });
            };
          })(delBtns[d]);
        }
        var editBtns = box.querySelectorAll('[data-pmfedit]');
        for (var e = 0; e < editBtns.length; e++) {
          (function (b) {
            b.onclick = function () {
              var id = b.getAttribute('data-pmfedit');
              var cur = null;
              for (var k = 0; k < list.length; k++) { if (String(list[k].id) === String(id)) cur = list[k]; }
              document.getElementById('pmfeditbox').innerHTML =
                '<h3>Edit filter</h3><form id="pmfeditf" class="form-inline">' +
                '<input id="pmfe-name" value="' + esc(cur.name) + '" required> ' +
                '<input id="pmfe-user" value="' + esc(cur.github_username) + '" required> ' +
                '<button class="btn btn-primary" type="submit">Save</button></form>';
              document.getElementById('pmfeditf').onsubmit = function (ev) {
                ev.preventDefault();
                api.put('/api/admin/private-filters/' + id, {
                  name: document.getElementById('pmfe-name').value,
                  github_username: document.getElementById('pmfe-user').value
                }).then(function () {
                  document.getElementById('pmfmsg').innerHTML = okHtml('Filter updated.');
                  loadPmf();
                }).catch(function (err) {
                  document.getElementById('pmfmsg').innerHTML = errorHtml(err.message);
                });
              };
            };
          })(editBtns[e]);
        }
      }).catch(function (err) {
        box.innerHTML = errorHtml(err.message);
      });
    }
    loadPmf();
    document.getElementById('pmfform').onsubmit = function (e) {
      e.preventDefault();
      api.post('/api/admin/private-filters', {
        name: document.getElementById('pmfname').value,
        github_username: document.getElementById('pmfuser').value
      }).then(function () {
        document.getElementById('pmfname').value = '';
        document.getElementById('pmfuser').value = '';
        document.getElementById('pmfmsg').innerHTML = okHtml('Added to the private list.');
        loadPmf();
      }).catch(function (err) {
        document.getElementById('pmfmsg').innerHTML = errorHtml(err.message);
      });
    };
    // On-call schedule.
    function loadOclist() {
      api.get('/api/admin/oncall-schedule').then(function (list) {
        var html = list.length === 0 ? '<p class="muted">No on-call entries yet.</p>' :
          '<table class="data-table"><thead><tr><th>Person</th><th>Start</th><th>End</th><th></th></tr></thead><tbody>' +
          list.map(function (o) {
            var nm = ((o.first_name || '') + ' ' + (o.last_name || '')).trim() || o.email;
            return '<tr><td>' + esc(nm) + '</td><td>' + esc(o.start_date) + '</td><td>' + esc(o.end_date) + '</td>' +
              '<td><button class="btn btn-link" data-ocdel="' + o.id + '">Remove</button></td></tr>';
          }).join('') + '</tbody></table>';
        document.getElementById('oclist').innerHTML = html;
        document.querySelectorAll('[data-ocdel]').forEach(function (b) {
          b.onclick = function () {
            api.delete('/api/admin/oncall-schedule/' + b.getAttribute('data-ocdel')).then(loadOclist);
          };
        });
      });
    }
    api.get('/api/tickets-service-team').then(function (team) {
      var sel = document.getElementById('ocperson');
      sel.innerHTML = team.map(function (m) {
        var nm = ((m.first_name || '') + ' ' + (m.last_name || '')).trim() || m.email;
        return '<option value="' + m.id + '">' + esc(nm) + '</option>';
      }).join('');
    });
    loadOclist();
    document.getElementById('ocform').onsubmit = function (e) {
      e.preventDefault();
      api.post('/api/admin/oncall-schedule', {
        steward_id: document.getElementById('ocperson').value,
        start_date: document.getElementById('ocstart').value,
        end_date: document.getElementById('ocend').value
      }).then(function () {
        document.getElementById('ocmsg').innerHTML = okHtml('On-call entry added.');
        loadOclist();
      }).catch(function (err) {
        document.getElementById('ocmsg').innerHTML = errorHtml(err.message);
      });
    };
    function refreshBrandLogo() {
      var ts = Date.now();
      var imgs = document.querySelectorAll('.brand-logo');
      for (var k = 0; k < imgs.length; k++) {
        imgs[k].onerror = function () { this.onerror = null; this.src = 'logo.webp'; };
        imgs[k].src = '/api/logo?t=' + ts;
      }
      var prev = document.getElementById('logopreviewimg');
      if (prev) {
        prev.onerror = function () { this.onerror = null; this.src = 'logo.webp'; };
        prev.src = '/api/logo?t=' + ts;
      }
    }
    document.getElementById('logoupload').onclick = function () {
      var out = document.getElementById('logoout');
      var fi = document.getElementById('logofile');
      if (!fi.files.length) { out.innerHTML = errorHtml('Choose an image file first.'); return; }
      var fd = new FormData();
      fd.append('logo', fi.files[0]);
      out.innerHTML = '<p class="muted">Uploading...</p>';
      uploadFile('/api/admin/logo', fd).then(function () {
        out.innerHTML = okHtml('Logo updated — it is live in the header now.');
        document.getElementById('logofile').value = '';
        refreshBrandLogo();
      }).catch(function (err) {
        out.innerHTML = errorHtml(err.message);
      });
    };
    document.getElementById('logodelete').onclick = function () {
      var out = document.getElementById('logoout');
      if (!window.confirm('Remove the custom logo and go back to the default?')) return;
      api.delete('/api/admin/logo').then(function () {
        out.innerHTML = okHtml('Logo removed — back to the default.');
        var imgs = document.querySelectorAll('.brand-logo');
        for (var k = 0; k < imgs.length; k++) { imgs[k].src = 'logo.webp'; }
        var prev = document.getElementById('logopreviewimg');
        if (prev) prev.src = 'logo.webp';
      }).catch(function (err) {
        out.innerHTML = errorHtml(err.message);
      });
    };
    document.getElementById('ftjpreview').onclick = function () {
      var out = document.getElementById('ftjout');
      var fi = document.getElementById('ftjfile');
      if (!fi.files.length) { out.innerHTML = errorHtml('Choose a spreadsheet first.'); return; }
      var fd = new FormData();
      fd.append('file', fi.files[0]);
      out.innerHTML = '<p class="muted">Parsing the report (400K+ rows) — this can take about a minute...</p>';
      uploadFile('/api/admin/jobs/ftj-preview', fd).then(function (r) {
        var s = r.stats;
        var html = '<p><b>' + s.bills + '</b> paid F bills across <b>' + s.accounts + '</b> accounts, ' +
          'modals ' + esc(s.modal_from) + ' to ' + esc(s.modal_to) + ', total <b>' + fmtMoney(s.total_invoice) + '</b> ' +
          '<span class="muted">(' + esc(s.file_name) + ')</span></p>';
        html += '<div class="table-scroll"><table class="data-table"><thead><tr><th>Code</th><th>Name</th><th>EIN</th><th>Pay Frequency</th><th>Payroll Start</th><th>Payroll End</th><th>Check Date</th><th>Lives</th><th>Total Invoice</th></tr></thead><tbody>' +
          r.sample.map(function (b) {
            return '<tr><td><b>' + esc(b.company_code) + '</b></td><td>' + esc(b.company_name) + '</td><td>' +
              esc(b.ein) + '</td><td>' + esc(b.bill_mode) + '</td><td>' + esc(b.payroll_date) + '</td><td>' +
              esc(b.payroll_end_date) + '</td><td>' + esc(b.paid_date) + '</td><td>' + esc(b.lives_count) + '</td><td><b>' + fmtMoney(b.total_invoice) + '</b></td></tr>';
          }).join('') + '</tbody></table></div>';
        html += '<p><button class="btn btn-primary" id="ftjimport">Import ' + s.bills + ' bills</button> ' +
          '<span class="muted">Adds new, updates changed, deletes F bills missing from the report.</span></p><div id="ftjimportout"></div>';
        out.innerHTML = html;
        document.getElementById('ftjimport').onclick = function () {
          if (!window.confirm('Import ' + s.bills + ' F bills? This adds new bills, updates changed ones, and deletes F bills not in the report.')) return;
          var iout = document.getElementById('ftjimportout');
          iout.innerHTML = '<p class="muted">Importing...</p>';
          api.post('/api/admin/jobs/ftj-import', { preview_token: r.preview_token }).then(function (imp) {
            iout.innerHTML = okHtml('Done: ' + imp.added + ' added, ' + imp.updated + ' updated, ' + imp.deleted + ' deleted (' + imp.total + ' in report).');
          }).catch(function (err) { iout.innerHTML = errorHtml(err.message); });
        };
      }).catch(function (err) { out.innerHTML = errorHtml(err.message); });
    };
    document.getElementById('ftjest').onclick = function () {
      var out = document.getElementById('ftjestout');
      var days = parseInt(document.getElementById('ftjestdays').value, 10) || 90;
      out.innerHTML = '<p class="muted">Projecting unpaid bills...</p>';
      api.post('/api/admin/jobs/ftj-estimate-preview', { max_stale_days: days }).then(function (r) {
        if (!r.accounts.length) {
          out.innerHTML = okHtml('No unpaid bills to estimate — every account is current.') +
            (r.skipped_stale ? '<p class="muted">' + r.skipped_stale + ' accounts skipped (no paid bill in the last ' + r.max_stale_days + ' days).</p>' : '');
          return;
        }
        var html = '<p><b>' + r.total_estimates + '</b> estimated unpaid bills across <b>' + r.accounts.length + '</b> accounts.</p>';
        html += '<div class="table-scroll"><table class="data-table"><thead><tr><th>Code</th><th>Name</th><th>Frequency</th><th>Last Paid</th><th>Est. Bills</th><th>Est. Range</th><th>Lives</th><th>Total Each</th></tr></thead><tbody>' +
          r.accounts.map(function (x) {
            var range = x.estimates.length > 1
              ? esc(x.estimates[0]) + ' \u2192 ' + esc(x.estimates[x.estimates.length - 1])
              : esc(x.estimates[0]);
            return '<tr><td><b>' + esc(x.company_code) + '</b></td><td>' + esc(x.company_name) + '</td><td>' +
              esc(x.frequency) + '</td><td>' + esc(x.last_paid) + '</td><td>' + x.estimates.length + '</td><td>' +
              range + '</td><td>' + esc(x.lives_count) + '</td><td>' + fmtMoney(x.total_invoice) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
        if (r.skipped_stale || r.skipped_inactive) {
          html += '<p class="muted">Skipped: ' +
            (r.skipped_stale ? r.skipped_stale + ' stale (no paid bill in ' + r.max_stale_days + ' days)' : '') +
            (r.skipped_stale && r.skipped_inactive ? '; ' : '') +
            (r.skipped_inactive ? r.skipped_inactive + ' inactive' : '') + '.</p>';
        }
        html += '<p><button class="btn btn-primary" id="ftjestcreate">Create ' + r.total_estimates + ' unpaid bills</button></p><div id="ftjestcreateout"></div>';
        out.innerHTML = html;
        document.getElementById('ftjestcreate').onclick = function () {
          if (!window.confirm('Create ' + r.total_estimates + ' estimated unpaid F bills?')) return;
          var cout = document.getElementById('ftjestcreateout');
          cout.innerHTML = '<p class="muted">Creating...</p>';
          api.post('/api/admin/jobs/ftj-estimate-create', { max_stale_days: days }).then(function (c) {
            cout.innerHTML = okHtml('Done: ' + c.created + ' created' + (c.skipped ? ', ' + c.skipped + ' skipped (already exist)' : '') + '.');
          }).catch(function (err) { cout.innerHTML = errorHtml(err.message); });
        };
      }).catch(function (err) { out.innerHTML = errorHtml(err.message); });
    };
    document.getElementById('ftjestclear').onclick = function () {
      if (!window.confirm('Delete ALL open estimated bills? Paid bills are never touched.')) return;
      var out = document.getElementById('ftjestout');
      out.innerHTML = '<p class="muted">Deleting estimates...</p>';
      api.post('/api/admin/jobs/ftj-estimate-clear', {}).then(function (r) {
        out.innerHTML = okHtml('Deleted ' + r.deleted + ' estimated bills.');
      }).catch(function (err) { out.innerHTML = errorHtml(err.message); });
    };
    document.getElementById('xrefpreview').onclick = function () {
      var out = document.getElementById('xrefout');
      var fi = document.getElementById('xreffile');
      if (!fi.files.length) { out.innerHTML = errorHtml('Choose a spreadsheet first.'); return; }
      var fd = new FormData();
      fd.append('file', fi.files[0]);
      out.innerHTML = '<p class="muted">Parsing the cross-reference file...</p>';
      uploadFile('/api/admin/jobs/xref-preview', fd).then(function (r) {
        var s = r.stats;
        var html = '<p><b>' + s.rows + '</b> rows, <b>' + s.accounts + '</b> accounts ' +
          '<span class="muted">(' + esc(s.file_name) + ')</span></p>';
        html += '<div class="table-scroll"><table class="data-table"><thead><tr><th>Acct</th><th>TIN</th><th>Acct Name</th><th>City</th><th>State</th><th>Eff Date</th><th>Term Date</th></tr></thead><tbody>' +
          r.sample.map(function (x) {
            return '<tr><td><b>' + esc(x.acct) + '</b></td><td>' + esc(x.tin || '') + '</td><td>' + esc(x.acct_name || '') + '</td><td>' +
              esc(x.city || '') + '</td><td>' + esc(x.state || '') + '</td><td>' + esc(x.eff_date || '') + '</td><td>' + esc(x.term_date || '') + '</td></tr>';
          }).join('') + '</tbody></table></div>';
        html += '<p><button class="btn btn-primary" id="xrefimport">Import ' + s.rows + ' rows</button> ' +
          '<span class="muted">Replaces the cross-reference table.</span></p><div id="xrefimportout"></div>';
        out.innerHTML = html;
        document.getElementById('xrefimport').onclick = function () {
          if (!window.confirm('Import cross-reference? This replaces the current table.')) return;
          var iout = document.getElementById('xrefimportout');
          iout.innerHTML = '<p class="muted">Importing...</p>';
          api.post('/api/admin/jobs/xref-import', { preview_token: r.preview_token }).then(function (imp) {
            iout.innerHTML = okHtml('Done: ' + imp.imported + ' rows imported.');
          }).catch(function (err) { iout.innerHTML = errorHtml(err.message); });
        };
      }).catch(function (err) { out.innerHTML = errorHtml(err.message); });
    };
    document.getElementById('solpreview').onclick = function () {
      var out = document.getElementById('solout');
      var fi = document.getElementById('solfile');
      if (!fi.files.length) { out.innerHTML = errorHtml('Choose a spreadsheet first.'); return; }
      var fd = new FormData();
      fd.append('file', fi.files[0]);
      out.innerHTML = '<p class="muted">Parsing the Soluta report...</p>';
      uploadFile('/api/admin/jobs/sol-preview', fd).then(function (r) {
        var s = r.stats;
        var html = '<p><b>' + s.bills + '</b> S bills across <b>' + s.accounts + '</b> accounts ' +
          '(<b>' + s.paid + '</b> paid, <b>' + s.open + '</b> pending), total <b>' + fmtMoney(s.total_invoice) + '</b> ' +
          '<span class="muted">(' + esc(s.file_name) + ')</span></p>';
        html += '<div class="table-scroll"><table class="data-table"><thead><tr><th>Code</th><th>Name</th><th>EIN</th><th>Pay Frequency</th><th>Payroll Start</th><th>Payroll End</th><th>Check Date</th><th>Status</th><th>Lives</th><th>Total</th></tr></thead><tbody>' +
          r.sample.map(function (b) {
            return '<tr><td><b>' + esc(b.company_code) + '</b></td><td>' + esc(b.company_name) + '</td><td>' +
              esc(b.ein) + '</td><td>' + esc(b.bill_mode) + '</td><td>' + esc(b.payroll_date) + '</td><td>' +
              esc(b.payroll_end_date) + '</td><td>' + esc(b.paid_date) + '</td><td>' + esc(b.status) + '</td><td>' +
              esc(b.lives_count) + '</td><td><b>' + fmtMoney(b.total_invoice) + '</b></td></tr>';
          }).join('') + '</tbody></table></div>';
        html += '<p><button class="btn btn-primary" id="solimport">Import ' + s.bills + ' bills</button> ' +
          '<span class="muted">Adds new, updates changed, deletes S bills missing from the report.</span></p><div id="solimportout"></div>';
        out.innerHTML = html;
        document.getElementById('solimport').onclick = function () {
          if (!window.confirm('Import ' + s.bills + ' S bills? This adds new bills, updates changed ones, and deletes S bills not in the report.')) return;
          var iout = document.getElementById('solimportout');
          iout.innerHTML = '<p class="muted">Importing...</p>';
          api.post('/api/admin/jobs/sol-import', { preview_token: r.preview_token }).then(function (imp) {
            iout.innerHTML = okHtml('Done: ' + imp.added + ' added, ' + imp.updated + ' updated, ' + imp.deleted + ' deleted (' + imp.total + ' in report).');
          }).catch(function (err) { iout.innerHTML = errorHtml(err.message); });
        };
      }).catch(function (err) { out.innerHTML = errorHtml(err.message); });
    };
    document.getElementById('paypreview').onclick = function () {
      var out = document.getElementById('payout');
      var fi = document.getElementById('payfile');
      if (!fi.files.length) { out.innerHTML = errorHtml('Choose a spreadsheet first.'); return; }
      var fd = new FormData();
      fd.append('file', fi.files[0]);
      out.innerHTML = '<p class="muted">Parsing the payroll export — latest done case per company...</p>';
      uploadFile('/api/admin/jobs/payroll-preview', fd).then(function (r) {
        var s = r.stats;
        var html = '<p><b>' + s.companies + '</b> companies (latest done case each), <b>' + s.employees + '</b> employees ' +
          '<span class="muted">(' + esc(s.file_name) + ')</span></p>';
        if (s.skipped_no_qualifying_case) html += '<p class="muted">' + s.skipped_no_qualifying_case + ' EINs skipped (no done case with finals).</p>';
        if (s.recon_mismatch) html += '<p class="muted">' + s.recon_mismatch + ' companies where the headcount buckets do not reconcile.</p>';
        html += '<p class="muted">' + s.xref_matched + ' of ' + s.companies + ' match an iM4 company code via the EIN cross-reference.</p>';
        html += '<div class="table-scroll"><table class="data-table"><thead><tr><th>Case</th><th>EIN</th><th>Employer</th><th>Total</th><th>Ineligible</th><th>Enrolled</th><th>Premium</th><th>Admin Fee</th></tr></thead><tbody>' +
          r.sample.map(function (g) {
            return '<tr><td><b>' + esc(g.case_number) + '</b></td><td>' + esc(g.ein || '') + '</td><td>' + esc(g.employer_location || g.employer_name || '') + '</td><td>' +
              g.employee_count + '</td><td>' + g.ineligible_count + '</td><td>' + g.enrolled_count + '</td><td>' + fmtMoney(g.total_premium) + '</td><td>' +
              fmtMoney(g.total_admin_fee) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
        html += '<p><button class="btn btn-primary" id="payimport">Import ' + s.companies + ' companies</button> ' +
          '<span class="muted">Replaces the summary table and updates the Companies page payroll numbers. No employee PII is stored.</span></p><div id="payimportout"></div>';
        out.innerHTML = html;
        document.getElementById('payimport').onclick = function () {
          if (!window.confirm('Import payroll summary? This replaces the company summary table and updates payroll numbers on the Companies page.')) return;
          var iout = document.getElementById('payimportout');
          iout.innerHTML = '<p class="muted">Importing...</p>';
          api.post('/api/admin/jobs/payroll-import', { preview_token: r.preview_token }).then(function (imp) {
            iout.innerHTML = okHtml('Done: ' + imp.imported + ' company rows imported, ' + imp.companies_updated + ' company records updated' +
              (imp.xref_missed ? ' (' + imp.xref_missed + ' EINs had no cross-reference match)' : '') + '.');
          }).catch(function (err) { iout.innerHTML = errorHtml(err.message); });
        };
      }).catch(function (err) { out.innerHTML = errorHtml(err.message); });
    };
    document.getElementById('soldltemplate').onclick = function () {
      var headers = {};
      if (api.token) headers['Authorization'] = 'Bearer ' + api.token;
      fetch('/api/admin/jobs/sol-template', { headers: headers }).then(function (resp) {
        if (!resp.ok) throw new Error('Download failed');
        return resp.blob();
      }).then(function (blob) {
        var el = document.createElement('a');
        el.href = URL.createObjectURL(blob);
        el.download = 'soluta-report-template.csv';
        document.body.appendChild(el);
        el.click();
        setTimeout(function () { URL.revokeObjectURL(el.href); el.remove(); }, 1500);
      }).catch(function (err) { alert(err.message); });
    };
    document.getElementById('soldelexport').onclick = function () {
      var headers = {};
      if (api.token) headers['Authorization'] = 'Bearer ' + api.token;
      fetch('/api/admin/jobs/sol-export', { headers: headers }).then(function (resp) {
        if (!resp.ok) throw new Error('Download failed');
        return resp.blob();
      }).then(function (blob) {
        var el = document.createElement('a');
        el.href = URL.createObjectURL(blob);
        el.download = 'soluta-bills-export.csv';
        document.body.appendChild(el);
        el.click();
        setTimeout(function () { URL.revokeObjectURL(el.href); el.remove(); }, 1500);
      }).catch(function (err) { alert(err.message); });
    };
    function wireImportCard(prefix, type) {
      document.getElementById('imp-' + prefix + '-go').onclick = function () {
        var out = document.getElementById('imp-' + prefix + '-out');
        var rows = parseCSV(document.getElementById('imp-' + prefix + '-csv').value);
        if (rows.length === 0) { out.innerHTML = errorHtml('No data rows found.'); return; }
        if (type === 'billing') {
          out.innerHTML = '<p class="muted">Importing billing...</p>';
          api.post('/api/admin/import-billing', { rows: rows }).then(function (r) {
            out.innerHTML = '<h3>Done</h3>' + okHtml('Imported ' + r.imported + ' new, updated ' + r.updated + '.') +
              (r.errors.length ? '<div class="alert alert-error">' + r.errors.map(esc).join('<br>') + '</div>' : '');
          }).catch(function (err) { out.innerHTML = errorHtml(err.message); });
          return;
        }
        out.innerHTML = '<p class="muted">Validating...</p>';
        api.post('/api/admin/import', { type: type, rows: rows, dry_run: true }).then(function (d) {
          var html = '<h3>Validation</h3>' + okHtml(d.valid_count + ' valid rows.') +
            (d.errors.length ? '<div class="alert alert-error">' + d.errors.map(esc).join('<br>') + '</div>' : '') +
            (d.errors.length === 0
              ? '<button class="btn btn-primary" id="imp-' + prefix + '-confirm">Confirm import of ' + d.valid_count + ' rows</button>'
              : '<p class="muted">Fix the errors above and validate again.</p>');
          out.innerHTML = html;
          var cb = document.getElementById('imp-' + prefix + '-confirm');
          if (cb) cb.onclick = function () {
            api.post('/api/admin/import', { type: type, rows: rows, dry_run: false }).then(function (r) {
              out.innerHTML = '<h3>Done</h3>' + okHtml('Imported ' + r.imported + ' rows.') +
                (r.errors.length ? '<div class="alert alert-error">' + r.errors.map(esc).join('<br>') + '</div>' : '');
            }).catch(function (err) { out.innerHTML = errorHtml(err.message); });
          };
        }).catch(function (err) { out.innerHTML = errorHtml(err.message); });
      };
    }
    wireImportCard('stewards', 'stewards');
    wireImportCard('companies', 'companies');
    wireImportCard('assignments', 'assignments');
    wireImportCard('billing', 'billing');
    function wireDownload(btnId, type, fileName) {
      document.getElementById(btnId).onclick = function () {
        var headers = {};
        if (api.token) headers['Authorization'] = 'Bearer ' + api.token;
        fetch('/api/admin/export/' + type, { headers: headers }).then(function (resp) {
          if (!resp.ok) throw new Error('Download failed');
          return resp.blob();
        }).then(function (blob) {
          var el = document.createElement('a');
          el.href = URL.createObjectURL(blob);
          el.download = fileName;
          document.body.appendChild(el);
          el.click();
          setTimeout(function () { URL.revokeObjectURL(el.href); el.remove(); }, 1500);
        }).catch(function (err) { alert(err.message); });
      };
    }
    wireDownload('dl-stewards', 'stewards', 'stewards.csv');
    wireDownload('dl-companies', 'companies', 'companies.csv');
    wireDownload('dl-assignments', 'assignments', 'assignments.csv');
    wireDownload('dl-billing', 'billing', 'billing.csv');
    wireDownload('dl-commissions', 'commissions', 'commissions.csv');
    function loadCommissionsNow() {
      var box = document.getElementById('commissionsnow');
      if (!box) return;
      api.get('/api/admin/commissions').then(function (list) {
        if (!list.length) { box.innerHTML = '<p class="muted">No commissions on file yet.</p>'; return; }
        var rows = list.map(function (c) {
          var nm = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || '';
          var who = '<b>' + esc(c.steward_code) + '</b>' + (nm ? ' &middot; ' + esc(nm) : '');
          return '<tr><td><b>' + esc(c.company_code) + '</b></td><td>' + who + '</td><td>' + esc(String(c.pct)) + '%</td></tr>';
        }).join('');
        box.innerHTML = '<div class="table-scroll"><table class="data-table"><thead><tr><th>Company code</th><th>Steward</th><th>%</th></tr></thead><tbody>' +
          rows + '</tbody></table></div>';
      }).catch(function (err) { box.innerHTML = errorHtml(err.message); });
    }
    loadCommissionsNow();
    // Wide commission format: one line per company — company_code, then
    // repeating steward_code,pct pairs. Expands to one row per pair.
    function parseCommissionWide(text, stewardIds, companyCodes) {
      var lines = String(text).split(String.fromCharCode(10));
      var rows = [];
      var errors = [];
      function splitCells(line) {
        var cells = [];
        var cur = '';
        var inQ = false;
        for (var i = 0; i < line.length; i++) {
          var ch = line[i];
          if (ch === '"') { inQ = !inQ; continue; }
          if (ch === ',' && !inQ) { cells.push(cur.trim()); cur = ''; continue; }
          cur += ch;
        }
        cells.push(cur.trim());
        return cells;
      }
      var headerSeen = false;
      var format = null; // 'company-first' or 'steward-first', auto-detected
      lines.forEach(function (line, li) {
        if (!line.trim()) return;
        var cells = splitCells(line);
        if (!headerSeen) { headerSeen = true; return; }
        var first = (cells[0] || '').trim();
        var rest = cells.slice(1);
        while (rest.length && rest[rest.length - 1] === '') rest.pop();
        if (rest.length === 0) { errors.push('Line ' + (li + 1) + ': no pairs found'); return; }
        if (rest.length % 2 !== 0) {
          errors.push('Line ' + (li + 1) + ': uneven pairs for ' + (first || '(blank)') + ' — each entry needs a code and a percent');
          return;
        }
        // Auto-detect format from the first data line.
        // Strategy 1: exact ID match against the system lists.
        // Strategy 2: length heuristic (company codes are 6-digit, steward IDs are 4-digit).
        if (!format) {
          var firstIsSteward = stewardIds && stewardIds.indexOf(first) !== -1;
          var firstIsCompany = companyCodes && companyCodes.indexOf(first) !== -1;
          var pairKey = (rest[0] || '').trim();
          var pairIsSteward = stewardIds && stewardIds.indexOf(pairKey) !== -1;
          var pairIsCompany = companyCodes && companyCodes.indexOf(pairKey) !== -1;
          if (firstIsSteward && pairIsCompany) format = 'steward-first';
          else if (firstIsCompany && pairIsSteward) format = 'company-first';
          else {
            var firstLen = first.replace(/\D/g, '').length;
            var pairLen = pairKey.replace(/\D/g, '').length;
            if (firstLen <= 4 && pairLen >= 6) format = 'steward-first';
            else if (firstLen >= 6 && pairLen <= 4) format = 'company-first';
            else format = 'company-first';
          }
        }
        for (var p = 0; p < rest.length; p += 2) {
          var a = (rest[p] || '').trim();
          var pct = (rest[p + 1] || '').trim();
          if (!a && !pct) continue;
          if (format === 'steward-first') {
            rows.push({ company_code: a, steward_code: first, pct: pct });
          } else {
            rows.push({ company_code: first, steward_code: a, pct: pct });
          }
        }
      });
      return { rows: rows, errors: errors, format: format };
    }
    document.getElementById('imp-commissions-upload').onclick = function () {
      var out = document.getElementById('imp-commissions-fileout');
      var fi = document.getElementById('imp-commissions-file');
      if (!fi.files.length) { out.innerHTML = errorHtml('Choose a spreadsheet first.'); return; }
      var fd = new FormData();
      fd.append('file', fi.files[0]);
      out.innerHTML = '<p class="muted">Reading the schedule...</p>';
      uploadFile('/api/admin/jobs/commissions-parse', fd).then(function (p) {
        if (p.errors.length) {
          out.innerHTML = '<h3>Rejected</h3><div class="alert alert-error">' + p.errors.map(esc).join('<br>') + '</div>' +
            '<p class="muted">Fix the file and upload again. Nothing was imported.</p>';
          return;
        }
        var rows = p.rows;
        if (rows.length === 0) { out.innerHTML = errorHtml('No data rows found.'); return; }
        out.innerHTML = '<p class="muted">Parsed ' + rows.length + ' rows from ' + esc(p.file_name) + '. Validating...</p>';
        api.post('/api/admin/import-commissions', { rows: rows, dry_run: true }).then(function (d) {
          if (!d.success) {
            out.innerHTML = '<h3>Rejected</h3><div class="alert alert-error">' + d.errors.map(esc).join('<br>') + '</div>' +
              '<p class="muted">Fix the file and upload again. Nothing was imported.</p>';
            return;
          }
          out.innerHTML = '<h3>Validation</h3>' +
            okHtml(d.valid_count + ' rows across ' + d.companies + ' companies. Every company adds up to 100%.') +
            '<button class="btn btn-primary" id="imp-commissions-fileconfirm">Confirm import of ' + d.valid_count + ' rows</button>';
          document.getElementById('imp-commissions-fileconfirm').onclick = function () {
            out.innerHTML = '<p class="muted">Importing...</p>';
            api.post('/api/admin/import-commissions', { rows: rows, dry_run: false }).then(function (r) {
              out.innerHTML = '<h3>Done</h3>' + okHtml('Imported ' + r.imported + ' commission rows for ' + r.companies + ' companies.');
              loadCommissionsNow();
            }).catch(function (err) { out.innerHTML = errorHtml(err.message); });
          };
        }).catch(function (err) { out.innerHTML = errorHtml(err.message); });
      }).catch(function (err) { out.innerHTML = errorHtml(err.message); });
    };
    document.getElementById('imp-commissions-go').onclick = function () {
      var out = document.getElementById('imp-commissions-out');
      out.innerHTML = '<p class="muted">Detecting format...</p>';
      api.get('/api/admin/stewards').then(function (stewards) {
        api.get('/api/admin/companies').then(function (companies) {
          var stewardIds = stewards.map(function (s) { return String(s.id); });
          var companyCodes = companies.map(function (c) { return String(c.company_code); });
          var parsed = parseCommissionWide(document.getElementById('imp-commissions-csv').value, stewardIds, companyCodes);
          if (parsed.errors.length) {
            out.innerHTML = '<h3>Rejected</h3><div class="alert alert-error">' + parsed.errors.map(esc).join('<br>') + '</div>' +
              '<p class="muted">Fix the file and validate again. Nothing was imported.</p>';
            return;
          }
          var rows = parsed.rows;
          if (rows.length === 0) { out.innerHTML = errorHtml('No data rows found.'); return; }
          var fmtMsg = parsed.format === 'steward-first'
            ? 'Detected: one line per steward (steward ID, then company_code/pct pairs).'
            : 'Detected: one line per company (company_code, then steward ID/pct pairs).';
          out.innerHTML = '<p class="muted">' + fmtMsg + ' Validating...</p>';
          api.post('/api/admin/import-commissions', { rows: rows, dry_run: true }).then(function (d) {
            if (!d.success) {
              out.innerHTML = '<h3>Rejected</h3><div class="alert alert-error">' + d.errors.map(esc).join('<br>') + '</div>' +
                '<p class="muted">Fix the file and validate again. Nothing was imported.</p>';
              return;
            }
            out.innerHTML = '<h3>Validation</h3><p class="muted">' + fmtMsg + '</p>' +
              okHtml(d.valid_count + ' rows across ' + d.companies + ' companies. Every company adds up to 100%.') +
              '<button class="btn btn-primary" id="imp-commissions-confirm">Confirm import of ' + d.valid_count + ' rows</button>';
            document.getElementById('imp-commissions-confirm').onclick = function () {
              out.innerHTML = '<p class="muted">Importing...</p>';
              api.post('/api/admin/import-commissions', { rows: rows, dry_run: false }).then(function (r) {
                out.innerHTML = '<h3>Done</h3>' + okHtml('Imported ' + r.imported + ' commission rows for ' + r.companies + ' companies.');
                loadCommissionsNow();
              }).catch(function (err) { out.innerHTML = errorHtml(err.message); });
            };
          }).catch(function (err) { out.innerHTML = errorHtml(err.message); });
        }).catch(function (err) { out.innerHTML = errorHtml(err.message); });
      }).catch(function (err) { out.innerHTML = errorHtml(err.message); });
    };
    function del(target, mode, key, key2, confirmText) {
      var out = document.getElementById('delout');
      if (!window.confirm(confirmText)) return;
      out.innerHTML = '<p class="muted">Deleting...</p>';
      api.post('/api/admin/delete-data', { target: target, mode: mode, key: key, key2: key2 }).then(function (d) {
        out.innerHTML = okHtml('Deleted ' + d.deleted + ' — ' + d.detail + '.');
      }).catch(function (err) {
        out.innerHTML = errorHtml(err.message);
      });
    }
    function loadReopenList() {
      var sel = document.getElementById('reopencard');
      api.get('/api/onboarding').then(function (list) {
        var done = list.filter(function (c) { return c.status === 'complete'; });
        sel.innerHTML = done.length
          ? '<option value="">Choose a card...</option>' + done.map(function (c) {
              return '<option value="' + c.id + '">' + esc(c.client_name) +
                (c.github_issue_number ? ' (GitHub #' + c.github_issue_number + ')' : '') + '</option>';
            }).join('')
          : '<option value="">No initiated cards</option>';
      }).catch(function () {
        sel.innerHTML = '<option value="">Could not load cards</option>';
      });
    }
    loadReopenList();
    document.getElementById('doreopen').onclick = function () {
      var out = document.getElementById('reopenout');
      var id = document.getElementById('reopencard').value;
      if (!id) { out.innerHTML = errorHtml('Choose a card first.'); return; }
      if (!window.confirm('Reopen this card? Its documents can then be added, changed, or deleted, and it can be sent to GitHub again into a brand new GitHub card.')) return;
      out.innerHTML = '<p class="muted">Reopening...</p>';
      api.post('/api/admin/onboarding/' + id + '/reopen', {}).then(function (d) {
        out.innerHTML = okHtml('Card reopened — find it under Onboarding, In Progress.') +
          (d.previousIssue
            ? '<p class="muted">When you send it to GitHub again, a brand new GitHub card is created. Have someone delete the old GitHub issue #' + d.previousIssue + '.</p>'
            : '<p class="muted">When you send it to GitHub again, a brand new GitHub card is created.</p>');
        loadReopenList();
      }).catch(function (err) {
        out.innerHTML = errorHtml(err.message);
      });
    };
    // Edit stewards card: pick a steward, then edit.
    var esSel = document.getElementById('editstewardsel');
    var esBox = document.getElementById('editstewardbox');
    var esMsg = document.getElementById('editstewardmsg');
    var esList = [];
    function loadStewardPicker() {
      api.get('/api/admin/stewards').then(function (list) {
        esList = list;
        esSel.innerHTML = list.length
          ? '<option value="">Choose a steward...</option>' + list.map(function (s) {
              return '<option value="' + s.id + '">' + s.id + ' — ' + esc(s.email) + '</option>';
            }).join('')
          : '<option value="">No stewards</option>';
      }).catch(function () {
        esSel.innerHTML = '<option value="">Could not load stewards</option>';
      });
    }
    loadStewardPicker();
    esSel.onchange = function () {
      var id = esSel.value;
      esBox.innerHTML = '';
      esMsg.innerHTML = '';
      if (!id) return;
      var cur = null;
      for (var k = 0; k < esList.length; k++) {
        if (String(esList[k].id) === String(id)) cur = esList[k];
      }
      if (!cur) return;
      var curRoles = cur.roles || [];
      function chk(v) {
        return '<label style="margin-right:8px;"><input type="checkbox" class="es-rolechk" value="' + v + '"' +
          (curRoles.indexOf(v) !== -1 ? ' checked' : '') + '> ' + roleLabel(v) + '</label>';
      }
      esBox.innerHTML =
        '<p><b>' + esc(cur.first_name || '') + ' ' + esc(cur.last_name || '') + '</b> <span class="muted">' + esc(cur.email) + '</span></p>' +
        '<div class="card"><div class="card-title">Edit details</div>' +
        '<form id="es-editf"><label>First name <input id="es-fn" value="' + esc(cur.first_name || '') + '"></label> ' +
        '<label>Last name <input id="es-ln" value="' + esc(cur.last_name || '') + '"></label><br>' +
        '<label>Email <input id="es-em" type="email" value="' + esc(cur.email || '') + '" required></label> ' +
        '<label>Phone <input id="es-ph" value="' + esc(cur.phone || '') + '"></label> ' +
        '<button class="btn btn-primary" type="submit">Save</button></form><div id="es-editmsg"></div></div>' +
        '<div class="card"><div class="card-title">Set password</div>' +
        '<form id="es-pwf" class="form-inline"><input id="es-pw" type="password" placeholder="New password (8+ chars)" required minlength="8"> ' +
        '<button class="btn btn-primary" type="submit">Save</button></form><div id="es-pwmsg"></div></div>' +
        '<div class="card"><div class="card-title">Set roles</div>' +
        '<form id="es-rolef" class="form-inline">' +
        chk('steward') + ' ' + chk('top_dog') + ' ' + chk('onboarding') + ' ' + chk('admin') + ' ' + chk('service') + ' ' + chk('client') + ' ' +
        '<button class="btn btn-primary" type="submit">Save roles</button></form><div id="es-rolemsg"></div></div>' +
        '<div class="card"><div class="card-title">Renumber</div>' +
        '<p class="muted">Changes the Steward ID everywhere it is used. If this is your own account, sign out and back in afterwards.</p>' +
        '<form id="es-renumf" class="form-inline"><input id="es-newid" placeholder="New Steward ID" required pattern="[1-9][0-9]*"> ' +
        '<button class="btn btn-primary" type="submit">Renumber</button></form><div id="es-renummsg"></div></div>' +
        '<div class="card"><div class="card-title">Delete</div>' +
        '<p class="muted">Removes the steward and their assignments. Cannot be undone.</p>' +
        '<button class="btn btn-danger" id="es-del">Delete steward</button><div id="es-delmsg"></div></div>';
      document.getElementById('es-editf').onsubmit = function (ev) {
        ev.preventDefault();
        api.put('/api/admin/stewards/' + id, {
          first_name: document.getElementById('es-fn').value,
          last_name: document.getElementById('es-ln').value,
          email: document.getElementById('es-em').value,
          phone: document.getElementById('es-ph').value
        }).then(function () {
          document.getElementById('es-editmsg').innerHTML = okHtml('Steward updated.');
          loadStewardPicker();
        }).catch(function (err) {
          document.getElementById('es-editmsg').innerHTML = errorHtml(err.message);
        });
      };
      document.getElementById('es-pwf').onsubmit = function (ev) {
        ev.preventDefault();
        api.post('/api/admin/stewards/' + id + '/password', { password: document.getElementById('es-pw').value })
          .then(function () { document.getElementById('es-pwmsg').innerHTML = okHtml('Password updated.'); })
          .catch(function (err) { document.getElementById('es-pwmsg').innerHTML = errorHtml(err.message); });
      };
      document.getElementById('es-rolef').onsubmit = function (ev) {
        ev.preventDefault();
        var boxes = document.querySelectorAll('.es-rolechk');
        var picked = [];
        for (var m = 0; m < boxes.length; m++) {
          if (boxes[m].checked) picked.push(boxes[m].value);
        }
        if (picked.length === 0) {
          document.getElementById('es-rolemsg').innerHTML = errorHtml('Pick at least one role.');
          return;
        }
        api.post('/api/admin/set-roles', { steward_id: parseInt(id, 10), roles: picked }).then(function () {
          document.getElementById('es-rolemsg').innerHTML = okHtml('Roles updated.');
        }).catch(function (err) {
          document.getElementById('es-rolemsg').innerHTML = errorHtml(err.message);
        });
      };
      document.getElementById('es-renumf').onsubmit = function (ev) {
        ev.preventDefault();
        var newId = document.getElementById('es-newid').value.trim();
        if (!/^[1-9][0-9]*$/.test(newId)) {
          document.getElementById('es-renummsg').innerHTML = errorHtml('Enter a positive whole number.');
          return;
        }
        if (!window.confirm('Change steward ' + id + ' to ID ' + newId + '? Assignments, roles, messages, and commission splits move with it.')) return;
        api.post('/api/admin/stewards/' + id + '/renumber', { new_id: parseInt(newId, 10) }).then(function (res) {
          var msg = 'Steward ' + res.old_id + ' is now ID ' + res.new_id + '.';
          if (state.user && String(state.user.id) === String(res.old_id)) {
            msg += ' That was your own account — sign out and back in.';
          }
          document.getElementById('es-renummsg').innerHTML = okHtml(msg);
          loadStewardPicker();
          esSel.value = '';
          esBox.innerHTML = '';
        }).catch(function (err) {
          document.getElementById('es-renummsg').innerHTML = errorHtml(err.message);
        });
      };
      document.getElementById('es-del').onclick = function () {
        if (!window.confirm('Delete this steward? Their assignments will be removed. This cannot be undone.')) return;
        api.delete('/api/admin/stewards/' + id).then(function () {
          esMsg.innerHTML = okHtml('Steward deleted.');
          loadStewardPicker();
          esSel.value = '';
          esBox.innerHTML = '';
        }).catch(function (err) {
          esMsg.innerHTML = errorHtml(err.message);
        });
      };
    };
    document.getElementById('delstewards').onclick = function () {
      del('stewards', 'all', '', '', 'Delete ALL non-admin stewards and their assignments? This cannot be undone.');
    };
    document.getElementById('delstewardone').onclick = function () {
      var k = document.getElementById('delstewardkey').value.trim();
      if (!k) { document.getElementById('delout').innerHTML = errorHtml('Enter a Steward ID or email.'); return; }
      del('stewards', 'one', k, '', 'Delete steward "' + k + '" and their assignments? This cannot be undone.');
    };
    document.getElementById('delcompanies').onclick = function () {
      del('companies', 'all', '', '', 'Delete ALL companies, implementations, messages and updates? This cannot be undone.');
    };
    document.getElementById('delcompanyone').onclick = function () {
      var k = document.getElementById('delcompanykey').value.trim();
      if (!k) { document.getElementById('delout').innerHTML = errorHtml('Enter a Company Code.'); return; }
      del('companies', 'one', k, '', 'Delete company "' + k + '" with its implementations, messages and updates? This cannot be undone.');
    };
    document.getElementById('delassignments').onclick = function () {
      del('assignments', 'all', '', '', 'Delete ALL steward to company assignments? This cannot be undone.');
    };
    document.getElementById('delassignone').onclick = function () {
      var k1 = document.getElementById('delassignkey1').value.trim();
      var k2 = document.getElementById('delassignkey2').value.trim();
      if (!k1 || !k2) { document.getElementById('delout').innerHTML = errorHtml('Enter a Steward ID and a Company Code.'); return; }
      del('assignments', 'one', k1, k2, 'Delete the assignment of steward ' + k1 + ' to company ' + k2 + '? This cannot be undone.');
    };
    (function initDeleteBills() {
      var billRows = [];
      function refreshCount() {
        var sel = document.getElementById('delbillacct');
        var accts = sel ? Array.prototype.map.call(sel.selectedOptions, function (o) { return o.value; }) : [];
        var wantOpen = document.getElementById('delbillopen').checked;
        var wantPaid = document.getElementById('delbillpaid').checked;
        var wantF = document.getElementById('delbillf').checked;
        var wantS = document.getElementById('delbills').checked;
        var n = billRows.filter(function (r) {
          if (accts.length > 0 && accts.indexOf(String(r.company_code)) === -1) return false;
          if (r.status === 'paid' && !wantPaid) return false;
          if (r.status !== 'paid' && !wantOpen) return false;
          var t = r.bill_type === 'S' ? 'S' : 'F';
          if (t === 'F' && !wantF) return false;
          if (t === 'S' && !wantS) return false;
          return true;
        }).length;
        document.getElementById('delbillcount').innerHTML =
          'Current selection matches <b>' + n + '</b> bill' + (n === 1 ? '' : 's') + '.';
        return { accounts: accts, n: n,
          statuses: (wantOpen ? ['open'] : []).concat(wantPaid ? ['paid'] : []),
          types: (wantF ? ['F'] : []).concat(wantS ? ['S'] : []) };
      }
      api.get('/api/billing?status=open').then(function (o) {
        api.get('/api/billing?status=paid').then(function (p) {
          billRows = o.concat(p);
          var codeMap = {};
          billRows.forEach(function (r) { codeMap[String(r.company_code)] = r.company_name; });
          var sel = document.getElementById('delbillacct');
          sel.innerHTML = Object.keys(codeMap).sort().map(function (c) {
            return '<option value="' + esc(c) + '">' + esc(c) +
              (codeMap[c] && codeMap[c] !== c ? ' — ' + esc(codeMap[c]) : '') + '</option>';
          }).join('');
          ['delbillacct', 'delbillopen', 'delbillpaid', 'delbillf', 'delbills'].forEach(function (id) {
            document.getElementById(id).onchange = refreshCount;
          });
          refreshCount();
        }).catch(function () { document.getElementById('delbillcount').innerHTML = errorHtml('Could not load bills.'); });
      }).catch(function () { document.getElementById('delbillcount').innerHTML = errorHtml('Could not load bills.'); });
      document.getElementById('dodelbills').onclick = function () {
        var dc = refreshCount();
        if (dc.n === 0) { document.getElementById('delbillout').innerHTML = errorHtml('Nothing matches the current selection.'); return; }
        if (dc.statuses.length === 0 || dc.types.length === 0) {
          document.getElementById('delbillout').innerHTML = errorHtml('Pick at least one status and one bill type.');
          return;
        }
        if (!window.confirm('Delete ' + dc.n + ' bill' + (dc.n === 1 ? '' : 's') + '? This cannot be undone.')) return;
        document.getElementById('delbillout').innerHTML = '<p class="muted">Deleting...</p>';
        api.post('/api/admin/billing/delete-bills', {
          accounts: dc.accounts, statuses: dc.statuses, types: dc.types
        }).then(function (r) {
          document.getElementById('delbillout').innerHTML = okHtml('Deleted ' + r.deleted + ' bills.');
          initDeleteBills();
        }).catch(function (err) { document.getElementById('delbillout').innerHTML = errorHtml(err.message); });
      };
    })();
  });
}


// ---------------------------------------------------------------- onboarding
var OB_DOC_TYPES = [
  ['master_application', 'Master Application', 1],
  ['pre_implementation', 'Pre-Implementation Form', 1],
  ['commission_sheet', 'Commission Sheet', 1],
  ['w9', 'W-9s', 0],
  ['ach', 'ACH Authorizations', 0]
];
function obDocLabel(t) {
  for (var i = 0; i < OB_DOC_TYPES.length; i++) if (OB_DOC_TYPES[i][0] === t) return OB_DOC_TYPES[i][1];
  return t;
}

function viewForms() {
  requireUser(function () {
    var role = activeRole();
    if (['admin', 'top_dog'].indexOf(role) === -1) { location.hash = '#/dashboard'; return; }
    var isAdmin = role === 'admin';
    function load() {
      api.get('/api/forms').then(function (list) {
        var rows = list.length ? list.map(function (f) {
          return '<div class="ob-doc"><span><b>' + esc(f.name) + '</b></span> ' +
            '<span class="muted">' + esc(f.file_name) + '</span> ' +
            '<button class="btn btn-small" data-fdl="' + f.id + '" data-fn="' + esc(f.file_name) + '">Download</button>' +
            (isAdmin ? ' <button class="btn btn-small btn-danger" data-fdel="' + f.id + '">Delete</button>' : '') + '</div>';
        }).join('') : '<p class="muted">No blank forms stored yet.</p>';
        var up = isAdmin ?
          '<div class="card"><h4>Upload a blank form</h4>' +
          '<p class="muted">Stored as-is. Uploading a form with an existing name replaces it. The Soluta generator looks for a form named exactly "Soluta Billing Intake Form".</p>' +
          '<p><label>Form name: <input id="formname" style="width: 280px;"></label></p>' +
          '<p><label class="btn btn-primary">Choose file<input type="file" id="formfile" style="display:none"></label> <span id="formpick" class="muted"></span></p>' +
          '<p><button class="btn btn-primary" id="formupload">Upload form</button></p><div id="formmsg"></div></div>' : '';
        render(shell(
          '<h2>Forms</h2><div id="msg"></div>' +
          '<p class="muted">Blank forms the system uses to generate client paperwork.</p>' +
          up + '<div class="card"><h4>Stored forms</h4>' + rows + '</div>',
          '#/forms'));
        var ff = document.getElementById('formfile');
        if (ff) ff.onchange = function () {
          document.getElementById('formpick').textContent = ff.files[0] ? ff.files[0].name : '';
        };
        var fu = document.getElementById('formupload');
        if (fu) fu.onclick = function () {
          var nm = document.getElementById('formname').value.trim();
          var f = document.getElementById('formfile').files[0];
          var msg = document.getElementById('formmsg');
          if (!nm) { msg.innerHTML = errorHtml('Enter a form name.'); return; }
          if (!f) { msg.innerHTML = errorHtml('Choose a file.'); return; }
          var fd = new FormData();
          fd.append('name', nm);
          fd.append('file', f);
          msg.innerHTML = '<p class="muted">Uploading...</p>';
          uploadFile('/api/forms', fd).then(function () { load(); })
            .catch(function (err) { msg.innerHTML = errorHtml(err.message); });
        };
        document.querySelectorAll('[data-fdl]').forEach(function (el) {
          el.onclick = function () {
            var headers = {};
            if (api.token) headers['Authorization'] = 'Bearer ' + api.token;
            fetch('/api/forms/' + el.getAttribute('data-fdl') + '/download', { headers: headers }).then(function (resp) {
              if (!resp.ok) throw new Error('Download failed');
              return resp.blob();
            }).then(function (blob) {
              var url = URL.createObjectURL(blob);
              var aEl = document.createElement('a');
              aEl.href = url;
              aEl.download = el.getAttribute('data-fn');
              document.body.appendChild(aEl);
              aEl.click();
              setTimeout(function () { URL.revokeObjectURL(url); aEl.remove(); }, 500);
            }).catch(function (err) { document.getElementById('msg').innerHTML = errorHtml(err.message); });
          };
        });
        document.querySelectorAll('[data-fdel]').forEach(function (el) {
          el.onclick = function () {
            if (!confirm('Delete this blank form?')) return;
            api.delete('/api/forms/' + el.getAttribute('data-fdel')).then(load)
              .catch(function (err) { document.getElementById('msg').innerHTML = errorHtml(err.message); });
          };
        });
      }).catch(function (err) { render(shell(errorHtml(err.message), '#/forms')); });
    }
    load();
  });
}

function viewOnboarding() {
  requireUser(function () {
    if (!canOnboard()) { location.hash = '#/dashboard'; return; }
    api.get('/api/onboarding').then(function (list) {
      var prog = list.filter(function (c) { return c.status === 'in_progress'; });
      var done = list.filter(function (c) { return c.status !== 'in_progress'; });
      var canDel = activeRole() === 'admin' || activeRole() === 'onboarding';
      function card(c) {
        var badge = c.critical_open > 0
          ? '<span class="rag rag-red">' + c.critical_open + ' critical</span>'
          : '<span class="rag rag-green">Checked</span>';
        var delBtn = (canDel && c.status === 'in_progress' && (c.wizard_step || 1) < 4)
          ? ' <button class="btn btn-danger" data-obdel="' + c.id + '">Delete</button>' : '';
        return '<div class="ob-card"><div class="ob-card-head"><b>' + esc(c.client_name) + '</b>' + badge + '</div>' +
          '<div class="muted">' + c.doc_count + ' document(s) &middot; started ' + fmtDate(c.created_at) +
          (c.github_issue_number ? ' &middot; GitHub #' + c.github_issue_number : '') + '</div>' +
          '<p><a class="btn btn-primary" href="#/onboarding/' + (c.wizard_step ? 'process/' : '') + c.id + '">Open</a>' + delBtn + '</p></div>';
      }
      render(shell(
        '<h2>Onboarding</h2><div id="err"></div>' +
        '<p><a class="btn btn-primary" href="#/onboarding/new">+ Add client</a></p>' +
        '<h3>In Progress (' + prog.length + ')</h3>' +
        (prog.length ? '<div class="ob-grid">' + prog.map(card).join('') + '</div>' : '<p class="muted">No clients being onboarded right now.</p>') +
        '<h3>Complete (' + done.length + ')</h3>' +
        (done.length ? '<div class="ob-grid">' + done.map(card).join('') + '</div>' : '<p class="muted">Nothing completed yet.</p>'),
        '#/onboarding'));
      document.querySelectorAll('[data-obdel]').forEach(function (b) {
        b.onclick = function () {
          if (!window.confirm('Delete this unfinished onboarding session and its uploaded documents? This cannot be undone.')) return;
          api.delete('/api/onboarding/' + b.getAttribute('data-obdel')).then(function () { viewOnboarding(); })
            .catch(function (e) { document.getElementById('err').innerHTML = errorHtml(e.message); });
        };
      });
    }).catch(function (err) { render(shell(errorHtml(err.message), '#/onboarding')); });
  });
}

function obCheckList(items) {
  return '<ul style="list-style:none;padding-left:2px;">' + items.map(function (c) {
    var label = c.label || c.text || '';
    return '<li style="margin:4px 0;">' + (c.ok ? '<b style="color:#137333;">&#10003;</b>' : '<b style="color:#b3261e;">&#10007;</b>') + ' ' + esc(label) +
      (c.detail ? '<br><span class="muted" style="margin-left:20px;">' + esc(c.detail) + '</span>' : '') + '</li>';
  }).join('') + '</ul>';
}

function viewOnboardingNew() {
  requireUser(function () {
    if (!canOnboard()) { location.hash = '#/dashboard'; return; }
    var processId = null;
    render(shell(
      '<p><a href="#/onboarding">&larr; Onboarding</a></p>' +
      '<h2>New Onboarding</h2><div id="err"></div>' +
      '<div class="card"><h3>Step 1: Upload the DocuSign package</h3>' +
      '<p class="muted">Upload the completed DocuSign package (PDF). It must contain the Group Benefits - Fixed Indemnity Application, the Master Services Agreement, and the Authorization Agreement for Direct Payments (ACH).</p>' +
      '<p><input type="file" id="obpkg" accept=".pdf"></p>' +
      '<p><button class="btn btn-primary" id="obgo">Upload and verify</button></p><div id="obout"></div>' +
      '<p id="obcancelwrap" style="display:none;"><button class="btn btn-danger" id="obcancel">Cancel and delete this session</button></p></div>' +
      '<div class="card" id="obstep2" style="display:none;"><h3>Step 2: Verification</h3><div id="obchecks"></div><div id="obparent"></div></div>',
      '#/onboarding/new'));
    function showErr(m) { document.getElementById('err').innerHTML = errorHtml(m); }
    function runCheck() {
      var out = document.getElementById('obout');
      out.innerHTML = '<p class="muted">Verifying the package...</p>';
      api.post('/api/onboarding/' + processId + '/docusign-check', {}).then(function (r) {
        out.innerHTML = '';
        var card = document.getElementById('obstep2');
        card.style.display = '';
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        document.getElementById('obchecks').innerHTML = obCheckList(r.checks);
        var p = document.getElementById('obparent');
        if (r.passed) {
          p.innerHTML = '<p style="color:#137333;"><b>All verifications passed.</b></p>' +
            '<p>Parent Code: <b>' + esc(r.parent_code) + '</b><br>Parent Name: <b>' + esc(r.parent_name) + '</b> (the Applicant/Policyholder)</p>' +
            '<p><button class="btn btn-primary" id="obcontinue">Continue to Step 3</button></p>';
          document.getElementById('obcontinue').onclick = function () { location.hash = '#/onboarding/process/' + processId; };
        } else {
          p.innerHTML = '<p style="color:#b3261e;"><b>Submission is blocked until every check passes.</b> Delete this package and upload a corrected one.</p>' +
            '<p><button class="btn btn-danger" id="obdelpkg">Delete this package</button></p>';
          document.getElementById('obdelpkg').onclick = function () {
            api.get('/api/onboarding/' + processId).then(function (c) {
              var doc = (c.documents || []).filter(function (d) { return d.doc_type === 'docusign_package'; })[0];
              if (!doc) { showErr('No package found to delete.'); return; }
              api.delete('/api/onboarding/' + processId + '/documents/' + doc.id).then(function () {
                document.getElementById('obstep2').style.display = 'none';
                document.getElementById('obout').innerHTML = '<p class="muted">Package deleted. Choose the corrected DocuSign package above and upload again.</p>';
              }).catch(function (e) { showErr(e.message); });
            }).catch(function (e) { showErr(e.message); });
          };
        }
      }).catch(function (e) { out.innerHTML = errorHtml(e.message); });
    }
    document.getElementById('obgo').onclick = function () {
      var f = document.getElementById('obpkg').files[0];
      if (!f) { showErr('Choose the DocuSign package PDF first.'); return; }
      var out = document.getElementById('obout');
      out.innerHTML = '<p class="muted">Uploading...</p>';
      function uploadAndCheck() {
        var fd = new FormData();
        fd.append('docType', 'docusign_package');
        fd.append('file', f);
        uploadFile('/api/onboarding/' + processId + '/documents', fd).then(runCheck)
          .catch(function (e) { out.innerHTML = errorHtml(e.message); });
      }
      if (processId) { uploadAndCheck(); return; }
      api.post('/api/onboarding/process-start', {}).then(function (r) {
        processId = r.id;
        document.getElementById('obcancelwrap').style.display = '';
        uploadAndCheck();
      }).catch(function (e) { out.innerHTML = errorHtml(e.message); });
    };
    document.getElementById('obcancel').onclick = function () {
      if (!processId) { location.hash = '#/onboarding'; return; }
      if (!window.confirm('Cancel and delete this onboarding session and its uploaded documents? This cannot be undone.')) return;
      api.delete('/api/onboarding/' + processId).then(function () { location.hash = '#/onboarding'; })
        .catch(function (e) { showErr(e.message); });
    };
  });
}

function viewOnboardingProcess(id) {
  requireUser(function () {
    if (!canOnboard()) { location.hash = '#/dashboard'; return; }
    function load() {
      api.get('/api/onboarding/' + id).then(function (c) {
        var parentLine = c.parent_code
          ? '<p>Parent Code: <b>' + esc(c.parent_code) + '</b> &middot; Parent Name: <b>' + esc(c.parent_name || c.client_name) + '</b></p>'
          : '<p class="muted">Parent not assigned yet - the DocuSign package has not passed verification.</p>';
        var step2 = '<div class="card"><h3>Steps 1-2: DocuSign package</h3>' +
          (c.wizard_step >= 3
            ? '<p style="color:#137333;"><b>&#10003; Verified.</b> The package contains the Application, the Master Services Agreement, and the ACH Authorization, and the required fields, signatures, and dates checked out.</p>'
            : '<p style="color:#b3261e;">Not verified yet. The package on file has not passed - delete it there and upload a corrected package from the <a href="#/onboarding/new">New Onboarding</a> page.</p>') + '</div>';
        var codes = [];
        try { codes = JSON.parse(c.companies_json || '[]'); } catch (e) { codes = []; }
        var step3 = '';
        if (c.wizard_step >= 3 && !codes.length && c.status === 'in_progress') {
          step3 = '<div class="card"><h3>Step 3: Upload the Pre-Implementation Form</h3>' +
            '<p class="muted">Upload the Pre-Implementation Form (Excel). Each EIN column with a Legal Name of the Company becomes a company under this Parent: Legal Name becomes the Company Name, the Employer Address becomes the Address, City, State, and Zip, and the Employer Tax ID becomes the EIN. Company Codes are assigned automatically - the highest existing code + 1.</p>' +
            '<p><input type="file" id="obpre" accept=".xlsx,.xls,.csv"> <button class="btn" id="obpreup">Upload</button></p><div id="obpreout"></div>' +
            '<p><button class="btn btn-primary" id="obanalyze">Analyze the form</button></p><div id="obpreview"></div></div>';
        }
        var step4 = '';
        if (codes.length && c.status === 'in_progress') {
          step4 = '<div class="card"><h3>Step 4: Steward Update and Commission Update</h3>' +
            '<p>The companies are now on the Companies table with status PENDING: <b>' + codes.map(esc).join(', ') + '</b>. Complete both updates, in either order:</p>' +
            '<p><b>Steward Update:</b> go to the <a href="#/admin/stewards">Stewards page</a> and confirm every steward on the commission schedule is on the Stewards table, with all required fields filled out and their W9 and ACH uploaded.</p>' +
            '<p><b>Commission Update:</b> go to the <a href="#/admin/commissions">Commissions page</a> and add the commission record for each new company - upload the Commission Schedule on the company\'s row (it fills in the stewards and percentages for you), or click Edit and type them in. Each company must add up to 100%.</p>' +
            '<p><button class="btn btn-primary" id="obverify">Verify</button></p><div id="obverifyout"></div></div>' +
            '<div class="card" id="obstep5" style="display:none;"><h3>Step 5: Submit</h3>' +
            '<p class="muted">Verification passed. Submitting opens a Kanban card in GitHub under Onboarding, named for the Parent, with a summary of the account in the comments.</p>' +
            '<p><button class="btn btn-primary" id="obfinish">Submit</button></p><div id="obfinishout"></div></div>';
        }
        var done = '';
        if (c.status === 'complete') {
          done = '<div class="card"><h3>Submitted</h3><p>This onboarding is complete.' +
            (c.github_issue_number ? ' GitHub card: <b>#' + c.github_issue_number + '</b> (' + esc(c.github_repo || '') + ').' : '') + '</p></div>';
        }
        var delSession = '';
        if (c.status === 'in_progress' && (c.wizard_step || 1) < 4 && (activeRole() === 'admin' || activeRole() === 'onboarding')) {
          delSession = '<p><button class="btn btn-danger" id="obdelsession">Delete this session</button> ' +
            '<span class="muted">Stops this onboarding here and removes the session and its uploaded documents. Nothing has been created from it yet.</span></p>';
        }
        render(shell(
          '<p><a href="#/onboarding">&larr; Onboarding</a></p>' +
          '<h2>Onboarding: ' + esc(c.parent_name || c.client_name) + '</h2><div id="err"></div>' +
          parentLine + delSession + step2 + step3 + step4 + done,
          '#/onboarding'));
        var delSessBtn = document.getElementById('obdelsession');
        if (delSessBtn) delSessBtn.onclick = function () {
          if (!window.confirm('Delete this unfinished onboarding session and its uploaded documents? This cannot be undone.')) return;
          api.delete('/api/onboarding/' + id).then(function () { location.hash = '#/onboarding'; })
            .catch(function (e) { document.getElementById('err').innerHTML = errorHtml(e.message); });
        };
        var preUp = document.getElementById('obpreup');
        if (preUp) preUp.onclick = function () {
          var f = document.getElementById('obpre').files[0];
          var out = document.getElementById('obpreout');
          if (!f) { out.innerHTML = errorHtml('Choose the Pre-Implementation Form file first.'); return; }
          var fd = new FormData();
          fd.append('docType', 'pre_implementation');
          fd.append('file', f);
          out.innerHTML = '<p class="muted">Uploading...</p>';
          uploadFile('/api/onboarding/' + id + '/documents', fd).then(function () {
            out.innerHTML = '<p style="color:#137333;">Uploaded. Now click Analyze the form.</p>';
          }).catch(function (e) { out.innerHTML = errorHtml(e.message); });
        };
        var anBtn = document.getElementById('obanalyze');
        if (anBtn) anBtn.onclick = function () {
          var pv = document.getElementById('obpreview');
          pv.innerHTML = '<p class="muted">Analyzing...</p>';
          api.post('/api/onboarding/' + id + '/preimpl-preview', {}).then(function (r) {
            if (!r.companies.length) { pv.innerHTML = errorHtml('No EIN columns with a Legal Name of the Company were found in that form.'); return; }
            var rows = r.companies.map(function (co) {
              return '<tr><td><b>' + esc(co.company_code) + '</b></td><td>' + esc(co.ein) + '</td><td>' + esc(co.company_name) + '</td><td>' + esc(co.company_address_1) + '</td><td>' + esc(co.company_city) + '</td><td>' + esc(co.company_state) + '</td><td>' + esc(co.company_zip) + '</td><td>' + esc(co.company_status) + '</td>' +
                '<td>' + (co.missing.length ? '<span style="color:#b3261e;">Missing: ' + co.missing.map(esc).join('; ') + '</span>' : '<span style="color:#137333;">&#10003;</span>') + '</td></tr>';
            }).join('');
            var blocked = r.companies.some(function (co) { return co.missing.indexOf('Employer Address') !== -1 || co.missing.indexOf('Employer Tax ID (EIN)') !== -1; });
            pv.innerHTML = '<div class="table-scroll"><table class="data-table"><thead><tr><th>Company Code</th><th>EIN</th><th>Company Name</th><th>Address</th><th>City</th><th>State</th><th>Zip</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
              (r.skipped ? '<p class="muted">' + r.skipped + ' EIN column(s) had no Legal Name and were skipped.</p>' : '') +
              '<p><button class="btn btn-primary" id="obsubmit3"' + (blocked ? ' disabled' : '') + '>Submit - create these companies</button></p><div id="obsubmitout"></div>' +
              (blocked ? '<p style="color:#b3261e;">Submit is blocked: a company is missing its Employer Address or Employer Tax ID. Fix the form, upload it again, and re-analyze.</p>' : '');
            var sb = document.getElementById('obsubmit3');
            if (sb) sb.onclick = function () {
              var out = document.getElementById('obsubmitout');
              out.innerHTML = '<p class="muted">Creating the companies...</p>';
              api.post('/api/onboarding/' + id + '/process-submit-companies', {}).then(function () { load(); })
                .catch(function (e) { out.innerHTML = errorHtml(e.message); });
            };
          }).catch(function (e) { pv.innerHTML = errorHtml(e.message); });
        };
        var vBtn = document.getElementById('obverify');
        if (vBtn) vBtn.onclick = function () {
          var out = document.getElementById('obverifyout');
          out.innerHTML = '<p class="muted">Checking...</p>';
          api.post('/api/onboarding/' + id + '/process-verify', {}).then(function (r) {
            out.innerHTML = obCheckList(r.items);
            if (r.pass) {
              var s5 = document.getElementById('obstep5');
              s5.style.display = '';
              s5.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }).catch(function (e) { out.innerHTML = errorHtml(e.message); });
        };
        var fBtn = document.getElementById('obfinish');
        if (fBtn) fBtn.onclick = function () {
          var out = document.getElementById('obfinishout');
          out.innerHTML = '<p class="muted">Opening the GitHub card...</p>';
          api.post('/api/onboarding/' + id + '/process-finish', {}).then(function (r) {
            out.innerHTML = '<p style="color:#137333;"><b>Submitted.</b> GitHub card <a href="' + esc(r.issueUrl) + '" target="_blank" rel="noopener">#' + r.issueNumber + '</a> is open under Onboarding.</p>';
            load();
          }).catch(function (e) { out.innerHTML = errorHtml(e.message); });
        };
      }).catch(function (err) { render(shell(errorHtml(err.message), '#/onboarding')); });
    }
    load();
  });
}

function viewOnboardingDetail(id) {
  requireUser(function () {
    if (!canOnboard()) { location.hash = '#/dashboard'; return; }
    function load() {
      api.get('/api/onboarding/' + id).then(function (c) {
        var inProg = c.status === 'in_progress';
        var solutaDocs = c.documents.filter(function (d) { return d.doc_type === 'soluta_billing_intake'; });
        var hasPre = c.documents.some(function (d) { return d.doc_type === 'pre_implementation'; });
        var hasComm = c.documents.some(function (d) { return d.doc_type === 'commission_sheet'; });
        var solutaHtml = '';
        var solutaList = solutaDocs.length ? solutaDocs.map(function (d) {
          return '<div class="ob-doc"><span>' + esc(d.file_name) + '</span> ' +
            '<span class="muted">' + fmtDate(d.uploaded_at) + '</span> ' +
            '<button class="btn btn-link" data-solutadl="' + d.id + '" data-fn="' + esc(d.file_name) + '">Download</button></div>';
        }).join('') : '<p class="muted">No Soluta forms generated yet.</p>';
        if (inProg) {
          solutaHtml += solutaList;
          if (hasPre && hasComm) {
            solutaHtml += '<p><label>Payroll frequencies: <select id="solutamode">' +
              '<option value="auto" selected>All detected payroll frequencies</option>' +
              ['Weekly', 'Bi-weekly', 'Semi-monthly', 'Monthly'].map(function (mo) { return '<option value="' + mo + '">' + mo + ' only</option>'; }).join('') +
              '</select></label> ' +
              '<button class="btn btn-primary" id="solutagen">' + (solutaDocs.length ? 'Regenerate' : 'Generate') + ' Soluta Billing Intake Forms</button></p>' +
              '<p class="muted">One form is generated per payroll frequency, each listing only the EINs paid on that frequency. Yellow cells need a human to fill them in.</p>' +
              '<div id="solutamsg"></div>';
          } else {
            solutaHtml += '<p class="muted">Upload the Pre-Implementation Form and the Commission Sheet to enable generation.</p>';
          }
        } else {
          solutaHtml = solutaList;
        }
        function docRow(d) {
          return '<div class="ob-doc"><span>' + esc(d.file_name) + '</span> ' +
            '<span class="muted">' + fmtDate(d.uploaded_at) + '</span> ' +
            '<button class="btn btn-link" data-dl="' + d.id + '" data-fn="' + esc(d.file_name) + '">Download</button>' +
            (inProg ? ' <button class="btn btn-danger" data-del="' + d.id + '">Delete</button>' : '') + '</div>';
        }
        function slot(t, label, single) {
          var docs = c.documents.filter(function (d) { return d.doc_type === t; });
          var body = docs.length ? docs.map(docRow).join('') : '<p class="muted">No ' + esc(label) + ' uploaded yet.</p>';
          var up = inProg
            ? '<p><label class="btn">' + (docs.length && single ? 'Replace' : 'Upload') + ' ' + esc(label) +
              '<input type="file" data-up="' + t + '" style="display:none"' +
              (t === 'master_application' ? ' accept=".pdf"' : '') + '></label></p>'
            : '';
          return '<div class="card"><h4>' + esc(label) + '</h4>' + body + up + '</div>';
        }
        var issues = c.issues.length ? c.issues.map(function (x) {
          var cls = x.severity === 'critical' ? 'rag-red' : (x.severity === 'warning' ? 'rag-yellow' : 'rag-green');
          return '<div class="ob-issue"><span class="rag ' + cls + '">' + esc(x.severity) + '</span> ' +
            (x.doc_type ? '<b>' + esc(obDocLabel(x.doc_type)) + ':</b> ' : '') + esc(x.message) +
            (inProg ? ' <button class="btn btn-link" data-dismiss="' + x.id + '" title="Remove this finding">Delete</button>' +
            ' <button class="btn btn-link" data-override="' + x.id + '" title="Accept the document despite this finding">Override</button>' : '') + '</div>';
        }).join('') : '<p class="muted">No open issues. The documents look complete.</p>';
        var initBtn;
        if (!inProg) {
          initBtn = '<p class="muted">Sent to GitHub' + (c.initiated_at ? ' on ' + fmtDate(c.initiated_at) : '') +
            (c.github_issue_number ? ' &middot; GitHub issue #' + c.github_issue_number : '') + '.</p>';
        } else if (c.canInitiate) {
          initBtn = '<p><button class="btn btn-primary" id="obinit">Send to GitHub</button></p><div id="obinitmsg"></div>';
        } else {
          initBtn = '<p><button class="btn" disabled title="Upload all documents and clear critical issues first">Send to GitHub</button> ' +
            '<span class="muted">Available when all documents are uploaded and no critical issues are open.</span></p><div id="obinitmsg"></div>';
        }
        render(shell(
          '<p><a href="#/onboarding">&larr; Onboarding</a></p><div id="err"></div>' +
          '<h2>' + esc(c.client_name) + '</h2>' +
          '<p class="muted">Status: <b>' + (inProg ? 'In Progress' : 'Complete') + '</b>' +
          (c.payroll_provider ? ' &middot; Payroll: ' + esc(c.payroll_provider) : '') +
          ' &middot; Onboarding started ' + fmtDate(c.created_at) + '</p>' +
          '<h3>Documents</h3>' +
          slot('master_application', 'Master Application', 1) +
          slot('pre_implementation', 'Pre-Implementation Form', 1) +
          slot('commission_sheet', 'Commission Sheet', 1) +
          slot('w9', 'W-9s', 0) +
          slot('ach', 'ACH Authorizations', 0) +
          '<h3>Completeness check</h3><div id="obissues">' + issues + '</div>' +
          ((c.handled && c.handled.length) ? '<p class="muted">' + c.handled.map(function (h) { return h.n + ' ' + esc(h.resolution); }).join(' &middot; ') + '</p>' : '') +
          (inProg ? '<p><button class="btn" id="obreaudit">Re-run check</button></p>' : '') +
          '<h3>Soluta Billing Intake Form</h3>' + solutaHtml +
          '<h3>Send to GitHub</h3>' + initBtn +
          (inProg ? '<p><button class="btn btn-link" id="obdelete" style="color:#c00">Delete this client card</button></p>' : ''),
          '#/onboarding'));
        // wire up uploads
        var ups = document.querySelectorAll('[data-up]');
        for (var k = 0; k < ups.length; k++) {
          (function (el) {
            el.onchange = function () {
              var f = el.files[0];
              if (!f) return;
              var fd = new FormData();
              fd.append('docType', el.getAttribute('data-up'));
              fd.append('file', f);
              document.getElementById('err').innerHTML = '<p class="muted">Uploading and checking...</p>';
              uploadFile('/api/onboarding/' + id + '/documents', fd).then(load).catch(function (err) {
                document.getElementById('err').innerHTML = errorHtml(err.message);
              });
            };
          })(ups[k]);
        }
        // downloads + deletes + resolves
        document.querySelectorAll('[data-dl]').forEach(function (el) {
          el.onclick = function () { downloadOnboardingDoc(id, el.getAttribute('data-dl'), el.getAttribute('data-fn')); };
        });
        document.querySelectorAll('[data-del]').forEach(function (el) {
          el.onclick = function () {
            if (!confirm('Delete this document? You can upload a replacement.')) return;
            api.delete('/api/onboarding/' + id + '/documents/' + el.getAttribute('data-del')).then(load)
              .catch(function (err) { document.getElementById('err').innerHTML = errorHtml(err.message); });
          };
        });
        document.querySelectorAll('[data-solutadl]').forEach(function (el) {
          el.onclick = function () { downloadOnboardingDoc(id, el.getAttribute('data-solutadl'), el.getAttribute('data-fn')); };
        });
        var sg = document.getElementById('solutagen');
        if (sg) sg.onclick = function () {
          var mode = document.getElementById('solutamode').value;
          if (!confirm('Generate the Soluta Billing Intake Form(s) from the uploaded documents? One form is created per payroll frequency.')) return;
          document.getElementById('solutamsg').innerHTML = '<p class="muted">Generating...</p>';
          api.post('/api/onboarding/' + id + '/generate-soluta', { billingMode: mode }).then(function (r) {
            var names = (r.files || []).map(function (f) { return f.fileName + ' (' + f.locations + ' EINs)'; }).join(', ');
            window._solutaMsg = 'Generated ' + (r.files || []).length + ' form(s): ' + names;
            load();
          }).catch(function (err) { document.getElementById('solutamsg').innerHTML = errorHtml(err.message); });
        };
        if (window._solutaMsg && document.getElementById('solutamsg')) {
          document.getElementById('solutamsg').innerHTML = okHtml(window._solutaMsg);
          window._solutaMsg = null;
        }
        document.querySelectorAll('[data-dismiss]').forEach(function (el) {
          el.onclick = function () {
            if (!confirm('Delete this finding? It will be removed from the list.')) return;
            api.post('/api/onboarding/' + id + '/issues/' + el.getAttribute('data-dismiss') + '/resolve', { resolution: 'dismissed' }).then(load)
              .catch(function (err) { document.getElementById('err').innerHTML = errorHtml(err.message); });
          };
        });
        document.querySelectorAll('[data-override]').forEach(function (el) {
          el.onclick = function () {
            if (!confirm('Override this finding? The document will be treated as accepted even though the check flagged it.')) return;
            api.post('/api/onboarding/' + id + '/issues/' + el.getAttribute('data-override') + '/resolve', { resolution: 'overridden' }).then(load)
              .catch(function (err) { document.getElementById('err').innerHTML = errorHtml(err.message); });
          };
        });
        var ra = document.getElementById('obreaudit');
        if (ra) ra.onclick = function () {
          api.post('/api/onboarding/' + id + '/audit', {}).then(load)
            .catch(function (err) { document.getElementById('err').innerHTML = errorHtml(err.message); });
        };
        var ib = document.getElementById('obinit');
        if (ib) ib.onclick = function () {
          if (!confirm('Send ' + c.client_name + ' to GitHub? This creates the GitHub card and moves the client to Complete.')) return;
          document.getElementById('obinitmsg').innerHTML = '<p class="muted">Creating the GitHub card...</p>';
          api.post('/api/onboarding/' + id + '/initiate', {}).then(function (r) {
            var msg = 'Sent to GitHub. Issue <a href="' + esc(r.issueUrl) + '" target="_blank">#' + r.issueNumber + '</a> created.';
            if (!r.boardOk) msg += ' <span class="rag rag-yellow">Card was not added to the board automatically: ' + esc(r.boardError || 'unknown reason') + '. Add issue #' + r.issueNumber + ' to the board by hand.</span>';
            document.getElementById('obinitmsg').innerHTML = '<p>' + msg + '</p>';
            setTimeout(load, 2500);
          }).catch(function (err) {
            document.getElementById('obinitmsg').innerHTML = errorHtml(err.message);
          });
        };
        var del = document.getElementById('obdelete');
        if (del) del.onclick = function () {
          if (!confirm('Delete this entire onboarding card and all its documents?')) return;
          api.delete('/api/onboarding/' + id).then(function () { location.hash = '#/onboarding'; })
            .catch(function (err) { document.getElementById('err').innerHTML = errorHtml(err.message); });
        };
      }).catch(function (err) { render(shell(errorHtml(err.message), '#/onboarding')); });
    }
    load();
  });
}

// ---------------------------------------------------------------- router

function route() {
  var h = location.hash || '#/login';
  if (h === '' || h === '#/') {
    location.hash = api.token ? '#/dashboard' : '#/login';
    return;
  }
  var noHash = h.slice(0, 2) === '#/' ? h.slice(2) : h;
  var parts = noHash.split('?');
  var pathParts = parts[0].split('/');
  var query = {};
  if (parts[1]) parts[1].split('&').forEach(function (kv) {
    var p = kv.split('=');
    query[p[0]] = decodeURIComponent(p[1] || '');
  });
  if (h === '#/login') return viewLogin();
  if (h === '#/forgot') return viewForgot();
  if (pathParts[0] === 'reset-password') return viewResetPassword(query.token || '');
  if (pathParts[0] === 'reset') return viewReset(query.token || '');
  if (pathParts[0] === 'dashboard') return viewDashboard();
  if (pathParts[0] === 'billing') return viewBilling();
  if (pathParts[0] === 'security') return viewSecurity();
  if (pathParts[0] === 'parent' && pathParts[1]) return viewParent(decodeURIComponent(pathParts[1]));
  if (pathParts[0] === 'child' && pathParts[1]) return viewChild(pathParts[1]);
  if (pathParts[0] === 'clients') return viewClients();
  if (pathParts[0] === 'forms') return viewForms();
  if (pathParts[0] === 'implementations') return viewImplementations();
  if (pathParts[0] === 'onboarding') {
    if (!pathParts[1]) return viewOnboarding();
    if (pathParts[1] === 'new') return viewOnboardingNew();
    if (pathParts[1] === 'process' && pathParts[2]) return viewOnboardingProcess(pathParts[2]);
    return viewOnboardingDetail(pathParts[1]);
  }
  if (pathParts[0] === 'project' && pathParts[1]) return viewProject(pathParts[1]);
  if (pathParts[0] === 'admin' && pathParts[1] === 'stewards') return viewAdminStewards();
  if (pathParts[0] === 'admin' && pathParts[1] === 'companies') return viewAdminCompanies();
  if (pathParts[0] === 'admin' && pathParts[1] === 'assignments') return viewAdminAssignments();
  if (pathParts[0] === 'admin' && pathParts[1] === 'commissions') return viewAdminCommissions();
  if (pathParts[0] === 'admin' && pathParts[1] === 'jobs') return viewAdminJobs();
  if (pathParts[0] === 'parent-page') return viewParentPage();
  if (pathParts[0] === 'tickets') {
    if (pathParts[1] === 'new') return viewNewTicket();
    if (pathParts[1]) return viewTicketDetail(pathParts[1]);
    return viewTickets();
  }
  if (pathParts[0] === 'ar') { location.hash = '#/dashboard'; return; } // A/R retired 2026-10-13
  location.hash = '#/login';
}

api.init();
window.addEventListener('hashchange', route);
route();

})();
