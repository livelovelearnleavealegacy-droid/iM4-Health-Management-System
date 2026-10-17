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

// The 12-week implementation plan. The clock starts the first time a project
// enters the Initiation stage. Weeks are counted from that start date.
const TIMELINE = [
  { stage: 'Initiation', block: 'Kickoff', startWeek: 0, endWeek: 1, duties: [
    'Receive information from IHIA',
    'Receive intro from IHIA',
    'Send intro with availability to client',
    'Set introduction meeting',
    'Set up codes for express/2.0 if possible',
    'Complete introduction meeting and send recap, requirements, and generic education'
  ] },
  { stage: 'Data Gathering', block: 'Census and setup', startWeek: 1, endWeek: 5, duties: [
    'Receive census from client',
    'Review census from client and unhide reports',
    'Set up codes',
    'Unit test'
  ] },
  { stage: 'Implementation', block: 'Development and testing', startWeek: 5, endWeek: 6, duties: [
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
  { stage: 'Go Live', block: 'Go live', startWeek: 10, endWeek: 12, duties: [
    'Complete go live - training',
    'Send recap and documentation',
    'Provide follow-up support as needed'
  ] }
];
const TOTAL_TIMELINE_WEEKS = 12;

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
  // Nightly key updates: one row per implementation per day, only when that
  // day's messages contained something worth noting. Replaces the old
  // full-project summaries (that table is kept for history but no longer written).
  await db.query('CREATE TABLE IF NOT EXISTS implementation_updates (' +
    'id SERIAL PRIMARY KEY, ' +
    'implementation_id INT REFERENCES implementations(id) ON DELETE CASCADE, ' +
    'update_date DATE NOT NULL, ' +
    'body TEXT NOT NULL, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'UNIQUE(implementation_id, update_date))');
  // Private message filters: any message containing @github_username is hidden
  // from the app, the nightly updates, and the weekly email. Managed by admins
  // on the Jobs page (name + GitHub username, both editable).
  await db.query('CREATE TABLE IF NOT EXISTS private_message_filters (' +
    'id SERIAL PRIMARY KEY, ' +
    'name TEXT NOT NULL, ' +
    'github_username TEXT NOT NULL UNIQUE, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW())');
  // Site header logo: single row (id = 1) holding the uploaded image bytes.
  // Served at GET /api/logo; when empty the app falls back to logo.webp.
  await db.query('CREATE TABLE IF NOT EXISTS site_logo (' +
    'id INT PRIMARY KEY, ' +
    'file_name TEXT NOT NULL, ' +
    'mime_type TEXT NOT NULL, ' +
    'data BYTEA NOT NULL, ' +
    'uploaded_at TIMESTAMPTZ DEFAULT NOW())');
  // Commission splits: one row per (company, steward). Uploaded via the Jobs
  // page in wide format (one line per company, repeating steward_code,pct
  // pairs); each upload replaces the rows for every company code it mentions.
  await db.query('CREATE TABLE IF NOT EXISTS commissions (' +
    'id SERIAL PRIMARY KEY, ' +
    'company_code TEXT NOT NULL, ' +
    'steward_code INTEGER NOT NULL, ' +
    'pct NUMERIC NOT NULL, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'UNIQUE(company_code, steward_code))');
  // v5.13.x migration: the column started life as agent TEXT.
  const hasAgentCol = await db.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'commissions' AND column_name = 'agent'");
  if (hasAgentCol.rows.length > 0) {
    await db.query('ALTER TABLE commissions RENAME COLUMN agent TO steward_code');
  }
  const scType = await db.query(
    "SELECT data_type FROM information_schema.columns WHERE table_name = 'commissions' AND column_name = 'steward_code'");
  if (scType.rows.length > 0 && scType.rows[0].data_type !== 'integer') {
    await db.query("DELETE FROM commissions WHERE steward_code !~ '^[0-9]+$'");
    await db.query('ALTER TABLE commissions ALTER COLUMN steward_code TYPE INTEGER USING steward_code::integer');
  }
  // One-time 2026-10-07: superseded by the manual Renumber button
  // (POST /api/admin/stewards/:id/renumber). Kept as a no-op note.
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
    "bill_type TEXT NOT NULL DEFAULT 'F', " +
    'is_estimate BOOLEAN NOT NULL DEFAULT FALSE, ' +
    'bill_mode TEXT, ' +
    'ein TEXT, ' +
    'payroll_end_date DATE, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'updated_at TIMESTAMPTZ DEFAULT NOW())');
  await db.query("ALTER TABLE invoices ADD COLUMN IF NOT EXISTS bill_type TEXT NOT NULL DEFAULT 'F'");
  await db.query('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_estimate BOOLEAN NOT NULL DEFAULT FALSE');
  await db.query('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS bill_mode TEXT');
  await db.query('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS ein TEXT');
  await db.query('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payroll_end_date DATE');

  const cols = [
    ['stewards', 'role', "TEXT NOT NULL DEFAULT 'steward'"],
    ['stewards', 'password_hash', 'TEXT'],
    ['stewards', 'first_name', 'TEXT'],
    ['stewards', 'last_name', 'TEXT'],
    ['stewards', 'phone', 'TEXT'],
    ['stewards', 'steward_company_name', 'TEXT'],
    ['stewards', 'address', 'TEXT'],
    ['stewards', 'city', 'TEXT'],
    ['stewards', 'state', 'TEXT'],
    ['stewards', 'zip', 'TEXT'],
    ['stewards', 'payee', 'TEXT'],
    ['stewards', 'tax_id', 'TEXT'],
    ['stewards', 'statement_email', 'TEXT'],
    ['stewards', 'reset_token', 'TEXT'],
    ['stewards', 'reset_expires', 'TIMESTAMPTZ'],
    ['stewards', 'two_factor_enabled', 'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['stewards', 'created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ['companies', 'created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ['companies', 'company_status', "TEXT NOT NULL DEFAULT 'ACTIVE'"],
    ['companies', 'ein', 'TEXT'],
    ['companies', 'address_1', 'TEXT'],
    ['companies', 'city', 'TEXT'],
    ['companies', 'state', 'TEXT'],
    ['companies', 'zip', 'TEXT'],
    ['companies', 'parent_company_code', 'TEXT'],
    ['companies', 'parent_company_name', 'TEXT'],


    ['implementations', 'github_item_id', 'TEXT UNIQUE'],
    ['implementations', 'created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ['implementations', 'updated_at', 'TIMESTAMPTZ DEFAULT NOW()'],
    ['implementations', 'github_issue_number', 'INT'],
    ['implementations', 'github_repo', 'TEXT'],
    ['implementations', 'card_title', 'TEXT'],
    ['implementations', 'payroll_provider', 'TEXT'],
    ['implementations', 'payroll_frequency', 'TEXT'],
    ['implementations', 'total_employees', 'INT'],
    ['implementations', 'qualified_employee_count', 'INT'],
    ['implementations', 'impl_start_date', 'DATE'],
    ['implementations', 'notes', 'TEXT']
  ];
  for (const [table, col, def] of cols) {
    await db.query('ALTER TABLE ' + table + ' ADD COLUMN IF NOT EXISTS ' + col + ' ' + def);
  }
  // (The v5.46 company_status backfill that ran here referenced the active
  // boolean; v6.13.0 removed both - see the reconcile block below.)
  // v5: "parent" renamed to "ee" on import headings; carry existing values over.
  // v6.11.0 (Leroy): consolidate the parent fields into parent_company_code /
  // parent_company_name and drop the legacy ee_* columns for good. Copies
  // any ee value into the parent pair wherever the parent pair is empty,
  // then drops both ee columns. Guarded so later boots are no-ops.
  await db.query('DO $$ BEGIN ' +
    "IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'ee_company_code') THEN " +
    "UPDATE companies SET parent_company_code = ee_company_code WHERE (parent_company_code IS NULL OR parent_company_code = '') AND ee_company_code IS NOT NULL AND ee_company_code <> ''; " +
    "UPDATE companies SET parent_company_name = ee_company_name WHERE (parent_company_name IS NULL OR parent_company_name = '') AND ee_company_name IS NOT NULL AND ee_company_name <> ''; " +
    'ALTER TABLE companies DROP COLUMN ee_company_code; ' +
    'ALTER TABLE companies DROP COLUMN ee_company_name; ' +
    'END IF; END $$');
  // v6.11.1 (Leroy): companies.github_issue_number was never read or written
  // (the live issue numbers live on implementations and onboarding_clients)
  // and held no values - drop it. Its re-add entry above is also removed.
  await db.query('ALTER TABLE companies DROP COLUMN IF EXISTS github_issue_number');
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
    "doc_type TEXT NOT NULL CHECK (doc_type IN ('master_application', 'pre_implementation', 'commission_sheet', 'w9', 'ach', 'soluta_billing_intake', 'docusign_package')), " +
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
  await db.query('CREATE TABLE IF NOT EXISTS steward_documents (' +
    'steward_id INT NOT NULL REFERENCES stewards(id) ON DELETE CASCADE, ' +
    "doc_type TEXT NOT NULL CHECK (doc_type IN ('w9', 'ach')), " +
    'file_name TEXT NOT NULL, ' +
    'mime_type TEXT, ' +
    'file_data BYTEA NOT NULL, ' +
    'uploaded_by INT REFERENCES stewards(id), ' +
    'created_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'updated_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'PRIMARY KEY (steward_id, doc_type))');
  await db.query('ALTER TABLE onboarding_clients ADD COLUMN IF NOT EXISTS parent_code TEXT');
  await db.query('ALTER TABLE onboarding_clients ADD COLUMN IF NOT EXISTS parent_name TEXT');
  await db.query('ALTER TABLE onboarding_clients ADD COLUMN IF NOT EXISTS wizard_step INT');
  await db.query('ALTER TABLE onboarding_clients ADD COLUMN IF NOT EXISTS companies_json TEXT');
  await db.query('CREATE TABLE IF NOT EXISTS company_documents (' +
    'company_code TEXT PRIMARY KEY, ' +
    'file_name TEXT NOT NULL, ' +
    'mime_type TEXT, ' +
    'file_data BYTEA NOT NULL, ' +
    'uploaded_by INT REFERENCES stewards(id), ' +
    'created_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'updated_at TIMESTAMPTZ DEFAULT NOW())');
  // v6.6 (Leroy): Parent page — parents get their own table (Parent Code +
  // Parent Name are parent-level data) plus two file slots per parent.
  await db.query('CREATE TABLE IF NOT EXISTS parents (' +
    'parent_code TEXT PRIMARY KEY, ' +
    'parent_name TEXT NOT NULL, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'updated_at TIMESTAMPTZ DEFAULT NOW())');
  await db.query('CREATE TABLE IF NOT EXISTS company_ach_documents (' +
    'company_code TEXT PRIMARY KEY, ' +
    'file_name TEXT NOT NULL, ' +
    'mime_type TEXT, ' +
    'file_data BYTEA NOT NULL, ' +
    'uploaded_by INT REFERENCES stewards(id), ' +
    'created_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'updated_at TIMESTAMPTZ DEFAULT NOW())');
  await db.query('CREATE TABLE IF NOT EXISTS parent_documents (' +
    'parent_code TEXT NOT NULL, ' +
    'doc_kind TEXT NOT NULL CHECK (doc_kind IN (' + "'master_application', 'pre_implementation_checklist'" + ')), ' +
    'file_name TEXT NOT NULL, ' +
    'mime_type TEXT, ' +
    'file_data BYTEA NOT NULL, ' +
    'uploaded_by INT REFERENCES stewards(id), ' +
    'created_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'updated_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'PRIMARY KEY (parent_code, doc_kind))');
  // Seed parents from the parent codes already carried by companies.
  await db.query('INSERT INTO parents (parent_code, parent_name) ' +
    'SELECT parent_company_code, MAX(parent_company_name) FROM companies ' +
    "WHERE parent_company_code IS NOT NULL AND parent_company_code <> '' AND parent_company_name IS NOT NULL AND parent_company_name <> '' " +
    'GROUP BY parent_company_code ON CONFLICT (parent_code) DO NOTHING');
  await db.query('INSERT INTO parents (parent_code, parent_name) ' +
    'SELECT parent_company_code, MAX(parent_company_name) FROM companies ' +
    "WHERE parent_company_code IS NOT NULL AND parent_company_code <> '' AND parent_company_name IS NOT NULL AND parent_company_name <> '' " +
    'GROUP BY parent_company_code ON CONFLICT (parent_code) DO NOTHING');
  await db.query('ALTER TABLE onboarding_documents DROP CONSTRAINT IF EXISTS onboarding_documents_doc_type_check');
  await db.query("ALTER TABLE onboarding_documents ADD CONSTRAINT onboarding_documents_doc_type_check " +
    "CHECK (doc_type IN ('master_application', 'pre_implementation', 'commission_sheet', 'w9', 'ach', 'soluta_billing_intake', 'docusign_package'))");
  // v5.29: ticket system tables.
  await db.query('CREATE TABLE IF NOT EXISTS tickets (' +
    'id SERIAL PRIMARY KEY, ' +
    'company_code TEXT NOT NULL, ' +
    'title TEXT NOT NULL, ' +
    'description TEXT NOT NULL, ' +
    "category TEXT NOT NULL DEFAULT 'general', " +
    "priority TEXT NOT NULL DEFAULT 'medium', " +
    "status TEXT NOT NULL DEFAULT 'open', " +
    'created_by INT REFERENCES stewards(id), ' +
    'assigned_to INT REFERENCES stewards(id), ' +
    'created_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'updated_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'resolved_at TIMESTAMPTZ)');
  await db.query('CREATE TABLE IF NOT EXISTS ticket_replies (' +
    'id SERIAL PRIMARY KEY, ' +
    'ticket_id INT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, ' +
    'author_id INT REFERENCES stewards(id), ' +
    'body TEXT NOT NULL, ' +
    'is_internal BOOLEAN NOT NULL DEFAULT FALSE, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW())');
  await db.query('CREATE TABLE IF NOT EXISTS on_call_schedule (' +
    'id SERIAL PRIMARY KEY, ' +
    'steward_id INT NOT NULL REFERENCES stewards(id) ON DELETE CASCADE, ' +
    'start_date DATE NOT NULL, ' +
    'end_date DATE NOT NULL, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW())');
  // v5.29: 'client' and 'service' join the allowed roles.
  try {
    const rc2 = await db.query("SELECT conname FROM pg_constraint WHERE conrelid = 'user_roles'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%onboarding%'");
    for (const c of rc2.rows) { await db.query('ALTER TABLE user_roles DROP CONSTRAINT ' + c.conname); }
    await db.query("ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check CHECK (role IN ('admin', 'steward', 'top_dog', 'onboarding', 'client', 'service'))");
  } catch (e) { console.error('Client/service role migration:', e.message); }
  // v6.16 (Leroy): 'commissions' joins the allowed roles - the commission
  // calculation + statement generation role. Assignable by Admin only
  // (set-roles is requireAdmin) and, like 'admin', its assignments are
  // hidden from every non-admin viewer (see GET /api/admin/stewards).
  try {
    const has16 = await db.query("SELECT conname FROM pg_constraint WHERE conrelid = 'user_roles'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%commissions%'");
    if (has16.rows.length === 0) {
      const olds16 = await db.query("SELECT conname FROM pg_constraint WHERE conrelid = 'user_roles'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%role%'");
      for (const c of olds16.rows) { await db.query('ALTER TABLE user_roles DROP CONSTRAINT ' + c.conname); }
      await db.query("ALTER TABLE user_roles ADD CONSTRAINT user_roles_role_check CHECK (role IN ('admin', 'steward', 'top_dog', 'onboarding', 'client', 'service', 'commissions'))");
    }
  } catch (e) { console.error('Commissions role migration:', e.message); }
  // v6.17 (Leroy): referral fee (commission) calculation. A period is one
  // build tab on the Referral Fees page; source files (F = FTJ Premium
  // Applied Report, S = Soluta later) are validated on Jobs and calculated
  // into pending rows - one row per company, payroll (modal) date, and
  // steward. A (source, company, modal date) may be calculated only ONCE,
  // ever: re-imports of an already-calculated referral fee are ignored.
  await db.query('CREATE TABLE IF NOT EXISTS referral_fee_periods (' +
    'id SERIAL PRIMARY KEY, ' +
    'label TEXT NOT NULL, ' +
    "status TEXT NOT NULL DEFAULT 'open', " +
    'created_by INT, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'locked_at TIMESTAMPTZ)');
  await db.query('CREATE TABLE IF NOT EXISTS referral_fee_imports (' +
    'id SERIAL PRIMARY KEY, ' +
    'period_id INT NOT NULL REFERENCES referral_fee_periods(id) ON DELETE CASCADE, ' +
    "source TEXT NOT NULL DEFAULT 'F', " +
    'file_name TEXT, ' +
    'imported_by INT, ' +
    'groups_seen INT DEFAULT 0, ' +
    'lines_created INT DEFAULT 0, ' +
    'duplicates_ignored INT DEFAULT 0, ' +
    'rows_created INT DEFAULT 0, ' +
    "skipped JSONB DEFAULT '[]', " +
    'created_at TIMESTAMPTZ DEFAULT NOW())');
  await db.query('CREATE TABLE IF NOT EXISTS referral_fee_lines (' +
    'id SERIAL PRIMARY KEY, ' +
    'period_id INT NOT NULL REFERENCES referral_fee_periods(id) ON DELETE CASCADE, ' +
    'import_id INT REFERENCES referral_fee_imports(id) ON DELETE SET NULL, ' +
    "source TEXT NOT NULL DEFAULT 'F', " +
    'company_code TEXT NOT NULL, ' +
    'company_name TEXT, ' +
    'modal_date DATE NOT NULL, ' +
    'applied_date DATE, ' +
    'statement_date DATE NOT NULL, ' +
    'bill_mode TEXT, ' +
    'admin_fee NUMERIC NOT NULL DEFAULT 0, ' +
    'enrolled INT NOT NULL DEFAULT 0, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'UNIQUE (source, company_code, modal_date))');
  await db.query('CREATE TABLE IF NOT EXISTS referral_fee_pending (' +
    'id SERIAL PRIMARY KEY, ' +
    'line_id INT NOT NULL REFERENCES referral_fee_lines(id) ON DELETE CASCADE, ' +
    'period_id INT NOT NULL REFERENCES referral_fee_periods(id) ON DELETE CASCADE, ' +
    'company_code TEXT NOT NULL, ' +
    'steward_id INT, ' +
    'steward_name TEXT, ' +
    'pct NUMERIC NOT NULL, ' +
    'referral_fee NUMERIC NOT NULL, ' +
    'created_at TIMESTAMPTZ DEFAULT NOW())');
  // v6.17.1 (Leroy): ONE rounding adjustment record per period. Per-row
  // cent rounding makes the pending rows total a few cents off the admin
  // fee total; the difference is posted to RLJAT (steward 155026) as a
  // single adjustment so the period foots exactly.
  await db.query('CREATE TABLE IF NOT EXISTS referral_fee_adjustments (' +
    'id SERIAL PRIMARY KEY, ' +
    'period_id INT NOT NULL UNIQUE REFERENCES referral_fee_periods(id) ON DELETE CASCADE, ' +
    'steward_id INT, ' +
    'steward_name TEXT, ' +
    'amount NUMERIC NOT NULL DEFAULT 0, ' +
    'updated_at TIMESTAMPTZ DEFAULT NOW())');
  // v6.19: generated referral fee statements, one per payee per period.
  // content_hash covers everything that went into the file (statement
  // content + the Forms template itself), so regenerating can skip
  // unchanged statements and replace changed ones.
  await db.query('CREATE TABLE IF NOT EXISTS referral_fee_statements (' +
    'id SERIAL PRIMARY KEY, ' +
    'period_id INT NOT NULL REFERENCES referral_fee_periods(id) ON DELETE CASCADE, ' +
    'steward_id INT NOT NULL, ' +
    'payee_name TEXT, ' +
    'statement_date DATE, ' +
    'total NUMERIC(14,2) NOT NULL DEFAULT 0, ' +
    'file_name TEXT NOT NULL, ' +
    'file_data BYTEA NOT NULL, ' +
    'content_hash TEXT NOT NULL, ' +
    'generated_at TIMESTAMPTZ DEFAULT NOW(), ' +
    'generated_by INT, ' +
    'UNIQUE (period_id, steward_id))');
  // v6.20: statements also carry their lives (enrolled) total - it is a
  // headline number on the steward's Statements page. Backfilled from
  // the pending rows each statement was generated from.
  await db.query('ALTER TABLE referral_fee_statements ADD COLUMN IF NOT EXISTS enrolled INT');
  await db.query('UPDATE referral_fee_statements s SET enrolled = ' +
    '(SELECT COALESCE(SUM(l.enrolled), 0) FROM referral_fee_pending pp JOIN referral_fee_lines l ON l.id = pp.line_id ' +
    'WHERE pp.period_id = s.period_id AND pp.steward_id = s.steward_id) WHERE s.enrolled IS NULL');
  // v5.30: accounts receivable module.
  await db.query('CREATE TABLE IF NOT EXISTS ar_followups (' +
    'id SERIAL PRIMARY KEY, ' +
    'invoice_id INT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, ' +
    "action_type TEXT NOT NULL DEFAULT 'note', " +
    'notes TEXT, ' +
    'promise_date DATE, ' +
    'tier INT, ' +
    'created_by INT REFERENCES stewards(id), ' +
    'created_at TIMESTAMPTZ DEFAULT NOW())');
  await db.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_email TEXT');
  // v6.15.0 (Leroy): company-level pay_frequency, version, and type (from
  // his master spreadsheet), displayed on the Companies page and accepted
  // by the companies import.
  await db.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS pay_frequency TEXT');
  await db.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS version TEXT');
  await db.query('ALTER TABLE companies ADD COLUMN IF NOT EXISTS type TEXT');
  await db.query('ALTER TABLE invoices ADD COLUMN IF NOT EXISTS ar_hold BOOLEAN NOT NULL DEFAULT FALSE');
  await db.query('CREATE TABLE IF NOT EXISTS payroll_company_summary (' +
    'id SERIAL PRIMARY KEY, ' +
    'case_number TEXT, ' +
    'ein TEXT, ' +
    'employer_name TEXT, ' +
    'employer_location TEXT, ' +
    'state TEXT, ' +
    'zip TEXT, ' +
    'pay_schedule TEXT, ' +
    'cycle INT, ' +
    'period_year INT, ' +
    'period_quarter TEXT, ' +
    'period_month TEXT, ' +
    'period_day INT, ' +
    'employee_count INT NOT NULL DEFAULT 0, ' +
    'eligible_count INT NOT NULL DEFAULT 0, ' +
    'opt_out_count INT NOT NULL DEFAULT 0, ' +
    'new_count INT NOT NULL DEFAULT 0, ' +
    'total_gross_wages NUMERIC, ' +
    'total_net_pay NUMERIC, ' +
    'total_premium NUMERIC, ' +
    'total_admin_fee NUMERIC, ' +
    'total_benefit NUMERIC, ' +
    'total_claim NUMERIC, ' +
    'total_fica_savings NUMERIC, ' +
    'file_name TEXT, ' +
    'is_latest_case BOOLEAN, ' +
    'imported_at TIMESTAMPTZ DEFAULT NOW())');
  await db.query('ALTER TABLE payroll_company_summary ADD COLUMN IF NOT EXISTS ineligible_count INT NOT NULL DEFAULT 0');
  await db.query('ALTER TABLE payroll_company_summary ADD COLUMN IF NOT EXISTS enrolled_count INT NOT NULL DEFAULT 0');
  await db.query('CREATE TABLE IF NOT EXISTS ein_account_xref (' +
    'id SERIAL PRIMARY KEY, ' +
    'hop TEXT, ' +
    'grp TEXT, ' +
    'acct TEXT, ' +
    'tin TEXT, ' +
    'acct_name TEXT, ' +
    'addr1 TEXT, ' +
    'addr2 TEXT, ' +
    'city TEXT, ' +
    'state TEXT, ' +
    'zip TEXT, ' +
    'eff_date DATE, ' +
    'term_date DATE, ' +
    'file_name TEXT, ' +
    'imported_at TIMESTAMPTZ DEFAULT NOW())');
  await db.query("UPDATE stewards SET first_name = SPLIT_PART(name, ' ', 1) " +
    "WHERE (first_name IS NULL OR first_name = '') AND name IS NOT NULL AND name <> ''");
  await db.query("UPDATE stewards SET last_name = NULLIF(SUBSTRING(name FROM POSITION(' ' IN name) + 1), '') " +
    "WHERE (last_name IS NULL OR last_name = '') AND name IS NOT NULL AND POSITION(' ' IN name) > 0");
  // ---- v6.13.0 (Leroy): the companies.active boolean is redundant with
  // company_status. One-time reconcile in Leroy's order: where
  // company_status has a value it stays; where it is blank, active decides
  // (yes = ACTIVE, no = TERMED, neither = PENDING). Then drop the column;
  // every filter and writer uses company_status from here on.
  const legacyActive = await db.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'active'");
  if (legacyActive.rows.length) {
    await db.query("UPDATE companies SET company_status = CASE WHEN active IS TRUE THEN 'ACTIVE' WHEN active IS FALSE THEN 'TERMED' ELSE 'PENDING' END " +
      "WHERE company_status IS NULL OR company_status = ''");
    await db.query('ALTER TABLE companies DROP COLUMN active');
  }
  // ---- v6.12.0 (Leroy): payroll data moves OFF companies into
  // payroll_company_summary, which becomes the payroll table: one row per
  // case per import dataset, stamped with the company it belongs to, kept
  // as history. Companies keep no payroll columns; readers take each
  // company's latest payroll row (see payrollJoin).
  await db.query('ALTER TABLE payroll_company_summary ADD COLUMN IF NOT EXISTS company_code TEXT');
  await db.query('ALTER TABLE payroll_company_summary ADD COLUMN IF NOT EXISTS dataset_date DATE');
  await db.query('ALTER TABLE payroll_company_summary ADD COLUMN IF NOT EXISTS period_start DATE');
  await db.query('ALTER TABLE payroll_company_summary ADD COLUMN IF NOT EXISTS period_end DATE');
  await db.query('ALTER TABLE payroll_company_summary ADD COLUMN IF NOT EXISTS bill_premium NUMERIC');
  await db.query('ALTER TABLE payroll_company_summary ADD COLUMN IF NOT EXISTS bill_claims NUMERIC');
  await db.query('ALTER TABLE payroll_company_summary ADD COLUMN IF NOT EXISTS bill_admin NUMERIC');
  await db.query('ALTER TABLE payroll_company_summary ADD COLUMN IF NOT EXISTS bill_savings NUMERIC');
  await db.query('CREATE INDEX IF NOT EXISTS idx_payroll_summary_company ON payroll_company_summary (company_code, dataset_date DESC)');
  await db.query('UPDATE payroll_company_summary SET dataset_date = imported_at::date WHERE dataset_date IS NULL AND imported_at IS NOT NULL');
  await db.query("UPDATE payroll_company_summary SET period_end = make_date(period_year, period_month::int, period_day) " +
    "WHERE period_end IS NULL AND period_year IS NOT NULL AND period_month ~ '^[0-9]+$' AND period_month::int BETWEEN 1 AND 12 AND period_day BETWEEN 1 AND 31");
  // One-time legacy migration, only while companies still carries the old
  // payroll columns: stamp existing summary rows with their company, copy
  // the pushed bill values onto them, synthesize rows for any company whose
  // snapshot would otherwise be lost, then drop the 14 columns.
  const legacyPayroll = await db.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'payroll_total'");
  if (legacyPayroll.rows.length) {
    try {
      const acctByTin = {};
      const xr = await db.query('SELECT DISTINCT tin, acct FROM ein_account_xref WHERE tin IS NOT NULL AND acct IS NOT NULL');
      xr.rows.forEach(function (r) {
        const n = normEin(r.tin);
        if (!n || !r.acct) return;
        if (!acctByTin[n]) acctByTin[n] = [];
        acctByTin[n].push(String(r.acct).trim().replace(/^['"]+|['"]+$/g, ''));
      });
      const ce = await db.query('SELECT company_code, ein FROM companies WHERE ein IS NOT NULL');
      ce.rows.forEach(function (r) {
        const n = normEin(r.ein);
        if (!n || !r.company_code) return;
        if (!acctByTin[n]) acctByTin[n] = [];
        if (acctByTin[n].indexOf(r.company_code) === -1) acctByTin[n].push(r.company_code);
      });
      const coSet = {};
      ce.rows.forEach(function (r) { coSet[String(r.company_code)] = true; });
      const allCos = await db.query('SELECT company_code FROM companies');
      allCos.rows.forEach(function (r) { coSet[String(r.company_code)] = true; });
      const unstamped = await db.query('SELECT id, ein FROM payroll_company_summary WHERE company_code IS NULL AND ein IS NOT NULL');
      for (const row of unstamped.rows) {
        const accts = (acctByTin[normEin(row.ein)] || []).filter(function (a) { return coSet[a]; });
        if (!accts.length) continue;
        await db.query('UPDATE payroll_company_summary SET company_code = $1 WHERE id = $2', [accts[0], row.id]);
        for (let i = 1; i < accts.length; i++) {
          await db.query(
            'INSERT INTO payroll_company_summary (case_number, ein, employer_name, employer_location, state, zip, pay_schedule, cycle, period_year, period_quarter, period_month, period_day, employee_count, eligible_count, ineligible_count, opt_out_count, enrolled_count, new_count, total_gross_wages, total_net_pay, total_premium, total_admin_fee, total_benefit, total_claim, total_fica_savings, file_name, is_latest_case, company_code, dataset_date, period_start, period_end, bill_premium, bill_claims, bill_admin, bill_savings) ' +
            'SELECT case_number, ein, employer_name, employer_location, state, zip, pay_schedule, cycle, period_year, period_quarter, period_month, period_day, employee_count, eligible_count, ineligible_count, opt_out_count, enrolled_count, new_count, total_gross_wages, total_net_pay, total_premium, total_admin_fee, total_benefit, total_claim, total_fica_savings, file_name, is_latest_case, $2, dataset_date, period_start, period_end, bill_premium, bill_claims, bill_admin, bill_savings FROM payroll_company_summary WHERE id = $1',
            [row.id, accts[i]]);
        }
      }
      await db.query('UPDATE payroll_company_summary s SET bill_premium = c.payroll_bill_premium, bill_claims = c.payroll_bill_claims, bill_admin = c.payroll_bill_admin, bill_savings = c.payroll_bill_savings ' +
        'FROM companies c WHERE s.company_code = c.company_code AND s.dataset_date = c.payroll_dataset_date AND c.payroll_bill_premium IS NOT NULL');
      const orphans = await db.query(
        'SELECT c.company_code, c.company_name, c.payroll_total, c.payroll_qualified, c.payroll_ineligible, c.payroll_opted_out, c.payroll_enrolled, c.payroll_new_qualified, ' +
        'c.payroll_bill_premium, c.payroll_bill_claims, c.payroll_bill_admin, c.payroll_bill_savings, c.payroll_pay_schedule, c.payroll_ein, c.payroll_dataset_date ' +
        'FROM companies c WHERE (c.payroll_total IS NOT NULL OR c.payroll_dataset_date IS NOT NULL) ' +
        'AND NOT EXISTS (SELECT 1 FROM payroll_company_summary s WHERE s.company_code = c.company_code)');
      for (const o of orphans.rows) {
        await db.query(
          'INSERT INTO payroll_company_summary (ein, employer_name, pay_schedule, employee_count, eligible_count, ineligible_count, opt_out_count, enrolled_count, new_count, bill_premium, bill_claims, bill_admin, bill_savings, file_name, company_code, dataset_date) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
          [o.payroll_ein, o.company_name, o.payroll_pay_schedule, o.payroll_total || 0, o.payroll_qualified || 0, o.payroll_ineligible || 0,
           o.payroll_opted_out || 0, o.payroll_enrolled || 0, o.payroll_new_qualified || 0, o.payroll_bill_premium, o.payroll_bill_claims,
           o.payroll_bill_admin, o.payroll_bill_savings, 'legacy-companies-snapshot', o.company_code, o.payroll_dataset_date]);
      }
      // Drops happen only when every step above succeeded; on any error the
      // old columns stay and the migration retries on the next boot.
      await db.query('ALTER TABLE companies ' +
        'DROP COLUMN IF EXISTS payroll_total, DROP COLUMN IF EXISTS payroll_qualified, ' +
        'DROP COLUMN IF EXISTS payroll_ineligible, DROP COLUMN IF EXISTS payroll_opted_out, ' +
        'DROP COLUMN IF EXISTS payroll_enrolled, DROP COLUMN IF EXISTS payroll_not_enrolled, ' +
        'DROP COLUMN IF EXISTS payroll_new_qualified, DROP COLUMN IF EXISTS payroll_bill_premium, ' +
        'DROP COLUMN IF EXISTS payroll_bill_claims, DROP COLUMN IF EXISTS payroll_bill_admin, ' +
        'DROP COLUMN IF EXISTS payroll_bill_savings, DROP COLUMN IF EXISTS payroll_pay_schedule, ' +
        'DROP COLUMN IF EXISTS payroll_ein, DROP COLUMN IF EXISTS payroll_dataset_date');
    } catch (e) { console.error('Payroll migration error:', e.message); }
  }
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

// Stewards / Companies / Assignments admin pages are visible to Top Dogs too.
function requireAdminOrTopDog(req, res, next) {
  requireAuth(req, res, function () {
    const r = req.user && req.user.activeRole;
    if (r !== 'admin' && r !== 'top_dog') return res.status(403).json({ error: 'Admin or Top Dog only' });
    next();
  });
}

// Stewards page (v5.44): viewable by admin, top dog (view only), and
// onboarding; maintenance (add/edit/password) is admin + onboarding only.
function requireStewardsAccess(req, res, next) {
  requireAuth(req, res, function () {
    const r = req.user && req.user.activeRole;
    if (r !== 'admin' && r !== 'top_dog' && r !== 'onboarding') return res.status(403).json({ error: 'Admin, Top Dog, or Onboarding only' });
    next();
  });
}

// Companies page (v5.48): viewable by admin, top dog (view only), and
// onboarding; add/edit is admin + onboarding; delete is admin only.
function requireCompaniesAccess(req, res, next) {
  requireAuth(req, res, function () {
    const r = req.user && req.user.activeRole;
    if (r !== 'admin' && r !== 'top_dog' && r !== 'onboarding') return res.status(403).json({ error: 'Admin, Top Dog, or Onboarding only' });
    next();
  });
}

function requireAdminOrOnboarding(req, res, next) {
  requireAuth(req, res, function () {
    const r = req.user && req.user.activeRole;
    if (r !== 'admin' && r !== 'onboarding') return res.status(403).json({ error: 'Admin or Onboarding only' });
    next();
  });
}

// Companies maintenance pages (v6.7): Admin, Top Dog, and Onboarding.
function requireAdminTopDogOnboarding(req, res, next) {
  requireAuth(req, res, function () {
    const r = req.user && req.user.activeRole;
    if (r !== 'admin' && r !== 'top_dog' && r !== 'onboarding') return res.status(403).json({ error: 'Available to Admin, Top Dog, and Onboarding only' });
    next();
  });
}

// Commissions page data (v6.16, Leroy): Admin, Top Dog, Onboarding, and the
// Commissions role (view only). Row edits stay Admin + Onboarding and row
// delete stays Admin only - those endpoints keep their own guards.
function requireCommissionsPageViewer(req, res, next) {
  requireAuth(req, res, function () {
    const r = req.user && req.user.activeRole;
    if (r !== 'admin' && r !== 'top_dog' && r !== 'onboarding' && r !== 'commissions') return res.status(403).json({ error: 'Available to Admin, Top Dog, Onboarding, and Commissions only' });
    next();
  });
}

// Referral Fees pages (v6.17, Leroy): Admin and the Commissions role;
// v6.19 adds Top Dog as a viewer so statements can be downloaded by
// Admin and Top Dog, per Leroy.
function requireReferralViewer(req, res, next) {
  requireAuth(req, res, function () {
    const r = req.user && req.user.activeRole;
    if (r !== 'admin' && r !== 'commissions' && r !== 'top_dog') return res.status(403).json({ error: 'Referral Fees is available to Admin, Top Dog, and Commissions only' });
    next();
  });
}

// Parent page (v6.6, Leroy): visible to Admin, Top Dog, and Onboarding only.
function requireParentViewer(req, res, next) {
  requireAuth(req, res, function () {
    const r = req.user && req.user.activeRole;
    if (r !== 'admin' && r !== 'top_dog' && r !== 'onboarding') return res.status(403).json({ error: 'Parent page is available to Admin, Top Dog, and Onboarding only' });
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

// v6.12.0: payroll lives in payroll_company_summary now. This lateral join
// attaches each company's LATEST payroll row under the same payroll_* field
// names the companies table used to carry, so every reader keeps working.
function payrollJoin(alias) {
  const a = alias || 'c';
  return 'LEFT JOIN LATERAL (SELECT s.employee_count AS payroll_total, s.eligible_count AS payroll_qualified, ' +
    's.ineligible_count AS payroll_ineligible, s.opt_out_count AS payroll_opted_out, s.enrolled_count AS payroll_enrolled, ' +
    'GREATEST(s.eligible_count - s.enrolled_count - s.new_count, 0) AS payroll_not_enrolled, ' +
    's.new_count AS payroll_new_qualified, s.bill_premium AS payroll_bill_premium, s.bill_claims AS payroll_bill_claims, ' +
    's.bill_admin AS payroll_bill_admin, s.bill_savings AS payroll_bill_savings, s.pay_schedule AS payroll_pay_schedule, ' +
    's.ein AS payroll_ein, s.dataset_date AS payroll_dataset_date FROM payroll_company_summary s ' +
    'WHERE s.company_code = ' + a + '.company_code ORDER BY s.dataset_date DESC NULLS LAST, s.imported_at DESC, s.id DESC LIMIT 1) p ON TRUE ';
}
const PAYROLL_COLS = 'p.payroll_total, p.payroll_qualified, p.payroll_ineligible, p.payroll_opted_out, p.payroll_enrolled, ' +
  'p.payroll_not_enrolled, p.payroll_new_qualified, p.payroll_bill_premium, p.payroll_bill_claims, p.payroll_bill_admin, ' +
  'p.payroll_bill_savings, p.payroll_pay_schedule, p.payroll_ein, p.payroll_dataset_date';

// Compose a YYYY-MM-DD period-end date from a payroll group's period parts,
// or null when they don't form a real date. The Power BI source carries no
// period start date, so period_start stays empty rather than invented.
function payrollPeriodEnd(g) {
  if (!g.period_year || !g.period_month || !g.period_day) return null;
  const y = parseInt(g.period_year, 10), m = parseInt(g.period_month, 10), d = parseInt(g.period_day, 10);
  if (!(y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// Eligible = stored qualified value, else computed total - ineligible - opted out.
function eligibleOf(c) {
  if (c.payroll_qualified !== null && c.payroll_qualified !== undefined) return c.payroll_qualified;
  if (c.payroll_total === null || c.payroll_total === undefined) return null;
  return (c.payroll_total || 0) - (c.payroll_ineligible || 0) - (c.payroll_opted_out || 0);
}

function parentKey(c) {
  const par = c.parent_company_code && String(c.parent_company_code).trim();
  return par || c.company_code;
}
function parentName(c) {
  const par = c.parent_company_name && String(c.parent_company_name).trim();
  return par || c.company_name;
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

// Ticket system: service role sees all tickets; clients/stewards see their companies' tickets.
function canSeeAllTickets(user) {
  const r = user.activeRole;
  return r === 'admin' || r === 'top_dog' || r === 'service';
}

function canManageTickets(user) {
  const r = user.activeRole;
  return r === 'admin' || r === 'top_dog' || r === 'service';
}

// Find who's on call right now for ticket auto-assignment.
async function getCurrentOnCall() {
  const r = await getPool().query(
    'SELECT o.steward_id, s.first_name, s.last_name, s.email FROM on_call_schedule o ' +
    'JOIN stewards s ON s.id = o.steward_id ' +
    'WHERE CURRENT_DATE BETWEEN o.start_date AND o.end_date ' +
    'ORDER BY o.start_date DESC LIMIT 1');
  return r.rows.length > 0 ? r.rows[0] : null;
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
const PAYROLL_FIELDS = ['payroll_total', 'payroll_qualified', 'payroll_ineligible', 'payroll_opted_out',
  'payroll_enrolled', 'payroll_not_enrolled', 'payroll_new_qualified', 'payroll_bill_premium',
  'payroll_bill_claims', 'payroll_bill_admin', 'payroll_bill_savings', 'payroll_pay_schedule',
  'payroll_ein', 'payroll_dataset_date'];
function hasPayrollRow(c) {
  return PAYROLL_FIELDS.some(function (k) { return c[k] !== null && c[k] !== undefined; });
}
function groupParents(rows) {
  const map = {};
  const order = [];
  rows.forEach(function (c) {
    const key = parentKey(c);
    if (!map[key]) {
      map[key] = { code: key, name: parentName(c), children: [], total: 0, eligible: 0, enrolled: 0, has_total: false, has_eligible: false, has_enrolled: false, has_payroll: false };
      order.push(key);
    }
    const g = map[key];
    if (String(c.company_code) !== String(key)) g.name = parentName(c);
    const child = {
      id: c.id, company_code: c.company_code, company_name: c.company_name,
      total: c.payroll_total, eligible: eligibleOf(c), enrolled: c.payroll_enrolled,
      payroll_dataset_date: c.payroll_dataset_date, has_payroll: hasPayrollRow(c)
    };
    g.children.push(child);
    if (child.total !== null && child.total !== undefined) { g.total += child.total; g.has_total = true; }
    if (child.eligible !== null && child.eligible !== undefined) { g.eligible += child.eligible; g.has_eligible = true; }
    if (child.enrolled !== null && child.enrolled !== undefined) { g.enrolled += child.enrolled; g.has_enrolled = true; }
    if (child.has_payroll) g.has_payroll = true;
  });
  return order.map(function (key) {
    const g = map[key];
    g.children.sort(function (a, b) { return String(a.company_code).localeCompare(String(b.company_code)); });
    return {
      code: g.code, name: g.name,
      total: g.has_total ? g.total : null,
      eligible: g.has_eligible ? g.eligible : null,
      enrolled: g.has_enrolled ? g.enrolled : null,
      has_payroll: g.has_payroll,
      children: g.children
    };
  });
}

// Open-invoice stats per company code: count, total, and oldest open payroll
// date (arrears are measured from the oldest unpaid bill).
// v6.4 (Leroy): estimates excluded so card numbers match the Billing tab.
async function openInvoiceStats(db) {
  const inv = await db.query(
    "SELECT company_code, COUNT(*)::int AS open_count, COALESCE(SUM(total_invoice), 0)::float AS open_total, " +
    "MIN(payroll_date)::text AS oldest_open FROM invoices WHERE status = 'open' AND is_estimate = FALSE GROUP BY company_code");
  const map = {};
  inv.rows.forEach(function (x) { map[String(x.company_code)] = x; });
  return map;
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
        ' OR LOWER(COALESCE(c.parent_company_code, ' + "''" + ')) LIKE $' + params.length +
        ' OR LOWER(COALESCE(c.parent_company_name, ' + "''" + ')) LIKE $' + params.length + ')';
    }
    const activeWhere = "c.company_status <> 'TERMED'";
    where = where ? where + ' AND ' + activeWhere : 'WHERE ' + activeWhere;
    const r = await getPool().query('SELECT c.*, ' + PAYROLL_COLS + ' FROM companies c ' + payrollJoin('c') + where + ' ' + numericCodeSort('c'), params);
    const groups = groupParents(r.rows);
    // Attach open invoice count/total/oldest per company_code (arrears from oldest).
    try {
      const invMap = await openInvoiceStats(getPool());
      groups.forEach(function (g) {
        let oc = 0;
        let ot = 0;
        let oldest = null;
        g.children.forEach(function (ch) {
          const st = invMap[String(ch.company_code)];
          if (st) {
            oc += st.open_count;
            ot += st.open_total;
            ch.open_invoices = st.open_count;
            ch.open_total = st.open_total;
            ch.oldest_open = st.oldest_open;
            if (st.oldest_open && (!oldest || st.oldest_open < oldest)) oldest = st.oldest_open;
          } else {
            ch.open_invoices = 0;
            ch.open_total = 0;
            ch.oldest_open = null;
          }
        });
        g.open_invoices = oc;
        g.open_total = ot;
        g.oldest_open = oldest;
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
    let where = "(c.company_code = $1 OR c.parent_company_code = $1)";
    const params = [code];
    if (ids) {
      if (ids.length === 0) return res.status(403).json({ error: 'Not assigned to this client' });
      params.push(ids);
      where = "(" + where + ") AND c.id = ANY($" + params.length + ")";
    }
    const rows = await getPool().query('SELECT c.*, ' + PAYROLL_COLS + ' FROM companies c ' + payrollJoin('c') + 'WHERE ' + where + ' ' + numericCodeSort('c'), params);
    if (rows.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const groups = groupParents(rows.rows);
    const group = groups[0];
    try {
      const invMap = await openInvoiceStats(getPool());
      rows.rows.forEach(function (c) {
        const st = invMap[String(c.company_code)];
        c.open_invoices = st ? st.open_count : 0;
        c.open_total = st ? st.open_total : 0;
        c.oldest_open = st ? st.oldest_open : null;
      });
    } catch (e) { console.error('Invoice stats error:', e); }
    const childIds = rows.rows.map(c => c.id);
    const impls = await getPool().query(
      'SELECT i.*, c.company_code, c.company_name, ' +
      'EXTRACT(DAY FROM (NOW() - i.updated_at))::int AS days_in_stage, ' +
      '(SELECT body FROM implementation_updates u WHERE u.implementation_id = i.id ORDER BY u.update_date DESC LIMIT 1) AS latest_update ' +
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

// ---------------------------------------------------------------- parent page (v6.6, Leroy)
// One row per Parent: Parent Code + Parent Name (the parent-level data
// points), a system-derived Parent Status, and two file slots (Master
// Application, Pre-implementation Checklist). Visible to Admin, Top Dog,
// and Onboarding; only Admin can add/edit/delete.
// Parent Status rules (Leroy): no companies tied -> Pending; exactly one
// company -> that company's status; several -> Active when at least one
// child is Active, Termed only when every child is Termed, else Pending.
function parentStatusOf(counts) {
  if (!counts || !counts.total) return 'PENDING';
  if (counts.active > 0) return 'ACTIVE';
  if (counts.termed === counts.total) return 'TERMED';
  return 'PENDING';
}

// The canonical Parent for a code: { code, name } from the Parent page's
// data (parents table name wins, else the name companies carry), or null
// when the code is not an existing Parent Code.
async function canonicalParent(db, code) {
  if (!code) return null;
  const set = await parentCodeSet(db);
  if (!set[String(code)]) return null;
  const t = await db.query('SELECT parent_name FROM parents WHERE parent_code = $1', [String(code)]);
  if (t.rows.length) return { code: String(code), name: t.rows[0].parent_name };
  const c = await db.query(
    'SELECT MAX(parent_company_name) AS name FROM companies WHERE parent_company_code = $1', [String(code)]);
  return { code: String(code), name: (c.rows.length && c.rows[0].name) || String(code) };
}

async function parentCodeSet(db) {
  const r = await db.query(
    'SELECT parent_code AS code FROM parents ' +
    "UNION SELECT parent_company_code FROM companies WHERE parent_company_code IS NOT NULL AND parent_company_code <> ''");
  const set = {};
  r.rows.forEach(function (x) { if (x.code) set[String(x.code)] = true; });
  return set;
}

async function listParents(db) {
  const codes = await parentCodeSet(db);
  const nameRows = await db.query(
    'SELECT code, MAX(name) AS name FROM (' +
    'SELECT parent_code AS code, parent_name AS name FROM parents ' +
    'UNION ALL SELECT parent_company_code, parent_company_name FROM companies ' +
    "WHERE parent_company_code IS NOT NULL AND parent_company_code <> '') u GROUP BY code");
  const names = {};
  nameRows.rows.forEach(function (x) { if (x.code && x.name) names[String(x.code)] = x.name; });
  const tableNames = await db.query('SELECT parent_code, parent_name FROM parents');
  tableNames.rows.forEach(function (x) { names[String(x.parent_code)] = x.parent_name; });
  // Child counts per parent, matching parentKey() everywhere else in the app.
  const countsRows = await db.query(
    'SELECT pcode, COUNT(*)::int AS total, ' +
    "COUNT(*) FILTER (WHERE company_status = 'ACTIVE')::int AS active, " +
    "COUNT(*) FILTER (WHERE company_status = 'PENDING')::int AS pending, " +
    "COUNT(*) FILTER (WHERE company_status = 'TERMED')::int AS termed " +
    'FROM (SELECT CASE WHEN parent_company_code IS NOT NULL AND parent_company_code <> ' + "''" + ' THEN parent_company_code END AS pcode, company_status FROM companies) s ' +
    'WHERE pcode IS NOT NULL GROUP BY pcode');
  const counts = {};
  countsRows.rows.forEach(function (x) { counts[String(x.pcode)] = x; });
  const docRows = await db.query('SELECT parent_code, doc_kind, file_name, updated_at FROM parent_documents');
  const docs = {};
  docRows.rows.forEach(function (x) {
    const k = String(x.parent_code);
    if (!docs[k]) docs[k] = {};
    docs[k][x.doc_kind] = { file_name: x.file_name, updated_at: x.updated_at };
  });
  return Object.keys(codes).map(function (code) {
    const c = counts[code] || { total: 0, active: 0, pending: 0, termed: 0 };
    return {
      parent_code: code,
      parent_name: names[code] || code,
      company_count: c.total,
      counts: c,
      parent_status: parentStatusOf(c),
      master_application: (docs[code] && docs[code].master_application) || null,
      pre_implementation_checklist: (docs[code] && docs[code].pre_implementation_checklist) || null
    };
  }).sort(function (a, b) { return String(a.parent_name).localeCompare(String(b.parent_name)); });
}

app.get('/api/parent-page', requireParentViewer, async (req, res) => {
  try {
    res.json(await listParents(getPool()));
  } catch (error) { console.error('Parent page list error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/parent-page', requireAdmin, async (req, res) => {
  const db = getPool();
  try {
    const name = String((req.body || {}).parent_name || '').trim();
    if (!name) return res.status(400).json({ error: 'Parent Name is required' });
    let code = String((req.body || {}).parent_code || '').trim().toUpperCase();
    if (code && !/^PC\d{4}$/.test(code)) {
      return res.status(400).json({ error: 'Parent Code must be "PC" plus four numbers (for example PC0007).' });
    }
    if (!code) {
      // Auto-assign: highest PC#### in use + 1, like the Onboarding process.
      const set = await parentCodeSet(db);
      let max = 0;
      Object.keys(set).forEach(function (c) {
        const m = /^PC(\d+)$/i.exec(c);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      });
      code = 'PC' + String(max + 1).padStart(4, '0');
    }
    const set = await parentCodeSet(db);
    if (set[code]) return res.status(400).json({ error: 'Parent Code ' + code + ' is already in use.' });
    const co = await db.query('SELECT company_code FROM companies WHERE company_code = $1', [code]);
    if (co.rows.length) return res.status(400).json({ error: 'Parent Code ' + code + ' matches an existing Company Code.' });
    await db.query('INSERT INTO parents (parent_code, parent_name) VALUES ($1, $2)', [code, name]);
    res.json({ ok: true, parent_code: code });
  } catch (error) { console.error('Parent add error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.put('/api/parent-page/:code', requireAdmin, async (req, res) => {
  const db = getPool();
  const client = await db.connect();
  try {
    const oldCode = String(req.params.code || '').trim();
    const newCode = String((req.body || {}).parent_code || '').trim();
    const newName = String((req.body || {}).parent_name || '').trim();
    if (!newCode || !newName) { client.release(); return res.status(400).json({ error: 'Parent Code and Parent Name are both required' }); }
    const set = await parentCodeSet(db);
    if (!set[oldCode]) { client.release(); return res.status(404).json({ error: 'Parent not found' }); }
    if (newCode !== oldCode) {
      if (set[newCode]) { client.release(); return res.status(400).json({ error: 'Parent Code ' + newCode + ' is already in use.' }); }
      const co = await db.query('SELECT company_code FROM companies WHERE company_code = $1', [newCode]);
      if (co.rows.length) { client.release(); return res.status(400).json({ error: 'Parent Code ' + newCode + ' matches an existing Company Code.' }); }
    }
    await client.query('BEGIN');
    // Make sure the parent has a concrete row before cascading.
    await client.query('INSERT INTO parents (parent_code, parent_name) VALUES ($1, $2) ON CONFLICT (parent_code) DO NOTHING', [oldCode, newName]);
    if (newCode !== oldCode) {
      await client.query('UPDATE companies SET parent_company_code = $1 WHERE parent_company_code = $2', [newCode, oldCode]);
      await client.query('UPDATE parent_documents SET parent_code = $1 WHERE parent_code = $2', [newCode, oldCode]);
      await client.query('UPDATE parents SET parent_code = $1, updated_at = NOW() WHERE parent_code = $2', [newCode, oldCode]);
    }
    await client.query('UPDATE parents SET parent_name = $1, updated_at = NOW() WHERE parent_code = $2', [newName, newCode]);
    await client.query('UPDATE companies SET parent_company_name = $1 WHERE parent_company_code = $2', [newName, newCode]);
    await client.query('COMMIT');
    client.release();
    res.json({ ok: true, parent_code: newCode });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    client.release();
    console.error('Parent edit error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/parent-page/:code', requireAdmin, async (req, res) => {
  const db = getPool();
  try {
    const code = String(req.params.code || '').trim();
    const tied = await db.query(
      'SELECT COUNT(*)::int AS n FROM companies WHERE parent_company_code = $1', [code]);
    if (tied.rows[0].n > 0) {
      return res.status(400).json({ error: tied.rows[0].n + ' companies are still tied to this parent. Reassign or remove those companies first, then delete the parent.' });
    }
    await db.query('DELETE FROM parent_documents WHERE parent_code = $1', [code]);
    await db.query('DELETE FROM parents WHERE parent_code = $1', [code]);
    res.json({ ok: true });
  } catch (error) { console.error('Parent delete error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

const PARENT_DOC_KINDS = ['master_application', 'pre_implementation_checklist'];

app.post('/api/parent-page/:code/documents/:kind', requireAdmin, handleUpload('file'), async (req, res) => {
  const db = getPool();
  try {
    const code = String(req.params.code || '').trim();
    const kind = String(req.params.kind || '').trim();
    if (PARENT_DOC_KINDS.indexOf(kind) === -1) return res.status(400).json({ error: 'Unknown document kind' });
    const set = await parentCodeSet(db);
    if (!set[code]) return res.status(404).json({ error: 'Parent not found' });
    if (!req.file) return res.status(400).json({ error: 'A file is required' });
    await db.query('INSERT INTO parents (parent_code, parent_name) ' +
      'SELECT $1, COALESCE((SELECT MAX(parent_company_name) FROM companies WHERE parent_company_code = $1), $1) ' +
      'ON CONFLICT (parent_code) DO NOTHING', [code]);
    await db.query(
      'INSERT INTO parent_documents (parent_code, doc_kind, file_name, mime_type, file_data, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6) ' +
      'ON CONFLICT (parent_code, doc_kind) DO UPDATE SET file_name = EXCLUDED.file_name, mime_type = EXCLUDED.mime_type, file_data = EXCLUDED.file_data, uploaded_by = EXCLUDED.uploaded_by, updated_at = NOW()',
      [code, kind, req.file.originalname, req.file.mimetype, req.file.buffer, req.user.id]);
    res.json({ ok: true, file_name: req.file.originalname });
  } catch (error) { console.error('Parent doc upload error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/parent-page/:code/documents/:kind/download', requireParentViewer, async (req, res) => {
  try {
    const r = await getPool().query(
      'SELECT file_name, mime_type, file_data FROM parent_documents WHERE parent_code = $1 AND doc_kind = $2',
      [String(req.params.code || '').trim(), String(req.params.kind || '').trim()]);
    if (!r.rows.length) return res.status(404).json({ error: 'No file on record for this parent' });
    const f = r.rows[0];
    res.set('Content-Type', f.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename=\"' + String(f.file_name).replace(/\"/g, '') + '\"');
    res.send(f.file_data);
  } catch (error) { console.error('Parent doc download error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/parent-page/:code/documents/:kind', requireAdmin, async (req, res) => {
  try {
    await getPool().query('DELETE FROM parent_documents WHERE parent_code = $1 AND doc_kind = $2',
      [String(req.params.code || '').trim(), String(req.params.kind || '').trim()]);
    res.json({ ok: true });
  } catch (error) { console.error('Parent doc delete error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// Child detail: full payroll, stewards, implementation cards.
app.get('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    const ids = await visibleCompanyIds(req.user);
    if (ids && ids.indexOf(parseInt(req.params.id, 10)) === -1) {
      return res.status(403).json({ error: 'Not assigned to this client' });
    }
    const c = await getPool().query('SELECT c.*, ' + PAYROLL_COLS + ' FROM companies c ' + payrollJoin('c') + 'WHERE c.id = $1', [req.params.id]);
    if (c.rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    const impls = await getPool().query(
      'SELECT i.*, EXTRACT(DAY FROM (NOW() - i.updated_at))::int AS days_in_stage, ' +
      '(SELECT COUNT(*)::int FROM messages m WHERE m.implementation_id = i.id) AS message_count, ' +
      '(SELECT body FROM implementation_updates u WHERE u.implementation_id = i.id ORDER BY u.update_date DESC LIMIT 1) AS latest_update ' +
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
      'SELECT i.*, c.company_code, c.company_name, p.payroll_enrolled AS lives, ' +
      'EXTRACT(DAY FROM (NOW() - i.updated_at))::int AS days_in_stage, ' +
      '(SELECT body FROM implementation_updates u WHERE u.implementation_id = i.id ORDER BY u.update_date DESC LIMIT 1) AS latest_update ' +
      'FROM implementations i JOIN companies c ON c.id = i.company_id ' +
      payrollJoin('c') + where + ' ORDER BY i.status, c.company_name', params);
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
      'SELECT i.*, c.company_code, c.company_name, c.parent_company_code, c.parent_company_name, ' +
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
      'WHERE m.implementation_id = $1 ORDER BY COALESCE(m.github_created_at, m.created_at) DESC, m.id DESC',
      [req.params.id]);
    const sums = await getPool().query(
      'SELECT update_date, body, created_at FROM implementation_updates WHERE implementation_id = $1 ORDER BY update_date DESC LIMIT 10',
      [req.params.id]);
    const timeline = await buildTimeline(getPool(), req.params.id);
    const filters = await privateFilters(getPool());
    res.json({ implementation: impl, messages: withoutPrivateMessages(msgs.rows, filters), updates: sums.rows, timeline: timeline });
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
    const coActive = coWhere ? coWhere + " AND c.company_status <> 'TERMED'" : "WHERE c.company_status <> 'TERMED'";
    const tc = await db.query('SELECT COUNT(*)::int AS c FROM companies c ' + coActive, coParams);
    const tl = await db.query(
      'SELECT COALESCE(SUM(COALESCE(p.payroll_qualified, p.payroll_total - COALESCE(p.payroll_ineligible, 0) - COALESCE(p.payroll_opted_out, 0))), 0)::int AS t ' +
      'FROM companies c ' + payrollJoin('c') + coActive, coParams);
    // v5.4: Total Enrolled = sum of payroll_enrolled across each company's latest payroll.
    const te = await db.query(
      'SELECT COALESCE(SUM(p.payroll_enrolled), 0)::int AS t FROM companies c ' + payrollJoin('c') + coActive, coParams);
    let stWhere = '';
    const stParams = [];
    if (ids) {
      stWhere = 'WHERE c.id = ANY($1)';
      stParams.push(ids);
    }
    const stActive = stWhere ? stWhere + " AND c.company_status <> 'TERMED'" : "WHERE c.company_status <> 'TERMED'";
    const st = await db.query(
      'SELECT i.stage AS stage, COUNT(*)::int AS count FROM implementations i ' +
      'JOIN companies c ON c.id = i.company_id ' + stActive + ' GROUP BY i.stage ORDER BY i.stage', stParams);
    let billingOpen = { count: 0, total: 0 };
    let billingPaid = { count: 0, total: 0 };
    if (codes === null || codes.length > 0) {
      let bWhere = '';
      const bParams = [];
      if (codes) {
        bWhere = 'WHERE company_code = ANY($1)';
        bParams.push(codes);
      }
      const bActive = "NOT EXISTS (SELECT 1 FROM companies c WHERE c.company_code = invoices.company_code AND c.company_status = 'TERMED')";
      const b = await db.query(
        "SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total_invoice), 0)::float AS total FROM invoices " +
        (bWhere ? bWhere + ' AND ' + bActive : 'WHERE ' + bActive) + ' GROUP BY status', bParams);
      b.rows.forEach(function (x) {
        if (x.status === 'open') billingOpen = { count: x.count, total: x.total };
        if (x.status === 'paid') billingPaid = { count: x.count, total: x.total };
      });
    }
    // v5.3: total enrolled from the most recent payroll_dataset_date.
    // v6.12.0: dataset dates live on the payroll rows; p is each company's
    // latest payroll row (payrollJoin), same as the old companies columns.
    let enrolledLast = { rows: [] };
    try {
      let eWhere = "WHERE p.payroll_dataset_date IS NOT NULL AND c.company_status <> 'TERMED'";
      const eParams = [];
      if (ids) {
        eParams.push(ids);
        eWhere += ' AND c.id = ANY($' + eParams.length + ')';
      }
      enrolledLast = await db.query(
        'SELECT COALESCE(SUM(p.payroll_enrolled), 0)::int AS t, MAX(p.payroll_dataset_date)::text AS d ' +
        'FROM companies c ' + payrollJoin('c') + eWhere + ' AND p.payroll_dataset_date = (' +
        'SELECT MAX(p.payroll_dataset_date) FROM companies c2 ' + payrollJoin('c2') +
        (ids ? "WHERE c2.id = ANY($1) AND c2.company_status <> 'TERMED'" : "WHERE c2.company_status <> 'TERMED'") + ')',
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
// v6.1 (Leroy): Billing page open to every role. Scoping is enforced
// inside via getVisibleCodes: full-visibility roles see all companies;
// stewards/service/client see only their assigned companies.
// v6.2 (Leroy): Open Bills reports only imported, known bills —
// estimated bills (is_estimate) are never returned for status=open.
app.get('/api/billing', requireAuth, async (req, res) => {
  try {
    const status = req.query.status === 'paid' ? 'paid' : 'open';
    // v6.16 (Leroy): the Commissions role sees Billing for ALL accounts,
    // like the full-visibility roles; every other scoped role keeps its
    // assignment scoping. Deliberately NOT added to hasFullVisibility, so
    // no other page's data opens up to the role.
    const codes = req.user.activeRole === 'commissions' ? null : await getVisibleCodes(req.user);
    if (codes && codes.length === 0) return res.json([]);
    let where = "WHERE status = $1 AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.company_code = invoices.company_code AND c.company_status = 'TERMED')";
    if (status === 'open') where += ' AND is_estimate = FALSE';
    const params = [status];
    const btype = req.query.type === 'F' || req.query.type === 'S' ? req.query.type : null;
    if (btype) {
      params.push(btype);
      where += ' AND bill_type = $' + params.length;
    }
    if (codes) {
      params.push(codes);
      where += ' AND company_code = ANY($' + params.length + ')';
    }
    const r = await getPool().query(
      'SELECT * FROM invoices ' + where + ' ORDER BY payroll_date DESC NULLS LAST, company_code', params);
    const rows = r.rows;
    // Fill missing EINs (F bills carry none) from, in order: the EIN
    // cross-reference, another bill for the same company, the company's
    // payroll EIN. Best-effort: any failure just leaves EIN blank.
    try {
      const need = {};
      rows.forEach(function (row) { if (!row.ein) need[String(row.company_code)] = true; });
      const needCodes = Object.keys(need);
      if (needCodes.length) {
        const found = {};
        const x = await getPool().query(
          'SELECT acct::text AS code, tin AS ein FROM ein_account_xref WHERE acct::text = ANY($1) AND tin IS NOT NULL', [needCodes]);
        x.rows.forEach(function (m) { if (m.ein) found[m.code] = m.ein; });
        const o = await getPool().query(
          'SELECT company_code AS code, MAX(ein) AS ein FROM invoices WHERE company_code = ANY($1) AND ein IS NOT NULL GROUP BY company_code', [needCodes]);
        o.rows.forEach(function (m) { if (m.ein && !found[m.code]) found[m.code] = m.ein; });
        const c = await getPool().query(
          'SELECT DISTINCT ON (company_code) company_code AS code, ein FROM payroll_company_summary ' +
          'WHERE company_code = ANY($1) AND ein IS NOT NULL ORDER BY company_code, dataset_date DESC NULLS LAST, imported_at DESC, id DESC', [needCodes]);
        c.rows.forEach(function (m) { if (m.ein && !found[m.code]) found[m.code] = m.ein; });
        rows.forEach(function (row) { if (!row.ein && found[String(row.company_code)]) row.ein = found[String(row.company_code)]; });
      }
    } catch (einErr) { console.error('Billing EIN fill skipped:', einErr.message); }
    res.json(rows);
  } catch (error) {
    console.error('Billing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// v5: billing CSV import (admin only). Accepts { csv } text or { rows } array.
// Columns: company_code (required), company_name, payroll_date, payroll_end_date,
// lives_count, total_invoice, status, paid_date, bill_type ('F' or 'S', default 'F'),
// bill_mode, ein.
// Upserts on (company_code, payroll_date, bill_type).
app.post('/api/admin/import-billing', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    let rows = [];
    if (Array.isArray(body.rows)) rows = body.rows;
    else if (body.csv) rows = parseCsvServer(body.csv);
    else return res.status(400).json({ error: 'Provide { csv } text or { rows }' });
    rows = rows.map(normalizeRow);
    const db = getPool();
    let imported = 0;
    let updated = 0;
    const errors = [];
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const line = idx + 2;
      try {
        const company_code = row.company_code !== undefined && row.company_code !== null ? String(row.company_code).trim() : '';
        if (!company_code) throw new Error('company_code is required');
        const company_name = row.company_name !== undefined && row.company_name !== null ? String(row.company_name).trim() : company_code;
        const payroll_date = toISODate(row.payroll_date);
        const payroll_end_date = toISODate(row.payroll_end_date);
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
        let bill_type = row.bill_type !== undefined && row.bill_type !== null && String(row.bill_type).trim() !== ''
          ? String(row.bill_type).trim().toUpperCase() : 'F';
        if (bill_type !== 'F' && bill_type !== 'S') throw new Error("bill_type must be 'F' or 'S'");
        let bill_mode_csv = row.bill_mode !== undefined && row.bill_mode !== null && String(row.bill_mode).trim() !== ''
          ? String(row.bill_mode).trim() : null;
        const ein = row.ein !== undefined && row.ein !== null && String(row.ein).trim() !== ''
          ? String(row.ein).trim().replace(/\D/g, '') : null;
        const up = await db.query(
          'UPDATE invoices SET company_name = $1, lives_count = $2, total_invoice = $3, status = $4, paid_date = $5, is_estimate = FALSE, bill_mode = COALESCE($8, bill_mode), ein = COALESCE($10, ein), payroll_end_date = COALESCE($11, payroll_end_date), updated_at = NOW() ' +
          "WHERE company_code = $6 AND ((payroll_date = $7) OR (payroll_date IS NULL AND $7 IS NULL)) AND bill_type = $9",
          [company_name, lives_count, total_invoice, status, paid_date, company_code, payroll_date, bill_mode_csv, bill_type, ein, payroll_end_date]);
        if (up.rowCount > 0) {
          updated++;
        } else {
          await db.query(
            'INSERT INTO invoices (company_code, company_name, payroll_date, payroll_end_date, lives_count, total_invoice, status, paid_date, bill_type, bill_mode, ein) ' +
            'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
            [company_code, company_name, payroll_date, payroll_end_date, lives_count, total_invoice, status, paid_date, bill_type, bill_mode_csv, ein]);
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

// ---------------------------------------------------------------- v5.8: FTJ billing from Premium Applied Report
// Bill types: 'F' = FTJ (from the Premium Applied Report), 'S' = Soluta (later).
const FTJ_PERIODS = { '1': 52, '2': 26, '3': 24, '4': 12, 'M': 12 };
const ftjPreviewCache = new Map();
const solPreviewCache = new Map();

function ftjISODate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && isFinite(v)) {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  const str = String(v).trim();
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
  const d2 = new Date(str);
  return isNaN(d2) ? null : d2.toISOString().slice(0, 10);
}

// Parse a Premium Applied Report workbook into paid F bills.
// One bill per (Account, Modal Date): invoice total = sum of Amount Applied
// across all products; lives = round(admin-only sum / (40*12/periods)).
function parsePremiumApplied(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  let headerIdx = -1;
  let colIdx = null;
  let dataRows = null;
  for (const sn of wb.SheetNames) {
    const ws = wb.Sheets[sn];
    const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
    for (let i = 0; i < Math.min(arr.length, 25); i++) {
      const r = arr[i] || [];
      const up = r.map(function (c) { return String(c === null || c === undefined ? '' : c).toUpperCase().trim(); });
      const ai = up.indexOf('ACCOUNT');
      const mi = up.findIndex(function (c) { return c === 'MODAL DATE'; });
      const bi = up.findIndex(function (c) { return c === 'BILL MODE'; });
      const ti = up.findIndex(function (c) { return c === 'AMOUNT APPLIED'; });
      if (ai !== -1 && mi !== -1 && bi !== -1 && ti !== -1) {
        headerIdx = i;
        colIdx = {
          account: ai, modal: mi, billMode: bi, amount: ti,
          product: up.indexOf('PRODUCT ID'),
          applied: up.findIndex(function (c) { return c === 'APPLIED DATE'; })
        };
        dataRows = arr.slice(i + 1);
        break;
      }
    }
    if (dataRows) break;
  }
  if (!dataRows) throw new Error('Could not find the Premium Applied Report columns (ACCOUNT / MODAL DATE / BILL MODE / AMOUNT APPLIED).');
  const groups = new Map();
  for (const r of dataRows) {
    if (!r) continue;
    const acctRaw = colIdx.account !== -1 ? r[colIdx.account] : null;
    if (acctRaw === null || acctRaw === undefined || String(acctRaw).trim() === '') continue;
    const account = String(acctRaw).trim();
    const modalDate = ftjISODate(r[colIdx.modal]);
    if (!modalDate) continue;
    const billMode = String(r[colIdx.billMode] === null || r[colIdx.billMode] === undefined ? '' : r[colIdx.billMode]).trim().toUpperCase();
    const product = colIdx.product !== -1 ? String(r[colIdx.product] === null || r[colIdx.product] === undefined ? '' : r[colIdx.product]).trim().toUpperCase() : '';
    let amount = 0;
    const av = r[colIdx.amount];
    if (typeof av === 'number' && isFinite(av)) amount = av;
    else if (av !== null && av !== undefined && String(av).trim() !== '') {
      const p = parseFloat(String(av).replace(/[^0-9.\-]/g, ''));
      if (!isNaN(p)) amount = p;
    }
    const appliedDate = colIdx.applied !== -1 ? ftjISODate(r[colIdx.applied]) : null;
    const key = account + '|' + modalDate;
    let g = groups.get(key);
    if (!g) {
      g = { company_code: account, payroll_date: modalDate, bill_mode: billMode, total_invoice: 0, admin_fees: 0, paid_date: null, rows: 0 };
      groups.set(key, g);
    }
    g.total_invoice += amount;
    if (product === 'ADMIN') g.admin_fees += amount;
    if (!g.bill_mode && billMode) g.bill_mode = billMode;
    if (appliedDate && (!g.paid_date || appliedDate > g.paid_date)) g.paid_date = appliedDate;
    g.rows += 1;
  }
  const bills = [];
  for (const g of groups.values()) {
    const periods = FTJ_PERIODS[g.bill_mode] || 0;
    const rate = periods ? 480 / periods : 0;
    const lives = rate ? Math.round(g.admin_fees / rate) : 0;
    bills.push({
      company_code: g.company_code,
      company_name: '',
      payroll_date: g.payroll_date,
      payroll_end_date: null,
      bill_mode: g.bill_mode,
      total_invoice: Math.round(g.total_invoice * 100) / 100,
      admin_fees: Math.round(g.admin_fees * 100) / 100,
      lives_count: lives,
      paid_date: g.paid_date,
      ein: null,
      bill_type: 'F'
    });
  }
  bills.sort(function (a, b) {
    return a.company_code < b.company_code ? -1 : a.company_code > b.company_code ? 1 :
      (a.payroll_date < b.payroll_date ? -1 : 1);
  });
  return bills;
}

// Parse a Soluta iM4H Invoice Report workbook into S bills.
// One row = one bill. Columns: IM4H_ID (company code), EIN, GroupName
// (company name), PayrollStart, PayrollEnd, BillingMode, Status
// (Paid/Due), GrandTotal, Enrolled (lives), RemitDate (paid date).
// No estimating: the report carries both paid and pending bills.
function parseSolutaReport(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  let headerIdx = -1;
  let colIdx = null;
  let dataRows = null;
  for (const sn of wb.SheetNames) {
    const ws = wb.Sheets[sn];
    const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
    for (let i = 0; i < Math.min(arr.length, 25); i++) {
      const r = arr[i] || [];
      const up = r.map(function (c) { return String(c === null || c === undefined ? '' : c).toUpperCase().trim().replace(/\s+/g, ''); });
      const idI = up.findIndex(function (c) { return c === 'IM4H_ID' || c === 'IM4HID'; });
      const nameI = up.findIndex(function (c) { return c === 'GROUPNAME' || c === 'GROUP_NAME'; });
      const psI = up.findIndex(function (c) { return c === 'PAYROLLSTART' || c === 'PAYROLL_START'; });
      const stI = up.findIndex(function (c) { return c === 'STATUS'; });
      const totI = up.findIndex(function (c) { return c === 'GRANDTOTAL' || c === 'GRAND_TOTAL'; });
      if (idI !== -1 && psI !== -1 && stI !== -1 && totI !== -1) {
        headerIdx = i;
        colIdx = {
          id: idI, name: nameI,
          payrollStart: psI, payrollEnd: up.findIndex(function (c) { return c === 'PAYROLLEND' || c === 'PAYROLL_END'; }),
          status: stI, total: totI,
          billingMode: up.findIndex(function (c) { return c === 'BILLINGMODE' || c === 'BILLING_MODE'; }),
          enrolled: up.findIndex(function (c) { return c === 'ENROLLED'; }),
          remitDate: up.findIndex(function (c) { return c === 'REMITDATE' || c === 'REMIT_DATE'; }),
          ein: up.findIndex(function (c) { return c === 'EIN'; })
        };
        dataRows = arr.slice(i + 1);
        break;
      }
    }
    if (dataRows) break;
  }
  if (!dataRows) throw new Error('Could not find the Soluta report columns (IM4H_ID / PayrollStart / Status / GrandTotal).');
  const bills = [];
  for (const r of dataRows) {
    if (!r) continue;
    const codeRaw = r[colIdx.id];
    if (codeRaw === null || codeRaw === undefined || String(codeRaw).trim() === '') continue;
    const company_code = String(codeRaw).trim();
    const payroll_date = ftjISODate(r[colIdx.payrollStart]);
    const statusRaw = String(r[colIdx.status] || '').trim().toLowerCase();
    let status;
    if (statusRaw === 'paid') status = 'paid';
    else if (statusRaw === 'due' || statusRaw === 'open' || statusRaw === 'pending') status = 'open';
    else if (statusRaw === '') status = 'open';
    else continue;
    let total = 0;
    const tv = r[colIdx.total];
    if (typeof tv === 'number' && isFinite(tv)) total = tv;
    else if (tv !== null && tv !== undefined && String(tv).trim() !== '') {
      const p = parseFloat(String(tv).replace(/[^0-9.\-]/g, ''));
      if (!isNaN(p)) total = p;
    }
    let lives = null;
    if (colIdx.enrolled !== -1) {
      const ev = r[colIdx.enrolled];
      if (typeof ev === 'number' && isFinite(ev)) lives = Math.round(ev);
      else if (ev !== null && ev !== undefined && String(ev).trim() !== '') {
        const p = parseInt(String(ev).replace(/[^0-9]/g, ''), 10);
        if (!isNaN(p)) lives = p;
      }
    }
    const company_name = colIdx.name !== -1 && r[colIdx.name] ? String(r[colIdx.name]).trim() : company_code;
    const bill_mode = colIdx.billingMode !== -1 && r[colIdx.billingMode] ? String(r[colIdx.billingMode]).trim() : null;
    const paid_date = status === 'paid' && colIdx.remitDate !== -1 ? ftjISODate(r[colIdx.remitDate]) : null;
    const ein = colIdx.ein !== -1 && r[colIdx.ein] ? String(r[colIdx.ein]).trim().replace(/\D/g, '') : null;
    const payroll_end_date = colIdx.payrollEnd !== -1 ? ftjISODate(r[colIdx.payrollEnd]) : null;
    bills.push({
      company_code: company_code,
      company_name: company_name,
      payroll_date: payroll_date,
      payroll_end_date: payroll_end_date,
      bill_mode: bill_mode,
      total_invoice: Math.round(total * 100) / 100,
      lives_count: lives,
      status: status,
      paid_date: paid_date,
      ein: ein || null,
      bill_type: 'S',
      is_estimate: false
    });
  }
  bills.sort(function (a, b) {
    return a.company_code < b.company_code ? -1 : a.company_code > b.company_code ? 1 :
      (a.payroll_date < b.payroll_date ? -1 : 1);
  });
  return bills;
}

// Preview: upload the report, parse it, cache the bills, show stats + sample.
app.post('/api/admin/jobs/ftj-preview', requireAdmin, handleUpload('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No file uploaded' });
    const bills = parsePremiumApplied(req.file.buffer);
    if (bills.length === 0) return res.status(400).json({ error: 'No bills found in this file' });
    const db = getPool();
    const coRes = await db.query('SELECT company_code, company_name FROM companies');
    const coMap = {};
    coRes.rows.forEach(function (r) { coMap[String(r.company_code)] = r.company_name; });
    bills.forEach(function (b) { b.company_name = coMap[b.company_code] || b.company_code; });
    const crypto = require('crypto');
    const previewToken = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    for (const [tk, v] of ftjPreviewCache) { if (v.expires < now) ftjPreviewCache.delete(tk); }
    ftjPreviewCache.set(previewToken, { bills: bills, expires: now + 30 * 60 * 1000, fileName: req.file.originalname });
    let total = 0;
    const accounts = {};
    bills.forEach(function (b) { total += b.total_invoice; accounts[b.company_code] = true; });
    res.json({
      ok: true,
      preview_token: previewToken,
      stats: {
        bills: bills.length,
        accounts: Object.keys(accounts).length,
        total_invoice: Math.round(total * 100) / 100,
        modal_from: bills[0].payroll_date,
        modal_to: bills[bills.length - 1].payroll_date,
        file_name: req.file.originalname
      },
      sample: bills.slice(0, 8)
    });
  } catch (error) { console.error('FTJ preview error:', error); res.status(500).json({ error: error.message || 'Internal server error' }); }
});

// Import: reconcile cached preview bills against F invoices.
// Adds new, updates changed, deletes F bills missing from the report.
app.post('/api/admin/jobs/ftj-import', requireAdmin, async (req, res) => {
  try {
    const previewToken = req.body && req.body.preview_token;
    const cached = previewToken ? ftjPreviewCache.get(previewToken) : null;
    if (!cached || cached.expires < Date.now()) {
      if (previewToken) ftjPreviewCache.delete(previewToken);
      return res.status(400).json({ error: 'Preview expired. Upload the report again.' });
    }
    const bills = cached.bills;
    const db = getPool();
    const exRes = await db.query("SELECT * FROM invoices WHERE bill_type = 'F'");
    const exMap = {};
    exRes.rows.forEach(function (r) {
      const pd = r.payroll_date ? new Date(r.payroll_date).toISOString().slice(0, 10) : '';
      exMap[r.company_code + '|' + pd] = r;
    });
    let added = 0, updated = 0;
    const seen = {};
    for (const b of bills) {
      const key = b.company_code + '|' + b.payroll_date;
      seen[key] = true;
      const ex = exMap[key];
      const paidDate = b.paid_date || null;
      if (ex) {
        const exPaid = ex.paid_date ? new Date(ex.paid_date).toISOString().slice(0, 10) : null;
        const same = !ex.is_estimate && String(ex.company_name) === String(b.company_name) &&
          Number(ex.lives_count) === Number(b.lives_count) &&
          Number(ex.total_invoice) === Number(b.total_invoice) &&
          ex.status === 'paid' && exPaid === paidDate;
        if (!same) {
          await db.query('UPDATE invoices SET company_name = $1, lives_count = $2, total_invoice = $3, status = $4, paid_date = $5, is_estimate = FALSE, bill_mode = $6, updated_at = NOW() WHERE id = $7',
            [b.company_name, b.lives_count, b.total_invoice, 'paid', paidDate, b.bill_mode || null, ex.id]);
          updated++;
        }
      } else {
        await db.query("INSERT INTO invoices (company_code, company_name, payroll_date, lives_count, total_invoice, status, paid_date, bill_type, bill_mode) VALUES ($1, $2, $3, $4, $5, 'paid', $6, 'F', $7)",
          [b.company_code, b.company_name, b.payroll_date, b.lives_count, b.total_invoice, paidDate, b.bill_mode || null]);
        added++;
      }
    }
    let deleted = 0;
    for (const key of Object.keys(exMap)) {
      if (!seen[key] && !exMap[key].is_estimate) {
        await db.query('DELETE FROM invoices WHERE id = $1', [exMap[key].id]);
        deleted++;
      }
    }
    ftjPreviewCache.delete(previewToken);
    res.json({ ok: true, added: added, updated: updated, deleted: deleted, total: bills.length });
  } catch (error) { console.error('FTJ import error:', error); res.status(500).json({ error: error.message || 'Internal server error' }); }
});

// ---------------------------------------------------------------- v5.32: payroll company summary (Power BI export)
// Company-level aggregates only — no employee PII is stored.
const payrollPreviewCache = new Map();

function payrollNum(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = parseFloat(String(v).replace(/[$,]/g, ''));
  return isNaN(n) ? 0 : n;
}
function payrollBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1';
}

// v6.9.0 (Leroy): canonical EIN form for ALL matching - punctuation and
// dashes stripped, uppercased, and a purely numeric value shorter than 9
// digits is left-padded with zeros (Excel number cells lose leading
// zeros). With or without the dash, the same EIN produces the same key.
function normEin(v) {
  if (v === null || v === undefined) return '';
  let s = String(v).replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
  if (/^[0-9]+$/.test(s) && s.length < 9) s = s.padStart(9, '0');
  return s;
}

function parsePayrollExport(buffer, fileName) {
  // v5.36: one row per EIN — the latest case with Status='done' that has at
  // least one finalized employee. Headcounts come from the case's LATEST
  // payroll cycle snapshot (distinct employees in that cycle), matching the
  // case screenshots: Total, Ineligible (= Total - Eligible - OptedOut),
  // OptedOut, Eligible, New Qualified (= New AND Final), Enrolled
  // (= Final but not New Qualified), Not Enrolled (= Eligible - Enrolled
  // - New Qualified). Money is summed from the snapshot rows.
  // No employee PII is stored.
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  if (!rows.length) throw new Error('No data rows found in this file.');
  const norm = {};
  Object.keys(rows[0]).forEach(function (k) { norm[String(k).trim().toLowerCase()] = k; });
  function col() {
    for (let i = 0; i < arguments.length; i++) {
      const k = norm[String(arguments[i]).trim().toLowerCase()];
      if (k !== undefined) return k;
    }
    return null;
  }
  const cCase = col('case_number', 'case number', 'casenumber');
  const cEin = col('ein');
  if (!cCase) throw new Error('Could not find a Case_Number column.');
  if (!cEin) throw new Error('Could not find an EIN column.');
  const cEmpId = col('employeeid', 'employee id');
  const cEmpName = col('employername', 'employer name');
  const cEmpLoc = col('employerlocation', 'employer location');
  const cState = col('state');
  const cZip = col('zip', 'zipcode', 'zip code');
  const cPaySched = col('payschedule', 'pay schedule');
  const cStatus = col('status');
  const cCycle = col('cycle');
  const cGross = col('grosswages', 'gross wages');
  const cNet = col('netpay', 'net pay');
  const cPrem = col('premium');
  const cAdmin = col('adminfee', 'admin fee');
  const cBen = col('benefitamount', 'benefit amount');
  const cClaim = col('claim');
  const cFica = col('ficasavings', 'fica savings');
  const cElig = col('iseligible', 'is eligible');
  const cOpt = col('isoptout', 'is optout', 'is opt out');
  const cNew = col('isnew', 'is new');
  const cFin = col('isfinal', 'is final');
  const cYear = col('updated_dt - year', 'updated_dt-year');
  const cMonth = col('updated_dt - month', 'updated_dt-month');
  const cDay = col('updated_dt - day', 'updated_dt-day');
  function txt(v) { return (v !== null && v !== undefined && String(v).trim() !== '') ? String(v).trim() : null; }
  function cycNum(v) { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
  // Pass 1: bucket rows by (ein, case); remember each case's max cycle.
  const cases = {};
  rows.forEach(function (r) {
    const caseNum = txt(r[cCase]);
    // Normalize EIN (v6.9.0): canonical key via normEin so '47-2606741',
    // '472606741', and a zero-stripped Excel number all match. Letters are
    // kept so division suffixes ('-reg', '-105A') stay distinct.
    const ein = txt(r[cEin]) ? normEin(txt(r[cEin])) : null;
    if (!caseNum || !ein) return;
    const key = ein + '|' + caseNum;
    let c = cases[key];
    if (!c) c = cases[key] = { ein: ein, case_number: caseNum, maxCycle: -1, rows: [], done: false };
    const cy = cCycle ? cycNum(r[cCycle]) : 0;
    if (cy > c.maxCycle) c.maxCycle = cy;
    c.rows.push(r);
    if (cStatus && String(r[cStatus]).trim().toLowerCase() === 'done') c.done = true;
  });
  // Pass 2: per (ein, case), take the latest-cycle snapshot; per EIN pick the
  // latest done case with at least one finalized employee in its snapshot.
  const best = {};
  const seenEin = {};
  Object.keys(cases).forEach(function (key) {
    const c = cases[key];
    seenEin[c.ein] = true;
    const snap = {};
    c.rows.forEach(function (r) {
      const cy = cCycle ? cycNum(r[cCycle]) : 0;
      if (cy !== c.maxCycle) return;
      const eid = cEmpId ? txt(r[cEmpId]) : null;
      const empKey = eid || ('row#' + Object.keys(snap).length);
      if (snap[empKey]) return;
      snap[empKey] = {
        elig: !!(cElig && payrollBool(r[cElig])),
        fin: !!(cFin && payrollBool(r[cFin])),
        opt: !!(cOpt && payrollBool(r[cOpt])),
        isnew: !!(cNew && payrollBool(r[cNew])),
        gross: cGross ? payrollNum(r[cGross]) : 0,
        net: cNet ? payrollNum(r[cNet]) : 0,
        prem: cPrem ? payrollNum(r[cPrem]) : 0,
        admin: cAdmin ? payrollNum(r[cAdmin]) : 0,
        ben: cBen ? payrollNum(r[cBen]) : 0,
        claim: cClaim ? payrollNum(r[cClaim]) : 0,
        fica: cFica ? payrollNum(r[cFica]) : 0,
        name: txt(r[cEmpName]), loc: txt(r[cEmpLoc]),
        state: txt(r[cState]), zip: txt(r[cZip]),
        sched: cPaySched ? txt(r[cPaySched]) : null,
        py: null, pm: null, pd: null
      };
      const e = snap[empKey];
      if (cYear && cMonth && cDay) {
        const y = parseInt(r[cYear], 10), d = parseInt(r[cDay], 10);
        if (!isNaN(y) && !isNaN(d)) {
          const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
          const mo = months[String(r[cMonth]).trim().toLowerCase()] || 1;
          e.py = y; e.pm = mo; e.pd = d;
        }
      }
    });
    const finals = Object.keys(snap).filter(function (k) { return snap[k].fin; }).length;
    c.snapshot = snap;
    if (!c.done || finals === 0) return;
    const cur = best[c.ein];
    if (!cur || c.case_number > cur.case_number) best[c.ein] = c;
  });
  // Pass 3: aggregate the chosen case snapshot per EIN.
  const out = [];
  const skipped = { no_qualifying_case: 0 };
  Object.keys(best).forEach(function (ein) {
    const c = best[ein];
    const g = {
      ein: ein, case_number: c.case_number, employer_name: null, employer_location: null,
      state: null, zip: null, pay_schedule: null,
      period_year: null, period_month: null, period_day: null,
      employee_count: 0, eligible_count: 0, ineligible_count: 0, opt_out_count: 0,
      enrolled_count: 0, new_count: 0,
      total_gross_wages: 0, total_net_pay: 0, total_premium: 0, total_admin_fee: 0,
      total_benefit: 0, total_claim: 0, total_fica_savings: 0,
      bill_premium: 0, bill_claims: 0, bill_admin: 0, bill_savings: 0,
      file_name: fileName || null
    };
    const schedCount = {};
    Object.keys(c.snapshot).forEach(function (k) {
      const e = c.snapshot[k];
      g.employee_count++;
      if (e.elig) g.eligible_count++;
      if (e.opt) g.opt_out_count++;
      if (e.isnew && e.fin) g.new_count++;
      else if (e.fin) {
        g.enrolled_count++;
        // Bill and Savings Summary is computed over enrolled employees only.
        g.bill_premium += e.prem;
        g.bill_claims += e.claim;
        g.bill_admin += e.admin;
        g.bill_savings += Math.round(e.prem * 0.0765 * 100) / 100;
      }
      g.total_gross_wages += e.gross;
      g.total_net_pay += e.net;
      g.total_premium += e.prem;
      g.total_admin_fee += e.admin;
      g.total_benefit += e.ben;
      g.total_claim += e.claim;
      g.total_fica_savings += e.fica;
      if (!g.employer_name) g.employer_name = e.name;
      if (!g.employer_location) g.employer_location = e.loc;
      if (!g.state) g.state = e.state;
      if (!g.zip) g.zip = e.zip;
      if (e.sched) schedCount[e.sched] = (schedCount[e.sched] || 0) + 1;
      if (e.py) {
        const cur = g.period_year ? g.period_year * 10000 + g.period_month * 100 + g.period_day : 0;
        if (e.py * 10000 + e.pm * 100 + e.pd > cur) { g.period_year = e.py; g.period_month = e.pm; g.period_day = e.pd; }
      }
    });
    g.ineligible_count = g.employee_count - g.eligible_count - g.opt_out_count;
    let topSched = null, topN = 0;
    Object.keys(schedCount).forEach(function (s) { if (schedCount[s] > topN) { topN = schedCount[s]; topSched = s; } });
    g.pay_schedule = topSched;
    out.push(g);
  });
  skipped.no_qualifying_case = Object.keys(seenEin).length - out.length;
  out.sort(function (a, b) { return String(a.case_number).localeCompare(String(b.case_number)); });
  return { groups: out, skipped: skipped };
}




app.post('/api/admin/jobs/payroll-preview', requireAdmin, handleUpload('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No file uploaded' });
    const parsed = parsePayrollExport(req.file.buffer, req.file.originalname);
    const groups = parsed.groups;
    if (!groups.length) return res.status(400).json({ error: 'No companies with a done, finalized case found in this file' });
    const crypto = require('crypto');
    const previewToken = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    for (const [tk, v] of payrollPreviewCache) { if (v.expires < now) payrollPreviewCache.delete(tk); }
    payrollPreviewCache.set(previewToken, { groups: groups, expires: now + 30 * 60 * 1000, fileName: req.file.originalname });
    let employees = 0, reconBad = 0;
    groups.forEach(function (g) {
      employees += g.employee_count;
      if (g.ineligible_count + g.opt_out_count + g.eligible_count !== g.employee_count) reconBad++;
    });
    // How many companies will match to iM4 company codes? v6.9.0: EINs are
    // matched in canonical form (dash or no dash, leading zeros restored)
    // against the EIN cross-reference AND the companies table's own EINs.
    const db = getPool();
    let matched = 0;
    try {
      const tinSet = {};
      const xr = await db.query('SELECT DISTINCT tin FROM ein_account_xref WHERE tin IS NOT NULL');
      xr.rows.forEach(function (r) { const n = normEin(r.tin); if (n) tinSet[n] = true; });
      const ce = await db.query('SELECT DISTINCT ein FROM companies WHERE ein IS NOT NULL');
      ce.rows.forEach(function (r) { const n = normEin(r.ein); if (n) tinSet[n] = true; });
      groups.forEach(function (g) {
        const en = normEin(g.ein);
        if (en && tinSet[en]) matched++;
      });
    } catch (e) { /* xref table may not exist yet */ }
    res.json({
      ok: true,
      preview_token: previewToken,
      stats: {
        companies: groups.length, employees: employees,
        skipped_no_qualifying_case: parsed.skipped.no_qualifying_case,
        recon_mismatch: reconBad, xref_matched: matched,
        file_name: req.file.originalname
      },
      sample: groups.slice(0, 8)
    });
  } catch (error) { console.error('Payroll preview error:', error); res.status(500).json({ error: error.message || 'Internal server error' }); }
});

app.post('/api/admin/jobs/payroll-import', requireAdmin, async (req, res) => {
  try {
    const previewToken = req.body && req.body.preview_token;
    const cached = previewToken ? payrollPreviewCache.get(previewToken) : null;
    if (!cached || cached.expires < Date.now()) {
      if (previewToken) payrollPreviewCache.delete(previewToken);
      return res.status(400).json({ error: 'Preview expired. Upload the file again.' });
    }
    const groups = cached.groups;
    const db = getPool();
    // v6.12.0: payroll_company_summary IS the payroll table. Each import
    // appends one row per case for EACH company the case belongs to,
    // stamped with the company code and the dataset date; nothing is
    // pushed onto companies anymore (readers take the latest row).
    // Re-importing on the same day replaces that day's rows; earlier
    // datasets stay as history. Unmatched cases are stored unstamped.
    const acctByTin = {};
    const xr = await db.query('SELECT DISTINCT tin, acct FROM ein_account_xref WHERE tin IS NOT NULL AND acct IS NOT NULL');
    xr.rows.forEach(function (r) {
      const n = normEin(r.tin);
      if (!n || !r.acct) return;
      if (!acctByTin[n]) acctByTin[n] = [];
      acctByTin[n].push(String(r.acct).trim().replace(/^['"]+|['"]+$/g, ''));
    });
    // v6.9.0: fall back to the companies table's own EIN when the
    // cross-reference has no entry for it - every company carries an EIN,
    // so a payroll row whose EIN matches a company always lands.
    const ce = await db.query('SELECT company_code, ein FROM companies WHERE ein IS NOT NULL');
    ce.rows.forEach(function (r) {
      const n = normEin(r.ein);
      if (!n || !r.company_code) return;
      if (!acctByTin[n]) acctByTin[n] = [];
      if (acctByTin[n].indexOf(r.company_code) === -1) acctByTin[n].push(r.company_code);
    });
    const coSet = {};
    const allCos = await db.query('SELECT company_code FROM companies');
    allCos.rows.forEach(function (r) { coSet[String(r.company_code)] = true; });
    let imported = 0, companiesUpdated = 0, xrefMissed = 0;
    const stamped = {};
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM payroll_company_summary WHERE dataset_date = CURRENT_DATE');
      for (const g of groups) {
        const accts = (acctByTin[normEin(g.ein)] || []).filter(function (a) { return coSet[a]; });
        const periodEnd = payrollPeriodEnd(g);
        const targets = accts.length ? accts : [null];
        if (!accts.length) xrefMissed++;
        for (const acct of targets) {
          await client.query(
            'INSERT INTO payroll_company_summary (case_number, ein, employer_name, employer_location, state, zip, pay_schedule, period_year, period_month, period_day, employee_count, eligible_count, ineligible_count, opt_out_count, enrolled_count, new_count, total_gross_wages, total_net_pay, total_premium, total_admin_fee, total_benefit, total_claim, total_fica_savings, file_name, company_code, dataset_date, period_end, bill_premium, bill_claims, bill_admin, bill_savings) ' +
            'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,CURRENT_DATE,$26,$27,$28,$29,$30)',
            [g.case_number, g.ein, g.employer_name, g.employer_location, g.state, g.zip, g.pay_schedule,
             g.period_year, g.period_month, g.period_day, g.employee_count, g.eligible_count, g.ineligible_count,
             g.opt_out_count, g.enrolled_count, g.new_count, g.total_gross_wages, g.total_net_pay, g.total_premium,
             g.total_admin_fee, g.total_benefit, g.total_claim, g.total_fica_savings, g.file_name, acct, periodEnd,
             g.bill_premium, g.bill_claims, g.bill_admin, g.bill_savings]);
          if (acct && !stamped[acct]) { stamped[acct] = true; companiesUpdated++; }
        }
        imported++;
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (e2) {}
      throw e;
    } finally { client.release(); }
    payrollPreviewCache.delete(previewToken);
    res.json({ ok: true, imported: imported, companies_updated: companiesUpdated, xref_missed: xrefMissed });
  } catch (error) { console.error('Payroll import error:', error); res.status(500).json({ error: error.message || 'Internal server error' }); }
});

// ---------------------------------------------------------------- v5.33: EIN <-> account cross-reference
// Maps TIN (EIN) to Acct (company code) across sources.
const xrefPreviewCache = new Map();

function xrefDate(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return null;
}

function parseXrefExport(buffer, fileName) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  if (!rows.length) throw new Error('No data rows found in this file.');
  const norm = {};
  Object.keys(rows[0]).forEach(function (k) { norm[String(k).trim().toLowerCase()] = k; });
  function col() {
    for (let i = 0; i < arguments.length; i++) {
      const k = norm[String(arguments[i]).trim().toLowerCase()];
      if (k !== undefined) return k;
    }
    return null;
  }
  const cAcct = col('acct', 'account', 'account_code', 'company_code', 'company code');
  const cTin = col('tin', 'ein');
  if (!cAcct) throw new Error('Could not find an Acct (company code) column.');
  if (!cTin) throw new Error('Could not find a TIN (EIN) column.');
  const cHop = col('hop');
  const cGrp = col('group');
  const cName = col('acct name', 'account name', 'acct_name');
  const cA1 = col('addr 1', 'address 1', 'addr1');
  const cA2 = col('addr 2', 'address 2', 'addr2');
  const cCity = col('city');
  const cState = col('state');
  const cZip = col('zip', 'zipcode', 'zip code');
  const cEff = col('eff date', 'effective date', 'eff_date');
  const cTerm = col('term date', 'termination date', 'term_date');
  function txt(r, c) { return (c && r[c] !== null && r[c] !== undefined && String(r[c]).trim() !== '') ? String(r[c]).trim() : null; }
  const out = [];
  rows.forEach(function (r) {
    let acct = txt(r, cAcct);
    if (!acct) return;
    acct = acct.replace(/^['"]+|['"]+$/g, '').trim();
    out.push({
      hop: txt(r, cHop), grp: txt(r, cGrp), acct: acct, tin: txt(r, cTin),
      acct_name: txt(r, cName), addr1: txt(r, cA1), addr2: txt(r, cA2),
      city: txt(r, cCity), state: txt(r, cState), zip: txt(r, cZip),
      eff_date: cEff ? xrefDate(r[cEff]) : null,
      term_date: cTerm ? xrefDate(r[cTerm]) : null,
      file_name: fileName || null
    });
  });
  return out;
}

app.post('/api/admin/jobs/xref-preview', requireAdmin, handleUpload('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No file uploaded' });
    const rows = parseXrefExport(req.file.buffer, req.file.originalname);
    if (!rows.length) return res.status(400).json({ error: 'No rows found in this file' });
    const crypto = require('crypto');
    const previewToken = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    for (const [tk, v] of xrefPreviewCache) { if (v.expires < now) xrefPreviewCache.delete(tk); }
    xrefPreviewCache.set(previewToken, { rows: rows, expires: now + 30 * 60 * 1000, fileName: req.file.originalname });
    const accts = {};
    rows.forEach(function (r) { accts[r.acct] = true; });
    res.json({
      ok: true,
      preview_token: previewToken,
      stats: { rows: rows.length, accounts: Object.keys(accts).length, file_name: req.file.originalname },
      sample: rows.slice(0, 8)
    });
  } catch (error) { console.error('Xref preview error:', error); res.status(500).json({ error: error.message || 'Internal server error' }); }
});

app.post('/api/admin/jobs/xref-import', requireAdmin, async (req, res) => {
  try {
    const previewToken = req.body && req.body.preview_token;
    const cached = previewToken ? xrefPreviewCache.get(previewToken) : null;
    if (!cached || cached.expires < Date.now()) {
      if (previewToken) xrefPreviewCache.delete(previewToken);
      return res.status(400).json({ error: 'Preview expired. Upload the file again.' });
    }
    const rows = cached.rows;
    const db = getPool();
    await db.query('DELETE FROM ein_account_xref');
    let imported = 0;
    for (const r of rows) {
      await db.query(
        'INSERT INTO ein_account_xref (hop, grp, acct, tin, acct_name, addr1, addr2, city, state, zip, eff_date, term_date, file_name) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
        [r.hop, r.grp, r.acct, r.tin, r.acct_name, r.addr1, r.addr2, r.city, r.state, r.zip, r.eff_date, r.term_date, r.file_name]);
      imported++;
    }
    xrefPreviewCache.delete(previewToken);
    res.json({ ok: true, imported: imported });
  } catch (error) { console.error('Xref import error:', error); res.status(500).json({ error: error.message || 'Internal server error' }); }
});

// ---------------------------------------------------------------- v5.9: estimate unpaid F bills
const FTJ_MODE_NAMES = { '1': 'Weekly', '2': 'Bi-weekly', '3': 'Semi-monthly', '4': 'Monthly', 'M': 'Monthly' };

function ftjAddDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function ftjAddMonthsISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}
function ftjPad2(n) { return (n < 10 ? '0' : '') + n; }

// Most common two month-days in the paid history (semi-monthly pattern).
function ftjSemiMonthlyDays(history) {
  const counts = {};
  history.forEach(function (iso) {
    const day = parseInt(iso.slice(8, 10), 10);
    counts[day] = (counts[day] || 0) + 1;
  });
  const days = Object.keys(counts).map(Number).sort(function (a, b) { return counts[b] - counts[a]; });
  if (days.length >= 2) return [days[0], days[1]].sort(function (a, b) { return a - b; });
  return [1, 15];
}

// Expected payroll dates after lastISO (exclusive) through todayISO (inclusive),
// following the account's bill-mode pattern.
function ftjProjectDates(mode, lastISO, history, todayISO) {
  const out = [];
  if (mode === '1' || mode === '2') {
    const step = mode === '1' ? 7 : 14;
    let d = ftjAddDaysISO(lastISO, step);
    while (d <= todayISO) { out.push(d); d = ftjAddDaysISO(d, step); }
  } else if (mode === '4' || mode === 'M') {
    let n = 1;
    let d = ftjAddMonthsISO(lastISO, n);
    while (d <= todayISO) { out.push(d); n++; d = ftjAddMonthsISO(lastISO, n); }
  } else if (mode === '3') {
    const pair = ftjSemiMonthlyDays(history);
    let y = parseInt(lastISO.slice(0, 4), 10);
    let m = parseInt(lastISO.slice(5, 7), 10);
    for (let i = 0; i < 120; i++) {
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      pair.forEach(function (day) {
        if (day > lastDay) return;
        const iso = y + '-' + ftjPad2(m) + '-' + ftjPad2(day);
        if (iso > lastISO && iso <= todayISO) out.push(iso);
      });
      if (y + '-' + ftjPad2(m) + '-01' > todayISO) break;
      m++; if (m > 12) { m = 1; y++; }
    }
    out.sort();
  }
  return out;
}

// Infer bill mode from the median gap between paid payroll dates (fallback when
// bill_mode was never recorded, e.g. older manual CSV rows).
function ftjInferMode(history) {
  if (history.length < 2) return '';
  const gaps = [];
  for (let i = 1; i < history.length; i++) {
    gaps.push((new Date(history[i] + 'T00:00:00Z') - new Date(history[i - 1] + 'T00:00:00Z')) / 86400000);
  }
  gaps.sort(function (a, b) { return a - b; });
  const med = gaps[Math.floor(gaps.length / 2)];
  if (med >= 5 && med <= 9) return '1';
  if (med >= 12 && med <= 16) {
    // Ambiguous: bi-weekly (strict 14-day steps, drifting month-days) vs
    // semi-monthly (fixed month-days). Count distinct month-days.
    const mdays = {};
    history.forEach(function (iso) { mdays[parseInt(iso.slice(8, 10), 10)] = true; });
    return Object.keys(mdays).length <= 2 ? '3' : '2';
  }
  if (med >= 17 && med <= 23) return '3';
  if (med >= 26 && med <= 33) return '4';
  return '';
}

// Derive unpaid-bill estimates: for each F account, project expected payroll
// dates after its last paid bill through today; copy lives/total from the
// last paid bill. Skips dates that already have any F bill.
async function estimateUnpaidBills(db, maxStaleDays) {
  maxStaleDays = parseInt(maxStaleDays, 10);
  if (isNaN(maxStaleDays) || maxStaleDays < 0) maxStaleDays = 90;
  const paid = await db.query(
    "SELECT company_code, company_name, payroll_date, bill_mode, lives_count, total_invoice " +
    "FROM invoices WHERE bill_type = 'F' AND status = 'paid' AND payroll_date IS NOT NULL " +
    "ORDER BY company_code, payroll_date");
  const inactive = await db.query("SELECT company_code FROM companies WHERE company_status = 'TERMED'");
  const inactiveSet = {};
  inactive.rows.forEach(function (r) { inactiveSet[r.company_code] = true; });
  const all = await db.query("SELECT company_code, payroll_date FROM invoices WHERE bill_type = 'F' AND payroll_date IS NOT NULL");
  const have = {};
  all.rows.forEach(function (r) {
    have[r.company_code + '|' + new Date(r.payroll_date).toISOString().slice(0, 10)] = true;
  });
  const byAcct = {};
  paid.rows.forEach(function (row) {
    const code = row.company_code;
    if (!byAcct[code]) byAcct[code] = [];
    byAcct[code].push(row);
  });
  const today = new Date().toISOString().slice(0, 10);
  const accounts = [];
  let skippedStale = 0;
  let skippedInactive = 0;
  Object.keys(byAcct).sort().forEach(function (code) {
    const rows = byAcct[code];
    const last = rows[rows.length - 1];
    const lastISO = new Date(last.payroll_date).toISOString().slice(0, 10);
    if (inactiveSet[code]) { skippedInactive++; return; }
    const staleDays = Math.round((new Date(today + 'T00:00:00Z') - new Date(lastISO + 'T00:00:00Z')) / 86400000);
    if (staleDays > maxStaleDays) { skippedStale++; return; }
    const history = rows.map(function (x) { return new Date(x.payroll_date).toISOString().slice(0, 10); });
    const mc = {};
    rows.forEach(function (x) { const mm = String(x.bill_mode || '').toUpperCase(); if (mm) mc[mm] = (mc[mm] || 0) + 1; });
    let mode = Object.keys(mc).sort(function (a, b) { return mc[b] - mc[a]; })[0] || '';
    if (!mode) mode = ftjInferMode(history);
    const dates = ftjProjectDates(mode, lastISO, history, today).filter(function (d) {
      return !have[code + '|' + d];
    });
    if (dates.length === 0) return;
    accounts.push({
      stale_days: staleDays,
      company_code: code,
      company_name: last.company_name,
      frequency: FTJ_MODE_NAMES[mode] || mode || 'unknown',
      bill_mode: mode,
      last_paid: lastISO,
      lives_count: last.lives_count,
      total_invoice: last.total_invoice === null ? null : Number(last.total_invoice),
      estimates: dates
    });
  });
  return { accounts: accounts, skipped_stale: skippedStale, skipped_inactive: skippedInactive, max_stale_days: maxStaleDays };
}

app.post('/api/admin/jobs/ftj-estimate-preview', requireAdmin, async (req, res) => {
  // v6.2 (Leroy): estimates retired — Open Bills reports imported bills only.
  return res.status(400).json({ error: 'Estimates are retired: the Billing page now reports only imported bills. Existing estimates can be removed with Delete all estimates.' });
});

app.post('/api/admin/jobs/ftj-estimate-create', requireAdmin, async (req, res) => {
  // v6.2 (Leroy): estimates retired — Open Bills reports imported bills only.
  return res.status(400).json({ error: 'Estimates are retired: the Billing page now reports only imported bills. Existing estimates can be removed with Delete all estimates.' });
});

// Delete all open estimated bills (is_estimate). Real paid bills are never touched.
app.post('/api/admin/jobs/ftj-estimate-clear', requireAdmin, async (req, res) => {
  try {
    const del = await getPool().query("DELETE FROM invoices WHERE is_estimate = TRUE AND status = 'open'");
    res.json({ ok: true, deleted: del.rowCount });
  } catch (error) { console.error('FTJ estimate clear error:', error); res.status(500).json({ error: error.message || 'Internal server error' }); }
});

// ---------------------------------------------------------------- Soluta billing (S): report import
// The Soluta report carries both paid and pending bills — no estimating.
// Preview parses and caches; import adds new, updates changed, and deletes
// S bills missing from the report.
app.post('/api/admin/jobs/sol-preview', requireAdmin, handleUpload('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No file uploaded' });
    const bills = parseSolutaReport(req.file.buffer);
    if (bills.length === 0) return res.status(400).json({ error: 'No bills found in this file' });
    const db = getPool();
    const coRes = await db.query('SELECT company_code, company_name FROM companies');
    const coMap = {};
    coRes.rows.forEach(function (r) { coMap[String(r.company_code)] = r.company_name; });
    bills.forEach(function (b) { if (coMap[b.company_code]) b.company_name = coMap[b.company_code]; });
    const crypto = require('crypto');
    const previewToken = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    for (const [tk, v] of solPreviewCache) { if (v.expires < now) solPreviewCache.delete(tk); }
        solPreviewCache.set(previewToken, { bills: bills, expires: now + 30 * 60 * 1000, fileName: req.file.originalname });
    let total = 0, paid = 0, open = 0;
    const accounts = {};
    bills.forEach(function (b) {
      total += b.total_invoice;
      accounts[b.company_code] = true;
      if (b.status === 'paid') paid++; else open++;
    });
    res.json({
      ok: true,
      preview_token: previewToken,
      stats: {
        bills: bills.length, accounts: Object.keys(accounts).length,
        paid: paid, open: open, total_invoice: Math.round(total * 100) / 100,
        file_name: req.file.originalname
      },
      sample: bills.slice(0, 10)
    });
  } catch (error) { console.error('Soluta preview error:', error); res.status(500).json({ error: error.message || 'Internal server error' }); }
});

app.post('/api/admin/jobs/sol-import', requireAdmin, async (req, res) => {
  try {
    const previewToken = req.body && req.body.preview_token;
    const cached = previewToken ? solPreviewCache.get(previewToken) : null;
    if (!cached || cached.expires < Date.now()) {
      if (previewToken) solPreviewCache.delete(previewToken);
      return res.status(400).json({ error: 'Preview expired. Upload the report again.' });
    }
    const bills = cached.bills;
    const db = getPool();
    const exRes = await db.query("SELECT * FROM invoices WHERE bill_type = 'S'");
    const exMap = {};
    exRes.rows.forEach(function (r) {
      const pd = r.payroll_date ? new Date(r.payroll_date).toISOString().slice(0, 10) : '';
      exMap[r.company_code + '|' + pd] = r;
    });
    let added = 0, updated = 0;
    const seen = {};
    for (const b of bills) {
      const key = b.company_code + '|' + b.payroll_date;
      seen[key] = true;
      const ex = exMap[key];
      const paidDate = b.paid_date || null;
      const exEnd = ex && ex.payroll_end_date ? new Date(ex.payroll_end_date).toISOString().slice(0, 10) : null;
      if (ex) {
        const exPaid = ex.paid_date ? new Date(ex.paid_date).toISOString().slice(0, 10) : null;
        const same = !ex.is_estimate && String(ex.company_name) === String(b.company_name) &&
          Number(ex.lives_count) === Number(b.lives_count) &&
          Number(ex.total_invoice) === Number(b.total_invoice) &&
          ex.status === b.status && exPaid === paidDate &&
          String(ex.bill_mode || '') === String(b.bill_mode || '') &&
          String(ex.ein || '') === String(b.ein || '') &&
          exEnd === (b.payroll_end_date || null);
        if (!same) {
          await db.query('UPDATE invoices SET company_name = $1, lives_count = $2, total_invoice = $3, status = $4, paid_date = $5, is_estimate = FALSE, bill_mode = $6, ein = $7, payroll_end_date = $8, updated_at = NOW() WHERE id = $9',
            [b.company_name, b.lives_count, b.total_invoice, b.status, paidDate, b.bill_mode || null, b.ein || null, b.payroll_end_date || null, ex.id]);
          updated++;
        }
      } else {
        await db.query("INSERT INTO invoices (company_code, company_name, payroll_date, payroll_end_date, lives_count, total_invoice, status, paid_date, bill_type, bill_mode, ein) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'S', $9, $10)",
          [b.company_code, b.company_name, b.payroll_date, b.payroll_end_date || null, b.lives_count, b.total_invoice, b.status, paidDate, b.bill_mode || null, b.ein || null]);
        added++;
      }
    }
    let deleted = 0;
    for (const key of Object.keys(exMap)) {
      if (!seen[key] && !exMap[key].is_estimate) {
        await db.query('DELETE FROM invoices WHERE id = $1', [exMap[key].id]);
        deleted++;
      }
    }
    solPreviewCache.delete(previewToken);
    res.json({ ok: true, added: added, updated: updated, deleted: deleted, total: bills.length });
  } catch (error) { console.error('Soluta import error:', error); res.status(500).json({ error: error.message || 'Internal server error' }); }
});

// Soluta template + export: same columns the import reads.
app.get('/api/admin/jobs/sol-template', requireAdmin, async (req, res) => {
  try {
    const headers = ['IM4H_ID', 'EIN', 'GroupName', 'PayrollStart', 'PayrollEnd', 'BillingMode', 'Status', 'GrandTotal', 'Enrolled', 'RemitDate'];
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', 'attachment; filename="soluta-report-template.csv"');
    res.send(headers.join(',') + '\n');
  } catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/jobs/sol-export', requireAdmin, async (req, res) => {
  try {
    const r = await getPool().query(
      "SELECT company_code AS \"IM4H_ID\", ein AS \"EIN\", company_name AS \"GroupName\", " +
      "TO_CHAR(payroll_date, 'YYYY-MM-DD') AS \"PayrollStart\", " +
      "TO_CHAR(payroll_end_date, 'YYYY-MM-DD') AS \"PayrollEnd\", " +
      "CASE WHEN status = 'paid' THEN 'Paid' ELSE 'Due' END AS \"Status\", " +
      "total_invoice AS \"GrandTotal\", lives_count AS \"Enrolled\", bill_mode AS \"BillingMode\", " +
      "TO_CHAR(paid_date, 'YYYY-MM-DD') AS \"RemitDate\" " +
      "FROM invoices WHERE bill_type = 'S' ORDER BY company_code, payroll_date");
    const headers = ['IM4H_ID', 'EIN', 'GroupName', 'PayrollStart', 'PayrollEnd', 'BillingMode', 'Status', 'GrandTotal', 'Enrolled', 'RemitDate'];
    const lines = [headers.join(',')];
    r.rows.forEach(function (row) {
      lines.push(headers.map(function (h) {
        const v = row[h] === null || row[h] === undefined ? '' : String(row[h]);
        return v.indexOf(',') !== -1 || v.indexOf('"') !== -1 ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(','));
    });
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', 'attachment; filename="soluta-bills-export.csv"');
    res.send(lines.join('\n'));
  } catch (error) { console.error('Soluta export error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// Parse a commission schedule XLSX (the IM4_COMM_SETUP format) into
// { company_code, steward_code, pct } rows. Columns: ACCOUNT (or
// COMPANY_CODE) for the company code, ACCOUNT NAME, then repeating
// (AGENT, %) pairs where AGENT is
// "155026 - First Last" (steward ID + name) and % is a decimal
// (0.375 = 37.5%). Duplicate steward IDs for the same company are summed.
// Each company's percentages must add up to 100%.
function parseCommissionSchedule(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: false });
  if (arr.length < 2) throw new Error('No data rows found in the spreadsheet.');
  const headers = (arr[0] || []).map(function (h) { return String(h || '').toUpperCase().trim(); });
  let acctIdx = headers.indexOf('ACCOUNT');
  if (acctIdx === -1) acctIdx = headers.indexOf('COMPANY_CODE');
  if (acctIdx === -1) acctIdx = headers.indexOf('COMPANY CODE');
  if (acctIdx === -1) throw new Error('Could not find the ACCOUNT (or COMPANY_CODE) column.');
  // Find (AGENT, %) pairs: an AGENT column followed by a % column.
  const pairs = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if ((h.indexOf('AGENT') !== -1 || h.indexOf('WRITING') !== -1 || h.indexOf('STEWARD') !== -1) && i + 1 < headers.length) {
      const nh = headers[i + 1];
      if (nh.indexOf('%') !== -1) pairs.push({ agent: i, pct: i + 1 });
    }
  }
  if (pairs.length === 0) throw new Error('Could not find the AGENT / % columns.');
  const rows = [];
  const errors = [];
  for (let ri = 1; ri < arr.length; ri++) {
    const r = arr[ri] || [];
    const acctRaw = r[acctIdx];
    if (acctRaw === null || acctRaw === undefined || String(acctRaw).trim() === '') continue;
    const companyCode = String(acctRaw).trim();
    const rawBySteward = {};
    for (const p of pairs) {
      const agentRaw = r[p.agent];
      if (agentRaw === null || agentRaw === undefined || String(agentRaw).trim() === '') continue;
      // "155026 - RLJAT" -> steward ID "155026"
      const stewardId = String(agentRaw).split(' - ')[0].trim().split(' ')[0];
      if (!stewardId) continue;
      const pctRaw = r[p.pct];
      if (pctRaw === null || pctRaw === undefined || String(pctRaw).trim() === '') continue;
      const dec = parseFloat(String(pctRaw));
      if (isNaN(dec)) {
        errors.push('Row ' + (ri + 1) + ': invalid % "' + pctRaw + '" for steward ' + stewardId);
        continue;
      }
      rawBySteward[stewardId] = (rawBySteward[stewardId] || 0) + dec;
    }
    const rawIds = Object.keys(rawBySteward);
    if (rawIds.length === 0) continue;
    // Leroy's sheet carries decimals (0.125 = 12.5%); accept percents
    // (12.5) too - decide per company by which total the raw values hit.
    const rawTotal = rawIds.reduce(function (a, sid) { return a + rawBySteward[sid]; }, 0);
    let factor = null;
    if (Math.abs(rawTotal - 1) <= 0.02) factor = 100;
    else if (Math.abs(rawTotal - 100) <= 1) factor = 1;
    if (factor === null) {
      errors.push('Company ' + companyCode + ': percentages sum to ' + (Math.round(rawTotal * 10000) / 10000) + ', not 100 (or 1.0 as decimals).');
      continue;
    }
    const bySteward = {};
    rawIds.forEach(function (sid) { bySteward[sid] = Math.round(rawBySteward[sid] * factor * 10000) / 10000; });
    const stewardIds = Object.keys(bySteward);
    const total = stewardIds.reduce(function (a, sid) { return a + bySteward[sid]; }, 0);
    if (Math.abs(total - 100) > 0.01) {
      errors.push('Company ' + companyCode + ': percentages sum to ' + (Math.round(total * 100) / 100) + ', not 100.');
    }
    for (const sid of stewardIds) {
      rows.push({ company_code: companyCode, steward_code: sid, pct: Math.round(bySteward[sid] * 10000) / 10000 });
    }
  }
  return { rows: rows, errors: errors };
}

app.post('/api/admin/jobs/commissions-parse', requireAdmin, handleUpload('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No file uploaded' });
    const parsed = parseCommissionSchedule(req.file.buffer);
    res.json({ ok: true, rows: parsed.rows, errors: parsed.errors, file_name: req.file.originalname });
  } catch (error) { console.error('Commission parse error:', error); res.status(500).json({ error: error.message || 'Internal server error' }); }
});

// ---------------------------------------------------------------- v5.9: delete bills (admin)
// Any combination of statuses (open/paid), bill types (F/S), and accounts.
app.post('/api/admin/billing/delete-bills', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const accounts = Array.isArray(body.accounts) ? body.accounts.map(function (a) { return String(a); }) : [];
    const statuses = Array.isArray(body.statuses) ? body.statuses.filter(function (x) { return x === 'open' || x === 'paid'; }) : [];
    const types = Array.isArray(body.types) ? body.types.filter(function (x) { return x === 'F' || x === 'S'; }) : [];
    if (statuses.length === 0 || types.length === 0) {
      return res.status(400).json({ error: 'Pick at least one status (paid/unpaid) and one bill type (F/S).' });
    }
    const params = [statuses, types];
    let where = 'status = ANY($1) AND bill_type = ANY($2)';
    if (accounts.length > 0) { params.push(accounts); where += ' AND company_code = ANY($3)'; }
    const del = await getPool().query('DELETE FROM invoices WHERE ' + where, params);
    res.json({ ok: true, deleted: del.rowCount });
  } catch (error) { console.error('Delete bills error:', error); res.status(500).json({ error: error.message || 'Internal server error' }); }
});

// ---------------------------------------------------------------- admin: stewards (read-only list; import only; password + roles set here)
// ------------------------------------------- steward payee / tax id (v6.18, Leroy)
// Stewards gained company/address fields plus Payee and Tax ID (used by
// the referral fee statement process). Payee is 'Steward' or 'Company'
// and decides the Tax ID format: Steward = SSN (###-##-####), Company =
// EIN (##-#######). Tax IDs are stored digits-only. The full number is
// returned ONLY by the editor's reveal endpoint (Admin + Onboarding);
// every list payload carries the masked form - last four digits visible,
// the rest X's (XXX-XX-1234 for an SSN, XX-XXX1234 for an EIN).
function taxIdDigits(v) { return String(v || '').replace(/[^0-9]/g, ''); }
function formatTaxId(digits, payee) {
  if (!digits) return '';
  if (payee === 'Company') return digits.slice(0, 2) + '-' + digits.slice(2);
  return digits.slice(0, 3) + '-' + digits.slice(3, 5) + '-' + digits.slice(5);
}
function maskTaxId(digits, payee) {
  if (!digits) return '';
  const last4 = digits.slice(-4);
  return payee === 'Company' ? 'XX-XXX' + last4 : 'XXX-XX-' + last4;
}
// Shared validation for the create/update steward endpoints. Returns
// { payee, taxId, hasTax, error }: hasTax is false when the body carries
// no tax_id key at all (update endpoints then leave the stored value
// untouched, so a failed reveal can never wipe a Tax ID by accident).
function parsePayeeTax(b) {
  const payee = b.payee === undefined || b.payee === null ? '' : String(b.payee).trim();
  if (payee !== '' && payee !== 'Steward' && payee !== 'Company') {
    return { error: 'Payee must be Steward or Company' };
  }
  const hasTax = Object.prototype.hasOwnProperty.call(b, 'tax_id');
  let taxId = null;
  if (hasTax) {
    const raw = b.tax_id === null || b.tax_id === undefined ? '' : String(b.tax_id).trim();
    if (raw === '') { taxId = null; }
    else {
      const digits = taxIdDigits(raw);
      if (digits.length !== 9) {
        return { error: payee === 'Company'
          ? 'Tax ID must be a 9-digit EIN (##-#######)'
          : 'Tax ID must be a 9-digit SSN (###-##-####)' };
      }
      if (!payee) return { error: 'Choose a Payee (Steward or Company) - the Tax ID format depends on it' };
      taxId = digits;
    }
  }
  return { payee: payee || null, taxId: taxId, hasTax: hasTax };
}
function cleanOpt(v) { return v && String(v).trim() !== '' ? String(v).trim() : null; }

app.get('/api/admin/stewards', requireStewardsAccess, async (req, res) => {
  try {
    const r = await getPool().query(
      "SELECT s.id, s.email, s.first_name, s.last_name, s.name, s.phone, s.steward_company_name, s.address, s.city, s.state, s.zip, s.payee, s.tax_id, s.statement_email, s.role, s.created_at, " +
      "COALESCE(array_agg(ur.role) FILTER (WHERE ur.role IS NOT NULL), '{}') AS roles " +
      "FROM stewards s LEFT JOIN user_roles ur ON ur.steward_id = s.id " +
      "GROUP BY s.id ORDER BY CASE WHEN s.role = 'admin' THEN 0 ELSE 1 END, s.id");
    // v6.18: the full Tax ID never rides in a list payload - masked only.
    r.rows.forEach(function (row) {
      row.tax_id_masked = maskTaxId(row.tax_id, row.payee);
      delete row.tax_id;
    });
    // v6.16 (Leroy): nobody but an Admin may see the admin or commissions
    // roles, or who holds them. For every other viewer those two roles are
    // stripped from this payload (stored assignments are untouched), and a
    // person whose only visible trace was a hidden role shows their next
    // visible role instead.
    if (req.user.activeRole !== 'admin') {
      const hiddenRoles = { admin: true, commissions: true };
      r.rows.forEach(function (row) {
        row.roles = (row.roles || []).filter(function (x) { return !hiddenRoles[x]; });
        if (hiddenRoles[row.role]) row.role = row.roles[0] || 'steward';
      });
    }
    res.json(r.rows);
  } catch (error) {
    console.error('Admin stewards error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// The steward editor's reveal: the ONLY endpoint that returns a full
// Tax ID, and only to the roles that maintain stewards (Admin +
// Onboarding). Returns the number formatted per the steward's Payee.
app.get('/api/admin/stewards/:id/tax-id', requireAdminOrOnboarding, async (req, res) => {
  try {
    const r = await getPool().query('SELECT payee, tax_id FROM stewards WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = r.rows[0];
    res.json({ payee: row.payee || '', tax_id: formatTaxId(row.tax_id, row.payee) });
  } catch (error) {
    console.error('Steward tax-id reveal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ------------------------------------------- steward W9 / ACH documents
// One stored file per steward per type, kept in steward_documents.
// Admin + Onboarding only: Top Dog does not see these at all (the
// Stewards page hides the columns for top_dog, and these endpoints
// refuse the role too). Uploading replaces the file on file.
app.get('/api/admin/stewards/documents-status', requireAdminOrOnboarding, async (req, res) => {
  try {
    const r = await getPool().query('SELECT steward_id, doc_type, file_name FROM steward_documents ORDER BY steward_id, doc_type');
    const map = {};
    r.rows.forEach(function (x) {
      if (!map[x.steward_id]) map[x.steward_id] = { w9: null, ach: null };
      map[x.steward_id][x.doc_type] = x.file_name;
    });
    res.json(map);
  } catch (error) { console.error('Steward documents status error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/stewards/:id/documents/:type', requireAdminOrOnboarding, handleUpload('file'), async (req, res) => {
  try {
    const type = String(req.params.type || '');
    if (type !== 'w9' && type !== 'ach') return res.status(400).json({ error: 'Document type must be w9 or ach' });
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid steward id' });
    if (!req.file) return res.status(400).json({ error: 'A file is required' });
    const db = getPool();
    const st = await db.query('SELECT id FROM stewards WHERE id = $1', [id]);
    if (!st.rows.length) return res.status(404).json({ error: 'Steward not found' });
    await db.query(
      'INSERT INTO steward_documents (steward_id, doc_type, file_name, mime_type, file_data, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6) ' +
      'ON CONFLICT (steward_id, doc_type) DO UPDATE SET file_name = EXCLUDED.file_name, mime_type = EXCLUDED.mime_type, file_data = EXCLUDED.file_data, uploaded_by = EXCLUDED.uploaded_by, updated_at = NOW()',
      [id, type, req.file.originalname, req.file.mimetype, req.file.buffer, req.user.id]);
    res.json({ ok: true });
  } catch (error) { console.error('Steward document upload error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/stewards/:id/documents/:type/download', requireAdminOrOnboarding, async (req, res) => {
  try {
    const type = String(req.params.type || '');
    if (type !== 'w9' && type !== 'ach') return res.status(400).json({ error: 'Document type must be w9 or ach' });
    const r = await getPool().query('SELECT file_name, mime_type, file_data FROM steward_documents WHERE steward_id = $1 AND doc_type = $2', [parseInt(req.params.id, 10), type]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'No document on file' });
    const f = r.rows[0];
    res.set('Content-Type', f.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="' + String(f.file_name).replace(/"/g, '') + '"');
    res.send(f.file_data);
  } catch (error) { console.error('Steward document download error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/admin/stewards/:id/documents/:type', requireAdminOrOnboarding, async (req, res) => {
  try {
    const type = String(req.params.type || '');
    if (type !== 'w9' && type !== 'ach') return res.status(400).json({ error: 'Document type must be w9 or ach' });
    await getPool().query('DELETE FROM steward_documents WHERE steward_id = $1 AND doc_type = $2', [parseInt(req.params.id, 10), type]);
    res.json({ ok: true });
  } catch (error) { console.error('Steward document delete error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/stewards/next-id', requireAdminOrOnboarding, async (req, res) => {
  try {
    const r = await getPool().query('SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM stewards');
    res.json({ next_id: parseInt(r.rows[0].next_id, 10) });
  } catch (error) { console.error('Next steward id error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// Create a steward from the Stewards page (admin + onboarding). The ID is the
// next number (MAX(id)+1) and the Steward role is assigned automatically.
// Only an admin may request a specific ID instead of the next number.
app.post('/api/admin/stewards', requireAdminOrOnboarding, async (req, res) => {
  try {
    const b = req.body || {};
    const first = String(b.first_name || '').trim();
    const last = String(b.last_name || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const phone = b.phone && String(b.phone).trim() !== '' ? String(b.phone).trim() : null;
    const stmtEmail = b.statement_email && String(b.statement_email).trim() !== '' ? String(b.statement_email).trim().toLowerCase() : null;
    if (stmtEmail && stmtEmail.indexOf('@') === -1) return res.status(400).json({ error: 'Statement Email must be a valid email address' });
    const pt = parsePayeeTax(b);
    if (pt.error) return res.status(400).json({ error: pt.error });
    let pwHash = null;
    if (b.password && String(b.password) !== '') {
      if (String(b.password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      pwHash = await bcrypt.hash(String(b.password), 10);
    }
    if (!first) return res.status(400).json({ error: 'First name is required' });
    if (!last) return res.status(400).json({ error: 'Last name is required' });
    if (!email || email.indexOf('@') === -1) return res.status(400).json({ error: 'A valid email is required' });
    const db = getPool();
    const dupe = await db.query('SELECT id FROM stewards WHERE LOWER(email) = $1', [email]);
    if (dupe.rows.length) return res.status(400).json({ error: 'That email is already used by steward ' + dupe.rows[0].id });
    const mx = await db.query('SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM stewards');
    let newId = parseInt(mx.rows[0].next_id, 10);
    if (b.id !== undefined && b.id !== null && String(b.id).trim() !== '') {
      const want = parseInt(b.id, 10);
      if (isNaN(want) || want <= 0) return res.status(400).json({ error: 'Steward ID must be a positive number' });
      if (want !== newId) {
        if (req.user.activeRole !== 'admin') return res.status(403).json({ error: 'Only an admin can choose the Steward ID' });
        const taken = await db.query('SELECT id FROM stewards WHERE id = $1', [want]);
        if (taken.rows.length) return res.status(400).json({ error: 'Steward ID ' + want + ' is already in use' });
        newId = want;
      }
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "INSERT INTO stewards (id, email, name, first_name, last_name, phone, steward_company_name, address, city, state, zip, payee, tax_id, statement_email, password_hash, role) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'steward')",
        [newId, email, (first + ' ' + last).trim(), first, last, phone, cleanOpt(b.steward_company_name), cleanOpt(b.address), cleanOpt(b.city), cleanOpt(b.state), cleanOpt(b.zip), pt.payee, pt.hasTax ? pt.taxId : null, stmtEmail, pwHash]);
      await client.query("INSERT INTO user_roles (steward_id, role) VALUES ($1, 'steward') ON CONFLICT DO NOTHING", [newId]);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (rb) { /* ignore */ }
      throw e;
    } finally { client.release(); }
    await db.query("SELECT setval('stewards_id_seq', COALESCE((SELECT MAX(id) FROM stewards), 1))");
    res.json({ success: true, id: newId });
  } catch (error) { console.error('Admin create steward error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/stewards/:id/password', requireAdminOrOnboarding, async (req, res) => {
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

// Edit a steward's profile fields (admin + top dog). First name, last name,
// and email are required; phone is optional.
app.put('/api/admin/stewards/:id', requireAdminOrOnboarding, async (req, res) => {
  try {
    const { first_name, last_name, email, phone, statement_email, password } = req.body || {};
    const first = String(first_name || '').trim();
    const last = String(last_name || '').trim();
    const em = String(email || '').trim().toLowerCase();
    if (!first) return res.status(400).json({ error: 'First name is required' });
    if (!last) return res.status(400).json({ error: 'Last name is required' });
    if (!em || em.indexOf('@') === -1) return res.status(400).json({ error: 'A valid email is required' });
    const stmtEmail = statement_email && String(statement_email).trim() !== '' ? String(statement_email).trim().toLowerCase() : null;
    if (stmtEmail && stmtEmail.indexOf('@') === -1) return res.status(400).json({ error: 'Statement Email must be a valid email address' });
    const pt = parsePayeeTax(req.body || {});
    if (pt.error) return res.status(400).json({ error: pt.error });
    const coName = cleanOpt(req.body.steward_company_name);
    const addr = cleanOpt(req.body.address);
    const city = cleanOpt(req.body.city);
    const state = cleanOpt(req.body.state);
    const zip = cleanOpt(req.body.zip);
    let pwHash = null;
    if (password && String(password) !== '') {
      if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      pwHash = await bcrypt.hash(String(password), 10);
    }
    const db = getPool();
    const dupe = await db.query('SELECT id FROM stewards WHERE LOWER(email) = $1 AND id <> $2', [em, req.params.id]);
    if (dupe.rows.length) return res.status(400).json({ error: 'That email is already used by steward ' + dupe.rows[0].id });
    const sets = ['first_name = $1', 'last_name = $2', 'email = $3', 'phone = $4', 'statement_email = $5',
      "name = TRIM(COALESCE($1,'') || ' ' || COALESCE($2,''))"];
    const params = [first, last, em, phone && String(phone).trim() !== '' ? String(phone).trim() : null, stmtEmail];
    params.push(coName); sets.push('steward_company_name = $' + params.length);
    params.push(addr); sets.push('address = $' + params.length);
    params.push(city); sets.push('city = $' + params.length);
    params.push(state); sets.push('state = $' + params.length);
    params.push(zip); sets.push('zip = $' + params.length);
    params.push(pt.payee); sets.push('payee = $' + params.length);
    // tax_id joins the update only when the body carries the key (see
    // parsePayeeTax): an editor that could not reveal the stored number
    // omits it, and the stored Tax ID is left untouched.
    if (pt.hasTax) { params.push(pt.taxId); sets.push('tax_id = $' + params.length); }
    if (pwHash) { params.push(pwHash); sets.push('password_hash = $' + params.length); }
    params.push(req.params.id);
    const r = await db.query(
      'UPDATE stewards SET ' + sets.join(', ') + ' WHERE id = $' + params.length + ' RETURNING id', params);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Admin edit steward error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Renumber a steward's ID from the Stewards page. Copies the steward row to
// the new ID (plain PK UPDATEs are impossible: FKs are not deferrable),
// repoints all 8 referencing tables + commissions.steward_code, deletes the
// old row, restores the email — one atomic transaction on a dedicated
// client. If you renumber your own account, sign out and back in afterwards.
app.post('/api/admin/stewards/:id/renumber', requireAdmin, async (req, res) => {
  try {
    const db = getPool();
    const oldId = parseInt(req.params.id, 10);
    const newId = parseInt(req.body && req.body.new_id, 10);
    if (isNaN(oldId) || oldId <= 0) return res.status(400).json({ error: 'Invalid steward id' });
    if (isNaN(newId) || newId <= 0) return res.status(400).json({ error: 'New ID must be a positive number' });
    if (newId === oldId) return res.status(400).json({ error: 'New ID is the same as the current ID' });
    const target = await db.query('SELECT id, email FROM stewards WHERE id = $1', [oldId]);
    if (target.rows.length === 0) return res.status(404).json({ error: 'Steward not found' });
    const origEmail = target.rows[0].email;
    const taken = await db.query('SELECT id, email FROM stewards WHERE id = $1', [newId]);
    // Self-heal: an interrupted renumber (v5.14.5's non-atomic migration) may
    // have left a '.renumber-tmp' ghost copy at the target ID. If the ghost
    // is this steward's own copy (verified by temp email), reuse it instead
    // of failing: skip the INSERT, repoint (idempotent), delete the old row,
    // restore the email.
    let reuseGhost = false;
    if (taken.rows.length > 0) {
      const ghostEmail = taken.rows[0].email || '';
      if (ghostEmail === origEmail + '.renumber-tmp') {
        reuseGhost = true;
      } else {
        return res.status(400).json({ error: 'ID ' + newId + ' is already in use by ' + ghostEmail });
      }
    }
    const client = await db.connect();
    let step = 'connect';
    try {
      step = 'BEGIN';
      await client.query('BEGIN');
      if (!reuseGhost) {
        step = 'INSERT copy';
        await client.query(
          'INSERT INTO stewards (id, email, name, created_at, role, password_hash, first_name, last_name, phone, statement_email, ' +
          'reset_token, reset_expires, two_factor_enabled) ' +
          "SELECT $1, email || '.renumber-tmp', name, created_at, role, password_hash, first_name, last_name, phone, statement_email, " +
          'reset_token, reset_expires, two_factor_enabled FROM stewards WHERE id = $2',
          [newId, oldId]);
      }
      const repoints = [
        ['assignments', 'UPDATE assignments SET steward_id = $1 WHERE steward_id = $2'],
        ['messages', 'UPDATE messages SET steward_id = $1 WHERE steward_id = $2'],
        ['user_roles', 'UPDATE user_roles SET steward_id = $1 WHERE steward_id = $2'],
        ['password_reset_tokens', 'UPDATE password_reset_tokens SET steward_id = $1 WHERE steward_id = $2'],
        ['two_factor_codes', 'UPDATE two_factor_codes SET steward_id = $1 WHERE steward_id = $2'],
        ['onboarding_clients', 'UPDATE onboarding_clients SET created_by = $1 WHERE created_by = $2'],
        ['onboarding_documents', 'UPDATE onboarding_documents SET uploaded_by = $1 WHERE uploaded_by = $2'],
        ['forms', 'UPDATE forms SET uploaded_by = $1 WHERE uploaded_by = $2'],
        ['commissions', 'UPDATE commissions SET steward_code = $1 WHERE steward_code = $2'],
      ];
      for (const [label, sql] of repoints) {
        step = 'repoint ' + label;
        await client.query(sql, [newId, oldId]);
      }
      step = 'DELETE old steward';
      await client.query('DELETE FROM stewards WHERE id = $1', [oldId]);
      step = 'restore email';
      await client.query('UPDATE stewards SET email = $1 WHERE id = $2', [origEmail, newId]);
      step = 'setval sequence';
      await client.query("SELECT setval('stewards_id_seq', COALESCE((SELECT MAX(id) FROM stewards), 1))");
      step = 'COMMIT';
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (rb) { /* ignore */ }
      e.renumberStep = step;
      throw e;
    } finally {
      client.release();
    }
    res.json({ success: true, old_id: oldId, new_id: newId, reused_ghost: reuseGhost });
  } catch (error) {
    console.error('Admin renumber steward error:', error);
    const stepInfo = error.renumberStep ? ' (failed at step: ' + error.renumberStep + ')' : '';
    res.status(500).json({ error: (error.message || 'Internal server error') + stepInfo });
  }
});

// Delete a steward (admin only). Refuses to delete the last admin or
// yourself. Assignments and roles are removed with the steward; messages,
// documents, forms, and tickets keep their content but lose the author link.
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
      await db.query('UPDATE onboarding_clients SET created_by = NULL WHERE created_by = $1', [id]);
      await db.query('UPDATE onboarding_documents SET uploaded_by = NULL WHERE uploaded_by = $1', [id]);
      await db.query('UPDATE forms SET uploaded_by = NULL WHERE uploaded_by = $1', [id]);
      await db.query('UPDATE steward_documents SET uploaded_by = NULL WHERE uploaded_by = $1', [id]);
      await db.query('UPDATE tickets SET created_by = NULL WHERE created_by = $1', [id]);
      await db.query('UPDATE tickets SET assigned_to = NULL WHERE assigned_to = $1', [id]);
      await db.query('UPDATE ticket_replies SET author_id = NULL WHERE author_id = $1', [id]);
      await db.query('UPDATE ar_followups SET created_by = NULL WHERE created_by = $1', [id]);
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
    const allowed = ['admin', 'steward', 'top_dog', 'onboarding', 'client', 'service', 'commissions'];
    if (!steward_id || !Array.isArray(roles) || roles.length === 0) {
      return res.status(400).json({ error: 'steward_id and a non-empty roles array are required' });
    }
    for (const r of roles) {
      if (allowed.indexOf(r) === -1) return res.status(400).json({ error: 'Invalid role: ' + r });
    }
    const db = getPool();
    const s = await db.query('SELECT id FROM stewards WHERE id = $1', [steward_id]);
    if (s.rows.length === 0) return res.status(404).json({ error: 'Steward not found' });
    if (roles.indexOf('admin') === -1) {
      const cur = await db.query("SELECT role FROM user_roles WHERE steward_id = $1 AND role = 'admin'", [steward_id]);
      if (cur.rows.length > 0) {
        const cnt = await db.query("SELECT COUNT(*) AS c FROM user_roles WHERE role = 'admin'");
        if (parseInt(cnt.rows[0].c, 10) <= 1) {
          return res.status(400).json({ error: 'Cannot remove the admin role from the last admin' });
        }
      }
    }
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
app.get('/api/admin/companies', requireCompaniesAccess, async (req, res) => {
  try {
    const r = await getPool().query('SELECT * FROM companies c ' + numericCodeSort('c'));
    const inv = await getPool().query(
      "SELECT company_code, COUNT(*) AS n, COALESCE(SUM(total_invoice), 0) AS total " +
      "FROM invoices WHERE status = 'open' GROUP BY company_code");
    const invMap = {};
    inv.rows.forEach(function (x) { invMap[x.company_code] = x; });
    const rows = r.rows.map(function (c) {
      const iv = invMap[c.company_code] || { n: 0, total: 0 };
      c.open_invoice_count = parseInt(iv.n, 10);
      c.open_invoice_total = parseFloat(iv.total);
      return c;
    });
    res.json(rows);
  } catch (error) {
    console.error('Admin companies error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Set a company's status (admin/top dog). Accepts { company_status:
// 'ACTIVE' | 'TERMED' | 'PENDING' } or the legacy { active: true/false }.
// Termed companies keep all their data but are hidden from steward views
// and billing. (v6.13.0: the old active boolean column is gone; status is
// the only source of truth.)
app.post('/api/admin/companies/:code/active', requireAdminOrTopDog, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Company code is required' });
    let status = null;
    const rawStatus = req.body && req.body.company_status;
    if (rawStatus !== undefined && rawStatus !== null && String(rawStatus).trim() !== '') {
      const sv = String(rawStatus).trim().toUpperCase();
      if (sv === 'ACTIVE' || sv === 'PENDING') status = sv;
      else if (sv === 'TERMED' || sv === 'TERMINATED') status = 'TERMED';
      else return res.status(400).json({ error: 'company_status must be ACTIVE, TERMED, or PENDING' });
    } else {
      const active = req.body && req.body.active;
      if (active !== true && active !== false) return res.status(400).json({ error: 'Provide company_status (ACTIVE, TERMED, or PENDING) or active (true/false)' });
      status = active ? 'ACTIVE' : 'TERMED';
    }
    const r = await getPool().query(
      'UPDATE companies SET company_status = $1 WHERE company_code = $2 RETURNING company_code, company_status',
      [status, code]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    res.json({ success: true, company_code: r.rows[0].company_code, company_status: r.rows[0].company_status });
  } catch (error) {
    console.error('Admin set company status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ------------------------------------------------- v5.48: company maintenance (Companies page)
// Access, from Leroy's instructions: Onboarding can add a Company and add
// (or later update) all the fields (all fields required). Only an Admin
// can delete a company. Top Dog views only. Changing the Company Code
// itself is admin-only (like changing a Steward ID) because bills,
// commissions, and the EIN cross-reference key on it; a change cascades
// to all of them in one transaction.
function companyFieldValues(b) {
  const t = function (v) { return v !== undefined && v !== null ? String(v).trim() : ''; };
  return {
    parent_code: t(b.parent_code).toUpperCase(),
    parent_name: t(b.parent_name),
    company_code: t(b.company_code),
    ein: t(b.ein),
    company_name: t(b.company_name),
    address_1: t(b.address_1 || b.company_address_1),
    city: t(b.city || b.company_city),
    state: t(b.state || b.company_state).toUpperCase(),
    zip: t(b.zip || b.company_zip),
    company_status: t(b.company_status).toUpperCase() || 'ACTIVE',
    billing_email: t(b.billing_email),
    pay_frequency: t(b.pay_frequency),
    version: t(b.version),
    type: t(b.type)
  };
}
function companyFieldErrors(v) {
  // v6.15.1 (Leroy): the only required company fields are Parent Code,
  // Parent Name, Company Code, EIN, and Company Name. Everything else is
  // optional; format rules still apply to any value that is provided.
  const errs = [];
  if (!/^PC\d{4}$/.test(v.parent_code)) errs.push('Parent Code must be "PC" plus four numbers (for example PC0007).');
  if (!v.parent_name) errs.push('Parent Name is required.');
  if (!/^\d{4}$/.test(v.company_code)) errs.push('Company Code must be four numbers.');
  if (!/^\d{2}-\d{7}$/.test(v.ein)) errs.push('EIN must be two numbers, a dash, and seven more numbers (for example 47-5096437).');
  if (!v.company_name) errs.push('Company Name is required.');
  if (v.company_status && ['ACTIVE', 'PENDING', 'TERMED'].indexOf(v.company_status) === -1) errs.push('Company Status must be ACTIVE, PENDING, or TERMED.');
  if (v.billing_email && v.billing_email.indexOf('@') === -1) errs.push('Billing Email must be a valid email address.');
  return errs;
}

app.post('/api/admin/companies', requireAdmin, async (req, res) => {
  try {
    const v = companyFieldValues(req.body || {});
    // v6.7 (Leroy): the Parent must already exist on the Parent page; the
    // Parent Name always comes from the Parent page, never from this form.
    const canon = await canonicalParent(getPool(), v.parent_code);
    if (!canon) return res.status(400).json({ error: 'Parent Code ' + (v.parent_code || '(blank)') + ' is not on the Parent page. Parent Codes and Names are managed on the Parent page only.' });
    v.parent_name = canon.name;
    const errs = companyFieldErrors(v);
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const db = getPool();
    const dupe = await db.query('SELECT company_name FROM companies WHERE company_code = $1', [v.company_code]);
    if (dupe.rows.length) return res.status(400).json({ error: 'Company Code ' + v.company_code + ' is already in use by ' + dupe.rows[0].company_name + '. Company Codes must be unique.' });
    const r = await db.query(
      'INSERT INTO companies (company_code, company_name, parent_company_code, parent_company_name, ein, address_1, city, state, zip, company_status, billing_email, pay_frequency, version, type) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *',
      [v.company_code, v.company_name, v.parent_code, v.parent_name, v.ein, v.address_1, v.city, v.state, v.zip, v.company_status, v.billing_email || null, v.pay_frequency || null, v.version || null, v.type || null]);
    res.json({ success: true, company: r.rows[0] });
  } catch (error) {
    console.error('Admin create company error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/api/admin/companies/:code', requireAdminOrOnboarding, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    const v = companyFieldValues(req.body || {});
    // v6.7 (Leroy): Admin and Onboarding may reassign a company to another
    // EXISTING Parent Code; the Parent Name always comes from the Parent
    // page. Creating or renaming Parents happens only on the Parent page.
    const canon = await canonicalParent(getPool(), v.parent_code);
    if (!canon) return res.status(400).json({ error: 'Parent Code ' + (v.parent_code || '(blank)') + ' is not on the Parent page. Parent Codes and Names are managed on the Parent page only.' });
    v.parent_name = canon.name;
    const errs = companyFieldErrors(v);
    if (errs.length) return res.status(400).json({ error: errs.join(' ') });
    const db = getPool();
    const cur = await db.query('SELECT company_code, parent_company_code FROM companies WHERE company_code = $1', [code]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Company not found' });
    const codeChange = v.company_code !== code;
    if (codeChange) {
      if (!req.user || req.user.activeRole !== 'admin') {
        return res.status(403).json({ error: 'Only an Admin can change a Company Code.' });
      }
      const dupe = await db.query('SELECT company_name FROM companies WHERE company_code = $1', [v.company_code]);
      if (dupe.rows.length) return res.status(400).json({ error: 'Company Code ' + v.company_code + ' is already in use by ' + dupe.rows[0].company_name + '. Company Codes must be unique.' });
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      if (codeChange) {
        await client.query('UPDATE invoices SET company_code = $1 WHERE company_code = $2', [v.company_code, code]);
        await client.query('UPDATE commissions SET company_code = $1 WHERE company_code = $2', [v.company_code, code]);
        await client.query('UPDATE ein_account_xref SET acct = $1 WHERE acct = $2', [v.company_code, code]);
        await client.query('UPDATE companies SET parent_company_code = $1 WHERE parent_company_code = $2', [v.company_code, code]);
      }
      const r = await client.query(
        'UPDATE companies SET company_code = $1, company_name = $2, parent_company_code = $3, parent_company_name = $4, ' +
        'ein = $5, address_1 = $6, city = $7, state = $8, zip = $9, company_status = $10, billing_email = $11, pay_frequency = $12, version = $13, type = $14 WHERE company_code = $15 RETURNING *',
        [v.company_code, v.company_name, v.parent_code, v.parent_name, v.ein, v.address_1, v.city, v.state, v.zip, v.company_status, v.billing_email || null, v.pay_frequency || null, v.version || null, v.type || null, code]);
      await client.query('COMMIT');
      res.json({ success: true, company: r.rows[0] });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Admin update company error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/admin/companies/:code', requireAdmin, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    const db = getPool();
    const cur = await db.query('SELECT company_name FROM companies WHERE company_code = $1', [code]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Company not found' });
    const bills = await db.query('SELECT COUNT(*) AS n FROM invoices WHERE company_code = $1', [code]);
    if (Number(bills.rows[0].n) > 0) {
      return res.status(400).json({ error: 'Company ' + code + ' (' + cur.rows[0].company_name + ') has ' + bills.rows[0].n + ' bill(s) on file and cannot be deleted. Term the company instead, or remove its bills first.' });
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM commissions WHERE company_code = $1', [code]);
      await client.query('DELETE FROM ein_account_xref WHERE acct = $1', [code]);
      await client.query('DELETE FROM companies WHERE company_code = $1', [code]);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Admin delete company error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- admin: assignments (read-only list; import only)
// ------------------------------------------- commission schedule documents (v6.0)
// One stored Commission Schedule per company (company_documents). Uploading
// one reads it and pre-populates that company's stewards and percentages.
// Admin + Onboarding only, matching the Commissions page editor.
app.get('/api/admin/companies/commission-schedules-status', requireAdminOrOnboarding, async (req, res) => {
  try {
    const r = await getPool().query('SELECT company_code, file_name FROM company_documents ORDER BY company_code');
    const map = {};
    r.rows.forEach(function (x) { map[x.company_code] = x.file_name; });
    res.json(map);
  } catch (error) { console.error('Schedule status error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/companies/:code/commission-schedule', requireAdminOrOnboarding, handleUpload('file'), async (req, res) => {
  const db = getPool();
  const client = await db.connect();
  try {
    const code = String(req.params.code || '').trim();
    const co = await db.query('SELECT company_code FROM companies WHERE company_code = $1', [code]);
    if (!co.rows.length) { client.release(); return res.status(404).json({ error: 'Company not found' }); }
    if (!req.file) { client.release(); return res.status(400).json({ error: 'A file is required' }); }
    let parsed;
    try { parsed = parseCommissionSchedule(req.file.buffer); }
    catch (e) { client.release(); return res.status(400).json({ error: 'Could not read that file as a Commission Schedule: ' + e.message }); }
    const mine = parsed.rows.filter(function (r) { return String(r.company_code) === code; });
    const fileCompanies = {};
    parsed.rows.forEach(function (r) { fileCompanies[String(r.company_code)] = true; });
    const blockers = parsed.errors.filter(function (e) {
      if (e.indexOf('Company ' + code + ':') === 0) return true;
      return Object.keys(fileCompanies).length <= 1;
    });
    if (blockers.length) { client.release(); return res.status(400).json({ error: blockers[0] }); }
    if (!mine.length) { client.release(); return res.status(400).json({ error: 'That file has no commission rows for company ' + code + '. Nothing was changed.' }); }
    const stMap = {};
    (await db.query('SELECT id FROM stewards')).rows.forEach(function (x) { stMap[String(x.id)] = true; });
    const unknown = mine.map(function (r) { return String(r.steward_code); }).filter(function (sid) { return !stMap[sid]; });
    if (unknown.length) { client.release(); return res.status(400).json({ error: 'Steward ID(s) not on the Stewards table: ' + unknown.join(', ') + '. Add the steward first, then upload again.' }); }
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO company_documents (company_code, file_name, mime_type, file_data, uploaded_by) VALUES ($1, $2, $3, $4, $5) ' +
      'ON CONFLICT (company_code) DO UPDATE SET file_name = EXCLUDED.file_name, mime_type = EXCLUDED.mime_type, file_data = EXCLUDED.file_data, uploaded_by = EXCLUDED.uploaded_by, updated_at = NOW()',
      [code, req.file.originalname, req.file.mimetype, req.file.buffer, req.user.id]);
    await client.query('DELETE FROM commissions WHERE company_code = $1', [code]);
    for (const r of mine) {
      await client.query('INSERT INTO commissions (company_code, steward_code, pct) VALUES ($1, $2, $3)', [code, parseInt(r.steward_code, 10), r.pct]);
    }
    await client.query('COMMIT');
    client.release();
    res.json({ ok: true, entries: mine.length, file_name: req.file.originalname });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    client.release();
    console.error('Schedule upload error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/admin/companies/:code/commission-schedule/download', requireAdminOrOnboarding, async (req, res) => {
  try {
    const r = await getPool().query('SELECT file_name, mime_type, file_data FROM company_documents WHERE company_code = $1', [String(req.params.code || '').trim()]);
    if (!r.rows.length) return res.status(404).json({ error: 'No Commission Schedule on file for this company' });
    const f = r.rows[0];
    res.set('Content-Type', f.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="' + String(f.file_name).replace(/"/g, '') + '"');
    res.send(f.file_data);
  } catch (error) { console.error('Schedule download error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/admin/companies/:code/commission-schedule', requireAdminOrOnboarding, async (req, res) => {
  try {
    await getPool().query('DELETE FROM company_documents WHERE company_code = $1', [String(req.params.code || '').trim()]);
    res.json({ ok: true });
  } catch (error) { console.error('Schedule delete error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// ACH Authorization file per company (v6.7, Leroy): one stored file per
// company on the Companies maintenance page. Upload/replace/delete by the
// page's editors (Admin + Onboarding); view/download by Admin, Top Dog,
// and Onboarding. The file is stored as-is (never parsed).
app.get('/api/admin/companies/ach-documents-status', requireAdminTopDogOnboarding, async (req, res) => {
  try {
    const r = await getPool().query('SELECT company_code, file_name FROM company_ach_documents ORDER BY company_code');
    const map = {};
    r.rows.forEach(function (x) { map[x.company_code] = x.file_name; });
    res.json(map);
  } catch (error) { console.error('ACH status error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/admin/companies/:code/ach-document', requireAdminOrOnboarding, handleUpload('file'), async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    const co = await getPool().query('SELECT company_code FROM companies WHERE company_code = $1', [code]);
    if (!co.rows.length) return res.status(404).json({ error: 'Company not found' });
    if (!req.file) return res.status(400).json({ error: 'A file is required' });
    await getPool().query(
      'INSERT INTO company_ach_documents (company_code, file_name, mime_type, file_data, uploaded_by) VALUES ($1, $2, $3, $4, $5) ' +
      'ON CONFLICT (company_code) DO UPDATE SET file_name = EXCLUDED.file_name, mime_type = EXCLUDED.mime_type, file_data = EXCLUDED.file_data, uploaded_by = EXCLUDED.uploaded_by, updated_at = NOW()',
      [code, req.file.originalname, req.file.mimetype, req.file.buffer, req.user.id]);
    res.json({ ok: true, file_name: req.file.originalname });
  } catch (error) { console.error('ACH upload error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/companies/:code/ach-document/download', requireAdminTopDogOnboarding, async (req, res) => {
  try {
    const r = await getPool().query('SELECT file_name, mime_type, file_data FROM company_ach_documents WHERE company_code = $1', [String(req.params.code || '').trim()]);
    if (!r.rows.length) return res.status(404).json({ error: 'No ACH Authorization on file for this company' });
    const f = r.rows[0];
    res.set('Content-Type', f.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename=\"' + String(f.file_name).replace(/\"/g, '') + '\"');
    res.send(f.file_data);
  } catch (error) { console.error('ACH download error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/admin/companies/:code/ach-document', requireAdminOrOnboarding, async (req, res) => {
  try {
    await getPool().query('DELETE FROM company_ach_documents WHERE company_code = $1', [String(req.params.code || '').trim()]);
    res.json({ ok: true });
  } catch (error) { console.error('ACH delete error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/admin/assignments', requireAdminOrTopDog, async (req, res) => {
  try {
    const r = await getPool().query(
      "SELECT a.id, a.steward_id, c.company_code, c.company_name, s.email AS steward_email, " +
      "CASE WHEN COALESCE(s.first_name, '') <> '' OR COALESCE(s.last_name, '') <> '' " +
      "THEN TRIM(COALESCE(s.first_name, '') || ' ' || COALESCE(s.last_name, '')) ELSE COALESCE(s.name, '') END AS steward_name " +
      'FROM assignments a JOIN stewards s ON s.id = a.steward_id JOIN companies c ON c.id = a.company_id ' +
      'ORDER BY a.steward_id, c.company_code');
    res.json(r.rows);
  } catch (error) {
    console.error('Admin assignments error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- admin: import (bulk updates; stewards and companies also have page maintenance)
// stewards:    steward_id, email, first_name, last_name, phone, password (everyone imported is a steward)
// companies:   parent_code, parent_name, company_code, ein, company_name,
//               company_address_1, company_city, company_state, company_zip,
//               company_status
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
    'account': 'company_code',
    'account #': 'company_code',
    'company code': 'company_code',
    'acct': 'company_code',
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
      // v6.15.1 (Leroy): required company fields are parent_company_code,
      // parent_company_name, company_code, ein, and company_name only.
      if (!row.company_code) { e('company_code is required'); return; }
      if (!row.company_name) { e('company_name is required'); return; }
      const parentCode = row.parent_code || row.parent_company_code;
      const parentName = row.parent_name || row.parent_company_name;
      if (!parentCode || !String(parentCode).trim()) { e('parent_company_code is required'); return; }
      if (!parentName || !String(parentName).trim()) { e('parent_company_name is required'); return; }
      if (!row.ein || !String(row.ein).trim()) { e('ein is required'); return; }
      const key = String(row.company_code).trim();
      if (seen[key]) { e('duplicate company_code in file'); return; }
      seen[key] = true;
      let status = null;
      const statusRaw = row.company_status !== undefined && row.company_status !== null ? String(row.company_status).trim() : '';
      if (statusRaw !== '') {
        const sv = statusRaw.toUpperCase();
        if (sv === 'ACTIVE') status = 'ACTIVE';
        else if (sv === 'TERMED' || sv === 'TERMINATED') status = 'TERMED';
        else if (sv === 'PENDING') status = 'PENDING';
        else { e('company_status must be ACTIVE, TERMED, or PENDING (got "' + row.company_status + '")'); return; }
      } else if (row.active !== undefined && row.active !== null && String(row.active).trim() !== '') {
        const av = String(row.active).trim().toLowerCase();
        if (['yes', 'y', 'true', '1', 'active'].indexOf(av) !== -1) status = 'ACTIVE';
        else if (['no', 'n', 'false', '0', 'inactive', 'termed', 'terminated'].indexOf(av) !== -1) status = 'TERMED';
        else if (av === 'pending') status = 'PENDING';
        else { e('active must be Yes/No (got "' + row.active + '")'); return; }
      }
      const txt = function (v) { return v !== undefined && v !== null && String(v).trim() !== '' ? String(v).trim() : null; };
      valid.push({
        company_code: key, company_name: String(row.company_name).trim(),
        parent_company_code: parentCode ? String(parentCode).trim() : null,
        parent_company_name: parentName ? String(parentName).trim() : null,
        company_status: status,
        ein: txt(row.ein),
        address_1: txt(row.company_address_1 || row.address_1 || row['address 1'] || row['company address 1']),
        city: txt(row.company_city || row.city),
        state: txt(row.company_state || row.state),
        zip: txt(row.company_zip || row.zip || row.zipcode),
        pay_frequency: txt(row.pay_frequency || row['pay frequency'] || row.pay_schedule || row['pay schedule']),
        version: txt(row.version),
        type: txt(row.type)
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
    if (type === 'assignments' && v.valid.length > 0) {
      // Predecessor rule (Leroy): an assignment can only be imported when
      // its steward is already on the Stewards table AND its company is
      // already on the Companies table. Missing either blocks the import.
      const gateDb = getPool();
      const stSet = {};
      (await gateDb.query('SELECT id FROM stewards')).rows.forEach(function (x) { stSet[String(x.id)] = true; });
      const coSet = {};
      (await gateDb.query('SELECT company_code FROM companies')).rows.forEach(function (x) { coSet[String(x.company_code)] = true; });
      const kept = [];
      for (const a of v.valid) {
        if (!stSet[String(a.steward_id)]) {
          v.errors.push('Steward ' + a.steward_id + ' is not on the Stewards table - import the steward before assigning them (the assignment to company ' + a.company_code + ' was not imported).');
          continue;
        }
        if (!coSet[String(a.company_code)]) {
          v.errors.push('Company ' + a.company_code + ' is not on the Companies table - import the company before assigning stewards to it (steward ' + a.steward_id + ' was not assigned).');
          continue;
        }
        kept.push(a);
      }
      v.valid = kept;
      if (dry_run === false && v.errors.length > 0) {
        return res.json({ success: false, errors: v.errors });
      }
    }
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
          const detailSets =
            'ein = COALESCE(EXCLUDED.ein, companies.ein), ' +
            'address_1 = COALESCE(EXCLUDED.address_1, companies.address_1), ' +
            'city = COALESCE(EXCLUDED.city, companies.city), ' +
            'state = COALESCE(EXCLUDED.state, companies.state), ' +
            'zip = COALESCE(EXCLUDED.zip, companies.zip), ' +
            'pay_frequency = COALESCE(EXCLUDED.pay_frequency, companies.pay_frequency), ' +
            'version = COALESCE(EXCLUDED.version, companies.version), ' +
            'type = COALESCE(EXCLUDED.type, companies.type)';
          if (c.company_status === null || c.company_status === undefined) {
            await db.query(
              'INSERT INTO companies (company_code, company_name, parent_company_code, parent_company_name, ein, address_1, city, state, zip, pay_frequency, version, type) ' +
              'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ' +
              'ON CONFLICT (company_code) DO UPDATE SET company_name = EXCLUDED.company_name, ' +
              'parent_company_code = EXCLUDED.parent_company_code, parent_company_name = EXCLUDED.parent_company_name, ' + detailSets,
              [c.company_code, c.company_name, c.parent_company_code, c.parent_company_name, c.ein, c.address_1, c.city, c.state, c.zip, c.pay_frequency, c.version, c.type]);
          } else {
            await db.query(
              'INSERT INTO companies (company_code, company_name, parent_company_code, parent_company_name, company_status, ein, address_1, city, state, zip, pay_frequency, version, type) ' +
              'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ' +
              'ON CONFLICT (company_code) DO UPDATE SET company_name = EXCLUDED.company_name, ' +
              'parent_company_code = EXCLUDED.parent_company_code, parent_company_name = EXCLUDED.parent_company_name, ' +
              'company_status = EXCLUDED.company_status, ' + detailSets,
              [c.company_code, c.company_name, c.parent_company_code, c.parent_company_name, c.company_status, c.ein, c.address_1, c.city, c.state, c.zip, c.pay_frequency, c.version, c.type]);
          }
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

// ---------------------------------------------------------------- admin CSV exports (download anything importable)
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
function toCSV(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  rows.forEach(function (r) { lines.push(headers.map(function (h) { return csvCell(r[h]); }).join(',')); });
  return lines.join('\r\n');
}
app.get('/api/admin/export/:type', requireAdmin, async (req, res) => {
  try {
    const type = req.params.type;
    const db = getPool();
    let headers, rows;
    if (type === 'stewards') {
      headers = ['steward_id', 'email', 'first_name', 'last_name', 'phone'];
      rows = (await db.query('SELECT id AS steward_id, email, first_name, last_name, phone FROM stewards ORDER BY id')).rows;
    } else if (type === 'companies') {
      headers = ['parent_code', 'parent_name', 'company_code', 'ein', 'company_name', 'company_address_1', 'company_city', 'company_state', 'company_zip', 'company_status'];
      rows = (await db.query(
        "SELECT parent_company_code AS parent_code, parent_company_name AS parent_name, company_code, ein, company_name, " +
        "address_1 AS company_address_1, city AS company_city, state AS company_state, zip AS company_zip, " +
        "company_status " +
        'FROM companies ORDER BY company_code')).rows;
    } else if (type === 'assignments') {
      headers = ['steward_id', 'company_code'];
      rows = (await db.query(
        'SELECT a.steward_id, c.company_code FROM assignments a JOIN companies c ON c.id = a.company_id ' +
        'ORDER BY a.steward_id, c.company_code')).rows;
    } else if (type === 'billing') {
      headers = ['company_code', 'company_name', 'ein', 'payroll_date', 'payroll_end_date', 'lives_count', 'total_invoice', 'status', 'paid_date', 'bill_type', 'bill_mode'];
      rows = (await db.query(
        "SELECT company_code, company_name, ein, TO_CHAR(payroll_date, 'YYYY-MM-DD') AS payroll_date, " +
        "TO_CHAR(payroll_end_date, 'YYYY-MM-DD') AS payroll_end_date, lives_count, " +
        "total_invoice, status, TO_CHAR(paid_date, 'YYYY-MM-DD') AS paid_date, bill_type, bill_mode FROM invoices " +
        'ORDER BY company_code, payroll_date')).rows;
    } else if (type === 'commissions') {
      // Leroy's sheet format, matching the Excel import exactly: COMPANY_CODE,
      // then STEWARD #1 / #1 %, STEWARD #2 / #2 %, ... Agent cells are
      // "155026 - NAME"; % cells are decimals (0.375 = 37.5%).
      const r = await db.query(
        'SELECT c.company_code, c.steward_code, c.pct, s.first_name, s.last_name, s.email ' +
        'FROM commissions c LEFT JOIN stewards s ON s.id = c.steward_code ' +
        'ORDER BY c.company_code, c.steward_code');
      const byCo = {};
      const order = [];
      r.rows.forEach(function (x) {
        if (!byCo[x.company_code]) { byCo[x.company_code] = []; order.push(x.company_code); }
        byCo[x.company_code].push(x);
      });
      let maxPairs = 0;
      order.forEach(function (c) { maxPairs = Math.max(maxPairs, byCo[c].length); });
      const h = ['COMPANY_CODE'];
      for (let pi = 0; pi < maxPairs; pi++) h.push('STEWARD #' + (pi + 1), '#' + (pi + 1) + ' %');
      const lines = [h.join(',')];
      order.forEach(function (c) {
        const cells = [csvCell(c)];
        byCo[c].forEach(function (x) {
          const nm = (((x.first_name || '') + ' ' + (x.last_name || '')).trim() || x.email || '');
          cells.push(csvCell(nm ? (x.steward_code + ' - ' + nm) : String(x.steward_code)));
          cells.push(csvCell(String(Math.round((Number(x.pct) / 100) * 1000000) / 1000000)));
        });
        while (cells.length < h.length) cells.push('');
        lines.push(cells.join(','));
      });
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="commissions.csv"');
      return res.send(lines.join('\r\n'));
    } else {
      return res.status(400).json({ error: 'unknown export type' });
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="' + type + '.csv"');
    res.send(toCSV(headers, rows));
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- admin: commission table import
// Wide format: one line per company — company_code, then repeating
// steward_code,pct pairs (steward_code is the Steward ID). The file is the
// complete commission table for every company code it mentions: validated
// all-or-nothing first, then existing rows for those companies are replaced.
// Any problem rejects the whole file with an explanation and imports nothing.
app.post('/api/admin/import-commissions', requireAdmin, async (req, res) => {
  try {
    const { rows, dry_run } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows array is required' });
    const db = getPool();
    const coMap = {};
    (await db.query('SELECT company_code FROM companies')).rows.forEach(function (x) { coMap[String(x.company_code)] = true; });
    const stMap = {};
    (await db.query('SELECT id FROM stewards')).rows.forEach(function (x) { stMap[String(x.id)] = true; });
    const errors = [];
    const valid = [];
    const seen = {};
    const perCompany = {};
    rows.map(normalizeRow).forEach(function (row, idx) {
      const line = idx + 2;
      const e = function (msg) { errors.push('Row ' + line + ': ' + msg); };
      const code = row.company_code ? String(row.company_code).trim() : '';
      const scRaw = row.steward_code ? String(row.steward_code).trim() : '';
      if (!code) { e('company_code is required'); return; }
      // Predecessor rule (Leroy): commissions can only be imported for a
      // company that already exists on the Companies table, and a steward
      // who already exists on the Stewards table. Anything missing blocks
      // the whole import - nothing is skipped silently.
      if (!coMap[code]) { e('company ' + code + ' is not on the Companies table - add or import the company before importing its commissions'); return; }
      if (!scRaw) { e('steward_code is required'); return; }
      const scId = parseInt(scRaw, 10);
      if (isNaN(scId) || scId <= 0) { e('steward_code "' + scRaw + '" must be a Steward ID number'); return; }
      if (!stMap[String(scId)]) { e('steward ' + scId + ' is not on the Stewards table - add or import the steward before importing commissions for them'); return; }
      const key = code + '|' + scId;
      if (seen[key]) { e('duplicate steward ' + scId + ' for company ' + code + ' in this file'); return; }
      seen[key] = true;
      let pct = null;
      if (row.pct !== undefined && row.pct !== null && String(row.pct).trim() !== '') {
        pct = parseFloat(String(row.pct).trim().replace('%', ''));
      }
      if (pct === null || isNaN(pct)) { e('pct must be a number, e.g. 25 for 25%'); return; }
      if (pct <= 0 || pct > 100) { e('pct must be greater than 0 and at most 100'); return; }
      valid.push({ company_code: code, steward_code: scId, pct: pct });
      if (!perCompany[code]) perCompany[code] = [];
      perCompany[code].push(pct);
    });
    Object.keys(perCompany).forEach(function (code) {
      const pcts = perCompany[code];
      if (pcts.length > 10) {
        errors.push('Company ' + code + ': ' + pcts.length + ' stewards in this file — at most 10 stewards per company. The file was rejected and nothing was imported.');
      }
      const total = pcts.reduce(function (a, b) { return a + b; }, 0);
      const rounded = Math.round(total * 100) / 100;
      if (Math.abs(total - 100) > 0.01) {
        errors.push('Company ' + code + ': the percentages add up to ' + rounded + ', not 100. The file was rejected and nothing was imported.');
      }
    });
    if (errors.length > 0) {
      return res.json({ success: false, errors: errors });
    }
    const companyCount = Object.keys(perCompany).length;
    if (dry_run !== false) {
      return res.json({ success: true, dry_run: true, valid_count: valid.length, companies: companyCount, errors: [] });
    }
    for (const code of Object.keys(perCompany)) {
      await db.query('DELETE FROM commissions WHERE company_code = $1', [code]);
    }
    let imported = 0;
    for (const v of valid) {
      await db.query(
        'INSERT INTO commissions (company_code, steward_code, pct) VALUES ($1, $2, $3) ' +
        'ON CONFLICT (company_code, steward_code) DO UPDATE SET pct = EXCLUDED.pct',
        [v.company_code, v.steward_code, v.pct]);
      imported++;
    }
    res.json({ success: true, dry_run: false, imported: imported, companies: companyCount, errors: [] });
  } catch (error) {
    console.error('Commission import error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Commissions page data: one entry per company with its stewards and percentages.
app.get('/api/admin/commissions-by-company', requireCommissionsPageViewer, async (req, res) => {
  try {
    const r = await getPool().query(
      'SELECT co.company_code, co.company_name, co.ein, co.company_status, c.steward_code, c.pct, ' +
      's.first_name, s.last_name, s.email ' +
      'FROM companies co ' +
      'LEFT JOIN commissions c ON c.company_code = co.company_code ' +
      'LEFT JOIN stewards s ON s.id = c.steward_code ' +
      'ORDER BY co.company_code, c.steward_code');
    const byCompany = {};
    const order = [];
    r.rows.forEach(function (row) {
      const code = row.company_code;
      if (!byCompany[code]) {
        byCompany[code] = {
          company_code: code,
          company_name: row.company_name || code,
          ein: row.ein || '',
          company_status: row.company_status || 'ACTIVE',
          stewards: []
        };
        order.push(code);
      }
      if (row.steward_code === null || row.steward_code === undefined) return;
      var name = ((row.first_name || '') + ' ' + (row.last_name || '')).trim() || row.email || '';
      byCompany[code].stewards.push({
        steward_code: row.steward_code,
        name: name,
        pct: row.pct
      });
    });
    res.json(order.map(function (code) { return byCompany[code]; }));
  } catch (error) {
    console.error('Commissions by company error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// v6.8 (Leroy): an Admin can delete a company's whole commission row (all
// of its splits) from the Commissions page. The company itself stays.
app.delete('/api/admin/commissions/:code', requireAdmin, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    const co = await getPool().query('SELECT company_code FROM companies WHERE company_code = $1', [code]);
    if (!co.rows.length) return res.status(404).json({ error: 'Company not found' });
    const r = await getPool().query('DELETE FROM commissions WHERE company_code = $1', [code]);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (error) { console.error('Commission row delete error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// ------------------------------------------------- v5.51: save one company's commissions (Commissions page editor)
// Admin + Onboarding only (Top Dog views only). Body: { entries:
// [{ steward_code, pct }] } with pct as a DECIMAL (0.125 = 12.5%), the
// sheet convention. The entries must total 100% (stored units) or the
// save is refused; an empty entries list clears the company's
// commissions. Company code, name, and EIN are NOT editable here - they
// are driven by the Companies page.
app.put('/api/admin/commissions/:code', requireAdminOrOnboarding, async (req, res) => {
  try {
    const code = String(req.params.code || '').trim();
    const db = getPool();
    const co = await db.query('SELECT company_code FROM companies WHERE company_code = $1', [code]);
    if (!co.rows.length) return res.status(404).json({ error: 'Company not found' });
    const entries = (req.body && Array.isArray(req.body.entries)) ? req.body.entries : null;
    if (!entries) return res.status(400).json({ error: 'entries array is required' });
    const cleaned = [];
    const seenStewards = {};
    for (const e of entries) {
      const sid = parseInt(String(e && e.steward_code !== undefined ? e.steward_code : '').trim(), 10);
      const dec = parseFloat(e && e.pct);
      if (isNaN(sid) || sid <= 0) return res.status(400).json({ error: 'Every agent row needs a valid Steward ID.' });
      if (isNaN(dec) || dec <= 0 || dec > 1) return res.status(400).json({ error: 'Every % must be a decimal above 0 and at most 1 (for example 0.125 for 12.5%).' });
      if (seenStewards[sid]) return res.status(400).json({ error: 'Steward ' + sid + ' is listed twice - combine their share into one row.' });
      seenStewards[sid] = true;
      cleaned.push({ steward_code: sid, pct: Math.round(dec * 100 * 10000) / 10000 });
    }
    if (cleaned.length > 0) {
      const total = cleaned.reduce(function (a, x) { return a + x.pct; }, 0);
      if (Math.abs(total - 100) > 0.01) {
        return res.status(400).json({ error: 'The % column must add up to 100% before this can be saved. It currently adds up to ' + (Math.round(total * 100) / 100) + '%.' });
      }
      const ids = cleaned.map(function (x) { return x.steward_code; });
      const found = await db.query('SELECT id FROM stewards WHERE id = ANY($1)', [ids]);
      const foundSet = {};
      found.rows.forEach(function (r) { foundSet[r.id] = true; });
      const missing = ids.filter(function (id) { return !foundSet[id]; });
      if (missing.length) return res.status(400).json({ error: 'Steward ID(s) not on the steward list: ' + missing.join(', ') + '.' });
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM commissions WHERE company_code = $1', [code]);
      for (const x of cleaned) {
        await client.query('INSERT INTO commissions (company_code, steward_code, pct) VALUES ($1, $2, $3)', [code, x.steward_code, x.pct]);
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
    res.json({ success: true, company_code: code, entries: cleaned.length });
  } catch (error) {
    console.error('Save commissions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- ticket system
// ---------------------------------------------------------------- v6.17: referral fees (commission calculation)
// Periods, source-file imports, pending rows. FTJ (F) built first; the
// Soluta (S) import and period lockdown + statements are later builds.
// Statement date for a calculated line: the first of the month following
// the applied date (Leroy). appliedISO is the group's latest Applied Date.
function statementDateFor(appliedISO) {
  if (!appliedISO) return null;
  const y = parseInt(appliedISO.slice(0, 4), 10);
  const m = parseInt(appliedISO.slice(5, 7), 10);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return ny + '-' + ('0' + nm).slice(-2) + '-01';
}

// Admin factors by Bill Mode (Leroy): Enrolled (lives) = total Admin Fee
// divided by the factor for the pay frequency.
const REFERRAL_FACTORS = { '1': 9.23, '2': 18.46, '3': 20, '4': 40, 'M': 40 };

// Rounding rule (v6.17.1, Leroy): each pending row is rounded to the cent,
// so a period's rows can total a few cents more or less than its admin
// fees. ONE adjustment record per period carries the exact difference,
// posted to RLJAT (steward 155026, per Leroy's commission files), so the
// period always foots exactly: rows + adjustment = admin fees. Recomputed
// after every import into the period.
const REFERRAL_ROUNDING_STEWARD_ID = 155026;
async function refreshReferralAdjustment(db, periodId) {
  const t = await db.query(
    'SELECT (SELECT COALESCE(SUM(admin_fee), 0) FROM referral_fee_lines WHERE period_id = $1) AS admin_total, ' +
    '(SELECT COALESCE(SUM(referral_fee), 0) FROM referral_fee_pending WHERE period_id = $1) AS fees_total, ' +
    '(SELECT COUNT(*) FROM referral_fee_lines WHERE period_id = $1) AS line_count', [periodId]);
  const lineCount = parseInt(t.rows[0].line_count, 10);
  if (!lineCount) return null;
  const adjCents = Math.round(Number(t.rows[0].admin_total) * 100) - Math.round(Number(t.rows[0].fees_total) * 100);
  const amount = adjCents / 100;
  await db.query(
    'INSERT INTO referral_fee_adjustments (period_id, steward_id, steward_name, amount, updated_at) VALUES ($1, $2, $3, $4, NOW()) ' +
    'ON CONFLICT (period_id) DO UPDATE SET steward_id = EXCLUDED.steward_id, steward_name = EXCLUDED.steward_name, amount = EXCLUDED.amount, updated_at = NOW()',
    [periodId, REFERRAL_ROUNDING_STEWARD_ID, 'RLJAT', amount]);
  return { steward_id: REFERRAL_ROUNDING_STEWARD_ID, steward_name: 'RLJAT', amount: amount };
}

// Calculate one FTJ Premium Applied Report into pending referral fee rows
// for a period. Only the Admin Fees are used (products with PRODUCT ID
// 'ADMIN', signed amounts, so backouts net out). One calculated line per
// (company, modal date); one pending row per steward on the company's
// commission split, at the percentages on file when the calculation runs.
// A (source, company, modal date) that has already been calculated - in
// ANY period - is ignored. Groups that cannot be calculated are reported
// in `skipped` with the reason (never silently dropped).
async function runReferralImportF(db, buffer, fileName, periodId, userId) {
  const bills = parsePremiumApplied(buffer);
  const per = await db.query('SELECT * FROM referral_fee_periods WHERE id = $1', [periodId]);
  if (!per.rows.length) throw new Error('Referral fee period not found.');
  if (per.rows[0].status !== 'open') throw new Error('That referral fee period is locked.');
  const compR = await db.query('SELECT company_code, company_name FROM companies');
  const compMap = {};
  compR.rows.forEach(function (c) { compMap[c.company_code] = c; });
  const cmR = await db.query('SELECT company_code, steward_code, pct FROM commissions ORDER BY company_code, steward_code');
  const splitMap = {};
  cmR.rows.forEach(function (c) {
    if (!splitMap[c.company_code]) splitMap[c.company_code] = [];
    splitMap[c.company_code].push(c);
  });
  const stR = await db.query('SELECT id, first_name, last_name, name FROM stewards');
  const stName = {};
  stR.rows.forEach(function (s) {
    stName[s.id] = displayName(s) || ('Steward ' + s.id);
  });
  const imp = await db.query(
    'INSERT INTO referral_fee_imports (period_id, source, file_name, imported_by, groups_seen) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [periodId, 'F', fileName || null, userId || null, bills.length]);
  const importId = imp.rows[0].id;
  let linesCreated = 0;
  let duplicates = 0;
  let rowsCreated = 0;
  const skipped = [];
  for (const b of bills) {
    if (!(b.admin_fees > 0)) {
      skipped.push({ company_code: b.company_code, modal_date: b.payroll_date, reason: 'Admin Fees total $0.00 in this file - nothing to calculate' });
      continue;
    }
    const company = compMap[b.company_code];
    if (!company) {
      skipped.push({ company_code: b.company_code, modal_date: b.payroll_date, reason: 'Company code is not on the Companies table' });
      continue;
    }
    const splits = splitMap[b.company_code] || [];
    if (!splits.length) {
      skipped.push({ company_code: b.company_code, modal_date: b.payroll_date, reason: 'No commission split on file for this company' });
      continue;
    }
    const factor = REFERRAL_FACTORS[b.bill_mode] || 0;
    const enrolled = factor ? Math.round(b.admin_fees / factor) : (b.lives_count || 0);
    const stmt = statementDateFor(b.paid_date);
    const ins = await db.query(
      'INSERT INTO referral_fee_lines (period_id, import_id, source, company_code, company_name, modal_date, applied_date, statement_date, bill_mode, admin_fee, enrolled) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (source, company_code, modal_date) DO NOTHING RETURNING id',
      [periodId, importId, 'F', b.company_code, company.company_name, b.payroll_date, b.paid_date, stmt, b.bill_mode, b.admin_fees, enrolled]);
    if (!ins.rows.length) { duplicates++; continue; }
    const lineId = ins.rows[0].id;
    linesCreated++;
    let splitTotal = 0;
    const adminCents = Math.round(b.admin_fees * 100);
    for (const s of splits) {
      splitTotal += Number(s.pct);
      // Exact decimal money math in integers: a float product like
      // 276.90 * 25 lands a hair under the true half-cent and rounds a
      // cent low, so the fee is computed as integer cents x pct-thousandths.
      const pctMilli = Math.round(Number(s.pct) * 1000);
      const fee = Math.floor((adminCents * pctMilli + 50000) / 100000) / 100;
      await db.query(
        'INSERT INTO referral_fee_pending (line_id, period_id, company_code, steward_id, steward_name, pct, referral_fee) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [lineId, periodId, b.company_code, s.steward_code, stName[s.steward_code] || ('Steward ' + s.steward_code), s.pct, fee]);
      rowsCreated++;
    }
    if (Math.abs(splitTotal - 100) > 0.001) {
      skipped.push({ company_code: b.company_code, modal_date: b.payroll_date, reason: 'Commission split on file totals ' + splitTotal + '% - the remaining ' + Math.round((100 - splitTotal) * 100) / 100 + '% has no steward and was not calculated' });
    }
  }
  await db.query(
    'UPDATE referral_fee_imports SET lines_created = $1, duplicates_ignored = $2, rows_created = $3, skipped = $4 WHERE id = $5',
    [linesCreated, duplicates, rowsCreated, JSON.stringify(skipped), importId]);
  const adjustment = await refreshReferralAdjustment(db, periodId);
  return {
    import_id: importId, period_id: periodId, source: 'F', file_name: fileName || null,
    groups_seen: bills.length, lines_created: linesCreated, duplicates_ignored: duplicates,
    rows_created: rowsCreated, skipped: skipped, adjustment: adjustment
  };
}

// Periods list for the Referral Fees page: one tab per period, kept as history.
app.get('/api/referral-fees/periods', requireReferralViewer, async (req, res) => {
  try {
    const r = await getPool().query(
      'SELECT p.*, ' +
      '(SELECT COUNT(*) FROM referral_fee_lines l WHERE l.period_id = p.id) AS line_count, ' +
      '(SELECT COUNT(*) FROM referral_fee_pending pp WHERE pp.period_id = p.id) AS row_count, ' +
      '(SELECT COALESCE(SUM(l.admin_fee), 0) FROM referral_fee_lines l WHERE l.period_id = p.id) AS total_admin_fees, ' +
      '(SELECT COALESCE(SUM(pp.referral_fee), 0) FROM referral_fee_pending pp WHERE pp.period_id = p.id) + ' +
      '(SELECT COALESCE(adj.amount, 0) FROM referral_fee_adjustments adj WHERE adj.period_id = p.id) AS total_referral_fees ' +
      'FROM referral_fee_periods p ORDER BY p.id');
    res.json(r.rows);
  } catch (error) {
    console.error('Referral periods error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start a referral fee build (a new period tab). Admin only.
app.post('/api/admin/referral-fees/periods', requireAdmin, async (req, res) => {
  try {
    const label = (req.body && req.body.label ? String(req.body.label) : '').trim();
    if (!label) return res.status(400).json({ error: 'A period label is required' });
    const r = await getPool().query(
      'INSERT INTO referral_fee_periods (label, created_by) VALUES ($1, $2) RETURNING *',
      [label, req.user.id]);
    res.json(r.rows[0]);
  } catch (error) {
    console.error('Referral period create error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete an entire period (v6.18.2, Leroy): the period and everything
// calculated in it - lines, pending rows, import history, and the
// rounding adjustment all cascade away. The freed (company, payroll
// date) pairs are no longer marked calculated, so the month can be
// imported and calculated fresh afterwards.
async function deleteReferralPeriod(db, periodId) {
  const per = await db.query('SELECT * FROM referral_fee_periods WHERE id = $1', [periodId]);
  if (!per.rows.length) return null;
  const counts = await db.query(
    'SELECT (SELECT COUNT(*) FROM referral_fee_lines WHERE period_id = $1) AS lines, ' +
    '(SELECT COUNT(*) FROM referral_fee_pending WHERE period_id = $1) AS pending_rows', [periodId]);
  await db.query('DELETE FROM referral_fee_periods WHERE id = $1', [periodId]);
  return {
    label: per.rows[0].label,
    lines_deleted: parseInt(counts.rows[0].lines, 10),
    rows_deleted: parseInt(counts.rows[0].pending_rows, 10)
  };
}

app.delete('/api/admin/referral-fees/periods/:id', requireAdmin, async (req, res) => {
  try {
    const out = await deleteReferralPeriod(getPool(), req.params.id);
    if (!out) return res.status(404).json({ error: 'Period not found' });
    res.json(Object.assign({ success: true }, out));
  } catch (error) {
    console.error('Referral period delete error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// One period: its imports (with skip reports) and its pending commissions table.
// Payee display (v6.18.1, Leroy): the Referral Fees table's Payee column
// follows the Stewards page - when a steward's Payee is Company, show
// their Steward Company Name; otherwise (Payee Steward, or not set yet)
// show the steward's own name.
function payeeDisplayName(steward, snapshotName) {
  if (steward && steward.payee === 'Company' && steward.steward_company_name) return steward.steward_company_name;
  if (steward) return displayName(steward) || snapshotName || '';
  return snapshotName || '';
}

// Assemble one period's detail payload (imports, pending rows with their
// Payee display names, totals, and the rounding adjustment - which gets
// the same Payee treatment plus the period's statement date: the latest
// statement date among its calculated lines).
async function referralPeriodDetail(db, periodId) {
  const per = await db.query('SELECT * FROM referral_fee_periods WHERE id = $1', [periodId]);
  if (!per.rows.length) return null;
  const imports = await db.query('SELECT * FROM referral_fee_imports WHERE period_id = $1 ORDER BY id', [periodId]);
  const rows = await db.query(
    'SELECT pp.id, pp.company_code, l.company_name, l.modal_date, l.admin_fee, pp.pct, pp.referral_fee, ' +
    'l.enrolled, pp.steward_id, pp.steward_name, l.statement_date, l.source, ' +
    's.payee AS steward_payee, s.steward_company_name, s.first_name, s.last_name, s.name ' +
    'FROM referral_fee_pending pp JOIN referral_fee_lines l ON l.id = pp.line_id ' +
    'LEFT JOIN stewards s ON s.id = pp.steward_id ' +
    'WHERE pp.period_id = $1 ORDER BY pp.company_code, l.modal_date, pp.steward_id', [periodId]);
  rows.rows.forEach(function (row) {
    row.payee_name = payeeDisplayName(
      { payee: row.steward_payee, steward_company_name: row.steward_company_name, first_name: row.first_name, last_name: row.last_name, name: row.name },
      row.steward_name);
  });
  const totals = await db.query(
    'SELECT (SELECT COALESCE(SUM(admin_fee), 0) FROM referral_fee_lines WHERE period_id = $1) AS total_admin_fees, ' +
    '(SELECT COALESCE(SUM(referral_fee), 0) FROM referral_fee_pending WHERE period_id = $1) AS total_referral_fees', [periodId]);
  const adj = await db.query('SELECT * FROM referral_fee_adjustments WHERE period_id = $1', [periodId]);
  const adjustment = adj.rows.length ? adj.rows[0] : null;
  if (adjustment) {
    const st = await db.query('SELECT payee, steward_company_name, first_name, last_name, name FROM stewards WHERE id = $1', [adjustment.steward_id]);
    adjustment.payee_name = payeeDisplayName(st.rows.length ? st.rows[0] : null, adjustment.steward_name);
    const sd = await db.query('SELECT MAX(statement_date) AS d FROM referral_fee_lines WHERE period_id = $1', [periodId]);
    adjustment.statement_date = sd.rows[0].d;
  }
  const t = totals.rows[0];
  t.net_referral_fees = Math.round((Number(t.total_referral_fees) + (adjustment ? Number(adjustment.amount) : 0)) * 100) / 100;
  return { period: per.rows[0], imports: imports.rows, rows: rows.rows, totals: t, adjustment: adjustment };
}

app.get('/api/referral-fees/periods/:id', requireReferralViewer, async (req, res) => {
  try {
    const detail = await referralPeriodDetail(getPool(), req.params.id);
    if (!detail) return res.status(404).json({ error: 'Period not found' });
    res.json(detail);
  } catch (error) {
    console.error('Referral period detail error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- referral fee statements (v6.19, Leroy)
// One statement per payee per period, generated from the Forms template
// named STATEMENT_TEMPLATE_FORM and filled with the period's pending
// rows (the period's rounding adjustment lands on its steward's
// statement). Statements are stored in referral_fee_statements with a
// hash of everything that went into the file - the statement content
// plus the template itself - so Generate skips a statement whose hash
// is unchanged, replaces one whose content moved, and creates the rest.
const STATEMENT_TEMPLATE_FORM = 'iM4 Health Statement Template';

function stmtExcelSerial(iso) {
  const t = Date.parse(iso + 'T00:00:00Z');
  return Math.round((t - Date.UTC(1899, 11, 30)) / 86400000);
}
function stmtNum(x) { return String(Math.round(Number(x) * 100) / 100); }
function stmtCellStyle(sheetXml, ref) {
  const m = sheetXml.match(new RegExp('<c r="' + ref + '" s="(\\d+)"'));
  return m ? parseInt(m[1], 10) : null;
}
function stmtCellXml(sheetXml, ref) {
  const m = sheetXml.match(new RegExp('<c r="' + ref + '"[^>]*?(?:/>|>.*?</c>)'));
  return m ? m[0] : '';
}
function stmtRowXml(sheetXml, r) {
  const m = sheetXml.match(new RegExp('<row r="' + r + '"[^>]*>.*?</row>'));
  return m ? m[0] : '';
}

// Fill the statement template (an .xlsx in Forms) for one payee. The
// workbook package is edited in place with PizZip - only the sheet's
// rows, a few appended cell formats, the sheet name, and the print area
// change - so the template's logo, fonts, fills, and print settings
// carry into every statement untouched.
function buildStatementXlsx(templateBuf, st) {
  const PizZip = require('pizzip');
  const zip = new PizZip(templateBuf);
  const sheetPath = 'xl/worksheets/sheet1.xml';
  const sheetFile = zip.file(sheetPath);
  if (!sheetFile) throw new Error('The statement template has no first worksheet to fill.');
  let sheet = sheetFile.asText();
  let styles = zip.file('xl/styles.xml').asText();
  let wbXml = zip.file('xl/workbook.xml').asText();

  const sTitle = stmtCellStyle(sheet, 'A5');
  const sHead = stmtCellStyle(sheet, 'A12');
  const sClient = stmtCellStyle(sheet, 'A13');
  const sFooter = stmtCellStyle(sheet, 'A11');
  function xfOf(idx) {
    const blocks = styles.split('<cellXfs');
    const seg = '<cellXfs' + blocks[blocks.length - 1];
    const xfs = seg.match(/<xf[^>]*?(?:\/>|>.*?<\/xf>)/g) || [];
    return xfs[idx] || '';
  }
  function fontIdOf(idx) {
    const m = xfOf(idx).match(/fontId="(\d+)"/);
    return m ? m[1] : '2';
  }
  const fontPlain = fontIdOf(sHead);
  const countMatch = styles.match(/(<cellXfs count=")(\d+)(")/);
  const baseIdx = parseInt(countMatch[2], 10);
  function xf(numFmtId, fontId, align) {
    return '<xf numFmtId="' + numFmtId + '" fontId="' + fontId + '" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyAlignment="1"><alignment horizontal="' + align + '" vertical="center"/></xf>';
  }
  const S = {
    hdrText: baseIdx,
    hdrDate: baseIdx + 1,
    hdrEmail: baseIdx + 2,
    detDate: baseIdx + 3,
    detInt: baseIdx + 4,
    detMoney: baseIdx + 5,
    detPct: baseIdx + 6,
    client: sClient
  };
  const newXfs =
    xf(0, fontPlain, 'left') +
    xf(14, fontPlain, 'right') +
    xf(49, fontPlain, 'right') +
    xf(14, fontPlain, 'center') +
    xf(3, fontPlain, 'center') +
    xf(165, fontPlain, 'center') +
    xf(10, fontPlain, 'center');
  styles = styles.replace(/(<cellXfs count=")\d+(")/, '$1' + (baseIdx + 7) + '$2');
  styles = styles.replace('</cellXfs>', newXfs + '</cellXfs>');

  const pre = sheet.slice(0, sheet.indexOf('<sheetData>') + '<sheetData>'.length);
  const post = sheet.slice(sheet.indexOf('</sheetData>'));
  const keepRows = [1, 2, 3, 4, 5].map(function (r) { return stmtRowXml(sheet, r); }).join('');
  const d6 = stmtCellXml(sheet, 'D6');
  const d7 = stmtCellXml(sheet, 'D7');
  const headRow = stmtRowXml(sheet, 12);

  function textCell(ref, sIdx, text) {
    return '<c r="' + ref + '" s="' + sIdx + '" t="inlineStr"><is><t>' + escXml(text) + '</t></is></c>';
  }
  function numCell(ref, sIdx, v) {
    return '<c r="' + ref + '" s="' + sIdx + '"><v>' + v + '</v></c>';
  }
  function rowOpen(r) { return '<row r="' + r + '" spans="1:5" x14ac:dyDescent="0.25">'; }

  let rows = keepRows;
  rows += rowOpen(6) + textCell('A6', S.hdrText, st.payeeName) + d6 + numCell('E6', S.hdrDate, stmtExcelSerial(st.statementDate)) + '</row>';
  rows += rowOpen(7) + textCell('A7', S.hdrText, st.address) + d7 + numCell('E7', S.hdrDate, stmtExcelSerial(st.monthEnding)) + '</row>';
  rows += rowOpen(8) + textCell('A8', S.hdrText, st.cityLine) + textCell('E8', S.hdrEmail, st.email) + '</row>';
  rows += rowOpen(9) + textCell('A9', S.hdrText, st.personName) + '</row>';
  rows += headRow;
  let body = '';
  let r = 13;
  const firstBody = r;
  for (const cl of st.clients) {
    body += rowOpen(r) + textCell('A' + r, S.client, cl.label) + '</row>';
    r++;
    for (const d of cl.rows) {
      body += rowOpen(r) +
        numCell('A' + r, S.detDate, stmtExcelSerial(d.date)) +
        numCell('B' + r, S.detInt, d.enrolled) +
        numCell('C' + r, S.detMoney, stmtNum(d.admin)) +
        numCell('D' + r, S.detPct, stmtNum(Number(d.pct) / 100)) +
        numCell('E' + r, S.detMoney, stmtNum(d.fee)) +
        '</row>';
      r++;
    }
  }
  if (st.adjustment !== null && st.adjustment !== undefined && Number(st.adjustment) !== 0) {
    body += rowOpen(r) + textCell('A' + r, S.client, 'Rounding adjustment') + numCell('E' + r, S.detMoney, stmtNum(st.adjustment)) + '</row>';
    r++;
  }
  const lastBody = r - 1;
  const totalsRow = r;
  function sumCell(col, sIdx, cached) {
    return '<c r="' + col + totalsRow + '" s="' + sIdx + '"><f>SUM(' + col + firstBody + ':' + col + lastBody + ')</f><v>' + cached + '</v></c>';
  }
  body += rowOpen(totalsRow) +
    sumCell('B', S.detInt, st.totals.enrolled) +
    sumCell('C', S.detMoney, stmtNum(st.totals.admin)) +
    sumCell('E', S.detMoney, stmtNum(st.totals.fee)) +
    '</row>';
  const footerRow = totalsRow + 4;
  let footer = '<row r="' + footerRow + '" spans="1:5" ht="33" customHeight="1" x14ac:dyDescent="0.25">' +
    textCell('A' + footerRow, sFooter, 'If you have questions, please email daylynne@innovativehia.com');
  for (const col of ['B', 'C', 'D', 'E']) footer += '<c r="' + col + footerRow + '" s="' + sFooter + '"/>';
  footer += '</row>';

  let out = pre + rows + body + footer + post;
  out = out.replace(/<dimension ref="[^"]*"\s*\/>/, '<dimension ref="A1:E' + footerRow + '"/>');
  out = out.replace(/<mergeCells count="\d+">.*?<\/mergeCells>/, '<mergeCells count="1"><mergeCell ref="A' + footerRow + ':E' + footerRow + '"/></mergeCells>');

  const newName = String(st.sheetName || 'Statement').slice(0, 31);
  wbXml = wbXml.replace(/<sheet name="[^"]*"/, '<sheet name="' + escXml(newName) + '"');
  wbXml = wbXml.replace(/'[^']*'!\$A:\$E/, "'" + newName.replace(/'/g, "''") + "'!$A:$E");
  if (/<calcPr[^>]*>/.test(wbXml)) {
    wbXml = wbXml.replace(/<calcPr[^>]*>/, function (m) { return m.replace(/\/?>$/, '') + ' fullCalcOnLoad="1"/>'; });
  } else {
    wbXml = wbXml.replace('</workbook>', '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>');
  }

  zip.file(sheetPath, out);
  zip.file('xl/styles.xml', styles);
  zip.file('xl/workbook.xml', wbXml);
  const appFile = zip.file('docProps/app.xml');
  if (appFile) {
    let app = appFile.asText();
    app = app.replace(/<vt:lpstr>[^<]*<\/vt:lpstr>/, '<vt:lpstr>' + escXml(newName) + '</vt:lpstr>');
    zip.file('docProps/app.xml', app);
  }
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Assemble the statement content for every payee in a period from its
// pending rows. Money is accumulated in integer cents; the period's
// rounding adjustment is folded into its steward's statement.
async function referralStatementContents(db, periodId) {
  const rows = await db.query(
    'SELECT pp.steward_id, pp.steward_name, pp.company_code, l.company_name, ' +
    "to_char(l.modal_date, 'YYYY-MM-DD') AS modal_date, l.admin_fee, pp.pct, pp.referral_fee, l.enrolled, " +
    "to_char(l.statement_date, 'YYYY-MM-DD') AS statement_date, " +
    's.first_name, s.last_name, s.name, s.email, s.statement_email, s.payee, s.steward_company_name, s.address, s.city, s.state, s.zip ' +
    'FROM referral_fee_pending pp JOIN referral_fee_lines l ON l.id = pp.line_id ' +
    'LEFT JOIN stewards s ON s.id = pp.steward_id WHERE pp.period_id = $1 ' +
    'ORDER BY pp.steward_id, pp.company_code, l.modal_date', [periodId]);
  const adjRes = await db.query('SELECT * FROM referral_fee_adjustments WHERE period_id = $1', [periodId]);
  const adjustment = adjRes.rows.length ? adjRes.rows[0] : null;
  const bySteward = new Map();
  for (const row of rows.rows) {
    let c = bySteward.get(row.steward_id);
    if (!c) {
      const steward = {
        payee: row.payee, steward_company_name: row.steward_company_name,
        first_name: row.first_name, last_name: row.last_name, name: row.name
      };
      c = {
        steward_id: row.steward_id,
        first_name: row.first_name || '',
        last_name: row.last_name || '',
        payeeName: String(payeeDisplayName(steward, row.steward_name) || '').toUpperCase(),
        address: String(row.address || '').toUpperCase(),
        cityLine: String([row.city, row.state, row.zip].filter(Boolean).join(' ')).toUpperCase(),
        email: row.statement_email || row.email || '',
        personName: String(displayName(steward) || row.steward_name || '').toUpperCase(),
        statementDate: row.statement_date,
        clientMap: new Map(),
        enrolled: 0, adminCents: 0, feeCents: 0
      };
      bySteward.set(row.steward_id, c);
    }
    if (row.statement_date > c.statementDate) c.statementDate = row.statement_date;
    let cl = c.clientMap.get(row.company_code);
    if (!cl) {
      cl = { label: row.company_code + ' ' + (row.company_name || ''), rows: [] };
      c.clientMap.set(row.company_code, cl);
    }
    cl.rows.push({
      date: row.modal_date, enrolled: row.enrolled,
      admin: Number(row.admin_fee), pct: Number(row.pct), fee: Number(row.referral_fee)
    });
    c.enrolled += Number(row.enrolled) || 0;
    c.adminCents += Math.round(Number(row.admin_fee) * 100);
    c.feeCents += Math.round(Number(row.referral_fee) * 100);
  }
  const out = [];
  for (const c of bySteward.values()) {
    let adjAmount = null;
    if (adjustment && Number(adjustment.steward_id) === Number(c.steward_id)) {
      adjAmount = Number(adjustment.amount);
      c.feeCents += Math.round(adjAmount * 100);
    }
    const sd = new Date(c.statementDate + 'T00:00:00Z');
    sd.setUTCDate(sd.getUTCDate() - 1);
    out.push({
      steward_id: c.steward_id,
      first_name: c.first_name,
      last_name: c.last_name,
      payeeName: c.payeeName,
      address: c.address,
      cityLine: c.cityLine,
      email: c.email,
      personName: c.personName,
      statementDate: c.statementDate,
      monthEnding: sd.toISOString().slice(0, 10),
      clients: Array.from(c.clientMap.values()),
      adjustment: adjAmount,
      totals: { enrolled: c.enrolled, admin: c.adminCents / 100, fee: c.feeCents / 100 }
    });
  }
  return out;
}

function statementFileBase(content, collision) {
  let base = String(content.last_name || 'Statement').replace(/[^A-Za-z0-9]+/g, '');
  if (!base) base = 'Statement';
  if (collision) base += String(content.first_name || '').replace(/[^A-Za-z]/g, '').charAt(0).toUpperCase();
  return base;
}

async function generateReferralStatements(db, periodId, userId) {
  const tpl = await db.query('SELECT file_data FROM forms WHERE name = $1', [STATEMENT_TEMPLATE_FORM]);
  if (!tpl.rows.length) {
    const e = new Error('Statement template not found in Forms. Upload an .xlsx named "' + STATEMENT_TEMPLATE_FORM + '" on the Forms page first.');
    e.status = 400;
    throw e;
  }
  const templateBuf = tpl.rows[0].file_data;
  const templateHash = crypto.createHash('sha256').update(templateBuf).digest('hex');
  const contents = await referralStatementContents(db, periodId);
  const nameCounts = {};
  contents.forEach(function (c) {
    const k = String(c.last_name || '').toLowerCase();
    nameCounts[k] = (nameCounts[k] || 0) + 1;
  });
  let created = 0, replaced = 0, unchanged = 0;
  const list = [];
  for (const c of contents) {
    const base = statementFileBase(c, nameCounts[String(c.last_name || '').toLowerCase()] > 1);
    const iso = c.statementDate;
    const fileName = base + '_' + iso.slice(5, 7) + iso.slice(8, 10) + iso.slice(0, 4) + '.xlsx';
    const hash = crypto.createHash('sha256').update(JSON.stringify({ t: templateHash, c: c })).digest('hex');
    const ex = await db.query('SELECT id, content_hash FROM referral_fee_statements WHERE period_id = $1 AND steward_id = $2', [periodId, c.steward_id]);
    if (ex.rows.length && ex.rows[0].content_hash === hash) {
      unchanged++;
      list.push({ steward_id: c.steward_id, payee_name: c.payeeName, total: c.totals.fee, status: 'unchanged' });
      continue;
    }
    const buf = buildStatementXlsx(templateBuf, Object.assign({}, c, { sheetName: base }));
    if (ex.rows.length) {
      await db.query(
        'UPDATE referral_fee_statements SET payee_name = $1, statement_date = $2, total = $3, enrolled = $4, file_name = $5, file_data = $6, content_hash = $7, generated_at = NOW(), generated_by = $8 WHERE id = $9',
        [c.payeeName, c.statementDate, c.totals.fee, c.totals.enrolled, fileName, buf, hash, userId, ex.rows[0].id]);
      replaced++;
      list.push({ steward_id: c.steward_id, payee_name: c.payeeName, total: c.totals.fee, status: 'replaced' });
    } else {
      await db.query(
        'INSERT INTO referral_fee_statements (period_id, steward_id, payee_name, statement_date, total, enrolled, file_name, file_data, content_hash, generated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [periodId, c.steward_id, c.payeeName, c.statementDate, c.totals.fee, c.totals.enrolled, fileName, buf, hash, userId]);
      created++;
      list.push({ steward_id: c.steward_id, payee_name: c.payeeName, total: c.totals.fee, status: 'created' });
    }
  }
  // Mirror rule (v6.19.1, Leroy): a statement whose payee no longer has
  // rows in the period is removed, so after every Generate the statement
  // set matches exactly the data it was generated from.
  const keepIds = new Set(contents.map(function (c) { return Number(c.steward_id); }));
  const existing = await db.query('SELECT id, steward_id FROM referral_fee_statements WHERE period_id = $1', [periodId]);
  let removed = 0;
  for (const row of existing.rows) {
    if (!keepIds.has(Number(row.steward_id))) {
      await db.query('DELETE FROM referral_fee_statements WHERE id = $1', [row.id]);
      removed++;
    }
  }
  return { created: created, replaced: replaced, unchanged: unchanged, removed: removed, total: contents.length, statements: list };
}

app.post('/api/admin/referral-fees/periods/:id/generate-statements', requireAdmin, async (req, res) => {
  try {
    const per = await getPool().query('SELECT id FROM referral_fee_periods WHERE id = $1', [req.params.id]);
    if (!per.rows.length) return res.status(404).json({ error: 'Period not found' });
    const out = await generateReferralStatements(getPool(), req.params.id, req.user.id);
    res.json(out);
  } catch (error) {
    console.error('Statement generate error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Internal server error' });
  }
});

// The period's generated statements (no file bytes - those come from
// the download endpoint).
app.get('/api/referral-fees/periods/:id/statements', requireReferralViewer, async (req, res) => {
  try {
    const r = await getPool().query(
      'SELECT id, steward_id, payee_name, statement_date, total, file_name, generated_at FROM referral_fee_statements WHERE period_id = $1 ORDER BY payee_name',
      [req.params.id]);
    res.json(r.rows);
  } catch (error) {
    console.error('Statement list error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Statement download: Admin and Top Dog, plus the steward the
// statement belongs to (v6.20, for the steward Statements page).
app.get('/api/referral-fees/statements/:sid/download', requireAuth, async (req, res) => {
  try {
    const r = await getPool().query('SELECT file_name, file_data, steward_id FROM referral_fee_statements WHERE id = $1', [req.params.sid]);
    if (!r.rows.length) return res.status(404).json({ error: 'Statement not found' });
    const role = req.user && req.user.activeRole;
    const own = Number(r.rows[0].steward_id) === Number(req.user.id);
    if (role !== 'admin' && role !== 'top_dog' && !own) {
      return res.status(403).json({ error: 'Statements can be downloaded by Admin, Top Dog, and the steward they belong to' });
    }
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="' + String(r.rows[0].file_name).replace(/"/g, '') + '"');
    res.send(r.rows[0].file_data);
  } catch (error) {
    console.error('Statement download error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- steward Statements page (v6.20, Leroy)
// A steward sees their own referral fee money in two parts:
// - Pending payment: their rows in the current month - the newest
//   period that has pending rows, judged by its statement date - shown
//   only while no statement has been generated for them in that period.
//   Once statements are generated the month is closed, not pending.
// - Closed months: one downloadable statement per period, with its
//   lives and total.
async function myStatements(db, stewardId) {
  const stmts = await db.query(
    'SELECT st.id, st.period_id, p.label AS period_label, st.payee_name, st.statement_date, st.total, st.enrolled, st.file_name, st.generated_at ' +
    'FROM referral_fee_statements st JOIN referral_fee_periods p ON p.id = st.period_id ' +
    'WHERE st.steward_id = $1 ORDER BY st.statement_date DESC, st.id DESC', [stewardId]);
  const cur = await db.query(
    'SELECT l.period_id, MAX(l.statement_date) AS sd FROM referral_fee_lines l ' +
    'WHERE EXISTS (SELECT 1 FROM referral_fee_pending pp WHERE pp.period_id = l.period_id) ' +
    'GROUP BY l.period_id ORDER BY sd DESC NULLS LAST, l.period_id DESC LIMIT 1');
  let pending = null;
  if (cur.rows.length) {
    const periodId = cur.rows[0].period_id;
    const hasStmt = await db.query('SELECT id FROM referral_fee_statements WHERE period_id = $1 AND steward_id = $2', [periodId, stewardId]);
    if (!hasStmt.rows.length) {
      const rows = await db.query(
        'SELECT pp.company_code, l.company_name, ' +
        "to_char(l.modal_date, 'YYYY-MM-DD') AS modal_date, l.admin_fee, pp.pct, pp.referral_fee, l.enrolled, " +
        "to_char(l.statement_date, 'YYYY-MM-DD') AS statement_date " +
        'FROM referral_fee_pending pp JOIN referral_fee_lines l ON l.id = pp.line_id ' +
        'WHERE pp.period_id = $1 AND pp.steward_id = $2 ORDER BY pp.company_code, l.modal_date', [periodId, stewardId]);
      if (rows.rows.length) {
        const per = await db.query('SELECT * FROM referral_fee_periods WHERE id = $1', [periodId]);
        const adjRes = await db.query('SELECT amount FROM referral_fee_adjustments WHERE period_id = $1 AND steward_id = $2', [periodId, stewardId]);
        const adjustment = adjRes.rows.length ? { amount: Number(adjRes.rows[0].amount) } : null;
        let adminC = 0, feeC = 0, enr = 0;
        rows.rows.forEach(function (r) {
          adminC += Math.round(Number(r.admin_fee) * 100);
          feeC += Math.round(Number(r.referral_fee) * 100);
          enr += Number(r.enrolled) || 0;
        });
        if (adjustment) feeC += Math.round(adjustment.amount * 100);
        pending = {
          period: per.rows[0],
          rows: rows.rows,
          adjustment: adjustment,
          totals: { admin_fees: adminC / 100, referral_fees: feeC / 100, enrolled: enr }
        };
      }
    }
  }
  return { pending: pending, statements: stmts.rows };
}

app.get('/api/my/statements', requireAuth, async (req, res) => {
  try {
    res.json(await myStatements(getPool(), req.user.id));
  } catch (error) {
    console.error('My statements error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/admin/referral-fees/statements/:sid', requireAdmin, async (req, res) => {
  try {
    const r = await getPool().query('DELETE FROM referral_fee_statements WHERE id = $1', [req.params.sid]);
    if (!r.rowCount) return res.status(404).json({ error: 'Statement not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Statement delete error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload + validate + calculate a referral fee source file (Jobs page).
// FTJ (F) is built; the Soluta (S) import arrives with its own build.
app.post('/api/admin/referral-fees/import', requireAdmin, handleUpload('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const source = String((req.body && req.body.source) || 'F').toUpperCase();
    const periodId = parseInt(req.body && req.body.period_id, 10);
    if (!periodId) return res.status(400).json({ error: 'Choose a referral fee period first (start a build on the Referral Fees page).' });
    if (source !== 'F') return res.status(400).json({ error: 'The Soluta (S) referral fee import is not built yet.' });
    const result = await runReferralImportF(getPool(), req.file.buffer, req.file.originalname, periodId, req.user.id);
    res.json(Object.assign({ success: true }, result));
  } catch (error) {
    console.error('Referral import error:', error);
    res.status(400).json({ error: error.message || 'Import failed' });
  }
});

// List tickets, scoped by role: service/admin/top_dog see all; client/steward see their companies.
app.get('/api/tickets', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const r = user.activeRole;
    if (r !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    let q = 'SELECT t.*, c.company_name, ' +
      'cb.first_name AS creator_first, cb.last_name AS creator_last, ' +
      'ab.first_name AS assignee_first, ab.last_name AS assignee_last, ' +
      '(SELECT COUNT(*) FROM ticket_replies WHERE ticket_id = t.id) AS reply_count ' +
      'FROM tickets t LEFT JOIN companies c ON c.company_code = t.company_code ' +
      'LEFT JOIN stewards cb ON cb.id = t.created_by ' +
      'LEFT JOIN stewards ab ON ab.id = t.assigned_to';
    const params = [];
    if (!canSeeAllTickets(user)) {
      const codes = await getVisibleCodes(user);
      if (!codes || codes.length === 0) return res.json([]);
      q += ' WHERE t.company_code = ANY($1)';
      params.push(codes);
    }
    // Optional filters
    const filters = [];
    if (req.query.status) { params.push(req.query.status); filters.push('t.status = $' + params.length); }
    if (req.query.priority) { params.push(req.query.priority); filters.push('t.priority = $' + params.length); }
    if (req.query.category) { params.push(req.query.category); filters.push('t.category = $' + params.length); }
    if (req.query.q) { params.push('%' + req.query.q + '%'); filters.push('(t.title ILIKE $' + params.length + ' OR t.description ILIKE $' + params.length + ')'); }
    if (filters.length > 0) q += (params.length > filters.length || q.indexOf('WHERE') !== -1 ? ' AND ' : ' WHERE ') + filters.join(' AND ');
    q += ' ORDER BY t.updated_at DESC LIMIT 200';
    const result = await getPool().query(q, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Ticket list error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a ticket. Auto-assigns to whoever is on call.
app.post('/api/tickets', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const r = user.activeRole;
    if (r !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    const { company_code, title, description, category, priority } = req.body || {};
    if (!company_code || !title || !description) {
      return res.status(400).json({ error: 'company_code, title, and description are required' });
    }
    // Verify the user can file for this company.
    if (!canSeeAllTickets(user)) {
      const codes = await getVisibleCodes(user);
      if (!codes || codes.indexOf(String(company_code)) === -1) {
        return res.status(403).json({ error: 'Not authorized for this company' });
      }
    }
    const validCats = ['billing', 'onboarding', 'technical', 'general'];
    const validPris = ['low', 'medium', 'high', 'urgent'];
    const cat = validCats.indexOf(category) !== -1 ? category : 'general';
    const pri = validPris.indexOf(priority) !== -1 ? priority : 'medium';
    // Auto-assign to on-call.
    let assignee = null;
    const oncall = await getCurrentOnCall();
    if (oncall) assignee = oncall.steward_id;
    const ins = await getPool().query(
      'INSERT INTO tickets (company_code, title, description, category, priority, status, created_by, assigned_to) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [String(company_code), String(title), String(description), cat, pri, 'open', user.id, assignee]);
    const ticketId = ins.rows[0].id;
    // Notify the assignee, or all service staff if unassigned.
    try {
      let notifyEmails = [];
      if (assignee) {
        const ar = await getPool().query('SELECT email FROM stewards WHERE id = $1', [assignee]);
        if (ar.rows.length > 0) notifyEmails.push(ar.rows[0].email);
      } else {
        const sr = await getPool().query(
          "SELECT DISTINCT s.email FROM stewards s JOIN user_roles ur ON ur.steward_id = s.id WHERE ur.role = 'service'");
        notifyEmails = sr.rows.map(x => x.email);
      }
      const coName = (await getPool().query('SELECT company_name FROM companies WHERE company_code = $1', [String(company_code)])).rows[0];
      for (const em of notifyEmails) {
        await sendEmail(em, 'New ticket #' + ticketId + ': ' + title,
          '<p>A new ' + pri + ' priority ticket was filed for <b>' + escHtml(String(company_code)) + '</b>' +
          (coName ? ' (' + escHtml(coName.company_name) + ')' : '') + '.</p>' +
          '<p><b>' + escHtml(title) + '</b></p><p>' + escHtml(description).replace(/\n/g, '<br>') + '</p>');
      }
    } catch (e) { console.error('Ticket notify error:', e.message); }
    res.json({ id: ticketId, assigned_to: assignee });
  } catch (error) {
    console.error('Ticket create error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Ticket detail with replies. Clients don't see internal notes.
app.get('/api/tickets/:id', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const r = user.activeRole;
    if (r !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    const t = await getPool().query(
      'SELECT t.*, c.company_name, cb.first_name AS creator_first, cb.last_name AS creator_last, cb.email AS creator_email, ' +
      'ab.first_name AS assignee_first, ab.last_name AS assignee_last ' +
      'FROM tickets t LEFT JOIN companies c ON c.company_code = t.company_code ' +
      'LEFT JOIN stewards cb ON cb.id = t.created_by LEFT JOIN stewards ab ON ab.id = t.assigned_to ' +
      'WHERE t.id = $1', [req.params.id]);
    if (t.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = t.rows[0];
    if (!canSeeAllTickets(user)) {
      const codes = await getVisibleCodes(user);
      if (!codes || codes.indexOf(ticket.company_code) === -1) {
        return res.status(403).json({ error: 'Not authorized for this ticket' });
      }
    }
    let rq = 'SELECT tr.*, s.first_name, s.last_name, s.email FROM ticket_replies tr ' +
      'LEFT JOIN stewards s ON s.id = tr.author_id WHERE tr.ticket_id = $1';
    // Clients never see internal notes.
    if (r === 'client') rq += ' AND tr.is_internal = FALSE';
    rq += ' ORDER BY tr.created_at ASC';
    const replies = await getPool().query(rq, [req.params.id]);
    ticket.replies = replies.rows;
    res.json(ticket);
  } catch (error) {
    console.error('Ticket detail error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add a reply. Only service/admin/top_dog can mark internal.
app.post('/api/tickets/:id/replies', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const r = user.activeRole;
    if (r !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    const { body, is_internal } = req.body || {};
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'Reply body is required' });
    const t = await getPool().query('SELECT * FROM tickets WHERE id = $1', [req.params.id]);
    if (t.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = t.rows[0];
    if (!canSeeAllTickets(user)) {
      const codes = await getVisibleCodes(user);
      if (!codes || codes.indexOf(ticket.company_code) === -1) {
        return res.status(403).json({ error: 'Not authorized for this ticket' });
      }
    }
    const internal = canManageTickets(user) && is_internal === true;
    await getPool().query(
      'INSERT INTO ticket_replies (ticket_id, author_id, body, is_internal) VALUES ($1, $2, $3, $4)',
      [req.params.id, user.id, String(body), internal]);
    await getPool().query('UPDATE tickets SET updated_at = NOW() WHERE id = $1', [req.params.id]);
    // Notify the other side (skip for internal notes).
    if (!internal) {
      try {
        const authorName = displayName(user);
        let notifyTo = null;
        if (r === 'client') {
          // Client replied: notify the assignee.
          if (ticket.assigned_to) {
            const ar = await getPool().query('SELECT email FROM stewards WHERE id = $1', [ticket.assigned_to]);
            if (ar.rows.length > 0) notifyTo = ar.rows[0].email;
          }
        } else {
          // Staff replied: notify the requester.
          const cr = await getPool().query('SELECT email FROM stewards WHERE id = $1', [ticket.created_by]);
          if (cr.rows.length > 0 && cr.rows[0].email !== user.email) notifyTo = cr.rows[0].email;
        }
        if (notifyTo) {
          await sendEmail(notifyTo, 'Re: Ticket #' + ticket.id + ': ' + ticket.title,
            '<p><b>' + escHtml(authorName) + '</b> replied to ticket #' + ticket.id + ':</p>' +
            '<p>' + escHtml(String(body)).replace(/\n/g, '<br>') + '</p>');
        }
      } catch (e) { console.error('Ticket reply notify error:', e.message); }
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Ticket reply error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update ticket: status, priority, assignee, category. Staff only.
app.patch('/api/tickets/:id', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    if (!canManageTickets(user)) return res.status(403).json({ error: 'Not authorized' });
    const t = await getPool().query('SELECT * FROM tickets WHERE id = $1', [req.params.id]);
    if (t.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = t.rows[0];
    const { status, priority, assigned_to, category } = req.body || {};
    const updates = [];
    const params = [];
    const validStatuses = ['open', 'in_progress', 'waiting_customer', 'resolved'];
    const validPris = ['low', 'medium', 'high', 'urgent'];
    const validCats = ['billing', 'onboarding', 'technical', 'general'];
    if (status && validStatuses.indexOf(status) !== -1) {
      params.push(status); updates.push('status = $' + params.length);
      if (status === 'resolved') updates.push('resolved_at = NOW()');
      else updates.push('resolved_at = NULL');
    }
    if (priority && validPris.indexOf(priority) !== -1) { params.push(priority); updates.push('priority = $' + params.length); }
    if (category && validCats.indexOf(category) !== -1) { params.push(category); updates.push('category = $' + params.length); }
    if (assigned_to !== undefined) {
      if (assigned_to === null || assigned_to === '') { updates.push('assigned_to = NULL'); }
      else { params.push(parseInt(assigned_to, 10)); updates.push('assigned_to = $' + params.length); }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    updates.push('updated_at = NOW()');
    params.push(req.params.id);
    await getPool().query('UPDATE tickets SET ' + updates.join(', ') + ' WHERE id = $' + params.length, params);
    // Notify requester on resolve.
    if (status === 'resolved' && ticket.status !== 'resolved') {
      try {
        const cr = await getPool().query('SELECT email FROM stewards WHERE id = $1', [ticket.created_by]);
        if (cr.rows.length > 0) {
          await sendEmail(cr.rows[0].email, 'Ticket #' + ticket.id + ' resolved: ' + ticket.title,
            '<p>Your ticket <b>#' + ticket.id + ' ' + escHtml(ticket.title) + '</b> has been marked resolved.</p>' +
            '<p>Reply to this ticket if the issue persists.</p>');
        }
      } catch (e) { console.error('Ticket resolve notify error:', e.message); }
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Ticket update error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Current on-call person (for display + auto-assignment transparency).
app.get('/api/tickets-oncall', requireAuth, async (req, res) => {
  try {
    const oc = await getCurrentOnCall();
    res.json(oc || { none: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin: on-call schedule management.
app.get('/api/admin/oncall-schedule', requireAdmin, async (req, res) => {
  try {
    const r = await getPool().query(
      'SELECT o.id, o.steward_id, o.start_date, o.end_date, s.first_name, s.last_name, s.email ' +
      'FROM on_call_schedule o JOIN stewards s ON s.id = o.steward_id ORDER BY o.start_date DESC');
    res.json(r.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/admin/oncall-schedule', requireAdmin, async (req, res) => {
  try {
    const { steward_id, start_date, end_date } = req.body || {};
    if (!steward_id || !start_date || !end_date) {
      return res.status(400).json({ error: 'steward_id, start_date, and end_date are required' });
    }
    const ins = await getPool().query(
      'INSERT INTO on_call_schedule (steward_id, start_date, end_date) VALUES ($1, $2, $3) RETURNING id',
      [parseInt(steward_id, 10), start_date, end_date]);
    res.json({ id: ins.rows[0].id });
  } catch (error) {
    console.error('On-call schedule create error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/admin/oncall-schedule/:id', requireAdmin, async (req, res) => {
  try {
    await getPool().query('DELETE FROM on_call_schedule WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Service team roster (for the assignee dropdown).
app.get('/api/tickets-service-team', requireAuth, async (req, res) => {
  try {
    if (!canManageTickets(req.user)) return res.status(403).json({ error: 'Not authorized' });
    const r = await getPool().query(
      "SELECT DISTINCT s.id, s.first_name, s.last_name, s.email FROM stewards s " +
      "JOIN user_roles ur ON ur.steward_id = s.id WHERE ur.role IN ('service', 'admin', 'top_dog') ORDER BY s.first_name, s.last_name");
    res.json(r.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- accountability
// Personal stats + team ranking for the dashboard.
app.get('/api/accountability', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const db = getPool();
    // My open tickets.
    const myTickets = await db.query(
      "SELECT COUNT(*) AS c FROM tickets WHERE assigned_to = $1 AND status != 'resolved'",
      [user.id]);
    // My overdue bills (steward's companies).
    let myOverdue = { c: 0 };
    const codes = await getVisibleCodes(user);
    if (!codes || codes.length > 0) {
      let q = "SELECT COUNT(*) AS c FROM invoices WHERE status = 'open' AND is_estimate = FALSE " +
        "AND ar_hold = FALSE AND payroll_date IS NOT NULL AND (CURRENT_DATE - payroll_date) >= 10";
      const params = [];
      if (codes) { q += ' AND company_code = ANY($1)'; params.push(codes); }
      myOverdue = (await db.query(q, params)).rows[0];
    }
    // My recent resolutions (last 30 days).
    const myResolved = await db.query(
      "SELECT COUNT(*) AS c FROM tickets WHERE assigned_to = $1 AND status = 'resolved' " +
      "AND resolved_at > NOW() - INTERVAL '30 days'",
      [user.id]);
    const out = {
      my_open_tickets: parseInt(myTickets.rows[0].c, 10),
      my_overdue_bills: parseInt(myOverdue.c, 10),
      my_resolved_30d: parseInt(myResolved.rows[0].c, 10)
    };
    // Team view for admin/top_dog.
    if (user.activeRole === 'admin' || user.activeRole === 'top_dog') {
      const team = await db.query(
        "SELECT s.id, s.first_name, s.last_name, s.email, " +
        "(SELECT COUNT(*) FROM tickets t WHERE t.assigned_to = s.id AND t.status != 'resolved') AS open_tickets, " +
        "(SELECT COUNT(*) FROM tickets t WHERE t.assigned_to = s.id AND t.status = 'resolved' AND t.resolved_at > NOW() - INTERVAL '30 days') AS resolved_30d " +
        "FROM stewards s WHERE s.id IN (SELECT DISTINCT assigned_to FROM tickets WHERE assigned_to IS NOT NULL) " +
        "ORDER BY open_tickets DESC");
      out.team = team.rows;
    }
    res.json(out);
  } catch (error) {
    console.error('Accountability error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- accounts receivable
// AR tiers: bills are due upon receipt. Tier 1 = 10+ days, Tier 2 = 20+ days, Tier 3 = 30+ days.
function arTier(daysOverdue) {
  if (daysOverdue >= 30) return 3;
  if (daysOverdue >= 20) return 2;
  if (daysOverdue >= 10) return 1;
  return 0;
}

// Watch list: open, non-estimate bills 10+ days overdue, not on hold.
app.get('/api/ar/watchlist', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const r = user.activeRole;
    if (['admin', 'top_dog', 'service', 'steward'].indexOf(r) === -1) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    let q = 'SELECT i.id, i.company_code, i.company_name, i.payroll_date, i.total_invoice, i.bill_type, ' +
      'i.ar_hold, c.billing_email, (CURRENT_DATE - i.payroll_date)::int AS days_overdue, ' +
      '(SELECT COUNT(*) FROM ar_followups WHERE invoice_id = i.id) AS touch_count, ' +
      '(SELECT MAX(created_at) FROM ar_followups WHERE invoice_id = i.id) AS last_touch, ' +
      '(SELECT MAX(tier) FROM ar_followups WHERE invoice_id = i.id AND action_type = ' + "'email'" + ') AS last_tier_emailed ' +
      'FROM invoices i LEFT JOIN companies c ON c.company_code = i.company_code ' +
      "WHERE i.status = 'open' AND i.is_estimate = FALSE AND i.ar_hold = FALSE " +
      'AND i.payroll_date IS NOT NULL AND (CURRENT_DATE - i.payroll_date) >= 10';
    const params = [];
    if (!canSeeAllTickets(user)) {
      const codes = await getVisibleCodes(user);
      if (!codes || codes.length === 0) return res.json([]);
      q += ' AND i.company_code = ANY($1)';
      params.push(codes);
    }
    q += ' ORDER BY (CURRENT_DATE - i.payroll_date) DESC, i.total_invoice DESC';
    const result = await getPool().query(q, params);
    const rows = result.rows.map(function (x) {
      x.tier = arTier(x.days_overdue);
      return x;
    });
    res.json(rows);
  } catch (error) {
    console.error('AR watchlist error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Follow-up history for a bill.
app.get('/api/ar/followups/:invoiceId', requireAuth, async (req, res) => {
  try {
    const r = await getPool().query(
      'SELECT f.*, s.first_name, s.last_name FROM ar_followups f ' +
      'LEFT JOIN stewards s ON s.id = f.created_by WHERE f.invoice_id = $1 ORDER BY f.created_at DESC',
      [req.params.invoiceId]);
    res.json(r.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Log a manual follow-up touch.
app.post('/api/ar/followups', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const r = user.activeRole;
    if (['admin', 'top_dog', 'service', 'steward'].indexOf(r) === -1) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    const { invoice_id, action_type, notes, promise_date } = req.body || {};
    if (!invoice_id) return res.status(400).json({ error: 'invoice_id is required' });
    const validTypes = ['email', 'call', 'note', 'promise'];
    const at = validTypes.indexOf(action_type) !== -1 ? action_type : 'note';
    await getPool().query(
      'INSERT INTO ar_followups (invoice_id, action_type, notes, promise_date, created_by) VALUES ($1, $2, $3, $4, $5)',
      [parseInt(invoice_id, 10), at, notes || null, promise_date || null, user.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('AR followup error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Set/clear the billing email for a company (admin/top_dog/service).
app.patch('/api/ar/billing-email', requireAuth, async (req, res) => {
  try {
    if (!canManageTickets(req.user)) return res.status(403).json({ error: 'Not authorized' });
    const { company_code, billing_email } = req.body || {};
    if (!company_code) return res.status(400).json({ error: 'company_code is required' });
    await getPool().query('UPDATE companies SET billing_email = $1 WHERE company_code = $2',
      [billing_email || null, String(company_code)]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Put a bill on hold / take it off hold (disputed, payment plan, etc).
app.patch('/api/ar/hold/:invoiceId', requireAuth, async (req, res) => {
  try {
    if (!canManageTickets(req.user)) return res.status(403).json({ error: 'Not authorized' });
    const hold = req.body && req.body.hold === true;
    await getPool().query('UPDATE invoices SET ar_hold = $1 WHERE id = $2', [hold, req.params.invoiceId]);
    if (req.body && req.body.notes) {
      await getPool().query(
        'INSERT INTO ar_followups (invoice_id, action_type, notes, created_by) VALUES ($1, ' + "'note'" + ', $2, $3)',
        [req.params.invoiceId, (hold ? '[Hold] ' : '[Unhold] ') + String(req.body.notes), req.user.id]);
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// AR summary counts for the nav badge / dashboard.
app.get('/api/ar/summary', requireAuth, async (req, res) => {
  try {
    const r = await getPool().query(
      "SELECT (CURRENT_DATE - payroll_date)::int AS days_overdue FROM invoices " +
      "WHERE status = 'open' AND is_estimate = FALSE AND ar_hold = FALSE " +
      'AND payroll_date IS NOT NULL AND (CURRENT_DATE - payroll_date) >= 10');
    const counts = { tier1: 0, tier2: 0, tier3: 0, total: 0 };
    let totalAmt = 0;
    const amtR = await getPool().query(
      "SELECT COALESCE(SUM(total_invoice), 0) AS amt FROM invoices " +
      "WHERE status = 'open' AND is_estimate = FALSE AND ar_hold = FALSE " +
      'AND payroll_date IS NOT NULL AND (CURRENT_DATE - payroll_date) >= 10');
    totalAmt = parseFloat(amtR.rows[0].amt) || 0;
    r.rows.forEach(function (x) {
      const t = arTier(x.days_overdue);
      counts.total++;
      if (t === 1) counts.tier1++;
      else if (t === 2) counts.tier2++;
      else if (t === 3) counts.tier3++;
    });
    counts.total_amount = Math.round(totalAmt * 100) / 100;
    res.json(counts);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Daily cron: send tier emails for newly-overdue bills, escalate tier 3 to tickets.
app.post('/api/admin/run-ar-followup-cron', async (req, res) => {
  if (!checkSyncSecret(req, res)) return;
  // A/R module retired 2026-10-13 (Leroy): no follow-up emails, no
  // auto-created tickets. The handler below is kept in place but
  // unreachable; the daily trigger cron has been removed.
  return res.json({ success: true, disabled: true, emailed: 0, tickets: 0, skipped_no_email: 0, errors: [] });
  const db = getPool();
  const out = { emailed: 0, tickets: 0, skipped_no_email: 0, errors: [] };
  try {
    const bills = await db.query(
      'SELECT i.id, i.company_code, i.company_name, i.payroll_date, i.total_invoice, i.bill_type, ' +
      'c.billing_email, (CURRENT_DATE - i.payroll_date)::int AS days_overdue, ' +
      '(SELECT MAX(tier) FROM ar_followups WHERE invoice_id = i.id AND action_type = ' + "'email'" + ') AS last_tier_emailed, ' +
      '(SELECT COUNT(*) FROM tickets WHERE title LIKE ' + "'%Overdue bill%' AND description ILIKE '%invoice #' || i.id || '%'" + ') AS ticket_count ' +
      'FROM invoices i LEFT JOIN companies c ON c.company_code = i.company_code ' +
      "WHERE i.status = 'open' AND i.is_estimate = FALSE AND i.ar_hold = FALSE " +
      'AND i.payroll_date IS NOT NULL AND (CURRENT_DATE - i.payroll_date) >= 10 ' +
      'ORDER BY (CURRENT_DATE - i.payroll_date) DESC');
    for (const b of bills.rows) {
      const tier = arTier(b.days_overdue);
      const lastEmailed = b.last_tier_emailed || 0;
      try {
        // Send the tier email if we haven't sent for this tier yet.
        if (tier > lastEmailed) {
          if (!b.billing_email) { out.skipped_no_email++; }
          else {
            const subjects = {
              1: 'Friendly reminder: invoice ' + b.days_overdue + ' days past due',
              2: 'Second notice: invoice ' + b.days_overdue + ' days past due',
              3: 'Final notice: invoice ' + b.days_overdue + ' days past due — escalation pending'
            };
            const bodies = {
              1: 'This is a friendly reminder that the invoice below is now ' + b.days_overdue + ' days past due. Bills are due upon receipt — please remit at your earliest convenience.',
              2: 'This is a second notice. The invoice below is now ' + b.days_overdue + ' days past due. Please remit promptly to avoid escalation.',
              3: 'FINAL NOTICE. The invoice below is now ' + b.days_overdue + ' days past due. If payment is not received promptly this account will be escalated for further action.'
            };
            const amt = '$' + Number(b.total_invoice).toLocaleString('en-US', { minimumFractionDigits: 2 });
            await sendEmail(b.billing_email, subjects[tier],
              '<p>' + bodies[tier] + '</p>' +
              '<p><b>Company:</b> ' + escHtml(b.company_code) + ' — ' + escHtml(b.company_name || '') + '<br>' +
              '<b>Payroll date:</b> ' + b.payroll_date.toISOString().slice(0, 10) + '<br>' +
              '<b>Amount:</b> ' + amt + '<br>' +
              '<b>Days overdue:</b> ' + b.days_overdue + '</p>' +
              '<p>Reply to this email or contact us if you have questions about this invoice.</p>');
            await db.query(
              'INSERT INTO ar_followups (invoice_id, action_type, notes, tier) VALUES ($1, ' + "'email'" + ', $2, $3)',
              [b.id, 'Tier ' + tier + ' automated reminder sent to ' + b.billing_email, tier]);
            out.emailed++;
          }
        }
        // Tier 3: auto-create a ticket if none exists for this invoice.
        if (tier === 3 && parseInt(b.ticket_count, 10) === 0) {
          const oncall = await getCurrentOnCall();
          const amt = '$' + Number(b.total_invoice).toLocaleString('en-US', { minimumFractionDigits: 2 });
          const ins = await db.query(
            'INSERT INTO tickets (company_code, title, description, category, priority, status, assigned_to) ' +
            'VALUES ($1, $2, $3, ' + "'billing'" + ', ' + "'high'" + ', ' + "'open'" + ', $4) RETURNING id',
            [b.company_code,
             'Overdue bill: ' + b.company_code + ' ' + amt + ' (' + b.days_overdue + ' days)',
             'Invoice #' + b.id + ' for ' + b.company_name + ' is ' + b.days_overdue + ' days overdue. ' +
             'Amount: ' + amt + ', payroll date: ' + b.payroll_date.toISOString().slice(0, 10) + '. ' +
             'Automated tier-3 reminders sent. Follow up for payment.',
             oncall ? oncall.steward_id : null]);
          out.tickets++;
        }
      } catch (e) {
        out.errors.push('Invoice ' + b.id + ': ' + e.message);
      }
    }
    res.json(Object.assign({ success: true }, out));
  } catch (error) {
    console.error('AR followup cron error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});



// Current commission table, for the admin view on the Jobs page.
app.get('/api/admin/commissions', requireAdmin, async (req, res) => {
  try {
    const r = await getPool().query(
      'SELECT c.company_code, c.steward_code, c.pct, s.first_name, s.last_name, s.email ' +
      'FROM commissions c LEFT JOIN stewards s ON s.id = c.steward_code ' +
      'ORDER BY c.company_code, c.steward_code');
    res.json(r.rows);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- github mirror sync (link-only) + stage learning
async function fetchProjectItems() {
  const query = `query($after: String) { organization(login: "` + GITHUB_ORG + `") { projectV2(number: ` + GITHUB_PROJECT + `) { items(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { id content { __typename ... on DraftIssue { title } ... on Issue { title number repository { nameWithOwner } } ... on PullRequest { title } } fieldValues(first: 25) { nodes { __typename ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } } ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { name } } } ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2Field { name } } } } } } } } } }`;
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

// Build the 12-week timeline for one implementation. v6.5 (Leroy): the
// clock starts on the GitHub Kanban board's "Implementation Start Date"
// (implementations.impl_start_date, kept current by the kanban sync).
// When that field is empty, no dates are assigned to the plan.
async function buildTimeline(db, implId) {
  const DAY = 24 * 60 * 60 * 1000;
  const st = await db.query('SELECT stage, impl_start_date FROM implementations WHERE id = $1', [implId]);
  const currentStage = st.rows.length ? String(st.rows[0].stage || '') : '';
  const rawStart = st.rows.length ? st.rows[0].impl_start_date : null;
  if (!rawStart) return { started: false, missingStartDate: true, blocks: [] };
  const startStr = rawStart instanceof Date ? rawStart.toISOString().slice(0, 10) : String(rawStart).slice(0, 10);
  const start = new Date(startStr + 'T00:00:00Z');
  if (isNaN(start.getTime())) return { started: false, missingStartDate: true, blocks: [] };
  const today = new Date();
  const weekElapsed = Math.max(0, Math.floor((today.getTime() - start.getTime()) / (7 * DAY)));
  const curStageIdx = STAGES.indexOf(currentStage);
  let currentMarked = false;
  const blocks = TIMELINE.map(function (b) {
    const sDate = new Date(start.getTime() + b.startWeek * 7 * DAY);
    const eDate = new Date(start.getTime() + b.endWeek * 7 * DAY);
    const bStageIdx = STAGES.indexOf(b.stage);
    // Color by actual stage, not by weeks elapsed: blocks before the current
    // stage are done (blue), the first block of the current stage is current
    // (purple).
    const done = curStageIdx !== -1 && bStageIdx !== -1 && bStageIdx < curStageIdx;
    let current = false;
    if (!currentMarked && !done && curStageIdx !== -1 && b.stage === currentStage) {
      current = true;
      currentMarked = true;
    }
    return {
      stage: b.stage, block: b.block, startWeek: b.startWeek, endWeek: b.endWeek,
      startDate: sDate.toISOString().slice(0, 10), endDate: eDate.toISOString().slice(0, 10),
      duties: b.duties,
      done: done,
      current: current
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

// ---------------------------------------------------------------- private message filters
// Any message whose body contains @github_username (case-insensitive) for a
// name on the private filter list is hidden from the app: the project message
// list, the nightly updates, and the weekly email. Messages stay stored (and
// stay on GitHub) so removing someone from the list restores their messages.
async function privateFilters(db) {
  const r = await db.query('SELECT id, name, github_username FROM private_message_filters ORDER BY github_username');
  return r.rows;
}
function isPrivateMessage(body, filters) {
  const b = String(body || '').toLowerCase();
  for (const f of (filters || [])) {
    const u = String(f.github_username || '').trim().toLowerCase();
    if (u && b.indexOf('@' + u) !== -1) return true;
  }
  return false;
}
function withoutPrivateMessages(rows, filters) {
  if (!filters || filters.length === 0) return rows;
  return rows.filter(function (m) { return !isPrivateMessage(m.body, filters); });
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
        else if (v.__typename === 'ProjectV2ItemFieldDateValue') fields[v.field.name] = v.date;
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
      // v6.5 (Leroy): the 12-week plan clock starts on the board's
      // "Implementation Start Date" field (a date field; may be empty).
      let implStartDate = null;
      for (const k of Object.keys(fields)) {
        if (String(k).trim().toLowerCase() === 'implementation start date' && fields[k]) {
          implStartDate = String(fields[k]).slice(0, 10);
        }
      }
      const up = await db.query(
        'INSERT INTO implementations (company_id, stage, status, github_item_id, github_issue_number, github_repo, card_title, payroll_provider, payroll_frequency, total_employees, qualified_employee_count, impl_start_date, updated_at) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW()) ' +
        'ON CONFLICT (github_item_id) DO UPDATE SET company_id = EXCLUDED.company_id, stage = EXCLUDED.stage, ' +
        'status = EXCLUDED.status, github_issue_number = EXCLUDED.github_issue_number, github_repo = EXCLUDED.github_repo, ' +
        'card_title = EXCLUDED.card_title, payroll_provider = EXCLUDED.payroll_provider, ' +
        'payroll_frequency = EXCLUDED.payroll_frequency, total_employees = EXCLUDED.total_employees, ' +
        'qualified_employee_count = EXCLUDED.qualified_employee_count, impl_start_date = EXCLUDED.impl_start_date, updated_at = NOW() RETURNING id',
        [companyId, stage, fields['Priority'] || 'NORMAL', item.id, issueNumber, repo,
          fullTitle, fields['Payroll Provider'] || null, fields['Payroll Frequency'] || null,
          fields['Total Employees'] != null ? Math.trunc(fields['Total Employees']) : null,
          fields['Qualified Employee Count'] != null ? Math.trunc(fields['Qualified Employee Count']) : null,
          implStartDate]);
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
        await db.query('DELETE FROM implementation_updates WHERE implementation_id = ANY($1)', [ids]);
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

      // No assigned companies (and not top dog / admin) -> no newsletter.
      if (!isTopDog && !isAdmin && companies.length === 0) {
        results.push({ email: recip.email, sent: false, skipped: 'no assigned companies' });
        continue;
      }

      // Activity in the window.
      let updates = [];
      let messages = [];
      let stageChanges = [];
      let invoices = [];
      const pfilters = await privateFilters(db);
      if (companyIds.length > 0) {
        const s = await db.query(
          'SELECT u.update_date, u.body, c.company_name, c.company_code FROM implementation_updates u ' +
          'JOIN implementations i ON i.id = u.implementation_id ' +
          'JOIN companies c ON c.id = i.company_id ' +
          'WHERE i.company_id = ANY($1) AND u.update_date >= $2 ORDER BY u.update_date DESC LIMIT 40',
          [companyIds, since]);
        updates = s.rows;
        const m = await db.query(
          'SELECT m.created_at, m.body, m.author_name, c.company_name, c.company_code FROM messages m ' +
          'JOIN implementations i ON i.id = m.implementation_id ' +
          'JOIN companies c ON c.id = i.company_id ' +
          'WHERE i.company_id = ANY($1) AND m.created_at >= $2 ORDER BY m.created_at DESC LIMIT 60',
          [companyIds, since]);
        messages = withoutPrivateMessages(m.rows, pfilters);
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

      // Nothing new on any of their companies this week -> no newsletter.
      const hadActivity = updates.length > 0 || messages.length > 0 || stageChanges.length > 0 || invoices.length > 0;
      if (!hadActivity) {
        results.push({ email: recip.email, sent: false, skipped: 'no updates this week' });
        continue;
      }

      const fmtList = function (arr, fn) {
        return arr.length === 0 ? '(none)' : arr.map(fn).join(nl);
      };
      const prompt =
        'You are writing a robust Friday weekly summary email for ' + recipName +
        ' (' + roles.join(', ') + ') at iM4 Health. Cover the last ' + days + ' days thoroughly — this is their one weekly briefing and it should feel complete.' + nl + nl +
        'THEIR COMPANIES (' + companies.length + '):' + nl +
        fmtList(companies.slice(0, 60), function (c) { return '- ' + c.company_name + ' (' + c.company_code + ')'; }) + nl + nl +
        'DAILY KEY UPDATES THIS WEEK (milestones and progress only):' + nl +
        fmtList(updates, function (u) {
          return '- ' + u.company_name + ' (' + u.company_code + '), ' + String(u.update_date).slice(0, 10) + ': ' + String(u.body || '').slice(0, 600);
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
        '- 4-6 bullets on what actually happened this week across their companies — lead with the biggest wins and movement' + nl + nl +
        'KEY MILESTONES:' + nl +
        '- every meaningful milestone or completed key task this week, with the company name' + nl + nl +
        'AT-RISK PROJECTS:' + nl +
        '- any project that looks blocked, stalled, or behind plan, with WHY (one line each); say "(none)" if everything is on track' + nl + nl +
        'YOUR TO-DOS (emphasis here — things assigned to ' + recipName + ' or needing their attention):' + nl +
        '- each bullet: WHAT, which COMPANY, and DUE DATE or TBD. Pull from updates, messages, stage stalls, and open invoices.' + nl + nl +
        'COMPANY UPDATES:' + nl +
        '- one short paragraph or 2-3 bullets per company that had activity; skip companies with nothing new' + nl + nl +
        'OPEN MONEY ITEMS:' + nl +
        '- open invoices that need attention, oldest first, with company and amount' + nl + nl +
        'Keep it plain-spoken and tight. No preamble, no sign-off.';

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 2500,
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
const SINGLE_DOC_TYPES = ['master_application', 'pre_implementation', 'commission_sheet', 'docusign_package'];
const DOC_LABELS = {
  master_application: 'Master Application',
  pre_implementation: 'Pre-Implementation Form',
  commission_sheet: 'Commission Sheet',
  w9: 'W-9',
  ach: 'ACH Authorization',
  soluta_billing_intake: 'Soluta Billing Intake Form',
  docusign_package: 'DocuSign Package'
};
const GITHUB_ISSUES_OWNER = process.env.GITHUB_ISSUES_OWNER || 'im4health-implementation';
const GITHUB_ISSUES_REPO = process.env.GITHUB_ISSUES_REPO || 'Implementation';
const GITHUB_PROJECT_ID = process.env.GITHUB_PROJECT_ID || 'PVT_kwDOEB2rr84BTidM';
const GITHUB_STATUS_FIELD_ID = process.env.GITHUB_STATUS_FIELD_ID || 'PVTSSF_lADOEB2rr84BTidM';

const multer = require('multer');
const onboardingUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
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
    if (roles.indexOf('admin') !== -1 || roles.indexOf('onboarding') !== -1 || roles.indexOf('top_dog') !== -1) return next();
    return res.status(403).json({ error: 'Onboarding access only' });
  });
}

// Forms tab: visible to top_dog and admin.
function requireFormsViewer(req, res, next) {
  requireAuth(req, res, function () {
    const r = req.user && req.user.activeRole;
    if (r === 'admin' || r === 'top_dog') return next();
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
  ['Payroll Frequency #3 (if applicable)', 'payrollFreq3'],
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
  // Match longest labels first so 'Payroll Frequency #2' wins over 'Payroll Frequency'.
  const sortedLabels = PREIMPL_LABELS.slice().sort(function (a, b) { return b[0].length - a[0].length; });
  for (const r of rows) {
    if (!r) continue;
    const lab = normLabel(cell(r, 1) || cell(r, 0));
    for (const pair of sortedLabels) {
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
  const val = function (r, i) { const v = r && r[i]; return (v === null || v === undefined) ? '' : String(v).trim(); };
  const num = function (v) { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
  const out = { groupName: '', agencyName: '', agencyPct: null, totalCommission: null, agents: [], effectiveDate: '' };
  let pending = null;
  rows.forEach(function (r) {
    if (!r) return;
    const a = val(r, 0).toLowerCase();
    for (let i = 0; i < r.length; i++) {
      if (val(r, i).toLowerCase() === 'total commission') {
        for (let j = i + 1; j < r.length; j++) { const n = num(val(r, j)); if (n !== null) { out.totalCommission = n; break; } }
      }
    }
    if (a === 'group name') out.groupName = val(r, 1);
    else if (a === 'agency name') out.agencyName = val(r, 1);
    else if (a === 'effective date') out.effectiveDate = val(r, 1);
    else if (a === 'agency') { if (val(r, 1)) out.agencyName = val(r, 1); pending = { kind: 'agency' }; }
    else if (/^agent \d+$/.test(a)) {
      const nm = val(r, 1);
      if (nm) { out.agents.push({ name: nm, pct: null }); pending = { kind: 'agent', idx: out.agents.length - 1 }; }
      else pending = null;
    }
    else if (a === 'broker') pending = null;
    else if (a === 'percentage' && pending) {
      let p = num(val(r, 1));
      if (p !== null && p > 1) p = p / 100;
      if (pending.kind === 'agency') out.agencyPct = p;
      else if (pending.idx !== undefined && out.agents[pending.idx]) out.agents[pending.idx].pct = p;
    }
  });
  if (out.agents.length === 0) {
    // fall back to the header-section agent names (no percentages available)
    ['Agent 1 Name', 'Agent 2 Name', 'Agent 3 Name'].forEach(function (lab) {
      const get = function (label) {
        for (const r of rows) {
          if (r && r[0] && String(r[0]).trim().toLowerCase() === String(label).toLowerCase()) {
            const v = r[1]; return (v === null || v === undefined) ? '' : String(v).trim();
          }
        }
        return '';
      };
      const nm = get(lab);
      if (nm) out.agents.push({ name: nm, pct: null });
    });
  }
  return out;
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

// Canonical payroll frequencies found in a free-text field.
function modesIn(text) {
  const h = ' ' + String(text || '').toLowerCase() + ' ';
  const modes = [];
  if (/semi[\s-]?monthly/.test(h)) modes.push('Semi-monthly');
  if (/bi[\s-]?weekly/.test(h)) modes.push('Bi-weekly');
  const t = h.replace(/semi[\s-]?monthly/g, ' ').replace(/bi[\s-]?weekly/g, ' ');
  if (/weekly/.test(t)) modes.push('Weekly');
  if (/monthly/.test(t)) modes.push('Monthly');
  return modes;
}

// Payroll frequencies for one EIN block ('same' inherits EIN #1's value).
function einModes(ein, first) {
  const get = function (v, fb) { return /^same$/i.test(String(v || '').trim()) ? fb : v; };
  const f = first || ein;
  const modes = [];
  [get(ein.payrollFreq, f.payrollFreq), get(ein.payrollFreq2, f.payrollFreq2), get(ein.payrollFreq3, f.payrollFreq3)]
    .forEach(function (txt) {
      modesIn(txt).forEach(function (m) { if (modes.indexOf(m) === -1) modes.push(m); });
    });
  return modes;
}

const SOLUTA_PERIODS = { 'Weekly': 52, 'Bi-weekly': 26, 'Semi-monthly': 24, 'Monthly': 12 };

// Referral-fee-calculator math from the commission sheet:
// per-period admin fee = totalCommission * 12 / periodsPerYear; each payee
// gets that times their commission percentage.
function solutaPepm(comm, mode) {
  const periods = SOLUTA_PERIODS[mode] || 24;
  const total = comm.totalCommission;
  const money = function (pct) {
    if (!(total > 0) || pct === null || pct === undefined) return '';
    return '$' + (Math.round(total * 12 / periods * pct * 100) / 100).toFixed(2);
  };
  return { agencyAmt: money(comm.agencyPct), money: money };
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
  const cellTextOf = function (tcXml) {
    let out = '';
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
    let mm;
    while ((mm = re.exec(tcXml)) !== null) out += mm[1];
    return out.replace(/&(amp|lt|gt|quot);/g, function (e) { return { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' }[e]; });
  };
  const setCellText = function (tcXml, text, highlight) {
    let tcPr = (tcXml.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/) || [''])[0];
    if (highlight) {
      const shd = '<w:shd w:val="clear" w:color="auto" w:fill="FFFF00"/>';
      tcPr = tcPr ? tcPr.replace(/<\/w:tcPr>$/, shd + '</w:tcPr>') : '<w:tcPr>' + shd + '</w:tcPr>';
    }
    const open = tcXml.match(/^<w:tc(\s[^>]*)?>/);
    return '<w:tc' + (open && open[1] ? open[1] : '') + '>' + tcPr +
      '<w:p><w:r><w:t xml:space="preserve">' + escXml(text) + '</w:t></w:r></w:p></w:tc>';
  };
  // texts: array of strings or {t, hl}; cells without a spec are left as-is
  const setRowCells = function (trXml, texts) {
    const cells = cellsOf(trXml);
    const out = cells.map(function (c, i) {
      if (i >= texts.length) return c;
      const spec = texts[i];
      const t = (spec && typeof spec === 'object') ? spec.t : spec;
      const hl = !!(spec && typeof spec === 'object' && spec.hl);
      return setCellText(c, t === undefined || t === null ? '' : t, hl);
    });
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
  r0[0] = setRowCells(r0[0], [labelText, { t: data.groupName || '', hl: !data.groupName }]);
  newTables[0] = buildTable(tables[0].xml, r0);

  // Table 1: locations (header + data rows; clone last row if more locations)
  let r1 = rowsOf(tables[1].xml);
  const tmplRow = r1[r1.length - 1];
  const locRows = [r1[0]];
  data.locations.forEach(function (loc, i) {
    const src = r1[1 + i] || tmplRow;
    locRows.push(setRowCells(src, [
      { t: loc.name, hl: !loc.name },
      { t: loc.ein, hl: !loc.ein },
      { t: loc.groupId, hl: !loc.groupId },
      loc.notes || ''
    ]));
  });
  newTables[1] = buildTable(tables[1].xml, locRows);

  // Table 2: contacts
  let r2 = rowsOf(tables[2].xml);
  const contactRows = [r2[0]];
  const mkContact = function (srcRow, type, name, phone, email, hl) {
    hl = hl || {};
    return setRowCells(srcRow, [type, { t: name || '', hl: !!hl.name }, phone || '', { t: email || '', hl: !!hl.email }, mode]);
  };
  contactRows.push(mkContact(r2[1], 'Primary Contact', data.primary.name, '', data.primary.email, { name: !data.primary.name, email: !data.primary.email }));
  contactRows.push(mkContact(r2[2], 'Billing Contact', data.billing.name, '', data.billing.email, { name: !data.billing.name, email: !data.billing.email }));
  contactRows.push(mkContact(r2[3], 'Broker Producer', data.brokerProducer.name, '', '', { name: !data.brokerProducer.name, email: true }));
  contactRows.push(r2[4]); // Broker Account Manager stays as-is (blank)
  const otherTmpl = r2[4];
  contactRows.push(setRowCells(otherTmpl, ['Other', '', '', '', '']));
  contactRows.push(setRowCells(otherTmpl, ['Other', '', '', '', '']));
  newTables[2] = buildTable(tables[2].xml, contactRows);

  // Table 3: PEPM rows. Row 1 (agency starter row from the template) is kept as-is;
  // agent rows fill the blank rows below, cloning if there are more agents.
  let r3 = rowsOf(tables[3].xml);
  const pepmRows = [r3[0]];
  // Agency starter row from the template: keep its payee text, set the computed amount.
  const agencyCells = cellsOf(r3[1]);
  const tplSuffix = (cellTextOf(agencyCells[1]).split('/')[1] || '').trim();
  const modeSuffix = (mode === 'Semi-monthly' && tplSuffix) ? tplSuffix : mode.toLowerCase();
  const amtText = function (amt) { return (amt || ('$5.00/' + modeSuffix)) + (amt && amt.indexOf('/') === -1 ? '/' + modeSuffix : ''); };
  pepmRows.push(setRowCells(r3[1], [{ t: cellTextOf(agencyCells[0]) }, { t: amtText(data.agencyAmt), hl: !data.agencyAmt }]));
  const pepmTmpl = r3[r3.length - 1];
  data.agents.forEach(function (a, i) {
    const src = r3[2 + i] || pepmTmpl;
    const who = a.name + (a.taxId ? ' \u2013 ' + a.taxId : '');
    pepmRows.push(setRowCells(src, [{ t: who, hl: !a.taxId }, { t: amtText(a.amount), hl: !a.amount }]));
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
// ------------------------------------------- v6.0: onboarding process (Leroy's 5-step flow)
// Step 1/2: a DocuSign package is uploaded and validated before anything
// else can happen. Step 3: the Pre-Implementation Form yields the child
// companies. Step 4: Submit writes the Companies table, then a Verify
// pass checks commissions + stewards. Step 5: a GitHub card is opened.
const US_STATES = { AL: 'ALABAMA', AK: 'ALASKA', AZ: 'ARIZONA', AR: 'ARKANSAS', CA: 'CALIFORNIA', CO: 'COLORADO', CT: 'CONNECTICUT', DE: 'DELAWARE', FL: 'FLORIDA', GA: 'GEORGIA', HI: 'HAWAII', ID: 'IDAHO', IL: 'ILLINOIS', IN: 'INDIANA', IA: 'IOWA', KS: 'KANSAS', KY: 'KENTUCKY', LA: 'LOUISIANA', ME: 'MAINE', MD: 'MARYLAND', MA: 'MASSACHUSETTS', MI: 'MICHIGAN', MN: 'MINNESOTA', MS: 'MISSISSIPPI', MO: 'MISSOURI', MT: 'MONTANA', NE: 'NEBRASKA', NV: 'NEVADA', NH: 'NEW HAMPSHIRE', NJ: 'NEW JERSEY', NM: 'NEW MEXICO', NY: 'NEW YORK', NC: 'NORTH CAROLINA', ND: 'NORTH DAKOTA', OH: 'OHIO', OK: 'OKLAHOMA', OR: 'OREGON', PA: 'PENNSYLVANIA', RI: 'RHODE ISLAND', SC: 'SOUTH CAROLINA', SD: 'SOUTH DAKOTA', TN: 'TENNESSEE', TX: 'TEXAS', UT: 'UTAH', VT: 'VERMONT', VA: 'VIRGINIA', WA: 'WASHINGTON', WV: 'WEST VIRGINIA', WI: 'WISCONSIN', WY: 'WYOMING', DC: 'DISTRICT OF COLUMBIA' };

function dsNorm(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function dsHas(hay, needle) { const n = dsNorm(needle); return n.length >= 2 && dsNorm(hay).indexOf(n) !== -1; }
function stateVariants(stateRaw) {
  const up = String(stateRaw || '').toUpperCase().trim();
  const out = [];
  if (!up) return out;
  if (US_STATES[up]) { out.push(up, US_STATES[up]); return out; }
  Object.keys(US_STATES).forEach(function (abbr) { if (US_STATES[abbr] === up) out.push(abbr, up); });
  if (!out.length) out.push(up);
  return out;
}

// Value printed after a form label on the same extracted line, cut at the
// next label so "City: X State: Y" style rows split correctly.
const DS_NEXT_LABEL = /\s+(Address|City|State|Zip|ZIP Code|Phone|Telephone|Fax|Email|Signature|Date|Name|Number|Representative|Bank|Routing|Account|Client|Grantee|Tax ID)\s*:.*$/i;
function dsField(lines, labelRe) {
  for (const line of lines) {
    const m = line.match(labelRe);
    if (m) {
      let v = line.slice(m.index + m[0].length).replace(/^[\s:\-–]+/, '').trim();
      const cut = v.replace(DS_NEXT_LABEL, '').trim();
      if (cut) v = cut;
      if (v) return v;
    }
  }
  return '';
}

function dsSigEvidence(pagesArr) {
  const dateRe = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/i;
  let sig = 0, dates = 0;
  pagesArr.forEach(function (pg) {
    pg.lines.forEach(function (l) {
      if (/signature|signed by/i.test(l) && !/^(signature|signed|date)\s*:?\s*$/i.test(l.trim())) sig++;
      if (dateRe.test(l)) dates++;
    });
  });
  return { sig: sig, dates: dates };
}

// Validate one uploaded DocuSign package. pages = extractPdfLines output;
// policyName = applicant name from the POLICYHOLDER INFORMATION block
// (extractApplicantName) used as a cross-check source. Returns itemized
// checks; passed = every check ok (Leroy: submission is blocked until
// the verifications are confirmed).
function validateDocusignPackage(pages, policyName) {
  const checks = [];
  const add = function (id, label, ok, detail) { checks.push({ id: id, label: label, ok: !!ok, detail: detail || '' }); };
  const pageText = function (pg) { return pg.lines.join('\n'); };
  const findStart = function (needles) {
    for (let i = 0; i < pages.length; i++) {
      const t = pageText(pages[i]);
      for (const n of needles) if (dsHas(t, n)) return i;
    }
    return -1;
  };
  const fiaStart = findStart(['Fixed Indemnity']);
  const msaStart = findStart(['Master Services Agreement']);
  const achStart = findStart(['Authorization Agreement for Direct Payments', 'Direct Payments ACH']);
  const starts = [fiaStart, msaStart, achStart].filter(function (x) { return x >= 0; }).sort(function (a, b) { return a - b; });
  const section = function (start) {
    if (start < 0) return [];
    let end = pages.length;
    starts.forEach(function (s) { if (s > start && s < end) end = s; });
    return pages.slice(start, Math.min(end, start + 10));
  };
  add('includes_fia', 'Package includes the Group Benefits - Fixed Indemnity Application', fiaStart >= 0, fiaStart >= 0 ? 'Found on page ' + pages[fiaStart].page + '.' : 'No page mentions "Fixed Indemnity".');
  add('includes_msa', 'Package includes the Master Services Agreement', msaStart >= 0, msaStart >= 0 ? 'Found on page ' + pages[msaStart].page + '.' : 'No page mentions "Master Services Agreement".');
  add('includes_ach', 'Package includes the Authorization Agreement for Direct Payments (ACH)', achStart >= 0, achStart >= 0 ? 'Found on page ' + pages[achStart].page + '.' : 'No page mentions the Authorization Agreement for Direct Payments.');

  // ---- Fixed Indemnity Application, first page
  const applicant = { name: '', address: '', city: '', state: '', zip: '', phone: '' };
  if (fiaStart >= 0) {
    const first = pages[fiaStart].lines;
    const sec = section(fiaStart);
    applicant.name = dsField(first, /applicant\s*\/?\s*policyholder/i) || dsField(first, /policyholder/i) || policyName || '';
    applicant.address = dsField(first, /(^|\s)address(?!\s*of)/i);
    applicant.city = dsField(first, /\bcity\b/i);
    applicant.state = dsField(first, /\bstate\b/i);
    applicant.zip = dsField(first, /\bzip(\s*code)?\b/i);
    if (!/\d{5}/.test(applicant.zip)) {
      const zm = pageText(pages[fiaStart]).match(/\b\d{5}(-\d{4})?\b/);
      applicant.zip = zm ? zm[0] : applicant.zip;
    }
    applicant.phone = dsField(first, /\b(phone|telephone)\b/i);
    if (applicant.phone.replace(/\D/g, '').length < 7) {
      const pm = pageText(pages[fiaStart]).match(/\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/);
      applicant.phone = pm ? pm[0] : applicant.phone;
    }
    add('fia_applicant', 'Application: Applicant/Policyholder is filled out', applicant.name.length >= 2, applicant.name ? 'Read: ' + applicant.name : 'No value found next to Applicant/Policyholder on the first page.');
    add('fia_address', 'Application: Address is filled out', applicant.address.length >= 4, applicant.address ? 'Read: ' + applicant.address : 'No value found next to Address on the first page.');
    add('fia_city', 'Application: City is filled out', applicant.city.length >= 2, applicant.city ? 'Read: ' + applicant.city : 'No value found next to City on the first page.');
    add('fia_state', 'Application: State is filled out', applicant.state.length >= 2, applicant.state ? 'Read: ' + applicant.state : 'No value found next to State on the first page.');
    add('fia_zip', 'Application: Zip Code is filled out', /\d{5}/.test(applicant.zip), applicant.zip ? 'Read: ' + applicant.zip : 'No 5-digit Zip Code found on the first page.');
    add('fia_phone', 'Application: Phone Number is filled out', applicant.phone.replace(/\D/g, '').length >= 7, applicant.phone ? 'Read: ' + applicant.phone : 'No phone number found on the first page.');
    const ev = dsSigEvidence(sec);
    add('fia_signature', 'Application: signature and signature date present', ev.sig >= 1 && ev.dates >= 1, 'Found ' + ev.sig + ' signature line(s) and ' + ev.dates + ' date(s) in the Application section.');
  }
  // ---- Master Services Agreement
  if (msaStart >= 0) {
    const sec = section(msaStart);
    const firstText = pageText(pages[msaStart]);
    const titleAt = firstText.toUpperCase().indexOf('MASTER SERVICES AGREEMENT');
    const preamble = titleAt >= 0 ? firstText.slice(titleAt, titleAt + 1800) : firstText.slice(0, 1800);
    add('msa_blank1', 'Master Services Agreement: first blank matches the Applicant/Policyholder', applicant.name && dsHas(preamble, applicant.name), applicant.name ? (dsHas(preamble, applicant.name) ? 'The first paragraph names ' + applicant.name + '.' : applicant.name + ' does not appear in the first paragraph.') : 'No Applicant/Policyholder was read from the Application to compare against.');
    const cityOk = applicant.city && dsHas(preamble, applicant.city);
    const stateOk = stateVariants(applicant.state).some(function (v) { return dsHas(preamble, v); });
    add('msa_blank2', 'Master Services Agreement: second blank at least matches the City and State', !!(cityOk && stateOk), 'City match: ' + (cityOk ? 'yes' : 'no') + '; State match: ' + (stateOk ? 'yes' : 'no') + ' (checked the first paragraph).');
    const lastPage = sec.length ? [sec[sec.length - 1]] : [];
    const ev2 = dsSigEvidence(lastPage);
    add('msa_signatures', 'Master Services Agreement: signature and date in both signature blocks on the last page', ev2.sig >= 2 && ev2.dates >= 2, 'On the last page (page ' + (lastPage.length ? lastPage[0].page : '?') + '): ' + ev2.sig + ' signature line(s), ' + ev2.dates + ' date(s); two of each are required.');
  }
  // ---- Authorization Agreement for Direct Payments (ACH)
  if (achStart >= 0) {
    const sec = section(achStart);
    const lines = [];
    sec.forEach(function (pg) { pg.lines.forEach(function (l) { lines.push(l); }); });
    const secText = sec.map(pageText).join('\n');
    const gName = dsField(lines, /client\s*\/?\s*grantee\s*name/i) || dsField(lines, /grantee/i) || dsField(lines, /client\s*name/i);
    add('ach_client', 'ACH Agreement: Client/Grantee Name is filled out', gName.length >= 2, gName ? 'Read: ' + gName : 'No value found next to Client/Grantee Name.');
    let taxId = dsField(lines, /tax\s*id/i);
    if (!/\d{2}-\d{7}|\d{9}/.test(taxId)) { const tm = secText.match(/\b\d{2}-\d{7}\b/); taxId = tm ? tm[0] : taxId; }
    add('ach_taxid', 'ACH Agreement: Tax ID Number is filled out', /\d{2}-\d{7}/.test(taxId) || /\d{9}/.test(taxId.replace(/\D/g, '')), taxId ? 'Read: ' + taxId : 'No Tax ID Number found.');
    const rep = dsField(lines, /authorized\s*representative/i);
    add('ach_rep', 'ACH Agreement: Authorized Representative is filled out', rep.length >= 2, rep ? 'Read: ' + rep : 'No value found next to Authorized Representative.');
    const bank = dsField(lines, /bank\s*name/i) || dsField(lines, /name\s*of\s*bank/i) || dsField(lines, /financial\s*institution/i);
    add('ach_bank', 'ACH Agreement: Bank Name is filled out', bank.length >= 2, bank ? 'Read: ' + bank : 'No value found next to Bank Name.');
    let routing = dsField(lines, /routing/i).replace(/\D/g, '');
    if (routing.length !== 9) { const rm = secText.replace(/[^0-9\n]/g, ' ').match(/\b\d{9}\b/); routing = rm ? rm[0] : routing; }
    add('ach_routing', 'ACH Agreement: Routing Number is filled out (9 digits)', routing.length === 9, routing ? 'Read: ' + routing : 'No 9-digit routing number found.');
    const acct = dsField(lines, /account\s*number/i).replace(/\D/g, '');
    add('ach_account', 'ACH Agreement: Bank Account Number is filled out', acct.length >= 4, acct ? 'Read: account ending ' + acct.slice(-4) : 'No value found next to Account Number.');
    const ev3 = dsSigEvidence(sec);
    add('ach_signature', 'ACH Agreement: signature and signature date present', ev3.sig >= 1 && ev3.dates >= 1, 'Found ' + ev3.sig + ' signature line(s) and ' + ev3.dates + ' date(s) in the ACH section.');
  }
  return { checks: checks, passed: checks.every(function (c) { return c.ok; }), applicant: applicant };
}

async function nextParentCode(db) {
  const r = await db.query("SELECT parent_company_code AS pc FROM companies");
  let max = 1000;
  r.rows.forEach(function (x) {
    const m = String(x.pc || '').match(/^PC(\d+)$/);
    if (m) { const n = parseInt(m[1], 10); if (!isNaN(n) && n > max) max = n; }
  });
  return 'PC' + String(max + 1).padStart(4, '0');
}
async function nextCompanyCode(db) {
  const r = await db.query("SELECT company_code FROM companies WHERE company_code ~ '^[0-9]+$'");
  let max = 1000;
  r.rows.forEach(function (x) { const n = parseInt(String(x.company_code), 10); if (!isNaN(n) && n > max) max = n; });
  return max + 1;
}

// "123 Main St, Springfield, IL 62701" -> parts; best-effort, the whole
// string stays in address_1 when the tail does not parse.
function splitAddress(raw) {
  const out = { address_1: '', city: '', state: '', zip: '' };
  const s = String(raw || '').replace(/\s*\n\s*/g, ', ').replace(/\s+/g, ' ').trim();
  if (!s) return out;
  const m = s.match(/^(.*?)[, ]+([A-Za-z .]+?)[, ]+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/);
  if (m) {
    out.address_1 = m[1].replace(/,+$/, '').trim();
    out.city = m[2].trim();
    out.state = m[3];
    out.zip = m[4];
    return out;
  }
  const z = s.match(/(\d{5}(?:-\d{4})?)\s*$/);
  if (z) out.zip = z[1];
  out.address_1 = s;
  return out;
}

// Companies a client's Pre-Implementation Form will create (Step 3/4).
async function preImplCompanies(db, clientId) {
  const d = await db.query("SELECT file_data FROM onboarding_documents WHERE client_id = $1 AND doc_type = 'pre_implementation' ORDER BY uploaded_at DESC LIMIT 1", [clientId]);
  if (!d.rows.length) return { error: 'No Pre-Implementation Form has been uploaded yet.' };
  let blocks;
  try { blocks = extractPreImplEins(d.rows[0].file_data); }
  catch (e) { return { error: 'Could not read the Pre-Implementation Form: ' + e.message }; }
  let next = await nextCompanyCode(db);
  const companies = [];
  let skipped = 0;
  blocks.forEach(function (b) {
    if (!b.legalName) { skipped++; return; }
    const parts = splitAddress(b.address);
    companies.push({
      company_code: String(next++).padStart(4, '0'),
      ein: String(b.taxId || '').trim(),
      company_name: String(b.legalName || '').trim(),
      company_address_1: parts.address_1,
      company_city: parts.city,
      company_state: parts.state,
      company_zip: parts.zip,
      company_status: 'PENDING',
      missing: [
        !b.address ? 'Employer Address' : null,
        !b.taxId ? 'Employer Tax ID (EIN)' : null,
        !parts.city ? 'City (could not be separated from the address)' : null,
        !parts.state ? 'State (could not be separated from the address)' : null,
        !parts.zip ? 'Zip (could not be separated from the address)' : null
      ].filter(Boolean)
    });
  });
  const pp = blocks.map(function (b) { return b.payrollProvider; }).filter(Boolean)[0] || '';
  return { companies: companies, skipped: skipped, payroll_provider: pp };
}

// Step 4 Verify: for each company created by this onboarding, the
// commission schedule must be complete (100%) and every steward on it
// must be on the Stewards table with required fields + W9 + ACH.
async function runProcessVerify(db, client) {
  const items = [];
  let codes = [];
  try { codes = JSON.parse(client.companies_json || '[]'); } catch (e) { codes = []; }
  if (!codes.length) return { pass: false, items: [{ ok: false, text: 'No companies have been created yet - finish Step 3 and click Submit first.' }] };
  let allOk = true;
  for (const code of codes) {
    const cr = await db.query('SELECT COALESCE(SUM(pct), 0) AS total, COUNT(*)::int AS n FROM commissions WHERE company_code = $1', [code]);
    const total = parseFloat(cr.rows[0].total);
    if (cr.rows[0].n === 0) { items.push({ ok: false, text: 'Company ' + code + ': no commission record yet - add it on the Commissions page.' }); allOk = false; continue; }
    if (Math.abs(total - 100) > 0.01) { items.push({ ok: false, text: 'Company ' + code + ': commissions add up to ' + (Math.round(total * 100) / 100) + '%, not 100%.' }); allOk = false; continue; }
    items.push({ ok: true, text: 'Company ' + code + ': commission schedule is complete (adds up to 100%).' });
    const srs = await db.query('SELECT DISTINCT steward_code FROM commissions WHERE company_code = $1 ORDER BY steward_code', [code]);
    for (const sr of srs.rows) {
      const sid = sr.steward_code;
      const st = await db.query('SELECT first_name, last_name, email FROM stewards WHERE id = $1', [sid]);
      if (!st.rows.length) { items.push({ ok: false, text: 'Steward ' + sid + ' (company ' + code + ') is not on the Stewards table.' }); allOk = false; continue; }
      const s = st.rows[0];
      const missF = [];
      if (!s.first_name) missF.push('First Name');
      if (!s.last_name) missF.push('Last Name');
      if (!s.email) missF.push('Email');
      if (missF.length) { items.push({ ok: false, text: 'Steward ' + sid + ' is missing required field(s) on the Stewards page: ' + missF.join(', ') + '.' }); allOk = false; continue; }
      const docs = await db.query('SELECT doc_type FROM steward_documents WHERE steward_id = $1', [sid]);
      const have = docs.rows.map(function (x) { return x.doc_type; });
      const missD = [];
      if (have.indexOf('w9') === -1) missD.push('W9');
      if (have.indexOf('ach') === -1) missD.push('ACH');
      if (missD.length) { items.push({ ok: false, text: 'Steward ' + sid + ' (' + s.first_name + ' ' + s.last_name + ') is missing document(s): ' + missD.join(' and ') + ' - upload them on the Stewards page.' }); allOk = false; continue; }
      items.push({ ok: true, text: 'Steward ' + sid + ' (' + s.first_name + ' ' + s.last_name + '): on the Stewards table, required fields filled, W9 and ACH uploaded.' });
    }
  }
  return { pass: allOk, items: items };
}

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
    if (ONBOARDING_DOC_TYPES.indexOf(docType) === -1 && docType !== 'docusign_package') return res.status(400).json({ error: 'Unknown document type' });
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
// v6.10.0 (Leroy): delete an unfinished onboarding session. Only before
// the point of no return: a completed session is a record, and once
// companies have been created (Step 4) the session stays - the companies
// themselves are managed on the Companies page. Documents and audit
// issues cascade-delete with the client row.
app.delete('/api/onboarding/:id', requireOnboarder, async (req, res) => {
  const r = req.user && req.user.activeRole;
  if (r !== 'admin' && r !== 'onboarding') return res.status(403).json({ error: 'Admin or Onboarding only' });
  try {
    const db = getPool();
    const cur = await db.query('SELECT status, wizard_step, github_issue_number FROM onboarding_clients WHERE id = $1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Onboarding session not found' });
    const c = cur.rows[0];
    if (c.status === 'complete' || c.github_issue_number) {
      return res.status(400).json({ error: 'This onboarding is complete and cannot be deleted.' });
    }
    if ((c.wizard_step || 1) >= 4) {
      return res.status(400).json({ error: 'Companies were already created from this session, so the session cannot be deleted. The companies themselves can be removed on the Companies page.' });
    }
    await db.query('DELETE FROM onboarding_clients WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) { console.error('Onboarding session delete error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

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


// ------------------------------------------- onboarding process endpoints (v6.0)
// Step 1: start a process (creates the onboarding record the wizard drives).
app.post('/api/onboarding/process-start', requireOnboarder, async (req, res) => {
  try {
    const db = getPool();
    const ins = await db.query(
      "INSERT INTO onboarding_clients (client_name, status, created_by, wizard_step) VALUES ('New Onboarding (DocuSign pending)', 'in_progress', $1, 1) RETURNING id",
      [req.user.id]);
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (error) { console.error('Process start error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// Step 2: validate the uploaded DocuSign package. On a full pass the
// Parent Code (highest + 1) and Parent Name (the Applicant/Policyholder)
// are assigned and the process opens Step 3.
app.post('/api/onboarding/:id/docusign-check', requireOnboarder, async (req, res) => {
  try {
    const db = getPool();
    const c = await db.query('SELECT * FROM onboarding_clients WHERE id = $1', [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ error: 'Not found' });
    const client = c.rows[0];
    const d = await db.query("SELECT file_data FROM onboarding_documents WHERE client_id = $1 AND doc_type = 'docusign_package' ORDER BY uploaded_at DESC LIMIT 1", [req.params.id]);
    if (!d.rows.length) return res.status(400).json({ error: 'No DocuSign package has been uploaded yet.' });
    let pages, policy;
    try {
      pages = await extractPdfLines(d.rows[0].file_data);
      policy = await extractApplicantName(d.rows[0].file_data);
    } catch (e) {
      return res.status(400).json({ error: 'Could not read the uploaded PDF: ' + e.message });
    }
    const result = validateDocusignPackage(pages, policy.name);
    if (result.passed) {
      const parentCode = client.parent_code || await nextParentCode(db);
      const parentName = result.applicant.name || client.parent_name || client.client_name;
      await db.query('UPDATE onboarding_clients SET parent_code = $1, parent_name = $2, client_name = $2, wizard_step = CASE WHEN wizard_step IS NULL OR wizard_step < 3 THEN 3 ELSE wizard_step END WHERE id = $3',
        [parentCode, parentName, req.params.id]);
      return res.json({ ok: true, passed: true, checks: result.checks, applicant: result.applicant, parent_code: parentCode, parent_name: parentName });
    }
    res.json({ ok: true, passed: false, checks: result.checks, applicant: result.applicant });
  } catch (error) { console.error('DocuSign check error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// Step 3: preview the companies the Pre-Implementation Form will create.
app.post('/api/onboarding/:id/preimpl-preview', requireOnboarder, async (req, res) => {
  try {
    const db = getPool();
    const out = await preImplCompanies(db, req.params.id);
    if (out.error) return res.status(400).json({ error: out.error });
    res.json({ ok: true, companies: out.companies, skipped: out.skipped });
  } catch (error) { console.error('Pre-impl preview error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// Step 4 Submit: write the companies to the Companies table (status
// PENDING, under the assigned Parent Code/Name). Runs once.
app.post('/api/onboarding/:id/process-submit-companies', requireOnboarder, async (req, res) => {
  const db = getPool();
  const client = await db.connect();
  try {
    const c = await db.query('SELECT * FROM onboarding_clients WHERE id = $1', [req.params.id]);
    if (!c.rows.length) { client.release(); return res.status(404).json({ error: 'Not found' }); }
    const record = c.rows[0];
    if (!record.parent_code || !record.parent_name) { client.release(); return res.status(400).json({ error: 'The DocuSign package has not been verified yet (Step 2).' }); }
    if (record.companies_json) { client.release(); return res.status(400).json({ error: 'The companies for this onboarding were already submitted.' }); }
    const out = await preImplCompanies(db, req.params.id);
    if (out.error) { client.release(); return res.status(400).json({ error: out.error }); }
    if (!out.companies.length) { client.release(); return res.status(400).json({ error: 'No EIN columns with a Legal Name of the Company were found in the Pre-Implementation Form.' }); }
    const blocking = [];
    out.companies.forEach(function (co) {
      co.missing.forEach(function (m) {
        if (m === 'Employer Address' || m === 'Employer Tax ID (EIN)') blocking.push(co.company_name + ': ' + m + ' is missing.');
      });
    });
    if (blocking.length) { client.release(); return res.status(400).json({ error: 'Cannot submit yet. ' + blocking.join(' ') }); }
    await client.query('BEGIN');
    await client.query('INSERT INTO parents (parent_code, parent_name) VALUES ($1, $2) ON CONFLICT (parent_code) DO NOTHING',
      [record.parent_code, record.parent_name]);
    for (const co of out.companies) {
      await client.query(
        'INSERT INTO companies (company_code, company_name, parent_company_code, parent_company_name, ein, address_1, city, state, zip, company_status) ' +
        'VALUES ($3, $4, $1, $2, $5, $6, $7, $8, $9, $10)',
        [record.parent_code, record.parent_name, co.company_code, co.company_name, co.ein, co.company_address_1, co.company_city, co.company_state, co.company_zip, co.company_status]);
    }
    await client.query('UPDATE onboarding_clients SET companies_json = $1, wizard_step = 4, payroll_provider = COALESCE(NULLIF($2, \'\'), payroll_provider) WHERE id = $3',
      [JSON.stringify(out.companies.map(function (x) { return x.company_code; })), out.payroll_provider || '', req.params.id]);
    await client.query('COMMIT');
    client.release();
    res.json({ ok: true, companies: out.companies });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    client.release();
    console.error('Process submit companies error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Step 4 Verify button.
app.post('/api/onboarding/:id/process-verify', requireOnboarder, async (req, res) => {
  try {
    const db = getPool();
    const c = await db.query('SELECT * FROM onboarding_clients WHERE id = $1', [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ error: 'Not found' });
    const out = await runProcessVerify(db, c.rows[0]);
    res.json({ ok: true, pass: out.pass, items: out.items });
  } catch (error) { console.error('Process verify error:', error); res.status(500).json({ error: 'Internal server error' }); }
});

// Step 5 Submit: open the GitHub Kanban card under Onboarding, named
// for the Parent, with a summary of the account as a comment.
app.post('/api/onboarding/:id/process-finish', requireOnboarder, async (req, res) => {
  try {
    const nl = String.fromCharCode(10);
    const db = getPool();
    const c = await db.query('SELECT * FROM onboarding_clients WHERE id = $1', [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ error: 'Not found' });
    const record = c.rows[0];
    if (record.status !== 'in_progress') return res.status(400).json({ error: 'This onboarding has already been submitted.' });
    const verify = await runProcessVerify(db, record);
    if (!verify.pass) return res.status(400).json({ error: 'Verification has not passed yet.', items: verify.items });
    if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GitHub is not connected on the server' });
    let codes = [];
    try { codes = JSON.parse(record.companies_json || '[]'); } catch (e) { codes = []; }
    const lines = [];
    lines.push('Onboarding summary for ' + (record.parent_name || record.client_name));
    lines.push('Parent Code: ' + (record.parent_code || ''));
    lines.push('Parent Name: ' + (record.parent_name || record.client_name));
    lines.push('Payroll provider: ' + (record.payroll_provider || 'TBD'));
    lines.push('');
    lines.push('Companies created (' + codes.length + '):');
    for (const code of codes) {
      const co = await db.query('SELECT company_name, ein FROM companies WHERE company_code = $1', [code]);
      const name = co.rows.length ? co.rows[0].company_name : '';
      const ein = co.rows.length ? (co.rows[0].ein || '') : '';
      lines.push('- ' + code + ' - ' + name + (ein ? ' (EIN ' + ein + ')' : '') + ' - status PENDING');
      const cm = await db.query('SELECT steward_code, pct FROM commissions WHERE company_code = $1 ORDER BY steward_code', [code]);
      cm.rows.forEach(function (x) { lines.push('    Steward ' + x.steward_code + ': ' + x.pct + '%'); });
    }
    const summary = lines.join(nl);
    const title = (record.parent_name || record.client_name) + '; ' + (record.payroll_provider || 'TBD') + '; Onboarding';
    const issue = await ghCreateIssue(title, summary);
    let commentOk = false, boardOk = false, boardError = '';
    try { await postIssueComment(GITHUB_ISSUES_OWNER + '/' + GITHUB_ISSUES_REPO, issue.number, summary); commentOk = true; }
    catch (e) { console.error('Summary comment failed:', e.message); }
    try { await ghBoardAddCard(issue.node_id, 'Onboarding (IHIA)'); boardOk = true; }
    catch (e) { boardError = e.message; console.error('Board add failed:', e.message); }
    await db.query("UPDATE onboarding_clients SET status = 'complete', wizard_step = 5, initiated_at = NOW(), github_issue_number = $1, github_repo = $2 WHERE id = $3",
      [issue.number, GITHUB_ISSUES_OWNER + '/' + GITHUB_ISSUES_REPO, req.params.id]);
    res.json({ ok: true, issueNumber: issue.number, issueUrl: issue.html_url, boardOk: boardOk, boardError: boardError, commentOk: commentOk });
  } catch (error) { console.error('Process finish error:', error); res.status(500).json({ error: error.message || 'Internal server error' }); }
});

// ---------------------------------------------------------------- blank forms library
// The Forms tab stores blank forms (e.g. the Soluta Billing Intake Form)
// used to generate client paperwork. Visible to top_dog and admin;
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

    // One form per payroll frequency: an EIN goes on every form whose
    // frequency it pays. EINs with no detectable frequency go on all forms.
    const firstEin = eins[0] || {};
    const einModesList = eins.map(function (e) { return einModes(e, firstEin); });
    let modes = [];
    einModesList.forEach(function (ms) { ms.forEach(function (m) { if (modes.indexOf(m) === -1) modes.push(m); }); });
    const only = req.body && req.body.billingMode ? String(req.body.billingMode) : 'auto';
    if (only !== 'auto' && SOLUTA_PERIODS[only]) modes = [only];
    if (modes.length === 0) modes = [(only !== 'auto' && SOLUTA_PERIODS[only]) ? only : 'Semi-monthly'];

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
    const groupName = comm.groupName || (eins[0] && eins[0].legalName) || c.rows[0].client_name || '';

    await db.query("DELETE FROM onboarding_documents WHERE client_id = $1 AND doc_type = 'soluta_billing_intake'", [req.params.id]);
    const files = [];
    for (const mode of modes) {
      const pepm = solutaPepm(comm, mode);
      const locs = [];
      eins.forEach(function (e, i) {
        const ms = einModesList[i];
        if (ms.length !== 0 && ms.indexOf(mode) === -1) return;
        locs.push({
          name: e.legalName || '', ein: e.taxId || '',
          groupId: matchCompanyCode(coRes.rows, e.legalName), notes: e.address || ''
        });
      });
      const data = {
        groupName: groupName,
        locations: locs,
        primary: { name: first(eins.map(function (e) { return e.signerName; })), email: first(eins.map(function (e) { return e.signerEmail; })) },
        billing: { name: first(eins.map(function (e) { return e.billingContact; })), email: first(eins.map(function (e) { return e.billingEmail; })) },
        brokerProducer: { name: comm.agents[0] ? comm.agents[0].name : '' },
        agencyAmt: pepm.agencyAmt,
        agents: comm.agents.map(function (a) { return { name: a.name, taxId: w9ByName(a.name), amount: pepm.money(a.pct) }; }),
        mode: mode
      };
      const filled = fillSolutaDocx(fr.rows[0].file_data, data);
      const safeGroup = groupName.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Client';
      const now = new Date();
      const fileName = safeGroup + '_' + mode.replace(/-/g, '') + '_Billing_Intake_Form_' + (now.getMonth() + 1) + '.' + now.getDate() + '.' + now.getFullYear() + '.docx';
      const ins = await db.query(
        "INSERT INTO onboarding_documents (client_id, doc_type, file_name, mime_type, file_data, uploaded_by) VALUES ($1, 'soluta_billing_intake', $2, $3, $4, $5) RETURNING id",
        [req.params.id, fileName,
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         filled, req.user.id]);
      files.push({ docId: ins.rows[0].id, fileName: fileName, mode: mode, locations: locs.length });
    }
    res.json({ ok: true, files: files });
  } catch (error) { console.error('Soluta generate error:', error); res.status(500).json({ error: error.message || 'Internal server error' }); }
});

// ---------------------------------------------------------------- nightly key updates (Sun-Thu nights + on demand)
// Nightly key update for one implementation: looks at the day's messages and
// extracts ONLY meaningful milestones, completed key tasks, and newly
// identified obstacles. Returns 'NONE' when nothing worth noting happened.
async function claudeUpdate(db, impl, company, dayMessages, timeline) {
  const nl = String.fromCharCode(10);
  const msgText = dayMessages.map(m => '- ' + (m.author_name || 'unknown') + ' (' + (m.when || '') + '): ' + String(m.body || '').slice(0, 500)).join(nl);
  let tlText = 'No timeline yet (the project has not entered Initiation).';
  if (timeline && timeline.started) {
    tlText = 'Week ' + timeline.weekElapsed + ' of ' + TOTAL_TIMELINE_WEEKS + '. Current stage: ' + timeline.currentStage +
      '. Expected stage now: ' + timeline.expectedStage + '. Expected go-live: ' + timeline.goLiveDate + '. ' +
      (timeline.daysBehind > 0
        ? 'The project is ' + timeline.daysBehind + ' days behind the plan.'
        : 'The project is on the planned pace.');
  }
  const prompt = 'You are a project manager writing a brief daily progress note for the project owner. ' +
    'Project: ' + company.company_name + ' (company code ' + company.company_code + '). ' +
    'Current stage: ' + (impl.stage || 'unknown') + '. ' + tlText + nl +
    "Today's messages (oldest first):" + nl + msgText + nl + nl +
    'List ONLY meaningful milestones, progress, completed key tasks, or newly identified obstacles from these messages. ' +
    'Do NOT recap the entire project and do NOT restate background. If a key task was completed, say what was done. ' +
    'If a new obstacle was identified, say what it is. ' +
    'If nothing meaningful happened, reply with exactly: NONE' + nl + nl +
    'Otherwise write in EXACTLY this format:' + nl +
    'STATUS: RED, YELLOW, or GREEN (your judgment: RED = blocked or seriously off track, YELLOW = at risk or stalled, GREEN = on track)' + nl +
    'UPDATES:' + nl +
    '- one bullet per meaningful milestone, completed task, or new obstacle (one line each)' + nl +
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
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!resp.ok) throw new Error('Anthropic API returned ' + resp.status);
  const data = await resp.json();
  const parts = (data.content || []).filter(p => p.type === 'text').map(p => p.text);
  return parts.join(nl).trim();
}

// Nightly job (Sun-Thu): for each active implementation, look at messages
// since the last recorded update. If there was activity (excluding private
// @-mention messages), ask Claude for the day's meaningful milestones and
// store one update row. Quiet days store nothing.
async function runUpdates() {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  try {
    const db = getPool();
    const filters = await privateFilters(db);
    const impls = await db.query(
      'SELECT i.*, c.company_name, c.company_code ' +
      'FROM implementations i JOIN companies c ON c.id = i.company_id ' +
      "WHERE COALESCE(i.stage, '') <> 'Complete' ORDER BY i.id");
    const today = new Date().toISOString().slice(0, 10);
    let done = 0;
    let quiet = 0;
    const errors = [];
    for (const impl of impls.rows) {
      try {
        const last = await db.query(
          'SELECT MAX(created_at) AS last_at FROM implementation_updates WHERE implementation_id = $1',
          [impl.id]);
        const since = (last.rows[0] && last.rows[0].last_at)
          ? new Date(last.rows[0].last_at).toISOString()
          : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const msgs = await db.query(
          'SELECT author_name, body, COALESCE(github_created_at, created_at) AS when FROM messages ' +
          'WHERE implementation_id = $1 AND COALESCE(github_created_at, created_at) > $2 ' +
          'ORDER BY COALESCE(github_created_at, created_at)',
          [impl.id, since]);
        const visible = withoutPrivateMessages(msgs.rows, filters);
        if (visible.length === 0) { quiet++; continue; }
        const timeline = await buildTimeline(db, impl.id);
        const body = await claudeUpdate(db, impl, impl, visible, timeline);
        if (!body || /^none\b/i.test(body.trim())) { quiet++; continue; }
        await db.query(
          'INSERT INTO implementation_updates (implementation_id, update_date, body) VALUES ($1, $2, $3) ' +
          'ON CONFLICT (implementation_id, update_date) DO UPDATE SET body = EXCLUDED.body',
          [impl.id, today, body]);
        done++;
      } catch (e) {
        errors.push('impl ' + impl.id + ': ' + e.message);
      }
    }
    return { success: true, updated: done, quiet: quiet, of: impls.rows.length, errors: errors };
  } catch (error) {
    console.error('Updates error:', error);
    throw error;
  }
}

app.post('/api/admin/run-updates', async (req, res) => {
  if (!checkSyncSecret(req, res)) return;
  try {
    res.json(await runUpdates());
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Same updates, triggered by a signed-in admin from the Jobs page (JWT, no secret needed).
app.post('/api/admin/run-updates-now', requireAdmin, async (req, res) => {
  try {
    res.json(await runUpdates());
  } catch (error) {
    console.error('Updates error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------- private message filters (admin)
// GET all, POST new, PUT edit, DELETE remove. Any message containing
// @github_username is hidden from the app, updates, and weekly emails.
app.get('/api/admin/private-filters', requireAdmin, async (req, res) => {
  try {
    res.json(await privateFilters(getPool()));
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.post('/api/admin/private-filters', requireAdmin, async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    const username = String((req.body && req.body.github_username) || '').trim().replace(/^@/, '');
    if (!name || !username) return res.status(400).json({ error: 'Name and GitHub username are required' });
    const r = await getPool().query(
      'INSERT INTO private_message_filters (name, github_username) VALUES ($1, $2) ' +
      'ON CONFLICT (github_username) DO UPDATE SET name = EXCLUDED.name RETURNING *',
      [name, username]);
    res.status(201).json({ success: true, filter: r.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.put('/api/admin/private-filters/:id', requireAdmin, async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    const username = String((req.body && req.body.github_username) || '').trim().replace(/^@/, '');
    if (!name || !username) return res.status(400).json({ error: 'Name and GitHub username are required' });
    const r = await getPool().query(
      'UPDATE private_message_filters SET name = $1, github_username = $2 WHERE id = $3 RETURNING *',
      [name, username, req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, filter: r.rows[0] });
  } catch (error) {
    if (error && error.code === '23505') return res.status(400).json({ error: 'That GitHub username is already on the list' });
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.delete('/api/admin/private-filters/:id', requireAdmin, async (req, res) => {
  try {
    await getPool().query('DELETE FROM private_message_filters WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------- site header logo (admin)
// Single uploaded image served at GET /api/logo (public; the header <img>
// falls back to the built-in logo.webp when nothing is uploaded).
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.get('/api/logo', async (req, res) => {
  try {
    const r = await getPool().query('SELECT mime_type, data FROM site_logo WHERE id = 1');
    if (r.rows.length === 0) return res.status(404).end();
    res.set('Content-Type', r.rows[0].mime_type);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(r.rows[0].data);
  } catch (error) {
    res.status(500).end();
  }
});
app.post('/api/admin/logo', requireAdmin, function (req, res, next) {
  logoUpload.single('logo')(req, res, function (err) {
    if (err) return res.status(400).json({ error: 'Upload failed: ' + err.message });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose an image file first' });
    const okTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
    if (okTypes.indexOf(req.file.mimetype) === -1) {
      return res.status(400).json({ error: 'Only PNG, JPG, GIF, WebP, or SVG images' });
    }
    await getPool().query(
      'INSERT INTO site_logo (id, file_name, mime_type, data) VALUES (1, $1, $2, $3) ' +
      'ON CONFLICT (id) DO UPDATE SET file_name = EXCLUDED.file_name, mime_type = EXCLUDED.mime_type, ' +
      'data = EXCLUDED.data, uploaded_at = NOW()',
      [req.file.originalname, req.file.mimetype, req.file.buffer]);
    res.json({ success: true });
  } catch (error) {
    console.error('Logo upload error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.delete('/api/admin/logo', requireAdmin, async (req, res) => {
  try {
    await getPool().query('DELETE FROM site_logo WHERE id = 1');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
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
