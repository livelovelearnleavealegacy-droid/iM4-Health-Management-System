// iM4 Health Management System (Smart Hub) - v5
// Parent/child companies with payroll roll-ups. Stewards/Companies/Assignments
// remain import-only. Link-only kanban sync. Stage-duration learning feeds the
// Claude summary prompt (RAG status, key dates, to-dos with owners/due dates).
// v5 adds: Top Dog role + multi-role switching, Resend email (password reset +
// email-code 2FA), Dashboard, Billing (invoices + CSV import).

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------- config
const JWT_SECRET = process.env.JWT_SECRET || '';
const SYNC_SECRET = process.env.SYNC_SECRET || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_ORG = process.env.GITHUB_ORG || 'im4health-implementation';
const GITHUB_PROJECT = parseInt(process.env.GITHUB_PROJECT || '3', 10);
const GITHUB_POST_AS = process.env.GITHUB_POST_AS || 'FTJ Solutions';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || '';
const RESEND_FROM = process.env.RESEND_FROM || EMAIL_FROM || 'iM4 Health <no-reply@im4health.com>';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const APP_URL = process.env.APP_URL || '';

const STAGES = ['Data Gathering', 'Initiation', 'Onboarding IHIA', 'Implementation', 'Go Live', 'Complete'];
// Default expected working days per stage until real cases teach us better.
const DEFAULT_STAGE_DAYS = {
  'Data Gathering': 30,
  'Initiation': 7,
  'Onboarding IHIA': 7,
  'Implementation': 30,
  'Go Live': 14,
  'Complete': 0
};

// ---------------------------------------------------------------- database
let pool = null;
function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
  }
  return pool;
}

async function migrate() {
  const db = getPool();
  await db.query('CREATE TABLE IF NOT EXISTS companies (' +
    'id SERIAL PRIMARY KEY, ' +
    'company_code TEXT UNIQUE NOT NULL, ' +
    'company_name TEXT NOT NULL, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW())');
  await db.query('CREATE TABLE IF NOT EXISTS stewards (' +
    'id SERIAL PRIMARY KEY, ' +
    'email TEXT UNIQUE NOT NULL, ' +
    'name TEXT, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW())');
  await db.query('CREATE TABLE IF NOT EXISTS assignments (' +
    'id SERIAL PRIMARY KEY, ' +
    'steward_id INT REFERENCES stewards(id) ON DELETE CASCADE, ' +
    'company_id INT REFERENCES companies(id) ON DELETE CASCADE, ' +
    'UNIQUE(steward_id, company_id))');
  await db.query('CREATE TABLE IF NOT EXISTS implementations (' +
    'id SERIAL PRIMARY KEY, ' +
    'company_id INT REFERENCES companies(id) ON DELETE CASCADE, ' +
    'stage TEXT, ' +
    'status TEXT, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'updated_at TIMESTAMPTZ DEFAULT NOW())');
  await db.query('CREATE TABLE IF NOT EXISTS messages (' +
    'id SERIAL PRIMARY KEY, ' +
    'implementation_id INT REFERENCES implementations(id) ON DELETE CASCADE, ' +
    'github_comment_id BIGINT UNIQUE, ' +
    'author_name TEXT, ' +
    'author_login TEXT, ' +
    'body TEXT NOT NULL, ' +
    'direction TEXT NOT NULL DEFAULT ' + "'in', " +
    'steward_id INT REFERENCES stewards(id) ON DELETE SET NULL, ' +
    'github_created_at TIMESTAMPTZ, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW())');
  await db.query('CREATE TABLE IF NOT EXISTS implementation_summaries (' +
    'id SERIAL PRIMARY KEY, ' +
    'implementation_id INT REFERENCES implementations(id) ON DELETE CASCADE, ' +
    'summary_date DATE NOT NULL, ' +
    'body TEXT NOT NULL, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'UNIQUE(implementation_id, summary_date))');
  // Stage-duration learning: one row per stage visit. Kept (SET NULL) even if
  // the implementation tile is later removed, so real cases keep teaching us.
  await db.query('CREATE TABLE IF NOT EXISTS stage_history (' +
    'id SERIAL PRIMARY KEY, ' +
    'implementation_id INT REFERENCES implementations(id) ON DELETE SET NULL, ' +
    'stage TEXT NOT NULL, ' +
    'entered_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'exited_at TIMESTAMPTZ, ' +
    'days INT)');
  // v5: multi-role support. stewards.role stays for backward compat; user_roles
  // is the source of truth going forward.
  await db.query('CREATE TABLE IF NOT EXISTS user_roles (' +
    'id SERIAL PRIMARY KEY, ' +
    'steward_id INT REFERENCES stewards(id) ON DELETE CASCADE, ' +
    "role TEXT NOT NULL CHECK (role IN ('admin', 'steward', 'top_dog')), " +
    'created_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'UNIQUE(steward_id, role))');
  // v5: hashed password-reset tokens (new flow; the legacy reset_token columns
  // on stewards remain for the old /api/auth/forgot + /api/auth/reset flow).
  await db.query('CREATE TABLE IF NOT EXISTS password_reset_tokens (' +
    'id SERIAL PRIMARY KEY, ' +
    'steward_id INT REFERENCES stewards(id) ON DELETE CASCADE, ' +
    'token_hash TEXT NOT NULL, ' +
    'expires_at TIMESTAMPTZ NOT NULL, ' +
    'used_at TIMESTAMPTZ, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW())');
  // v5: email-code two-factor authentication.
  await db.query('CREATE TABLE IF NOT EXISTS two_factor_codes (' +
    'id SERIAL PRIMARY KEY, ' +
    'steward_id INT REFERENCES stewards(id) ON DELETE CASCADE, ' +
    'code_hash TEXT NOT NULL, ' +
    'expires_at TIMESTAMPTZ NOT NULL, ' +
    'used_at TIMESTAMPTZ, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW())');
  // v5: billing invoices.
  await db.query('CREATE TABLE IF NOT EXISTS invoices (' +
    'id SERIAL PRIMARY KEY, ' +
    'company_code TEXT NOT NULL, ' +
    'company_name TEXT NOT NULL, ' +
    'payroll_date DATE, ' +
    'lives_count INT, ' +
    'total_invoice NUMERIC(12,2), ' +
    "status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid')), " +
    'paid_date DATE, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'updated_at TIMESTAMPTZ DEFAULT NOW())');

  const cols = [
    ['stewards', 'role', "TEXT NOT NULL DEFAULT 'steward'"],
    ['stewards', 'password_hash', 'TEXT'],
    ['stewards', 'first_name', 'TEXT'],
    ['stewards', 'last_name', 'TEXT'],
    ['stewards', 'phone', 'TEXT'],
    ['stewards', 'reset_token', 'TEXT'],
    ['stewards', 'reset_expires', 'TIMESTAMPTZ'],
    ['stewards', 'two_factor_enabled', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['stewards', 'created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ['companies', 'created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ['companies', 'github_issue_number', 'INT'],
    ['companies', 'parent_company_code', 'TEXT'],
    ['companies', 'parent_company_name', 'TEXT'],
    ['companies', 'ee_company_code', 'TEXT'],
    ['companies', 'ee_company_name', 'TEXT'],
    ['companies', 'payroll_total', 'INT'],
    ['companies', 'payroll_ineligible', 'INT'],
    ['companies', 'payroll_opted_out', 'INT'],
    ['companies', 'payroll_qualified', 'INT'],
    ['companies', 'payroll_enrolled', 'INT'],
    ['companies', 'payroll_not_enrolled', 'INT'],
    ['companies', 'payroll_new_qualified', 'INT'],
    ['companies', 'payroll_dataset_date', 'DATE'],
    ['implementations', 'github_item_id', 'TEXT UNIQUE'],
    ['implementations', 'created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ['implementations', 'updated_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ['implementations', 'github_issue_number', 'INT'],
    ['implementations', 'github_repo', 'TEXT'],
    ['implementations', 'card_title', 'TEXT'],
    ['implementations', 'payroll_provider', 'TEXT'],
    ['implementations', 'payroll_frequency', 'TEXT'],
    ['implementations', 'notes', 'TEXT']
  ];
  for (const [table, col, def] of cols) {
    await db.query('ALTER TABLE ' + table + ' ADD COLUMN IF NOT EXISTS ' + col + ' ' + def);
  }
  // v5: "parent" renamed to "ee" on import headings; carry existing values over.
  await db.query('UPDATE companies SET ee_company_code = parent_company_code WHERE (ee_company_code IS NULL OR ee_company_code = ' + "''" + ') AND parent_company_code IS NOT NULL AND parent_company_code <> ' + "''");
  await db.query('UPDATE companies SET ee_company_name = parent_company_name WHERE (ee_company_name IS NULL OR ee_company_name = ' + "''" + ') AND parent_company_name IS NOT NULL AND parent_company_name <> ' + "''");
  await db.query("UPDATE stewards SET role = 'steward' WHERE role IS NULL OR role = ''");
  // v5: backfill user_roles from the legacy single-role column (idempotent).
  await db.query("INSERT INTO user_roles (steward_id, role) SELECT id, role FROM stewards WHERE role IN ('admin', 'steward', 'top_dog') ON CONFLICT DO NOTHING");
  await db.query("UPDATE stewards SET first_name = SPLIT_PART(name, ' ', 1) " +
    "WHERE (first_name IS NULL OR first_name = '') AND name IS NOT NULL AND name <> ''");
  await db.query("UPDATE stewards SET last_name = NULLIF(SUBSTRING(name FROM POSITION(' ' IN name) + 1), '') " +
    "WHERE (last_name IS NULL OR last_name = '') AND name IS NOT NULL AND POSITION(' ' IN name) > 0");
}

async function bootstrapAdmin() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return;
  const db = getPool();
  const found = await db.query('SELECT id, password_hash FROM stewards WHERE LOWER(email) = LOWER($1) LIMIT 1', [ADMIN_EMAIL]);
  if (found.rows.length === 0) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    const ins = await db.query("INSERT INTO stewards (email, name, first_name, role, password_hash) VALUES ($1, $2, $3, 'admin', $4) RETURNING id",
      [ADMIN_EMAIL, 'Administrator', 'Administrator', hash]);
    await db.query("INSERT INTO user_roles (steward_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING", [ins.rows[0].id]);
    console.log('Bootstrapped admin account: ' + ADMIN_EMAIL);
  } else {
    await db.query("INSERT INTO user_roles (steward_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING", [found.rows[0].id]);
    if (!found.rows[0].password_hash) {
      const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
      await db.query("UPDATE stewards SET role = 'admin', password_hash = $1 WHERE id = $2", [hash, found.rows[0].id]);
      console.log('Set admin password for: ' + ADMIN_EMAIL);
    }
  }
}

// ---------------------------------------------------------------- auth helpers
function pickActiveRole(roles) {
  if (!roles || roles.length === 0) return 'steward';
  if (roles.indexOf('admin') !== -1) return 'admin';
  const sorted = roles.slice().sort();
  return sorted[0];
}

function signToken(user, roles, activeRole) {
  return jwt.sign({ id: user.id, email: user.email, roles: roles, activeRole: activeRole }, JWT_SECRET, { expiresIn: '12h' });
}

function sign2faToken(userId) {
  return jwt.sign({ id: userId, purpose: '2fa-pending' }, JWT_SECRET, { expiresIn: '10m' });
}

async function requireAuth(req, res, next) {
  try {
    if (!JWT_SECRET) return res.status(500).json({ error: 'Server auth is not configured' });
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not signed in' });
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.purpose === '2fa-pending') {
      return res.status(401).json({ error: 'Two-factor verification required' });
    }
    const r = await getPool().query('SELECT id, email, first_name, last_name, name, role, two_factor_enabled FROM stewards WHERE id = $1 LIMIT 1', [payload.id]);
    if (r.rows.length === 0) return res.status(401).json({ error: 'Account no longer exists' });
    const row = r.rows[0];
    // Roles come from the JWT; fall back to the legacy single-role column for
    // tokens minted before v5.
    let roles = payload.roles;
    if (!Array.isArray(roles) || roles.length === 0) {
      roles = row.role ? [row.role] : ['steward'];
    }
    let activeRole = payload.activeRole;
    if (roles.indexOf(activeRole) === -1) activeRole = pickActiveRole(roles);
    req.user = {
      id: row.id, email: row.email, first_name: row.first_name, last_name: row.last_name,
      name: row.name, role: activeRole, roles: roles, activeRole: activeRole,
      two_factor_enabled: !!row.two_factor_enabled
    };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired, please sign in again' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, function () {
    if (req.user.activeRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

function checkSyncSecret(req, res) {
  if (!SYNC_SECRET || req.headers['x-sync-secret'] !== SYNC_SECRET) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

function displayName(u) {
  const full = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return full || u.name || u.email;
}

function publicUser(u, roles, activeRole) {
  const r = roles || u.roles || [u.role || 'steward'];
  const a = activeRole || u.activeRole || pickActiveRole(r);
  return { id: u.id, email: u.email, name: displayName(u), role: a, roles: r, activeRole: a };
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

// Eligible = stored qualified value, else computed total - ineligible - opted out.
function eligibleOf(c) {
  if (c.payroll_qualified !== null && c.payroll_qualified !== undefined) return c.payroll_qualified;
  if (c.payroll_total === null || c.payroll_total === undefined) return null;
  return (c.payroll_total || 0) - (c.payroll_ineligible || 0) - (c.payroll_opted_out || 0);
}

function parentKey(c) {
  const ee = c.ee_company_code && String(c.ee_company_code).trim();
  const par = c.parent_company_code && String(c.parent_company_code).trim();
  return ee || par || c.company_code;
}
function parentName(c) {
  const ee = c.ee_company_name && String(c.ee_company_name).trim();
  const par = c.parent_company_name && String(c.parent_company_name).trim();
  return ee || par || c.company_name;
}

async function userRoles(db, stewardId) {
  const r = await db.query('SELECT role FROM user_roles WHERE steward_id = $1 ORDER BY role', [stewardId]);
  return r.rows.map(function (x) { return x.role; });
}

// Visibility: admin and top_dog see ALL companies (null = no filter);
// stewards see only their assigned companies.
async function visibleCompanyIds(user) {
  if (user.activeRole === 'admin' || user.activeRole === 'top_dog') return null;
  const r = await getPool().query('SELECT company_id FROM assignments WHERE steward_id = $1', [user.id]);
  return r.rows.map(x => x.company_id);
}

async function getVisibleCodes(user) {
  if (user.activeRole === 'admin' || user.activeRole === 'top_dog') return null;
  const r = await getPool().query(
    'SELECT DISTINCT c.company_code FROM assignments a JOIN companies c ON c.id = a.company_id WHERE a.steward_id = $1',
    [user.id]);
  return r.rows.map(x => x.company_code);
}

// ---------------------------------------------------------------- email (Resend)
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.log('sendEmail skipped (RESEND_API_KEY is not set): to=' + to + ' subject=' + subject);
    return { skipped: true };
  }
  try {
    const resend = new Resend(RESEND_API_KEY);
    const result = await resend.emails.send({ from: RESEND_FROM, to: to, subject: subject, html: html });
    return { ok: true, id: result && result.data ? result.data.id : null };
  } catch (e) {
    console.error('sendEmail failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Minimal CSV parser for the billing import (handles quoted commas).
function parseCsvServer(text) {
  const rows = [];
  let headers = null;
  const lines = String(text).split(String.fromCharCode(10));
  lines.forEach(function (line) {
    if (!line.trim()) return;
    const cells = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === ',' && !inQ) { cells.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    if (!headers) {
      headers = cells.map(function (h) { return h.toLowerCase().trim(); });
    } else {
      const obj = {};
      headers.forEach(function (h, idx) { obj[h] = cells[idx] !== undefined ? cells[idx] : ''; });
      rows.push(obj);
    }
  });
  return rows;
}

// ---------------------------------------------------------------- public
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    if (!JWT_SECRET) return res.status(500).json({ error: 'Server auth is not configured (JWT_SECRET)' });
    const db = getPool();
    const r = await db.query('SELECT * FROM stewards WHERE LOWER(email) = LOWER($1) LIMIT 1', [String(email).trim()]);
    if (r.rows.length === 0 || !r.rows[0].password_hash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const user = r.rows[0];
    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    const roles = await userRoles(db, user.id);
    // v5: email-code 2FA. Password is verified; hold the full session until
    // the code checks out.
    if (user.two_factor_enabled) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const codeHash = crypto.createHash('sha256').update(code).digest('hex');
      const expires = new Date(Date.now() + 10 * 60 * 1000);
      await db.query('INSERT INTO two_factor_codes (steward_id, code_hash, expires_at) VALUES ($1, $2, $3)',
        [user.id, codeHash, expires.toISOString()]);
      await sendEmail(user.email, 'Your iM4 Health login code',
        '<p>Your iM4 Health login code is:</p>' +
        '<p style="font-size: 28px; font-weight: bold; letter-spacing: 4px;">' + code + '</p>' +
        '<p>This code expires in 10 minutes. If you did not try to sign in, you can ignore this email.</p>');
      return res.json({ success: true, need2fa: true, tmpToken: sign2faToken(user.id) });
    }
    const activeRole = pickActiveRole(roles);
    res.json({ success: true, token: signToken(user, roles, activeRole), user: publicUser(user, roles, activeRole) });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function appBaseUrl(req) {
  if (APP_URL) return APP_URL.replace(/[/]+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return proto + '://' + req.get('host');
}

// v5 password reset: hashed single-use tokens, emailed link. Always returns
// { ok: true } so nobody can probe which emails have accounts.
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const email = req.body && req.body.email ? String(req.body.email).trim() : '';
    const done = function () { return res.json({ ok: true }); };
    if (!email) return done();
    const db = getPool();
    const r = await db.query('SELECT id, email FROM stewards WHERE LOWER(email) = LOWER($1) LIMIT 1', [email]);
    if (r.rows.length > 0) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000);
      await db.query('INSERT INTO password_reset_tokens (steward_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [r.rows[0].id, tokenHash, expires.toISOString()]);
      const link = appBaseUrl(req) + '/#/reset-password?token=' + token;
      await sendEmail(r.rows[0].email, 'Reset your iM4 Health password',
        '<p>Someone requested a password reset for your iM4 Health account.</p>' +
        '<p><a href="' + link + '">Set a new password</a></p>' +
        '<p>This link expires in one hour. If you did not request this, you can ignore it.</p>');
    }
    return done();
  } catch (error) {
    console.error('Forgot-password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const token = req.body && req.body.token ? String(req.body.token) : '';
    const newPassword = req.body && req.body.newPassword ? String(req.body.newPassword) : '';
    if (!token || newPassword.length < 8) {
      return res.status(400).json({ error: 'A valid token and a password of at least 8 characters are required' });
    }
    const db = getPool();
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const r = await db.query(
      'SELECT id, steward_id FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() LIMIT 1',
      [tokenHash]);
    if (r.rows.length === 0) return res.status(400).json({ error: 'This reset link is invalid or has expired' });
    const hash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE stewards SET password_hash = $1 WHERE id = $2', [hash, r.rows[0].steward_id]);
    await db.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [r.rows[0].id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('Reset-password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- 2FA (email codes)
async function latestCode(db, stewardId) {
  const r = await db.query(
    'SELECT id, code_hash FROM two_factor_codes WHERE steward_id = $1 AND used_at IS NULL AND expires_at > NOW() ' +
    'ORDER BY created_at DESC LIMIT 1', [stewardId]);
  return r.rows.length > 0 ? r.rows[0] : null;
}

app.post('/api/auth/2fa/verify-login', async (req, res) => {
  try {
    const tmpToken = req.body && req.body.tmpToken ? String(req.body.tmpToken) : '';
    const code = req.body && req.body.code ? String(req.body.code).trim() : '';
    if (!tmpToken || !code) return res.status(400).json({ error: 'A login token and code are required' });
    let payload;
    try {
      payload = jwt.verify(tmpToken, JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: 'Login session expired, please sign in again' });
    }
    if (!payload || payload.purpose !== '2fa-pending' || !payload.id) {
      return res.status(401).json({ error: 'Invalid login session' });
    }
    const db = getPool();
    const row = await latestCode(db, payload.id);
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    if (!row || row.code_hash !== codeHash) {
      return res.status(400).json({ error: 'That code is incorrect or has expired' });
    }
    await db.query('UPDATE two_factor_codes SET used_at = NOW() WHERE id = $1', [row.id]);
    const u = await db.query('SELECT * FROM stewards WHERE id = $1 LIMIT 1', [payload.id]);
    if (u.rows.length === 0) return res.status(401).json({ error: 'Account no longer exists' });
    const roles = await userRoles(db, u.rows[0].id);
    const activeRole = pickActiveRole(roles);
    res.json({ success: true, token: signToken(u.rows[0], roles, activeRole), user: publicUser(u.rows[0], roles, activeRole) });
  } catch (error) {
    console.error('2FA verify-login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/auth/2fa/status', requireAuth, async (req, res) => {
  res.json({ enabled: !!req.user.two_factor_enabled });
});

app.post('/api/auth/2fa/enable', requireAuth, async (req, res) => {
  try {
    const db = getPool();
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    await db.query('INSERT INTO two_factor_codes (steward_id, code_hash, expires_at) VALUES ($1, $2, $3)',
      [req.user.id, codeHash, expires.toISOString()]);
    await sendEmail(req.user.email, 'Your iM4 Health verification code',
      '<p>Your iM4 Health verification code is:</p>' +
      '<p style="font-size: 28px; font-weight: bold; letter-spacing: 4px;">' + code + '</p>' +
      '<p>This code expires in 10 minutes.</p>');
    res.json({ ok: true });
  } catch (error) {
    console.error('2FA enable error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/2fa/confirm', requireAuth, async (req, res) => {
  try {
    const code = req.body && req.body.code ? String(req.body.code).trim() : '';
    if (!code) return res.status(400).json({ error: 'A code is required' });
    const db = getPool();
    const row = await latestCode(db, req.user.id);
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    if (!row || row.code_hash !== codeHash) {
      return res.status(400).json({ error: 'That code is incorrect or has expired' });
    }
    await db.query('UPDATE two_factor_codes SET used_at = NOW() WHERE id = $1', [row.id]);
    await db.query('UPDATE stewards SET two_factor_enabled = TRUE WHERE id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('2FA confirm error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/2fa/disable', requireAuth, async (req, res) => {
  try {
    await getPool().query('UPDATE stewards SET two_factor_enabled = FALSE WHERE id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('2FA disable error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// v5: switch the active role (only to a role the user actually has).
app.post('/api/auth/switch-role', requireAuth, async (req, res) => {
  try {
    const role = req.body && req.body.role ? String(req.body.role) : '';
    if (!role || req.user.roles.indexOf(role) === -1) {
      return res.status(403).json({ error: 'That role is not available for this account' });
    }
    const token = signToken(req.user, req.user.roles, role);
    res.json({ success: true, token: token, user: publicUser(req.user, req.user.roles, role) });
  } catch (error) {
    console.error('Switch-role error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Legacy password-reset flow (kept working): raw token on the steward row.
function baseUrl(req) {
  if (APP_URL) return APP_URL.replace(/[/]+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return proto + '://' + req.get('host');
}

app.post('/api/auth/forgot', async (req, res) => {
  try {
    const { email } = req.body || {};
    const done = () => res.json({ success: true, message: 'If that email has an account, a reset link is on its way.' });
    if (!email) return done();
    const r = await getPool().query('SELECT id, email FROM stewards WHERE LOWER(email) = LOWER($1) LIMIT 1', [String(email).trim()]);
    if (r.rows.length === 0) return done();
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    await getPool().query('UPDATE stewards SET reset_token = $1, reset_expires = $2 WHERE id = $3', [token, expires.toISOString(), r.rows[0].id]);
    const link = baseUrl(req) + '/#reset?token=' + token;
    await sendEmail(r.rows[0].email, 'Reset your iM4 Health password',
      '<p>Someone requested a password reset for your iM4 Health account.</p>' +
      '<p><a href="' + link + '">Set a new password</a></p>' +
      '<p>This link expires in one hour. If you did not request this, you can ignore it.</p>');
    return done();
  } catch (error) {
    console.error('Forgot-password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/reset', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password || String(password).length < 8) {
      return res.status(400).json({ error: 'A valid token and a password of at least 8 characters are required' });
    }
    const r = await getPool().query(
      'SELECT id FROM stewards WHERE reset_token = $1 AND reset_expires > NOW() LIMIT 1', [String(token)]);
    if (r.rows.length === 0) return res.status(400).json({ error: 'This reset link is invalid or has expired' });
    const hash = await bcrypt.hash(String(password), 10);
    await getPool().query('UPDATE stewards SET password_hash = $1, reset_token = NULL, reset_expires = NULL WHERE id = $2',
      [hash, r.rows[0].id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Reset error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/me', requireAuth, (req, res) => {
  const u = publicUser(req.user, req.user.roles, req.user.activeRole);
  u.two_factor_enabled = !!req.user.two_factor_enabled;
  res.json(u);
});

// ---------------------------------------------------------------- github helpers
function ghHeaders() {
  return {
    'Authorization': 'Bearer ' + GITHUB_TOKEN,
    'Content-Type': 'application/json',
    'User-Agent': 'im4-sync'
  };
}

async function fetchIssueComments(repo, issueNumber) {
  const comments = [];
  let page = 1;
  for (;;) {
    const resp = await fetch('https://api.github.com/repos/' + repo + '/issues/' + issueNumber + '/comments?per_page=100&page=' + page, { headers: ghHeaders() });
    if (!resp.ok) throw new Error('GitHub comments API returned ' + resp.status);
    const batch = await resp.json();
    for (const c of batch) comments.push(c);
    if (batch.length < 100) break;
    page++;
  }
  return comments;
}

async function postIssueComment(repo, issueNumber, body) {
  const resp = await fetch('https://api.github.com/repos/' + repo + '/issues/' + issueNumber + '/comments', {
    method: 'POST',
    headers: ghHeaders(),
    body: JSON.stringify({ body: body })
  });
  if (!resp.ok) throw new Error('GitHub comment post returned ' + resp.status);
  return resp.json();
}

function numericCodeSort(prefix) {
  const p = prefix ? prefix + '.' : '';
  return "ORDER BY CASE WHEN " + p + "company_code ~ '^[0-9]+$' THEN 0 ELSE 1 END, " +
    "CASE WHEN " + p + "company_code ~ '^[0-9]+$' THEN " + p + "company_code::int END NULLS LAST, " + p + "company_code";
}

// Build parent groups from company rows. Each group: one card on Clients.
// Payroll is rolled up from the children: Total, Eligible, Enrolled.
function groupParents(rows) {
  const map = {};
  const order = [];
  rows.forEach(function (c) {
    const key = parentKey(c);
    if (!map[key]) {
      map[key] = { code: key, name: parentName(c), children: [], total: 0, eligible: 0, enrolled: 0, has_total: false, has_eligible: false, has_enrolled: false };
      order.push(key);
    }
    const g = map[key];
    if (String(c.company_code) !== String(key)) g.name = parentName(c);
    const child = {
      id: c.id, company_code: c.company_code, company_name: c.company_name,
      total: c.payroll_total, eligible: eligibleOf(c), enrolled: c.payroll_enrolled,
      payroll_dataset_date: c.payroll_dataset_date
    };
    g.children.push(child);
    if (child.total !== null && child.total !== undefined) { g.total += child.total; g.has_total = true; }
    if (child.eligible !== null && child.eligible !== undefined) { g.eligible += child.eligible; g.has_eligible = true; }
    if (child.enrolled !== null && child.enrolled !== undefined) { g.enrolled += child.enrolled; g.has_enrolled = true; }
  });
  return order.map(function (key) {
    const g = map[key];
    g.children.sort(function (a, b) { return String(a.company_code).localeCompare(String(b.company_code)); });
    return {
      code: g.code, name: g.name,
      total: g.has_total ? g.total : null,
      eligible: g.has_eligible ? g.eligible : null,
      enrolled: g.has_enrolled ? g.enrolled : null,
      children: g.children
    };
  });
}

// ---------------------------------------------------------------- steward: clients (parent cards with rolled-up payroll)
app.get('/api/clients', requireAuth, async (req, res) => {
  try {
    const ids = await visibleCompanyIds(req.user);
    let where = '';
    const params = [];
    if (ids) {
      if (ids.length === 0) return res.json([]);
      where = 'WHERE c.id = ANY($1)';
      params.push(ids);
    }
    const q = req.query.q ? String(req.query.q).toLowerCase() : '';
    if (q) {
      params.push('%' + q + '%');
      where += (where ? ' AND ' : 'WHERE ') + '(LOWER(c.company_code) LIKE $' + params.length +
        ' OR LOWER(c.company_name) LIKE $' + params.length +
        ' OR LOWER(COALESCE(c.ee_company_code, ' + "''" + ')) LIKE $' + params.length +
        ' OR LOWER(COALESCE(c.ee_company_name, ' + "''" + ')) LIKE $' + params.length +
        ' OR LOWER(COALESCE(c.parent_company_code, ' + "''" + ')) LIKE $' + params.length +
        ' OR LOWER(COALESCE(c.parent_company_name, ' + "''" + ')) LIKE $' + params.length + ')';
    }
    const r = await getPool().query('SELECT * FROM companies c ' + where + ' ' + numericCodeSort('c'), params);
    res.json(groupParents(r.rows));
  } catch (error) {
    console.error('Load clients error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Parent detail: child cards + stewards (union) + implementations across children.
app.get('/api/parents/:code', requireAuth, async (req, res) => {
  try {
    const code = String(req.params.code);
    const ids = await visibleCompanyIds(req.user);
    let where = "(c.company_code = $1 OR c.ee_company_code = $1 OR c.parent_company_code = $1)";
    const params = [code];
    if (ids) {
      if (ids.length === 0) return res.status(403).json({ error: 'Not assigned to this client' });
      params.push(ids);
      where = "(" + where + ") AND c.id = ANY($" + params.length + ")";
    }
    const rows = await getPool().query('SELECT * FROM companies c WHERE ' + where + ' ' + numericCodeSort('c'), params);
    if (rows.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const groups = groupParents(rows.rows);
    const group = groups[0];
    const childIds = rows.rows.map(c => c.id);
    const impls = await getPool().query(
      'SELECT i.*, c.company_code, c.company_name, ' +
      'EXTRACT(DAY FROM (NOW() - i.updated_at))::int AS days_in_stage, ' +
      '(SELECT body FROM implementation_summaries s WHERE s.implementation_id = i.id ORDER BY s.summary_date DESC LIMIT 1) AS latest_summary ' +
      'FROM implementations i JOIN companies c ON c.id = i.company_id ' +
      'WHERE i.company_id = ANY($1) ORDER BY i.updated_at DESC', [childIds]);
    const stewards = await getPool().query(
      'SELECT DISTINCT s.id, s.first_name, s.last_name, s.name, s.email FROM stewards s ' +
      'JOIN assignments a ON a.steward_id = s.id WHERE a.company_id = ANY($1) ORDER BY s.id', [childIds]);
    res.json({ parent: group, children: rows.rows, implementations: impls.rows, stewards: stewards.rows });
  } catch (error) {
    console.error('Load parent error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Child detail: full payroll, stewards, implementation cards.
app.get('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    const ids = await visibleCompanyIds(req.user);
    if (ids && ids.indexOf(parseInt(req.params.id, 10)) === -1) {
      return res.status(403).json({ error: 'Not assigned to this client' });
    }
    const c = await getPool().query('SELECT * FROM companies WHERE id = $1', [req.params.id]);
    if (c.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const impls = await getPool().query(
      'SELECT i.*, EXTRACT(DAY FROM (NOW() - i.updated_at))::int AS days_in_stage, ' +
      '(SELECT COUNT(*)::int FROM messages m WHERE m.implementation_id = i.id) AS message_count, ' +
      '(SELECT body FROM implementation_summaries s WHERE s.implementation_id = i.id ORDER BY s.summary_date DESC LIMIT 1) AS latest_summary ' +
      'FROM implementations i WHERE i.company_id = $1 ORDER BY i.updated_at DESC', [req.params.id]);
    const stewards = await getPool().query(
      'SELECT s.id, s.first_name, s.last_name, s.name, s.email FROM stewards s JOIN assignments a ON a.steward_id = s.id WHERE a.company_id = $1 ORDER BY s.id',
      [req.params.id]);
    res.json({ company: c.rows[0], implementations: impls.rows, stewards: stewards.rows });
  } catch (error) {
    console.error('Load client error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- steward: implementations (implementation data only)
app.get('/api/implementations', requireAuth, async (req, res) => {
  try {
    const ids = await visibleCompanyIds(req.user);
    let where = '';
    const params = [];
    if (ids) {
      if (ids.length === 0) return res.json([]);
      where = 'WHERE i.company_id = ANY($1)';
      params.push(ids);
    }
    const clauses = [];
    if (req.query.stage) {
      params.push(String(req.query.stage));
      clauses.push('i.stage = $' + params.length);
    }
    const q = req.query.q ? String(req.query.q).toLowerCase() : '';
    if (q) {
      params.push('%' + q + '%');
      clauses.push('(LOWER(c.company_code) LIKE $' + params.length + ' OR LOWER(c.company_name) LIKE $' + params.length + ')');
    }
    if (clauses.length > 0) where += (where ? ' AND ' : 'WHERE ') + clauses.join(' AND ');
    const r = await getPool().query(
      'SELECT i.*, c.company_code, c.company_name, ' +
      'EXTRACT(DAY FROM (NOW() - i.updated_at))::int AS days_in_stage, ' +
      '(SELECT body FROM implementation_summaries s WHERE s.implementation_id = i.id ORDER BY s.summary_date DESC LIMIT 1) AS latest_summary ' +
      'FROM implementations i JOIN companies c ON c.id = i.company_id ' +
      where + ' ORDER BY i.status, c.company_name', params);
    res.json(r.rows);
  } catch (error) {
    console.error('Load implementations error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/implementations/:id', requireAuth, async (req, res) => {
  try {
    const ids = await visibleCompanyIds(req.user);
    const r = await getPool().query(
      'SELECT i.*, c.company_code, c.company_name, c.ee_company_code, c.ee_company_name, c.parent_company_code, c.parent_company_name, ' +
      'EXTRACT(DAY FROM (NOW() - i.updated_at))::int AS days_in_stage, ' +
      '(SELECT entered_at FROM stage_history h WHERE h.implementation_id = i.id AND h.exited_at IS NULL ' +
      'ORDER BY h.entered_at DESC LIMIT 1) AS stage_entered_at ' +
      'FROM implementations i JOIN companies c ON c.id = i.company_id WHERE i.id = $1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (ids && ids.indexOf(r.rows[0].company_id) === -1) {
      return res.status(403).json({ error: 'Not assigned to this client' });
    }
    const impl = r.rows[0];
    const msgs = await getPool().query(
      'SELECT m.*, s.first_name, s.last_name, s.name AS steward_legacy_name FROM messages m LEFT JOIN stewards s ON s.id = m.steward_id ' +
      'WHERE m.implementation_id = $1 ORDER BY COALESCE(m.github_created_at, m.created_at)',
      [req.params.id]);
    const sums = await getPool().query(
      'SELECT summary_date, body, created_at FROM implementation_summaries WHERE implementation_id = $1 ORDER BY summary_date DESC LIMIT 5',
      [req.params.id]);
    res.json({ implementation: impl, messages: msgs.rows, summaries: sums.rows });
  } catch (error) {
    console.error('Load project error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/implementations/:id/messages', requireAuth, async (req, res) => {
  try {
    const { body } = req.body || {};
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'Message text is required' });
    const r = await getPool().query('SELECT * FROM implementations WHERE id = $1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const impl = r.rows[0];
    const ids = await visibleCompanyIds(req.user);
    if (ids && ids.indexOf(impl.company_id) === -1) {
      return res.status(403).json({ error: 'Not assigned to this client' });
    }
    const stewardName = displayName(req.user);
    const nl = String.fromCharCode(10);
    const ghBody = '**' + stewardName + '**' + nl + nl + String(body).trim();
    let ghComment = null;
    if (GITHUB_TOKEN && impl.github_repo && impl.github_issue_number) {
      ghComment = await postIssueComment(impl.github_repo, impl.github_issue_number, ghBody);
    }
    const m = await getPool().query(
      'INSERT INTO messages (implementation_id, github_comment_id, author_name, author_login, body, direction, steward_id, github_created_at) ' +
      'VALUES ($1, $2, $3, $4, $5, ' + "'out'" + ', $6, NOW()) RETURNING *',
      [impl.id, ghComment ? ghComment.id : null, stewardName, GITHUB_POST_AS, String(body).trim(), req.user.id]);
    res.status(201).json({ success: true, message: m.rows[0], posted_to_github: !!ghComment });
  } catch (error) {
    console.error('Post message error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- v5: dashboard
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const db = getPool();
    const ids = await visibleCompanyIds(req.user);
    const codes = await getVisibleCodes(req.user);
    let coWhere = '';
    const coParams = [];
    if (ids) {
      if (ids.length === 0) {
        return res.json({ totalClients: 0, clientsByStage: [], totalLives: 0, billingOpen: { count: 0, total: 0 }, billingPaid: { count: 0, total: 0 } });
      }
      coWhere = 'WHERE c.id = ANY($1)';
      coParams.push(ids);
    }
    const tc = await db.query('SELECT COUNT(*)::int AS c FROM companies c ' + coWhere, coParams);
    const tl = await db.query(
      'SELECT COALESCE(SUM(COALESCE(c.payroll_qualified, c.payroll_total - COALESCE(c.payroll_ineligible, 0) - COALESCE(c.payroll_opted_out, 0))), 0)::int AS t ' +
      'FROM companies c ' + coWhere, coParams);
    let stWhere = '';
    const stParams = [];
    if (ids) {
      stWhere = 'WHERE c.id = ANY($1)';
      stParams.push(ids);
    }
    const st = await db.query(
      'SELECT i.stage AS stage, COUNT(*)::int AS count FROM implementations i ' +
      'JOIN companies c ON c.id = i.company_id ' + stWhere + ' GROUP BY i.stage ORDER BY i.stage', stParams);
    let billingOpen = { count: 0, total: 0 };
    let billingPaid = { count: 0, total: 0 };
    if (codes === null || codes.length > 0) {
      let bWhere = '';
      const bParams = [];
      if (codes) {
        bWhere = 'WHERE company_code = ANY($1)';
        bParams.push(codes);
      }
      const b = await db.query(
        "SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total_invoice), 0)::float AS total FROM invoices " +
        bWhere + ' GROUP BY status', bParams);
      b.rows.forEach(function (x) {
        if (x.status === 'open') billingOpen = { count: x.count, total: x.total };
        if (x.status === 'paid') billingPaid = { count: x.count, total: x.total };
      });
    }
    res.json({
      totalClients: tc.rows[0].c,
      clientsByStage: st.rows,
      totalLives: tl.rows[0].t,
      billingOpen: billingOpen,
      billingPaid: billingPaid
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- v5: billing
app.get('/api/billing', requireAuth, async (req, res) => {
  try {
    const status = req.query.status === 'paid' ? 'paid' : 'open';
    const codes = await getVisibleCodes(req.user);
    if (codes && codes.length === 0) return res.json([]);
    let where = 'WHERE status = $1';
    const params = [status];
    if (codes) {
      params.push(codes);
      where += ' AND company_code = ANY($2)';
    }
    const r = await getPool().query(
      'SELECT * FROM invoices ' + where + ' ORDER BY payroll_date DESC NULLS LAST, company_code', params);
    res.json(r.rows);
  } catch (error) {
    console.error('Billing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// v5: billing CSV import (admin only). Accepts { csv } text or { rows } array.
// Columns: company_code, company_name, payroll_date, lives_count,
// total_invoice, status, paid_date. Upserts on (company_code, payroll_date).
app.post('/api/admin/import-billing', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    let rows = [];
    if (Array.isArray(body.rows)) rows = body.rows;
    else if (body.csv) rows = parseCsvServer(body.csv);
    else return res.status(400).json({ error: 'Provide { csv } text or { rows }' });
    const db = getPool();
    let imported = 0;
    let updated = 0;
    const errors = [];
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const line = idx + 2;
      try {
        const company_code = row.company_code !== undefined && row.company_code !== null ? String(row.company_code).trim() : '';
        const company_name = row.company_name !== undefined && row.company_name !== null ? String(row.company_name).trim() : '';
        if (!company_code) throw new Error('company_code is required');
        if (!company_name) throw new Error('company_name is required');
        const payroll_date = toISODate(row.payroll_date);
        const lives_count = num(row.lives_count);
        let total_invoice = null;
        if (row.total_invoice !== undefined && row.total_invoice !== null && String(row.total_invoice).trim() !== '') {
          total_invoice = parseFloat(String(row.total_invoice));
          if (isNaN(total_invoice)) throw new Error('total_invoice must be a number');
        }
        let status = row.status !== undefined && row.status !== null && String(row.status).trim() !== ''
          ? String(row.status).trim().toLowerCase() : 'open';
        if (status !== 'open' && status !== 'paid') throw new Error("status must be 'open' or 'paid'");
        const paid_date = toISODate(row.paid_date);
        const up = await db.query(
          'UPDATE invoices SET company_name = $1, lives_count = $2, total_invoice = $3, status = $4, paid_date = $5, updated_at = NOW() ' +
          'WHERE company_code = $6 AND ((payroll_date = $7) OR (payroll_date IS NULL AND $7 IS NULL))',
          [company_name, lives_count, total_invoice, status, paid_date, company_code, payroll_date]);
        if (up.rowCount > 0) {
          updated++;
        } else {
          await db.query(
            'INSERT INTO invoices (company_code, company_name, payroll_date, lives_count, total_invoice, status, paid_date) ' +
            'VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [company_code, company_name, payroll_date, lives_count, total_invoice, status, paid_date]);
          imported++;
        }
      } catch (e) {
        errors.push('Row ' + line + ': ' + e.message);
      }
    }
    res.json({ success: true, imported: imported, updated: updated, errors: errors });
  } catch (error) {
    console.error('Billing import error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- admin: stewards (read-only list; import only; password + roles set here)
app.get('/api/admin/stewards', requireAdmin, async (req, res) => {
  try {
    const r = await getPool().query(
      "SELECT s.id, s.email, s.first_name, s.last_name, s.name, s.phone, s.role, s.created_at, " +
      "COALESCE(array_agg(ur.role) FILTER (WHERE ur.role IS NOT NULL), '{}') AS roles " +
      "FROM stewards s LEFT JOIN user_roles ur ON ur.steward_id = s.id " +
      "GROUP BY s.id ORDER BY CASE WHEN s.role = 'admin' THEN 0 ELSE 1 END, s.id");
    res.json(r.rows);
  } catch (error) {
    console.error('Admin stewards error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/stewards/:id/password', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const hash = await bcrypt.hash(String(password), 10);
    const r = await getPool().query('UPDATE stewards SET password_hash = $1 WHERE id = $2 RETURNING id', [hash, req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Admin set password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// v5.2: edit a steward's profile (admin only).
app.put('/api/admin/stewards/:id', requireAdmin, async (req, res) => {
  try {
    const { first_name, last_name, email, phone } = req.body || {};
    if (!email || String(email).trim() === '') {
      return res.status(400).json({ error: 'Email is required' });
    }
    const db = getPool();
    const r = await db.query(
      'UPDATE stewards SET first_name = $1, last_name = $2, email = $3, phone = $4, ' +
      "name = TRIM(COALESCE($1,'') || ' ' || COALESCE($2,'')) WHERE id = $5 RETURNING id",
      [first_name || null, last_name || null, String(email).trim(), phone || null, req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Admin edit steward error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// v5.2: delete a steward (admin only). Refuses to delete the last admin.
app.delete('/api/admin/stewards/:id', requireAdmin, async (req, res) => {
  try {
    const db = getPool();
    const id = req.params.id;
    const target = await db.query('SELECT id FROM stewards WHERE id = $1', [id]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const adminCount = await db.query(
      "SELECT COUNT(*) AS c FROM user_roles WHERE role = 'admin'");
    const targetRoles = await db.query('SELECT role FROM user_roles WHERE steward_id = $1', [id]);
    const isAdmin = targetRoles.rows.some(function (r) { return r.role === 'admin'; });
    if (isAdmin && parseInt(adminCount.rows[0].c, 10) <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last admin' });
    }
    if (String(req.user.id) === String(id)) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }
    await db.query('BEGIN');
    try {
      await db.query('DELETE FROM user_roles WHERE steward_id = $1', [id]);
      await db.query('DELETE FROM assignments WHERE steward_id = $1', [id]);
      await db.query('UPDATE messages SET steward_id = NULL WHERE steward_id = $1', [id]);
      await db.query('DELETE FROM stewards WHERE id = $1', [id]);
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Admin delete steward error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// v5: replace a steward's roles (admin only). Keeps at least one role.
app.post('/api/admin/set-roles', requireAdmin, async (req, res) => {
  try {
    const steward_id = req.body && req.body.steward_id;
    const roles = req.body && req.body.roles;
    const allowed = ['admin', 'steward', 'top_dog'];
    if (!steward_id || !Array.isArray(roles) || roles.length === 0) {
      return res.status(400).json({ error: 'steward_id and a non-empty roles array are required' });
    }
    for (const r of roles) {
      if (allowed.indexOf(r) === -1) return res.status(400).json({ error: 'Invalid role: ' + r });
    }
    const db = getPool();
    const s = await db.query('SELECT id FROM stewards WHERE id = $1', [steward_id]);
    if (s.rows.length === 0) return res.status(404).json({ error: 'Steward not found' });
    await db.query('DELETE FROM user_roles WHERE steward_id = $1', [steward_id]);
    for (const r of roles) {
      await db.query('INSERT INTO user_roles (steward_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING', [steward_id, r]);
    }
    // Keep the legacy single-role column in sync for backward compatibility.
    await db.query('UPDATE stewards SET role = $1 WHERE id = $2', [roles[0], steward_id]);
    res.json({ success: true, roles: roles });
  } catch (error) {
    console.error('Set-roles error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- admin: companies (read-only list; import only)
app.get('/api/admin/companies', requireAdmin, async (req, res) => {
  try {
    const r = await getPool().query('SELECT * FROM companies c ' + numericCodeSort('c'));
    res.json(r.rows);
  } catch (error) {
    console.error('Admin companies error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- admin: assignments (read-only list; import only)
app.get('/api/admin/assignments', requireAdmin, async (req, res) => {
  try {
    const r = await getPool().query(
      'SELECT a.id, a.steward_id, c.company_code, s.email AS steward_email ' +
      'FROM assignments a JOIN stewards s ON s.id = a.steward_id JOIN companies c ON c.id = a.company_id ' +
      'ORDER BY a.steward_id, c.company_code');
    res.json(r.rows);
  } catch (error) {
    console.error('Admin assignments error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- admin: import (the ONLY way to update these tables)
// stewards:    steward_id, email, first_name, last_name, phone, password (everyone imported is a steward)
// companies:   company_code, company_name, ee_company_code, ee_company_name,
//              payroll_total, payroll_ineligible, payroll_opted_out, payroll_qualified,
//              payroll_enrolled, payroll_not_enrolled, payroll_new_qualified, payroll_dataset_date
// assignments: steward_id, company_code
// Date values: accept YYYY-MM-DD or an Excel serial number (days since 1899-12-30).
function toISODate(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  let digits = s.length > 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] < '0' || s[i] > '9') { digits = false; break; }
  }
  if (digits) {
    const ms = Date.UTC(1899, 11, 30) + parseInt(s, 10) * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return s;
}

// Header normalization: lowercase, strip "(...)" notes, and accept the ee_*
// payroll aliases (ee_total, ee_ineligible, ee_optedout, ee_qualified,
// ee_enrolled, ee_not_enrolled, ee_new_qualified, ee_dataset_date).
function normalizeRow(row) {
  const n = {};
  Object.keys(row).forEach(function (k) {
    let key = String(k).toLowerCase().trim();
    const paren = key.indexOf('(');
    if (paren !== -1) key = key.slice(0, paren).trim();
    n[key] = row[k];
  });
  const aliases = {
    'ee_total': 'payroll_total',
    'ee_ineligible': 'payroll_ineligible',
    'ee_optedout': 'payroll_opted_out',
    'ee_opted_out': 'payroll_opted_out',
    'ee_qualified': 'payroll_qualified',
    'ee_enrolled': 'payroll_enrolled',
    'ee_not_enrolled': 'payroll_not_enrolled',
    'ee_new_qualified': 'payroll_new_qualified',
    'ee_dataset_date': 'payroll_dataset_date'
  };
  Object.keys(aliases).forEach(function (a) {
    if (n[a] !== undefined && n[aliases[a]] === undefined) n[aliases[a]] = n[a];
  });
  return n;
}

function validateImport(type, rows) {
  rows = rows.map(normalizeRow);
  const errors = [];
  const valid = [];
  const seen = {};
  rows.forEach(function (row, idx) {
    const line = idx + 2;
    const e = function (msg) { errors.push('Row ' + line + ': ' + msg); };
    if (type === 'stewards') {
      if (!row.email || !String(row.email).includes('@')) { e('email is required'); return; }
      const key = String(row.email).trim().toLowerCase();
      if (seen[key]) { e('duplicate email in file'); return; }
      seen[key] = true;
      let stewardId = null;
      if (row.steward_id !== undefined && row.steward_id !== null && String(row.steward_id).trim() !== '') {
        stewardId = parseInt(String(row.steward_id).trim(), 10);
        if (isNaN(stewardId) || stewardId <= 0) { e('steward_id must be a positive number'); return; }
        const idKey = 'id:' + stewardId;
        if (seen[idKey]) { e('duplicate steward_id in file'); return; }
        seen[idKey] = true;
      }
      let password = null;
      if (row.password !== undefined && row.password !== null && String(row.password) !== '') {
        password = String(row.password);
        if (password.length < 8) { e('password must be at least 8 characters'); return; }
      }
      valid.push({ steward_id: stewardId, email: key, first_name: row.first_name || null, last_name: row.last_name || null, phone: row.phone || null, password: password });
    } else if (type === 'companies') {
      if (!row.company_code) { e('company_code is required'); return; }
      if (!row.company_name) { e('company_name is required'); return; }
      const key = String(row.company_code).trim();
      if (seen[key]) { e('duplicate company_code in file'); return; }
      seen[key] = true;
      const eeCode = row.ee_company_code || row.parent_company_code;
      const eeName = row.ee_company_name || row.parent_company_name;
      valid.push({
        company_code: key, company_name: String(row.company_name).trim(),
        ee_company_code: eeCode ? String(eeCode).trim() : null,
        ee_company_name: eeName ? String(eeName).trim() : null,
        payroll_total: num(row.payroll_total), payroll_ineligible: num(row.payroll_ineligible),
        payroll_opted_out: num(row.payroll_opted_out), payroll_qualified: num(row.payroll_qualified),
        payroll_enrolled: num(row.payroll_enrolled), payroll_not_enrolled: num(row.payroll_not_enrolled),
        payroll_new_qualified: num(row.payroll_new_qualified),
        payroll_dataset_date: toISODate(row.payroll_dataset_date)
      });
    } else if (type === 'assignments') {
      if (!row.steward_id || !row.company_code) { e('steward_id and company_code are required'); return; }
      const sid = parseInt(String(row.steward_id).trim(), 10);
      if (isNaN(sid) || sid <= 0) { e('steward_id must be a positive number'); return; }
      const key = sid + '|' + String(row.company_code).trim();
      if (seen[key]) { e('duplicate assignment in file'); return; }
      seen[key] = true;
      valid.push({ steward_id: sid, company_code: String(row.company_code).trim() });
    } else {
      e('unknown import type');
    }
  });
  return { valid: valid, errors: errors };
}

app.post('/api/admin/import', requireAdmin, async (req, res) => {
  try {
    const { type, rows, dry_run } = req.body || {};
    if (['stewards', 'companies', 'assignments'].indexOf(type) === -1) {
      return res.status(400).json({ error: 'type must be stewards, companies, or assignments' });
    }
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows array is required' });
    const v = validateImport(type, rows);
    if (dry_run !== false) {
      return res.json({ success: true, dry_run: true, valid_count: v.valid.length, errors: v.errors, preview: v.valid.slice(0, 10) });
    }
    const db = getPool();
    let imported = 0;
    const commitErrors = v.errors.slice();
    if (type === 'stewards') {
      for (const s of v.valid) {
        try {
          // A password in the file is hashed and set; a blank leaves the existing one alone.
          const hash = s.password ? await bcrypt.hash(s.password, 10) : null;
          // The live table requires name NOT NULL; keep it in sync with first/last.
          const nm = [s.first_name, s.last_name].filter(Boolean).join(' ').trim() || s.email;
          let savedId = null;
          if (s.steward_id !== null) {
            // Explicit Steward ID: upsert on id, never touch existing roles.
            if (hash) {
              const r = await db.query(
                'INSERT INTO stewards (id, email, name, first_name, last_name, phone, password_hash, role) VALUES ($1, $2, $3, $4, $5, $6, $7, ' + "'steward'" + ') ' +
                'ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, first_name = EXCLUDED.first_name, ' +
                'last_name = EXCLUDED.last_name, phone = EXCLUDED.phone, password_hash = EXCLUDED.password_hash RETURNING id',
                [s.steward_id, s.email, nm, s.first_name, s.last_name, s.phone, hash]);
              savedId = r.rows[0].id;
            } else {
              const r = await db.query(
                'INSERT INTO stewards (id, email, name, first_name, last_name, phone, role) VALUES ($1, $2, $3, $4, $5, $6, ' + "'steward'" + ') ' +
                'ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, first_name = EXCLUDED.first_name, ' +
                'last_name = EXCLUDED.last_name, phone = EXCLUDED.phone RETURNING id',
                [s.steward_id, s.email, nm, s.first_name, s.last_name, s.phone]);
              savedId = r.rows[0].id;
            }
          } else {
            // No Steward ID: upsert on email, never touch existing roles.
            if (hash) {
              const r = await db.query(
                'INSERT INTO stewards (email, name, first_name, last_name, phone, password_hash, role) VALUES ($1, $2, $3, $4, $5, $6, ' + "'steward'" + ') ' +
                'ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, ' +
                'phone = EXCLUDED.phone, password_hash = EXCLUDED.password_hash RETURNING id',
                [s.email, nm, s.first_name, s.last_name, s.phone, hash]);
              savedId = r.rows[0].id;
            } else {
              const r = await db.query(
                'INSERT INTO stewards (email, name, first_name, last_name, phone, role) VALUES ($1, $2, $3, $4, $5, ' + "'steward'" + ') ' +
                'ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, ' +
                'phone = EXCLUDED.phone RETURNING id',
                [s.email, nm, s.first_name, s.last_name, s.phone]);
              savedId = r.rows[0].id;
            }
          }
          // v5: everyone imported here is at least a steward; keep user_roles
          // in sync without touching roles an admin may have assigned.
          if (savedId) {
            await db.query("INSERT INTO user_roles (steward_id, role) VALUES ($1, 'steward') ON CONFLICT DO NOTHING", [savedId]);
          }
          imported++;
        } catch (err) { commitErrors.push(s.email + ': ' + err.message); }
      }
      await db.query("SELECT setval('stewards_id_seq', COALESCE((SELECT MAX(id) FROM stewards), 1))");
    } else if (type === 'companies') {
      for (const c of v.valid) {
        try {
          await db.query(
            'INSERT INTO companies (company_code, company_name, ee_company_code, ee_company_name, ' +
            'payroll_total, payroll_ineligible, payroll_opted_out, ' +
            'payroll_qualified, payroll_enrolled, payroll_not_enrolled, payroll_new_qualified, payroll_dataset_date) ' +
            'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ' +
            'ON CONFLICT (company_code) DO UPDATE SET company_name = EXCLUDED.company_name, ' +
            'ee_company_code = EXCLUDED.ee_company_code, ee_company_name = EXCLUDED.ee_company_name, ' +
            'payroll_total = EXCLUDED.payroll_total, payroll_ineligible = EXCLUDED.payroll_ineligible, ' +
            'payroll_opted_out = EXCLUDED.payroll_opted_out, payroll_qualified = EXCLUDED.payroll_qualified, ' +
            'payroll_enrolled = EXCLUDED.payroll_enrolled, payroll_not_enrolled = EXCLUDED.payroll_not_enrolled, ' +
            'payroll_new_qualified = EXCLUDED.payroll_new_qualified, payroll_dataset_date = EXCLUDED.payroll_dataset_date',
            [c.company_code, c.company_name, c.ee_company_code, c.ee_company_name,
              c.payroll_total, c.payroll_ineligible, c.payroll_opted_out,
              c.payroll_qualified, c.payroll_enrolled, c.payroll_not_enrolled, c.payroll_new_qualified, c.payroll_dataset_date]);
          imported++;
        } catch (err) { commitErrors.push(c.company_code + ': ' + err.message); }
      }
    } else {
      const sMap = {};
      (await db.query('SELECT id FROM stewards')).rows.forEach(x => { sMap[String(x.id)] = x.id; });
      const cMap = {};
      (await db.query('SELECT id, company_code FROM companies')).rows.forEach(x => { cMap[x.company_code] = x.id; });
      for (const a of v.valid) {
        const sid = sMap[String(a.steward_id)];
        const cid = cMap[a.company_code];
        if (!sid) { commitErrors.push(a.steward_id + ': steward not found'); continue; }
        if (!cid) { commitErrors.push(a.company_code + ': company not found (is it on the company list?)'); continue; }
        await db.query('INSERT INTO assignments (steward_id, company_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [sid, cid]);
        imported++;
      }
    }
    res.json({ success: true, dry_run: false, imported: imported, errors: commitErrors });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- github mirror sync (link-only) + stage learning
async function fetchProjectItems() {
  const query = `query($after: String) { organization(login: "` + GITHUB_ORG + `") { projectV2(number: ` + GITHUB_PROJECT + `) { items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id content { __typename ... on DraftIssue { title } ... on Issue { title number repository { nameWithOwner } } ... on PullRequest { title } } fieldValues(first: 25) { nodes { __typename ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { name } } } } } } } } } }`;
  const all = [];
  let after = null;
  for (;;) {
    const resp = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: ghHeaders(),
      body: JSON.stringify({ query: query, variables: { after: after } })
    });
    if (!resp.ok) throw new Error('GitHub API returned ' + resp.status);
    const data = await resp.json();
    if (data.errors) throw new Error('GitHub API: ' + data.errors[0].message);
    const items = data.data.organization.projectV2.items;
    for (const n of items.nodes) all.push(n);
    if (!items.pageInfo.hasNextPage) break;
    after = items.pageInfo.endCursor;
  }
  return all;
}

// Record stage transitions so the summary prompt learns real durations.
async function trackStage(db, implId, newStage) {
  const cur = await db.query(
    'SELECT id, stage FROM stage_history WHERE implementation_id = $1 AND exited_at IS NULL ORDER BY entered_at DESC LIMIT 1',
    [implId]);
  if (cur.rows.length === 0) {
    await db.query('INSERT INTO stage_history (implementation_id, stage) VALUES ($1, $2)', [implId, newStage]);
    return;
  }
  if (cur.rows[0].stage === newStage) return;
  await db.query(
    "UPDATE stage_history SET exited_at = NOW(), days = EXTRACT(DAY FROM (NOW() - entered_at))::int WHERE id = $1",
    [cur.rows[0].id]);
  await db.query('INSERT INTO stage_history (implementation_id, stage) VALUES ($1, $2)', [implId, newStage]);
}

// Pulls an issue's comments into the app and prunes app copies of comments
// deleted on GitHub (both directions: the app mirrors the card's comment list).
// Messages never posted to GitHub (NULL github_comment_id) are never pruned.
// Returns { pulled, pruned }. Throws on failure.
async function syncIssueComments(db, implId, repo, issueNumber) {
  const comments = await fetchIssueComments(repo, issueNumber);
  const seenIds = [];
  let pulled = 0;
  for (const c of comments) {
    seenIds.push(c.id);
    const login = (c.user && c.user.login) ? c.user.login : 'github';
    await db.query(
      'INSERT INTO messages (implementation_id, github_comment_id, author_name, author_login, body, direction, github_created_at) ' +
      'VALUES ($1, $2, $3, $4, $5, ' + "'in'" + ', $6) ON CONFLICT (github_comment_id) DO NOTHING',
      [implId, c.id, login, login, c.body || '', c.created_at]);
    pulled++;
  }
  const gone = await db.query(
    'DELETE FROM messages WHERE implementation_id = $1 AND github_comment_id IS NOT NULL ' +
    'AND NOT (github_comment_id = ANY($2::bigint[]))',
    [implId, seenIds]);
  return { pulled: pulled, pruned: gone.rowCount };
}

async function runGithubSync() {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not set');
  try {
    const db = getPool();
    const items = await fetchProjectItems();
    let synced = 0;
    let skippedHoldDead = 0;
    let skippedNoCode = 0;
    let skippedNotOnList = 0;
    let commentsPulled = 0;
    let commentsPruned = 0;
    const syncedIds = [];
    for (const item of items) {
      const fields = {};
      for (const v of item.fieldValues.nodes) {
        if (v.__typename === 'ProjectV2ItemFieldSingleSelectValue') fields[v.field.name] = v.name;
        else if (v.__typename === 'ProjectV2ItemFieldNumberValue') fields[v.field.name] = v.number;
      }
      const status = fields['Status'] || '';
      if (status === 'Hold' || status === 'Dead') { skippedHoldDead++; continue; }
      const codeRaw = fields['Company Code'];
      if (codeRaw === undefined || codeRaw === null) { skippedNoCode++; continue; }
      const code = String(Math.trunc(codeRaw));
      const comp = await db.query('SELECT id, company_name FROM companies WHERE company_code = $1', [code]);
      if (comp.rows.length === 0) { skippedNotOnList++; continue; }
      const companyId = comp.rows[0].id;
      const fullTitle = (item.content && item.content.title) ? item.content.title : 'Untitled';
      const issueNumber = (item.content && item.content.__typename === 'Issue') ? item.content.number : null;
      const repo = (item.content && item.content.repository) ? item.content.repository.nameWithOwner : null;
      const stage = status || 'No Status';
      const up = await db.query(
        'INSERT INTO implementations (company_id, stage, status, github_item_id, github_issue_number, github_repo, card_title, payroll_provider, payroll_frequency, updated_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW()) ' +
        'ON CONFLICT (github_item_id) DO UPDATE SET company_id = EXCLUDED.company_id, stage = EXCLUDED.stage, ' +
        'status = EXCLUDED.status, github_issue_number = EXCLUDED.github_issue_number, github_repo = EXCLUDED.github_repo, ' +
        'card_title = EXCLUDED.card_title, payroll_provider = EXCLUDED.payroll_provider, ' +
        'payroll_frequency = EXCLUDED.payroll_frequency, updated_at = NOW() RETURNING id',
        [companyId, stage, fields['Priority'] || 'NORMAL', item.id, issueNumber, repo,
          fullTitle, fields['Payroll Provider'] || null, fields['Payroll Frequency'] || null]);
      await trackStage(db, up.rows[0].id, stage);
      syncedIds.push(item.id);
      synced++;
      if (issueNumber && repo) {
        try {
          const r = await syncIssueComments(db, up.rows[0].id, repo, issueNumber);
          commentsPulled += r.pulled;
          commentsPruned += r.pruned;
        } catch (ce) {
          console.error('Comment pull failed for issue ' + issueNumber + ':', ce.message);
        }
      }
    }
    if (syncedIds.length > 0) {
      await db.query('DELETE FROM implementations WHERE github_item_id IS NOT NULL AND NOT (github_item_id = ANY($1))', [syncedIds]);
    } else {
      await db.query('DELETE FROM implementations WHERE github_item_id IS NOT NULL');
    }
    const compCount = await db.query('SELECT COUNT(*)::int AS c FROM companies');
    return { success: true, synced: synced, skipped_hold_dead: skippedHoldDead, skipped_no_code: skippedNoCode, skipped_not_on_list: skippedNotOnList, companies: compCount.rows[0].c, comments_pulled: commentsPulled, comments_pruned: commentsPruned };
  } catch (error) {
    console.error('GitHub sync error:', error);
    throw error;
  }
}

app.post('/api/admin/sync-github', async (req, res) => {
  if (!checkSyncSecret(req, res)) return;
  try {
    res.json(await runGithubSync());
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Same sync, triggered by a signed-in admin from the Jobs page (JWT, no secret needed).
app.post('/api/admin/sync-now', requireAdmin, async (req, res) => {
  try {
    res.json(await runGithubSync());
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Messages-only sync: pulls GitHub comments for every linked implementation and
// prunes app copies of deleted comments. Lighter than the full board sync.
async function runMessageSync() {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not set');
  const db = getPool();
  const impls = await db.query(
    "SELECT id, github_repo, github_issue_number FROM implementations " +
    "WHERE github_repo IS NOT NULL AND github_issue_number IS NOT NULL ORDER BY id");
  let pulled = 0;
  let pruned = 0;
  const errors = [];
  for (const impl of impls.rows) {
    try {
      const r = await syncIssueComments(db, impl.id, impl.github_repo, impl.github_issue_number);
      pulled += r.pulled;
      pruned += r.pruned;
    } catch (e) {
      errors.push('impl ' + impl.id + ': ' + e.message);
    }
  }
  return { success: true, implementations: impls.rows.length, comments_pulled: pulled, comments_pruned: pruned, errors: errors };
}

app.post('/api/admin/sync-messages-now', requireAdmin, async (req, res) => {
  try {
    res.json(await runMessageSync());
  } catch (error) {
    console.error('Message sync error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------- admin: delete data (Jobs page)
// Imports never delete; these do. Everything runs in a transaction.
app.post('/api/admin/delete-data', requireAdmin, async (req, res) => {
  const db = getPool();
  const target = req.body && req.body.target;
  const mode = req.body && req.body.mode;
  const key = (req.body && req.body.key) ? String(req.body.key).trim() : '';
  const key2 = (req.body && req.body.key2) ? String(req.body.key2).trim() : '';
  try {
    await db.query('BEGIN');
    let deleted = 0;
    let detail = '';
    if (target === 'stewards' && mode === 'all') {
      // Admins are kept: deleting your own admin row would lock you out.
      await db.query("UPDATE messages SET steward_id = NULL WHERE steward_id IN (SELECT id FROM stewards WHERE role <> 'admin')");
      await db.query("DELETE FROM assignments WHERE steward_id IN (SELECT id FROM stewards WHERE role <> 'admin')");
      const r = await db.query("DELETE FROM stewards WHERE role <> 'admin'");
      deleted = r.rowCount;
      detail = 'non-admin stewards and their assignments removed (admins kept)';
    } else if (target === 'stewards' && mode === 'one') {
      if (!key) throw new Error('Enter a Steward ID or email');
      const byEmail = key.indexOf('@') !== -1;
      const s = byEmail
        ? await db.query('SELECT id, role FROM stewards WHERE LOWER(email) = LOWER($1)', [key])
        : await db.query('SELECT id, role FROM stewards WHERE id = $1', [parseInt(key, 10)]);
      if (s.rows.length === 0) throw new Error('Steward not found: ' + key);
      if (s.rows[0].role === 'admin') throw new Error('Refusing to delete an admin account');
      const sid = s.rows[0].id;
      await db.query('UPDATE messages SET steward_id = NULL WHERE steward_id = $1', [sid]);
      await db.query('DELETE FROM assignments WHERE steward_id = $1', [sid]);
      await db.query('DELETE FROM stewards WHERE id = $1', [sid]);
      deleted = 1;
      detail = 'steward ' + key + ' and their assignments removed';
    } else if (target === 'companies' && mode === 'all') {
      const c = await db.query('SELECT COUNT(*)::int AS n FROM companies');
      await db.query('TRUNCATE companies RESTART IDENTITY CASCADE');
      deleted = c.rows[0].n;
      detail = 'companies removed with their implementations, messages, summaries and assignments';
    } else if (target === 'companies' && mode === 'one') {
      if (!key) throw new Error('Enter a Company Code');
      const c = await db.query('SELECT id FROM companies WHERE company_code = $1', [key]);
      if (c.rows.length === 0) throw new Error('Company not found: ' + key);
      const cid = c.rows[0].id;
      const impls = await db.query('SELECT id FROM implementations WHERE company_id = $1', [cid]);
      const ids = impls.rows.map(function (r) { return r.id; });
      if (ids.length > 0) {
        await db.query('DELETE FROM messages WHERE implementation_id = ANY($1)', [ids]);
        await db.query('DELETE FROM implementation_summaries WHERE implementation_id = ANY($1)', [ids]);
        await db.query('DELETE FROM stage_history WHERE implementation_id = ANY($1)', [ids]);
        await db.query('DELETE FROM implementations WHERE id = ANY($1)', [ids]);
      }
      await db.query('DELETE FROM assignments WHERE company_id = $1', [cid]);
      await db.query('DELETE FROM companies WHERE id = $1', [cid]);
      deleted = 1;
      detail = 'company ' + key + ' removed with its implementations, messages, summaries and assignments';
    } else if (target === 'assignments' && mode === 'all') {
      const a = await db.query('SELECT COUNT(*)::int AS n FROM assignments');
      await db.query('TRUNCATE assignments RESTART IDENTITY');
      deleted = a.rows[0].n;
      detail = 'assignments removed';
    } else if (target === 'assignments' && mode === 'one') {
      if (!key || !key2) throw new Error('Enter a Steward ID and a Company Code');
      const sid = parseInt(key, 10);
      if (isNaN(sid)) throw new Error('Steward ID must be a number');
      const r = await db.query(
        'DELETE FROM assignments WHERE steward_id = $1 AND company_id = (SELECT id FROM companies WHERE company_code = $2)',
        [sid, key2]);
      if (r.rowCount === 0) throw new Error('Assignment not found for steward ' + key + ' and company ' + key2);
      deleted = r.rowCount;
      detail = 'assignment of steward ' + key + ' to company ' + key2 + ' removed';
    } else {
      throw new Error('Unknown delete request');
    }
    await db.query('COMMIT');
    res.json({ success: true, deleted: deleted, detail: detail });
  } catch (error) {
    await db.query('ROLLBACK');
    res.status(400).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------- claude summaries (Sun-Thu nights + on demand)
// Learns stage durations from real cases (stage_history); falls back to defaults.
async function typicalDurations(db) {
  const out = {};
  try {
    const r = await db.query(
      'SELECT stage, ROUND(AVG(days))::int AS avg_days, COUNT(*)::int AS n FROM stage_history ' +
      'WHERE days IS NOT NULL GROUP BY stage');
    r.rows.forEach(function (x) { out[x.stage] = { days: x.avg_days, cases: x.n }; });
  } catch (e) { console.error('Duration learning query failed:', e.message); }
  return out;
}

async function claudeSummarize(db, impl, company, recentMessages, typical) {
  const nl = String.fromCharCode(10);
  const msgText = recentMessages.slice(-20).map(m => '- ' + (m.author_name || 'unknown') + ' (' + (m.when || '') + '): ' + String(m.body || '').slice(0, 400)).join(nl);
  const durLines = STAGES.map(function (s) {
    const t = typical[s];
    const days = t ? t.days + ' (observed over ' + t.cases + ' real cases)' : DEFAULT_STAGE_DAYS[s] + ' (default estimate)';
    return '- ' + s + ': ' + days + ' working days';
  }).join(nl);
  const stageEntered = impl.stage_entered_at ? new Date(impl.stage_entered_at).toLocaleDateString() : 'unknown';
  const prompt = 'You are a project manager writing a brief nightly update for the project owner. ' +
    'Project: ' + company.company_name + ' (company code ' + company.company_code + '). ' +
    'Current stage: ' + (impl.stage || 'unknown') + ' (entered ' + stageEntered + ', ' + (impl.days_in_stage || 0) + ' days in stage). ' +
    'Status: ' + (impl.status || 'unknown') + '. Card: ' + (impl.card_title || '') + '.' + nl +
    'Typical working days per stage:' + nl + durLines + nl +
    'Recent messages (newest last):' + nl + (msgText || '(none)') + nl + nl +
    'Write the update in EXACTLY this format:' + nl +
    'STATUS: RED, YELLOW, or GREEN (your judgment: RED = blocked or seriously off track, YELLOW = at risk or stalled, GREEN = on track)' + nl +
    'KEY DATES:' + nl +
    '- one bullet per important date: when the current stage started, expected completion of the current stage (use the typical durations above), expected go-live, and any due dates mentioned in the messages' + nl +
    'SUMMARY:' + nl +
    '- 1-2 sentences on the current status and what has been accomplished recently' + nl +
    '- Outstanding to-dos, each with WHAT needs doing, WHO owns it, and the DUE DATE (use TBD where unknown)' + nl +
    '- Obstacles or roadblocks and who is working on them' + nl +
    'Keep it tight and plain-spoken. No preamble, no sign-off.';
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!resp.ok) throw new Error('Anthropic API returned ' + resp.status);
  const data = await resp.json();
  const parts = (data.content || []).filter(p => p.type === 'text').map(p => p.text);
  return parts.join(nl).trim();
}

async function runSummaries() {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  try {
    const db = getPool();
    const typical = await typicalDurations(db);
    const impls = await db.query(
      'SELECT i.*, c.company_name, c.company_code, ' +
      'EXTRACT(DAY FROM (NOW() - i.updated_at))::int AS days_in_stage, ' +
      '(SELECT entered_at FROM stage_history h WHERE h.implementation_id = i.id AND h.exited_at IS NULL ' +
      'ORDER BY h.entered_at DESC LIMIT 1) AS stage_entered_at ' +
      'FROM implementations i JOIN companies c ON c.id = i.company_id ' +
      "WHERE COALESCE(i.stage, '') <> 'Complete' ORDER BY i.id");
    const today = new Date().toISOString().slice(0, 10);
    let done = 0;
    const errors = [];
    for (const impl of impls.rows) {
      try {
        const msgs = await db.query(
          'SELECT author_name, body, COALESCE(github_created_at, created_at) AS when FROM messages ' +
          'WHERE implementation_id = $1 ORDER BY COALESCE(github_created_at, created_at) DESC LIMIT 20',
          [impl.id]);
        const body = await claudeSummarize(db, impl, impl, msgs.rows.reverse(), typical);
        await db.query(
          'INSERT INTO implementation_summaries (implementation_id, summary_date, body) VALUES ($1, $2, $3) ' +
          'ON CONFLICT (implementation_id, summary_date) DO UPDATE SET body = EXCLUDED.body',
          [impl.id, today, body]);
        done++;
      } catch (e) {
        errors.push('impl ' + impl.id + ': ' + e.message);
      }
    }
    return { success: true, summarized: done, of: impls.rows.length, errors: errors };
  } catch (error) {
    console.error('Summaries error:', error);
    throw error;
  }
}

app.post('/api/admin/run-summaries', async (req, res) => {
  if (!checkSyncSecret(req, res)) return;
  try {
    res.json(await runSummaries());
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Same summaries, triggered by a signed-in admin from the Jobs page (JWT, no secret needed).
app.post('/api/admin/run-summaries-now', requireAdmin, async (req, res) => {
  try {
    res.json(await runSummaries());
  } catch (error) {
    console.error('Summaries error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------- static + startup
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

let started = false;
async function startup() {
  if (started) return;
  started = true;
  await migrate();
  await bootstrapAdmin();
}
startup().catch(e => console.error('Startup error:', e));

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log('iM4 Health Management System listening on port ' + port);
  });
}

module.exports = app;
