/**
 * Local live-data proxy for the NSE + BSE dashboard.
 *
 * WHY THIS EXISTS
 * Yahoo Finance's data endpoints (query1/query2.finance.yahoo.com) block
 * CORS for direct browser requests, so a static HTML file can never fetch
 * them itself. This tiny server fetches Yahoo server-side (no CORS applies
 * server-to-server) and exposes clean JSON to the frontend on the same
 * origin, so the browser's fetch() calls just work.
 *
 * WHAT'S LIVE VS SIMULATED
 * Live through this proxy: current price, day high/low, volume, intraday
 * price series, and the top index ticker (Nifty 50 / Bank Nifty / Nifty IT
 * / India VIX).
 * Still simulated in the frontend: fundamentals (P/E, ROE, shareholding,
 * segments...), backtest results, news, and F&O snapshot — Yahoo's free
 * endpoints don't reliably expose these without extra auth (crumb/cookie),
 * so those stay clearly labeled as demo data.
 *
 * RUN IT
 *   npm install
 *   node server.js
 *   open http://localhost:3000
 */
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Short cache so many browser tabs / a fast refresh loop don't hammer Yahoo
// and trip its rate limiting. 12s roughly matches the dashboard's own
// refresh cadence.
const CACHE_TTL_MS = 12000;
const cache = new Map();

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'application/json'
};

async function fetchYahooJson(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) return hit.data;

  const resp = await fetch(url, { headers: YAHOO_HEADERS });
  if (!resp.ok) {
    throw new Error(`Yahoo responded ${resp.status} for ${url}`);
  }
  const data = await resp.json();
  cache.set(url, { time: Date.now(), data });
  return data;
}

function parseChartPayload(json, requestedSymbol) {
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !result.meta) return null;
  const meta = result.meta;
  const timestamps = result.timestamp || [];
  const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
  const series = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] != null) series.push({ t: timestamps[i], c: closes[i] });
  }
  return {
    symbol: requestedSymbol,
    price: meta.regularMarketPrice,
    prevClose: meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose,
    dayHigh: meta.regularMarketDayHigh,
    dayLow: meta.regularMarketDayLow,
    volume: meta.regularMarketVolume,
    currency: meta.currency,
    marketState: meta.marketState,
    exchangeName: meta.exchangeName,
    series
  };
}

async function getChartData(yahooSymbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;
  const json = await fetchYahooJson(url);
  return parseChartPayload(json, yahooSymbol);
}

// Single symbol, with its own intraday series (used for the price chart)
app.get('/api/chart/:symbol', async (req, res) => {
  try {
    const range = req.query.range || '1d';
    const interval = req.query.interval || '5m';
    const parsed = await getChartData(req.params.symbol, range, interval);
    if (!parsed) return res.status(502).json({ error: 'No data returned for symbol', symbol: req.params.symbol });
    res.json(parsed);
  } catch (e) {
    res.status(502).json({ error: e.message, symbol: req.params.symbol });
  }
});

// Multiple symbols in one call, lighter payload (used for screener/peers/ticker)
app.get('/api/quotes', async (req, res) => {
  const symbols = (req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: 'symbols query param required, comma separated' });
  const results = await Promise.all(symbols.map(async (sym) => {
    try {
      return await getChartData(sym, '1d', '5m');
    } catch (e) {
      return { symbol: sym, error: e.message };
    }
  }));
  res.json(results);
});

// Longer daily history, used by the Backtest tab to run strategies against
// real historical closes instead of the short mock series.
app.get('/api/history/:symbol', async (req, res) => {
  try {
    const range = req.query.range || '2y';
    const parsed = await getChartData(req.params.symbol, range, '1d');
    if (!parsed) return res.status(502).json({ error: 'No data returned for symbol', symbol: req.params.symbol });
    res.json(parsed);
  } catch (e) {
    res.status(502).json({ error: e.message, symbol: req.params.symbol });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// PERSISTENT STORE (Upstash Redis — free tier, HTTP REST API)
// Needed so positions/alerts/watchlist survive across devices AND
// so the server can check them even when nobody's browser is open.
// Requires UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN env vars.
// Degrades gracefully: without them, sync endpoints just no-op and
// the frontend keeps using localStorage only, same as before.
// ============================================================
async function redisCmd(...args) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Upstash not configured (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN missing)');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  const json = await resp.json();
  if (json.error) throw new Error(json.error);
  return json.result;
}
async function storeGet(key, fallback) {
  try {
    const raw = await redisCmd('GET', key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
async function storeSet(key, value) {
  await redisCmd('SET', key, JSON.stringify(value));
}

app.get('/api/sync/:key', async (req, res) => {
  const allowed = ['positions', 'price-alerts', 'watchlist', 'portfolio'];
  if (!allowed.includes(req.params.key)) return res.status(400).json({ error: 'unknown key' });
  try {
    const data = await storeGet(`store:${req.params.key}`, []);
    res.json({ data, source: 'upstash' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
app.post('/api/sync/:key', async (req, res) => {
  const allowed = ['positions', 'price-alerts', 'watchlist', 'portfolio'];
  if (!allowed.includes(req.params.key)) return res.status(400).json({ error: 'unknown key' });
  try {
    await storeSet(`store:${req.params.key}`, req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ============================================================
// TELEGRAM NOTIFICATIONS
// Requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env vars.
// ============================================================
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing)');
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
  const json = await resp.json();
  if (!json.ok) throw new Error(json.description || 'Telegram send failed');
  return json;
}

// ============================================================
// SERVER-SIDE ALERT CHECK
// Called on a schedule by GitHub Actions (see .github/workflows),
// so it runs even when no browser is open. Reads positions/alerts
// from Upstash, checks live prices via Yahoo, sends a Telegram
// message for anything newly triggered, and writes status back.
// Optional CHECK_ALERTS_SECRET env var gates this endpoint so
// randoms can't spam your Telegram by hitting it directly.
// ============================================================
app.get('/api/check-alerts', async (req, res) => {
  const secret = process.env.CHECK_ALERTS_SECRET;
  if (secret && req.query.secret !== secret) return res.status(403).json({ error: 'forbidden' });

  try {
    const positions = await storeGet('store:positions', []);
    const priceAlerts = await storeGet('store:price-alerts', []);
    const openPositions = positions.filter(p => p.status === 'open');
    const activeAlerts = priceAlerts.filter(a => a.status === 'active');
    const notifications = [];

    const symbols = [...new Set([...openPositions.map(p => p.symbol), ...activeAlerts.map(a => a.symbol)])];
    const prices = {};
    for (const sym of symbols) {
      try {
        const data = await getChartData(`${sym}.NS`, '1d', '5m');
        if (data && data.price != null) prices[sym] = data.price;
      } catch (e) { /* leave unpriced, skip this symbol this run */ }
    }

    for (const p of openPositions) {
      const price = prices[p.symbol];
      if (price == null) continue;
      p.lastPrice = price;
      const hitTarget = p.side === 'buy' ? price >= p.target : price <= p.target;
      const hitStop = p.side === 'buy' ? price <= p.stopLoss : price >= p.stopLoss;
      if (hitTarget) { p.status = 'target'; notifications.push(`🎯 <b>Target hit</b> — ${p.symbol} ${p.side.toUpperCase()} @ entry ₹${p.entryPrice.toFixed(2)}, now ₹${price.toFixed(2)}`); }
      else if (hitStop) { p.status = 'stoploss'; notifications.push(`⛔ <b>Stop-loss hit</b> — ${p.symbol} ${p.side.toUpperCase()} @ entry ₹${p.entryPrice.toFixed(2)}, now ₹${price.toFixed(2)}`); }
    }
    for (const a of activeAlerts) {
      const price = prices[a.symbol];
      if (price == null) continue;
      a.lastPrice = price;
      const triggered = a.condition === 'above' ? price >= a.price : price <= a.price;
      if (triggered) { a.status = 'triggered'; notifications.push(`🔔 <b>Price alert</b> — ${a.symbol} ${a.condition==='above'?'crossed above':'crossed below'} ₹${a.price.toFixed(2)} (now ₹${price.toFixed(2)})`); }
    }

    try {
      await storeSet('store:positions', positions);
      await storeSet('store:price-alerts', priceAlerts);
    } catch (e) { /* Upstash not configured — nothing to persist, that's fine */ }

    for (const msg of notifications) {
      try { await sendTelegram(msg); } catch (e) { /* Telegram not configured or failed — keep going */ }
    }

    res.json({ checked: symbols.length, triggered: notifications.length, notifications });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});


// ============================================================
// UPSTOX F&O DATA (Open Interest, Max Pain, PCR, Option Chain)
// Requires UPSTOX_ACCESS_TOKEN env var (Analytics Token — see README).
// Degrades gracefully: if the token isn't set, or Upstox errors, or an
// instrument_key mapping below turns out wrong, every route returns a
// clean JSON error and the frontend falls back to simulated data —
// it never crashes the app either way.
// ============================================================
const UPSTOX_BASE = 'https://api.upstox.com/v2';
// Confirmed against Upstox's own documentation examples. A couple of the
// less common indices are best-guess formats and may need correcting once
// tested against the real API — they'll just error gracefully if wrong.
const UPSTOX_INDEX_KEYS = {
  NIFTY: 'NSE_INDEX|Nifty 50',
  BANKNIFTY: 'NSE_INDEX|Nifty Bank',
  NIFTYIT: 'NSE_INDEX|Nifty IT',
  SENSEX: 'BSE_INDEX|SENSEX',
  FINNIFTY: 'NSE_INDEX|Nifty Fin Service',
  MIDCPNIFTY: 'NSE_INDEX|Nifty Midcap Select',
  BANKEX: 'BSE_INDEX|BANKEX',
  NIFTYNXT50: 'NSE_INDEX|Nifty Next 50'
};

function upstoxHeaders() {
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  if (!token) throw new Error('UPSTOX_ACCESS_TOKEN not configured on the server');
  return { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` };
}
async function upstoxGet(path) {
  const resp = await fetch(`${UPSTOX_BASE}${path}`, { headers: upstoxHeaders() });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json || json.status !== 'success') {
    throw new Error((json && (json.errors?.[0]?.message || json.message)) || `Upstox request failed (${resp.status})`);
  }
  return json.data;
}
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
async function nearestExpiry(instrumentKey) {
  const contracts = await upstoxGet(`/option/contract?instrument_key=${encodeURIComponent(instrumentKey)}`);
  const expiries = [...new Set(contracts.map(c => c.expiry))].sort();
  const today = todayIso();
  return expiries.find(e => e >= today) || expiries[expiries.length - 1];
}

app.get('/api/upstox/fno/:index', async (req, res) => {
  try {
    const instrumentKey = UPSTOX_INDEX_KEYS[req.params.index];
    if (!instrumentKey) return res.status(400).json({ error: 'Unknown index symbol', symbol: req.params.index });
    const expiry = await nearestExpiry(instrumentKey);
    const date = todayIso();

    const [pcrData, maxPainData, chainData] = await Promise.all([
      upstoxGet(`/market/pcr?instrument_key=${encodeURIComponent(instrumentKey)}&expiry=${expiry}&date=${date}&bucket_interval=60`),
      upstoxGet(`/market/max-pain?instrument_key=${encodeURIComponent(instrumentKey)}&expiry=${expiry}&date=${date}&bucket_interval=60`),
      upstoxGet(`/option/chain?instrument_key=${encodeURIComponent(instrumentKey)}&expiry_date=${expiry}`)
    ]);

    let totalCallOi = 0, totalPutOi = 0, atmIv = null, minDiff = Infinity;
    const spot = pcrData.spot_closing_price;
    (chainData || []).forEach(row => {
      totalCallOi += row.call_options?.market_data?.oi || 0;
      totalPutOi += row.put_options?.market_data?.oi || 0;
      const diff = Math.abs(row.strike_price - spot);
      if (diff < minDiff) { minDiff = diff; atmIv = row.call_options?.option_greeks?.iv ?? row.put_options?.option_greeks?.iv; }
    });

    res.json({
      symbol: req.params.index,
      expiry,
      spot,
      pcr: pcrData.pcr,
      maxPain: maxPainData.max_pain,
      totalCallOi, totalPutOi,
      atmIv,
      source: 'upstox-real'
    });
  } catch (e) {
    res.status(502).json({ error: e.message, symbol: req.params.index });
  }
});


app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\nDashboard running at http://localhost:${PORT}`);
  console.log(`Live data proxied from Yahoo Finance (cache TTL ${CACHE_TTL_MS / 1000}s)\n`);
});
