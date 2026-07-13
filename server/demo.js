import crypto from 'node:crypto';
import db from './db.js';
import { categorize } from './categorizer.js';

// Deterministic PRNG so demo data is stable across reseeds.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_ACCOUNTS = [
  {
    id: 'demo-amex-gold',
    name: 'Amex Gold Card',
    official_name: 'American Express Gold Card',
    institution: 'American Express',
    type: 'credit', subtype: 'credit card', mask: '1005',
    balance_current: 1834.22, balance_available: null, balance_limit: 15000,
  },
  {
    id: 'demo-fh-checking',
    name: 'First Horizon Checking',
    official_name: 'First Horizon Bank Checking',
    institution: 'First Horizon Bank',
    type: 'depository', subtype: 'checking', mask: '4417',
    balance_current: 6412.87, balance_available: 6298.11, balance_limit: null,
  },
];

// [merchant, min$, max$, monthly frequency, account, optional fixed day-of-month]
const SPEND_PATTERNS = [
  ['Whole Foods Market', 45, 160, 4, 'demo-amex-gold'],
  ['Trader Joe\'s', 30, 90, 3, 'demo-amex-gold'],
  ['Kroger', 40, 130, 2, 'demo-amex-gold'],
  ['Starbucks', 5, 14, 9, 'demo-amex-gold'],
  ['Chipotle Mexican Grill', 11, 26, 4, 'demo-amex-gold'],
  ['DoorDash', 22, 58, 3, 'demo-amex-gold'],
  ['Chick-fil-A', 9, 22, 3, 'demo-amex-gold'],
  ['Local Bistro', 40, 120, 2, 'demo-amex-gold'],
  ['Amazon.com', 15, 140, 5, 'demo-amex-gold'],
  ['Target', 25, 110, 2, 'demo-amex-gold'],
  ['Best Buy', 40, 300, 0.4, 'demo-amex-gold'],
  ['Uber Trip', 9, 34, 4, 'demo-amex-gold'],
  ['Shell Oil', 32, 62, 3, 'demo-fh-checking'],
  ['Netflix.com', 15.49, 15.49, 1, 'demo-amex-gold', 3],
  ['Spotify USA', 11.99, 11.99, 1, 'demo-amex-gold', 7],
  ['AMC Theatres', 14, 45, 1, 'demo-amex-gold'],
  ['Ticketmaster', 60, 220, 0.3, 'demo-amex-gold'],
  ['CVS Pharmacy', 8, 45, 2, 'demo-amex-gold'],
  ['Summit Fitness Gym', 39, 39, 1, 'demo-fh-checking', 5],
  ['Delta Air Lines', 180, 520, 0.25, 'demo-amex-gold'],
  ['Airbnb', 220, 640, 0.2, 'demo-amex-gold'],
  ['Marriott Hotels', 150, 420, 0.15, 'demo-amex-gold'],
  ['Comcast Xfinity', 89.99, 89.99, 1, 'demo-fh-checking', 12],
  ['Verizon Wireless', 92.4, 92.4, 1, 'demo-fh-checking', 16],
  ['Duke Energy Electric', 95, 210, 1, 'demo-fh-checking', 20],
  ['Oakwood Apartments Rent', 1650, 1650, 1, 'demo-fh-checking', 1],
  ['State Farm Insurance', 148.5, 148.5, 1, 'demo-fh-checking', 22],
];

const INCOME_PATTERNS = [
  // Paychecks on the 1st and 15th.
  ['ACME Corp Payroll Direct Dep', 2740, 2740, 'demo-fh-checking', [1, 15]],
];

export function seedDemoData({ months = 6 } = {}) {
  clearDemoData();
  const rand = mulberry32(20260713);

  const insAcc = db.prepare(`INSERT OR REPLACE INTO accounts
    (id, item_id, name, official_name, institution, type, subtype, mask, balance_current, balance_available, balance_limit, currency, is_demo)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', 1)`);
  for (const a of DEMO_ACCOUNTS) {
    insAcc.run(a.id, a.name, a.official_name, a.institution, a.type, a.subtype, a.mask,
      a.balance_current, a.balance_available, a.balance_limit);
  }

  const insTxn = db.prepare(`INSERT INTO transactions
    (id, account_id, date, name, merchant_name, amount, category, category_source, plaid_category, pending, is_demo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 1)`);

  const today = new Date();
  const rows = [];
  for (let m = 0; m < months; m++) {
    const monthDate = new Date(today.getFullYear(), today.getMonth() - m, 1);
    const daysInMonth = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate();
    const isCurrentMonth = m === 0;
    const lastDay = isCurrentMonth ? today.getDate() : daysInMonth;

    for (const [merchant, min, max, freq, account, fixedDay] of SPEND_PATTERNS) {
      // Fractional frequencies become a probability of appearing this month.
      let count = Math.floor(freq);
      if (rand() < freq - count) count++;
      for (let i = 0; i < count; i++) {
        const day = fixedDay || 1 + Math.floor(rand() * daysInMonth);
        if (day > lastDay) continue;
        const amount = Math.round((min + rand() * (max - min)) * 100) / 100;
        const date = fmtDate(monthDate.getFullYear(), monthDate.getMonth(), day);
        rows.push({ account, date, name: merchant, amount });
      }
    }
    for (const [name, min, max, account, days] of INCOME_PATTERNS) {
      for (const day of days) {
        if (day > lastDay) continue;
        const amount = -(min + rand() * (max - min));
        const date = fmtDate(monthDate.getFullYear(), monthDate.getMonth(), day);
        rows.push({ account, date, name, amount: Math.round(amount * 100) / 100 });
      }
    }
  }

  const run = db.transaction(() => {
    for (const r of rows) {
      const { category, source } = categorize({ name: r.name, merchant_name: r.name, amount: r.amount, plaidPrimary: null });
      insTxn.run(`demo-${crypto.randomUUID()}`, r.account, r.date, r.name, r.name, r.amount, category, source);
    }
    // Starter budgets, only if the user hasn't set any yet.
    const hasBudgets = db.prepare('SELECT COUNT(*) c FROM budgets').get().c > 0;
    if (!hasBudgets) {
      const ins = db.prepare('INSERT OR REPLACE INTO budgets (category, monthly_limit) VALUES (?, ?)');
      ins.run('Groceries', 600); ins.run('Food & Dining', 350); ins.run('Shopping', 400);
      ins.run('Transportation', 250); ins.run('Bills & Utilities', 2300);
      ins.run('Entertainment', 150); ins.run('Health & Wellness', 120); ins.run('Travel', 300);
    }
  });
  run();
  return rows.length;
}

export function clearDemoData() {
  db.prepare('DELETE FROM transactions WHERE is_demo = 1').run();
  db.prepare('DELETE FROM accounts WHERE is_demo = 1').run();
}

function fmtDate(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
