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
app.use(express.json());
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
// FULL STOCK UNIVERSE (real NSE + BSE equity list from Upstox)
// Upstox publishes a complete, officially-sourced instruments file,
// refreshed daily, no auth needed to download. We fetch + gunzip +
// filter to just equities (instrument_type EQ), cache in memory for
// a day, and expose a lightweight list for the search bar to use.
// Community reports occasional 403s/blank files on this public
// asset URL, so this degrades gracefully to an empty result (the
// frontend then just keeps using its curated fallback list) rather
// than ever crashing the server.
// ============================================================
const zlib = require('zlib');
let universeCache = { data: null, time: 0 };
const UNIVERSE_TTL_MS = 24 * 60 * 60 * 1000;

async function fetchInstrumentFile(exchange) {
  const url = `https://assets.upstox.com/market-quote/instruments/exchange/${exchange}.json.gz`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Upstox instruments file (${exchange}) responded ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const json = zlib.gunzipSync(buf).toString('utf8');
  const list = JSON.parse(json);
  // Keep only plain equities — the same file also bundles F&O contracts,
  // indices, etc., which we don't want cluttering the equity search list.
  return list.filter(row => row.instrument_type === 'EQ' && row.trading_symbol);
}

async function fetchAndCacheUniverse() {
  const [nse, bse] = await Promise.all([
    fetchInstrumentFile('NSE').catch(() => []),
    fetchInstrumentFile('BSE').catch(() => [])
  ]);
  const seen = new Set();
  const combined = [];
  // NSE first so it wins on any symbol collision between the two exchanges
  for (const row of [...nse, ...bse]) {
    if (seen.has(row.trading_symbol)) continue;
    seen.add(row.trading_symbol);
    combined.push({ symbol: row.trading_symbol, name: row.name, exchange: row.exchange, instrument_key: row.instrument_key });
  }
  if (!combined.length) throw new Error('Both NSE and BSE instrument fetches returned nothing');
  universeCache = { data: combined, time: Date.now() };
  return combined;
}

app.get('/api/stock-universe', async (req, res) => {
  if (universeCache.data && Date.now() - universeCache.time < UNIVERSE_TTL_MS) {
    return res.json({ stocks: universeCache.data, cached: true });
  }
  try {
    const combined = await fetchAndCacheUniverse();
    res.json({ stocks: combined, cached: false });
  } catch (e) {
    res.status(502).json({ error: e.message, stocks: [] });
  }
});



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

    // IMPORTANT: this checks telegramSent, NOT status. The browser's own
    // 8-second monitor sets status ('target'/'stoploss'/'triggered') purely
    // for its own UI — that used to also (wrongly) stop the server from ever
    // notifying, since the server only looked at items still 'open'/'active'.
    // That meant if the browser was open anywhere, Telegram would never fire.
    // Checking telegramSent instead makes browser detection and Telegram
    // notification fully independent: each item gets notified exactly once,
    // whichever side (browser or this server check) detects it first.
    const positionsToCheck = positions.filter(p => !p.telegramSent && p.status !== 'closed');
    const alertsToCheck = priceAlerts.filter(a => !a.telegramSent);
    const notifications = [];

    // Positions never carry optionMeta (Buy/Sell only trades the underlying
    // stock), so their symbols always go through the Yahoo equity path.
    const equitySymbols = [...new Set([...positionsToCheck.map(p => p.symbol), ...alertsToCheck.filter(a => !a.optionMeta).map(a => a.symbol)])];
    const prices = {};
    for (const sym of equitySymbols) {
      try {
        const data = await getChartData(`${sym}.NS`, '1d', '5m');
        if (data && data.price != null) prices[sym] = data.price;
      } catch (e) { /* leave unpriced, skip this symbol this run */ }
    }

    // Option alerts fetch through the same option-chain logic the scanning
    // UI uses — grouped by underlying+expiry so a chain with several alerts
    // on it only gets fetched once per run, not once per alert.
    const optionAlerts = alertsToCheck.filter(a => a.optionMeta);
    const chainGroups = {};
    optionAlerts.forEach(a => {
      const key = `${a.optionMeta.underlying}|${a.optionMeta.expiry}`;
      (chainGroups[key] = chainGroups[key] || []).push(a);
    });
    const optionPrices = {}; // alert.id -> ltp
    for (const key of Object.keys(chainGroups)) {
      const [underlying, expiry] = key.split('|');
      try {
        const instrumentKey = await resolveInstrumentKey(underlying);
        const chainData = await upstoxGet(`/option/chain?instrument_key=${encodeURIComponent(instrumentKey)}&expiry_date=${expiry}`);
        chainGroups[key].forEach(a => {
          const row = (chainData || []).find(r => r.strike_price === a.optionMeta.strike);
          const side = a.optionMeta.side === 'ce' ? row?.call_options?.market_data : row?.put_options?.market_data;
          if (side && side.ltp != null) optionPrices[a.id] = side.ltp;
        });
      } catch (e) { /* Upstox not configured/reachable this run — these alerts just get skipped this pass */ }
    }

    for (const p of positionsToCheck) {
      const price = prices[p.symbol];
      if (price == null) continue;
      p.lastPrice = price;
      const hitTarget = p.side === 'buy' ? price >= p.target : price <= p.target;
      const hitStop = p.side === 'buy' ? price <= p.stopLoss : price >= p.stopLoss;
      if (hitTarget) { p.status = 'target'; p.telegramSent = true; notifications.push(`🎯 <b>Target hit</b> — ${p.symbol} ${p.side.toUpperCase()} @ entry ₹${p.entryPrice.toFixed(2)}, now ₹${price.toFixed(2)}`); }
      else if (hitStop) { p.status = 'stoploss'; p.telegramSent = true; notifications.push(`⛔ <b>Stop-loss hit</b> — ${p.symbol} ${p.side.toUpperCase()} @ entry ₹${p.entryPrice.toFixed(2)}, now ₹${price.toFixed(2)}`); }
      else if (p.deviationLevel != null && !p.deviationSent) {
        // Early warning: price has moved halfway from entry toward stop-loss,
        // but hasn't hit either target or stop-loss yet. Fires once per position.
        const pastDeviation = p.side === 'buy' ? price <= p.deviationLevel : price >= p.deviationLevel;
        if (pastDeviation) {
          p.deviationSent = true;
          notifications.push(`⚠️ <b>Deviation warning</b> — ${p.symbol} ${p.side.toUpperCase()} is moving against your entry (₹${p.entryPrice.toFixed(2)} → ₹${price.toFixed(2)}), roughly halfway to your stop-loss (₹${p.stopLoss.toFixed(2)}). Not stopped out yet — just an early heads-up.`);
        }
      }
    }
    for (const a of alertsToCheck) {
      const price = a.optionMeta ? optionPrices[a.id] : prices[a.symbol];
      if (price == null) continue;
      a.lastPrice = price;
      const triggered = a.condition === 'above' ? price >= a.price : price <= a.price;
      if (triggered) { a.status = 'triggered'; a.telegramSent = true; notifications.push(`🔔 <b>Price alert</b> — ${a.symbol} ${a.condition==='above'?'crossed above':'crossed below'} ₹${a.price.toFixed(2)} (now ₹${price.toFixed(2)})`); }
    }

    try {
      await storeSet('store:positions', positions);
      await storeSet('store:price-alerts', priceAlerts);
    } catch (e) { /* Upstash not configured — nothing to persist, that's fine */ }

    for (const msg of notifications) {
      try { await sendTelegram(msg); } catch (e) { /* Telegram not configured or failed — keep going */ }
    }

    res.json({ checked: equitySymbols.length + optionAlerts.length, triggered: notifications.length, notifications });
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

// ============================================================
// OPTIONS CHAIN SCANNING (any F&O-enabled stock or index)
// "Signal" here means the standard OI-buildup classification
// traders actually use for options — Long/Short Buildup, Long
// Unwinding, Short Covering — derived from price direction + OI
// direction together, NOT an RSI/MACD-style indicator (those
// don't translate meaningfully to option premiums).
//
// OI change needs a "before" snapshot to compare against. We
// keep our own snapshot in Upstash (refreshed each scan) rather
// than relying on an unverified historical-OI endpoint, so the
// very first scan of a symbol+expiry has no signal yet — that's
// expected, not a bug — and every scan after that does.
// ============================================================
async function resolveInstrumentKey(symbol) {
  if (UPSTOX_INDEX_KEYS[symbol]) return UPSTOX_INDEX_KEYS[symbol];
  if (!universeCache.data) { try { await fetchAndCacheUniverse(); } catch (e) { /* fall through */ } }
  const hit = universeCache.data && universeCache.data.find(s => s.symbol === symbol);
  if (hit && hit.instrument_key) return hit.instrument_key;
  throw new Error(`Could not resolve an Upstox instrument key for "${symbol}" — it may not be F&O-enabled, or the stock universe hasn't loaded yet.`);
}

function classifyBuildup(priceChangePct, oiChangePct) {
  if (oiChangePct == null || priceChangePct == null) return 'No comparison yet';
  const priceUp = priceChangePct > 0.5, priceDown = priceChangePct < -0.5;
  const oiUp = oiChangePct > 2, oiDown = oiChangePct < -2;
  if (priceUp && oiUp) return 'Long Buildup';
  if (priceDown && oiUp) return 'Short Buildup';
  if (priceDown && oiDown) return 'Long Unwinding';
  if (priceUp && oiDown) return 'Short Covering';
  return 'Neutral';
}

app.get('/api/options/chain/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const instrumentKey = await resolveInstrumentKey(symbol);
    const expiry = req.query.expiry || await nearestExpiry(instrumentKey);
    const chainData = await upstoxGet(`/option/chain?instrument_key=${encodeURIComponent(instrumentKey)}&expiry_date=${expiry}`);

    const snapshotKey = `optionsnapshot:${instrumentKey}:${expiry}`;
    const prevSnapshot = await storeGet(snapshotKey, null);
    const prevByStrike = {};
    if (prevSnapshot) prevSnapshot.strikes.forEach(s => { prevByStrike[s.strike] = s; });

    const strikes = (chainData || []).map(row => {
      const ce = row.call_options?.market_data || {};
      const pe = row.put_options?.market_data || {};
      const prev = prevByStrike[row.strike_price];

      function withSignal(curr, prevSide) {
        if (!prev || !prevSide || curr.ltp == null || prevSide.ltp == null) {
          return { ltp: curr.ltp, oi: curr.oi, signal: 'No comparison yet' };
        }
        const priceChangePct = prevSide.ltp ? ((curr.ltp - prevSide.ltp) / prevSide.ltp) * 100 : null;
        const oiChangePct = prevSide.oi ? ((curr.oi - prevSide.oi) / prevSide.oi) * 100 : null;
        return { ltp: curr.ltp, oi: curr.oi, priceChangePct, oiChangePct, signal: classifyBuildup(priceChangePct, oiChangePct) };
      }
      return {
        strike: row.strike_price,
        ce: withSignal(ce, prev && prev.ce),
        pe: withSignal(pe, prev && prev.pe)
      };
    });

    try {
      await storeSet(snapshotKey, { time: Date.now(), strikes: strikes.map(s => ({ strike: s.strike, ce: { ltp: s.ce.ltp, oi: s.ce.oi }, pe: { ltp: s.pe.ltp, oi: s.pe.oi } })) });
    } catch (e) { /* Upstash not configured — signals just won't have a "before" to compare next time */ }

    res.json({ symbol, expiry, strikes, hasComparison: !!prevSnapshot });
  } catch (e) {
    res.status(502).json({ error: e.message, symbol: req.params.symbol });
  }
});

app.get('/api/options/expiries/:symbol', async (req, res) => {
  try {
    const instrumentKey = await resolveInstrumentKey(req.params.symbol);
    const contracts = await upstoxGet(`/option/contract?instrument_key=${encodeURIComponent(instrumentKey)}`);
    const expiries = [...new Set(contracts.map(c => c.expiry))].sort();
    res.json({ symbol: req.params.symbol, expiries });
  } catch (e) {
    res.status(502).json({ error: e.message, symbol: req.params.symbol });
  }
});


app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\nDashboard running at http://localhost:${PORT}`);
  console.log(`Live data proxied from Yahoo Finance (cache TTL ${CACHE_TTL_MS / 1000}s)\n`);
});
