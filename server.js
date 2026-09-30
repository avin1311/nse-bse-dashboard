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

const compression = require('compression');
const { AsyncLocalStorage } = require('async_hooks');
const lowPriority = new AsyncLocalStorage(); // background work (scans) runs in this lane so a user's click is never queued behind it

const app = express();
// Instant health check (no upstream calls) — point an uptime pinger here to keep the free Render instance awake
app.get('/healthz', (req, res) => { res.set('Cache-Control', 'no-store'); res.type('text/plain').send('ok'); });
// gzip/deflate every text response (the page alone is ~325 KB uncompressed); never buffer the live SSE stream
app.use(compression({ filter: (req, res) => (req.path.startsWith('/api/stream') ? false : compression.filter(req, res)) }));
// tiny response caches so many tabs / rapid clicks share one upstream call
function microCache(ttl) {
  const store = new Map();
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    const k = req.originalUrl, hit = store.get(k);
    if (hit && Date.now() - hit.t < ttl) return res.status(hit.status).json(hit.body);
    const oj = res.json.bind(res);
    res.json = (b) => { if (res.statusCode < 400) { store.set(k, { t: Date.now(), status: res.statusCode, body: b }); if (store.size > 600) store.delete(store.keys().next().value); } return oj(b); };
    next();
  };
}
app.use('/api/quote', microCache(4000));
app.use('/api/upstox/fno', microCache(60000));
app.use('/api/news', microCache(5 * 60000));
app.use('/api/shareholding', microCache(30 * 60000));
app.use('/api/fundamentals', microCache(10 * 60000));

// ============================================================
// SECURITY: optional passcode, rate limiting, basic headers, health tracking
// ============================================================
app.use(express.json({ limit: '1mb' }));
const crypto = require('crypto');
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'geolocation=(), camera=(), microphone=()' });
  next();
});
function makeLimiter(windowMs, max) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now(); const k = req.ip || 'x';
    let h = hits.get(k); if (!h || now - h.start > windowMs) { h = { start: now, n: 0 }; hits.set(k, h); }
    if (++h.n > max) { res.set('Retry-After', String(Math.ceil((h.start + windowMs - now) / 1000))); return res.status(429).json({ error: 'Too many requests — slow down and retry shortly' }); }
    next();
  };
}
const apiLimiter = makeLimiter(60000, 900);          // generous: the dashboard itself makes many calls
const authLimiter = makeLimiter(15 * 60000, 10);     // passcode guesses
app.use('/api', (req, res, next) => (req.path.startsWith('/stream') ? next() : apiLimiter(req, res, next)));

const PASSCODE = process.env.DASHBOARD_PASSCODE || '';
const authToken = () => crypto.createHash('sha256').update('dash-v1|' + PASSCODE).digest('hex');
function readCookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
function safeEq(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); }
const isAuthed = req => !PASSCODE || safeEq(readCookie(req, 'dash_auth'), authToken());
app.get('/api/auth/status', (req, res) => res.json({ required: !!PASSCODE, ok: isAuthed(req) }));
app.post('/api/auth', authLimiter, (req, res) => {
  if (!PASSCODE) return res.json({ ok: true, required: false });
  const given = String((req.body && req.body.passcode) || '');
  if (!safeEq(crypto.createHash('sha256').update(given).digest('hex'), crypto.createHash('sha256').update(PASSCODE).digest('hex'))) return res.status(401).json({ error: 'Wrong passcode' });
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.set('Set-Cookie', `dash_auth=${authToken()}; Path=/; Max-Age=${30 * 86400}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.set('Set-Cookie', 'dash_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'); res.json({ ok: true }); });
// everything under /api needs the passcode (when one is set), except auth itself and the secret-protected alert check
app.use('/api', (req, res, next) => {
  if (!PASSCODE || req.path.startsWith('/auth') || req.path === '/logout') return next();
  if (req.path === '/check-alerts' && process.env.CHECK_ALERTS_SECRET) return next(); // has its own secret gate
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'auth required', authRequired: true });
});
// health bookkeeping for the status panel
const HEALTH = { upstox: { lastOk: 0, lastErr: '', lastErrAt: 0 }, telegram: { lastSent: 0, lastErr: '', lastErrAt: 0, lastTestAt: 0 }, alerts: { lastRun: 0, lastTriggered: 0, lastSentAt: 0 }, startedAt: Date.now() };
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
// ============================================================
// NEWS ENDPOINT — Real RSS feed from Economic Times Markets
// Fetches and parses RSS XML, filters for the stock symbol,
// returns up to 8 relevant headlines with basic sentiment.
// ============================================================
const newsCache = {};
const NEWS_TTL = 15 * 60 * 1000; // 15 minutes

function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || block.match(/<title>(.*?)<\/title>/))?.[1]?.trim() || '';
    const link = (block.match(/<link>(.*?)<\/link>/) || block.match(/<guid[^>]*>(.*?)<\/guid>/))?.[1]?.trim() || '';
    const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/))?.[1]?.trim() || '';
    const desc = (block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) || block.match(/<description>(.*?)<\/description>/))?.[1]?.trim() || '';
    if (title) items.push({ title, link, pubDate: pubDate ? new Date(pubDate).toLocaleDateString('en-IN', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) : 'Today', description: desc });
  }
  return items;
}

function getSentiment(text) {
  const t = text.toLowerCase();
  const pos = ['gain','rise','surge','jump','rally','profit','growth','beat','up','high','positive','strong','buy','bullish','record'];
  const neg = ['fall','drop','decline','loss','crash','down','weak','miss','sell','bearish','concern','risk','low','negative'];
  const posScore = pos.filter(w => t.includes(w)).length;
  const negScore = neg.filter(w => t.includes(w)).length;
  if (posScore > negScore) return 'Positive';
  if (negScore > posScore) return 'Negative';
  return 'Neutral';
}

// ---- News: stock-specific headlines (Google News RSS) + market feeds (ET, Moneycontrol), newest first ----
function decodeEnt(t){
  return String(t||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
    .replace(/&#(\d+);/g,(m,n)=>String.fromCharCode(+n)).replace(/&nbsp;/g,' ').replace(/&amp;/g,'&');
}
function stripTags(t){ return decodeEnt(t).replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim(); }
function parseNewsFeed(xml, defaultSource) {
  const out = [];
  const re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const g = tag => { const x = b.match(new RegExp('<'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+tag+'>')); return x ? x[1] : ''; };
    let title = stripTags(g('title')); if (!title) continue;
    let source = stripTags(g('source')) || defaultSource;
    // Google News titles end with " - Publisher"
    const dash = title.lastIndexOf(' - ');
    if (dash > 20 && (!source || source === defaultSource || title.slice(dash+3) === source)) { source = title.slice(dash+3); title = title.slice(0, dash); }
    else if (dash > 20 && title.slice(dash+3) === source) title = title.slice(0, dash);
    const link = stripTags(g('link')) || stripTags(g('guid'));
    const ts = Date.parse(g('pubDate')) || 0;
    let desc = stripTags(g('description'));
    if (desc.toLowerCase().startsWith(title.toLowerCase().slice(0, 30))) desc = '';   // Google repeats the headline
    if (desc.length > 220) desc = desc.slice(0, 217).replace(/\s+\S*$/, '') + '…';
    out.push({ title, link, ts, source, description: desc });
  }
  return out;
}
async function fetchFeed(url, source) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; dashboard)' }, signal: AbortSignal.timeout(7000) });
    if (!r.ok) return [];
    return parseNewsFeed(await r.text(), source);
  } catch (e) { return []; }
}
const gnews = q => `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:7d')}&hl=en-IN&gl=IN&ceid=IN:en`;
const NEWS_FEEDS_GENERAL = [
  ['https://economictimes.indiatimes.com/markets/stocks/news/rssfeeds/2146842.cms', 'Economic Times'],
  ['https://www.moneycontrol.com/rss/latestnews.xml', 'Moneycontrol'],
  ['https://www.moneycontrol.com/rss/marketreports.xml', 'Moneycontrol']
];
app.get('/api/news/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const name = String(req.query.name || '').replace(/[^\w &.\-]/g, '').trim().slice(0, 60);
  const key = symbol + '|' + name;
  const now = Date.now();
  if (newsCache[key] && now - newsCache[key].time < NEWS_TTL) return res.json(newsCache[key].data);
  try {
    const isIndex = /^(NIFTY|BANKNIFTY|FINNIFTY|SENSEX|MIDCPNIFTY|INDIAVIX|NIFTY\w*|BSE\w*)$/.test(symbol) && !name;
    const q1 = isIndex ? `${symbol} Indian stock market` : `${name || symbol} share`;
    const queries = [[gnews(q1), 'Google News']];
    if (!isIndex) queries.push([gnews(`${symbol} NSE stock`), 'Google News']);
    const [specific, general] = await Promise.all([
      Promise.all(queries.map(([u, s]) => fetchFeed(u, s))).then(a => a.flat()),
      Promise.all(NEWS_FEEDS_GENERAL.map(([u, s]) => fetchFeed(u, s))).then(a => a.flat())
    ]);
    const words = [symbol.toLowerCase(), ...(name ? name.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !['limited','ltd','industries','india','corporation','company'].includes(w)) : [])];
    const mentions = it => { const t = (it.title + ' ' + it.description).toLowerCase(); return words.some(w => t.includes(w)); };
    const seen = new Set();
    const uniq = arr => arr.filter(it => { const k = it.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; });
    const spec = uniq(specific).sort((a, b) => b.ts - a.ts);
    const gen = uniq(general).sort((a, b) => b.ts - a.ts);
    const genRel = gen.filter(mentions);
    let items = [...spec, ...genRel].sort((a, b) => b.ts - a.ts).slice(0, 15).map(i => ({ ...i, scope: 'stock' }));
    // pad with the latest general market headlines if the stock itself has little news
    if (items.length < 8) items = items.concat(gen.filter(g => !genRel.includes(g)).slice(0, 8 - items.length).map(i => ({ ...i, scope: 'market' })));
    items = items.map(i => ({ ...i, pubDate: i.ts ? new Date(i.ts).toISOString() : '', sentiment: getSentiment(i.title + ' ' + i.description) }));
    const result = { symbol, items, fetchedAt: new Date().toISOString() };
    if (items.length) newsCache[key] = { data: result, time: now };
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message, items: [] });
  }
});

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
  // Full quote (has net_change + ohlc + volume); fall back to plain LTP if it fails
  let entry = null;
  try {
    const q = await upstoxGet(`/market-quote/quotes?instrument_key=${encodeURIComponent(instrumentKey)}`);
    entry = q && (q[instrumentKey.replace('|', ':')] || Object.values(q)[0]);
  } catch (e) { entry = null; }
  if (!entry) {
    const data = await upstoxGet(`/market-quote/ltp?instrument_key=${encodeURIComponent(instrumentKey)}`);
    entry = data && (data[instrumentKey.replace('|', ':')] || Object.values(data)[0]);
  }
  if (!entry) throw new Error('No quote returned for ' + instrumentKey);
  const price = entry.last_price;
  let prevClose = (entry.net_change != null && price != null) ? price - entry.net_change : (entry.cp || entry.ohlc?.close || price);
  const changePct = prevClose ? ((price - prevClose) / prevClose * 100) : 0;
  const result = { price, prevClose, changePct, dayHigh: entry.ohlc?.high, dayLow: entry.ohlc?.low, open: entry.ohlc?.open, volume: entry.volume, source: 'upstox' };
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
  if (upstoxTokens().length) {
    try {
      // Resolve the instrument key from the universe cache if available
      let instrumentKey = null;
      try { instrumentKey = await dataKeyFor(sym.startsWith('^') ? appSym(sym) : sym); } catch (e) { instrumentKey = null; }
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



// ============================================================
// REAL DAILY HISTORY FOR SIGNALS (batched, cached 30 min)
// The screener/stock signals are computed from these real closes
// instead of the seeded demo price series.
// ============================================================
const scanHistCache = {};
const SCAN_HIST_TTL = 30 * 60 * 1000;
async function getScanHistory(sym) {
  const c = scanHistCache[sym];
  if (c && Date.now() - c.time < SCAN_HIST_TTL) return c.data;
  let ser = null, source = 'upstox';
  try { const rows = await getUpstoxCandles(appSym(sym), '1D'); if (rows.length >= 30) ser = rows.slice(-250).map(r => ({ t: r.t, c: r.c, h: r.h, l: r.l, v: r.v })); } catch (e) { /* fall back to Yahoo */ }
  if (!ser) {
    source = 'yahoo';
    const parsed = await getChartData(sym, '1y', '1d');
    if (!parsed || !parsed.series || parsed.series.length < 30) throw new Error('insufficient history');
    ser = parsed.series.slice(-250);
  }
  const data = { c: ser.map(p => p.c), h: ser.map(p => p.h), l: ser.map(p => p.l), v: ser.map(p => p.v), t: ser.map(p => p.t), source };
  scanHistCache[sym] = { data, time: Date.now() };
  return data;
}
app.get('/api/scan-history', (req, res) => lowPriority.run(true, async () => {
  const symbols = (req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 60);
  if (!symbols.length) return res.status(400).json({ error: 'symbols required' });
  const out = {};
  let i = 0;
  async function worker() {
    while (i < symbols.length) {
      const sym = symbols[i++];
      try { out[sym] = await getScanHistory(sym); } catch (e) { out[sym] = { error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  res.json(out);
}));


// ============================================================
// SEASONALITY: real monthly closes (max history), cached 12h
// ============================================================
const seasCache = {};
const SEAS_TTL = 12 * 60 * 60 * 1000;
async function getSeasonality(sym) {
  const c = seasCache[sym];
  if (c && Date.now() - c.time < SEAS_TTL) return c.data;
  let ser = null, source = 'upstox';
  try { const rows = await getUpstoxCandles(appSym(sym), '1M'); if (rows.length >= 14) ser = rows; } catch (e) { /* fall back to Yahoo */ }
  if (!ser) {
    source = 'yahoo';
    const parsed = await getChartData(sym, 'max', '1mo');
    if (!parsed || !parsed.series || parsed.series.length < 14) throw new Error('insufficient monthly history');
    ser = parsed.series;
  }
  const data = { t: ser.map(p => p.t), c: ser.map(p => p.c), source };
  seasCache[sym] = { data, time: Date.now() };
  return data;
}
app.get('/api/seasonality-batch', (req, res) => lowPriority.run(true, async () => {
  const symbols = (req.query.symbols || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 40);
  if (!symbols.length) return res.status(400).json({ error: 'symbols required' });
  const out = {};
  let i = 0;
  async function worker() {
    while (i < symbols.length) {
      const sym = symbols[i++];
      try { out[sym] = await getSeasonality(sym); } catch (e) { out[sym] = { error: e.message }; }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  res.json(out);
}));

// ============================================================
// F&O-ENABLED UNDERLYINGS (from Upstox NSE instruments file), cached 24h
// ============================================================
const FNO_FALLBACK = ['RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK','SBIN','BHARTIARTL','ITC','LT','KOTAKBANK','AXISBANK','HINDUNILVR','BAJFINANCE','MARUTI','SUNPHARMA','TITAN','ASIANPAINT','ULTRACEMCO','NESTLEIND','WIPRO','HCLTECH','TECHM','POWERGRID','NTPC','ONGC','COALINDIA','TATAMOTORS','TATASTEEL','JSWSTEEL','HINDALCO','ADANIENT','ADANIPORTS','M&M','BAJAJFINSV','DRREDDY','CIPLA','DIVISLAB','EICHERMOT','HEROMOTOCO','BPCL','GRASIM','INDUSINDBK','BRITANNIA','APOLLOHOSP','TATACONSUM','SBILIFE','HDFCLIFE','BAJAJ-AUTO','UPL','VOLTAS','PIDILITIND','DLF','GAIL','IOC','VEDL','SAIL','PNB','BANKBARODA','CANBK','IDFCFIRSTB','FEDERALBNK','AUBANK','BANDHANBNK','TATAPOWER','TATACHEM','TVSMOTOR','ASHOKLEY','BHEL','BEL','HAL','IRCTC','ZOMATO','PAYTM','NAUKRI','DMART','SIEMENS','ABB','HAVELLS','CROMPTON','GODREJCP','DABUR','MARICO','COLPAL','LUPIN','AUROPHARMA','TORNTPHARM','ALKEM','BIOCON','MCX','CHOLAFIN','MUTHOOTFIN','MANAPPURAM','LICHSGFIN','RECLTD','PFC','INDIGO','JUBLFOOD','PAGEIND','TRENT','BERGEPAINT','ACC','AMBUJACEM','SHREECEM','INDHOTEL','LTIM','PERSISTENT','COFORGE','MPHASIS','OFSS'];
let fnoCache = { data: null, time: 0, source: null };
app.get('/api/fno-stocks', (req, res) => lowPriority.run(true, async () => {
  if (fnoCache.data && Date.now() - fnoCache.time < 24 * 60 * 60 * 1000) return res.json({ symbols: fnoCache.data, source: fnoCache.source });
  try {
    const list = await fetchRawInstrumentFile('NSE');
    const set = new Set();
    list.forEach(r => {
      if (r.segment === 'NSE_FO' && ['CE', 'PE', 'FUT'].includes(r.instrument_type) && r.underlying_symbol && r.underlying_type !== 'INDEX') set.add(r.underlying_symbol);
    });
    if (set.size < 50) throw new Error('too few F&O underlyings found (' + set.size + ')');
    fnoCache = { data: Array.from(set), time: Date.now(), source: 'upstox' };
  } catch (e) {
    console.warn('F&O list from Upstox failed, using built-in list:', e.message);
    fnoCache = { data: FNO_FALLBACK, time: Date.now() - 23 * 60 * 60 * 1000, source: 'fallback' }; // retry in ~1h
  }
  res.json({ symbols: fnoCache.data, source: fnoCache.source });
}));


function istParts() { const d = new Date(Date.now() + 19800000); return { dow: d.getUTCDay(), mins: d.getUTCHours() * 60 + d.getUTCMinutes() }; }
function marketState() { const { dow, mins } = istParts(); if (dow === 0 || dow === 6) return 'closed'; if (mins >= 555 && mins <= 930) return 'open'; if (mins >= 540 && mins < 555) return 'pre-open'; return 'closed'; }
app.get('/api/status', async (req, res) => {
  const toks = upstoxTokens();
  let upstoxLive = null;
  try { await upstoxFetchJson(`https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encodeURIComponent('NSE_INDEX|Nifty 50')}`); upstoxLive = true; } catch (e) { upstoxLive = false; }
  let storage = 'not configured';
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) { try { await redisCmd('PING'); storage = 'ok'; } catch (e) { storage = 'error: ' + e.message; } }
  res.json({
    serverTime: new Date().toISOString(), market: marketState(), uptimeSec: Math.round((Date.now() - HEALTH.startedAt) / 1000),
    auth: { passcodeEnabled: !!PASSCODE, alertSecretSet: !!process.env.CHECK_ALERTS_SECRET },
    upstox: { tokensConfigured: toks.length, liveCheck: upstoxLive, lastOk: HEALTH.upstox.lastOk || null, lastError: HEALTH.upstox.lastErr || null, lastErrorAt: HEALTH.upstox.lastErrAt || null },
    telegram: { configured: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID), lastSent: HEALTH.telegram.lastSent || null, lastError: HEALTH.telegram.lastErr || null },
    alerts: { lastRun: HEALTH.alerts.lastRun || null, lastTriggered: HEALTH.alerts.lastTriggered, lastMessageAt: HEALTH.alerts.lastSentAt || null },
    storage
  });
});
app.post('/api/telegram-test', makeLimiter(60000, 5), async (req, res) => {
  try { await sendTelegram('✅ <b>Test message</b> from your NSE/BSE dashboard — Telegram alerts are working.'); HEALTH.telegram.lastTestAt = Date.now(); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
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
  const token = process.env.UPSTOX_OAUTH_TOKEN || process.env.UPSTOX_ACCESS_TOKEN || process.env.UPSTOX_ANALYTICS_TOKEN;
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
  if (!upstoxTokens().length || !UpstoxClient) {
    return res.status(503).json({ error: 'Upstox streaming not configured — no Upstox token set' });
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
          const ySymbol = ({NIFTY:'^NSEI',BANKNIFTY:'^NSEBANK',NIFTYIT:'^CNXIT',SENSEX:'^BSESN',NIFTYFMCG:'^CNXFMCG',NIFTYPHARMA:'^CNXPHARMA',NIFTYAUTO:'^CNXAUTO',NIFTYMETAL:'^CNXMETAL',NIFTYREALTY:'^CNXREALTY',NIFTYENERGY:'^CNXENERGY',NIFTYINFRA:'^CNXINFRA',NIFTYPSUBANK:'^CNXPSUBANK',NIFTYMIDCAP:'^CNXMIDCAP',NIFTYSMALLCAP:'^CNXSMALLCAP',NIFTYNXT50:'^NSMIDCP100',INDIAVIX:'^INDIAVIX'})[sym] || (sym + '.NS');
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
let upstoxTokenCheck = { time: 0, valid: false, reason: null, token: null };
async function checkUpstoxToken() {
  const toks = upstoxTokens();
  if (!toks.length) return { valid: false, reason: 'no token set' };
  const key = toks.join('|');
  const now = Date.now();
  if (upstoxTokenCheck.token === key && now - upstoxTokenCheck.time < 30000) return upstoxTokenCheck;
  let valid = false, reason = null;
  try { await upstoxGet('/market-quote/ltp?instrument_key=' + encodeURIComponent('NSE_INDEX|Nifty 50')); valid = true; }
  catch (e) { reason = e.message; }
  upstoxTokenCheck = { time: now, valid, reason, token: key };
  return upstoxTokenCheck;
}

app.get('/api/stream/status', async (req, res) => {
  const chk = await checkUpstoxToken().catch(() => ({ valid: false, reason: 'check failed' }));
  res.json({
    tokenValid: !!(chk.valid || streamerConnected),
    tokenReason: chk.valid ? null : chk.reason,
    streamerConnected,
    activeClients: sseClients.size,
    subscribedKeys: allSubscribedKeys(),
    cachedPrices: Array.from(latestPrices.keys()),
    upstoxTokenSet: upstoxTokens().length > 0,
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
  NIFTYIT: ['Nifty IT'],
  MIDCPNIFTY: ['MID SELECT'],
  FINNIFTY: ['Fin Service'],
  BANKEX: ['BANKEX'],
  NIFTYNXT50: ['Next 50']
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
  const json = await resp.json().catch(() => ({}));
  if (!json.ok) { const m = json.description || 'Telegram send failed'; HEALTH.telegram.lastErr = m; HEALTH.telegram.lastErrAt = Date.now(); throw new Error(m); }
  HEALTH.telegram.lastSent = Date.now(); HEALTH.telegram.lastErr = '';
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
  if (secret && !safeEq(req.query.secret || '', secret)) return res.status(403).json({ error: 'forbidden' });

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
      let px = null;
      try { const q = await getUpstoxLTPC(await dataKeyFor(sym)); if (q && q.price != null) px = q.price; } catch (e) { /* fall back to Yahoo below */ }
      if (px == null) {
        try { const data = await getChartData(`${sym}.NS`, '1d', '5m'); if (data && data.price != null) px = data.price; } catch (e) { /* leave unpriced, skip this symbol this run */ }
      }
      if (px != null) prices[sym] = px;
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
      try { await sendTelegram(msg); HEALTH.alerts.lastSentAt = Date.now(); } catch (e) { HEALTH.telegram.lastErr = e.message; HEALTH.telegram.lastErrAt = Date.now(); }
    }
    HEALTH.alerts.lastRun = Date.now(); HEALTH.alerts.lastTriggered = notifications.length;

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
    process.env.UPSTOX_OAUTH_TOKEN = token;
    upstoxTokenCheck = { time: 0, valid: false, reason: null, token: null };
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
  MIDCPNIFTY: 'NSE_INDEX|NIFTY MID SELECT',
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

// ---- Upstox token pool -------------------------------------------------
// UPSTOX_ANALYTICS_TOKEN : 1-year read-only token (REST market data, no WebSocket)
// UPSTOX_ACCESS_TOKEN    : legacy name — either kind of token
// UPSTOX_OAUTH_TOKEN     : set automatically by "Connect Upstox" login (daily, allows WebSocket)
// REST calls try each token in turn, so an expired daily token never breaks data
// as long as the long-lived Analytics token is present.
function upstoxTokens() {
  return [...new Set([process.env.UPSTOX_OAUTH_TOKEN, process.env.UPSTOX_ACCESS_TOKEN, process.env.UPSTOX_ANALYTICS_TOKEN].filter(Boolean))];
}
let upstoxNext = 0, upstoxHiWaiting = 0;
async function upstoxThrottle() { // keep well under Upstox rate limits (~9 req/s)
  if (lowPriority.getStore()) { // background scan: only go when no interactive request is waiting
    for (let i = 0; i < 400; i++) {
      if (upstoxHiWaiting === 0 && Date.now() >= upstoxNext) break;
      await new Promise(r => setTimeout(r, 40));
    }
    upstoxNext = Math.max(Date.now(), upstoxNext) + 110;
    return;
  }
  upstoxHiWaiting++;
  try {
    const now = Date.now(); const at = Math.max(now, upstoxNext); upstoxNext = at + 110;
    if (at > now) await new Promise(r => setTimeout(r, at - now));
  } finally { upstoxHiWaiting--; }
}
async function upstoxFetchJson(url) {
  const toks = upstoxTokens();
  if (!toks.length) throw new Error('No Upstox token configured (set UPSTOX_ANALYTICS_TOKEN on Render)');
  let lastErr = null;
  for (const tk of toks) {
    await upstoxThrottle();
    const resp = await fetch(url, { headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${tk}` } });
    const json = await resp.json().catch(() => null);
    if (resp.ok && json && json.status === 'success') { HEALTH.upstox.lastOk = Date.now(); return json.data; }
    const msg = (json && (json.errors?.[0]?.message || json.message)) || `Upstox request failed (${resp.status})`;
    lastErr = new Error(msg); HEALTH.upstox.lastErr = msg; HEALTH.upstox.lastErrAt = Date.now();
    if (resp.status === 401 || resp.status === 403 || /invalid credentials|token/i.test(msg)) continue; // try the next token
    throw lastErr;
  }
  throw lastErr;
}
async function upstoxGet(path) { return upstoxFetchJson(`${UPSTOX_BASE}${path}`); }
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

  // Real Upstox schema: key-ratios = [{name:'P/E', company_value:'20.15', sector_value:'12.46'}, ...]
  // (values are strings, some with a % sign)
  const pr = v => { if (v == null) return null; const n = parseFloat(String(v).replace(/[%,]/g, '')); return isNaN(n) ? null : n; };
  const byName = {};
  if (Array.isArray(ratios)) ratios.forEach(r => { if (r && r.name) byName[String(r.name).trim().toUpperCase()] = r; });
  const cv = n => pr(byName[n]?.company_value);
  const sv = n => pr(byName[n]?.sector_value);
  if (!Array.isArray(ratios) && !profile) throw new Error('Upstox fundamentals unavailable for ' + symbol);

  const result = {
    symbol,
    isin,
    pe: cv('P/E'), peSector: sv('P/E'),
    pb: cv('P/B'), pbSector: sv('P/B'),
    roe: cv('ROE'), roeSector: sv('ROE'),
    roce: cv('ROCE'), roceSector: sv('ROCE'),
    roa: cv('ROA'), roaSector: sv('ROA'),
    evEbitda: cv('EV/EBITDA'), evEbitdaSector: sv('EV/EBITDA'),
    // Not provided by Upstox's fundamentals API -> client falls back to simulated
    marketCap: null, debtEquity: null, currentRatio: null, eps: null, dividendYield: null,
    sector: profile?.sector ?? null,
    description: profile?.company_profile ?? null,
    sectorMarketCapInr: profile?.sector_market_cap_inr?.formatted ?? null,
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


// ============================================================
// REAL SHAREHOLDING PATTERN (Upstox /fundamentals/{isin}/share-holdings)
// ============================================================
const shareholdingCache = {};
async function getUpstoxShareholding(symbol) {
  const now = Date.now();
  if (shareholdingCache[symbol] && now - shareholdingCache[symbol].time < FUNDAMENTALS_TTL) return shareholdingCache[symbol].data;
  const instrumentKey = HARDCODED_EQ_KEYS[symbol] || (universeCache.data && universeCache.data.find(s => s.symbol === symbol)?.instrument_key);
  const isin = isinFromKey(instrumentKey);
  if (!isin) throw new Error('No ISIN found for ' + symbol);
  const rows = await upstoxGet(`/fundamentals/${isin}/share-holdings`);
  if (!Array.isArray(rows) || !rows.length) throw new Error('No shareholding data for ' + symbol);
  const categories = {};
  rows.forEach(r => {
    if (!r || !r.category || !Array.isArray(r.history)) return;
    const pt = p => { const d = new Date('1 ' + p); return isNaN(d) ? 0 : d.getTime(); };
    categories[r.category] = r.history.map(h => ({ period: h.period, value: Number(h.value) })).sort((a, b) => pt(a.period) - pt(b.period));
  });
  const latest = {};
  Object.keys(categories).forEach(k => {
    const h = categories[k];
    latest[k] = h.length ? h[h.length - 1].value : null;
  });
  const data = { symbol, isin, categories, latest, source: 'upstox' };
  shareholdingCache[symbol] = { data, time: now };
  return data;
}

app.get('/api/shareholding/:symbol', async (req, res) => {
  try { res.json(await getUpstoxShareholding(req.params.symbol)); }
  catch (e) { res.status(502).json({ error: e.message, symbol: req.params.symbol }); }
});

// ============================================================
// UPSTOX HISTORICAL CANDLES (primary price-data source)
// Yahoo is only a labelled fallback. Works with the Analytics token.
// ============================================================
const DATA_INDEX_KEYS = {
  ...UPSTOX_INDEX_KEYS,
  NIFTYFMCG: 'NSE_INDEX|Nifty FMCG', NIFTYPHARMA: 'NSE_INDEX|Nifty Pharma', NIFTYAUTO: 'NSE_INDEX|Nifty Auto',
  NIFTYMETAL: 'NSE_INDEX|Nifty Metal', NIFTYREALTY: 'NSE_INDEX|Nifty Realty', NIFTYENERGY: 'NSE_INDEX|Nifty Energy',
  NIFTYINFRA: 'NSE_INDEX|Nifty Infra', NIFTYPSUBANK: 'NSE_INDEX|Nifty PSU Bank', NIFTYMIDCAP: 'NSE_INDEX|NIFTY MIDCAP 100',
  NIFTYSMALLCAP: 'NSE_INDEX|NIFTY SMLCAP 100', INDIAVIX: 'NSE_INDEX|India VIX'
};
const DATA_INDEX_NAMES = {
  NIFTY: ['Nifty 50'], BANKNIFTY: ['Nifty Bank'], NIFTYIT: ['Nifty IT'], NIFTYFMCG: ['Nifty FMCG', 'FMCG'], NIFTYPHARMA: ['Nifty Pharma', 'Pharma'],
  NIFTYAUTO: ['Nifty Auto'], NIFTYMETAL: ['Nifty Metal', 'Metal'], NIFTYREALTY: ['Nifty Realty', 'Realty'], NIFTYENERGY: ['Nifty Energy'],
  NIFTYINFRA: ['Nifty Infra'], NIFTYPSUBANK: ['PSU Bank'], NIFTYMIDCAP: ['MIDCAP 100', 'Midcap 100'], NIFTYSMALLCAP: ['SMLCAP 100', 'Smallcap 100'],
  NIFTYNXT50: ['Next 50'], SENSEX: ['SENSEX'], INDIAVIX: ['India VIX']
};
const YAHOO_TO_APP = { '^NSEI': 'NIFTY', '^NSEBANK': 'BANKNIFTY', '^CNXIT': 'NIFTYIT', '^CNXFMCG': 'NIFTYFMCG', '^CNXPHARMA': 'NIFTYPHARMA', '^CNXAUTO': 'NIFTYAUTO',
  '^CNXMETAL': 'NIFTYMETAL', '^CNXREALTY': 'NIFTYREALTY', '^CNXENERGY': 'NIFTYENERGY', '^CNXINFRA': 'NIFTYINFRA', '^CNXPSUBANK': 'NIFTYPSUBANK',
  '^CNXMIDCAP': 'NIFTYMIDCAP', '^CNXSMALLCAP': 'NIFTYSMALLCAP', '^NSMIDCP100': 'NIFTYNXT50', '^BSESN': 'SENSEX', '^INDIAVIX': 'INDIAVIX' };
const APP_TO_YAHOO = Object.fromEntries(Object.entries(YAHOO_TO_APP).map(([y, a]) => [a, y]));
const appSym = ys => YAHOO_TO_APP[ys] || String(ys).replace(/\.NS$/, '');
const yahooSym = as => APP_TO_YAHOO[as] || (as + '.NS');

const resolvedIdxKeys = {};
async function dataKeyFor(sym) {
  if (resolvedIdxKeys[sym]) return resolvedIdxKeys[sym];
  if (DATA_INDEX_KEYS[sym]) return DATA_INDEX_KEYS[sym];
  const normalized = sym.replace(/[&-]/g, '_');
  if (HARDCODED_EQ_KEYS[sym]) return HARDCODED_EQ_KEYS[sym];
  if (HARDCODED_EQ_KEYS[normalized]) return HARDCODED_EQ_KEYS[normalized];
  if (!universeCache.data) await fetchAndCacheUniverse().catch(() => {});
  const hit = universeCache.data && universeCache.data.find(x => x.symbol === sym);
  if (hit && hit.instrument_key) return hit.instrument_key;
  throw new Error('No Upstox instrument key for ' + sym);
}
// [unit, interval, days back]  (weeks/months: from 2000)
const CANDLE_TF = { '1m': ['minutes', 1, 5], '5m': ['minutes', 5, 25], '15m': ['minutes', 15, 28], '30m': ['minutes', 30, 85], '1h': ['hours', 1, 85], '1D': ['days', 1, 365 * 5], '1W': ['weeks', 1, 0], '1M': ['months', 1, 0] };
const candleCache = {};
function istDate(offsetDays) { const d = new Date(Date.now() + 19800000 - (offsetDays || 0) * 86400000); return d.toISOString().slice(0, 10); }
function parseCandles(rows, unit) {
  const dateOnly = (unit === 'days' || unit === 'weeks' || unit === 'months');
  return (rows || []).map(c => {
    let t = Math.floor(Date.parse(c[0]) / 1000);
    if (dateOnly) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(c[0]); if (m) t = Date.UTC(+m[1], +m[2] - 1, +m[3], 12) / 1000; } // pin to noon UTC of the IST date
    return { t, o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] || 0 };
  }).filter(x => x.c > 0 && !isNaN(x.t));
}
async function fetchCandlesForKey(key, tf) {
  const [unit, interval, days] = CANDLE_TF[tf];
  const enc = encodeURIComponent(key);
  const from = days ? istDate(days) : '2000-01-01';
  const to = istDate(0);
  const hist = await upstoxFetchJson(`https://api.upstox.com/v3/historical-candle/${enc}/${unit}/${interval}/${to}/${from}`);
  let rows = parseCandles(hist && hist.candles, unit);
  if (unit === 'minutes' || unit === 'hours' || unit === 'days') { // today's still-forming candles
    try {
      const intra = await upstoxFetchJson(`https://api.upstox.com/v3/historical-candle/intraday/${enc}/${unit}/${interval}`);
      rows = rows.concat(parseCandles(intra && intra.candles, unit));
    } catch (e) { /* market not open yet / no intraday data — historical is enough */ }
  }
  const seen = new Set(); const out = [];
  rows.sort((a, b) => a.t - b.t).forEach(r => { if (!seen.has(r.t)) { seen.add(r.t); out.push(r); } });
  return out;
}
async function getUpstoxCandles(sym, tf) {
  if (!CANDLE_TF[tf]) throw new Error('unsupported timeframe ' + tf);
  const ck = sym + '|' + tf; const ttl = /m|h/.test(tf) && tf !== '1M' ? 20000 : 30 * 60000;
  const c = candleCache[ck]; if (c && Date.now() - c.time < ttl) return c.data;
  let key = await dataKeyFor(sym); let rows;
  try { rows = await fetchCandlesForKey(key, tf); }
  catch (e) {
    const kw = DATA_INDEX_NAMES[sym];
    if (kw && DATA_INDEX_KEYS[sym] && /instrument|invalid|not found|400|404/i.test(e.message)) { // self-heal a wrong index key by name search
      key = await findIndexInstrumentKey(kw); resolvedIdxKeys[sym] = key; rows = await fetchCandlesForKey(key, tf);
    } else throw e;
  }
  if (!rows.length) throw new Error('Upstox returned no candles for ' + sym);
  candleCache[ck] = { data: rows, time: Date.now() };
  return rows;
}
const YF_TF = { '1m': ['5d', '1m'], '5m': ['5d', '5m'], '15m': ['1mo', '15m'], '30m': ['1mo', '30m'], '1h': ['6mo', '60m'], '1D': ['2y', '1d'], '1W': ['5y', '1wk'], '1M': ['max', '1mo'] };
app.get('/api/candles/:symbol', async (req, res) => {
  const sym = req.params.symbol; const tf = req.query.tf || '5m';
  const errors = [];
  try { const rows = await getUpstoxCandles(sym, tf); return res.json({ symbol: sym, tf, source: 'upstox', series: rows }); }
  catch (e) { errors.push('Upstox: ' + e.message); }
  // last-good data from Upstox (clearly flagged) beats a different vendor's numbers or an error
  const last = candleCache[sym + '|' + tf];
  const maxAge = (/m|h/.test(tf) && tf !== '1M') ? 30 * 60000 : 24 * 3600000;
  if (last && Date.now() - last.time < maxAge) return res.json({ symbol: sym, tf, source: 'upstox', stale: true, ageSec: Math.round((Date.now() - last.time) / 1000), series: last.data, note: errors.join(' | ') });
  try {
    const [r, i] = YF_TF[tf] || YF_TF['5m'];
    const p = await getChartData(yahooSym(sym), r, i);
    if (p && p.series && p.series.length > 5) return res.json({ symbol: sym, tf, source: 'yahoo', series: p.series, note: errors.join(' | ') });
    errors.push('Yahoo: no data');
  } catch (e) { errors.push('Yahoo: ' + e.message); }
  res.status(502).json({ error: errors.join(' | '), symbol: sym });
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
