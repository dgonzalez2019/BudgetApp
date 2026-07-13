import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import db from './db.js';
import { categorize } from './categorizer.js';

export function plaidConfigured() {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

let client = null;
function getClient() {
  if (!plaidConfigured()) return null;
  if (!client) {
    const env = process.env.PLAID_ENV || 'sandbox';
    client = new PlaidApi(new Configuration({
      basePath: PlaidEnvironments[env],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
          'PLAID-SECRET': process.env.PLAID_SECRET,
        },
      },
    }));
  }
  return client;
}

/** Create a Link token so the browser can open Plaid Link (used to connect AMEX, First Horizon, etc.). */
export async function createLinkToken() {
  const res = await getClient().linkTokenCreate({
    user: { client_user_id: 'budgetapp-user' },
    client_name: 'BudgetApp',
    products: ['transactions'],
    country_codes: ['US'],
    language: 'en',
  });
  return res.data.link_token;
}

/** Exchange the public token from Link, store the item and its accounts. */
export async function exchangePublicToken(publicToken, institutionName) {
  const api = getClient();
  const ex = await api.itemPublicTokenExchange({ public_token: publicToken });
  const accessToken = ex.data.access_token;
  const itemId = ex.data.item_id;

  db.prepare('INSERT OR REPLACE INTO items (id, access_token, institution_name) VALUES (?, ?, ?)')
    .run(itemId, accessToken, institutionName || null);

  const acc = await api.accountsGet({ access_token: accessToken });
  const insert = db.prepare(`INSERT OR REPLACE INTO accounts
    (id, item_id, name, official_name, institution, type, subtype, mask, balance_current, balance_available, balance_limit, currency, is_demo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
  for (const a of acc.data.accounts) {
    insert.run(a.account_id, itemId, a.name, a.official_name, institutionName || null,
      a.type, a.subtype, a.mask,
      a.balances.current, a.balances.available, a.balances.limit,
      a.balances.iso_currency_code || 'USD');
  }
  const count = await syncItem(itemId);
  return { itemId, accounts: acc.data.accounts.length, transactions: count };
}

/** Pull new/updated transactions for one item via Plaid's cursor-based sync. */
export async function syncItem(itemId) {
  const api = getClient();
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  if (!item) throw new Error(`Unknown item ${itemId}`);

  let cursor = item.cursor || undefined;
  let added = 0;
  let hasMore = true;

  const upsert = db.prepare(`INSERT OR REPLACE INTO transactions
    (id, account_id, date, name, merchant_name, amount, category, category_source, plaid_category, pending, is_demo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
  const remove = db.prepare('DELETE FROM transactions WHERE id = ?');
  const manualCat = db.prepare("SELECT category, category_source FROM transactions WHERE id = ? AND category_source = 'manual'");

  while (hasMore) {
    const res = await api.transactionsSync({ access_token: item.access_token, cursor, count: 500 });
    const d = res.data;
    for (const t of [...d.added, ...d.modified]) {
      const plaidPrimary = t.personal_finance_category?.primary || null;
      // Keep a category the user set by hand, even if Plaid modifies the transaction.
      const existing = manualCat.get(t.transaction_id);
      const { category, source } = existing
        ? { category: existing.category, source: 'manual' }
        : categorize({ name: t.name, merchant_name: t.merchant_name, amount: t.amount, plaidPrimary });
      upsert.run(t.transaction_id, t.account_id, t.date, t.name, t.merchant_name || null,
        t.amount, category, source, plaidPrimary, t.pending ? 1 : 0);
      added++;
    }
    for (const r of d.removed) remove.run(r.transaction_id);
    cursor = d.next_cursor;
    hasMore = d.has_more;
  }

  db.prepare('UPDATE items SET cursor = ? WHERE id = ?').run(cursor, itemId);

  // Refresh balances on each sync.
  try {
    const acc = await api.accountsGet({ access_token: item.access_token });
    const upd = db.prepare('UPDATE accounts SET balance_current = ?, balance_available = ?, balance_limit = ? WHERE id = ?');
    for (const a of acc.data.accounts) {
      upd.run(a.balances.current, a.balances.available, a.balances.limit, a.account_id);
    }
  } catch { /* balances are best-effort */ }

  return added;
}

export async function syncAll() {
  const items = db.prepare('SELECT id FROM items').all();
  let total = 0;
  for (const it of items) total += await syncItem(it.id);
  return { items: items.length, transactions: total };
}

export function removeItem(itemId) {
  db.prepare('DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE item_id = ?)').run(itemId);
  db.prepare('DELETE FROM accounts WHERE item_id = ?').run(itemId);
  db.prepare('DELETE FROM items WHERE id = ?').run(itemId);
}
