import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import { getCategories, categoryNames, isCategory, recategorizeAuto } from './categorizer.js';
import { seedDemoData, clearDemoData } from './demo.js';
import * as plaid from './plaid.js';
import { authGuard, registerAuthRoutes, authEnabled } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1); // secure cookies behind cloud HTTPS proxies
app.use(express.json());

app.get('/healthz', (req, res) => res.json({ ok: true }));
registerAuthRoutes(app, path.join(__dirname, '..', 'public', 'login.html'));
app.use(authGuard);
app.use(express.static(path.join(__dirname, '..', 'public')));

const asyncRoute = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err?.response?.data || err);
  res.status(500).json({ error: err?.response?.data?.error_message || err.message });
});

// ---------- status ----------
app.get('/api/status', (req, res) => {
  const txnCount = db.prepare('SELECT COUNT(*) c FROM transactions').get().c;
  const accountCount = db.prepare('SELECT COUNT(*) c FROM accounts').get().c;
  res.json({
    plaidConfigured: plaid.plaidConfigured(),
    plaidEnv: process.env.PLAID_ENV || 'sandbox',
    authEnabled: authEnabled(),
    transactions: txnCount,
    accounts: accountCount,
    categories: categoryNames(),
    categoryMeta: getCategories(),
  });
});

// ---------- overview / analytics ----------
app.get('/api/overview', (req, res) => {
  const { start, end } = rangeParams(req);

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN amount > 0 AND category NOT IN ('Income', 'Transfers') THEN amount END), 0) AS spent,
      COALESCE(-SUM(CASE WHEN category = 'Income' THEN amount END), 0) AS income,
      COUNT(*) AS count
    FROM transactions WHERE date >= ? AND date <= ?`).get(start, end);

  const byCategory = db.prepare(`
    SELECT category, SUM(amount) AS total, COUNT(*) AS count
    FROM transactions
    WHERE date >= ? AND date <= ? AND amount > 0 AND category NOT IN ('Income', 'Transfers')
    GROUP BY category ORDER BY total DESC`).all(start, end);

  // Last 6 whole months of spending vs income, independent of the selected range.
  const monthly = db.prepare(`
    SELECT substr(date, 1, 7) AS month,
      COALESCE(SUM(CASE WHEN amount > 0 AND category NOT IN ('Income', 'Transfers') THEN amount END), 0) AS spent,
      COALESCE(-SUM(CASE WHEN category = 'Income' THEN amount END), 0) AS income
    FROM transactions
    WHERE date >= date('now', 'start of month', '-5 months')
    GROUP BY month ORDER BY month`).all();

  const daily = db.prepare(`
    SELECT date, COALESCE(SUM(CASE WHEN amount > 0 AND category NOT IN ('Income', 'Transfers') THEN amount END), 0) AS spent
    FROM transactions WHERE date >= ? AND date <= ?
    GROUP BY date ORDER BY date`).all(start, end);

  const topMerchants = db.prepare(`
    SELECT COALESCE(merchant_name, name) AS merchant, SUM(amount) AS total, COUNT(*) AS count
    FROM transactions
    WHERE date >= ? AND date <= ? AND amount > 0 AND category NOT IN ('Income', 'Transfers')
    GROUP BY merchant ORDER BY total DESC LIMIT 6`).all(start, end);

  // Rolling-month pace: the past month vs the month before it.
  const now = new Date();
  const spentBetween = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN amount > 0 AND category NOT IN ('Income', 'Transfers') THEN amount END), 0) AS s
    FROM transactions WHERE date >= ? AND date <= ?`);
  const shift = (months, days = 0) => new Date(now.getFullYear(), now.getMonth() + months, now.getDate() + days);
  const monthToDate = {
    spent: spentBetween.get(iso(shift(-1, 1)), iso(now)).s,
    prevSpent: spentBetween.get(iso(shift(-2, 1)), iso(shift(-1))).s,
  };

  // Calendar pace: the 1st through today vs the 1st through this day last month.
  const prevMonthDays = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
  const calendarMtd = {
    spent: spentBetween.get(iso(new Date(now.getFullYear(), now.getMonth(), 1)), iso(now)).s,
    prevSpent: spentBetween.get(
      iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      iso(new Date(now.getFullYear(), now.getMonth() - 1, Math.min(now.getDate(), prevMonthDays)))).s,
  };

  res.json({ start, end, totals, byCategory, monthly, daily, topMerchants, monthToDate, calendarMtd });
});

// ---------- transactions ----------
app.get('/api/transactions', (req, res) => {
  const { start, end } = rangeParams(req);
  const { category, account, q } = req.query;
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;

  const where = ['t.date >= ?', 't.date <= ?'];
  const params = [start, end];
  if (category) { where.push('t.category = ?'); params.push(category); }
  if (account) { where.push('t.account_id = ?'); params.push(account); }
  if (q) { where.push('(t.name LIKE ? OR t.merchant_name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }

  const sql = `FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) c ${sql}`).get(...params).c;
  const rows = db.prepare(`
    SELECT t.*, a.name AS account_name, a.institution, a.mask
    ${sql} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);

  res.json({ total, transactions: rows });
});

// Manual entries: for movements banks don't report (CD deposits, cash, …).
app.post('/api/transactions', (req, res) => {
  const { account_id, date, name, amount, category } = req.body || {};
  if (!db.prepare('SELECT id FROM accounts WHERE id = ?').get(account_id)) {
    return res.status(400).json({ error: 'Unknown account' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'Invalid date' });
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt === 0) return res.status(400).json({ error: 'Invalid amount' });
  const desc = String(name || '').trim();
  if (!desc) return res.status(400).json({ error: 'Description required' });
  if (!isCategory(category)) return res.status(400).json({ error: 'Unknown category' });

  const id = `manual-${crypto.randomUUID()}`;
  db.prepare(`INSERT INTO transactions
    (id, account_id, date, name, merchant_name, amount, category, category_source, plaid_category, pending, is_demo)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', NULL, 0, 0)`)
    .run(id, account_id, date, desc, desc, amt, category);
  res.json({ ok: true, id });
});

// Only manual entries are deletable — synced data is the bank's record.
app.delete('/api/transactions/:id', (req, res) => {
  if (!req.params.id.startsWith('manual-')) {
    return res.status(400).json({ error: 'Only manually added transactions can be deleted' });
  }
  db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.patch('/api/transactions/:id', (req, res) => {
  const { category, applyToSimilar } = req.body;
  if (!isCategory(category)) return res.status(400).json({ error: 'Unknown category' });

  const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!txn) return res.status(404).json({ error: 'Not found' });

  db.prepare("UPDATE transactions SET category = ?, category_source = 'manual' WHERE id = ?")
    .run(category, req.params.id);

  let similar = 0;
  if (applyToSimilar) {
    const keyword = (txn.merchant_name || txn.name).trim();
    db.prepare('INSERT INTO rules (keyword, category) VALUES (?, ?)').run(keyword, category);
    const result = db.prepare(`
      UPDATE transactions SET category = ?, category_source = 'rule'
      WHERE id != ? AND category_source != 'manual'
        AND (merchant_name LIKE ? OR name LIKE ?)`)
      .run(category, req.params.id, `%${keyword}%`, `%${keyword}%`);
    similar = result.changes;
  }
  res.json({ ok: true, similar });
});

// ---------- budgets ----------
app.get('/api/budgets', (req, res) => {
  const budgets = db.prepare('SELECT * FROM budgets').all();
  const monthStart = new Date().toISOString().slice(0, 8) + '01';
  const spent = db.prepare(`
    SELECT category, SUM(amount) AS total FROM transactions
    WHERE date >= ? AND amount > 0 AND category NOT IN ('Income', 'Transfers')
    GROUP BY category`).all(monthStart);
  const spentMap = Object.fromEntries(spent.map((s) => [s.category, s.total]));
  res.json({
    budgets: budgets.map((b) => ({ ...b, spent: spentMap[b.category] || 0 })),
    unbudgetedSpend: spent.filter((s) => !budgets.some((b) => b.category === s.category)),
  });
});

app.put('/api/budgets/:category', (req, res) => {
  const category = req.params.category;
  if (!isCategory(category)) return res.status(400).json({ error: 'Unknown category' });
  const limit = Number(req.body.monthly_limit);
  if (!Number.isFinite(limit) || limit < 0) return res.status(400).json({ error: 'Invalid limit' });
  if (limit === 0) db.prepare('DELETE FROM budgets WHERE category = ?').run(category);
  else db.prepare('INSERT OR REPLACE INTO budgets (category, monthly_limit) VALUES (?, ?)').run(category, limit);
  res.json({ ok: true });
});

// ---------- accounts ----------
app.get('/api/accounts', (req, res) => {
  const accounts = db.prepare(`
    SELECT a.*, i.institution_name,
      (SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id) AS txn_count,
      (SELECT MAX(date) FROM transactions t WHERE t.account_id = a.id) AS last_txn
    FROM accounts a LEFT JOIN items i ON i.id = a.item_id
    ORDER BY a.is_demo, a.institution`).all();
  // Never expose access tokens to the client.
  res.json({ accounts });
});

// ---------- categories ----------
// Colors for custom categories: mid-lightness hues distinct from the built-in
// theme slots, readable on both light and dark surfaces.
const CUSTOM_COLORS = ['#12908e', '#a3663a', '#6b8f1f', '#64748b', '#c2445f', '#7d3ac1'];

app.get('/api/categories', (req, res) => {
  res.json({ categories: getCategories() });
});

app.post('/api/categories', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const icon = String(req.body?.icon || '').trim().slice(0, 8) || '🏷️';
  if (name.length < 1 || name.length > 30) return res.status(400).json({ error: 'Name must be 1–30 characters' });
  if (db.prepare('SELECT 1 FROM categories WHERE lower(name) = lower(?)').get(name)) {
    return res.status(400).json({ error: 'That category already exists' });
  }
  const customCount = db.prepare('SELECT COUNT(*) c FROM categories WHERE is_builtin = 0').get().c;
  const color = CUSTOM_COLORS[customCount % CUSTOM_COLORS.length];
  db.prepare('INSERT INTO categories (name, icon, color, is_builtin, position) VALUES (?, ?, ?, 0, ?)')
    .run(name, icon, color, 10 + customCount);
  res.json({ ok: true, name, icon, color });
});

app.delete('/api/categories/:name', (req, res) => {
  const cat = db.prepare('SELECT * FROM categories WHERE name = ?').get(req.params.name);
  if (!cat) return res.status(404).json({ error: 'Not found' });
  if (cat.is_builtin) return res.status(400).json({ error: 'Built-in categories cannot be deleted' });
  db.prepare("UPDATE transactions SET category = 'Other', category_source = 'auto' WHERE category = ?").run(cat.name);
  db.prepare('DELETE FROM budgets WHERE category = ?').run(cat.name);
  db.prepare('DELETE FROM rules WHERE category = ?').run(cat.name);
  db.prepare('DELETE FROM categories WHERE name = ?').run(cat.name);
  recategorizeAuto(); // re-derive the orphaned transactions from Plaid data + remaining rules
  res.json({ ok: true });
});

// ---------- rules ----------
app.get('/api/rules', (req, res) => {
  res.json({ rules: db.prepare('SELECT * FROM rules ORDER BY created_at DESC').all() });
});
app.delete('/api/rules/:id', (req, res) => {
  db.prepare('DELETE FROM rules WHERE id = ?').run(req.params.id);
  recategorizeAuto();
  res.json({ ok: true });
});

// ---------- demo data ----------
app.post('/api/demo/seed', (req, res) => {
  const count = seedDemoData({ months: 6 });
  res.json({ ok: true, transactions: count });
});
app.post('/api/demo/clear', (req, res) => {
  clearDemoData();
  res.json({ ok: true });
});

// ---------- Plaid (bank sync) ----------
app.post('/api/plaid/link_token', asyncRoute(async (req, res) => {
  if (!plaid.plaidConfigured()) return res.status(400).json({ error: 'Plaid is not configured. Add PLAID_CLIENT_ID and PLAID_SECRET to your .env file.' });
  res.json({ link_token: await plaid.createLinkToken() });
}));

app.post('/api/plaid/exchange', asyncRoute(async (req, res) => {
  const { public_token, institution_name } = req.body;
  if (!public_token) return res.status(400).json({ error: 'public_token required' });
  res.json(await plaid.exchangePublicToken(public_token, institution_name));
}));

app.post('/api/plaid/sync', asyncRoute(async (req, res) => {
  if (!plaid.plaidConfigured()) return res.status(400).json({ error: 'Plaid is not configured.' });
  res.json(await plaid.syncAll());
}));

app.delete('/api/items/:id', (req, res) => {
  plaid.removeItem(req.params.id);
  res.json({ ok: true });
});

// Re-derive categories for non-manual transactions so mapping improvements
// (e.g. the Transfers category) apply to already-synced data.
try {
  const n = recategorizeAuto();
  if (n > 0) console.log(`  Recategorized ${n} transactions with current rules`);
} catch (err) {
  console.error('Startup recategorization failed:', err.message);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  BudgetApp running at http://localhost:${PORT}`);
  console.log(`  Plaid: ${plaid.plaidConfigured() ? `configured (${process.env.PLAID_ENV || 'sandbox'})` : 'not configured — demo mode available'}`);
  console.log(`  Auth: ${authEnabled() ? 'password required' : 'open (local mode — set APP_PASSWORD before hosting publicly)'}\n`);
});

function rangeParams(req) {
  const now = new Date();
  const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || '') ? req.query.start : iso(defaultStart);
  const end = /^\d{4}-\d{2}-\d{2}$/.test(req.query.end || '') ? req.query.end : iso(now);
  return { start, end };
}
function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
