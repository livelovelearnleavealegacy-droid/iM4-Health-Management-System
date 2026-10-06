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

const STAGES = ['Initiation', 'Data Gathering', 'Implementation', 'Go Live', 'Complete'];
// Default expected working days per stage until real cases teach us better.
const DEFAULT_STAGE_DAYS = {
  'Initiation': 14,
  'Data Gathering': 28,
  'Implementation': 42,
  'Go Live': 14,
  'Complete': 0
};

// The 14-week implementation plan. The clock starts the first time a project
// enters the Initiation stage. Weeks are counted from that start date.
const TIMELINE = [
  { stage: 'Initiation', block: 'Kickoff', startWeek: 0, endWeek: 2, duties: [
    'Receive information from IHIA',
    'Receive intro from IHIA',
    'Send intro with availability to client',
    'Set introduction meeting',
    'Set up codes for express/2.0 if possible',
    'Complete introduction meeting and send recap, requirements, and generic education'
  ] },
  { stage: 'Data Gathering', block: 'Census and setup', startWeek: 2, endWeek: 6, duties: [
    'Receive census from client',
    'Review census from client and unhide reports',
    'Set up codes',
    'Unit test'
  ] },
  { stage: 'Implementation', block: 'Development and testing', startWeek: 6, endWeek: 8, duties: [
    'Developers create what is needed for process',
    'Test run(s)'
  ] },
  { stage: 'Implementation', block: 'Dry run 1', startWeek: 8, endWeek: 10, duties: [
    'Confirm expected date to set up dry run',
    'Successful dry run 1 (must succeed twice)',
    'Send recaps with next steps',
    'Send educational materials',
    'Confirm expected go live and provide availability'
  ] },
  { stage: 'Implementation', block: 'Dry run 2', startWeek: 10, endWeek: 12, duties: [
    'Successful dry run 2 (must succeed twice)',
    'Send recaps with next steps',
    'Confirm expected go live and provide availability',
    'Set go live meeting'
  ] },
  { stage: 'Go Live', block: 'Go live', startWeek: 12, endWeek: 14, duties: [
    'Complete go live - training',
    'Send recap and documentation',
    'Provide follow-up support as needed'
  ] }
];
const TOTAL_TIMELINE_WEEKS = 14;

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
  // v5.6: 'onboarding' joins the allowed roles (drop the old 3-role check first).
  try {
    const rc = await db.query("SELECT conname FROM pg_constraint WHERE conrelid = 'user_roles'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%top_dog%'");
    for (const c of rc.rows) { await db.query('ALTER TABLE user_roles DROP CONSTRAINT ' + c.conname); }
    await db.query("ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check CHECK (role IN ('admin', 'steward', 'top_dog', 'onboarding'))");
  } catch (e) { console.error('Onboarding role migration:', e.message); }
  // v5.6: onboarding workflow tables. Documents are stored as bytea in Postgres.
  await db.query('CREATE TABLE IF NOT EXISTS onboarding_clients (' +
    'id SERIAL PRIMARY KEY, ' +
    'client_name TEXT NOT NULL, ' +
    "status TEXT NOT NULL DEFAULT 'in_progress', " +
    'payroll_provider TEXT, ' +
    'created_by INT REFERENCES stewards(id), ' +
    'created_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'initiated_at TIMESTAMPTZ, ' +
    'github_issue_number INT, ' +
    'github_repo TEXT)');
  await db.query('CREATE TABLE IF NOT EXISTS onboarding_documents (' +
    'id SERIAL PRIMARY KEY, ' +
    'client_id INT NOT NULL REFERENCES onboarding_clients(id) ON DELETE CASCADE, ' +
    "doc_type TEXT NOT NULL CHECK (doc_type IN ('master_application', 'pre_implementation', 'commission_sheet', 'w9', 'ach', 'soluta_billing_intake')), " +
    'file_name TEXT NOT NULL, ' +
    'mime_type TEXT, ' +
    'file_data BYTEA NOT NULL, ' +
    'uploaded_by INT REFERENCES stewards(id), ' +
    'uploaded_at TIMESTAMPTZ DEFAULT NOW())');
  await db.query('CREATE TABLE IF NOT EXISTS onboarding_issues (' +
    'id SERIAL PRIMARY KEY, ' +
    'client_id INT NOT NULL REFERENCES onboarding_clients(id) ON DELETE CASCADE, ' +
    "severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')), " +
    'doc_type TEXT, ' +
    'message TEXT NOT NULL, ' +
    'resolved BOOLEAN NOT NULL DEFAULT FALSE, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW())');
  await db.query('ALTER TABLE onboarding_issues ADD COLUMN IF NOT EXISTS resolution TEXT');
  await db.query('CREATE TABLE IF NOT EXISTS forms (' +
    'id SERIAL PRIMARY KEY, ' +
    'name TEXT UNIQUE NOT NULL, ' +
    'file_name TEXT NOT NULL, ' +
    'mime_type TEXT, ' +
    'file_data BYTEA NOT NULL, ' +
    'uploaded_by INT REFERENCES stewards(id), ' +
    'created_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'updated_at TIMESTAMPTZ DEFAULT NOW())');
  await db.query('ALTER TABLE onboarding_documents DROP CONSTRAINT IF EXISTS onboarding_documents_doc_type_check');
  await db.query("ALTER TABLE onboarding_documents ADD CONSTRAINT onboarding_documents_doc_type_check " +
    "CHECK (doc_type IN ('master_application', 'pre_implementation', 'commission_sheet', 'w9', 'ach', 'soluta_billing_intake'))");
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
function hasFullVisibility(user) {
  return user.activeRole === 'admin' || user.activeRole === 'top_dog' || user.activeRole === 'onboarding';
}

async function visibleCompanyIds(user) {
  if (hasFullVisibility(user)) return null;
  const r = await getPool().query('SELECT company_id FROM assignments WHERE steward_id = $1', [user.id]);
  return r.rows.map(x => x.company_id);
}

async function getVisibleCodes(user) {
  if (hasFullVisibility(user)) return null;
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
    const groups = groupParents(r.rows);
    // v5.3: attach open invoice count/total per company_code.
    try {
      const inv = await getPool().query(
        "SELECT company_code, COUNT(*)::int AS open_count, COALESCE(SUM(total_invoice), 0)::float AS open_total " +
        "FROM invoices WHERE status = 'open' GROUP BY company_code");
      const invMap = {};
      inv.rows.forEach(function (x) { invMap[String(x.company_code)] = x; });
      groups.forEach(function (g) {
        let oc = 0;
        let ot = 0;
        g.children.forEach(function (ch) {
          const s = invMap[String(ch.company_code)];
          if (s) {
            oc += s.open_count;
            ot += s.open_total;
            ch.open_invoices = s.open_count;
            ch.open_total = s.open_total;
          } else {
            ch.open_invoices = 0;
            ch.open_total = 0;
          }
        });
        g.open_invoices = oc;
        g.open_total = ot;
      });
    } catch (e) { console.error('Invoice stats error:', e); }
    res.json(groups);
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
    const timeline = await buildTimeline(getPool(), req.params.id);
    res.json({ implementation: impl, messages: msgs.rows, summaries: sums.rows, timeline: timeline });
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
    if (req.user.activeRole === 'onboarding') return res.status(403).json({ error: 'Not available for this role' });
    const db = getPool();
    const ids = await visibleCompanyIds(req.user);
    const codes = await getVisibleCodes(req.user);
    let coWhere = '';
    const coParams = [];
    if (ids) {
      if (ids.length === 0) {
        return res.json({ totalClients: 0, clientsByStage: [], totalLives: 0, totalEnrolled: 0, billingOpen: { count: 0, total: 0 }, billingPaid: { count: 0, total: 0 } });
      }
      coWhere = 'WHERE c.id = ANY($1)';
      coParams.push(ids);
    }
    const tc = await db.query('SELECT COUNT(*)::int AS c FROM companies c ' + coWhere, coParams);
    const tl = await db.query(
      'SELECT COALESCE(SUM(COALESCE(c.payroll_qualified, c.payroll_total - COALESCE(c.payroll_ineligible, 0) - COALESCE(c.payroll_opted_out, 0))), 0)::int AS t ' +
      'FROM companies c ' + coWhere, coParams);
    // v5.4: Total Enrolled = sum of payroll_enrolled across each company's latest payroll.
    const te = await db.query(
      'SELECT COALESCE(SUM(c.payroll_enrolled), 0)::int AS t FROM companies c ' + coWhere, coParams);
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
    // v5.3: total enrolled from the most recent payroll_dataset_date.
    let enrolledLast = { rows: [] };
    try {
      let eWhere = 'WHERE c.payroll_dataset_date IS NOT NULL';
      const eParams = [];
      if (ids) {
        eParams.push(ids);
        eWhere += ' AND c.id = ANY($' + eParams.length + ')';
      }
      enrolledLast = await db.query(
        'SELECT COALESCE(SUM(c.payroll_enrolled), 0)::int AS t, MAX(c.payroll_dataset_date)::text AS d ' +
        'FROM companies c ' + eWhere + ' AND c.payroll_dataset_date = (' +
        'SELECT MAX(c2.payroll_dataset_date) FROM companies c2 ' +
        (ids ? 'WHERE c2.id = ANY($1) AND c2.payroll_dataset_date IS NOT NULL' : 'WHERE c2.payroll_dataset_date IS NOT NULL') + ')',
        eParams);
    } catch (e) { console.error('Enrolled last payroll error:', e); }
    res.json({
      totalClients: tc.rows[0].c,
      clientsByStage: st.rows,
      totalLives: tl.rows[0].t,
      totalEnrolled: te.rows[0].t,
      billingOpen: billingOpen,
      billingPaid: billingPaid,
      enrolledLastPayroll: enrolledLast.rows[0] ? enrolledLast.rows[0].t : 0,
      lastPayrollDate: enrolledLast.rows[0] ? enrolledLast.rows[0].d : null
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- v5: billing
app.get('/api/billing', requireAuth, async (req, res) => {
  try {
    if (req.user.activeRole === 'onboarding') return res.status(403).json({ error: 'Not available for this role' });
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
    const allowed = ['admin', 'steward', 'top_dog', 'onboarding'];
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

// Map a GitHub board Status value onto the canonical five phases.
function normalizeStage(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'No Status';
  for (const c of STAGES) {
    if (c.toLowerCase() === s.toLowerCase()) return c;
  }
  if (s.toLowerCase() === 'onboarding ihia') return 'Initiation';
  return s;
}

// Build the 14-week timeline for one implementation. The clock starts the
// first time the project entered Initiation (falls back to the earliest
// recorded stage entry for older projects).
async function buildTimeline(db, implId) {
  const DAY = 24 * 60 * 60 * 1000;
  let r = await db.query(
    "SELECT MIN(entered_at) AS initiation_at FROM stage_history WHERE implementation_id = $1 AND stage = 'Initiation'",
    [implId]);
  let start = (r.rows[0] && r.rows[0].initiation_at) ? new Date(r.rows[0].initiation_at) : null;
  if (!start) {
    const e = await db.query(
      'SELECT MIN(entered_at) AS first_at FROM stage_history WHERE implementation_id = $1', [implId]);
    if (e.rows[0] && e.rows[0].first_at) start = new Date(e.rows[0].first_at);
  }
  if (!start || isNaN(start.getTime())) return { started: false, blocks: [] };
  const st = await db.query('SELECT stage FROM implementations WHERE id = $1', [implId]);
  const currentStage = st.rows.length ? String(st.rows[0].stage || '') : '';
  const today = new Date();
  const weekElapsed = Math.max(0, Math.floor((today.getTime() - start.getTime()) / (7 * DAY)));
  const blocks = TIMELINE.map(function (b) {
    const sDate = new Date(start.getTime() + b.startWeek * 7 * DAY);
    const eDate = new Date(start.getTime() + b.endWeek * 7 * DAY);
    return {
      stage: b.stage, block: b.block, startWeek: b.startWeek, endWeek: b.endWeek,
      startDate: sDate.toISOString().slice(0, 10), endDate: eDate.toISOString().slice(0, 10),
      duties: b.duties,
      done: weekElapsed >= b.endWeek,
      current: weekElapsed >= b.startWeek && weekElapsed < b.endWeek
    };
  });
  let cur = null;
  for (const b of blocks) { if (b.current) cur = b; }
  const expectedStage = weekElapsed >= TOTAL_TIMELINE_WEEKS ? 'Complete' : (cur ? cur.stage : blocks[0].stage);
  const curIdx = STAGES.indexOf(currentStage);
  const expIdx = STAGES.indexOf(expectedStage);
  const onTrack = curIdx === -1 || curIdx >= expIdx;
  let daysBehind = 0;
  if (!onTrack) {
    const mine = blocks.filter(function (b) { return b.stage === currentStage; });
    if (mine.length) {
      const endMs = new Date(mine[mine.length - 1].endDate + 'T00:00:00Z').getTime();
      daysBehind = Math.max(0, Math.floor((today.getTime() - endMs) / DAY));
    }
  }
  return {
    started: true,
    startDate: start.toISOString().slice(0, 10),
    weekElapsed: weekElapsed,
    currentStage: currentStage,
    expectedStage: expectedStage,
    onTrack: onTrack,
    daysBehind: daysBehind,
    goLiveDate: new Date(start.getTime() + TOTAL_TIMELINE_WEEKS * 7 * DAY).toISOString().slice(0, 10),
    blocks: blocks
  };
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
      const stage = normalizeStage(status);
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

// v5.3: Weekly email. Gathers the last 7 days of activity, asks Claude to write
// a personalized summary for each steward/top dog/admin, and sends via Resend.
// Emphasis: to-dos assigned to the recipient, updates on their companies.
async function runWeeklyEmail(daysBack) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set (weekly email needs Resend)');
  const db = getPool();
  const days = daysBack || 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const nl = String.fromCharCode(10);

  // All recipients: stewards with an email who hold steward, top_dog, or admin.
  const recips = await db.query(
    "SELECT DISTINCT s.id, s.email, s.first_name, s.last_name, s.name " +
    "FROM stewards s JOIN user_roles r ON r.steward_id = s.id " +
    "WHERE s.email IS NOT NULL AND s.email <> '' AND r.role IN ('steward', 'top_dog', 'admin')");
  if (recips.rows.length === 0) return { success: true, sent: 0, note: 'No recipients with email addresses' };

  const results = [];
  for (const recip of recips.rows) {
    try {
      const roles = await userRoles(db, recip.id);
      const isTopDog = roles.indexOf('top_dog') !== -1;
      const isAdmin = roles.indexOf('admin') !== -1;

      // Companies in scope: assigned ones, or all for top dog / admin.
      let companies = [];
      if (isTopDog || isAdmin) {
        const c = await db.query('SELECT id, company_code, company_name FROM companies ORDER BY company_code');
        companies = c.rows;
      } else {
        const c = await db.query(
          'SELECT c.id, c.company_code, c.company_name FROM companies c ' +
          'JOIN assignments a ON a.company_id = c.id WHERE a.steward_id = $1 ORDER BY c.company_code', [recip.id]);
        companies = c.rows;
      }
      const companyIds = companies.map(function (c) { return c.id; });
      const companyCodes = companies.map(function (c) { return String(c.company_code); });
      const recipName = [recip.first_name, recip.last_name].filter(Boolean).join(' ') || recip.name || recip.email;

      // Activity in the window.
      let summaries = [];
      let messages = [];
      let stageChanges = [];
      let invoices = [];
      if (companyIds.length > 0) {
        const s = await db.query(
          'SELECT s.summary_date, s.body, c.company_name, c.company_code FROM implementation_summaries s ' +
          'JOIN implementations i ON i.id = s.implementation_id ' +
          'JOIN companies c ON c.id = i.company_id ' +
          'WHERE i.company_id = ANY($1) AND s.summary_date >= $2 ORDER BY s.summary_date DESC LIMIT 30',
          [companyIds, since]);
        summaries = s.rows;
        const m = await db.query(
          'SELECT m.created_at, m.body, m.author_name, c.company_name, c.company_code FROM messages m ' +
          'JOIN implementations i ON i.id = m.implementation_id ' +
          'JOIN companies c ON c.id = i.company_id ' +
          'WHERE i.company_id = ANY($1) AND m.created_at >= $2 ORDER BY m.created_at DESC LIMIT 40',
          [companyIds, since]);
        messages = m.rows;
        const sh = await db.query(
          'SELECT sh.entered_at, sh.stage, c.company_name, c.company_code FROM stage_history sh ' +
          'JOIN implementations i ON i.id = sh.implementation_id ' +
          'JOIN companies c ON c.id = i.company_id ' +
          'WHERE i.company_id = ANY($1) AND sh.entered_at >= $2 ORDER BY sh.entered_at DESC LIMIT 30',
          [companyIds, since]);
        stageChanges = sh.rows;
      }
      if (companyCodes.length > 0) {
        const inv = await db.query(
          'SELECT company_code, company_name, payroll_date, lives_count, total_invoice, status, paid_date, created_at ' +
          'FROM invoices WHERE company_code = ANY($1) AND created_at >= $2 ORDER BY created_at DESC LIMIT 30',
          [companyCodes, since]);
        invoices = inv.rows;
      }
      // Open invoices (current to-dos on the money side).
      let openInv = [];
      if (companyCodes.length > 0) {
        const oi = await db.query(
          "SELECT company_code, company_name, payroll_date, total_invoice FROM invoices " +
          "WHERE company_code = ANY($1) AND status = 'open' ORDER BY payroll_date DESC LIMIT 20",
          [companyCodes]);
        openInv = oi.rows;
      }

      const fmtList = function (arr, fn) {
        return arr.length === 0 ? '(none)' : arr.map(fn).join(nl);
      };
      const prompt =
        'You are writing a Friday weekly summary email for ' + recipName +
        ' (' + roles.join(', ') + ') at iM4 Health. Cover the last ' + days + ' days.' + nl + nl +
        'THEIR COMPANIES (' + companies.length + '):' + nl +
        fmtList(companies.slice(0, 40), function (c) { return '- ' + c.company_name + ' (' + c.company_code + ')'; }) + nl + nl +
        'NEW SUMMARIES THIS WEEK:' + nl +
        fmtList(summaries, function (s) {
          return '- ' + s.company_name + ' (' + s.company_code + '), ' + String(s.summary_date).slice(0, 10) + ': ' + String(s.body || '').slice(0, 500);
        }) + nl + nl +
        'STAGE CHANGES THIS WEEK:' + nl +
        fmtList(stageChanges, function (s) {
          return '- ' + s.company_name + ' (' + s.company_code + '): entered ' + s.stage + ' on ' + String(s.entered_at).slice(0, 10);
        }) + nl + nl +
        'RECENT MESSAGES:' + nl +
        fmtList(messages, function (m) {
          return '- ' + m.company_name + ' (' + m.company_code + '), ' + (m.author_name || 'unknown') + ': ' + String(m.body || '').slice(0, 300);
        }) + nl + nl +
        'NEW INVOICES THIS WEEK:' + nl +
        fmtList(invoices, function (v) {
          return '- ' + v.company_name + ' (' + v.company_code + '): $' + v.total_invoice + ' (' + v.status + ')';
        }) + nl + nl +
        'OPEN INVOICES (still owed):' + nl +
        fmtList(openInv, function (v) {
          return '- ' + v.company_name + ' (' + v.company_code + '): $' + v.total_invoice;
        }) + nl + nl +
        'Write the email in this format:' + nl +
        'Subject line: one line, e.g. "Your iM4 weekly summary: <date range>"' + nl + nl +
        'WEEK IN REVIEW:' + nl +
        '- 3-5 bullets on what actually happened this week across their companies' + nl + nl +
        'YOUR TO-DOS (emphasis here — things assigned to ' + recipName + ' or needing their attention):' + nl +
        '- each bullet: WHAT, which COMPANY, and DUE DATE or TBD. Pull from summaries, messages, stage stalls, and open invoices.' + nl + nl +
        'COMPANY UPDATES:' + nl +
        '- one short paragraph or 1-2 bullets per company that had activity; skip companies with nothing new' + nl + nl +
        'Keep it plain-spoken and tight. No preamble, no sign-off. If there was genuinely no activity, say so in one line and list the standing open items.';

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }]
        })
      });
      if (!resp.ok) throw new Error('Anthropic API returned ' + resp.status);
      const data = await resp.json();
      const text = (data.content || []).filter(function (p) { return p.type === 'text'; }).map(function (p) { return p.text; }).join(nl).trim();

      // Split subject from body.
      let subject = 'Your iM4 weekly summary';
      let body = text;
      const subjMatch = text.match(/^(subject[^:]*:\s*)(.+)$/im);
      if (subjMatch) {
        subject = subjMatch[2].trim();
        body = text.slice(subjMatch[0].length).trim();
      }
      const html = '<div style="font-family: sans-serif; max-width: 640px">' +
        escHtml(body).replace(/\n/g, '<br>') + '</div>';

      const sent = await sendEmail(recip.email, subject, html);
      results.push({ email: recip.email, sent: !sent.skipped, error: sent.error || null });
    } catch (e) {
      console.error('Weekly email failed for ' + recip.email + ':', e.message);
      results.push({ email: recip.email, sent: false, error: e.message });
    }
  }
  const sentCount = results.filter(function (r) { return r.sent; }).length;
  return { success: true, sent: sentCount, total: results.length, results: results };
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------- weekly email (Friday nights + on demand)
app.post('/api/admin/run-weekly-email', requireAdmin, async (req, res) => {
  try {
    const days = req.body && req.body.days ? parseInt(req.body.days, 10) : 7;
    res.json(await runWeeklyEmail(days));
  } catch (error) {
    console.error('Weekly email error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Same weekly email, triggered by cron via sync secret (no JWT needed).
app.post('/api/admin/run-weekly-email-cron', async (req, res) => {
  if (!checkSyncSecret(req, res)) return;
  try {
    const days = req.body && req.body.days ? parseInt(req.body.days, 10) : 7;
    res.json(await runWeeklyEmail(days));
  } catch (error) {
    console.error('Weekly email cron error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
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


// ---------------------------------------------------------------- onboarding workflow (v5.6)
const ONBOARDING_DOC_TYPES = ['master_application', 'pre_implementation', 'commission_sheet', 'w9', 'ach'];
const SINGLE_DOC_TYPES = ['master_application', 'pre_implementation', 'commission_sheet'];
const DOC_LABELS = {
  master_application: 'Master Application',
  pre_implementation: 'Pre-Implementation Form',
  commission_sheet: 'Commission Sheet',
  w9: 'W-9',
  ach: 'ACH Authorization',
  soluta_billing_intake: 'Soluta Billing Intake Form'
};
const GITHUB_ISSUES_OWNER = process.env.GITHUB_ISSUES_OWNER || 'im4health-implementation';
const GITHUB_ISSUES_REPO = process.env.GITHUB_ISSUES_REPO || 'Implementation';
const GITHUB_PROJECT_ID = process.env.GITHUB_PROJECT_ID || 'PVT_kwDOEB2rr84BTidM';
const GITHUB_STATUS_FIELD_ID = process.env.GITHUB_STATUS_FIELD_ID || 'PVTSSF_lADOEB2rr84BTidM';

const multer = require('multer');
const onboardingUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
function handleUpload(field) {
  return function (req, res, next) {
    onboardingUpload.single(field)(req, res, function (err) {
      if (err) return res.status(400).json({ error: 'Upload failed: ' + err.message });
      next();
    });
  };
}

function requireOnboarder(req, res, next) {
  requireAuth(req, res, function () {
    const roles = req.user.roles || [];
    if (roles.indexOf('admin') !== -1 || roles.indexOf('onboarding') !== -1) return next();
    return res.status(403).json({ error: 'Onboarding access only' });
  });
}

// Forms tab: visible to top_dog, onboarding, and admin.
function requireFormsViewer(req, res, next) {
  requireAuth(req, res, function () {
    const r = req.user && req.user.activeRole;
    if (r === 'admin' || r === 'top_dog' || r === 'onboarding') return next();
    return res.status(403).json({ error: 'Not available for this role' });
  });
}

// Layout-aware PDF text extraction: items are sorted top-to-bottom, left-to-right
// and grouped into lines, so filled-in form values stay next to their labels.
let pdfjsLib = null;
function getPdfjs() {
  if (!pdfjsLib) pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  return pdfjsLib;
}

async function extractPdfLines(pdfBuffer) {
  const pdfjs = getPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBuffer), useSystemFonts: true }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items
      .map(function (it) { return { str: it.str, x: it.transform[4], y: it.transform[5] }; })
      .filter(function (it) { return it.str.trim() !== ''; });
    items.sort(function (a, b) { return (b.y - a.y) || (a.x - b.x); });
    const groups = [];
    items.forEach(function (it) {
      let g = null;
      for (let i = 0; i < groups.length; i++) {
        if (Math.abs(groups[i].y - it.y) < 4) { g = groups[i]; break; }
      }
      if (!g) { g = { y: it.y, items: [] }; groups.push(g); }
      g.items.push(it);
    });
    groups.sort(function (a, b) { return b.y - a.y; });
    const lines = groups.map(function (g) {
      g.items.sort(function (a, b) { return a.x - b.x; });
      return g.items.map(function (it) { return it.str; }).join(' ').replace(/\s+/g, ' ').trim();
    }).filter(function (x) { return x !== ''; });
    pages.push({ page: p, lines: lines });
  }
  if (doc.destroy) { try { await doc.destroy(); } catch (e) {} }
  return pages;
}

async function extractPdfText(pdfBuffer) {
  const pages = await extractPdfLines(pdfBuffer);
  return pages.map(function (pg) { return pg.lines.join('\n'); }).join('\n');
}

// Find the POLICYHOLDER INFORMATION section (usually page 2) and capture the
// applicant name printed under it. Returns { name, page }.
async function extractApplicantName(pdfBuffer) {
  const pages = await extractPdfLines(pdfBuffer);
  for (const pg of pages) {
    const lines = pg.lines;
    for (let i = 0; i < lines.length; i++) {
      const low = lines[i].toLowerCase();
      if (low.indexOf('policyholder information') !== -1 || low.indexOf('policy holder information') !== -1) {
        const parts = [];
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const l = lines[j];
          if (!l) continue;
          const ll = l.toLowerCase();
          if (ll.indexOf('full legal name') !== -1) break;
          if (/^(address|city|phone|fax|type of business|requested effective date)/i.test(ll)) break;
          parts.push(l);
          if (parts.join(' ').length > 120) break;
        }
        const name = parts.join(' ').replace(/\s+/g, ' ').trim();
        if (name) return { name: name, page: pg.page };
      }
    }
  }
  return { name: '', page: 0 };
}

function readWorkbook(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const out = {};
  wb.SheetNames.forEach(function (sn) {
    out[sn] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: null, blankrows: false });
  });
  return out;
}

// Find a label cell (starts-with, case-insensitive, trailing colon ignored)
// and return the first non-empty cell after it in the same row.
function rowValueByLabel(rows, label) {
  const key = String(label).toLowerCase().replace(/:$/, '');
  for (const r of rows) {
    if (!r) continue;
    for (let i = 0; i < r.length; i++) {
      const c = r[i];
      if (c === null || c === undefined) continue;
      const cell = String(c).trim().toLowerCase().replace(/:$/, '');
      if (cell === key || cell.indexOf(key) === 0) {
        for (let j = i + 1; j < r.length; j++) {
          const v = r[j];
          if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
        }
        return '';
      }
    }
  }
  return '';
}

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(inc|llc|ltd|co|corp|corporation|incorporated)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

// Audit one onboarding client for document completeness. Replaces the open
// issues with a fresh list and returns { issues, canInitiate }.

// ---------------------------------------------------------------- Soluta Billing Intake generation
// Data extraction + DOCX fill for the "Generate Soluta Billing Intake Form"
// button on the onboarding page. The blank is an ordinary Word document
// (tables); filling is done structurally by table/row/cell position, so the
// blank stored on the Forms tab needs no template tags.

const PREIMPL_LABELS = [
  ['Legal Name of the Company', 'legalName'],
  ['Employer Address', 'address'],
  ['Billing Contact (First and Last Name)', 'billingContact'],
  ['Billing Contact Email', 'billingEmail'],
  ['Employer Tax ID', 'taxId'],
  ['Name of Individual signing DocuSign', 'signerName'],
  ['Email of individual signing DocuSign', 'signerEmail'],
  ['Payroll Provider Company', 'payrollProvider'],
  ['Payroll Frequency', 'payrollFreq'],
  ['Payroll Frequency #2 (if applicable)', 'payrollFreq2'],
  ['Multiple Payroll Batches', 'multiBatches']
];

function normLabel(s) { return String(s || '').trim().toLowerCase().replace(/:$/, ''); }

// Parse a Pre-Implementation workbook into per-EIN blocks. Handles the
// multi-EIN layout (an "EIN #1..#N" header row with value columns under each)
// and the single-EIN layout (label/value pairs).
function extractPreImplEins(buffer) {
  const sheets = readWorkbook(buffer);
  const keys = Object.keys(sheets);
  const rows = keys.length ? sheets[keys[0]] : [];
  const cell = function (r, i) {
    const v = r && r[i];
    return (v === null || v === undefined) ? '' : String(v).trim();
  };
  let valCols = null;
  for (const r of rows) {
    if (!r) continue;
    const cols = [];
    for (let i = 0; i < r.length; i++) {
      if (/^EIN #\d+\s*$/i.test(cell(r, i))) cols.push(i);
    }
    if (cols.length > 0) { valCols = cols; break; }
  }
  if (!valCols) {
    const one = {};
    PREIMPL_LABELS.forEach(function (pair) { one[pair[1]] = rowValueByLabel(rows, pair[0]); });
    return [one];
  }
  const blocks = valCols.map(function () { return {}; });
  PREIMPL_LABELS.forEach(function (pair) { blocks.forEach(function (b) { b[pair[1]] = ''; }); });
  const labelHit = function (cellLab, want) {
    if (cellLab === want) return true;
    return cellLab.indexOf(want) === 0 && /[^a-z0-9]/.test(cellLab.slice(want.length, want.length + 1) || ' ');
  };
  for (const r of rows) {
    if (!r) continue;
    const lab = normLabel(cell(r, 1) || cell(r, 0));
    for (const pair of PREIMPL_LABELS) {
      if (labelHit(lab, normLabel(pair[0]))) {
        valCols.forEach(function (ci, bi) {
          const v = cell(r, ci);
          if (v && !blocks[bi][pair[1]]) blocks[bi][pair[1]] = v;
        });
        break;
      }
    }
  }
  // Some filers misalign columns (e.g. a tax ID typed into the email row).
  // Reassign by value shape so each field holds what it claims.
  const isEIN = function (v) { return /^\d{2}-\d{7}$/.test(v); };
  const isEmail = function (v) { return v.indexOf('@') !== -1; };
  blocks.forEach(function (b) {
    if (!isEIN(b.taxId)) {
      if (isEIN(b.billingEmail)) { b.taxId = b.billingEmail; b.billingEmail = ''; }
      else if (isEIN(b.billingContact)) { b.taxId = b.billingContact; b.billingContact = ''; }
      else b.taxId = '';
    }
    if (b.billingEmail && !isEmail(b.billingEmail)) {
      if (isEmail(b.billingContact)) { b.billingEmail = b.billingContact; b.billingContact = ''; }
      else b.billingEmail = '';
    }
    if (isEmail(b.billingContact)) b.billingContact = '';
  });
  return blocks.filter(function (b) { return b.legalName || b.taxId; });
}

function extractCommission(buffer) {
  const sheets = readWorkbook(buffer);
  const keys = Object.keys(sheets);
  const rows = keys.length ? sheets[keys[0]] : [];
  const get = function (label) {
    const key = String(label).toLowerCase();
    for (const r of rows) {
      if (r && r[0] && String(r[0]).trim().toLowerCase() === key) {
        const v = r[1];
        return (v === null || v === undefined) ? '' : String(v).trim();
      }
    }
    return '';
  };
  return {
    groupName: get('Group Name'),
    agencyName: get('Agency Name'),
    agents: [get('Agent 1 Name'), get('Agent 2 Name'), get('Agent 3 Name')].filter(function (a) { return !!a; }),
    effectiveDate: get('Effective Date')
  };
}

// Pull {name, taxId} from uploaded W-9 PDFs so agent rows can carry tax IDs.
async function extractW9TaxIds(w9docs) {
  const out = [];
  for (const w of w9docs) {
    try {
      const text = await extractPdfText(w.file_data);
      let nm = '';
      const m1 = text.match(/name \(as shown on your income tax return\)[^\n\r]*\n([^\n\r]{2,80})/i);
      if (m1 && m1[1].trim() && !/^(2|business name)/i.test(m1[1].trim())) nm = m1[1].trim();
      if (!nm) {
        const m2 = text.match(/business name[^\n\r]*\n([^\n\r]{2,80})/i);
        if (m2 && m2[1].trim() && !/^(3|check|disregarded)/i.test(m2[1].trim())) nm = m2[1].trim();
      }
      let taxId = '';
      const dashed = text.match(/\b(\d{2})-(\d{7})\b/);
      if (dashed) taxId = dashed[1] + '-' + dashed[2];
      else {
        const plain = text.match(/\b\d{9}\b/);
        if (plain) taxId = plain[0].slice(0, 2) + '-' + plain[0].slice(2);
      }
      out.push({ name: nm, taxId: taxId, fileName: w.file_name });
    } catch (e) { out.push({ name: '', taxId: '', fileName: w.file_name }); }
  }
  return out;
}

function normCoName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    .replace(/(llc|incorporated|inc|corporation|corp|company|co|limited|ltd|pllc|group)$/, '');
}

// Match a location to the app's company list for the iM4H Group ID column.
function matchCompanyCode(companies, legalName) {
  const n = normCoName(legalName);
  if (!n) return '';
  for (const c of companies) {
    if (normCoName(c.company_name) === n) return c.company_code;
  }
  return '';
}

function detectBillingMode(eins) {
  const b = eins && eins[0] ? eins[0] : {};
  const h = ((b.payrollFreq2 || '') + ' ' + (b.multiBatches || '') + ' ' + (b.payrollFreq || '')).toLowerCase();
  if (/semi.monthly|semimonthly/.test(h)) return 'Semi-monthly';
  if (/bi.weekly|biweekly/.test(h)) return 'Bi-weekly';
  if (/(^|[^a-z])weekly/.test(h)) return 'Weekly';
  if (/monthly/.test(h)) return 'Monthly';
  return 'Semi-monthly';
}

function escXml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Fill the blank Soluta Billing Intake DOCX structurally.
// data: { groupName, locations:[{name,ein,groupId,notes}], primary:{name,email},
//         billing:{name,email}, brokerProducer:{name}, agents:[{name,taxId}], mode }
function fillSolutaDocx(blankBuffer, data) {
  const PizZip = require('pizzip');
  const zip = new PizZip(blankBuffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('Not a Word document: word/document.xml is missing');
  let xml = file.asText();

  const tables = [];
  const tblRe = /<w:tbl[\s\S]*?<\/w:tbl>/g;
  let tm;
  while ((tm = tblRe.exec(xml)) !== null) tables.push({ start: tm.index, end: tm.index + tm[0].length, xml: tm[0] });
  if (tables.length < 4) throw new Error('Unexpected form layout: found ' + tables.length + ' tables, need 4');

  const rowsOf = function (tblXml) {
    const rows = [];
    const re = /<w:tr[\s\S]*?<\/w:tr>/g;
    let mm;
    while ((mm = re.exec(tblXml)) !== null) rows.push(mm[0]);
    return rows;
  };
  const cellsOf = function (trXml) {
    const cells = [];
    const re = /<w:tc[\s\S]*?<\/w:tc>/g;
    let mm;
    while ((mm = re.exec(trXml)) !== null) cells.push(mm[0]);
    return cells;
  };
  const setCellText = function (tcXml, text) {
    const pr = tcXml.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/);
    const tcPr = pr ? pr[0] : '';
    const open = tcXml.match(/^<w:tc(\s[^>]*)?>/);
    return '<w:tc' + (open && open[1] ? open[1] : '') + '>' + tcPr +
      '<w:p><w:r><w:t xml:space="preserve">' + escXml(text) + '</w:t></w:r></w:p></w:tc>';
  };
  const setRowCells = function (trXml, texts) {
    const cells = cellsOf(trXml);
    const out = cells.map(function (c, i) { return setCellText(c, texts[i] !== undefined ? texts[i] : ''); });
    return trXml.replace(/<w:tc[\s\S]*?<\/w:tc>/g, function () { return out.shift(); });
  };
  const buildTable = function (tblXml, newRows) {
    const first = tblXml.indexOf('<w:tr');
    const last = tblXml.lastIndexOf('</w:tr>') + '</w:tr>'.length;
    return tblXml.slice(0, first) + newRows.join('') + tblXml.slice(last);
  };

  const mode = data.mode || 'Semi-monthly';
  const newTables = tables.map(function (t) { return t.xml; });

  // Table 0: general info (Group Name value in row 0, second column)
  let r0 = rowsOf(tables[0].xml);
  const labelTc = cellsOf(r0[0])[0];
  let labelText = '';
  const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let tM;
  while ((tM = tRe.exec(labelTc)) !== null) labelText += tM[1];
  labelText = labelText.replace(/&(amp|lt|gt|quot);/g, function (e) { return { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' }[e]; });
  r0[0] = setRowCells(r0[0], [labelText, data.groupName || '']);
  newTables[0] = buildTable(tables[0].xml, r0);

  // Table 1: locations (header + data rows; clone last row if more locations)
  let r1 = rowsOf(tables[1].xml);
  const tmplRow = r1[r1.length - 1];
  const locRows = [r1[0]];
  data.locations.forEach(function (loc, i) {
    const src = r1[1 + i] || tmplRow;
    locRows.push(setRowCells(src, [loc.name, loc.ein, loc.groupId, loc.notes]));
  });
  newTables[1] = buildTable(tables[1].xml, locRows);

  // Table 2: contacts
  let r2 = rowsOf(tables[2].xml);
  const contactRows = [r2[0]];
  const mkContact = function (srcRow, type, name, phone, email) {
    return setRowCells(srcRow, [type, name || '', phone || '', email || '', mode]);
  };
  contactRows.push(mkContact(r2[1], 'Primary Contact', data.primary.name, '', data.primary.email));
  contactRows.push(mkContact(r2[2], 'Billing Contact', data.billing.name, '', data.billing.email));
  contactRows.push(mkContact(r2[3], 'Broker Producer', data.brokerProducer.name, '', ''));
  contactRows.push(r2[4]); // Broker Account Manager stays as-is (blank)
  const otherTmpl = r2[4];
  contactRows.push(setRowCells(otherTmpl, ['Other', '', '', '', '']));
  contactRows.push(setRowCells(otherTmpl, ['Other', '', '', '', '']));
  newTables[2] = buildTable(tables[2].xml, contactRows);

  // Table 3: PEPM rows. Row 1 (agency starter row from the template) is kept as-is;
  // agent rows fill the blank rows below, cloning if there are more agents.
  let r3 = rowsOf(tables[3].xml);
  const pepmRows = [r3[0], r3[1]];
  const pepmTmpl = r3[r3.length - 1];
  const modeSuffix = mode.toLowerCase();
  data.agents.forEach(function (a, i) {
    const src = r3[2 + i] || pepmTmpl;
    const who = a.name + (a.taxId ? ' \u2013 ' + a.taxId : '');
    pepmRows.push(setRowCells(src, [who, '$5.00/' + modeSuffix]));
  });
  newTables[3] = buildTable(tables[3].xml, pepmRows);

  // splice tables back (reverse order keeps offsets valid)
  for (let i = tables.length - 1; i >= 0; i--) {
    xml = xml.slice(0, tables[i].start) + newTables[i] + xml.slice(tables[i].end);
  }

  // billing-mode "checkboxes" (box-drawing chars): check the chosen mode
  const normMode = function (s) { return String(s).replace(/[☐☒]/g, '').toLowerCase().replace(/[^a-z]/g, ''); };
  const want = normMode(mode);
  const MODES = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
  xml = xml.replace(/<w:p[\s\S]*?<\/w:p>/g, function (p) {
    if (p.indexOf('☐') === -1 && p.indexOf('☒') === -1) return p;
    const label = normMode(p.replace(/<[^>]+>/g, ''));
    if (MODES.indexOf(label) === -1) return p;
    const checked = label === want;
    return p.replace(/[☐☒]/g, checked ? '☒' : '☐');
  });

  zip.file('word/document.xml', xml);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function runOnboardingAudit(db, clientId) {
  const issues = [];
  const push = function (severity, docType, message) { issues.push({ severity: severity, doc_type: docType, message: message }); };
  const c = await db.query('SELECT * FROM onboarding_clients WHERE id = $1', [clientId]);
  if (c.rows.length === 0) return { issues: [], canInitiate: false };
  const docs = await db.query('SELECT * FROM onboarding_documents WHERE client_id = $1 ORDER BY uploaded_at', [clientId]);
  const byType = {};
  docs.rows.forEach(function (d) { (byType[d.doc_type] = byType[d.doc_type] || []).push(d); });

  ONBOARDING_DOC_TYPES.forEach(function (t) {
    if (!byType[t] || byType[t].length === 0) push('critical', t, 'Missing: ' + DOC_LABELS[t] + ' has not been uploaded yet.');
  });

  let masterName = '';
  const md = byType.master_application && byType.master_application[0];
  if (md) {
    try {
      const text = await extractPdfText(md.file_data);
      masterName = (await extractApplicantName(md.file_data)).name;
      if (!masterName) push('critical', 'master_application', 'Could not find the applicant name under POLICYHOLDER INFORMATION. Check that this file is the Master Application.');
      const eff = text.match(/requested effective date\s*:?\s*([^\n\r]{1,40})/i);
      if (!eff || !eff[1].replace(/[_\s]/g, '')) push('warning', 'master_application', 'Requested Effective Date looks blank on the application.');
      if (text.toLowerCase().indexOf('in witness whereof') === -1) push('warning', 'master_application', 'No signature page found. The application may be unsigned.');
    } catch (e) { push('warning', 'master_application', 'Could not read the Master Application PDF (' + e.message + '). Verify it manually.'); }
  }

  let preName = '', payrollProvider = '';
  const pd = byType.pre_implementation && byType.pre_implementation[0];
  if (pd) {
    try {
      const sheets = readWorkbook(pd.file_data);
      const keys = Object.keys(sheets);
      const rows = keys.length ? sheets[keys[0]] : [];
      const checks = [
        ['Legal Name of the Company', true, 'Legal company name'],
        ['Employer Address', false, 'Employer address'],
        ['Billing Contact', false, 'Billing contact'],
        ['Billing Contact Email', false, 'Billing contact email'],
        ['Employer Tax ID', true, 'Employer Tax ID'],
        ['Payroll Provider Company', true, 'Payroll provider'],
        ['Payroll Frequency', false, 'Payroll frequency'],
        ['Last Payroll Run Date', false, 'Last payroll run date'],
        ['Name of Individual signing DocuSign', false, 'Signer name']
      ];
      checks.forEach(function (ck) {
        if (!rowValueByLabel(rows, ck[0])) push(ck[1] ? 'critical' : 'warning', 'pre_implementation', 'Pre-Implementation Form: "' + ck[2] + '" is blank.');
      });
      preName = rowValueByLabel(rows, 'Legal Name of the Company');
      payrollProvider = rowValueByLabel(rows, 'Payroll Provider Company');
      if (payrollProvider) await db.query('UPDATE onboarding_clients SET payroll_provider = $1 WHERE id = $2', [payrollProvider, clientId]);
    } catch (e) { push('warning', 'pre_implementation', 'Could not read the Pre-Implementation Form (' + e.message + '). Verify it manually.'); }
  }

  let commName = '';
  const sd = byType.commission_sheet && byType.commission_sheet[0];
  if (sd) {
    try {
      const sheets = readWorkbook(sd.file_data);
      const keys = Object.keys(sheets);
      const rows = keys.length ? sheets[keys[0]] : [];
      const get = function (label) {
        const key = label.toLowerCase();
        for (const r of rows) {
          if (r && r[0] && String(r[0]).trim().toLowerCase() === key) {
            const v = r[1];
            return (v === null || v === undefined) ? '' : String(v).trim();
          }
        }
        return '';
      };
      if (!get('Group Name')) push('critical', 'commission_sheet', 'Commission Sheet: Group Name is blank.');
      else commName = get('Group Name');
      if (!get('Agency Name')) push('warning', 'commission_sheet', 'Commission Sheet: Agency Name is blank.');
      if (!get('Agent 1 Name')) push('warning', 'commission_sheet', 'Commission Sheet: Agent 1 Name is blank.');
      if (!get('Broker Name')) push('warning', 'commission_sheet', 'Commission Sheet: Broker Name is blank.');
      if (!get('Effective Date')) push('warning', 'commission_sheet', 'Commission Sheet: Effective Date is blank.');
      if (!get('Product (s)')) push('warning', 'commission_sheet', 'Commission Sheet: Product(s) is blank.');
    } catch (e) { push('warning', 'commission_sheet', 'Could not read the Commission Sheet (' + e.message + '). Verify it manually.'); }
  }

  const w9s = byType.w9 || [];
  for (const w of w9s) {
    try {
      const text = await extractPdfText(w.file_data);
      const digits = text.replace(/[^0-9]/g, '');
      let nm = '';
      const m1 = text.match(/name \(as shown on your income tax return\)[^\n\r]*\n([^\n\r]{2,80})/i);
      if (m1 && m1[1].trim() && !/^(2|business name)/i.test(m1[1].trim())) nm = m1[1].trim();
      if (!nm) {
        const m2 = text.match(/business name[^\n\r]*\n([^\n\r]{2,80})/i);
        if (m2 && m2[1].trim() && !/^(3|check|disregarded)/i.test(m2[1].trim())) nm = m2[1].trim();
      }
      if (!nm) push('warning', 'w9', 'W-9 (' + w.file_name + '): could not find the name on line 1.');
      if (digits.length < 9) push('warning', 'w9', 'W-9 (' + w.file_name + '): no tax ID number found.');
      push('info', 'w9', 'W-9 (' + w.file_name + '): verify the signature and date visually; neither can be confirmed from the document text.');
    } catch (e) { push('warning', 'w9', 'W-9 (' + w.file_name + '): could not read the PDF (' + e.message + '). Verify it manually.'); }
  }

  const achs = byType.ach || [];
  for (const a of achs) {
    try {
      const text = await extractPdfText(a.file_data);
      if (text.replace(/\s/g, '').length < 60) {
        push('warning', 'ach', 'ACH (' + a.file_name + '): could not read the document text. Verify the routing and account numbers visually.');
      } else {
        const routingHit = text.match(/\b[0123][0-9]{8}\b/);
        const digitRuns = text.match(/\b[0-9]{4,17}\b/g) || [];
        const accountHit = digitRuns.filter(function (n) { return !routingHit || n !== routingHit[0]; });
        if (!routingHit) push('critical', 'ach', 'ACH (' + a.file_name + '): no bank routing number found.');
        if (accountHit.length === 0) push('critical', 'ach', 'ACH (' + a.file_name + '): no bank account number found.');
      }
    } catch (e) { push('warning', 'ach', 'ACH (' + a.file_name + '): could not read the file (' + e.message + '). Verify it manually.'); }
  }

  const names = [];
  if (masterName) names.push(['Master Application', masterName]);
  if (preName) names.push(['Pre-Implementation Form', preName]);
  if (commName) names.push(['Commission Sheet', commName]);
  for (let i = 1; i < names.length; i++) {
    if (normName(names[i][1]) !== normName(names[0][1])) {
      push('warning', null, 'Name mismatch: ' + names[i][0] + ' says "' + names[i][1] + '" but ' + names[0][0] + ' says "' + names[0][1] + '". Confirm the legal name.');
    }
  }

  const prev = await db.query('SELECT message, resolution FROM onboarding_issues WHERE client_id = $1 AND resolved = TRUE AND resolution IS NOT NULL', [clientId]);
  const prevMap = {};
  prev.rows.forEach(function (r) { prevMap[r.message] = r.resolution; });
  await db.query('DELETE FROM onboarding_issues WHERE client_id = $1 AND resolved = FALSE', [clientId]);
  for (const is of issues) {
    const prior = prevMap[is.message] || null;
    await db.query('INSERT INTO onboarding_issues (client_id, severity, doc_type, message, resolved, resolution) VALUES ($1, $2, $3, $4, $5, $6)',
      [clientId, is.severity, is.doc_type, is.message, !!prior, prior]);
  }
  const canInitiate = ONBOARDING_DOC_TYPES.every(function (t) { return byType[t] && byType[t].length > 0; }) &&
    !issues.some(function (x) { return x.severity === 'critical'; });
  return { issues: issues, canInitiate: canInitiate };
}

// Create a GitHub issue for an initiated client.
async function ghCreateIssue(title, body) {
  const resp = await fetch('https://api.github.com/repos/' + GITHUB_ISSUES_OWNER + '/' + GITHUB_ISSUES_REPO + '/issues', {
    method: 'POST', headers: ghHeaders(), body: JSON.stringify({ title: title, body: body })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error('GitHub issue creation failed: ' + (data.message || resp.status));
  return data;
}

// Add an issue to the kanban board and set its Status. Throws when the token
// lacks the project scope; the caller decides how to degrade.
async function ghBoardAddCard(issueNodeId, statusName) {
  const q = 'query { organization(login: "' + GITHUB_ORG + '") { projectV2(number: ' + GITHUB_PROJECT + ') { fields(first: 30) { nodes { __typename ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }';
  let resp = await fetch('https://api.github.com/graphql', { method: 'POST', headers: ghHeaders(), body: JSON.stringify({ query: q }) });
  let data = await resp.json();
  if (!resp.ok || data.errors) throw new Error('GitHub board lookup failed' + (data.errors ? ': ' + data.errors[0].message : ''));
  let fieldId = GITHUB_STATUS_FIELD_ID, optionId = null;
  const fields = data.data.organization.projectV2.fields.nodes;
  for (const f of fields) {
    if (f.name === 'Status') {
      if (f.id) fieldId = f.id;
      for (const o of (f.options || [])) { if (o.name === statusName) optionId = o.id; }
    }
  }
  if (!optionId) throw new Error('Status option "' + statusName + '" was not found on the board');
  const addMut = 'mutation($projectId: ID!, $contentId: ID!) { addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) { item { id } } }';
  resp = await fetch('https://api.github.com/graphql', { method: 'POST', headers: ghHeaders(),
    body: JSON.stringify({ query: addMut, variables: { projectId: GITHUB_PROJECT_ID, contentId: issueNodeId } }) });
  data = await resp.json();
  if (!resp.ok || data.errors) throw new Error('Could not add the card to the board' + (data.errors ? ': ' + data.errors[0].message : ' (HTTP ' + resp.status + ')'));
  const itemId = data.data.addProjectV2ItemById.item.id;
  const setMut = 'mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) { updateProjectV2ItemFieldValue(input: {projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: {singleSelectOptionId: $optionId}}) { projectV2Item { id } } }';
  resp = await fetch('https://api.github.com/graphql', { method: 'POST', headers: ghHeaders(),
    body: JSON.stringify({ query: setMut, variables: { projectId: GITHUB_PROJECT_ID, itemId: itemId, fieldId: fieldId, optionId: optionId } }) });
  data = await resp.json();
  if (!resp.ok || data.errors) throw new Error('Card added, but the status could not be set' + (data.errors ? ': ' + data.errors[0].message : ''));
  return itemId;
}

// List clients with document and open-critical-issue counts.
app.get('/api/onboarding', requireOnboarder, async (req, res) => {
  try {
    const r = await getPool().query(
      "SELECT c.*, " +
      "(SELECT COUNT(*)::int FROM onboarding_documents d WHERE d.client_id = c.id) AS doc_count, " +
      "(SELECT COUNT(*)::int FROM onboarding_issues i WHERE i.client_id = c.id AND i.resolved = FALSE AND i.severity = 'critical') AS critical_open " +
      "FROM onboarding_clients c ORDER BY CASE WHEN c.status = 'in_progress' THEN 0 ELSE 1 END, c.created_at DESC");
    res.json(r.rows);
  } catch (error) { console.error('Onboarding list error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// Extract the suggested client name from an uploaded Master Application (no storage).
app.post('/api/onboarding/parse-master', requireOnboarder, handleUpload('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const found = await extractApplicantName(req.file.buffer);
    res.json({ suggestedName: found.name, page: found.page });
  } catch (error) { console.error('Parse master error:', error); res.status(500).json({ error: 'Could not read that PDF: ' + error.message }); }
});

// Create a client: locks in the Master Application and runs the first audit.
app.post('/api/onboarding', requireOnboarder, handleUpload('masterApp'), async (req, res) => {
  try {
    const clientName = String(req.body.clientName || '').trim();
    if (!clientName) return res.status(400).json({ error: 'Client name is required' });
    if (!req.file) return res.status(400).json({ error: 'Master Application file is required' });
    const db = getPool();
    const r = await db.query('INSERT INTO onboarding_clients (client_name, created_by) VALUES ($1, $2) RETURNING *', [clientName, req.user.id]);
    const client = r.rows[0];
    await db.query("INSERT INTO onboarding_documents (client_id, doc_type, file_name, mime_type, file_data, uploaded_by) VALUES ($1, 'master_application', $2, $3, $4, $5)",
      [client.id, req.file.originalname, req.file.mimetype, req.file.buffer, req.user.id]);
    await runOnboardingAudit(db, client.id);
    res.json(client);
  } catch (error) { console.error('Onboarding create error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// Client detail: documents, open issues, and whether Initiate is allowed.
app.get('/api/onboarding/:id', requireOnboarder, async (req, res) => {
  try {
    const db = getPool();
    const c = await db.query('SELECT * FROM onboarding_clients WHERE id = $1', [req.params.id]);
    if (c.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const d = await db.query('SELECT id, doc_type, file_name, mime_type, uploaded_at, LENGTH(file_data) AS size FROM onboarding_documents WHERE client_id = $1 ORDER BY uploaded_at', [req.params.id]);
    const i = await db.query("SELECT * FROM onboarding_issues WHERE client_id = $1 AND resolved = FALSE ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at", [req.params.id]);
    const client = c.rows[0];
    const h = await db.query("SELECT resolution, COUNT(*)::int AS n FROM onboarding_issues WHERE client_id = $1 AND resolved = TRUE AND resolution IS NOT NULL GROUP BY resolution", [req.params.id]);
    client.documents = d.rows;
    client.issues = i.rows;
    client.handled = h.rows;
    client.canInitiate = client.status === 'in_progress' &&
      ONBOARDING_DOC_TYPES.every(function (t) { return d.rows.some(function (x) { return x.doc_type === t; }); }) &&
      !i.rows.some(function (x) { return x.severity === 'critical'; });
    res.json(client);
  } catch (error) { console.error('Onboarding detail error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// Upload a document (single-slot types replace; W-9 and ACH append).
app.post('/api/onboarding/:id/documents', requireOnboarder, handleUpload('file'), async (req, res) => {
  try {
    const docType = String(req.body.docType || '');
    if (ONBOARDING_DOC_TYPES.indexOf(docType) === -1) return res.status(400).json({ error: 'Unknown document type' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const db = getPool();
    const c = await db.query('SELECT id, status FROM onboarding_clients WHERE id = $1', [req.params.id]);
    if (c.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (c.rows[0].status !== 'in_progress') return res.status(400).json({ error: 'This client has already been sent to GitHub' });
    if (SINGLE_DOC_TYPES.indexOf(docType) !== -1) {
      await db.query('DELETE FROM onboarding_documents WHERE client_id = $1 AND doc_type = $2', [req.params.id, docType]);
    }
    await db.query('INSERT INTO onboarding_documents (client_id, doc_type, file_name, mime_type, file_data, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.params.id, docType, req.file.originalname, req.file.mimetype, req.file.buffer, req.user.id]);
    const audit = await runOnboardingAudit(db, req.params.id);
    res.json({ ok: true, canInitiate: audit.canInitiate });
  } catch (error) { console.error('Onboarding upload error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// Delete one document, then re-audit.
app.delete('/api/onboarding/:id/documents/:docId', requireOnboarder, async (req, res) => {
  try {
    const db = getPool();
    const c = await db.query('SELECT id, status FROM onboarding_clients WHERE id = $1', [req.params.id]);
    if (c.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (c.rows[0].status !== 'in_progress') return res.status(400).json({ error: 'This client has already been sent to GitHub' });
    await db.query('DELETE FROM onboarding_documents WHERE id = $1 AND client_id = $2', [req.params.docId, req.params.id]);
    const audit = await runOnboardingAudit(db, req.params.id);
    res.json({ ok: true, canInitiate: audit.canInitiate });
  } catch (error) { console.error('Onboarding doc delete error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// Download a document.
app.get('/api/onboarding/:id/documents/:docId/download', requireOnboarder, async (req, res) => {
  try {
    const r = await getPool().query('SELECT file_name, mime_type, file_data FROM onboarding_documents WHERE id = $1 AND client_id = $2', [req.params.docId, req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const d = r.rows[0];
    res.set('Content-Type', d.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="' + String(d.file_name).replace(/"/g, '') + '"');
    res.send(d.file_data);
  } catch (error) { console.error('Onboarding download error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// Re-run the completeness audit.
app.post('/api/onboarding/:id/audit', requireOnboarder, async (req, res) => {
  try {
    const audit = await runOnboardingAudit(getPool(), req.params.id);
    res.json({ ok: true, issues: audit.issues, canInitiate: audit.canInitiate });
  } catch (error) { console.error('Onboarding audit error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// Mark one issue as evaluated/resolved.
app.post('/api/onboarding/:id/issues/:issueId/resolve', requireOnboarder, async (req, res) => {
  try {
    const resolution = String((req.body && req.body.resolution) || 'dismissed') === 'overridden' ? 'overridden' : 'dismissed';
    await getPool().query('UPDATE onboarding_issues SET resolved = TRUE, resolution = $1 WHERE id = $2 AND client_id = $3', [resolution, req.params.issueId, req.params.id]);
    res.json({ ok: true });
  } catch (error) { console.error('Onboarding issue resolve error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// Initiate: create the GitHub card, board it under Initiation, move the client to Complete.
app.post('/api/onboarding/:id/initiate', requireOnboarder, async (req, res) => {
  try {
    const nl = String.fromCharCode(10);
    const db = getPool();
    const c = await db.query('SELECT * FROM onboarding_clients WHERE id = $1', [req.params.id]);
    if (c.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const client = c.rows[0];
    if (client.status !== 'in_progress') return res.status(400).json({ error: 'This client has already been sent to GitHub' });
    const d = await db.query('SELECT doc_type, file_name FROM onboarding_documents WHERE client_id = $1 ORDER BY uploaded_at', [req.params.id]);
    const i = await db.query("SELECT COUNT(*)::int AS n FROM onboarding_issues WHERE client_id = $1 AND resolved = FALSE AND severity = 'critical'", [req.params.id]);
    const missing = ONBOARDING_DOC_TYPES.filter(function (t) { return !d.rows.some(function (x) { return x.doc_type === t; }); });
    if (missing.length > 0) return res.status(400).json({ error: 'Still missing: ' + missing.map(function (t) { return DOC_LABELS[t]; }).join(', ') });
    if (i.rows[0].n > 0) return res.status(400).json({ error: 'There are still unresolved critical issues. Evaluate them first.' });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GitHub is not connected on the server' });
    const title = client.client_name + '; ' + (client.payroll_provider || 'TBD') + '; Onboarding';
    const body = 'Client onboarded through the iM4 app.' + nl + nl +
      'Documents collected:' + nl +
      d.rows.map(function (x) { return '- ' + DOC_LABELS[x.doc_type] + ': ' + x.file_name; }).join(nl) + nl + nl +
      'Client: ' + client.client_name + nl +
      'Payroll provider: ' + (client.payroll_provider || 'TBD') + nl +
      'Onboarded: ' + new Date().toISOString().slice(0, 10);
    const issue = await ghCreateIssue(title, body);
    let boardOk = false, boardError = '';
    try {
      await ghBoardAddCard(issue.node_id, 'Onboarding (IHIA)');
      boardOk = true;
    } catch (e) { boardError = e.message; console.error('Board add failed:', e.message); }
    await db.query("UPDATE onboarding_clients SET status = 'complete', initiated_at = NOW(), github_issue_number = $1, github_repo = $2 WHERE id = $3",
      [issue.number, GITHUB_ISSUES_OWNER + '/' + GITHUB_ISSUES_REPO, req.params.id]);
    res.json({ ok: true, issueNumber: issue.number, issueUrl: issue.html_url, boardOk: boardOk, boardError: boardError });
  } catch (error) { console.error('Onboarding initiate error:', error); res.status(500).json({ error: error.message || 'Internal server error' }); }
});

// Admin: reopen an initiated onboarding card so its documents can be added,
// changed, or deleted, then re-initiated. Re-initiating creates a brand new
// GitHub card; the old GitHub issue is left for someone to delete manually.
app.post('/api/admin/onboarding/:id/reopen', requireAdmin, async (req, res) => {
  try {
    const db = getPool();
    const c = await db.query('SELECT id, status, client_name, github_issue_number FROM onboarding_clients WHERE id = $1', [req.params.id]);
    if (c.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (c.rows[0].status !== 'complete') return res.status(400).json({ error: 'Only initiated cards can be reopened' });
    await db.query("UPDATE onboarding_clients SET status = 'in_progress' WHERE id = $1", [req.params.id]);
    res.json({ ok: true, clientName: c.rows[0].client_name, previousIssue: c.rows[0].github_issue_number });
  } catch (error) { console.error('Onboarding reopen error:', error); res.status(500).json({ error: 'Internal server error' }); }
});


// ---------------------------------------------------------------- blank forms library
// The Forms tab stores blank forms (e.g. the Soluta Billing Intake Form)
// used to generate client paperwork. Visible to top_dog, onboarding, admin;
// uploads and deletes are admin-only.
app.get('/api/forms', requireFormsViewer, async (req, res) => {
  try {
    const r = await getPool().query('SELECT id, name, file_name, mime_type, uploaded_by, created_at, updated_at FROM forms ORDER BY name');
    res.json(r.rows);
  } catch (error) { console.error('Forms list error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/forms', requireAdmin, handleUpload('file'), async (req, res) => {
  try {
    const name = req.body && req.body.name ? String(req.body.name).trim() : '';
    if (!name) return res.status(400).json({ error: 'A form name is required' });
    if (!req.file) return res.status(400).json({ error: 'A file is required' });
    const db = getPool();
    const existing = await db.query('SELECT id FROM forms WHERE name = $1', [name]);
    if (existing.rows.length > 0) {
      await db.query('UPDATE forms SET file_name = $1, mime_type = $2, file_data = $3, uploaded_by = $4, updated_at = NOW() WHERE id = $5',
        [req.file.originalname, req.file.mimetype, req.file.buffer, req.user.id, existing.rows[0].id]);
      return res.json({ ok: true, id: existing.rows[0].id, replaced: true });
    }
    const ins = await db.query('INSERT INTO forms (name, file_name, mime_type, file_data, uploaded_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [name, req.file.originalname, req.file.mimetype, req.file.buffer, req.user.id]);
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (error) { console.error('Form upload error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/forms/:id/download', requireFormsViewer, async (req, res) => {
  try {
    const r = await getPool().query('SELECT file_name, mime_type, file_data FROM forms WHERE id = $1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const f = r.rows[0];
    res.set('Content-Type', f.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="' + String(f.file_name).replace(/"/g, '') + '"');
    res.send(f.file_data);
  } catch (error) { console.error('Form download error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/forms/:id', requireAdmin, async (req, res) => {
  try {
    await getPool().query('DELETE FROM forms WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) { console.error('Form delete error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// ---------------------------------------------------------------- generate Soluta Billing Intake Form
const SOLUTA_FORM_NAME = 'Soluta Billing Intake Form';

app.post('/api/onboarding/:id/generate-soluta', requireOnboarder, async (req, res) => {
  try {
    const db = getPool();
    const c = await db.query('SELECT * FROM onboarding_clients WHERE id = $1', [req.params.id]);
    if (c.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    if (c.rows[0].status !== 'in_progress') return res.status(400).json({ error: 'This client has already been sent to GitHub' });
    const docs = await db.query('SELECT * FROM onboarding_documents WHERE client_id = $1 ORDER BY uploaded_at', [req.params.id]);
    const byType = {};
    docs.rows.forEach(function (d) { (byType[d.doc_type] = byType[d.doc_type] || []).push(d); });
    if (!byType.pre_implementation || byType.pre_implementation.length === 0) {
      return res.status(400).json({ error: 'Upload the Pre-Implementation Form first' });
    }
    if (!byType.commission_sheet || byType.commission_sheet.length === 0) {
      return res.status(400).json({ error: 'Upload the Commission Sheet first' });
    }
    const fr = await db.query('SELECT * FROM forms WHERE name = $1 ORDER BY updated_at DESC LIMIT 1', [SOLUTA_FORM_NAME]);
    if (fr.rows.length === 0) {
      return res.status(400).json({ error: 'No blank "' + SOLUTA_FORM_NAME + '" on the Forms tab yet. Upload it there first.' });
    }

    const eins = extractPreImplEins(byType.pre_implementation[0].file_data);
    const comm = extractCommission(byType.commission_sheet[0].file_data);
    const w9s = await extractW9TaxIds(byType.w9 || []);
    const coRes = await db.query('SELECT company_code, company_name FROM companies');
    let mode = req.body && req.body.billingMode ? String(req.body.billingMode) : 'auto';
    if (mode === 'auto' || ['Weekly', 'Bi-weekly', 'Semi-monthly', 'Monthly'].indexOf(mode) === -1) {
      mode = detectBillingMode(eins);
    }

    const w9ByName = function (agentName) {
      const an = normCoName(agentName);
      for (const w of w9s) {
        const wn = normCoName(w.name);
        if (wn && an && (wn === an || wn.indexOf(an) !== -1 || an.indexOf(wn) !== -1)) return w.taxId;
      }
      return '';
    };

    const first = function (vals) {
      for (const v of vals) { if (v) return v; }
      return '';
    };
    const data = {
      groupName: comm.groupName || (eins[0] && eins[0].legalName) || c.rows[0].client_name || '',
      locations: eins.map(function (e) {
        return {
          name: e.legalName || '', ein: e.taxId || '',
          groupId: matchCompanyCode(coRes.rows, e.legalName), notes: e.address || ''
        };
      }),
      primary: { name: first(eins.map(function (e) { return e.signerName; })), email: first(eins.map(function (e) { return e.signerEmail; })) },
      billing: { name: first(eins.map(function (e) { return e.billingContact; })), email: first(eins.map(function (e) { return e.billingEmail; })) },
      brokerProducer: { name: comm.agents[0] || '' },
      agents: comm.agents.map(function (a) { return { name: a, taxId: w9ByName(a) }; }),
      mode: mode
    };

    const filled = fillSolutaDocx(fr.rows[0].file_data, data);
    const safeGroup = (data.groupName || 'Client').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Client';
    const now = new Date();
    const fileName = safeGroup + '_' + mode.replace(/-/g, '') + '_Billing_Intake_Form_' + (now.getMonth() + 1) + '.' + now.getDate() + '.' + now.getFullYear() + '.docx';

    await db.query("DELETE FROM onboarding_documents WHERE client_id = $1 AND doc_type = 'soluta_billing_intake'", [req.params.id]);
    const ins = await db.query(
      "INSERT INTO onboarding_documents (client_id, doc_type, file_name, mime_type, file_data, uploaded_by) VALUES ($1, 'soluta_billing_intake', $2, $3, $4, $5) RETURNING id",
      [req.params.id, fileName,
       'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
       filled, req.user.id]);
    res.json({ ok: true, docId: ins.rows[0].id, fileName: fileName });
  } catch (error) { console.error('Soluta generate error:', error); res.status(500).json({ error: error.message || 'Internal server error' }); }
});

// Delete a whole onboarding client card.
app.delete('/api/onboarding/:id', requireOnboarder, async (req, res) => {
  try {
    await getPool().query('DELETE FROM onboarding_clients WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) { console.error('Onboarding delete error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// ---------------------------------------------------------------- claude summaries (Sun-Thu nights + on demand)
async function claudeSummarize(db, impl, company, recentMessages, typical, timeline) {
  const nl = String.fromCharCode(10);
  const msgText = recentMessages.slice(-20).map(m => '- ' + (m.author_name || 'unknown') + ' (' + (m.when || '') + '): ' + String(m.body || '').slice(0, 400)).join(nl);
  const durLines = STAGES.map(function (s) {
    const t = typical[s];
    const days = t ? t.days + ' (observed over ' + t.cases + ' real cases)' : DEFAULT_STAGE_DAYS[s] + ' (default estimate)';
    return '- ' + s + ': ' + days + ' working days';
  }).join(nl);
  const stageEntered = impl.stage_entered_at ? new Date(impl.stage_entered_at).toLocaleDateString() : 'unknown';
  let tlText = 'No timeline yet (the project has not entered Initiation).';
  if (timeline && timeline.started) {
    tlText = timeline.blocks.map(function (b) {
      return 'Weeks ' + b.startWeek + '-' + b.endWeek + ' (' + b.startDate + ' to ' + b.endDate + '): ' +
        b.stage + ' - ' + b.block + '. Duties: ' + b.duties.join('; ') + '.';
    }).join(nl) +
    nl + 'Timeline started ' + timeline.startDate + ' (week ' + timeline.weekElapsed + ' of ' + TOTAL_TIMELINE_WEEKS + '). ' +
    'Current stage: ' + timeline.currentStage + '. Expected stage now: ' + timeline.expectedStage + '. ' +
    'Expected go-live: ' + timeline.goLiveDate + '. ' +
    (timeline.daysBehind > 0
      ? 'The project is ' + timeline.daysBehind + ' days behind the plan.'
      : 'The project is on the planned pace.');
  }
  const prompt = 'You are a project manager writing a brief nightly update for the project owner. ' +
    'Project: ' + company.company_name + ' (company code ' + company.company_code + '). ' +
    'Current stage: ' + (impl.stage || 'unknown') + ' (entered ' + stageEntered + ', ' + (impl.days_in_stage || 0) + ' days in stage). ' +
    'Status: ' + (impl.status || 'unknown') + '. Card: ' + (impl.card_title || '') + '.' + nl +
    'Typical working days per stage:' + nl + durLines + nl +
    'The 14-week implementation plan (the clock starts the day the project first entered Initiation):' + nl + tlText + nl +
    'Recent messages (newest last):' + nl + (msgText || '(none)') + nl + nl +
    'Write the update in EXACTLY this format:' + nl +
    'STATUS: RED, YELLOW, or GREEN (your judgment: RED = blocked or seriously off track, YELLOW = at risk or stalled, GREEN = on track)' + nl +
    'KEY DATES:' + nl +
    '- one bullet per important date: when the current stage started, expected completion of the current stage (use the 14-week plan above), expected go-live, and any due dates mentioned in the messages' + nl +
    'SUMMARY:' + nl +
    '- 1-2 sentences on the current status and what has been accomplished recently' + nl +
    '- Outstanding to-dos, each with WHAT needs doing, WHO owns it, and the DUE DATE (use TBD where unknown; draw the to-dos from the current phase duties in the plan above)' + nl +
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
        const timeline = await buildTimeline(db, impl.id);
        const body = await claudeSummarize(db, impl, impl, msgs.rows.reverse(), typical, timeline);
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
