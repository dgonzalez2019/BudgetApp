import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import { CATEGORIES, recategorizeAuto } from './categorizer.js';
import { seedDemoData, clearDemoData } from './demo.js';
import * as plaid from './plaid.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
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
    transactions: txnCount,
    accounts: accountCount,
    categories: CATEGORIES,
  });
});

// ---------- overview / analytics ----------
app.get('/api/overview', (req, res) => {
  const { start, end } = rangeParams(req);

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN amount > 0 AND category != 'Income' THEN amount END), 0) AS spent,
      COALESCE(-SUM(CASE WHEN category = 'Income' THEN amount END), 0) AS income,
      COUNT(*) AS count
    FROM transactions WHERE date >= ? AND date <= ?`).get(start, end);

  const byCategory = db.prepare(`
    SELECT category, SUM(amount) AS total, COUNT(*) AS count
    FROM transactions
    WHERE date >= ? AND date <= ? AND amount > 0 AND category != 'Income'
    GROUP BY category ORDER BY total DESC`).all(start, end);

  // Last 6 whole months of spending vs income, independent of the selected range.
  const monthly = db.prepare(`
    SELECT substr(date, 1, 7) AS month,
      COALESCE(SUM(CASE WHEN amount > 0 AND category != 'Income' THEN amount END), 0) AS spent,
      COALESCE(-SUM(CASE WHEN category = 'Income' THEN amount END), 0) AS income
    FROM transactions
    WHERE date >= date('now', 'start of month', '-5 months')
    GROUP BY month ORDER BY month`).all();

  const daily = db.prepare(`
    SELECT date, COALESCE(SUM(CASE WHEN amount > 0 AND category != 'Income' THEN amount END), 0) AS spent
    FROM transactions WHERE date >= ? AND date <= ?
    GROUP BY date ORDER BY date`).all(start, end);

  const topMerchants = db.prepare(`
    SELECT COALESCE(merchant_name, name) AS merchant, SUM(amount) AS total, COUNT(*) AS count
    FROM transactions
    WHERE date >= ? AND date <= ? AND amount > 0 AND category != 'Income'
    GROUP BY merchant ORDER BY total DESC LIMIT 6`).all(start, end);

  res.json({ start, end, totals, byCategory, monthly, daily, topMerchants });
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

app.patch('/api/transactions/:id', (req, res) => {
  const { category, applyToSimilar } = req.body;
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Unknown category' });

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
    WHERE date >= ? AND amount > 0 AND category != 'Income'
    GROUP BY category`).all(monthStart);
  const spentMap = Object.fromEntries(spent.map((s) => [s.category, s.total]));
  res.json({
    budgets: budgets.map((b) => ({ ...b, spent: spentMap[b.category] || 0 })),
    unbudgetedSpend: spent.filter((s) => !budgets.some((b) => b.category === s.category)),
  });
});

app.put('/api/budgets/:category', (req, res) => {
  const category = req.params.category;
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Unknown category' });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  BudgetApp running at http://localhost:${PORT}`);
  console.log(`  Plaid: ${plaid.plaidConfigured() ? `configured (${process.env.PLAID_ENV || 'sandbox'})` : 'not configured — demo mode available'}\n`);
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
