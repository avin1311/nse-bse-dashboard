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
  const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const closes = quote.close || [];
  const opens = quote.open || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const volumes = quote.volume || [];
  const series = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] != null) {
      series.push({
        t: timestamps[i], c: closes[i],
        o: opens[i] != null ? opens[i] : closes[i],
        h: highs[i] != null ? highs[i] : closes[i],
        l: lows[i] != null ? lows[i] : closes[i],
        v: volumes[i] != null ? volumes[i] : 0
      });
    }
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

// ============================================================
// UPSTOX LTPC LIVE QUOTE
// Upstox's LTPC (Last Trade Price + Change) endpoint gives the
// real last-traded price in near-real-time via REST — no WebSocket
// complexity, no Protobuf decoding, works fine on Render's free tier.
// Tries Upstox first (faster, exchange-direct), falls back to Yahoo
// if the token isn't set or Upstox errors.
// ============================================================
const ltpcCache = {};
const LTPC_TTL = 5000; // 5 second local cache so rapid UI refreshes don't hammer the API

async function getUpstoxLTPC(instrumentKey) {
  const now = Date.now();
  if (ltpcCache[instrumentKey] && now - ltpcCache[instrumentKey].time < LTPC_TTL) {
    return { ...ltpcCache[instrumentKey].data, cached: true };
  }
  const data = await upstoxGet(`/market-quote/ltp?instrument_key=${encodeURIComponent(instrumentKey)}`);
  // Upstox returns { [instrumentKey]: { last_price, ohlc: { close } } }
  const entry = data && data[instrumentKey.replace('|', ':')];
  if (!entry) throw new Error('No LTPC data returned for ' + instrumentKey);
  const price = entry.last_price;
  const prevClose = entry.ohlc?.close || price;
  const changePct = prevClose ? ((price - prevClose) / prevClose * 100) : 0;
  const result = { price, prevClose, changePct, source: 'upstox' };
  ltpcCache[instrumentKey] = { data: result, time: now };
  return result;
}

// Live quote endpoint — used by the price ticker and Home page index cards.
// Symbol can be an equity symbol (RELIANCE, TCS etc.) or a Yahoo Finance
// index symbol (^NSEI, ^BSESN etc. — those always fall through to Yahoo
// since they're not Upstox instrument keys).
app.get('/api/quote/:symbol', async (req, res) => {
  const sym = req.params.symbol;
  // Index symbols (start with ^) always use Yahoo — not in the Upstox instruments format
  if (!sym.startsWith('^') && process.env.UPSTOX_ACCESS_TOKEN) {
    try {
      // Resolve the instrument key from the universe cache if available
      let instrumentKey = UPSTOX_INDEX_KEYS[sym];
      if (!instrumentKey) {
        if (!universeCache.data) await fetchAndCacheUniverse().catch(() => {});
        const hit = universeCache.data && universeCache.data.find(s => s.symbol === sym);
        if (hit && hit.instrument_key) instrumentKey = hit.instrument_key;
      }
      if (instrumentKey) {
        const data = await getUpstoxLTPC(instrumentKey);
        return res.json(data);
      }
    } catch (e) { /* fall through to Yahoo */ }
  }
  // Yahoo fallback — always used for index symbols and when Upstox not configured
  try {
    const ySymbol = sym.startsWith('^') ? sym : sym + '.NS';
    const data = await getChartData(ySymbol, '1d', '5m');
    if (!data || data.price == null) return res.status(502).json({ error: 'No price data' });
    const changePct = data.prevClose ? ((data.price - data.prevClose) / data.prevClose * 100) : 0;
    res.json({ price: data.price, prevClose: data.prevClose, changePct, marketState: data.marketState, source: 'yahoo' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
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
// UPSTOX WEBSOCKET → SERVER-SENT EVENTS LIVE FEED
// ============================================================
let UpstoxClient;
try { UpstoxClient = require('upstox-js-sdk'); } catch(e) { console.warn('upstox-js-sdk not installed — WebSocket feed unavailable'); }

let upstoxStreamer = null;
let streamerConnected = false;
const sseClients = new Map();
const latestPrices = new Map();
let streamerRetryTimer = null;

function initUpstoxAuth() {
  if (!UpstoxClient) return false;
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  if (!token) return false;
  const defaultClient = UpstoxClient.ApiClient.instance;
  const OAUTH2 = defaultClient.authentications['OAUTH2'];
  OAUTH2.accessToken = token;
  return true;
}

function allSubscribedKeys() {
  const keys = new Set();
  sseClients.forEach(client => client.symbols.forEach(k => keys.add(k)));
  return Array.from(keys);
}

function broadcastPrice(instrumentKey, data) {
  latestPrices.set(instrumentKey, { ...data, time: Date.now() });
  const payload = JSON.stringify({ instrumentKey, ...data });
  sseClients.forEach(client => {
    if (client.symbols.has(instrumentKey)) {
      try { client.res.write(`data: ${payload}\n\n`); } catch (e) {}
    }
  });
}

function startUpstoxStreamer(instrumentKeys) {
  if (!initUpstoxAuth()) return;
  if (!instrumentKeys.length) return;
  if (upstoxStreamer) { try { upstoxStreamer.disconnect(); } catch (e) {} upstoxStreamer = null; }
  streamerConnected = false;
  clearTimeout(streamerRetryTimer);

  try {
    upstoxStreamer = new UpstoxClient.MarketDataStreamerV3(instrumentKeys, 'ltpc');

    upstoxStreamer.on('open', () => {
      streamerConnected = true;
      console.log('Upstox WebSocket connected, streaming', instrumentKeys.length, 'instruments');
    });

    upstoxStreamer.on('message', (data) => {
      try {
        const feeds = data?.feeds || {};
        Object.entries(feeds).forEach(([key, feed]) => {
          const ltpc = feed?.ltpc;
          if (!ltpc) return;
          const price = ltpc.ltp;
          const prevClose = ltpc.cp || price;
          const changePct = prevClose ? ((price - prevClose) / prevClose * 100) : 0;
          broadcastPrice(key, { price, changePct, source: 'upstox-ws' });
        });
      } catch (e) {}
    });

    upstoxStreamer.on('close', (code) => {
      streamerConnected = false;
      // 401 = wrong token type — Analytics Token can't do WebSocket streaming.
      // Don't retry in a tight loop — the REST /api/quote endpoint still works.
      if (code === 401 || code === 4001) {
        console.warn('Upstox WebSocket 401 — Analytics Token lacks streaming permission. Live REST quotes still work via /api/quote. For 1s WebSocket feed, use a full OAuth access token (generated daily via Upstox login flow).');
        upstoxStreamer = null;
        return; // no retry for auth failures
      }
      console.log('Upstox WebSocket closed — retrying in 10s');
      streamerRetryTimer = setTimeout(() => {
        const keys = allSubscribedKeys();
        if (keys.length) startUpstoxStreamer(keys);
      }, 10000);
    });

    upstoxStreamer.on('error', (e) => {
      const msg = typeof e === 'object' ? (e.message || JSON.stringify(e)) : String(e);
      // 401 on the error event — same as close with code 401
      if (msg.includes('401')) {
        console.warn('Upstox WebSocket 401 — Analytics Token lacks streaming permission. Falling back to REST polling.');
        streamerConnected = false;
        upstoxStreamer = null;
        return;
      }
      console.error('Upstox WebSocket error:', msg);
    });

    upstoxStreamer.connect();
  } catch (e) {
    console.error('Failed to start Upstox streamer:', e.message);
    upstoxStreamer = null;
  }
}

// Resolve an equity symbol to its Upstox instrument key via the universe cache
async function symbolToInstrumentKey(symbol) {
  if (UPSTOX_INDEX_KEYS[symbol]) return UPSTOX_INDEX_KEYS[symbol];
  // Check hardcoded EQ keys first — instant, no network needed
  const normalized = symbol.replace(/[&-]/g, '_'); // handle M&M, BAJAJ-AUTO etc.
  if (HARDCODED_EQ_KEYS[symbol]) return HARDCODED_EQ_KEYS[symbol];
  if (HARDCODED_EQ_KEYS[normalized]) return HARDCODED_EQ_KEYS[normalized];
  // Fall through to universe cache
  if (!universeCache.data) await fetchAndCacheUniverse().catch(() => {});
  const hit = universeCache.data && universeCache.data.find(s => s.symbol === symbol);
  return hit && hit.instrument_key ? hit.instrument_key : null;
}

// SSE endpoint — browser opens this to receive 1s price updates
app.get('/api/stream', async (req, res) => {
  if (!process.env.UPSTOX_ACCESS_TOKEN || !UpstoxClient) {
    return res.status(503).json({ error: 'Upstox streaming not configured — UPSTOX_ACCESS_TOKEN missing' });
  }

  const rawSymbols = (req.query.symbols || '').split(',').filter(Boolean);
  if (!rawSymbols.length) return res.status(400).json({ error: 'symbols param required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clientId = Date.now() + '-' + Math.random().toString(36).slice(2);
  const clientSymbols = new Set();
  sseClients.set(clientId, { res, symbols: clientSymbols });

  // Resolve instrument keys — fetch universe if needed, then start streaming
  (async () => {
    const instrumentKeys = [];
    for (const sym of rawSymbols) {
      const key = sym.includes('|') ? sym : await symbolToInstrumentKey(sym).catch(() => null);
      if (key) { instrumentKeys.push(key); clientSymbols.add(key); }
    }

    if (!instrumentKeys.length) {
      // Can't resolve yet — send a REST quote as a one-off so browser at least gets current price
      for (const sym of rawSymbols) {
        try {
          const ySymbol = sym + '.NS';
          const data = await getChartData(ySymbol, '1d', '5m');
          if (data && data.price) {
            const changePct = data.prevClose ? ((data.price - data.prevClose) / data.prevClose * 100) : 0;
            const payload = JSON.stringify({ instrumentKey: sym, price: data.price, changePct, source: 'yahoo-fallback' });
            try { res.write(`data: ${payload}\n\n`); } catch (_) {}
          }
        } catch (e) {}
      }
      // Retry resolution after 5s (universe may finish loading by then)
      setTimeout(async () => {
        for (const sym of rawSymbols) {
          const key = await symbolToInstrumentKey(sym).catch(() => null);
          if (key && !clientSymbols.has(key)) {
            clientSymbols.add(key);
            if (streamerConnected && upstoxStreamer) {
              try { upstoxStreamer.subscribe([key], 'ltpc'); } catch (e) {}
            }
          }
        }
        const keys = allSubscribedKeys();
        if (keys.length && (!upstoxStreamer || !streamerConnected)) startUpstoxStreamer(keys);
      }, 5000);
      return;
    }

    // Send cached prices immediately
    instrumentKeys.forEach(key => {
      const cached = latestPrices.get(key);
      if (cached) try { res.write(`data: ${JSON.stringify({ instrumentKey: key, ...cached })}\n\n`); } catch (_) {}
    });

    if (streamerConnected && upstoxStreamer) {
      const newKeys = instrumentKeys.filter(k => !latestPrices.has(k));
      if (newKeys.length) try { upstoxStreamer.subscribe(newKeys, 'ltpc'); } catch (e) {}
    } else {
      startUpstoxStreamer(allSubscribedKeys());
    }
  })();

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); }
  }, 20000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(clientId);
    if (sseClients.size === 0 && upstoxStreamer) {
      clearTimeout(streamerRetryTimer);
      try { upstoxStreamer.disconnect(); } catch (e) {}
      upstoxStreamer = null;
      streamerConnected = false;
      console.log('All SSE clients gone — Upstox WebSocket disconnected');
    }
  });
});

// Debug endpoint — shows streamer status and what's being subscribed
app.get('/api/stream/status', (req, res) => {
  res.json({
    streamerConnected,
    activeClients: sseClients.size,
    subscribedKeys: allSubscribedKeys(),
    cachedPrices: Array.from(latestPrices.keys()),
    upstoxTokenSet: !!process.env.UPSTOX_ACCESS_TOKEN,
    sdkLoaded: !!UpstoxClient
  });
});




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

async function fetchRawInstrumentFile(exchange) {
  const url = `https://assets.upstox.com/market-quote/instruments/exchange/${exchange}.json.gz`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Upstox instruments file (${exchange}) responded ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const json = zlib.gunzipSync(buf).toString('utf8');
  return JSON.parse(json);
}
async function fetchInstrumentFile(exchange) {
  const list = await fetchRawInstrumentFile(exchange);
  // Keep only plain equities — the same file also bundles F&O contracts,
  // indices, etc., which we don't want cluttering the equity search list.
  return list.filter(row => row.instrument_type === 'EQ' && row.trading_symbol);
}

// Some of our hardcoded index instrument_key guesses (see UPSTOX_INDEX_KEYS)
// turned out wrong on the real API — expected, since I couldn't verify them
// without a live account. Rather than guess again blindly, this searches
// Upstox's own instruments file for an index whose name matches, so it
// self-corrects instead of needing another manual fix each time.
let indexNameCache = { data: null, time: 0 };
async function findIndexInstrumentKey(keywords) {
  if (!indexNameCache.data || Date.now() - indexNameCache.time > UNIVERSE_TTL_MS) {
    const [nse, bse] = await Promise.all([
      fetchRawInstrumentFile('NSE').catch(() => []),
      fetchRawInstrumentFile('BSE').catch(() => [])
    ]);
    // Indices sit in a distinct segment from plain equities (which are
    // NSE_EQ/BSE_EQ) — keep anything that isn't equity or a derivative
    // contract, then match by name below.
    indexNameCache = {
      data: [...nse, ...bse].filter(r => r.instrument_type && r.instrument_type !== 'EQ' && !['FUT', 'CE', 'PE'].includes(r.instrument_type) && r.name),
      time: Date.now()
    };
  }
  const upper = k => k.toUpperCase();
  const match = indexNameCache.data.find(r => keywords.every(k => upper(r.name).includes(upper(k))));
  if (!match) throw new Error(`No index matching [${keywords.join(', ')}] found in Upstox's instruments file`);
  return match.instrument_key;
}
// Fallback name-keywords for indices whose hardcoded key might be wrong —
// used only if the hardcoded UPSTOX_INDEX_KEYS guess fails against the
// live API for that symbol.
const INDEX_NAME_FALLBACK = {
  NIFTYIT: ['NIFTY', 'IT'],
  MIDCPNIFTY: ['MIDCAP'],
  FINNIFTY: ['FIN'],
  BANKEX: ['BANKEX'],
  NIFTYNXT50: ['NEXT', '50']
};

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

// ============================================================
// UPSTOX OAUTH TOKEN REFRESH FLOW
// The WebSocket streaming API requires a full OAuth access token
// (not the Analytics Token which only covers REST endpoints).
// This flow lets you refresh it from your dashboard without
// manually copying tokens — visit /upstox-login to start.
// Requires UPSTOX_API_KEY and UPSTOX_API_SECRET env vars
// (from your Upstox developer app settings).
// ============================================================
app.get('/upstox-login', (req, res) => {
  const apiKey = process.env.UPSTOX_API_KEY;
  const redirectUri = process.env.UPSTOX_REDIRECT_URI || `https://nse-bse-dashboard.onrender.com/upstox-callback`;
  if (!apiKey) return res.send('<h2>Set UPSTOX_API_KEY in Render environment variables first.</h2>');
  const authUrl = `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${apiKey}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(authUrl);
});

app.get('/upstox-callback', async (req, res) => {
  const { code } = req.query;
  const apiKey = process.env.UPSTOX_API_KEY;
  const apiSecret = process.env.UPSTOX_API_SECRET;
  const redirectUri = process.env.UPSTOX_REDIRECT_URI || `https://nse-bse-dashboard.onrender.com/upstox-callback`;
  if (!code || !apiKey || !apiSecret) return res.send('<h2>Missing code or API credentials. Check UPSTOX_API_KEY and UPSTOX_API_SECRET in Render.</h2>');
  try {
    const resp = await fetch('https://api.upstox.com/v2/login/authorization/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({ code, client_id: apiKey, client_secret: apiSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' })
    });
    const data = await resp.json();
    if (!data.access_token) throw new Error(JSON.stringify(data));
    const token = data.access_token;
    // Update the running server's token immediately — no restart needed
    process.env.UPSTOX_ACCESS_TOKEN = token;
    if (UpstoxClient) initUpstoxAuth();
    // Restart streamer with new token if clients are waiting
    const keys = allSubscribedKeys();
    if (keys.length) startUpstoxStreamer(keys);
    res.send(`<html><body style="font-family:monospace;background:#0b0f17;color:#e0e6f0;padding:32px;">
      <h2 style="color:#26c281">✓ Upstox OAuth token generated successfully</h2>
      <p>The server is now using the new token for WebSocket streaming. This token is valid until midnight IST.</p>
      <p style="color:#8a94a6;font-size:12px;">Token (first 20 chars): ${token.slice(0,20)}...</p>
      <p><strong>To make this permanent until midnight:</strong> copy the full token below and update UPSTOX_ACCESS_TOKEN in Render → Environment. The server is already using it for this session.</p>
      <details><summary style="cursor:pointer;color:#3d8bfd">Show full token</summary><pre style="word-break:break-all;font-size:11px;">${token}</pre></details>
      <br><a href="/" style="color:#3d8bfd">← Back to dashboard</a>
    </body></html>`);
  } catch (e) {
    res.send(`<h2>Token exchange failed: ${e.message}</h2><p>Check UPSTOX_API_KEY and UPSTOX_API_SECRET.</p>`);
  }
});


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

// Hardcoded NSE_EQ instrument keys for the most commonly opened stocks.
// These follow the pattern NSE_EQ|<ISIN> and are used as a fallback when
// the Upstox instruments file hasn't loaded yet (or fails to fetch on Render).
// Format: NSE_EQ|<ISIN> — ISINs are permanent and never change for a stock.
const HARDCODED_EQ_KEYS = {
  RELIANCE:   'NSE_EQ|INE002A01018',
  TCS:        'NSE_EQ|INE467B01029',
  HDFCBANK:   'NSE_EQ|INE040A01034',
  INFY:       'NSE_EQ|INE009A01021',
  ICICIBANK:  'NSE_EQ|INE090A01021',
  SBIN:       'NSE_EQ|INE062A01020',
  HINDUNILVR: 'NSE_EQ|INE030A01027',
  ITC:        'NSE_EQ|INE154A01025',
  KOTAKBANK:  'NSE_EQ|INE237A01028',
  LT:         'NSE_EQ|INE018A01030',
  BHARTIARTL: 'NSE_EQ|INE397D01024',
  AXISBANK:   'NSE_EQ|INE238A01034',
  BAJFINANCE: 'NSE_EQ|INE296A01024',
  MARUTI:     'NSE_EQ|INE585B01010',
  TATAMOTORS: 'NSE_EQ|INE155A01022',
  WIPRO:      'NSE_EQ|INE075A01022',
  ULTRACEMCO: 'NSE_EQ|INE481G01011',
  SUNPHARMA:  'NSE_EQ|INE044A01036',
  ASIANPAINT: 'NSE_EQ|INE021A01026',
  NESTLEIND:  'NSE_EQ|INE239A01024',
  APOLLOHOSP: 'NSE_EQ|INE437A01024',
  ZOMATO:     'NSE_EQ|INE758T01015',
  ADANIENT:   'NSE_EQ|INE423A01024',
  ADANIPORTS: 'NSE_EQ|INE742F01042',
  HCLTECH:    'NSE_EQ|INE860A01027',
  ONGC:       'NSE_EQ|INE213A01029',
  POWERGRID:  'NSE_EQ|INE752E01010',
  NTPC:       'NSE_EQ|INE733E01010',
  TITAN:      'NSE_EQ|INE280A01028',
  BAJAJFINSV: 'NSE_EQ|INE918I01026',
  JSWSTEEL:   'NSE_EQ|INE019A01038',
  TATASTEEL:  'NSE_EQ|INE081A01020',
  GRASIM:     'NSE_EQ|INE047A01021',
  CIPLA:      'NSE_EQ|INE059A01026',
  DRREDDY:    'NSE_EQ|INE089A01023',
  EICHERMOT:  'NSE_EQ|INE066A01021',
  BPCL:       'NSE_EQ|INE029A01011',
  TECHM:      'NSE_EQ|INE669C01036',
  HINDALCO:   'NSE_EQ|INE038A01020',
  SBILIFE:    'NSE_EQ|INE330G01039',
  M_M:        'NSE_EQ|INE101A01026', // M&M
  INDUSINDBK: 'NSE_EQ|INE095A01012',
  HDFCLIFE:   'NSE_EQ|INE795G01014',
  DIVISLAB:   'NSE_EQ|INE361B01024',
  COALINDIA:  'NSE_EQ|INE522F01014',
  BAJAJ_AUTO: 'NSE_EQ|INE917I01010',
  VEDL:       'NSE_EQ|INE205A01025',
  HAL:        'NSE_EQ|INE066F01012',
  BEL:        'NSE_EQ|INE263A01024',
  DLF:        'NSE_EQ|INE271C01023',
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

async function fetchFnoSnapshot(instrumentKey) {
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
  return { expiry, spot, pcr: pcrData.pcr, maxPain: maxPainData.max_pain, totalCallOi, totalPutOi, atmIv };
}

// ============================================================
// UPSTOX FUNDAMENTALS API
// Real P/E, P/B, ROE, ROCE, EPS, Market Cap, etc. from Upstox.
// Requires UPSTOX_ACCESS_TOKEN (Analytics Token covers this).
// Cached for 6 hours since fundamentals don't change intraday.
// ============================================================
const fundamentalsCache = {};
const FUNDAMENTALS_TTL = 6 * 60 * 60 * 1000; // 6 hours

// Extract ISIN from the instrument key (NSE_EQ|INE002A01018 → INE002A01018)
function isinFromKey(instrumentKey) {
  if (!instrumentKey) return null;
  const parts = instrumentKey.split('|');
  return parts.length > 1 ? parts[1] : null;
}

async function getUpstoxFundamentals(symbol) {
  const now = Date.now();
  if (fundamentalsCache[symbol] && now - fundamentalsCache[symbol].time < FUNDAMENTALS_TTL) {
    return { ...fundamentalsCache[symbol].data, cached: true };
  }
  const instrumentKey = HARDCODED_EQ_KEYS[symbol] || (universeCache.data && universeCache.data.find(s => s.symbol === symbol)?.instrument_key);
  if (!instrumentKey) throw new Error(`No instrument key found for ${symbol}`);
  const isin = isinFromKey(instrumentKey);
  if (!isin) throw new Error(`Could not extract ISIN from instrument key: ${instrumentKey}`);

  const [ratiosData, profileData] = await Promise.allSettled([
    upstoxGet(`/fundamentals/${isin}/key-ratios`),
    upstoxGet(`/fundamentals/${isin}/profile`)
  ]);

  const ratios = ratiosData.status === 'fulfilled' ? ratiosData.value : null;
  const profile = profileData.status === 'fulfilled' ? profileData.value : null;

  const result = {
    symbol,
    isin,
    // Key ratios
    pe: ratios?.pe_ratio?.company ?? null,
    peSector: ratios?.pe_ratio?.sector ?? null,
    pb: ratios?.pb_ratio?.company ?? null,
    pbSector: ratios?.pb_ratio?.sector ?? null,
    roe: ratios?.roe?.company ?? null,
    roeSector: ratios?.roe?.sector ?? null,
    roce: ratios?.roce?.company ?? null,
    roceSector: ratios?.roce?.sector ?? null,
    roa: ratios?.roa?.company ?? null,
    evEbitda: ratios?.ev_ebitda?.company ?? null,
    debtEquity: ratios?.debt_to_equity?.company ?? null,
    currentRatio: ratios?.current_ratio?.company ?? null,
    eps: ratios?.eps ?? null,
    dividendYield: ratios?.dividend_yield ?? null,
    // Company profile
    marketCap: profile?.market_cap ?? null,
    sector: profile?.sector ?? null,
    industry: profile?.industry ?? null,
    description: profile?.description ?? null,
    founded: profile?.founded ?? null,
    employees: profile?.total_employees ?? null,
    website: profile?.website ?? null,
    source: 'upstox'
  };

  fundamentalsCache[symbol] = { data: result, time: now };
  return result;
}

app.get('/api/fundamentals/:symbol', async (req, res) => {
  try {
    const data = await getUpstoxFundamentals(req.params.symbol);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message, symbol: req.params.symbol });
  }
});

app.get('/api/upstox/fno/:index', async (req, res) => {
  const indexSymbol = req.params.index;
  if (!UPSTOX_INDEX_KEYS[indexSymbol]) return res.status(400).json({ error: 'Unknown index symbol', symbol: indexSymbol });
  try {
    const instrumentKey = await resolveInstrumentKey(indexSymbol); // self-heals via name search if our hardcoded guess is wrong
    const snap = await fetchFnoSnapshot(instrumentKey);
    const healed = instrumentKey !== UPSTOX_INDEX_KEYS[indexSymbol];
    return res.json({ symbol: indexSymbol, ...snap, source: healed ? 'upstox-real-selfhealed' : 'upstox-real' });
  } catch (e) {
    return res.status(502).json({ error: e.message, symbol: indexSymbol });
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
  if (UPSTOX_INDEX_KEYS[symbol]) {
    const primary = UPSTOX_INDEX_KEYS[symbol];
    try {
      await nearestExpiry(primary); // cheap validity check against the real API
      return primary;
    } catch (e) {
      const keywords = INDEX_NAME_FALLBACK[symbol];
      if (!keywords) throw e; // no fallback keywords configured for this one — surface the original error
      return await findIndexInstrumentKey(keywords); // self-heal by name search instead of needing another manual fix
    }
  }
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
  // Pre-warm the stock universe cache so instrument key resolution works
  // immediately when the first SSE client connects, rather than adding a
  // cold-start delay to the first live feed request.
  setTimeout(() => {
    fetchAndCacheUniverse()
      .then(stocks => console.log(`Universe cache warmed: ${stocks.length} stocks loaded`))
      .catch(e => console.warn('Universe pre-warm failed (will retry on first request):', e.message));
  }, 3000); // 3s delay gives the server time to fully start before the fetch
});
