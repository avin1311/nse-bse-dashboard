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
