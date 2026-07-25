# NSE + BSE Analytics Dashboard

## Deploy it online (recommended — no terminal needed ever again)

**One-time setup (~10 minutes):**

1. **Create a GitHub account** at github.com if you don't have one (free).
2. **Create a new repository**: click the **+** in the top right → **New repository** → name it
   `nse-bse-dashboard` → leave it Public → click **Create repository**.
3. **Upload these files**: on the new repo's page, click **uploading an existing file**,
   then drag in every file from this folder (`server.js`, `package.json`, `render.yaml`,
   `.gitignore`, `README.md`, and the whole `public` folder) → scroll down → **Commit changes**.
4. **Create a Render account** at render.com → sign up with **GitHub** (one click, no
   separate password to manage).
5. On the Render dashboard: **New +** → **Web Service** → select your `nse-bse-dashboard`
   repo → Render auto-detects everything from `render.yaml` (build: `npm install`,
   start: `npm start`) → click **Create Web Service**.
6. Wait ~2 minutes for the first deploy. You'll get a public URL like
   `https://nse-bse-dashboard.onrender.com` — open it, that's your live site.

**Note:** Render's free tier spins the server down after 15 minutes of no visits, and
takes ~30–60 seconds to wake back up on the next visit. That's normal on the free plan,
not a bug.

**Getting future updates from here on:**
When there's an update, go to the file on your GitHub repo page → click the pencil
(✏️) icon to edit → paste in the new content → **Commit changes**. Render detects the
push and redeploys automatically within a minute or two — no downloads, no Command
Prompt, no restarting anything yourself.

## Real F&O data (Open Interest, Max Pain, PCR) via Upstox
1. Log into Upstox → `account.upstox.com/developer/apps` → **Create new app**
2. Open the app → **Analytics** tab → generate an **Analytics Token** (read-only, 1-year validity, no daily regeneration)
3. On Render: your service → **Environment** tab → **Add Environment Variable** →
   Key: `UPSTOX_ACCESS_TOKEN`, Value: your token → Save
4. The F&O indices tab will show a **REAL** tag per row once it's working, or
   **SIMULATED** if the token's missing/invalid/Upstox errors — it never breaks
   the page either way.

Note: a few Upstox developers have reported intermittent issues generating or
using the Analytics Token (per their own community forum) — if a specific
index keeps showing SIMULATED, check the Render logs for the actual error
message from Upstox.

## Options & futures scanning
Once `UPSTOX_ACCESS_TOKEN` is set (see below) and your Upstox account's F&O
segment is active, the **Options & futures** tab scans real option chains for
any index or F&O-enabled stock. The "signal" shown per strike is the standard
OI-buildup classification traders use — Long Buildup, Short Buildup, Long
Unwinding, Short Covering — derived from price direction + open-interest
direction together, computed by comparing each scan against your previous
one (stored in Upstash). The very first scan of a symbol+expiry always shows
"No comparison yet", since there's nothing prior to compare against — scan
again a few minutes later for real classifications. You can set a price alert
directly on any specific strike/CE/PE from the scan results, monitored the
same way (browser + server + Telegram) as your regular stock alerts.

## Full stock search (1000s of real NSE + BSE listings)
The search bar can find and open any real NSE/BSE-listed stock, not just the
~208 curated ones shown by default in the Screener — fetched from Upstox's
official, publicly-published instruments file (refreshed daily, no extra
setup needed, works independently of the other Upstox features above). The
Screener table itself intentionally stays limited to the curated list for
performance — rendering full technical analysis for thousands of stocks at
once would freeze the browser tab.

## Server-side alerts (work even when your browser is closed)
By default, Buy/Sell and price alerts only fire while this page is open in a
browser tab. To get notified via Telegram at any time — including when your
computer's off — three things need to be set up together:

**1. Upstash Redis (free)** — gives the server somewhere to store your
positions/alerts so it can check them independently of your browser.
- Sign up at upstash.com → **Create Database** → any name, free tier
- On the database page, find **REST API** → copy the URL and token
- Render → your service → **Environment** → add:
  - `UPSTASH_REDIS_REST_URL`
  - `UPSTASH_REDIS_REST_TOKEN`

**2. Telegram bot (free)** — how you actually get notified.
- Message **@BotFather** on Telegram → `/newbot` → follow the prompts → it
  gives you a bot token (looks like `123456:ABC-...`)
- Message your new bot anything once (so it can see your chat)
- Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser →
  find `"chat":{"id":123456789...}` in the response → that number is your chat ID
- Render → **Environment** → add:
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_CHAT_ID`
- Optional but recommended: also add `CHECK_ALERTS_SECRET` (any random string
  you make up) so random people on the internet can't hit your check endpoint
  and spam your Telegram

**3. GitHub Actions (free)** — the actual "checks every 5 minutes, even with
no browser open" part. Already included as
`.github/workflows/check-alerts.yml`. It needs two repo secrets:
- GitHub → your repo → **Settings** → **Secrets and variables** → **Actions**
  → **New repository secret**:
  - `DASHBOARD_URL` = `https://nse-bse-dashboard.onrender.com` (no trailing slash)
  - `CHECK_ALERTS_SECRET` = the same random string you used in step 2 (skip
    this secret entirely if you didn't set one on Render either)

Once all three are in place, positions/price alerts sync to the server
automatically as you create them, and you'll get a Telegram message the
moment a target/stop-loss/price level is crossed — checked every 5 minutes
by GitHub Actions regardless of whether the dashboard is open anywhere.

Without any of this configured, everything still works exactly as before —
alerts just stay browser-only.

## Run it locally instead
```
npm install
node server.js
```
Then open http://localhost:3000

## What's live vs simulated
- **Live** (once the server is running): current price, day high/low, volume,
  intraday price chart, and the top index ticker (Nifty 50 / Bank Nifty /
  Nifty IT / India VIX). Sourced from Yahoo Finance via `server.js`, which
  proxies the request server-side because Yahoo blocks direct browser (CORS)
  requests.
- **Simulated** (always, clearly labeled in the UI): fundamentals (P/E, ROE,
  shareholding, segment mix...), backtest results, news, and the F&O
  snapshot. Yahoo's free endpoints don't reliably expose these without extra
  auth, so treat this data as a placeholder for wiring up a real
  fundamentals/news provider later.

## Status badge
Next to the price you'll see one of:
- `LIVE` (green) — real Yahoo data just came through
- `Connecting…` — a fetch is in flight
- `SIMULATED` (amber) — the fetch failed (server not running, offline, or
  Yahoo rate-limited/blocked the request) and the UI fell back to a
  simulated price nudge so the page keeps working either way

## Extending
- Add more stocks: edit the `STOCKS` array near the top of the `<script>` in
  `public/index.html`.
- Swap the data source: edit `getChartData()` in `server.js`.
- Yahoo occasionally tightens bot detection (403s). If that happens
  consistently, swap in a paid provider (e.g. Alpha Vantage, Finnhub,
  Twelve Data) in the same `getChartData()` function — the rest of the app
  doesn't need to change since it only depends on the shape returned by
  `parseChartPayload()`.
