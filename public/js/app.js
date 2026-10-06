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
  return 'Steward';
}

function hasRole(r) {
  var u = state.user;
  return !!u && ((u.roles || []).indexOf(r) !== -1);
}
function canOnboard() { return hasRole('onboarding') || hasRole('admin'); }

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

function rollLine(total, eligible, enrolled) {
  var parts = [];
  if (total !== null && total !== undefined) parts.push('<span><b>' + total + '</b> total</span>');
  if (eligible !== null && eligible !== undefined) parts.push('<span><b>' + eligible + '</b> eligible</span>');
  if (enrolled !== null && enrolled !== undefined) parts.push('<span><b>' + enrolled + '</b> enrolled</span>');
  if (parts.length === 0) return '<span class="muted">No payroll data yet</span>';
  return parts.join(' ');
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
  delete: function (url) { return this.call('DELETE', url); }
};

var state = { user: null };

// ---------------------------------------------------------------- header (same on every page)
function logoHtml(size) {
  size = size || 34;
  var w = Math.round(size * 1.31);
  return '<img src="logo.webp" class="brand-logo" width="' + w + '" height="' + size + '" alt="iM4 Health">';
}

function activeRole() {
  var u = state.user;
  return u ? (u.activeRole || u.role || '') : '';
}

// Screens per role:
// steward: Dashboard, Companies, Billing, Implementation (assigned accounts only)
// onboarding: Companies, Implementation, Onboarding (all clients)
// top_dog: Dashboard, Companies, Billing, Implementation (all accounts)
// admin: everything
function navLinks() {
  var u = state.user;
  var role = activeRole();
  var links;
  if (role === 'onboarding') {
    links = [
      ['#/clients', 'Companies'],
      ['#/implementations', 'Implementation'],
      ['#/onboarding', 'Onboarding']
    ];
  } else {
    links = [
      ['#/dashboard', 'Dashboard'],
      ['#/clients', 'Companies'],
      ['#/billing', 'Billing'],
      ['#/implementations', 'Implementation']
    ];
    if (role === 'admin') links.push(['#/onboarding', 'Onboarding']);
  }
  if (role === 'admin' || role === 'top_dog' || role === 'onboarding') {
    links.push(['#/forms', 'Forms']);
  }
  if (role === 'admin') {
    links.push(['#/admin/jobs', 'Jobs']);
    links.push(['#/admin/stewards', 'Stewards']);
    links.push(['#/admin/companies', 'Companies']);
    links.push(['#/admin/assignments', 'Assignments']);
    links.push(['#/admin/import', 'Import']);
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
  return '<header class="topbar">' + menu +
    '<a class="brand" href="#" id="brandlink">' + logoHtml(34) + '<span class="brand-text">Management System</span></a>' +
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
    var codeFilter = '';
    function load() {
      api.get('/api/billing?status=open').then(function (openRows) {
        api.get('/api/billing?status=paid').then(function (paidRows) {
          function matches(r) {
            if (!codeFilter) return true;
            return String(r.company_code || '').toLowerCase().indexOf(codeFilter.toLowerCase()) !== -1;
          }
          var openF = openRows.filter(matches);
          var paidF = paidRows.filter(matches);
          function cell(v) { return '<td>' + (v === null || v === undefined || v === '' ? '&mdash;' : esc(v)) + '</td>'; }
          function panel(title, rows, showPaid) {
            var head = '<tr><th>Company Code</th><th>Company Name</th><th>Payroll Date</th><th>Lives</th><th>Total Invoice</th>' +
              (showPaid ? '<th>Day Paid</th>' : '') + '</tr>';
            var body = rows.map(function (r) {
              return '<tr><td><b>' + esc(r.company_code) + '</b></td>' +
                cell(r.company_name) + cell(fmtDate(r.payroll_date)) + cell(r.lives_count) +
                '<td><b>' + fmtMoney(r.total_invoice) + '</b></td>' +
                (showPaid ? cell(fmtDate(r.paid_date)) : '') + '</tr>';
            }).join('');
            return '<div class="billing-panel"><h3>' + title + ' (' + rows.length + ')</h3>' +
              (rows.length === 0
                ? '<p class="muted">' + (showPaid ? 'No paid invoices yet.' : 'No open bills.') + '</p>'
                : '<div class="table-scroll billing-scroll"><table class="data-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>') +
              '</div>';
          }
          render(shell(
            '<h2>Billing</h2><div id="msg"></div>' +
            '<div class="form-inline"><label>Filter by company code: <input id="bcode" placeholder="e.g. 9001" value="' + esc(codeFilter) + '"></label> ' +
            '<button class="btn btn-small" id="bcodeclear">Clear</button></div>' +
            '<div class="billing-panels">' +
            panel('Open Invoices', openF, false) +
            panel('Paid Invoices', paidF, true) +
            '</div>',
            '#/billing'));
          var bi = document.getElementById('bcode');
          bi.oninput = function () { codeFilter = bi.value; load(); };
          document.getElementById('bcodeclear').onclick = function () { codeFilter = ''; load(); };
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
    var q = '';
    function load() {
      var url = '/api/clients' + (q ? '?q=' + encodeURIComponent(q) : '');
      api.get(url).then(function (groups) {
        var cards = groups.map(function (g) {
          var sub = g.children.length > 1 ? g.children.length + ' companies' : '1 company';
          var invLine = '';
          if (g.open_invoices > 0) {
            invLine = '<div class="card-invoices"><b>' + g.open_invoices + '</b> open invoice' +
              (g.open_invoices === 1 ? '' : 's') + ' &mdash; <b>' + fmtMoney(g.open_total) + '</b></div>';
          } else {
            invLine = '<div class="muted">No open invoices</div>';
          }
          return '<a class="card" href="#/parent/' + esc(g.code) + '">' +
            '<div class="card-code">' + esc(g.code) + '</div>' +
            '<div class="card-title">' + esc(g.name) + '</div>' +
            '<div class="card-numbers">' + rollLine(g.total, g.eligible, g.enrolled) + '</div>' +
            invLine +
            '<div class="muted">' + sub + '</div></a>';
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

// The status shown on tiles and the project view is the summary's RAG judgment
// (RED/YELLOW/GREEN); the GitHub Priority badge is only a fallback when no
// summary exists yet.
function statusHtml(i) {
  var rag = parseRag(i.latest_summary);
  if (rag) return ragBadge(i.latest_summary);
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
  return '<a class="card" href="#/project/' + i.id + '">' +
    '<div class="card-code">' + esc(i.company_code) + '</div>' +
    '<div class="card-title">' + esc(i.company_name) + '</div>' +
    miniPipeline(i.stage) +
    '<div class="card-meta"><b>' + esc(i.stage || '') + '</b> ' + statusHtml(i) +
    (i.days_in_stage !== null && i.days_in_stage !== undefined ? ' <span class="muted">&middot; ' + i.days_in_stage + ' days in stage</span>' : '') + '</div>' +
    (i.latest_summary ? '<div class="card-summary">' + esc(i.latest_summary.slice(0, 140)) + '&hellip;</div>' : '') +
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
        return '<a class="card" href="#/child/' + c.id + '">' +
          '<div class="card-code">' + esc(c.company_code) + '</div>' +
          '<div class="card-title">' + esc(c.company_name) + '</div>' +
          '<div class="card-numbers">' + rollLine(c.payroll_total, elig, c.payroll_enrolled) + '</div></a>';
      }).join('');
      var stewardList = d.stewards.map(function (s) { return esc(personName(s)); }).join(', ');
      var implCards = d.implementations.map(implCard).join('');
      render(shell(
        '<p><a href="#/clients">&larr; Companies</a></p>' +
        '<h2><span class="code-chip">' + esc(p.code) + '</span> ' + esc(p.name) + '</h2>' +
        '<div class="rollup"><b>Roll-up:</b> ' + rollLine(p.total, p.eligible, p.enrolled) + '</div>' +
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

// ---------------------------------------------------------------- 14-week timeline
function timelineHtml(t) {
  if (!t || !t.started) return '<p class="muted">The timeline clock starts the first time this project enters Initiation.</p>';
  var head = '<div class="tl-head"><b>Week ' + t.weekElapsed + ' of 14</b> &middot; started ' + fmtDate(t.startDate) +
    ' &middot; expected go-live ' + fmtDate(t.goLiveDate) +
    ' &middot; expected stage now: <b>' + esc(t.expectedStage) + '</b>' +
    (t.daysBehind > 0
      ? ' &middot; <span class="rag rag-red">' + t.daysBehind + ' days behind plan</span>'
      : ' &middot; <span class="rag rag-green">On pace</span>') + '</div>';
  var blocks = t.blocks.map(function (b) {
    var cls = 'tl-block' + (b.current ? ' tl-current' : '') + (b.done ? ' tl-done' : '');
    return '<div class="' + cls + '">' +
      '<div class="tl-title">Weeks ' + b.startWeek + '-' + b.endWeek + ': ' + esc(b.block) +
      ' <span class="muted">(' + esc(b.stage) + ' &middot; ' + fmtDate(b.startDate) + ' &ndash; ' + fmtDate(b.endDate) + ')</span></div>' +
      '<ul class="tl-duties">' + b.duties.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul></div>';
  }).join('');
  return head + '<div class="timeline">' + blocks + '</div>';
}

// ---------------------------------------------------------------- project view: lifecycle visual + summary | messages
function lifecycleVisual(current, daysInStage, stageEnteredAt) {
  var idx = STAGES.indexOf(current);
  var html = '<div class="lifecycle">';
  STAGES.forEach(function (s, i) {
    var cls = 'lc-step';
    if (i < idx) cls += ' done';
    if (i === idx) cls += ' current';
    var daysLabel = '';
    if (i === idx) {
      if (stageEnteredAt) {
        var enteredMs = new Date(stageEnteredAt).getTime();
        var trueDays = isNaN(enteredMs) ? null : Math.max(0, Math.floor((Date.now() - enteredMs) / 86400000));
        daysLabel = '<div class="lc-days">in stage since ' + fmtDate(stageEnteredAt) +
          (trueDays === null ? '' : ' (' + trueDays + ' days)') + '</div>';
      } else if (daysInStage !== null && daysInStage !== undefined) {
        daysLabel = '<div class="lc-days">' + daysInStage + ' days in stage</div>';
      }
    }
    html += '<div class="' + cls + '">' +
      '<div class="lc-node">' + (i < idx ? '&#10003;' : (i + 1)) + '</div>' +
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

function summaryHtml(s) {
  if (!s) return '<p class="muted">No summaries yet. Summaries are generated nightly.</p>';
  var body = stripStatusLine(esc(s.body));
  return '<div class="summary">' + ragBadge(s.body) +
    '<div class="muted">Summary &middot; ' + fmtDate(s.summary_date) + '</div>' +
    '<div class="summary-body">' + body + '</div></div>';
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
      var latest = d.summaries.length > 0 ? d.summaries[0] : null;
      var older = d.summaries.slice(1).map(function (s) {
        return '<div class="summary summary-old">' + ragBadge(s.body) +
          '<div class="muted">Summary &middot; ' + fmtDate(s.summary_date) + '</div>' +
          '<div class="summary-body">' + stripStatusLine(esc(s.body)) + '</div></div>';
      }).join('');
      render(shell(
        '<p><a href="#/implementations">&larr; Implementation</a></p>' +
        '<h2><span class="code-chip">' + esc(i.company_code) + '</span> ' + esc(i.company_name) + '</h2>' +
        ((i.ee_company_name || i.parent_company_name) ? '<p class="muted">' + esc(i.ee_company_name || i.parent_company_name) + '</p>' : '') +
        '<div class="proj-grid"><div>' +
        '<h3>Project lifecycle</h3>' + lifecycleVisual(i.stage, i.days_in_stage, i.stage_entered_at) +
        '<h3>14-week timeline</h3>' + timelineHtml(d.timeline) +
        '<p>' + statusHtml(i) + '</p>' +
        (i.card_title ? '<p class="muted">' + esc(i.card_title) + '</p>' : '') +
        '<h3>Project summary</h3>' + summaryHtml(latest) + older +
        '</div><div>' +
        '<h3>Messages <span class="muted">(' + d.messages.length + ')</span></h3>' +
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
    if (state.user.role !== 'admin') { location.hash = '#/dashboard'; return; }
    api.get('/api/admin/stewards').then(function (list) {
      var rows = list.map(function (s) {
        var roles = (s.roles || []).map(roleLabel).join(', ');
        return '<tr><td><b>' + s.id + '</b></td><td>' + esc(s.first_name || '') + '</td><td>' + esc(s.last_name || '') + '</td>' +
          '<td>' + esc(s.email) + '</td><td>' + esc(s.phone || '') + '</td><td>' + esc(roles || s.role) + '</td>' +
          '<td class="row-actions"><button class="btn btn-small" data-edit="' + s.id + '">Edit</button> ' +
          '<button class="btn btn-small" data-pw="' + s.id + '">Set password</button> ' +
          '<button class="btn btn-small" data-roles="' + s.id + '">Set roles</button> ' +
          '<button class="btn btn-small btn-danger" data-del="' + s.id + '">Delete</button></td></tr>';
      }).join('');
      render(shell(
        '<h2>Stewards</h2><div id="msg"></div>' +
        '<p class="muted">Stewards are updated by CSV import only. ' +
        'Use "Edit" to change name, email, or phone. "Set password" gives a steward their login password, "Set roles" grants Steward, Top Dog, or Admin.</p>' +
        '<table class="data-table"><thead><tr><th>Steward ID</th><th>First name</th><th>Last name</th><th>Email</th><th>Phone</th><th>Roles</th><th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table><div id="editbox"></div><div id="pwbox"></div><div id="rolebox"></div>',
        '#/admin/stewards'));
      var ebtns = document.querySelectorAll('[data-edit]');
      for (var e = 0; e < ebtns.length; e++) {
        (function (b) {
          b.onclick = function () {
            var id = b.getAttribute('data-edit');
            var cur = null;
            for (var k = 0; k < list.length; k++) {
              if (String(list[k].id) === String(id)) cur = list[k];
            }
            document.getElementById('editbox').innerHTML =
              '<h3>Edit steward</h3><form id="editf">' +
              '<label>First name <input id="edit-fn" value="' + esc(cur.first_name || '') + '"></label> ' +
              '<label>Last name <input id="edit-ln" value="' + esc(cur.last_name || '') + '"></label><br>' +
              '<label>Email <input id="edit-em" type="email" value="' + esc(cur.email || '') + '" required></label> ' +
              '<label>Phone <input id="edit-ph" value="' + esc(cur.phone || '') + '"></label> ' +
              '<button class="btn btn-primary" type="submit">Save</button></form><div id="editmsg"></div>';
            document.getElementById('editf').onsubmit = function (ev) {
              ev.preventDefault();
              api.put('/api/admin/stewards/' + id, {
                first_name: document.getElementById('edit-fn').value,
                last_name: document.getElementById('edit-ln').value,
                email: document.getElementById('edit-em').value,
                phone: document.getElementById('edit-ph').value
              }).then(function () {
                document.getElementById('editmsg').innerHTML = okHtml('Steward updated.');
                viewAdminStewards();
              }).catch(function (err) {
                document.getElementById('editmsg').innerHTML = errorHtml(err.message);
              });
            };
          };
        })(ebtns[e]);
      }
      var dbtns = document.querySelectorAll('[data-del]');
      for (var d = 0; d < dbtns.length; d++) {
        (function (b) {
          b.onclick = function () {
            var id = b.getAttribute('data-del');
            if (!confirm('Delete this steward? Their assignments will be removed. This cannot be undone.')) return;
            api.delete('/api/admin/stewards/' + id).then(function () {
              viewAdminStewards();
            }).catch(function (err) {
              document.getElementById('msg').innerHTML = errorHtml(err.message);
            });
          };
        })(dbtns[d]);
      }
      var btns = document.querySelectorAll('[data-pw]');
      for (var i = 0; i < btns.length; i++) {
        (function (b) {
          b.onclick = function () {
            var id = b.getAttribute('data-pw');
            document.getElementById('pwbox').innerHTML =
              '<h3>Set password</h3><form id="pwf" class="form-inline">' +
              '<input id="pw-in" type="password" placeholder="New password (8+ chars)" required minlength="8"> ' +
              '<button class="btn btn-primary" type="submit">Save</button></form><div id="pwmsg"></div>';
            document.getElementById('pwf').onsubmit = function (e) {
              e.preventDefault();
              api.post('/api/admin/stewards/' + id + '/password', { password: document.getElementById('pw-in').value })
                .then(function () { document.getElementById('pwmsg').innerHTML = okHtml('Password updated.'); })
                .catch(function (err) { document.getElementById('pwmsg').innerHTML = errorHtml(err.message); });
            };
          };
        })(btns[i]);
      }
      var rbtns = document.querySelectorAll('[data-roles]');
      for (var j = 0; j < rbtns.length; j++) {
        (function (b) {
          b.onclick = function () {
            var id = b.getAttribute('data-roles');
            var cur = null;
            for (var k = 0; k < list.length; k++) {
              if (String(list[k].id) === String(id)) cur = list[k].roles || [];
            }
            function chk(v) { return '<label><input type="checkbox" class="rolechk" value="' + v + '"' + (cur.indexOf(v) !== -1 ? ' checked' : '') + '> ' + roleLabel(v) + '</label>'; }
            document.getElementById('rolebox').innerHTML =
              '<h3>Set roles</h3><form id="rolef" class="form-inline">' +
              chk('steward') + ' ' + chk('top_dog') + ' ' + chk('onboarding') + ' ' + chk('admin') + ' ' +
              '<button class="btn btn-primary" type="submit">Save roles</button></form><div id="rolemsg"></div>';
            document.getElementById('rolef').onsubmit = function (e) {
              e.preventDefault();
              var boxes = document.querySelectorAll('.rolechk');
              var picked = [];
              for (var m = 0; m < boxes.length; m++) {
                if (boxes[m].checked) picked.push(boxes[m].value);
              }
              if (picked.length === 0) {
                document.getElementById('rolemsg').innerHTML = errorHtml('Pick at least one role.');
                return;
              }
              api.post('/api/admin/set-roles', { steward_id: parseInt(id, 10), roles: picked }).then(function () {
                document.getElementById('rolemsg').innerHTML = okHtml('Roles updated.');
                viewAdminStewards();
              }).catch(function (err) {
                document.getElementById('rolemsg').innerHTML = errorHtml(err.message);
              });
            };
          };
        })(rbtns[j]);
      }
    }).catch(function (err) { render(shell(errorHtml(err.message), '#/admin/stewards')); });
  });
}

// ---------------------------------------------------------------- admin: companies (import only, with parent columns)
function viewAdminCompanies() {
  requireUser(function () {
    if (state.user.role !== 'admin') { location.hash = '#/dashboard'; return; }
    api.get('/api/admin/companies').then(function (list) {
      function cell(v) { return '<td>' + (v === null || v === undefined || v === '' ? '&mdash;' : esc(v)) + '</td>'; }
      function eeCode(c) { return c.ee_company_code || c.parent_company_code; }
      function eeName(c) { return c.ee_company_name || c.parent_company_name; }
      var rows = list.map(function (c) {
        var elig = (c.payroll_qualified !== null && c.payroll_qualified !== undefined) ? c.payroll_qualified
          : (c.payroll_total !== null && c.payroll_total !== undefined ? (c.payroll_total || 0) - (c.payroll_ineligible || 0) - (c.payroll_opted_out || 0) : null);
        return '<tr><td><b>' + esc(c.company_code) + '</b></td><td>' + esc(c.company_name) + '</td>' +
          cell(eeCode(c)) + cell(eeName(c)) +
          cell(c.payroll_total) + cell(c.payroll_ineligible) + cell(c.payroll_opted_out) +
          cell(elig) + cell(c.payroll_new_qualified) + cell(c.payroll_enrolled) + cell(c.payroll_not_enrolled) + '</tr>';
      }).join('');
      render(shell(
        '<h2>Companies</h2>' +
        '<p class="muted">Companies are updated by CSV import only.</p>' +
        '<div class="table-scroll"><table class="data-table"><thead>' +
        '<tr><th>Company Code</th><th>Company Name</th><th>EE Code</th><th>EE Name</th>' +
        '<th colspan="7">Last Payroll</th></tr><tr><th></th><th></th><th></th><th></th>' +
        '<th>Total Employees</th><th>Ineligible</th><th>Opt Out</th><th>Eligible</th><th>New Qualified</th><th>Enrolled</th><th>Not Enrolled</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>',
        '#/admin/companies'));
    }).catch(function (err) { render(shell(errorHtml(err.message), '#/admin/companies')); });
  });
}

// ---------------------------------------------------------------- admin: assignments (import only)
function viewAdminAssignments() {
  requireUser(function () {
    if (state.user.role !== 'admin') { location.hash = '#/dashboard'; return; }
    api.get('/api/admin/assignments').then(function (list) {
      var rows = list.map(function (a) {
        return '<tr><td><b>' + a.steward_id + '</b><div class="muted">' + esc(a.steward_email || '') + '</div></td>' +
          '<td><b>' + esc(a.company_code) + '</b></td></tr>';
      }).join('');
      render(shell(
        '<h2>Assignments</h2>' +
        '<p class="muted">Assignments are updated by CSV import only.</p>' +
        '<table class="data-table"><thead><tr><th>Steward ID</th><th>Company Code</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>',
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
  companies: 'company_code, company_name, ee_company_code, ee_company_name, payroll_total (or ee_total), payroll_ineligible (or ee_ineligible), payroll_opted_out (or ee_optedout), payroll_qualified (or ee_qualified), payroll_enrolled (or ee_enrolled), payroll_not_enrolled (or ee_not_enrolled), payroll_new_qualified (or ee_new_qualified), payroll_dataset_date (or ee_dataset_date, YYYY-MM-DD). Headers are case-insensitive.',
  assignments: 'steward_id, company_code',
  billing: 'company_code, company_name, payroll_date (YYYY-MM-DD), lives_count, total_invoice, status (open or paid), paid_date (YYYY-MM-DD, for paid invoices)'
};

function viewAdminImport() {
  requireUser(function () {
    if (state.user.role !== 'admin') { location.hash = '#/dashboard'; return; }
    render(shell(
      '<h2>Import</h2><div id="msg"></div>' +
      '<p class="muted">Step 1: choose a type and paste CSV (first row = headers). Step 2: review validation, then confirm. ' +
      'This is the only way Stewards, Companies, Assignments, and Billing are updated.</p>' +
      '<div class="form-inline"><select id="itype">' +
      '<option value="stewards">Stewards</option>' +
      '<option value="companies">Companies</option>' +
      '<option value="assignments">Assignments</option>' +
      '<option value="billing">Billing</option>' +
      '</select> <button class="btn btn-primary" id="validate">Validate</button></div>' +
      '<p class="muted" id="fmt"></p>' +
      '<textarea id="csv" rows="10" class="csvbox" placeholder="paste CSV here"></textarea>' +
      '<div id="preview"></div>',
      '#/admin/import'));
    var typeSel = document.getElementById('itype');
    function showFmt() { document.getElementById('fmt').textContent = 'Columns: ' + IMPORT_FORMATS[typeSel.value]; }
    typeSel.onchange = showFmt;
    showFmt();
    document.getElementById('validate').onclick = function () {
      var type = typeSel.value;
      var csvText = document.getElementById('csv').value;
      var rows = parseCSV(csvText);
      if (rows.length === 0) { document.getElementById('msg').innerHTML = errorHtml('No data rows found.'); return; }
      if (type === 'billing') {
        document.getElementById('preview').innerHTML = '<p class="muted">Importing billing...</p>';
        api.post('/api/admin/import-billing', { rows: rows }).then(function (r) {
          document.getElementById('preview').innerHTML = '<h3>Done</h3>' +
            okHtml('Imported ' + r.imported + ' new, updated ' + r.updated + '.') +
            (r.errors.length ? '<div class="alert alert-error">' + r.errors.map(esc).join('<br>') + '</div>' : '');
        }).catch(function (err) { document.getElementById('msg').innerHTML = errorHtml(err.message); });
        return;
      }
      api.post('/api/admin/import', { type: type, rows: rows, dry_run: true }).then(function (d) {
        var html = '<h3>Validation</h3>' + okHtml(d.valid_count + ' valid rows.') +
          (d.errors.length ? '<div class="alert alert-error">' + d.errors.map(esc).join('<br>') + '</div>' : '') +
          (d.errors.length === 0 ? '<button class="btn btn-primary" id="confirm">Confirm import of ' + d.valid_count + ' rows</button>' : '<p class="muted">Fix the errors above and validate again.</p>');
        document.getElementById('preview').innerHTML = html;
        var cb = document.getElementById('confirm');
        if (cb) cb.onclick = function () {
          api.post('/api/admin/import', { type: type, rows: rows, dry_run: false }).then(function (r) {
            document.getElementById('preview').innerHTML = '<h3>Done</h3>' + okHtml('Imported ' + r.imported + ' rows.') +
              (r.errors.length ? '<div class="alert alert-error">' + r.errors.map(esc).join('<br>') + '</div>' : '');
          }).catch(function (err) { document.getElementById('msg').innerHTML = errorHtml(err.message); });
        };
      }).catch(function (err) { document.getElementById('msg').innerHTML = errorHtml(err.message); });
    };
  });
}

// ---------------------------------------------------------------- admin: jobs (run sync / summaries on demand)
function viewAdminJobs() {
  requireUser(function () {
    if (state.user.role !== 'admin') { location.hash = '#/dashboard'; return; }
    render(shell(
      '<h2>Jobs</h2><div id="msg"></div>' +
      '<p class="muted">Run the scheduled jobs on demand. The GitHub sync also runs every 6 hours; summaries run Sunday through Thursday at 9:00 PM.</p>' +
      '<div class="card-grid">' +
      '<div class="card"><div class="card-title">GitHub kanban sync</div>' +
      '<p class="muted">Pulls board cards, links implementations, pulls comments, removes app copies of comments deleted on GitHub.</p>' +
      '<button class="btn btn-primary" id="runsync">Run sync now</button><div id="syncout"></div></div>' +
      '<div class="card"><div class="card-title">Message sync</div>' +
      '<p class="muted">Pulls GitHub comments and removes app copies of deleted comments. Lighter than the full sync.</p>' +
      '<button class="btn btn-primary" id="runmsg">Sync messages now</button><div id="msgout"></div></div>' +
      '<div class="card"><div class="card-title">Claude project summaries</div>' +
      '<p class="muted">Generates fresh summaries for every active implementation.</p>' +
      '<button class="btn btn-primary" id="runsum">Run summaries now</button><div id="sumout"></div></div>' +
      '<div class="card"><div class="card-title">Reopen onboarding card</div>' +
      '<p class="muted">Reopens an initiated (Complete) onboarding card so its documents can be added, changed, or deleted, then sent to GitHub again. Sending again creates a brand new GitHub card — have someone delete the old GitHub issue.</p>' +
      '<select id="reopencard" style="max-width: 100%;"><option value="">Loading...</option></select> ' +
      '<button class="btn btn-primary" id="doreopen">Reopen card</button><div id="reopenout"></div></div>' +
      '<div class="card"><div class="card-title">Weekly email</div>' +
      '<p class="muted">Claude writes a personalized Friday summary for each steward, top dog, and admin — week in review, their to-dos, company updates. Sends via Resend.</p>' +
      '<label>Days back: <input id="emaildays" type="number" value="7" min="1" max="30" style="width: 60px;"></label> ' +
      '<button class="btn btn-primary" id="runemail">Send weekly email now</button><div id="emailout"></div></div>' +
      '</div>' +
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
      api.post('/api/admin/run-summaries-now', {}).then(function (d) {
        out.innerHTML = okHtml('Summaries finished.') + pretty(d);
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
    document.getElementById('delstewards').onclick = function () {
      del('stewards', 'all', '', '', 'Delete ALL non-admin stewards and their assignments? This cannot be undone.');
    };
    document.getElementById('delstewardone').onclick = function () {
      var k = document.getElementById('delstewardkey').value.trim();
      if (!k) { document.getElementById('delout').innerHTML = errorHtml('Enter a Steward ID or email.'); return; }
      del('stewards', 'one', k, '', 'Delete steward "' + k + '" and their assignments? This cannot be undone.');
    };
    document.getElementById('delcompanies').onclick = function () {
      del('companies', 'all', '', '', 'Delete ALL companies, implementations, messages and summaries? This cannot be undone.');
    };
    document.getElementById('delcompanyone').onclick = function () {
      var k = document.getElementById('delcompanykey').value.trim();
      if (!k) { document.getElementById('delout').innerHTML = errorHtml('Enter a Company Code.'); return; }
      del('companies', 'one', k, '', 'Delete company "' + k + '" with its implementations, messages and summaries? This cannot be undone.');
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
    if (['admin', 'top_dog', 'onboarding'].indexOf(role) === -1) { location.hash = '#/dashboard'; return; }
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
        var solutaDoc = null;
        for (var sdi = 0; sdi < c.documents.length; sdi++) {
          if (c.documents[sdi].doc_type === 'soluta_billing_intake') { solutaDoc = c.documents[sdi]; break; }
        }
        var hasPre = c.documents.some(function (d) { return d.doc_type === 'pre_implementation'; });
        var hasComm = c.documents.some(function (d) { return d.doc_type === 'commission_sheet'; });
        var solutaHtml = '';
        if (inProg) {
          if (solutaDoc) {
            solutaHtml += '<p><button class="btn btn-link" data-solutadl="' + solutaDoc.id + '" data-fn="' + esc(solutaDoc.file_name) + '">Download generated form</button> ' +
              '<span class="muted">' + fmtDate(solutaDoc.uploaded_at) + '</span></p>';
          } else {
            solutaHtml += '<p class="muted">No Soluta form generated yet.</p>';
          }
          if (hasPre && hasComm) {
            solutaHtml += '<p><label>Billing mode: <select id="solutamode">' +
              '<option value="auto" selected>Auto-detect from payroll form</option>' +
              ['Weekly', 'Bi-weekly', 'Semi-monthly', 'Monthly'].map(function (mo) { return '<option value="' + mo + '">' + mo + '</option>'; }).join('') +
              '</select></label> ' +
              '<button class="btn btn-primary" id="solutagen">' + (solutaDoc ? 'Regenerate' : 'Generate') + ' Soluta Billing Intake Form</button></p>' +
              '<div id="solutamsg"></div>';
          } else {
            solutaHtml += '<p class="muted">Upload the Pre-Implementation Form and the Commission Sheet to enable generation.</p>';
          }
        } else {
          solutaHtml = solutaDoc
            ? '<p><button class="btn btn-link" data-solutadl="' + solutaDoc.id + '" data-fn="' + esc(solutaDoc.file_name) + '">Download Soluta Billing Intake Form</button></p>'
            : '<p class="muted">No Soluta form was generated.</p>';
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
          if (!confirm('Generate the Soluta Billing Intake Form from the uploaded documents?')) return;
          document.getElementById('solutamsg').innerHTML = '<p class="muted">Generating...</p>';
          api.post('/api/onboarding/' + id + '/generate-soluta', { billingMode: mode }).then(function () {
            window._solutaMsg = 'Generated and saved with the client documents.';
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
  if (pathParts[0] === 'admin' && pathParts[1] === 'import') return viewAdminImport();
  if (pathParts[0] === 'admin' && pathParts[1] === 'jobs') return viewAdminJobs();
  location.hash = '#/login';
}

api.init();
window.addEventListener('hashchange', route);
route();

})();
