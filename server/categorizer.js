import db from './db.js';

// Built-in categories. Position is the display/chart slot order; customs sort
// after Travel (position 10+) and before Transfers/Income/Other.
const BUILTIN_CATEGORIES = [
  ['Groceries', '🛒', 1],
  ['Food & Dining', '🍜', 2],
  ['Shopping', '🛍️', 3],
  ['Transportation', '🚗', 4],
  ['Bills & Utilities', '💡', 5],
  ['Entertainment', '🎬', 6],
  ['Health & Wellness', '💊', 7],
  ['Travel', '✈️', 8],
  ['Transfers', '🔁', 90],
  ['Income', '💵', 91],
  ['Other', '📦', 92],
];
{
  const seed = db.prepare('INSERT OR IGNORE INTO categories (name, icon, color, is_builtin, position) VALUES (?, ?, NULL, 1, ?)');
  for (const [name, icon, position] of BUILTIN_CATEGORIES) seed.run(name, icon, position);
}

export function getCategories() {
  return db.prepare('SELECT name, icon, color, is_builtin, position FROM categories ORDER BY position, name').all();
}
export function categoryNames() {
  return getCategories().map((c) => c.name);
}
export function isCategory(name) {
  return Boolean(db.prepare('SELECT 1 FROM categories WHERE name = ?').get(name));
}

// Plaid personal_finance_category.primary -> app category
const PLAID_PFC_MAP = {
  FOOD_AND_DRINK: 'Food & Dining',
  GENERAL_MERCHANDISE: 'Shopping',
  TRANSPORTATION: 'Transportation',
  RENT_AND_UTILITIES: 'Bills & Utilities',
  ENTERTAINMENT: 'Entertainment',
  MEDICAL: 'Health & Wellness',
  PERSONAL_CARE: 'Health & Wellness',
  TRAVEL: 'Travel',
  INCOME: 'Income',
  TRANSFER_IN: 'Transfers',
  TRANSFER_OUT: 'Transfers',
  LOAN_PAYMENTS: 'Bills & Utilities',
  GENERAL_SERVICES: 'Bills & Utilities',
  GOVERNMENT_AND_NON_PROFIT: 'Other',
  HOME_IMPROVEMENT: 'Shopping',
  BANK_FEES: 'Bills & Utilities',
};

// Built-in merchant keyword rules, checked before Plaid's category.
const BUILTIN_RULES = [
  ['whole foods', 'Groceries'], ['trader joe', 'Groceries'], ['kroger', 'Groceries'],
  ['publix', 'Groceries'], ['aldi', 'Groceries'], ['costco', 'Groceries'],
  ['walmart', 'Groceries'], ['safeway', 'Groceries'], ['heb', 'Groceries'],
  ['food lion', 'Groceries'], ['instacart', 'Groceries'],
  ['starbucks', 'Food & Dining'], ['mcdonald', 'Food & Dining'], ['chipotle', 'Food & Dining'],
  ['chick-fil-a', 'Food & Dining'], ['doordash', 'Food & Dining'], ['uber eats', 'Food & Dining'],
  ['grubhub', 'Food & Dining'], ['dunkin', 'Food & Dining'], ['taco bell', 'Food & Dining'],
  ['wendy', 'Food & Dining'], ['panera', 'Food & Dining'], ['domino', 'Food & Dining'],
  ['bistro', 'Food & Dining'], ['restaurant', 'Food & Dining'], ['cafe', 'Food & Dining'],
  ['pizza', 'Food & Dining'], ['grill', 'Food & Dining'], ['sushi', 'Food & Dining'],
  ['amazon', 'Shopping'], ['target', 'Shopping'], ['best buy', 'Shopping'],
  ['home depot', 'Shopping'], ['lowe', 'Shopping'], ['etsy', 'Shopping'],
  ['nike', 'Shopping'], ['apple store', 'Shopping'], ['ebay', 'Shopping'],
  ['uber', 'Transportation'], ['lyft', 'Transportation'], ['shell', 'Transportation'],
  ['exxon', 'Transportation'], ['chevron', 'Transportation'], ['bp ', 'Transportation'],
  ['parking', 'Transportation'], ['tolls', 'Transportation'], ['autozone', 'Transportation'],
  ['comcast', 'Bills & Utilities'], ['xfinity', 'Bills & Utilities'], ['verizon', 'Bills & Utilities'],
  ['at&t', 'Bills & Utilities'], ['t-mobile', 'Bills & Utilities'], ['electric', 'Bills & Utilities'],
  ['water dept', 'Bills & Utilities'], ['insurance', 'Bills & Utilities'], ['rent', 'Bills & Utilities'],
  ['mortgage', 'Bills & Utilities'], ['duke energy', 'Bills & Utilities'],
  ['netflix', 'Entertainment'], ['spotify', 'Entertainment'], ['hulu', 'Entertainment'],
  ['disney', 'Entertainment'], ['hbo', 'Entertainment'], ['cinema', 'Entertainment'],
  ['amc ', 'Entertainment'], ['steam', 'Entertainment'], ['playstation', 'Entertainment'],
  ['ticketmaster', 'Entertainment'], ['youtube', 'Entertainment'],
  ['cvs', 'Health & Wellness'], ['walgreens', 'Health & Wellness'], ['pharmacy', 'Health & Wellness'],
  ['gym', 'Health & Wellness'], ['fitness', 'Health & Wellness'], ['dental', 'Health & Wellness'],
  ['clinic', 'Health & Wellness'], ['peloton', 'Health & Wellness'],
  ['airline', 'Travel'], ['delta air', 'Travel'], ['united air', 'Travel'],
  ['southwest', 'Travel'], ['airbnb', 'Travel'], ['marriott', 'Travel'],
  ['hilton', 'Travel'], ['hotel', 'Travel'], ['expedia', 'Travel'],
  // Transfers are matched via Plaid's TRANSFER_IN/TRANSFER_OUT classification only —
  // a bare "transfer" keyword over-matches real spending (wires, bill-pay descriptions, …).
  ['payroll', 'Income'], ['direct dep', 'Income'], ['deposit', 'Income'],
];

/**
 * Decide a category for a transaction.
 * Priority: user rules > built-in keyword rules > Plaid category > sign heuristic.
 */
export function categorize({ name, merchant_name, amount, plaidPrimary }) {
  const text = `${merchant_name || ''} ${name || ''}`.toLowerCase();

  const userRules = db.prepare('SELECT keyword, category FROM rules ORDER BY length(keyword) DESC').all();
  for (const r of userRules) {
    if (text.includes(r.keyword.toLowerCase())) return { category: r.category, source: 'rule' };
  }
  for (const [kw, cat] of BUILTIN_RULES) {
    if (text.includes(kw)) return { category: cat, source: 'auto' };
  }
  if (plaidPrimary && PLAID_PFC_MAP[plaidPrimary]) {
    return { category: PLAID_PFC_MAP[plaidPrimary], source: 'auto' };
  }
  if (amount < 0) return { category: 'Income', source: 'auto' };
  return { category: 'Other', source: 'auto' };
}

/** Re-run categorization on transactions that were not manually set. */
export function recategorizeAuto() {
  const txns = db.prepare("SELECT id, name, merchant_name, amount, plaid_category FROM transactions WHERE category_source != 'manual'").all();
  const update = db.prepare('UPDATE transactions SET category = ?, category_source = ? WHERE id = ?');
  const run = db.transaction(() => {
    for (const t of txns) {
      const { category, source } = categorize({
        name: t.name, merchant_name: t.merchant_name, amount: t.amount, plaidPrimary: t.plaid_category,
      });
      update.run(category, source, t.id);
    }
  });
  run();
  return txns.length;
}
