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
    'payroll_enrolled', 'payroll_not_enrolled', 'payroll_new_qualified', 'payroll_dataset_date']
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
    '<div class="card-numbers">' + rollLine(o.total, o.eligible, o.enrolled, o.hasPayroll) + '</div>' +
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
// top_dog: everything except Jobs
// onboarding: Onboarding and Implementation only
// steward: Dashboard, Companies, Billing, Implementation, Tickets
// service: Tickets, Companies, Implementation (support desk)
// client: Tickets (own company only)
function navLinks() {
  var role = activeRole();
  var links = [];
  if (role === 'admin' || role === 'top_dog' || role === 'steward') {
    links.push(['#/dashboard', 'Dashboard']);
    links.push(['#/clients', 'Companies']);
    links.push(['#/billing', 'Billing']);
    links.push(['#/ar', 'A/R']);
  }
  if (role === 'service') {
    links.push(['#/clients', 'Companies']);
    links.push(['#/ar', 'A/R']);
  }
  links.push(['#/implementations', 'Implementation']);
  if (role === 'admin' || role === 'top_dog' || role === 'steward' || role === 'service' || role === 'client') {
    links.push(['#/tickets', 'Tickets']);
  }
  if (role === 'admin' || role === 'top_dog' || role === 'onboarding') {
    links.push(['#/onboarding', 'Onboarding']);
  }
  if (role === 'admin' || role === 'top_dog') {
    links.push(['#/forms', 'Forms']);
    links.push(['#/admin/stewards', 'Stewards']);
    links.push(['#/admin/companies', 'Companies']);
    links.push(['#/admin/assignments', 'Assignments']);
    links.push(['#/admin/commissions', 'Commissions']);
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
  window.scrollTo(0, 0);
}

function errorHtml(msg) {
  return msg ? '<div class="alert alert-error">' + esc(msg) + '</div>' : '';
}

function okHtml(msg) {
  return msg ? '<div class="alert alert-ok">' + esc(msg) + '</div>' : '';
}

function filterBar(searchVal, extra) {
  return '<div class="filterbar"><input id="fq" type="search" placeholder="Search..." value="' + esc(searchVal || '') + '">' +
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
        '<div class="card">' + (stageRows || '<p class="muted">No implementations on the kanban yet.</p>') + '</div>',
        '#/dashboard'));
    }).catch(function (err) { render(shell(errorHtml(err.message), '#/dashboard')); });
  });
}

// ---------------------------------------------------------------- billing
function viewBilling() {
  requireUser(function () {
    if (activeRole() === 'onboarding') { location.hash = '#/onboarding'; return; }
    var acctFilter = null;
    var statusFilter = '';
    function load() {
      api.get('/api/billing?status=open').then(function (openRows) {
        api.get('/api/billing?status=paid').then(function (paidRows) {
          var allRows = openRows.concat(paidRows);
          var codeMap = {};
          allRows.forEach(function (r) { codeMap[String(r.company_code)] = r.company_name; });
          var codes = Object.keys(codeMap).sort();
          if (acctFilter === null) acctFilter = codes.slice();
          function matches(r) {
            if (statusFilter) {
              var st = r.is_estimate ? 'estimated' : r.status;
              if (st !== statusFilter) return false;
            }
            if (acctFilter.indexOf(String(r.company_code)) === -1) return false;
            return true;
          }
          var rows = allRows.filter(matches);
          rows.sort(function (a, b) {
            var ad = a.payroll_date || '', bd = b.payroll_date || '';
            if (ad !== bd) return ad < bd ? 1 : -1;
            return String(a.company_code) < String(b.company_code) ? -1 : 1;
          });
          function cell(v) { return '<td>' + (v === null || v === undefined || v === '' ? '&mdash;' : esc(v)) + '</td>'; }
          function statusLabel(r) {
            if (r.is_estimate) return '<span class="badge">Estimated</span>';
            return r.status === 'paid' ? 'Paid' : 'Open';
          }
          var body = rows.map(function (r) {
            return '<tr><td><b>' + esc(r.company_code) + '</b></td>' +
              cell(r.company_name) +
              cell(r.ein) +
              cell(r.bill_mode) +
              cell(fmtDate(r.payroll_date)) +
              cell(fmtDate(r.payroll_end_date)) +
              cell(fmtDate(r.paid_date)) +
              cell(r.lives_count) +
              '<td><b>' + fmtMoney(r.total_invoice) + '</b></td>' +
              '<td>' + statusLabel(r) + '</td></tr>';
          }).join('');
          var boxes = codes.map(function (c) {
            var lbl = esc(c) + (codeMap[c] && codeMap[c] !== c ? ' — ' + esc(codeMap[c]) : '');
            return '<label style="display:block;white-space:nowrap;"><input type="checkbox" class="bacctbox" value="' + esc(c) + '"' +
              (acctFilter.indexOf(c) !== -1 ? ' checked' : '') + '> ' + lbl + '</label>';
          }).join('');
          render(shell(
            '<h2>Billing</h2><div id="msg"></div>' +
            '<h3>All Bills (' + rows.length + ')</h3>' +
            (rows.length === 0
              ? '<p class="muted">No bills match the filters.</p>'
              : '<div class="table-scroll" style="max-height:920px;overflow-y:auto;"><table class="data-table"><thead>' +
                '<tr><th>Company Code</th><th>Company Name</th><th>EIN</th><th>Pay Frequency</th>' +
                '<th>Payroll Begin Date</th><th>Payroll End Date</th><th>Check Date</th>' +
                '<th>Lives</th><th>Total $</th><th>Status</th></tr>' +
                '</thead><tbody>' + body + '</tbody></table></div>') +
            '<div class="card" style="margin-top:16px;"><div class="card-title">Filters</div>' +
            '<div class="form-inline" style="align-items:flex-start;">' +
            '<div><b>Accounts</b><br>' +
            '<div id="bacctboxes" style="max-height:180px;overflow-y:auto;border:1px solid var(--line);padding:6px 10px;min-width:220px;">' + boxes + '</div></div> ' +
            '<div><label>Status:<br><select id="bstatus">' +
            '<option value="">All statuses</option>' +
            '<option value="paid"' + (statusFilter === 'paid' ? ' selected' : '') + '>Paid</option>' +
            '<option value="open"' + (statusFilter === 'open' ? ' selected' : '') + '>Open</option>' +
            '<option value="estimated"' + (statusFilter === 'estimated' ? ' selected' : '') + '>Estimated</option>' +
            '</select></label></div> ' +
            '<div><br><button class="btn btn-small" id="bcodeclear">Reset filters</button></div>' +
            '</div></div>',
            '#/billing'));
          var boxEls = document.querySelectorAll('.bacctbox');
          Array.prototype.forEach.call(boxEls, function (cb) {
            cb.onchange = function () {
              acctFilter = Array.prototype.map.call(
                document.querySelectorAll('.bacctbox:checked'), function (x) { return x.value; });
              load();
            };
          });
          document.getElementById('bstatus').onchange = function () { statusFilter = this.value; load(); };
          document.getElementById('bcodeclear').onclick = function () { acctFilter = null; statusFilter = ''; load(); };
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
        '<div class="rollup"><b>Roll-up:</b> ' + rollLine(p.total, p.eligible, p.enrolled, p.has_payroll) + '</div>' +
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
  return '<table class="data-table"><tbody>' +
    row('Total employees', c.payroll_total) +
    row('Ineligible', c.payroll_ineligible) +
    row('Opted out', c.payroll_opted_out) +
    row('Eligible', elig()) +
    row('Enrolled', c.payroll_enrolled) +
    row('Not enrolled', c.payroll_not_enrolled) +
    row('New qualified', c.payroll_new_qualified) +
    '</tbody></table>' +
    (c.payroll_dataset_date ? '<p class="muted">Last payroll data: ' + fmtDate(c.payroll_dataset_date) + '</p>' : '');
}

// Child detail: payroll + stewards + implementation cards.
function viewChild(id) {
  requireUser(function () {
    api.get('/api/clients/' + id).then(function (d) {
      var c = d.company;
      var implCards = d.implementations.map(implCard).join('');
      var stewardList = d.stewards.map(function (s) { return esc(personName(s)); }).join(', ');
      var eeCode = c.ee_company_code || c.parent_company_code;
      var eeName = c.ee_company_name || c.parent_company_name || eeCode;
      var parentLink = (eeCode && eeCode !== c.company_code)
        ? '<p><a href="#/parent/' + esc(eeCode) + '">&larr; ' + esc(eeName) + '</a></p>'
        : '<p><a href="#/clients">&larr; Companies</a></p>';
      render(shell(parentLink +
        '<h2><span class="code-chip">' + esc(c.company_code) + '</span> ' + esc(c.company_name) + '</h2>' +
        '<h3>Last payroll</h3>' + payrollTable(c) +
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
        fs.onchange = function () { stage = fs.value; load(); };
      }).catch(function (err) { render(shell(errorHtml(err.message), '#/implementations')); });
    }
    load();
  });
}

// ---------------------------------------------------------------- 12-week plan timeline
function timelineHtml(t) {
  if (!t || !t.started) return '<p class="muted">The timeline clock starts the first time this project enters Initiation.</p>';
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
        ((i.ee_company_name || i.parent_company_name) ? '<p class="muted">' + esc(i.ee_company_name || i.parent_company_name) + '</p>' : '') +
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
    if (ar !== 'admin' && ar !== 'top_dog') { location.hash = '#/dashboard'; return; }
    api.get('/api/admin/stewards').then(function (list) {
      var rows = list.map(function (s) {
        var roles = (s.roles || []).map(roleLabel).join(', ');
        return '<tr><td><b>' + s.id + '</b></td><td>' + esc(s.first_name || '') + '</td><td>' + esc(s.last_name || '') + '</td>' +
          '<td>' + esc(s.email) + '</td><td>' + esc(s.phone || '') + '</td><td>' + esc(roles || s.role) + '</td></tr>';
      }).join('');
      render(shell(
        '<h2>Stewards</h2>' +
        '<p class="muted">Stewards are updated by CSV import only. To edit a steward, use the "Edit stewards" card on the Jobs page.</p>' +
        '<table class="data-table"><thead><tr><th>Steward ID</th><th>First name</th><th>Last name</th><th>Email</th><th>Phone</th><th>Roles</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>',
        '#/admin/stewards'));
    }).catch(function (err) { render(shell(errorHtml(err.message), '#/admin/stewards')); });
  });
}

// ---------------------------------------------------------------- admin: commissions (cards per company)
function viewAdminCommissions() {
  requireUser(function () {
    var ar = activeRole();
    if (ar !== 'admin' && ar !== 'top_dog') { location.hash = '#/dashboard'; return; }
    var q = '';
    function load() {
      api.get('/api/admin/commissions-by-company').then(function (list) {
        var ql = q.toLowerCase();
        var filtered = list.filter(function (c) {
          if (!ql) return true;
          if (String(c.company_code).toLowerCase().indexOf(ql) !== -1) return true;
          if (String(c.company_name || '').toLowerCase().indexOf(ql) !== -1) return true;
          for (var i = 0; i < c.stewards.length; i++) {
            if (String(c.stewards[i].name).toLowerCase().indexOf(ql) !== -1) return true;
          }
          return false;
        });
        var cards = filtered.map(function (c) {
          var lines = c.stewards.map(function (s) {
            return '<div class="card-line">' + esc(s.name) + ' <span class="muted">— ' + esc(s.pct) + '%</span></div>';
          }).join('');
          return '<div class="card">' +
            '<div class="card-code">' + esc(c.company_code) + '</div>' +
            '<div class="card-title">' + esc(c.company_name) + '</div>' +
            lines + '</div>';
        }).join('');
        var body = filtered.length === 0
          ? '<p class="muted">No commissions found.</p>'
          : '<div class="card-grid">' + cards + '</div>';
        render(shell(
          '<h2>Commissions</h2>' + filterBar(q, '') +
          '<div id="err"></div>' + body,
          '#/admin/commissions'));
        var fq = document.getElementById('fq');
        fq.onchange = function () { q = fq.value; load(); };
        fq.onkeydown = function (e) { if (e.key === 'Enter') { q = fq.value; load(); } };
        fq.oninput = function () { q = fq.value; load(); };
      }).catch(function (err) { render(shell(errorHtml(err.message), '#/admin/commissions')); });
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
    if (['admin', 'top_dog', 'service', 'steward', 'client'].indexOf(r) === -1) { location.hash = '#/dashboard'; return; }
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
    if (['admin', 'top_dog', 'service', 'steward', 'client'].indexOf(r) === -1) { location.hash = '#/dashboard'; return; }
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
    if (['admin', 'top_dog', 'service', 'steward', 'client'].indexOf(r) === -1) { location.hash = '#/dashboard'; return; }
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

// ---------------------------------------------------------------- admin: companies (import only, with parent columns)
function viewAdminCompanies() {
  requireUser(function () {
    var ar = activeRole();
    if (ar !== 'admin' && ar !== 'top_dog') { location.hash = '#/dashboard'; return; }
    api.get('/api/admin/companies').then(function (list) {
      function cell(v) { return '<td>' + (v === null || v === undefined || v === '' ? '&mdash;' : esc(v)) + '</td>'; }
      function parentCode(c) { return c.ee_company_code || c.parent_company_code; }
      function parentName(c) { return c.ee_company_name || c.parent_company_name; }
      var rows = list.map(function (c) {
        var isActive = c.active !== false;
        var act = isActive ? 'Yes' : '<b>No</b>';
        return '<tr data-active="' + (isActive ? '1' : '0') + '">' + cell(parentCode(c)) + cell(parentName(c)) +
          '<td><b>' + esc(c.company_code) + '</b></td><td>' + esc(c.company_name) + '</td>' +
          '<td>' + act + '</td>' +
          cell(c.payroll_ineligible) + cell(c.payroll_enrolled) +
          '<td>' + (c.open_invoice_count || 0) + '</td><td><b>' + fmtMoney(c.open_invoice_total || 0) + '</b></td></tr>';
      }).join('');
      render(shell(
        '<h2>Companies</h2>' +
        '<p class="muted">Companies are updated by CSV import only. ' +
        'Show: <label><input type="radio" name="cfilter" value="active" checked> Active</label> ' +
        '<label><input type="radio" name="cfilter" value="termed"> Termed</label> ' +
        '<label><input type="radio" name="cfilter" value="all"> All</label></p>' +
        '<div class="table-scroll"><table class="data-table"><thead>' +
        '<tr><th>Parent Code</th><th>Parent Name</th><th>Company Code</th><th>Company Name</th><th>Active</th>' +
        '<th colspan="2">Last Payroll</th><th colspan="2">Invoices outstanding</th></tr>' +
        '<tr><th></th><th></th><th></th><th></th><th></th>' +
        '<th>Ineligible</th><th>Enrolled</th><th>Invoices</th><th>Total amount</th></tr></thead>' +
        '<tbody id="companyrows">' + rows + '</tbody></table></div>',
        '#/admin/companies'));
      function applyCompanyFilter() {
        var v = document.querySelector('input[name="cfilter"]:checked').value;
        document.querySelectorAll('#companyrows tr').forEach(function (tr) {
          var a = tr.getAttribute('data-active') === '1';
          tr.style.display = (v === 'all' || (v === 'active') === a) ? '' : 'none';
        });
      }
      document.querySelectorAll('input[name="cfilter"]').forEach(function (r) {
        r.onchange = applyCompanyFilter;
      });
      applyCompanyFilter();
    }).catch(function (err) { render(shell(errorHtml(err.message), '#/admin/companies')); });
  });
}

// ---------------------------------------------------------------- admin: assignments (import only)
function viewAdminAssignments() {
  requireUser(function () {
    var ar = activeRole();
    if (ar !== 'admin' && ar !== 'top_dog') { location.hash = '#/dashboard'; return; }
    api.get('/api/admin/assignments').then(function (list) {
      api.get('/api/admin/stewards').then(function (stewards) {
        var rows = list.map(function (a) {
          return '<tr data-sid="' + a.steward_id + '"><td><b>' + a.steward_id + '</b><div class="muted">' + esc(a.steward_email || '') + '</div></td>' +
            '<td><b>' + esc(a.company_code) + '</b></td></tr>';
        }).join('');
        var opts = stewards.map(function (s) {
          var label = s.id + ' — ' + esc(s.email || '');
          return '<label style="display:block;white-space:nowrap;">' +
            '<input type="checkbox" class="sidpick" value="' + s.id + '" checked> ' + label + '</label>';
        }).join('');
        render(shell(
          '<h2>Assignments</h2>' +
          '<p class="muted">Assignments are updated by CSV import only.</p>' +
          '<h3>All Assignments (' + list.length + ')</h3>' +
          '<div class="table-scroll" style="max-height:920px;overflow-y:auto;"><table class="data-table"><thead><tr><th>Steward ID</th><th>Company Code</th></tr></thead>' +
          '<tbody id="assignrows">' + rows + '</tbody></table></div>' +
          '<div class="card" style="margin-top:16px;"><div class="card-title">Filters</div>' +
          '<div class="form-inline" style="align-items:flex-start;">' +
          '<div><b>Stewards</b><br>' +
          '<div style="max-height:180px;overflow-y:auto;border:1px solid var(--line);padding:6px 10px;min-width:220px;">' + opts + '</div></div> ' +
          '<div><br><button class="btn btn-small" id="sidall">All</button> <button class="btn btn-small" id="sidnone">None</button></div>' +
          '</div></div>',
          '#/admin/assignments'));
        function applySidFilter() {
          var sel = {};
          document.querySelectorAll('.sidpick:checked').forEach(function (c) { sel[c.value] = true; });
          document.querySelectorAll('#assignrows tr').forEach(function (tr) {
            tr.style.display = sel[tr.getAttribute('data-sid')] ? '' : 'none';
          });
        }
        document.querySelectorAll('.sidpick').forEach(function (c) { c.onchange = applySidFilter; });
        document.getElementById('sidall').onclick = function () {
          document.querySelectorAll('.sidpick').forEach(function (c) { c.checked = true; });
          applySidFilter();
        };
        document.getElementById('sidnone').onclick = function () {
          document.querySelectorAll('.sidpick').forEach(function (c) { c.checked = false; });
          applySidFilter();
        };
      }).catch(function (err) { render(shell(errorHtml(err.message), '#/admin/assignments')); });
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
  companies: 'parent_code, parent_name, company_code, company_name, active (optional: Yes/No; blank leaves the current flag unchanged). Headers are case-insensitive.',
  assignments: 'steward_id, company_code',
  billing: 'company_code (required), company_name, ein, payroll_date (YYYY-MM-DD), payroll_end_date (YYYY-MM-DD), lives_count, total_invoice, status (open or paid), paid_date (YYYY-MM-DD), bill_type (F or S), bill_mode',
  commissions: 'One line per steward OR one line per company (auto-detected): steward_id then repeating company_code,pct pairs - or company_code then repeating steward_id,pct pairs (e.g. 1001,155026,37.5,153909,25). Percentages for each company must add up to 100. The file replaces the commission table for every company code it mentions.'
};

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
      '<hr><p class="muted"><b>Unpaid estimates.</b> Projects unpaid F bills from each account\u2019s last paid bill and payroll frequency. Estimates appear on the Billing tab as pending bills marked \u201cest\u201d. Re-running never duplicates; importing a newer report replaces estimates with the real paid bills.</p>' +
      '<label>Only accounts paid within the last <input id="ftjestdays" type="number" value="90" min="1" max="3650" style="width: 70px;"> days</label> ' +
      '<button class="btn btn-primary" id="ftjest">Preview estimates</button> ' +
      '<button class="btn btn-small" id="ftjestclear">Delete all estimates</button><div id="ftjestout"></div></div>' +
      '<div class="card"><div class="card-title">Soluta billing (S): Soluta report</div>' +
      '<p class="muted">Upload the Soluta iM4H Invoice Report spreadsheet. It contains both paid and pending S bills \u2014 no estimating. Preview the bills first, then import to add new, update changed, and delete S bills missing from the report.</p>' +
      '<input type="file" id="solfile" accept=".xlsx,.xls,.csv"> ' +
      '<button class="btn btn-primary" id="solpreview">Upload &amp; preview</button> ' +
      '<button class="btn btn-small" id="soldltemplate">Download template</button> ' +
      '<button class="btn btn-small" id="soldelexport">Export current S bills</button><div id="solout"></div></div>' +
      '</div>' +
      '<h3>Imports</h3>' +
      '<p class="muted">Paste CSV (first row = headers), validate, then confirm. This is the only way Stewards, Companies, Assignments, Billing, and Commissions are updated. Use "Download current" to get a CSV of what is on file now.</p>' +
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
            (d.skipped_companies && d.skipped_companies.length
              ? '<p class="muted">Skipped ' + d.skipped_companies.length + ' companies not on the company list: ' + d.skipped_companies.map(esc).join(', ') + '</p>'
              : '') +
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
              (d.skipped_companies && d.skipped_companies.length
                ? '<p class="muted">Skipped ' + d.skipped_companies.length + ' companies not on the company list: ' + d.skipped_companies.map(esc).join(', ') + '</p>'
                : '') +
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
            '<button class="btn btn-link" data-fdl="' + f.id + '" data-fn="' + esc(f.file_name) + '">Download</button>' +
            (isAdmin ? ' <button class="btn btn-danger" data-fdel="' + f.id + '">Delete</button>' : '') + '</div>';
        }).join('') : '<p class="muted">No blank forms stored yet.</p>';
        var up = isAdmin ?
          '<div class="card"><h4>Upload a blank form</h4>' +
          '<p class="muted">Stored as-is. Uploading a form with an existing name replaces it. The Soluta generator looks for a form named exactly "Soluta Billing Intake Form".</p>' +
          '<p><label>Form name: <input id="formname" value="Soluta Billing Intake Form" style="width: 280px;"></label></p>' +
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
      function card(c) {
        var badge = c.critical_open > 0
          ? '<span class="rag rag-red">' + c.critical_open + ' critical</span>'
          : '<span class="rag rag-green">Checked</span>';
        return '<div class="ob-card"><div class="ob-card-head"><b>' + esc(c.client_name) + '</b>' + badge + '</div>' +
          '<div class="muted">' + c.doc_count + ' document(s) &middot; started ' + fmtDate(c.created_at) +
          (c.github_issue_number ? ' &middot; GitHub #' + c.github_issue_number : '') + '</div>' +
          '<p><a class="btn btn-primary" href="#/onboarding/' + c.id + '">Open</a></p></div>';
      }
      render(shell(
        '<h2>Onboarding</h2><div id="err"></div>' +
        '<p><a class="btn btn-primary" href="#/onboarding/new">+ Add client</a></p>' +
        '<h3>In Progress (' + prog.length + ')</h3>' +
        (prog.length ? '<div class="ob-grid">' + prog.map(card).join('') + '</div>' : '<p class="muted">No clients being onboarded right now.</p>') +
        '<h3>Complete (' + done.length + ')</h3>' +
        (done.length ? '<div class="ob-grid">' + done.map(card).join('') + '</div>' : '<p class="muted">Nothing completed yet.</p>'),
        '#/onboarding'));
    }).catch(function (err) { render(shell(errorHtml(err.message), '#/onboarding')); });
  });
}

function viewOnboardingNew() {
  requireUser(function () {
    if (!canOnboard()) { location.hash = '#/dashboard'; return; }
    var masterFile = null;
    render(shell(
      '<p><a href="#/onboarding">&larr; Onboarding</a></p>' +
      '<h2>Add client</h2><div id="err"></div>' +
      '<div class="card"><h3>Step 1: Upload the Master Application</h3>' +
      '<p class="muted">Upload the signed Master Application PDF. We will read the Applicant/Policy Holder name from the POLICYHOLDER INFORMATION page.</p>' +
      '<p><input type="file" id="obmaster" accept=".pdf"></p><div id="obparse"></div></div>' +
      '<div class="card" id="obconfirm" style="display:none"><h3>Step 2: Confirm the client name</h3>' +
      '<p><label>Client name<br><input type="text" id="obname" style="width:100%;max-width:420px"></label></p>' +
      '<p><button class="btn btn-primary" id="obcreate">Lock in and create client</button></p><div id="obcerr"></div></div>',
      '#/onboarding'));
    document.getElementById('obmaster').onchange = function (e) {
      var f = e.target.files[0];
      if (!f) return;
      masterFile = f;
      document.getElementById('obparse').innerHTML = '<p class="muted">Reading the application...</p>';
      var fd = new FormData();
      fd.append('file', f);
      uploadFile('/api/onboarding/parse-master', fd).then(function (d) {
        var box = document.getElementById('obconfirm');
        box.style.display = 'block';
        document.getElementById('obname').value = d.suggestedName || '';
        document.getElementById('obparse').innerHTML = d.suggestedName
          ? '<p>Found client name' + (d.page ? ' on page ' + d.page : '') + ': <b>' + esc(d.suggestedName) + '</b>. Confirm or correct it below.</p>'
          : '<p class="rag rag-yellow">Could not find the applicant name automatically. Type it below.</p>';
      }).catch(function (err) {
        document.getElementById('obparse').innerHTML = errorHtml(err.message);
      });
    };
    document.getElementById('obcreate').onclick = function () {
      var name = document.getElementById('obname').value.trim();
      if (!name) { document.getElementById('obcerr').innerHTML = errorHtml('Client name is required.'); return; }
      if (!masterFile) { document.getElementById('obcerr').innerHTML = errorHtml('Upload the Master Application first.'); return; }
      var fd = new FormData();
      fd.append('clientName', name);
      fd.append('masterApp', masterFile);
      document.getElementById('obcerr').innerHTML = '<p class="muted">Creating...</p>';
      uploadFile('/api/onboarding', fd).then(function (c) {
        location.hash = '#/onboarding/' + c.id;
      }).catch(function (err) {
        document.getElementById('obcerr').innerHTML = errorHtml(err.message);
      });
    };
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
    return viewOnboardingDetail(pathParts[1]);
  }
  if (pathParts[0] === 'project' && pathParts[1]) return viewProject(pathParts[1]);
  if (pathParts[0] === 'admin' && pathParts[1] === 'stewards') return viewAdminStewards();
  if (pathParts[0] === 'admin' && pathParts[1] === 'companies') return viewAdminCompanies();
  if (pathParts[0] === 'admin' && pathParts[1] === 'assignments') return viewAdminAssignments();
  if (pathParts[0] === 'admin' && pathParts[1] === 'commissions') return viewAdminCommissions();
  if (pathParts[0] === 'admin' && pathParts[1] === 'jobs') return viewAdminJobs();
  if (pathParts[0] === 'tickets') {
    if (pathParts[1] === 'new') return viewNewTicket();
    if (pathParts[1]) return viewTicketDetail(pathParts[1]);
    return viewTickets();
  }
  if (pathParts[0] === 'ar') return viewAR();
  location.hash = '#/login';
}

api.init();
window.addEventListener('hashchange', route);
route();

})();
