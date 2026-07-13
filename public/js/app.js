import { renderDonut, renderMonthlyBars, renderDailyLine, fmtUSD, fmtCompact } from './charts.js';

/* ---------------- category identity (fixed slot order) ---------------- */
const CAT_META = {
  'Groceries':         { slot: 'var(--cat-1)', icon: '🛒' },
  'Food & Dining':     { slot: 'var(--cat-2)', icon: '🍜' },
  'Shopping':          { slot: 'var(--cat-3)', icon: '🛍️' },
  'Transportation':    { slot: 'var(--cat-4)', icon: '🚗' },
  'Bills & Utilities': { slot: 'var(--cat-5)', icon: '💡' },
  'Entertainment':     { slot: 'var(--cat-6)', icon: '🎬' },
  'Health & Wellness': { slot: 'var(--cat-7)', icon: '💊' },
  'Travel':            { slot: 'var(--cat-8)', icon: '✈️' },
  'Income':            { slot: 'var(--cat-income)', icon: '💵' },
  'Other':             { slot: 'var(--cat-other)', icon: '📦' },
};
const catColor = (c) => CAT_META[c]?.slot || 'var(--cat-other)';
const catIcon = (c) => CAT_META[c]?.icon || '📦';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  categories: Object.keys(CAT_META),
  range: 'this-month',
  txnFilters: { q: '', category: '', account: '', offset: 0, limit: 50 },
  txnTotal: 0,
  plaidConfigured: false,
  accounts: [],
};

/* ---------------- api ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = '/login';
    return new Promise(() => {}); // page is navigating away
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ---------------- date ranges ---------------- */
function rangeDates(key) {
  const now = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const startOfMonth = (offset = 0) => new Date(now.getFullYear(), now.getMonth() + offset, 1);
  switch (key) {
    case 'last-month': return { start: iso(startOfMonth(-1)), end: iso(new Date(now.getFullYear(), now.getMonth(), 0)) };
    case '3m': return { start: iso(startOfMonth(-2)), end: iso(now) };
    case '6m': return { start: iso(startOfMonth(-5)), end: iso(now) };
    case 'ytd': return { start: `${now.getFullYear()}-01-01`, end: iso(now) };
    default: return { start: iso(startOfMonth(0)), end: iso(now) };
  }
}
const RANGE_LABELS = {
  'this-month': 'this month', 'last-month': 'last month',
  '3m': 'the last 3 months', '6m': 'the last 6 months', 'ytd': 'this year',
};

/* ---------------- toasts ---------------- */
function toast(msg, icon = '✅') {
  const stack = $('#toast-stack');
  const node = document.createElement('div');
  node.className = 'toast';
  const i = document.createElement('span');
  i.className = 't-icon';
  i.textContent = icon;
  const text = document.createElement('span');
  text.textContent = msg;
  node.append(i, text);
  stack.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    node.addEventListener('animationend', () => node.remove(), { once: true });
  }, 3200);
}

/* ---------------- count-up animation ---------------- */
function countUp(elm, target, { cents = false } = {}) {
  const dur = 650;
  const from = Number(elm.dataset.current || 0);
  const t0 = performance.now();
  elm.dataset.current = target;
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - (1 - p) ** 3;
    elm.textContent = fmtUSD(from + (target - from) * eased, { cents });
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ---------------- navigation ---------------- */
function switchView(name) {
  $$('.nav-item').forEach((b) => {
    const active = b.dataset.view === name;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active);
  });
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'dashboard') loadDashboard();
  if (name === 'transactions') loadTransactions(true);
  if (name === 'budgets') loadBudgets();
  if (name === 'accounts') loadAccounts();
}
$$('.nav-item').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.goto)));

/* ---------------- theme ---------------- */
const savedTheme = localStorage.getItem('theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
else if (matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';
$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  loadDashboard(); // charts resolve CSS vars at render time
});

/* ================= DASHBOARD ================= */
$$('#range-filters .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    state.range = chip.dataset.range;
    $$('#range-filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
    loadDashboard();
  });
});

function resolveVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

async function loadDashboard() {
  const { start, end } = rangeDates(state.range);
  const [ov, status] = await Promise.all([
    api(`/api/overview?start=${start}&end=${end}`),
    api('/api/status'),
  ]);
  state.plaidConfigured = status.plaidConfigured;

  const isEmpty = status.transactions === 0;
  $('#dash-empty').classList.toggle('hidden', !isEmpty);
  $('#dash-content').classList.toggle('hidden', isEmpty);
  if (isEmpty) return;

  $('#dash-subtitle').textContent = `Spending ${RANGE_LABELS[state.range]} · ${ov.totals.count} transactions`;

  // stat tiles
  countUp($('#stat-spent'), ov.totals.spent);
  countUp($('#stat-income'), ov.totals.income);
  countUp($('#stat-net'), ov.totals.income - ov.totals.spent);
  const days = Math.max(1, Math.round((new Date(end) - new Date(start)) / 86400000) + 1);
  countUp($('#stat-daily'), ov.totals.spent / days, { cents: true });
  $('#stat-daily-note').textContent = `across ${days} days`;
  $('#stat-net-note').textContent = ov.totals.income - ov.totals.spent >= 0 ? 'saving money 🎉' : 'spending exceeds income';

  // vs previous period delta on Spent
  const prevSpent = comparableSpent(ov.monthly, state.range);
  const deltaEl = $('#stat-spent-delta');
  if (prevSpent != null && prevSpent > 0 && state.range === 'this-month') {
    const pct = ((ov.totals.spent - prevSpent) / prevSpent) * 100;
    deltaEl.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}% vs last month's total`;
    deltaEl.className = 'stat-delta ' + (pct > 0 ? 'up-bad' : 'down-good');
  } else {
    deltaEl.textContent = '';
    deltaEl.className = 'stat-delta';
  }

  renderDonutSection(ov.byCategory);
  renderMonthlySection(ov.monthly);
  renderDailySection(ov.daily);
  renderMerchants(ov.topMerchants);
  renderRecent(start, end);
}

function comparableSpent(monthly, range) {
  if (range !== 'this-month' || monthly.length < 2) return null;
  return monthly[monthly.length - 2]?.spent ?? null;
}

function renderDonutSection(byCategory) {
  const data = byCategory.map((c) => ({ label: c.category, value: c.total, color: catColor(c.category), count: c.count }));
  const legend = $('#donut-legend');
  renderDonut($('#donut-chart'), data, {
    onHover: (label) => {
      legend.querySelectorAll('li').forEach((li) => li.classList.toggle('hl', li.dataset.cat === label));
    },
  });
  const total = data.reduce((s, d) => s + d.value, 0);
  legend.replaceChildren();
  for (const d of data) {
    const li = document.createElement('li');
    li.dataset.cat = d.label;
    const sw = document.createElement('span');
    sw.className = 'legend-swatch';
    sw.style.background = d.color;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = d.label;
    const amt = document.createElement('span');
    amt.className = 'amt';
    amt.textContent = fmtUSD(d.value);
    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = total ? `${Math.round((d.value / total) * 100)}%` : '';
    li.append(sw, name, amt, pct);
    li.addEventListener('click', () => {
      state.txnFilters.category = d.label;
      switchView('transactions');
    });
    li.style.cursor = 'pointer';
    legend.appendChild(li);
  }
}

function renderMonthlySection(monthly) {
  const months = monthly.map((m) => m.month);
  const series = [
    { name: 'Spending', color: resolveVar('--cat-1'), values: monthly.map((m) => m.spent) },
    { name: 'Income', color: resolveVar('--cat-2'), values: monthly.map((m) => m.income) },
  ];
  renderMonthlyBars($('#monthly-chart'), months, series);
  const legend = $('#monthly-legend');
  legend.replaceChildren();
  for (const s of series) {
    const key = document.createElement('span');
    key.className = 'key';
    const sw = document.createElement('span');
    sw.className = 'legend-swatch';
    sw.style.background = s.color;
    const t = document.createElement('span');
    t.textContent = s.name;
    key.append(sw, t);
    legend.appendChild(key);
  }
}

function renderDailySection(daily) {
  // fill missing days with zero so the line doesn't lie about gaps
  if (daily.length === 0) { renderDailyLine($('#daily-chart'), []); return; }
  const points = [];
  const start = new Date(daily[0].date + 'T12:00');
  const end = new Date(daily[daily.length - 1].date + 'T12:00');
  const byDate = Object.fromEntries(daily.map((d) => [d.date, d.spent]));
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    points.push({ date: key, value: byDate[key] || 0 });
  }
  renderDailyLine($('#daily-chart'), points, { color: resolveVar('--cat-1'), label: 'Spent' });
}

function renderMerchants(merchants) {
  const list = $('#top-merchants');
  list.replaceChildren();
  const max = merchants[0]?.total || 1;
  merchants.forEach((m, i) => {
    const li = document.createElement('li');
    const rank = document.createElement('span');
    rank.className = 'merchant-rank';
    rank.textContent = i + 1;
    const mid = document.createElement('div');
    mid.className = 'merchant-name';
    const nm = document.createElement('div');
    nm.textContent = m.merchant;
    const meta = document.createElement('div');
    meta.className = 'merchant-meta';
    meta.textContent = `${m.count} transaction${m.count === 1 ? '' : 's'}`;
    const bar = document.createElement('div');
    bar.className = 'merchant-bar';
    const fill = document.createElement('span');
    fill.style.width = `${(m.total / max) * 100}%`;
    bar.appendChild(fill);
    mid.append(nm, meta, bar);
    const amt = document.createElement('span');
    amt.className = 'merchant-amt';
    amt.textContent = fmtUSD(m.total);
    li.append(rank, mid, amt);
    list.appendChild(li);
  });
}

async function renderRecent(start, end) {
  const { transactions } = await api(`/api/transactions?start=${start}&end=${end}&limit=8`);
  const wrap = $('#recent-txns');
  wrap.replaceChildren(buildTxnTable(transactions));
}

/* ================= TRANSACTIONS ================= */
function buildTxnTable(txns) {
  const table = document.createElement('table');
  table.className = 'txn-table';
  const tbody = document.createElement('tbody');
  for (const t of txns) tbody.appendChild(txnRow(t));
  table.appendChild(tbody);
  return table;
}

function txnRow(t) {
  const tr = document.createElement('tr');

  const date = document.createElement('td');
  date.className = 'txn-date';
  date.textContent = new Date(t.date + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });

  const merch = document.createElement('td');
  merch.className = 'txn-merchant';
  merch.textContent = t.merchant_name || t.name;
  if (t.pending) {
    const p = document.createElement('span');
    p.className = 'txn-pending';
    p.textContent = 'pending';
    merch.appendChild(p);
  }

  const cat = document.createElement('td');
  const pill = document.createElement('button');
  pill.className = 'cat-pill';
  pill.title = 'Click to change category';
  const dot = document.createElement('span');
  dot.className = 'cat-dot';
  dot.style.background = catColor(t.category);
  const catName = document.createElement('span');
  catName.textContent = `${catIcon(t.category)} ${t.category}`;
  pill.append(dot, catName);
  pill.addEventListener('click', () => openCategoryModal(t));
  cat.appendChild(pill);

  const acct = document.createElement('td');
  acct.className = 'txn-account';
  acct.textContent = `${t.account_name}${t.mask ? ' ··' + t.mask : ''}`;

  const amt = document.createElement('td');
  amt.className = 'num' + (t.amount < 0 ? ' amt-in' : '');
  amt.textContent = (t.amount < 0 ? '+' : '') + fmtUSD(Math.abs(t.amount), { cents: true });

  tr.append(date, merch, cat, acct, amt);
  return tr;
}

function renderCatChips() {
  const wrap = $('#txn-cat-chips');
  wrap.replaceChildren();
  const all = document.createElement('button');
  all.className = 'chip' + (state.txnFilters.category ? '' : ' active');
  all.textContent = 'All';
  all.addEventListener('click', () => { state.txnFilters.category = ''; loadTransactions(true); });
  wrap.appendChild(all);
  for (const c of state.categories) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (state.txnFilters.category === c ? ' active' : '');
    chip.textContent = `${catIcon(c)} ${c}`;
    chip.addEventListener('click', () => {
      state.txnFilters.category = state.txnFilters.category === c ? '' : c;
      loadTransactions(true);
    });
    wrap.appendChild(chip);
  }
}

async function loadTransactions(reset = false) {
  if (reset) state.txnFilters.offset = 0;
  renderCatChips();

  const f = state.txnFilters;
  const { start, end } = rangeDates('6m'); // transactions view spans 6 months
  const params = new URLSearchParams({ start, end, limit: f.limit, offset: f.offset });
  if (f.q) params.set('q', f.q);
  if (f.category) params.set('category', f.category);
  if (f.account) params.set('account', f.account);

  const { total, transactions } = await api(`/api/transactions?${params}`);
  state.txnTotal = total;

  const tbody = $('#txn-table tbody');
  if (reset) tbody.replaceChildren();
  for (const t of transactions) tbody.appendChild(txnRow(t));

  $('#txn-count-label').textContent = `${total.toLocaleString()} transactions in the last 6 months`;
  $('#txn-more').classList.toggle('hidden', f.offset + f.limit >= total);

  if (state.accounts.length === 0) {
    const { accounts } = await api('/api/accounts');
    state.accounts = accounts;
  }
  const sel = $('#txn-account-filter');
  if (sel.options.length <= 1) {
    for (const a of state.accounts) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = `${a.name}${a.mask ? ' ··' + a.mask : ''}`;
      sel.appendChild(opt);
    }
  }
}

let searchTimer;
$('#txn-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.txnFilters.q = e.target.value.trim();
    loadTransactions(true);
  }, 250);
});
$('#txn-account-filter').addEventListener('change', (e) => {
  state.txnFilters.account = e.target.value;
  loadTransactions(true);
});
$('#txn-more').addEventListener('click', () => {
  state.txnFilters.offset += state.txnFilters.limit;
  loadTransactions(false);
});

/* ---------------- recategorize modal ---------------- */
function openCategoryModal(txn) {
  const modal = $('#cat-modal');
  $('#cat-modal-merchant').textContent = `${txn.merchant_name || txn.name} · ${fmtUSD(Math.abs(txn.amount), { cents: true })}`;
  const opts = $('#cat-modal-options');
  opts.replaceChildren();
  for (const c of state.categories) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (txn.category === c ? ' active' : '');
    chip.textContent = `${catIcon(c)} ${c}`;
    chip.addEventListener('click', async () => {
      try {
        const applyToSimilar = $('#cat-apply-similar').checked;
        const res = await api(`/api/transactions/${encodeURIComponent(txn.id)}`, {
          method: 'PATCH', body: { category: c, applyToSimilar },
        });
        modal.classList.add('hidden');
        toast(res.similar > 0 ? `Recategorized, plus ${res.similar} similar transaction${res.similar === 1 ? '' : 's'}` : 'Category updated');
        loadTransactions(true);
      } catch (err) {
        toast(err.message, '⚠️');
      }
    });
    opts.appendChild(chip);
  }
  modal.classList.remove('hidden');
}
$('#cat-modal-cancel').addEventListener('click', () => $('#cat-modal').classList.add('hidden'));
$('#cat-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) $('#cat-modal').classList.add('hidden');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#cat-modal').classList.add('hidden');
});

/* ================= BUDGETS ================= */
async function loadBudgets() {
  const { budgets, unbudgetedSpend } = await api('/api/budgets');
  const monthName = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  $('#budget-subtitle').textContent = `Monthly limits · ${monthName}`;

  const totalLimit = budgets.reduce((s, b) => s + b.monthly_limit, 0);
  const totalSpent = budgets.reduce((s, b) => s + b.spent, 0);
  const summary = $('#budget-summary');
  summary.replaceChildren();
  const sumLeft = document.createElement('div');
  const big = document.createElement('div');
  big.className = 'stat-value';
  big.textContent = fmtUSD(Math.max(0, totalLimit - totalSpent));
  const cap = document.createElement('div');
  cap.className = 'muted';
  cap.textContent = `left of ${fmtUSD(totalLimit)} budgeted this month`;
  sumLeft.append(big, cap);
  const meterWrap = document.createElement('div');
  meterWrap.style.flex = '1';
  meterWrap.style.minWidth = '220px';
  meterWrap.appendChild(buildMeter(totalSpent, totalLimit));
  summary.append(sumLeft, meterWrap);

  const list = $('#budget-list');
  list.replaceChildren();
  const budgeted = new Set(budgets.map((b) => b.category));
  for (const b of budgets) list.appendChild(budgetCard(b));
  // categories with spend but no budget, plus remaining categories — offer to set one
  const spendable = state.categories.filter((c) => c !== 'Income' && !budgeted.has(c));
  for (const c of spendable) {
    const spent = unbudgetedSpend.find((u) => u.category === c)?.total || 0;
    list.appendChild(budgetCard({ category: c, monthly_limit: 0, spent }));
  }
}

function buildMeter(spent, limit) {
  const pct = limit > 0 ? (spent / limit) * 100 : 0;
  const meter = document.createElement('div');
  meter.className = 'meter ' + (pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok');
  const fill = document.createElement('span');
  fill.style.width = '0%';
  requestAnimationFrame(() => { fill.style.width = `${Math.min(100, pct)}%`; });
  meter.appendChild(fill);
  return meter;
}

function budgetCard(b) {
  const card = document.createElement('div');
  card.className = 'card budget-card';

  const top = document.createElement('div');
  top.className = 'budget-top';
  const dot = document.createElement('span');
  dot.className = 'cat-dot';
  dot.style.background = catColor(b.category);
  const name = document.createElement('span');
  name.className = 'budget-name';
  name.textContent = `${catIcon(b.category)} ${b.category}`;
  const edit = document.createElement('div');
  edit.className = 'budget-edit';
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = '10';
  input.value = b.monthly_limit || '';
  input.placeholder = 'Set limit';
  input.setAttribute('aria-label', `Monthly budget for ${b.category}`);
  const save = async () => {
    const v = Number(input.value || 0);
    if (v === b.monthly_limit) return;
    try {
      await api(`/api/budgets/${encodeURIComponent(b.category)}`, { method: 'PUT', body: { monthly_limit: v } });
      toast(v > 0 ? `${b.category} budget set to ${fmtUSD(v)}/mo` : `${b.category} budget removed`);
      loadBudgets();
    } catch (err) { toast(err.message, '⚠️'); }
  };
  input.addEventListener('change', save);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  edit.appendChild(input);
  top.append(dot, name, edit);
  card.appendChild(top);

  if (b.monthly_limit > 0) {
    card.appendChild(buildMeter(b.spent, b.monthly_limit));
    const nums = document.createElement('div');
    nums.className = 'budget-nums';
    const spent = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = fmtUSD(b.spent);
    spent.append(strong, document.createTextNode(` of ${fmtUSD(b.monthly_limit)}`));
    const pct = (b.spent / b.monthly_limit) * 100;
    const status = document.createElement('span');
    status.className = 'budget-status ' + (pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok');
    status.textContent = pct >= 100
      ? `⛔ over by ${fmtUSD(b.spent - b.monthly_limit)}`
      : pct >= 80 ? `⚠️ ${Math.round(pct)}% used` : `✓ ${fmtUSD(b.monthly_limit - b.spent)} left`;
    nums.append(spent, status);
    card.appendChild(nums);
  } else if (b.spent > 0) {
    const note = document.createElement('div');
    note.className = 'muted';
    note.textContent = `${fmtUSD(b.spent)} spent this month — set a limit to track it`;
    card.appendChild(note);
  }
  return card;
}

/* ================= ACCOUNTS ================= */
const INSTITUTION_STYLES = [
  { match: /american express|amex/i, bg: '#016fd0', initials: 'AX' },
  { match: /first horizon/i, bg: '#00838f', initials: 'FH' },
];
function institutionStyle(name = '') {
  const hit = INSTITUTION_STYLES.find((s) => s.match.test(name));
  if (hit) return hit;
  const initials = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '🏦';
  return { bg: 'var(--accent)', initials };
}

async function loadAccounts() {
  const [status, { accounts }] = await Promise.all([api('/api/status'), api('/api/accounts')]);
  state.plaidConfigured = status.plaidConfigured;
  state.accounts = accounts;

  const note = $('#plaid-note');
  note.replaceChildren();
  if (status.plaidConfigured) {
    note.append(strong('Bank sync is on'), document.createTextNode(
      ` (Plaid ${status.plaidEnv}). Click “Link account” to connect American Express, First Horizon Bank, or 12,000+ other institutions. Transactions import and categorize automatically.`));
  } else {
    note.append(strong('Bank sync is not configured yet. '), document.createTextNode(
      'To link your Amex and First Horizon accounts automatically, create a free Plaid account and add '),
      code('PLAID_CLIENT_ID'), document.createTextNode(' and '), code('PLAID_SECRET'),
      document.createTextNode(' to a .env file (see README). Until then, you can explore with demo data below.'));
  }

  const grid = $('#account-list');
  grid.replaceChildren();
  if (accounts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No accounts yet — link one, or load the demo data.';
    grid.appendChild(empty);
  }
  for (const a of accounts) grid.appendChild(accountCard(a));
}

function strong(t) { const s = document.createElement('strong'); s.textContent = t; return s; }
function code(t) { const c = document.createElement('code'); c.textContent = t; return c; }

function accountCard(a) {
  const card = document.createElement('div');
  card.className = 'card account-card';
  const styleInfo = institutionStyle(a.institution || a.institution_name || a.name);
  card.style.setProperty('--accent', styleInfo.bg.startsWith('#') ? styleInfo.bg : undefined);

  const head = document.createElement('div');
  head.className = 'account-head';
  const logo = document.createElement('div');
  logo.className = 'account-logo';
  logo.style.background = styleInfo.bg;
  logo.textContent = styleInfo.initials;
  const titleWrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'account-title';
  title.textContent = a.name;
  const sub = document.createElement('div');
  sub.className = 'account-sub';
  sub.textContent = [a.institution || a.institution_name, a.subtype, a.mask ? `··${a.mask}` : null, a.is_demo ? 'demo' : null]
    .filter(Boolean).join(' · ');
  titleWrap.append(title, sub);
  head.append(logo, titleWrap);

  const bal = document.createElement('div');
  bal.className = 'account-balance';
  bal.textContent = a.balance_current != null ? fmtUSD(a.balance_current, { cents: true }) : '—';

  const meta = document.createElement('div');
  meta.className = 'account-meta';
  const left = document.createElement('span');
  left.textContent = a.type === 'credit'
    ? (a.balance_limit ? `of ${fmtCompact(a.balance_limit)} limit` : 'current balance')
    : (a.balance_available != null ? `${fmtUSD(a.balance_available, { cents: true })} available` : 'balance');
  const right = document.createElement('span');
  right.textContent = `${a.txn_count} txns${a.last_txn ? ' · updated ' + a.last_txn : ''}`;
  meta.append(left, right);

  card.append(head, bal, meta);

  if (a.item_id) {
    const rm = document.createElement('button');
    rm.className = 'text-btn account-remove';
    rm.textContent = 'Unlink';
    rm.addEventListener('click', async () => {
      if (!confirm(`Unlink ${a.name}? Its transactions will be removed.`)) return;
      await api(`/api/items/${encodeURIComponent(a.item_id)}`, { method: 'DELETE' });
      toast('Account unlinked');
      loadAccounts();
    });
    card.appendChild(rm);
  }
  return card;
}

/* ---------------- Plaid Link ---------------- */
async function openPlaidLink() {
  if (!state.plaidConfigured) {
    switchView('accounts');
    toast('Add your Plaid API keys first — see the note on the Accounts page', 'ℹ️');
    return;
  }
  try {
    const { link_token } = await api('/api/plaid/link_token', { method: 'POST' });
    // OAuth banks (Amex, First Horizon, …) leave the page and come back;
    // the token must survive that round-trip to resume the flow.
    localStorage.setItem('plaid_link_token', link_token);
    launchPlaidLink(link_token, null);
  } catch (err) {
    toast(err.message, '⚠️');
  }
}

function launchPlaidLink(token, receivedRedirectUri) {
  const handler = Plaid.create({
    token,
    receivedRedirectUri: receivedRedirectUri || undefined,
    onSuccess: async (public_token, metadata) => {
      localStorage.removeItem('plaid_link_token');
      toast('Linking account…', '⏳');
      try {
        const res = await api('/api/plaid/exchange', {
          method: 'POST',
          body: { public_token, institution_name: metadata.institution?.name },
        });
        toast(`Linked ${metadata.institution?.name || 'account'} — imported ${res.transactions} transactions`);
        loadAccounts();
      } catch (err) { toast(err.message, '⚠️'); }
    },
    onExit: (err) => {
      if (err) toast(err.display_message || err.error_message || 'Link exited', 'ℹ️');
    },
  });
  handler.open();
}

// Returning from a bank's OAuth approval page: resume Link where it left off.
(function resumeOAuthLink() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('oauth_state_id')) return;
  const receivedRedirectUri = window.location.href;
  history.replaceState({}, '', window.location.pathname);
  const token = localStorage.getItem('plaid_link_token');
  if (!token) {
    toast('Bank sign-in expired — tap “Link account” to try again', 'ℹ️');
    return;
  }
  switchView('accounts');
  launchPlaidLink(token, receivedRedirectUri);
})();
$('#link-btn').addEventListener('click', openPlaidLink);
$('#empty-link-btn').addEventListener('click', () => { switchView('accounts'); openPlaidLink(); });

$('#sync-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const res = await api('/api/plaid/sync', { method: 'POST' });
    toast(`Synced ${res.items} account link${res.items === 1 ? '' : 's'} — ${res.transactions} new or updated transactions`, '🔄');
    loadAccounts();
  } catch (err) {
    toast(err.message, '⚠️');
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- demo data ---------------- */
async function seedDemo() {
  const res = await api('/api/demo/seed', { method: 'POST' });
  toast(`Loaded ${res.transactions} demo transactions across 6 months`, '🌱');
  switchView('dashboard');
}
$('#demo-seed-btn').addEventListener('click', seedDemo);
$('#empty-demo-btn').addEventListener('click', seedDemo);
$('#demo-clear-btn').addEventListener('click', async () => {
  await api('/api/demo/clear', { method: 'POST' });
  toast('Demo data cleared');
  loadAccounts();
});

/* ---------------- sign out ---------------- */
$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  window.location.href = '/login';
});

/* ---------------- boot ---------------- */
$$('#range-filters .chip').find((c) => c.dataset.range === state.range)?.classList.add('active');
api('/api/status').then((s) => {
  if (s.categories?.length) state.categories = s.categories;
  state.plaidConfigured = s.plaidConfigured;
  $('#logout-btn').classList.toggle('hidden', !s.authEnabled);
});
loadDashboard();
