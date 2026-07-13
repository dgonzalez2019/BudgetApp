import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR lets cloud hosts point the database at a persistent volume.
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'budget.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  institution_name TEXT,
  cursor TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  item_id TEXT,
  name TEXT NOT NULL,
  official_name TEXT,
  institution TEXT,
  type TEXT,
  subtype TEXT,
  mask TEXT,
  balance_current REAL,
  balance_available REAL,
  balance_limit REAL,
  currency TEXT DEFAULT 'USD',
  is_demo INTEGER DEFAULT 0,
  FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  merchant_name TEXT,
  amount REAL NOT NULL,            -- positive = money out (spend), negative = money in
  category TEXT NOT NULL DEFAULT 'Other',
  category_source TEXT DEFAULT 'auto',  -- auto | rule | manual
  plaid_category TEXT,
  pending INTEGER DEFAULT 0,
  is_demo INTEGER DEFAULT 0,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_txn_account ON transactions(account_id);

CREATE TABLE IF NOT EXISTS budgets (
  category TEXT PRIMARY KEY,
  monthly_limit REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  name TEXT PRIMARY KEY,
  icon TEXT DEFAULT '🏷️',
  color TEXT,                      -- NULL for built-ins (they use theme CSS slots)
  is_builtin INTEGER DEFAULT 0,
  position INTEGER,
  excluded INTEGER DEFAULT 0       -- 1 = not counted as spending (reimbursements, card payments)
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// migrate databases created before the excluded flag existed
try { db.exec('ALTER TABLE categories ADD COLUMN excluded INTEGER DEFAULT 0'); } catch { /* column exists */ }

export default db;
