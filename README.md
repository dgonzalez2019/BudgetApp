# 💸 BudgetApp

A personal budgeting app that tracks your spending, categorizes every transaction automatically, and links directly to your **American Express card** and **First Horizon Bank account** (plus 12,000+ other institutions) through [Plaid](https://plaid.com) — so you never have to enter transactions by hand.

## Features

- **Automatic bank sync** — connect Amex, First Horizon, or any Plaid-supported institution; transactions and balances import automatically.
- **Smart categorization** — every transaction is sorted into categories (Groceries, Food & Dining, Shopping, Transportation, Bills & Utilities, Entertainment, Health & Wellness, Travel, Income) using merchant rules plus Plaid's enriched category data. Recategorize anything with one click, and optionally teach the app to always file that merchant the same way.
- **Interactive dashboard** — spending-by-category donut, monthly spending vs. income, a daily spending trend with crosshair tooltips, top merchants, and stat tiles with month-over-month deltas. Filter everything by date range (this month, last month, 3/6 months, YTD).
- **Budgets** — set monthly limits per category and watch animated progress meters shift from green → amber → red as the month unfolds.
- **Immersive design** — animated ambient background, glass-panel cards, smooth view transitions, count-up numbers, and hand-tuned light & dark themes (toggle in the sidebar).
- **Demo mode** — one click loads 6 months of realistic sample data (an Amex Gold card + First Horizon checking) so you can explore before wiring up Plaid.

## Quick start

```bash
npm install
npm start
```

Open **http://localhost:3000**, then click **Load demo data** to explore immediately.

## Linking your real accounts (Amex + First Horizon)

Banks don't let apps read your transactions directly — the industry-standard bridge is **Plaid**, the same service used by Venmo, Chime, and YNAB. Your bank credentials go to Plaid, never to this app; the app only stores an access token and the transaction data.

1. Create a free account at [dashboard.plaid.com/signup](https://dashboard.plaid.com/signup).
2. Copy your **client ID** and **secret** from the dashboard (Keys page).
3. In the project folder:
   ```bash
   cp .env.example .env
   # edit .env and paste in:
   # PLAID_CLIENT_ID=your_client_id
   # PLAID_SECRET=your_secret
   # PLAID_ENV=sandbox        <- start here; see below
   ```
4. Restart the app (`npm start`), open the **Accounts** tab, and click **+ Link account**.
5. Search for *American Express* or *First Horizon Bank* in the Plaid window, log in, and your transactions flow in. Use **Sync now** anytime to pull the latest.

### OAuth banks (Amex, First Horizon, Chase, …)

Many major institutions use OAuth: Plaid sends you to the bank's own site to approve, then returns you to the app. Two extra steps make that work:

1. In the Plaid dashboard, open **Developers → API → Allowed redirect URIs** and add your app's exact URL with a trailing slash, e.g. `https://your-app.up.railway.app/` (or `http://localhost:3000/` for local use).
2. Set `PLAID_REDIRECT_URI` to that **identical** string in your environment and restart/redeploy.

Without both, OAuth institutions fail with "link exited" or won't be selectable at all.

### Plaid environments

| `PLAID_ENV` | What it does |
|---|---|
| `sandbox` | Fake test banks (username `user_good`, password `pass_good`) — free, instant, great for trying the flow |
| `production` | Your real Amex + First Horizon accounts. Request Production access in the Plaid dashboard (free for small personal use under their Limited Production program) |

## Hosting it on the internet (use it from your phone, anywhere)

The app ships with a password gate and a Dockerfile so it can run on any cloud host. **Never host it publicly without setting `APP_PASSWORD`** — that's what turns the login screen on.

### Deploy on Railway (recommended, ~10 minutes)

1. Sign up at [railway.com](https://railway.com) with your GitHub account (Hobby plan, $5/mo).
2. Click **New Project → Deploy from GitHub repo** and pick this repository. Railway detects the Dockerfile and builds automatically.
3. Give the database a permanent home: right-click the service → **Attach volume**, mount path `/data`.
4. In the service's **Variables** tab add:
   | Variable | Value |
   |---|---|
   | `APP_PASSWORD` | a strong password you'll use to sign in |
   | `SESSION_SECRET` | any long random string (`openssl rand -hex 32`) |
   | `DATA_DIR` | `/data` |
   | `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` | your Plaid keys (optional, for bank sync) |
5. In **Settings → Networking** click **Generate Domain**. You'll get a URL like `budgetapp-production.up.railway.app`.
6. Open that URL on your phone, sign in, and use Share → **Add to Home Screen** for an app-like icon.

Any Docker-capable host works the same way (Render, Fly.io, a VPS) — the app needs one persistent directory for `DATA_DIR` and the environment variables above.

### Security notes

- Sessions are signed `httpOnly` cookies (30-day expiry); sign-in attempts are throttled to 5 per 15 minutes per IP.
- Changing `APP_PASSWORD` signs everyone out (unless you set `SESSION_SECRET`, which keeps sessions across password changes).
- Cloud hosts terminate HTTPS for you; the cookie is marked `Secure` automatically behind an HTTPS proxy.
- Without `APP_PASSWORD` set, the app runs open — fine on your own computer, never on the internet.

## How categorization works

1. **Your rules win** — when you recategorize a transaction and tick *"Always use this category for this merchant"*, a rule is saved and applied to past and future matches.
2. **Built-in merchant rules** — 80+ common merchants (Whole Foods → Groceries, Netflix → Entertainment, …).
3. **Plaid enrichment** — Plaid's `personal_finance_category` for anything not matched above.
4. Anything left lands in **Other**, one click away from a better home.

## Tech

- **Backend:** Node.js + Express, SQLite (better-sqlite3), official Plaid SDK
- **Frontend:** vanilla ES modules, hand-rolled SVG charts, zero UI frameworks
- **Storage:** everything lives locally in `data/budget.db` — your financial data never leaves your machine (Plaid API calls excepted)

## Project layout

```
server/
  index.js        Express app + REST API
  db.js           SQLite schema
  plaid.js        Link, token exchange, cursor-based transaction sync
  categorizer.js  Category rules engine
  demo.js         Demo data generator
public/
  index.html      Single-page app shell
  css/styles.css  Design system (light/dark tokens, glass cards, animations)
  js/app.js       Views, state, interactions
  js/charts.js    SVG donut / bars / line with tooltips & crosshair
```
