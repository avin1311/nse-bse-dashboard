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
    let source = stripTags(g('source')) || stripTags(g('News:Source')) || defaultSource;
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
async function fetchFeed(url, source, diag) {
  const d = { source, host: (url.match(/^https?:\/\/([^/]+)/) || [])[1] || url, status: null, n: 0, err: null };
  if (diag) diag.push(d);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept': 'application/rss+xml, application/xml, text/xml, */*;q=0.8', 'Accept-Language': 'en-IN,en;q=0.9' }, signal: AbortSignal.timeout(8000), redirect: 'follow' });
    d.status = r.status;
    if (!r.ok) return [];
    const items = parseNewsFeed(await r.text(), source);
    d.n = items.length;
    return items;
  } catch (e) { d.err = String(e && e.message || e).slice(0, 80); return []; }
}
const bing = q => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setmkt=en-IN&qft=sortbydate%3d%221%22`;
const yfeed = ys => `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ys)}&region=IN&lang=en-IN`;
const INDEX_YF = { NIFTY: '^NSEI', BANKNIFTY: '^NSEBANK', SENSEX: '^BSESN' };
const gnews = q => `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:4d')}&hl=en-IN&gl=IN&ceid=IN:en`;
const NEWS_FEEDS_GENERAL = [
  ['https://economictimes.indiatimes.com/markets/stocks/news/rssfeeds/2146842.cms', 'Economic Times'],
  ['https://www.moneycontrol.com/rss/latestnews.xml', 'Moneycontrol'],
  ['https://www.moneycontrol.com/rss/marketreports.xml', 'Moneycontrol'],
  ['https://www.livemint.com/rss/markets', 'Mint'],
  ['https://www.business-standard.com/rss/markets-106.rss', 'Business Standard']
];
// Market and company news straight from the publishers (their own feeds carry true publish times). Stock pages are filled
// from these first; a feed that stops working is skipped and shows up in the feed check.
const NEWS_FEEDS_PUBLISHER = NEWS_FEEDS_GENERAL.concat([
  ['https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', 'Economic Times'],
  ['https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms', 'Economic Times'],
  ['https://www.moneycontrol.com/rss/business.xml', 'Moneycontrol'],
  ['https://www.moneycontrol.com/rss/results.xml', 'Moneycontrol'],
  ['https://www.moneycontrol.com/rss/buzzingstocks.xml', 'Moneycontrol'],
  ['https://www.livemint.com/rss/companies', 'Mint'],
  ['https://www.business-standard.com/rss/companies-101.rss', 'Business Standard'],
  ['https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml', 'CNBC-TV18'],
  ['https://www.cnbctv18.com/commonfeeds/v1/cne/rss/business.xml', 'CNBC-TV18'],
  ['https://www.financialexpress.com/market/feed/', 'Financial Express'],
  ['https://www.thehindubusinessline.com/markets/feeder/default.rss', 'BusinessLine'],
  ['https://www.thehindubusinessline.com/companies/feeder/default.rss', 'BusinessLine'],
  ['https://feeds.feedburner.com/ndtvprofit-latest', 'NDTV Profit']
]);
let pubFeedCache = { t: 0, items: [], diag: [] }, pubFeedP = null;
async function publisherNews() { // shared by every stock page, refreshed every 5 minutes
  if (Date.now() - pubFeedCache.t < 300000) return pubFeedCache;
  if (pubFeedP) return pubFeedP;
  pubFeedP = (async () => { const diag = []; const items = (await Promise.all(NEWS_FEEDS_PUBLISHER.map(([u, src]) => fetchFeed(u, src, diag)))).flat().map(i => ({ ...i, via: 'publisher' }));
    pubFeedCache = { t: Date.now(), items, diag }; pubFeedP = null; return pubFeedCache; })();
  return pubFeedP;
}
// does a headline name this company? symbol as a word, the company name, or its first two words (never one generic word)
function stockMatcher(symbol, name) {
  const STOP = new Set(['limited', 'ltd', 'ltd.', 'the', 'and', 'of', 'india', 'indian', 'company', 'corporation', 'corp', 'co']);
  const words = String(name || '').replace(/\b(limited|ltd\.?)\b/ig, '').trim().split(/\s+/).filter(Boolean);
  const pats = [];
  if (symbol.length >= 3 && !/^(IT|OIL|IDEA|ABB|BEL)$/.test(symbol) || /^(ABB|BEL|OIL)$/.test(symbol)) pats.push(new RegExp('\\b' + symbol.replace(/[&-]/g, m => '\\' + m) + '\\b'));
  const core = words.map(w => w.replace(/[^A-Za-z0-9]/g, '')).filter(w => w && !STOP.has(w.toLowerCase()));
  if (core.length >= 2) pats.push(new RegExp('\\b' + core.slice(0, 2).join("(?:\\s+and\\s+|[\\s&.,'-]+)") + '\\b', 'i'));
  if (core.length === 1 && core[0].length >= 5) pats.push(new RegExp('\\b' + core[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'));
  return it => { const t = it.title + ' ' + (it.description || ''); return pats.some(p => p.test(t)); };
}

// What to search for on an index page: Google News phrases (index + its biggest members) and
// keywords that make a general-feed headline relevant. broad=true: every market headline counts.
const INDEX_NEWS = {
  NIFTY: { q: ['Nifty 50 today', 'Nifty 50 stocks Reliance HDFC Bank Infosys ICICI Bank TCS', 'Sensex Nifty market news'], kw: ['nifty','sensex','market','stocks','reliance','hdfc','infosys','icici','tcs','fii','rbi'], broad: true },
  SENSEX: { q: ['Sensex today', 'Sensex Nifty market news', 'BSE Sensex stocks'], kw: ['sensex','nifty','market','stocks'], broad: true },
  BANKNIFTY: { q: ['Bank Nifty today', 'Bank Nifty stocks HDFC Bank ICICI Bank SBI Axis Bank Kotak', 'banking stocks India RBI'], kw: ['bank','banking','hdfc','icici','sbi','axis','kotak','rbi','nbfc','lender'] },
  NIFTYIT: { q: ['Nifty IT today', 'IT stocks TCS Infosys Wipro HCL Tech Tech Mahindra', 'Indian IT services stocks'], kw: ['infosys','tcs','wipro','hcl','tech mahindra','ltimindtree','it stocks','it services','nasscom'] },
  NIFTYFMCG: { q: ['Nifty FMCG today', 'FMCG stocks HUL ITC Nestle Britannia', 'FMCG sector India'], kw: ['fmcg','hindustan unilever','hul','itc','nestle','britannia','dabur','tata consumer'] },
  NIFTYPHARMA: { q: ['Nifty Pharma today', 'pharma stocks Sun Pharma Cipla Dr Reddys', 'pharma sector India'], kw: ['pharma','sun pharma','cipla','dr reddy','lupin','usfda','drug'] },
  NIFTYAUTO: { q: ['Nifty Auto today', 'auto stocks Maruti Tata Motors Mahindra Bajaj', 'auto sales India'], kw: ['auto','maruti','tata motors','mahindra','bajaj auto','hero motocorp','eicher','car sales','two-wheeler'] },
  NIFTYMETAL: { q: ['Nifty Metal today', 'metal stocks Tata Steel JSW Steel Hindalco Vedanta', 'steel aluminium prices India'], kw: ['metal','steel','tata steel','jsw','hindalco','vedanta','coal','aluminium','copper'] },
  NIFTYREALTY: { q: ['Nifty Realty today', 'realty stocks DLF Godrej Properties Lodha', 'real estate sector India'], kw: ['realty','real estate','dlf','godrej properties','lodha','housing','property'] },
  NIFTYENERGY: { q: ['Nifty Energy today', 'energy stocks Reliance ONGC NTPC Power Grid', 'crude oil India stocks'], kw: ['energy','oil','ongc','reliance','ntpc','power','crude','gas','coal india'] },
  NIFTYINFRA: { q: ['Nifty Infra today', 'infrastructure stocks L&T Adani Ports', 'infrastructure India capex'], kw: ['infra','infrastructure','l&t','larsen','adani ports','capex','construction'] },
  NIFTYPSUBANK: { q: ['Nifty PSU Bank today', 'PSU bank stocks SBI Bank of Baroda PNB Canara', 'public sector banks India'], kw: ['psu bank','sbi','bank of baroda','pnb','canara','public sector bank','union bank'] },
  NIFTYMIDCAP: { q: ['Nifty Midcap today', 'midcap stocks India rally', 'midcap smallcap market India'], kw: ['midcap','smallcap','mid-cap','small-cap'], broad: true },
  NIFTYSMALLCAP: { q: ['Nifty Smallcap today', 'smallcap stocks India', 'midcap smallcap market India'], kw: ['smallcap','midcap','small-cap','mid-cap'], broad: true },
  NIFTYNXT50: { q: ['Nifty Next 50 today', 'Nifty Next 50 stocks', 'Sensex Nifty market news'], kw: ['next 50','nifty','market'], broad: true },
  INDIAVIX: { q: ['India VIX today', 'India VIX volatility market', 'Sensex Nifty market news'], kw: ['vix','volatility','nifty','market'], broad: true },
};
// ---- News freshness. Feed times are not publish times: Google / Bing re-list old articles when a site re-saves them, so a
// March story can show as "4 h ago". Every headline is checked before it is shown:
//  1. a date written in the headline or in the article's address that is more than 3 days old drops it;
//  2. the article page's own published time (meta tags / JSON-LD) replaces the feed time (Google News links are first
//     resolved to the real article); older than the limit drops it;
//  3. a headline about today's Nifty / Sensex / Bank Nifty move that contradicts today's actual move drops it.
const NEWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
function istNow() { return new Date(Date.now() + 19800000); }
function dateFromText(t) {
  const s = String(t || '');
  const mk = (y, mo, d) => { const now = istNow(); let yr = y ? +y : now.getUTCFullYear(); let ts = Date.UTC(yr, mo, +d) - 19800000; if (!y && ts > Date.now() + 2 * 86400000) ts = Date.UTC(yr - 1, mo, +d) - 19800000; return ts; };
  const mon = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  let m = s.match(new RegExp('\\b' + mon + '\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?\\b', 'i'));
  if (m) return mk(m[3], MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase().startsWith('sept') ? 4 : 3)] ?? MONTHS[m[1].toLowerCase().slice(0, 3)], m[2]);
  m = s.match(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+' + mon + '\\.?(?:,?\\s+(20\\d\\d))?\\b', 'i'));
  if (m) return mk(m[3], MONTHS[m[2].toLowerCase().slice(0, 3)], m[1]);
  return null;
}
function dateFromUrl(u) {
  const s = String(u || '');
  let m = s.match(/\/(20\d\d)\/(\d{1,2})\/(\d{1,2})\//) || s.match(/[\/_-](20\d\d)-(\d{2})-(\d{2})(?:[\/_.-]|$)/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return Date.UTC(+m[1], +m[2] - 1, +m[3]) - 19800000;
  m = s.match(/[\/_-]((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)-(\d{1,2})-(20\d\d)(?:[\/_.-]|$)/i);
  if (m) return Date.UTC(+m[3], MONTHS[m[1].toLowerCase().slice(0, 3)], +m[2]) - 19800000;
  return null;
}
const realUrlCache = new Map(); // google article id -> real url ('' when it could not be resolved)
async function resolveNewsUrl(link) {
  try {
    const u = new URL(link);
    if (/bing\.com$/.test(u.hostname)) { const r = u.searchParams.get('url'); return r || link; }
    if (!/news\.google\.com$/.test(u.hostname)) return link;
    const id = (u.pathname.match(/\/articles\/([^/?]+)/) || [])[1]; if (!id) return null;
    if (realUrlCache.has(id)) return realUrlCache.get(id) || null;
    // old-style ids carry the address in plain text
    try { const raw = Buffer.from(id.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1'); const h = raw.match(/https?:\/\/[\x21-\x7e]+/); if (h && !/^https?:\/\/news\.google/.test(h[0])) { realUrlCache.set(id, h[0]); return h[0]; } } catch (e) {}
    // new-style ids: ask Google for the address (same request its own page makes)
    const page = await fetch('https://news.google.com/rss/articles/' + id, { headers: { 'User-Agent': NEWS_UA }, signal: AbortSignal.timeout(5000) }).then(r => r.text());
    const sg = (page.match(/data-n-a-sg="([^"]+)"/) || [])[1], ts = (page.match(/data-n-a-ts="([^"]+)"/) || [])[1];
    if (!sg || !ts) { realUrlCache.set(id, ''); return null; }
    const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, +ts, sg]);
    const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]));
    const txt = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': NEWS_UA }, body, signal: AbortSignal.timeout(5000) }).then(r => r.text());
    const part = txt.split('\n\n')[1]; const arr = JSON.parse(part); const url = JSON.parse(arr[0][2])[1];
    realUrlCache.set(id, url || ''); if (realUrlCache.size > 3000) realUrlCache.delete(realUrlCache.keys().next().value);
    return url || null;
  } catch (e) { return null; }
}
const pubTimeCache = new Map(); // real url -> {ts|null}
async function articlePublished(url) {
  if (!url) return null;
  if (pubTimeCache.has(url)) return pubTimeCache.get(url);
  let ts = null;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': NEWS_UA, 'Accept': 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      let html = ''; const rd = r.body.getReader(); const dec = new TextDecoder();
      while (html.length < 400000) { const { done, value } = await rd.read(); if (done) break; html += dec.decode(value, { stream: true }); if (/<\/head>/i.test(html) && /datePublished|published_time/i.test(html)) break; }
      try { rd.cancel(); } catch (e) {}
      const pats = [/property=["'](?:og:)?article:published_time["'][^>]*content=["']([^"']+)/i, /content=["']([^"']+)["'][^>]*property=["'](?:og:)?article:published_time/i,
        /"datePublished"\s*:\s*"([^"]+)"/i, /itemprop=["']datePublished["'][^>]*content=["']([^"']+)/i, /name=["'](?:publish-date|pubdate|publishdate|PublishDate|article_date_original|date)["'][^>]*content=["']([^"']+)/i,
        /"dateCreated"\s*:\s*"([^"]+)"/i, /<time[^>]*datetime=["']([^"']+)/i];
      const found = []; for (const p of pats) { const m = html.match(p); if (m) { const t = Date.parse(m[1]); if (t && t < Date.now() + 3600000 && t > Date.UTC(2015, 0, 1)) found.push(t); } }
      if (found.length) ts = Math.min(...found);
    }
  } catch (e) {}
  pubTimeCache.set(url, ts); if (pubTimeCache.size > 4000) pubTimeCache.delete(pubTimeCache.keys().next().value);
  return ts;
}
let idxMoveCache = { t: 0, v: null };
async function todaysIndexMoves() {
  if (Date.now() - idxMoveCache.t < 120000) return idxMoveCache.v;
  const v = {};
  if (upstoxTokens().length) await Promise.all([['nifty', 'NSE_INDEX|Nifty 50'], ['sensex', 'BSE_INDEX|SENSEX'], ['bank nifty', 'NSE_INDEX|Nifty Bank']].map(async ([n, k]) => { try { const q = await getUpstoxLTPC(k); if (q && q.price) v[n] = { pct: q.changePct, pts: q.price - q.prevClose }; } catch (e) {} }));
  idxMoveCache = { t: Date.now(), v }; return v;
}
const DOWN_W = /\b(crash\w*|falls?|fell|tank\w*|slump\w*|plung\w*|sinks?|sank|bloodbath|tumbl\w*|slides?|declin\w*|drops?|dropped|down|bleed\w*|nosediv\w*|selloff|sell-off|lower)\b/i;
const UP_W = /\b(rall\w*|jumps?|jumped|surg\w*|soar\w*|gains?|gained|climbs?|climbed|up|zooms?|higher|spurts?|rebounds?|strong)\b/i;
function contradictsToday(title, mv) {
  const t = String(title || '');
  for (const n of ['bank nifty', 'nifty', 'sensex']) {
    const x = mv[n]; if (!x) continue;
    const re = new RegExp('\\b' + n + '(?! ?(it|pharma|auto|fmcg|metal|realty|bank|midcap|smallcap|next|financial|psu))\\b', 'i'); if (!re.test(t)) continue;
    const seg = t.slice(Math.max(0, t.search(re))).slice(0, 70);
    const dn = DOWN_W.test(seg), up = UP_W.test(seg);
    if (dn && !up && x.pct > 0.3) return true;
    if (up && !dn && x.pct < -0.3) return true;
    const pc = seg.match(/(\d+(?:\.\d+)?)\s?%/), pt = seg.match(/(\d{3,4}(?:,\d{3})?)\s?(?:pts|points)/i);
    if (pc && Math.abs(+pc[1]) > Math.abs(x.pct) * 2 + 0.6) return true;
    if (pt && +pt[1].replace(/,/g, '') > Math.abs(x.pts) * 2 + 80) return true;
    return false;
  }
  return false;
}
// items: [{title, link, ts, ...}] newest first; returns the fresh ones (with ts set to the article's own time when known)
async function freshNews(items, maxAgeH, want) {
  const now = Date.now(), lim = now - maxAgeH * 3600000;
  const mv = await todaysIndexMoves().catch(() => ({}));
  const todayIst = istNow().toISOString().slice(0, 10);
  const pre = items.filter(it => {
    if (!it.ts || it.ts < lim || it.ts > now + 3600000) return false;
    const td = dateFromText(it.title); if (td != null && td < Math.max(lim, now - 3 * 86400000) && td < it.ts - 3 * 86400000) { if (td < lim) return false; it.ts = td; }
    const ud = dateFromUrl(it.link); if (ud != null && ud < it.ts - 2 * 86400000) { if (ud < lim) return false; it.ts = ud; }
    return true;
  });
  // verify the newest candidates against the article page (in parallel, cached); stop once enough are confirmed
  const cand = pre.slice(0, Math.max(want * 2, 14));
  await Promise.all(cand.map(async it => {
    const real = await resolveNewsUrl(it.link);
    if (real) { it.realLink = real; const ud = dateFromUrl(real); if (ud != null && ud < it.ts - 2 * 86400000) { if (ud < lim) { it.stale = true; return; } it.ts = ud; } }
    const pub = real ? await articlePublished(real) : null;
    if (pub) { it.verified = true; if (pub < lim) it.stale = true; else it.ts = pub; }
  }));
  const out = cand.filter(it => !it.stale).filter(it => {
    const sameDay = new Date(it.ts + 19800000).toISOString().slice(0, 10) === todayIst;
    return !(sameDay && contradictsToday(it.title, mv));
  });
  return out.sort((a, b) => b.ts - a.ts).map(it => ({ ...it, link: it.realLink || it.link, realLink: undefined }));
}
app.get('/api/news/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const name = String(req.query.name || '').replace(/[^\w &.\-]/g, '').trim().slice(0, 60);
  const key = symbol + '|' + name;
  const now = Date.now();
  if (newsCache[key] && now - newsCache[key].time < NEWS_TTL) return res.json(newsCache[key].data);
  try {
    const diag = []; const ff = (u, s) => fetchFeed(u, s, diag);
    const idx = INDEX_NEWS[symbol];
    let items;
    if (idx) {
      const [specific, general] = await Promise.all([
        Promise.all([...idx.q.map(q => ff(gnews(q), 'Google News')), ...idx.q.slice(0, 2).map(q => ff(bing(q), 'Bing News')), ...(INDEX_YF[symbol] ? [ff(yfeed(INDEX_YF[symbol]), 'Yahoo Finance')] : [])]).then(a => a.flat()),
        Promise.all(NEWS_FEEDS_GENERAL.map(([u, s]) => ff(u, s))).then(a => a.flat())
      ]);
      const seen = new Set();
      const uniq = arr => arr.filter(it => { const k = it.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; });
      const spec = await freshNews(uniq(specific).sort((a, b) => b.ts - a.ts), 72, 15);
      const gen = await freshNews(uniq(general).sort((a, b) => b.ts - a.ts), 36, 10);
      const rel = gen.filter(it => { const t = (it.title + ' ' + it.description).toLowerCase(); return idx.kw.some(w => t.includes(w)); });
      items = [...spec, ...(idx.broad ? gen : rel)].sort((a, b) => b.ts - a.ts).slice(0, 25).map(i => ({ ...i, scope: 'stock' }));
      if (items.length < 8) items = items.concat(gen.filter(g => !items.includes(g)).slice(0, 8 - items.length).map(i => ({ ...i, scope: 'market' })));
    } else {
    // Stock page: only news about this company. Publisher feeds first (true publish times); search results (Google / Bing)
    // only when their date is confirmed on the article page. Newest first, older ones after (up to 90 days), no market filler.
    const nm = name || symbol, isMine = stockMatcher(symbol, name);
    const queries = [[gnews(`"${nm}" share`), 'Google News'], [gnews(`${symbol} NSE stock`), 'Google News'], [bing(`"${nm}" share`), 'Bing News'], [bing(`${nm} stock news`), 'Bing News']];
    const [search, pub] = await Promise.all([Promise.all(queries.map(([u, s]) => ff(u.replace('when:4d', 'when:30d'), s))).then(a => a.flat()), publisherNews()]);
    diag.push(...pub.diag);
    const seen = new Set();
    const uniq = arr => arr.filter(it => { const k = it.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; });
    const fromPub = uniq(pub.items.filter(isMine).filter(it => it.ts && it.ts > now - 90 * 86400000 && it.ts < now + 3600000)).map(it => ({ ...it, verified: true }));
    const cand = uniq(search.filter(isMine)).sort((a, b) => b.ts - a.ts);
    const verified = (await freshNews(cand, 90 * 24, 14)).filter(it => it.verified).map(it => ({ ...it, via: 'search' }));
    const mv = await todaysIndexMoves().catch(() => ({})), todayIst = istNow().toISOString().slice(0, 10);
    items = fromPub.concat(verified).filter(it => !(new Date(it.ts + 19800000).toISOString().slice(0, 10) === todayIst && contradictsToday(it.title, mv)))
      .sort((a, b) => b.ts - a.ts).slice(0, 15).map(i => ({ ...i, scope: 'stock' }));
    }
    items = items.map(i => ({ ...i, verified: !!i.verified, pubDate: i.ts ? new Date(i.ts).toISOString() : '', sentiment: getSentiment(i.title + ' ' + i.description) }));
    const result = { symbol, items, fetchedAt: new Date().toISOString(), feeds: diag, build: 'news-r3' };
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
const badEqKeys = new Set(); // built-in stock IDs that returned no data (an ISIN changes after a split): never used again
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
  if (!entry) { if (/^NSE_EQ\|/.test(instrumentKey)) badEqKeys.add(instrumentKey); throw new Error('No quote returned for ' + instrumentKey); }
  const price = entry.last_price;
  let prevClose = (entry.net_change != null && price != null) ? price - entry.net_change : (entry.cp || entry.ohlc?.close || price);
  const changePct = prevClose ? ((price - prevClose) / prevClose * 100) : 0;
  const result = { price, prevClose, changePct, dayHigh: entry.ohlc?.high, dayLow: entry.ohlc?.low, open: entry.ohlc?.open, volume: entry.volume, source: 'upstox' };
  ltpcCache[instrumentKey] = { data: result, time: now };
  return result;
}


// Batch live quotes straight from Upstox (same source as the stock header).
// GET /api/quotes-live?symbols=DIXON,TCS,NIFTY  -> { SYM: {price, prevClose, changePct, volume, ts} }
app.get('/api/quotes-live', async (req, res) => {
  const syms = [...new Set((req.query.symbols || '').split(',').map(s => s.trim()).filter(Boolean))].slice(0, 400);
  if (!syms.length) return res.status(400).json({ error: 'symbols required' });
  if (!upstoxTokens().length) return res.status(503).json({ error: 'Upstox not configured' });
  const keyOf = {};
  await Promise.all(syms.map(async s => { try { keyOf[s] = await dataKeyFor(s); } catch (e) {} }));
  const keys = [...new Set(Object.values(keyOf))];
  const byKey = {};
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    try {
      const q = await upstoxGet(`/market-quote/quotes?instrument_key=${encodeURIComponent(chunk.join(','))}`);
      Object.entries(q || {}).forEach(([k, e]) => { if (e) { if (e.instrument_token) byKey[e.instrument_token] = e; byKey[k] = e; } });
    } catch (e) { /* chunk skipped; those symbols just stay absent */ }
  }
  const out = {}; const ts = Date.now();
  syms.forEach(s => {
    const k = keyOf[s]; if (!k) return;
    const e = byKey[k] || byKey[k.replace('|', ':')]; if (!e || e.last_price == null) return;
    const price = e.last_price;
    const prevClose = (e.net_change != null) ? price - e.net_change : (e.ohlc && e.ohlc.close) || null;
    out[s] = { price, prevClose, changePct: prevClose ? (price / prevClose - 1) * 100 : 0, volume: e.volume, ts };
  });
  res.json(out);
});

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
      return res.status(502).json({ error: 'No Upstox instrument for ' + sym });
    } catch (e) { return res.status(502).json({ error: 'Upstox quote failed: ' + e.message }); }
  }
  res.status(503).json({ error: 'Upstox is not connected' }); // real Upstox prices only, no Yahoo fallback
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
  const rows = await getUpstoxCandles(appSym(sym), '1D'); if (rows.length >= 30) ser = rows.slice(-320).map(r => ({ t: r.t, o: r.o, c: r.c, h: r.h, l: r.l, v: r.v }));
  if (!ser) throw new Error('insufficient Upstox history'); // Upstox only, no Yahoo fallback
  const data = { o: ser.map(p => p.o != null ? p.o : p.c), c: ser.map(p => p.c), h: ser.map(p => p.h), l: ser.map(p => p.l), v: ser.map(p => p.v), t: ser.map(p => p.t), source };
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
  const rows = await getUpstoxCandles(appSym(sym), '1M'); if (rows.length >= 14) ser = rows;
  if (!ser) throw new Error('insufficient Upstox monthly history'); // Upstox only, no Yahoo fallback
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
// The sector index each stock belongs to (for the sector-agreement rule and the safety block); stocks not listed use Nifty
const SECTOR_GROUPS = {
  BANKNIFTY: ['HDFCBANK','ICICIBANK','KOTAKBANK','AXISBANK','INDUSINDBK','IDFCFIRSTB','FEDERALBNK','AUBANK','BANDHANBNK'],
  NIFTYPSUBANK: ['SBIN','PNB','BANKBARODA','CANBK'],
  NIFTYIT: ['TCS','INFY','WIPRO','HCLTECH','TECHM','LTIM','PERSISTENT','COFORGE','MPHASIS','OFSS'],
  NIFTYFMCG: ['ITC','HINDUNILVR','NESTLEIND','BRITANNIA','TATACONSUM','GODREJCP','DABUR','MARICO','COLPAL'],
  NIFTYPHARMA: ['SUNPHARMA','DRREDDY','CIPLA','DIVISLAB','LUPIN','AUROPHARMA','TORNTPHARM','ALKEM','BIOCON'],
  NIFTYAUTO: ['MARUTI','TATAMOTORS','M&M','EICHERMOT','HEROMOTOCO','BAJAJ-AUTO','TVSMOTOR','ASHOKLEY'],
  NIFTYMETAL: ['TATASTEEL','JSWSTEEL','HINDALCO','VEDL','SAIL','COALINDIA'],
  NIFTYENERGY: ['RELIANCE','ONGC','BPCL','IOC','GAIL','NTPC','POWERGRID','TATAPOWER'],
  NIFTYREALTY: ['DLF'],
  NIFTYINFRA: ['LT','ADANIPORTS','ULTRACEMCO','GRASIM','ACC','AMBUJACEM','SHREECEM','BHEL','SIEMENS','ABB']
};
const SECTOR_OF = {}; for (const [ix, list] of Object.entries(SECTOR_GROUPS)) for (const x of list) SECTOR_OF[x] = ix;
const sectorOf = sym => SECTOR_OF[sym] || 'NIFTY';
const SECTOR_LABEL = { NIFTY: 'Nifty 50', BANKNIFTY: 'Nifty Bank', NIFTYPSUBANK: 'Nifty PSU Bank', NIFTYIT: 'Nifty IT', NIFTYFMCG: 'Nifty FMCG', NIFTYPHARMA: 'Nifty Pharma', NIFTYAUTO: 'Nifty Auto', NIFTYMETAL: 'Nifty Metal', NIFTYENERGY: 'Nifty Energy', NIFTYREALTY: 'Nifty Realty', NIFTYINFRA: 'Nifty Infra' };
// live move of a sector index today: { pct, aboveOpen }, cached 3 minutes
const secMoveCache = {};
async function getSectorMove(ix) {
  const c = secMoveCache[ix]; if (c && Date.now() - c.t < 180000) return c.v;
  let v = null;
  try { const q = await getUpstoxLTPC(await dataKeyFor(ix)); if (q.price > 0 && q.prevClose > 0) v = { pct: (q.price / q.prevClose - 1) * 100, aboveOpen: q.open > 0 ? q.price >= q.open : null }; } catch (e) {}
  secMoveCache[ix] = { t: Date.now(), v }; return v;
}
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


// NSE equity trading holidays (weekdays). A holiday counts as a closed day everywhere (dow 0): no scans, calls, square-off or EOD.
const NSE_HOLIDAYS = new Set((process.env.NSE_HOLIDAYS || '2026-01-15,2026-01-26,2026-03-03,2026-03-26,2026-03-31,2026-04-03,2026-04-14,2026-05-01,2026-05-28,2026-06-26,2026-09-14,2026-10-02,2026-10-20,2026-11-10,2026-11-24,2026-12-25').split(',').map(x => x.trim()).filter(Boolean));
function istParts() { const d = new Date(Date.now() + 19800000), day = d.toISOString().slice(0, 10), hol = NSE_HOLIDAYS.has(day); return { dow: hol ? 0 : d.getUTCDay(), mins: d.getUTCHours() * 60 + d.getUTCMinutes(), holiday: hol, day }; }
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
// A crash restarts the free Render instance (~1 min of "waking up"), so log and carry on instead.
process.on('uncaughtException', e => { console.error('Uncaught (kept running):', e && e.stack || e); });
process.on('unhandledRejection', e => { console.error('Unhandled rejection (kept running):', e && e.stack || e); });
let UpstoxClient;
try { UpstoxClient = require('upstox-js-sdk'); } catch(e) { console.warn('upstox-js-sdk not installed — WebSocket feed unavailable'); }

let upstoxStreamer = null;
let streamerConnected = false;
const sseClients = new Map();
const latestPrices = new Map();
let streamerRetryTimer = null, streamerFails = 0;

function initUpstoxAuth() {
  if (!UpstoxClient) return false;
  const toks = upstoxTokens(), good = toks.filter(t => !tokenBad(t));
  const token = good[0] || toks[0];
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
    try { upstoxStreamer.autoReconnect(false); } catch (e) {} // the SDK's own reconnect throws (clearSubscriptions is not a function) and took the whole server down

    upstoxStreamer.on('open', () => {
      streamerConnected = true; streamerFails = 0;
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
      streamerFails++;
      const wait = Math.min(300000, 10000 * Math.pow(2, Math.min(streamerFails - 1, 5)));
      console.log('Upstox WebSocket closed — retrying in ' + Math.round(wait / 1000) + 's');
      upstoxStreamer = null;
      streamerRetryTimer = setTimeout(() => {
        const keys = allSubscribedKeys();
        if (keys.length) startUpstoxStreamer(keys);
      }, wait);
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
  try { const k = await dataKeyFor(symbol); if (k) return k; } catch (e) {} // live instrument list first (hardcoded ISINs go stale after splits)
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
      // Can't resolve yet (Upstox prices only): the browser keeps polling the Upstox REST quote meanwhile
      for (const sym of (false ? rawSymbols : [])) {
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

    try { lowPriority.run(true, async () => { await runCallsCycle(false); await liveMonitor(); await maybeEod(); }); } catch (e) {}
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
    process.env.UPSTOX_OAUTH_TOKEN = token; badTokenAt.delete(token);
    try { await storeSet('upstox:oauth', { token, t: Date.now() }); } catch (e) {} // survives restarts until it expires
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
// Format: NSE_EQ|<ISIN>. Note: an ISIN DOES change after a stock split, so the live Upstox list is preferred (see dataKeyFor).
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
const badTokenAt = new Map(); // token -> when Upstox last rejected it (expired daily tokens stay in the env)
function tokenBad(t) { const at = badTokenAt.get(t); return !!at && Date.now() - at < 30 * 60000; }
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
  const order = toks.filter(t => !tokenBad(t)).concat(toks.filter(tokenBad)); // known-bad tokens last
  for (const tk of order) {
    await upstoxThrottle();
    const resp = await fetch(url, { headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${tk}` }, signal: AbortSignal.timeout(25000) }); // never hang on a stuck connection
    const json = await resp.json().catch(() => null);
    if (resp.ok && json && json.status === 'success') { HEALTH.upstox.lastOk = Date.now(); badTokenAt.delete(tk); return json.data; }
    const msg = (json && (json.errors?.[0]?.message || json.message)) || `Upstox request failed (${resp.status})`;
    lastErr = new Error(msg); HEALTH.upstox.lastErr = msg; HEALTH.upstox.lastErrAt = Date.now();
    if (resp.status === 401 || resp.status === 403 || /invalid credentials|token/i.test(msg)) { badTokenAt.set(tk, Date.now()); continue; } // try the next token
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
  const e = expiries.find(x => x >= today); if (!e) throw new Error('No options trade on this instrument'); return e;
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

// Fundamentals change slowly: keep the last good answer (memory + saved store) and serve it, marked stale, when Upstox fails
// (rate limits while the strategy lab pulls history, a restart before the instrument list loads, a brief outage).
async function getUpstoxFundamentals(symbol) {
  const now = Date.now();
  if (fundamentalsCache[symbol] && now - fundamentalsCache[symbol].time < FUNDAMENTALS_TTL) return { ...fundamentalsCache[symbol].data, cached: true };
  let err = null;
  for (let a = 0; a < 2; a++) {
    try { const r = await getUpstoxFundamentalsRaw(symbol); try { await storeSet('fund:' + symbol, { t: Date.now(), data: r }); } catch (e) {} return r; }
    catch (e) { err = e; if (a === 0) await new Promise(r => setTimeout(r, 1500)); }
  }
  let old = fundamentalsCache[symbol] ? { t: fundamentalsCache[symbol].time, data: fundamentalsCache[symbol].data } : null;
  if (!old) { try { old = await storeGet('fund:' + symbol, null); } catch (e) {} }
  if (old && old.data) { fundamentalsCache[symbol] = { data: old.data, time: now - FUNDAMENTALS_TTL + 10 * 60 * 1000 }; return { ...old.data, stale: true, staleAt: old.t, staleWhy: err && err.message }; }
  throw err || new Error('Upstox fundamentals unavailable for ' + symbol);
}
async function getUpstoxFundamentalsRaw(symbol) {
  const now = Date.now();
  let instrumentKey = HARDCODED_EQ_KEYS[symbol] || (universeCache.data && universeCache.data.find(s => s.symbol === symbol)?.instrument_key);
  if (!instrumentKey) { try { const k = await dataKeyFor(symbol); if (k && /^NSE_EQ|^BSE_EQ/.test(k)) instrumentKey = k; } catch (e) {} }
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
  if (!Array.isArray(ratios) && !profile) throw new Error('Upstox fundamentals unavailable for ' + symbol + (ratiosData.status === 'rejected' ? ' (' + String(ratiosData.reason && ratiosData.reason.message || ratiosData.reason).slice(0, 90) + ')' : ''));

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

const resolvedIdxKeys = {}, keyMemo = { t: 0, m: null };
async function dataKeyFor(sym) {
  if (resolvedIdxKeys[sym]) return resolvedIdxKeys[sym];
  if (DATA_INDEX_KEYS[sym]) return DATA_INDEX_KEYS[sym];
  const normalized = sym.replace(/[&-]/g, '_');
  // Upstox's own instrument list (refreshed daily) wins: a stock's ISIN changes after a split, so a built-in ID can go stale
  const live = () => { const U = universeCache.data; if (!U) return null; if (keyMemo.t !== universeCache.time) { keyMemo.t = universeCache.time; keyMemo.m = new Map(); for (const x of U) { const cur = keyMemo.m.get(x.symbol); if (!cur || (!/^NSE_EQ\|/.test(cur.instrument_key || '') && /^NSE_EQ\|/.test(x.instrument_key || ''))) keyMemo.m.set(x.symbol, x); } } return keyMemo.m.get(sym) || null; };
  let hit = live(); if (hit && hit.instrument_key) return hit.instrument_key;
  const hk = HARDCODED_EQ_KEYS[sym] || HARDCODED_EQ_KEYS[normalized];
  if (hk && !badEqKeys.has(hk)) return hk; // fast fallback while the list is still loading
  if (!universeCache.data || Date.now() - (universeCache.time || 0) > 3600000) await fetchAndCacheUniverse().catch(() => {}); // refresh at most hourly
  hit = live(); if (hit && hit.instrument_key) return hit.instrument_key;
  if (hk) return hk;
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
  if (!rows.length && /^NSE_EQ\|/.test(key) && !badEqKeys.has(key)) { // stale stock ID (e.g. after a split): mark it and retry with the live instrument list
    badEqKeys.add(key); const k2 = await dataKeyFor(sym);
    if (k2 !== key) { try { rows = await fetchCandlesForKey(k2, tf); } catch (e) { rows = []; } }
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
  // Upstox only: no other vendor's numbers are mixed in; the page shows the error instead
  res.status(502).json({ error: 'Upstox data unavailable: ' + errors.join(' | '), symbol: sym });
});

app.get('/api/upstox/fno/:index', async (req, res) => {
  const indexSymbol = req.params.index;
  if (!UPSTOX_INDEX_KEYS[indexSymbol]) return res.status(400).json({ error: 'Unknown index symbol', symbol: indexSymbol });
  try {
    // built from the option chain itself (PCR, max pain, totals), so it also works on an expiry day when Upstox's
    // separate PCR / max-pain endpoints answer "Invalid expiry"
    const v = await getOiSnapshot(indexSymbol);
    return res.json({ symbol: indexSymbol, expiry: v.expiry, spot: v.spot, pcr: v.totals.pcr, maxPain: v.maxPain, totalCallOi: v.totals.ceOi, totalPutOi: v.totals.peOi, atmIv: v.atmIv, source: 'upstox-chain' });
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

// Open interest for one stock or index (Derivatives tab): every strike's call / put OI, today's change (vs the previous
// day's OI that Upstox reports), volume, premium and IV; totals, PCR now and yesterday, max pain (computed), and the strikes
// with the most call OI (resistance) and put OI (support). 60-second cache per symbol and expiry.
const oiCache = {};
async function getOiSnapshot(symbol, wantExpiry) {
  const key = await resolveInstrumentKey(symbol);
  const ck = symbol + '|' + (wantExpiry || '');
  if (oiCache[ck] && Date.now() - oiCache[ck].t < 60000) return oiCache[ck].v;
  const contracts = await upstoxGet(`/option/contract?instrument_key=${encodeURIComponent(key)}`);
  const today = todayIso();
  const expiries = [...new Set((contracts || []).map(c => c.expiry))].filter(e => e >= today).sort();
  if (!expiries.length) { const e = new Error('No options trade on ' + symbol); e.status = 404; throw e; }
  const expiry = expiries.includes(wantExpiry) ? wantExpiry : expiries[0];
  const lot = ((contracts || []).find(c => c.lot_size) || {}).lot_size || null;
  const chain = await upstoxGet(`/option/chain?instrument_key=${encodeURIComponent(key)}&expiry_date=${expiry}`);
  const side = o => { const m = (o && o.market_data) || {}, g = (o && o.option_greeks) || {};
    return { oi: m.oi || 0, prevOi: m.prev_oi != null ? m.prev_oi : null, chg: m.prev_oi != null ? (m.oi || 0) - m.prev_oi : null, vol: m.volume || 0, ltp: m.ltp != null ? m.ltp : null, ltpChg: (m.ltp != null && m.close_price) ? m.ltp - m.close_price : null, iv: g.iv != null ? g.iv : null }; };
  let spot = null;
  const strikes = (chain || []).map(r => { if (r.underlying_spot_price) spot = r.underlying_spot_price; return { strike: r.strike_price, ce: side(r.call_options), pe: side(r.put_options) }; }).filter(x => x.strike != null).sort((a, b) => a.strike - b.strike);
  if (!strikes.length) throw new Error('Upstox returned an empty option chain');
  const sum = (f) => strikes.reduce((a, x) => a + (f(x) || 0), 0);
  const ceOi = sum(x => x.ce.oi), peOi = sum(x => x.pe.oi), cePrev = sum(x => x.ce.prevOi), pePrev = sum(x => x.pe.prevOi);
  const ceChg = sum(x => x.ce.chg), peChg = sum(x => x.pe.chg), ceVol = sum(x => x.ce.vol), peVol = sum(x => x.pe.vol);
  let maxPain = null, best = Infinity;
  for (const k of strikes) { let pain = 0; for (const x of strikes) { pain += x.ce.oi * Math.max(0, k.strike - x.strike) + x.pe.oi * Math.max(0, x.strike - k.strike); } if (pain < best) { best = pain; maxPain = k.strike; } }
  const top = (f, n, filt) => strikes.filter(filt || (() => true)).slice().sort((a, b) => (f(b) || 0) - (f(a) || 0)).slice(0, n).filter(x => (f(x) || 0) > 0).map(x => ({ strike: x.strike, v: f(x) }));
  const atm = spot != null ? strikes.reduce((a, x) => Math.abs(x.strike - spot) < Math.abs(a.strike - spot) ? x : a, strikes[0]) : null;
  const v = { symbol, expiry, expiries: expiries.slice(0, 8), lot, spot, atm: atm && atm.strike, atmIv: atm ? (atm.ce.iv != null ? atm.ce.iv : atm.pe.iv) : null,
    totals: { ceOi, peOi, ceChg, peChg, ceVol, peVol, pcr: ceOi ? Math.round(peOi / ceOi * 100) / 100 : null, pcrPrev: cePrev ? Math.round(pePrev / cePrev * 100) / 100 : null, hasPrev: cePrev > 0 || pePrev > 0 },
    maxPain, resistance: top(x => x.ce.oi, 3, x => spot == null || x.strike >= spot * 0.98), support: top(x => x.pe.oi, 3, x => spot == null || x.strike <= spot * 1.02),
    ceAdd: top(x => x.ce.chg, 3), peAdd: top(x => x.pe.chg, 3), ceCut: top(x => -(x.ce.chg || 0), 2), peCut: top(x => -(x.pe.chg || 0), 2),
    strikes, market: marketState(), at: Date.now() };
  oiCache[ck] = { t: Date.now(), v };
  return v;
}
// An index option call that buys straight into a big open-interest wall: a CE with heavy call OI just above the price, or a PE
// with heavy put OI just below it (within 0.35%, at least 1.5x the typical strike's OI nearby). Tagged on the call and tracked
// separately (no history of strike-wise OI exists to backtest it); OI_WALL=block skips such calls instead.
function oiWallFor(v, dir) {
  if (!v || !v.spot) return null;
  const sp = v.spot, near = v.strikes.filter(x => Math.abs(x.strike / sp - 1) <= 0.03);
  const oiOf = x => dir === 'BUY' ? x.ce.oi : x.pe.oi, arr = near.map(oiOf).filter(x => x > 0).sort((a, b) => a - b); if (!arr.length) return null;
  const med = arr[Math.floor(arr.length / 2)];
  const cand = near.filter(x => (dir === 'BUY' ? x.strike >= sp && x.strike <= sp * 1.0035 : x.strike <= sp && x.strike >= sp * 0.9965) && oiOf(x) >= 1.5 * med)
    .sort((a, b) => oiOf(b) - oiOf(a))[0];
  return { against: !!cand, strike: cand ? cand.strike : null, distPct: cand ? Math.round(Math.abs(cand.strike / sp - 1) * 10000) / 100 : null, ratio: cand ? Math.round(oiOf(cand) / med * 10) / 10 : null, pcr: v.totals.pcr, expiry: v.expiry };
}
app.get('/api/oi/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase().replace(/[^A-Z0-9&_-]/g, '');
  try {
    if (!upstoxTokens().length) return res.status(503).json({ error: 'Upstox is not connected', symbol });
    res.json(await getOiSnapshot(symbol, req.query.expiry));
  } catch (e) { res.status(e.status || 502).json({ error: e.message, symbol }); }
});

app.get('/api/options/expiries/:symbol', async (req, res) => {
  try {
    const instrumentKey = await resolveInstrumentKey(req.params.symbol);
    const contracts = await upstoxGet(`/option/contract?instrument_key=${encodeURIComponent(instrumentKey)}`);
    const expiries = [...new Set(contracts.map(c => c.expiry))].sort();
    const lot = (contracts.find(c => c.lot_size) || {}).lot_size || null;
    res.json({ symbol: req.params.symbol, expiries, lotSize: lot });
  } catch (e) {
    res.status(502).json({ error: e.message, symbol: req.params.symbol });
  }
});



// ============================================================
// TRADE CALLS — rule-based stock calls (see calls.js), logged and tracked.
// Calls are persisted to Upstash when configured (otherwise memory only and
// lost on restart). New calls are generated by a scan that runs at most every
// SCAN_EVERY ms, triggered by page loads and by /api/check-alerts.
// ============================================================
const Calls = require('./calls');
const SCAN_EVERY = 8 * 60 * 1000;
const CALLS_MAX = 600;
let callsDb = null; let callsLoading = null;
const callsState = { running: false, lastScan: 0, lastErr: null, scanned: 0, found: 0 };
let callsLoadedOk = false; // false = storage could not be read: never overwrite the stored history with a partial list
async function storeGetStrict(key) { const raw = await redisCmd('GET', key); return raw ? JSON.parse(raw) : null; } // throws on a storage error
async function loadCalls() {
  if (callsDb) return callsDb;
  if (!callsLoading) callsLoading = (async () => {
    for (let i = 0; i < 4; i++) {
      try { const a = await storeGetStrict('store:trade-calls'); callsLoadedOk = true; return Array.isArray(a) ? a : []; }
      catch (e) { if (/not configured/.test(e.message)) return []; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
    }
    return []; // storage unreachable: work in memory, and merge with the stored list before the next save
  })().then(a => { callsDb = a;
    // repair: a closed call's result always comes from its exit price (an old race could leave a live-price P/L on it)
    callsDb.forEach(c => { if (c.closed && c.exit != null && c.entry > 0) { const sg = c.side === 'BUY' ? 1 : -1, g = sg * (c.exit - c.entry) / c.entry * 100, cost = c.costPct != null ? c.costPct : Calls.costPct(c.mode); c.grossPct = Math.round(g * 100) / 100; c.pnlPct = Math.round((g - cost) * 100) / 100; c.ltp = c.exit; } });
    return callsDb; });
  return callsLoading;
}
async function saveCalls() {
  try {
    if (!callsLoadedOk) { // the first load failed: fetch the stored list now and merge, instead of overwriting it
      const a = await storeGetStrict('store:trade-calls'); callsLoadedOk = true;
      if (Array.isArray(a)) { const have = new Set(callsDb.map(c => c.id)); const old = a.filter(c => !have.has(c.id)); if (old.length) callsDb.unshift(...old); }
    }
    await storeSet('store:trade-calls', callsDb.slice(-CALLS_MAX));
    const day = istDateKey(Math.floor(Date.now() / 1000)); // one rolling backup per day, kept 10 days
    if (lastCallsBackup !== day) { lastCallsBackup = day; try { await redisCmd('SET', 'store:trade-calls:bak:' + day, JSON.stringify(callsDb.slice(-CALLS_MAX)), 'EX', '864000'); } catch (e) {} }
  } catch (e) { /* storage unreachable: keep in memory, retry on the next save */ }
}
let lastCallsBackup = null;
const toBars = rows => rows.map(r => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
function istMinsNow() { const p = istParts(); return p.mins; }

const keyCandleCache = {};
async function getCandlesByKey(key, tf) { // option contracts: 20 s cache
  const ck = key + '|' + tf, c = keyCandleCache[ck]; if (c && Date.now() - c.time < 20000) return c.data;
  const data = await fetchCandlesForKey(key, tf); keyCandleCache[ck] = { data, time: Date.now() };
  return data;
}
async function trackCall(call) {
  try {
    if (call.kind === 'option') {
      const opt = toBars(await getCandlesByKey(call.instrumentKey, '15m'));
      let spot = null; try { spot = toBars(await getUpstoxCandles(call.underlying, '15m')); } catch (e) {}
      const nowSec = Math.floor(Date.now() / 1000);
      if (spot && spot.length && spot[spot.length - 1].t + 900 > nowSec) spot = spot.slice(0, -1); // closed bars only
      Object.assign(call, Calls.trackOption(call, opt, spot, nowSec));
      return;
    }
    const rows = await getUpstoxCandles(call.symbol, call.mode === 'intraday' ? '15m' : '1h');
    const st = Calls.track(call, toBars(rows), Math.floor(Date.now() / 1000));
    Object.assign(call, st);
  } catch (e) { /* keep last state */ }
}

// ---- Call events (target / stop hits), live monitor and end-of-day summary ----
let evDb = null;
async function loadEvents() { if (!evDb) { const a = await storeGet('store:calls-events', []); evDb = Array.isArray(a) ? a : []; } return evDb; }
// Alerts you have not acknowledged: the page beeps until you press Seen; Telegram repeats an important one once after 3 minutes.
const ACK_KINDS = /^(NEW|SL|BE|T\d)$/;
let ackDb = null;
async function loadAcks() { if (!ackDb) { const a = await storeGet('store:calls-acks', { ids: [], reminded: [] }); ackDb = { ids: a.ids || [], reminded: a.reminded || [] }; } return ackDb; }
async function saveAcks() { try { ackDb.ids = ackDb.ids.slice(-400); ackDb.reminded = ackDb.reminded.slice(-400); await storeSet('store:calls-acks', ackDb); } catch (e) {} }
async function remindUnacked() {
  const ev = await loadEvents(), A = await loadAcks(), now = Math.floor(Date.now() / 1000);
  const due = ev.filter(e => ACK_KINDS.test(e.kind) && now - e.t >= 180 && now - e.t < 1800 && !A.ids.includes(e.id) && !A.reminded.includes(e.id));
  if (!due.length) return;
  due.forEach(e => A.reminded.push(e.id)); await saveAcks();
  const txt = '⏰ <b>Not seen yet</b> (' + due.length + ')\n' + due.slice(0, 6).map(e => '• ' + String(e.text || '').replace(/<\/?(?!b>)[^>]*>/g, '') + ' (' + Math.round((now - e.t) / 60) + ' min ago)').join('\n') + '\nOpen the Calls Monitor and press Seen to stop reminders.';
  try { await sendTelegram(txt); } catch (e) {}
}
// No Upstox login by 9:05 on a trading day: one Telegram reminder with the login link (the token expires at 3:30 every morning)
let loginRemindDay = '';
async function remindLogin() {
  const p = istParts(); if (p.dow === 0 || p.dow === 6 || p.mins < 545 || p.mins > 600 || loginRemindDay === p.day) return;
  let ok = upstoxTokens().length > 0;
  if (ok) { try { await upstoxFetchJson(`https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encodeURIComponent('NSE_INDEX|Nifty 50')}`); } catch (e) { ok = false; } }
  loginRemindDay = p.day; if (ok) return;
  const base = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
  try { await sendTelegram('🔑 <b>Upstox is not logged in</b> and the market opens at 9:15. No live prices or calls until you log in' + (base ? ':\n' + base.replace(/\/$/, '') + '/upstox-login' : ' (open the dashboard → Status → Connect Upstox).')); } catch (e) {}
}
// Stay awake through market hours: Render's free plan sleeps a service after ~15 min without inbound requests, and
// GitHub's scheduled pings arrive only every few hours. Once awake (the 9:05 login reminder, your first visit, or the
// GitHub ping), the server requests its own public address every 8 minutes from 8:45 to 15:50 on trading days; that
// request comes back in through Render's front door, which counts as a visit.
const SELF_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
let lastSelfPing = 0;
// it also pings while the strategy lab is running at any hour: the lab takes about an hour, and a free Render service that gets no visit for 15 minutes goes to sleep and the run is lost
setInterval(() => { const p = istParts(), labBusy = typeof gate !== 'undefined' && gate && gate.building; if (!SELF_URL || (!labBusy && (p.dow === 0 || p.dow === 6 || p.mins < 525 || p.mins > 950)) || Date.now() - lastSelfPing < (labBusy ? 5 : 8) * 60000) return;
  lastSelfPing = Date.now(); fetch(SELF_URL + '/healthz', { signal: AbortSignal.timeout(20000) }).catch(() => {}); }, 60000).unref();
setInterval(() => { remindLogin().catch(() => {}); const p = istParts(); if (p.dow !== 0 && p.dow !== 6 && p.mins >= 555 && p.mins <= 945) remindUnacked().catch(() => {}); }, 60000).unref();
app.post('/api/calls/ack', async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String).slice(0, 200) : [];
  const A = await loadAcks(); ids.forEach(id => { if (!A.ids.includes(id)) A.ids.push(id); }); await saveAcks(); res.json({ ok: true, n: ids.length });
});
async function emitEvent(e, tg = true) {
  const db = await loadEvents();
  if (db.some(x => x.id === e.id)) return;
  db.push(e); if (db.length > 300) db.splice(0, db.length - 300);
  try { await storeSet('store:calls-events', db); } catch (x) { /* memory only */ }
  if (tg) { try { await sendTelegram(e.text + '\n<i>Rule-based screen, not advice.</i>'); } catch (x) {} }
}
function callEvents(c, before) {
  const out = []; const now = Math.floor(Date.now() / 1000);
  const base = { callId: c.id, source: srcOf(c), symbol: c.symbol, side: c.side, mode: c.mode, t: now };
  const tag = c.manual ? `[${srcOf(c) === 'pattern' ? 'Pattern' : srcOf(c) === 'agreement' ? 'Agreement' : 'Screener'}] ` : '';
  const pct = x => (x > 0 ? '+' : '') + x + '%';
  for (let i = before.hit + 1; i <= (c.targetsHit || 0); i++) {
    const px = c.targets[i - 1];
    out.push({ ...base, id: c.id + ':T' + i, kind: 'T' + i, level: 'good', price: px, pnlPct: null,
      text: `🎯 ${tag}<b>${c.symbol}</b> ${c.side} (${c.mode}) hit Target ${i} at ₹${px}` + (i === 1 ? '. Stop moved to entry.' : '') });
  }
  if (c.closed && !before.closed && c.status !== 'TARGET_HIT') {
    const k = c.status === 'SL_HIT' ? 'SL' : c.status === 'EXPIRED' ? 'EXPIRED' : 'BE';
    const icon = k === 'SL' ? '🛑' : k === 'EXPIRED' ? '⏱' : '⚪';
    const word = k === 'SL' ? 'hit its stop loss' : k === 'EXPIRED' ? 'expired' : 'was stopped at entry (after a target)';
    out.push({ ...base, id: c.id + ':' + k, kind: k, level: k === 'SL' ? 'bad' : 'info', price: c.exit, pnlPct: c.pnlPct,
      text: `${icon} ${tag}<b>${c.symbol}</b> ${c.side} (${c.mode}) ${word} at ₹${c.exit} (${pct(c.pnlPct)})` });
  } else if (c.closed && !before.closed) {
    out[out.length - 1] && (out[out.length - 1].text += ` (${pct(c.pnlPct)}). All targets done, call closed.`);
  }
  return out;
}
async function applyTrack(c) {
  const before = { hit: c.targetsHit || 0, closed: !!c.closed };
  await trackCall(c);
  if (c.closed && !before.closed) c.closedAt = c.exitT || Math.floor(Date.now() / 1000);
  for (const e of callEvents(c, before)) await emitEvent(e, true);
}
// Intraday calls are squared off at INTRADAY_EXIT (default 15:20 IST) at the live price, instead of waiting for the next scan.
const INTRADAY_EXIT_MIN = (() => { const m = /^(\d{1,2}):(\d{2})$/.exec(process.env.INTRADAY_EXIT || '15:20'); return m ? +m[1] * 60 + +m[2] : 920; })();
let squaring = false;
async function squareOffIntraday() {
  if (squaring || !upstoxTokens().length) return;
  const { dow, mins } = istParts(); if (dow < 1 || dow > 5 || mins < INTRADAY_EXIT_MIN || mins > 16 * 60) return;
  squaring = true;
  try {
    const db = await loadCalls(), now = Math.floor(Date.now() / 1000), day = istDateKey(now); let changed = false;
    for (const c of db.filter(x => !x.closed && x.mode === 'intraday' && istDateKey(x.t) === day)) {
      try {
        const q = await getUpstoxLTPC(c.instrumentKey || await dataKeyFor(c.symbol)); if (!(q.price > 0) || c.closed) continue;
        const sg = c.side === 'BUY' ? 1 : -1, cost = c.costPct != null ? c.costPct : Calls.costPct(c.mode), gross = sg * (q.price - c.entry) / c.entry * 100;
        Object.assign(c, { status: 'EXPIRED', closed: true, exit: Math.round(q.price * 100) / 100, ltp: Math.round(q.price * 100) / 100, exitT: now, closedAt: now, grossPct: Math.round(gross * 100) / 100, pnlPct: Math.round((gross - cost) * 100) / 100 });
        changed = true;
        await emitEvent({ id: c.id + ':EXPIRED', callId: c.id, source: srcOf(c), symbol: c.symbol, side: c.side, mode: c.mode, kind: 'EXPIRED', level: 'info', t: now, price: c.exit, pnlPct: c.pnlPct, text: `⏰ Intraday time exit ${Math.floor(INTRADAY_EXIT_MIN / 60)}:${String(INTRADAY_EXIT_MIN % 60).padStart(2, '0')}: ${c.side} ${c.symbol} at ${c.exit} (${c.pnlPct > 0 ? '+' : ''}${c.pnlPct}%)` }, true);
      } catch (e) { /* retry next minute */ }
    }
    if (changed) await saveCalls();
    try { await trackShadows(); } catch (e) {} // watch-only index signals get the same time exit
  } finally { squaring = false; }
}
setInterval(() => { squareOffIntraday().catch(() => {}); }, 60000).unref();
// Self-driven scans: during market hours the server scans on its own (every SCAN_EVERY),
// so calls are generated even when no dashboard tab is open. UptimeRobot keeps it awake.
setInterval(() => {
  try {
    const p = istParts(); if (p.dow === 0 || p.dow === 6 || p.mins < 555 || p.mins > 935 || !upstoxTokens().length) return;
    lowPriority.run(true, async () => { try { await runCallsCycle(false); await liveMonitor(); await maybeEod(); } catch (e) {} });
  } catch (e) {}
}, 60000).unref();
let lastLive = 0;
async function liveMonitor() {
  if (Date.now() - lastLive < 15000) return; lastLive = Date.now();
  if (!upstoxTokens().length) return;
  const db = await loadCalls(); const act = db.filter(c => !c.closed); if (!act.length) return;
  let changed = false;
  for (const c of act) {
    try {
      const q = await getUpstoxLTPC(c.instrumentKey || await dataKeyFor(c.symbol));
      if (q.price == null || c.closed) continue; // closed by the scan while we waited: never overwrite a final result with a live price
      const sgn = c.side === 'BUY' ? 1 : -1;
      c.ltp = q.price; c.pnlPct = Math.round((sgn * (q.price - c.entry) / c.entry * 100 - (c.costPct != null ? c.costPct : Calls.costPct(c.mode))) * 100) / 100; changed = true;
      const nextT = c.targets[c.targetsHit || 0];
      const trig = sgn === 1 ? (q.price <= c.activeSl || (nextT != null && q.price >= nextT)) : (q.price >= c.activeSl || (nextT != null && q.price <= nextT));
      if (trig) { const live = c.ltp; await applyTrack(c); if (!c.closed) c.ltp = live; }
    } catch (e) { /* skip this call this round */ }
  }
  if (changed) await saveCalls();
}
function istDateKey(t) { return new Date((t + 19800) * 1000).toISOString().slice(0, 10); }
async function loadEod() { const a = await storeGet('store:calls-eod', []); return Array.isArray(a) ? a : []; }
// ---- Risk in rupees: your capital and risk per trade size every new call (quantity / lots, ₹ at risk, ₹ profit or loss),
// and a daily loss stop halts new Trade Calls for the rest of the day once today's calls have lost that much (paper).
let riskCfg = { on: false, capital: 100000, riskPct: 1, dailyStopPct: 2, leverage: 5 };
storeGet('store:risk-settings', null).then(v => { if (v && typeof v === 'object') riskCfg = { ...riskCfg, ...v }; }).catch(() => {});
function sizeCall(c) {
  if (!riskCfg.on || !(c.entry > 0) || !(c.sl > 0)) return c;
  const riskRs = riskCfg.capital * riskCfg.riskPct / 100, per = Math.abs(c.entry - c.sl); if (!(per > 0)) return c;
  if (c.kind === 'option') { const lot = c.lotSize || 1, perLot = per * lot; const lots = Math.max(1, Math.floor(riskRs / perLot)); Object.assign(c, { lots, qty: lots * lot, riskRs: Math.round(perLot * lots), capRs: Math.round(c.entry * lots * lot), overRisk: perLot > riskRs }); }
  else { const capMax = riskCfg.capital * (c.mode === 'intraday' ? (riskCfg.leverage || 1) : 1); let qty = Math.floor(riskRs / per); qty = Math.min(qty, Math.floor(capMax / c.entry)); Object.assign(c, { qty: Math.max(0, qty), riskRs: Math.round(per * Math.max(0, qty)), capRs: Math.round(c.entry * Math.max(0, qty)) }); }
  return c;
}
const pnlRsOf = c => (c.qty > 0 && c.pnlPct != null && c.entry > 0) ? Math.round(c.pnlPct / 100 * c.entry * c.qty) : null;
function withRs(c) { const r = pnlRsOf(c); return r == null ? c : { ...c, pnlRs: r }; }
// today's Trade Calls (not your own monitor items) in rupees: closed today + still open
function dayRs(db) { const day = istDateKey(Math.floor(Date.now() / 1000)); let closed = 0, open = 0, n = 0;
  db.filter(c => !c.manual && c.qty > 0).forEach(c => { const r = pnlRsOf(c); if (r == null) return; if (c.closed && istDateKey(c.closedAt || c.exitT || c.t) === day) { closed += r; n++; } else if (!c.closed) open += r; });
  return { day, closed, open, total: closed + open, n, limit: riskCfg.on ? -Math.round(riskCfg.capital * riskCfg.dailyStopPct / 100) : null }; }
let dailyStopTold = '';
function dailyStopped(db) { if (!riskCfg.on || !(riskCfg.dailyStopPct > 0)) return false; const d = dayRs(db); const hit = d.total <= d.limit;
  if (hit && dailyStopTold !== d.day) { dailyStopTold = d.day; sendTelegram(`🛑 <b>Daily loss stop</b>: today's calls are at ₹${d.total.toLocaleString('en-IN')} (limit ₹${d.limit.toLocaleString('en-IN')}). No new Trade Calls until tomorrow; open calls keep running to their stops and targets.`).catch(() => {}); }
  return hit; }
// ---- Weekly lab report (Saturday 10:00 IST, Telegram + Calls Monitor): every kind of call's live results this week and
// since it started, next to its backtest record from the strategy lab; kinds whose live results lag their backtest are flagged.
async function buildWeekly() {
  const db = await loadCalls(), now = Math.floor(Date.now() / 1000), from = now - 7 * 86400, r2 = x => Math.round(x * 100) / 100;
  const agg = a => { const n = a.length; if (!n) return null; const w = a.filter(c => c.pnlPct > 0.05 && c.status !== 'BREAKEVEN').length, avg = a.reduce((s, c) => s + c.pnlPct, 0) / n;
    const rs = a.reduce((s, c) => s + (pnlRsOf(c) || 0), 0); return { n, win: Math.round(w / n * 100), avg: r2(avg), sum: r2(avg * n), rs: Math.round(rs), from: Math.min(...a.map(c => c.t)), to: Math.max(...a.map(c => c.closedAt || c.exitT || c.t)) }; };
  const closed = db.filter(c => c.closed && !c.manual), keys = [...new Set(closed.map(c => (c.gateKey || '').split('@')[0]).filter(Boolean))];
  const kinds = keys.map(k => { const all = closed.filter(c => (c.gateKey || '').split('@')[0] === k), wk = all.filter(c => (c.closedAt || c.exitT || c.t) >= from), lab = (gate.kinds || {})[k];
    const live = agg(all), week = agg(wk);
    const lagging = !!(live && lab && live.n >= 8 && lab.avg != null && live.avg < 0 && lab.avg > 0);
    return { key: k, label: gateLabel(k), week, live, lab: lab ? { n: lab.n, avg: lab.avg, winRate: lab.winRate, from: lab.from, to: lab.to, pass: !!lab.pass, retired: isRetired(lab) } : null, lagging };
  }).sort((a, b) => (b.week ? b.week.n : 0) - (a.week ? a.week.n : 0));
  const man = db.filter(c => c.closed && c.manual && (c.closedAt || c.exitT || c.t) >= from), bySrc = {};
  Object.keys(SOURCES).filter(k => k !== 'calls').forEach(k => { bySrc[k] = agg(man.filter(c => srcOf(c) === k)); });
  const labKinds = Object.entries(gate.kinds || {}).filter(([k]) => !k.includes('@'));
  const opts = closed.filter(c => c.kind === 'option' && c.oiWall), oiWall = { against: agg(opts.filter(c => c.oiWall.against)), clear: agg(opts.filter(c => !c.oiWall.against)) };
  return { built: now, from, to: now, oiWall, weekAll: agg(closed.filter(c => (c.closedAt || c.exitT || c.t) >= from)), kinds, bySrc,
    lab: { built: gate.t || null, labVersion: gate.labVersion || null, proven: labKinds.filter(([, v]) => v.pass).map(([k]) => gateLabel(k)), paused: labKinds.filter(([, v]) => isRetired(v)).map(([k]) => gateLabel(k)), blocked: (callsState.gateBlocked || []).slice(0, 10) } };
}
function weeklyText(x) {
  const d = t => new Date(t * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }), sg = v => v == null ? '—' : (v > 0 ? '+' : '') + v + '%';
  let t = `📅 <b>Weekly report</b> ${d(x.from)} – ${d(x.to)}\n`;
  t += x.weekAll ? `Trade Calls closed this week: ${x.weekAll.n} (${d(x.weekAll.from)} – ${d(x.weekAll.to)}), win ${x.weekAll.win}%, avg ${sg(x.weekAll.avg)}${riskCfg.on ? ', ₹' + x.weekAll.rs.toLocaleString('en-IN') : ''}\n` : 'No Trade Calls closed this week.\n';
  x.kinds.filter(k => k.week).slice(0, 8).forEach(k => { t += `• ${k.label}: week ${k.week.n} trades, avg ${sg(k.week.avg)} · since start ${k.live.n} trades (${d(k.live.from)} – ${d(k.live.to)}), avg ${sg(k.live.avg)}${k.lab ? ' · lab ' + k.lab.n + ' trades, avg ' + sg(k.lab.avg) : ''}${k.lagging ? ' ⚠️ live behind the backtest' : ''}\n`; });
  Object.entries(x.bySrc).forEach(([k, v]) => { if (v) t += `${SOURCES[k]}: ${v.n} closed, win ${v.win}%, avg ${sg(v.avg)}\n`; });
  if (x.oiWall && (x.oiWall.against || x.oiWall.clear)) t += `Index options into an OI wall: ${x.oiWall.against ? x.oiWall.against.n + ' closed, avg ' + sg(x.oiWall.against.avg) : 'none'} · clear of walls: ${x.oiWall.clear ? x.oiWall.clear.n + ' closed, avg ' + sg(x.oiWall.clear.avg) : 'none'} (since tagging began)\n`;
  t += `Lab: ${x.lab.proven.length} kinds proven${x.lab.paused.length ? ', ' + x.lab.paused.length + ' paused' : ''}.`;
  return t + '\n<i>Paper results; not advice.</i>';
}
let weeklyDone = '';
setInterval(async () => { try { const d = new Date(Date.now() + 19800000); if (d.getUTCDay() !== 6 || d.getUTCHours() * 60 + d.getUTCMinutes() < 600) return; const key = d.toISOString().slice(0, 10); if (weeklyDone === key) return;
  const list = await storeGet('store:weekly-reports', []); if (list.some(r => r.key === key)) { weeklyDone = key; return; }
  weeklyDone = key; const x = await buildWeekly(); x.key = key; list.push(x); await storeSet('store:weekly-reports', list.slice(-12)); await sendTelegram(weeklyText(x)); } catch (e) {} }, 10 * 60000).unref();
app.get('/api/calls/weekly', async (req, res) => { try { const list = await storeGet('store:weekly-reports', []); const live = await buildWeekly(); res.json({ latest: list[list.length - 1] || null, now: live, list: list.slice(-6).map(r => ({ key: r.key, from: r.from, to: r.to })) }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/settings/risk', async (req, res) => { const db = await loadCalls(); res.json({ ...riskCfg, today: dayRs(db), stopped: dailyStopped(db) }); });
app.post('/api/settings/risk', async (req, res) => {
  const b = req.body || {}, num = (v, lo, hi, d) => { const x = Number(v); return isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  riskCfg = { on: !!b.on, capital: num(b.capital, 1000, 1e9, riskCfg.capital), riskPct: num(b.riskPct, 0.1, 10, riskCfg.riskPct), dailyStopPct: num(b.dailyStopPct, 0, 50, riskCfg.dailyStopPct), leverage: num(b.leverage, 1, 10, riskCfg.leverage) };
  try { await storeSet('store:risk-settings', riskCfg); } catch (e) {}
  res.json({ ok: true, ...riskCfg });
});
const SOURCES = { calls: 'Trade Calls', pattern: 'Chart patterns (price action)', screener: 'Screener & scans', agreement: 'Agreement (screener + pattern + breakout, paper)' };
const srcOf = c => c.source || 'calls';
function buildEod(db, events, day, src) {
  if (src) { db = db.filter(c => srcOf(c) === src); const ids = new Set(db.map(c => c.id)); events = events.filter(e => ids.has(e.callId)); }
  const r2 = x => Math.round(x * 100) / 100;
  const slim = c => ({ symbol: c.symbol, kind: c.kind || 'stock', source: srcOf(c), side: c.side, mode: c.mode, status: c.status, entry: c.entry, exit: c.exit, ltp: c.ltp, pnlPct: c.pnlPct, targetsHit: c.targetsHit || 0 });
  const created = db.filter(c => istDateKey(c.t) === day);
  const closed = db.filter(c => c.closed && istDateKey(c.closedAt || c.exitT || c.t) === day);
  const active = db.filter(c => !c.closed);
  // an exit at the entry price is breakeven (its small minus is only costs), never a loss
  const isW = c => c.status !== 'BREAKEVEN' && c.pnlPct > 0.05, isL = c => c.status !== 'BREAKEVEN' && c.pnlPct < -0.05;
  const wins = closed.filter(isW), losses = closed.filter(isL);
  const sum = a => a.reduce((s, c) => s + c.pnlPct, 0);
  // stocks and index options are kept apart: an option's % is of its premium and is not comparable to a stock's %
  const part = f => { const cl = closed.filter(f), ac = active.filter(f), w = cl.filter(isW).length, l = cl.filter(isL).length;
    return { created: created.filter(f).length, closed: cl.length, wins: w, losses: l, flat: cl.length - w - l, netPct: r2(sum(cl)), winRate: w + l ? r2(w / (w + l) * 100) : null, open: ac.length, openPnlPct: r2(sum(ac)) }; };
  const evs = events.filter(e => istDateKey(e.t) === day);
  const sorted = closed.slice().sort((a, b) => b.pnlPct - a.pnlPct);
  return {
    date: day, built: Math.floor(Date.now() / 1000),
    created: { total: created.length, buy: created.filter(c => c.side === 'BUY').length, sell: created.filter(c => c.side === 'SELL').length, intraday: created.filter(c => c.mode === 'intraday').length, swing: created.filter(c => c.mode === 'swing').length },
    closed: { total: closed.length, wins: wins.length, losses: losses.length, flat: closed.length - wins.length - losses.length, netPct: r2(sum(closed)), winRate: wins.length + losses.length ? r2(wins.length / (wins.length + losses.length) * 100) : null },
    byType: { stocks: part(c => c.kind !== 'option'), options: part(c => c.kind === 'option') },
    targetHits: evs.filter(e => /^T\d$/.test(e.kind)).length, slHits: evs.filter(e => e.kind === 'SL').length,
    active: { total: active.length, openPnlPct: r2(sum(active)), inProfit: active.filter(c => c.pnlPct > 0.05).length, inLoss: active.filter(c => c.pnlPct < -0.05).length, list: active.map(slim) },
    best: sorted[0] ? slim(sorted[0]) : null, worst: sorted.length ? slim(sorted[sorted.length - 1]) : null,
    closedList: sorted.map(slim),
    allTime: Calls.summarize(db), source: src || 'all',
  };
}
function buildEodAll(db, ev, day) { const x = buildEod(db, ev, day); x.bySource = {}; for (const k of Object.keys(SOURCES)) x.bySource[k] = buildEod(db, ev, day, k); return x; }
function eodText(x) {
  const sg = n => (n > 0 ? '+' : '') + n + '%';
  let t = `📊 <b>Monitor: end of day ${x.date}</b>\n`;
  if (x.bySource) t += Object.keys(SOURCES).filter(k => x.bySource[k].created.total || x.bySource[k].closed.total || x.bySource[k].active.total).map(k => { const y = x.bySource[k]; return `${SOURCES[k]}: ${y.closed.total} closed (${y.closed.wins}W/${y.closed.losses}L, net ${sg(y.closed.netPct)}), ${y.active.total} open`; }).join('\n') + '\n';
  t += `New today: ${x.created.total} (buy ${x.created.buy}, sell ${x.created.sell}; intraday ${x.created.intraday}, swing ${x.created.swing})\n`;
  t += `Closed today: ${x.closed.total} (${x.closed.wins}W / ${x.closed.losses}L / ${x.closed.flat} breakeven)` + (x.closed.winRate != null ? `, win rate ${x.closed.winRate}%` : '') + '\n';
  if (x.byType) { const S = x.byType.stocks, O = x.byType.options;
    if (S.closed || S.open) t += `  Stocks: ${S.closed} closed (${S.wins}W/${S.losses}L/${S.flat} BE), net ${sg(S.netPct)}\n`;
    if (O.closed || O.open) t += `  Index options: ${O.closed} closed (${O.wins}W/${O.losses}L/${O.flat} BE), net ${sg(O.netPct)} of premium\n`; }
  t += `Targets hit: ${x.targetHits}, stops hit: ${x.slHits}\n`;
  t += `Still open: ${x.active.total} (${x.active.inProfit} in profit, ${x.active.inLoss} in loss, combined running ${sg(x.active.openPnlPct)})\n`;
  if (x.best) t += `Best: ${x.best.symbol} ${sg(x.best.pnlPct)}\n`;
  if (x.worst && x.worst.symbol !== (x.best && x.best.symbol)) t += `Worst: ${x.worst.symbol} ${sg(x.worst.pnlPct)}\n`;
  if (x.allTime.winRate != null) t += `All-time: ${x.allTime.closed} closed, win rate ${x.allTime.winRate}%, expectancy ${sg(x.allTime.expectancy)} per call\n`;
  return t + '<i>Rule-based screen, not advice.</i>';
}
let eodRunning = false;
async function runEod(day, force) {
  if (eodRunning) return null; eodRunning = true;
  try {
    const list = await loadEod();
    if (!force && list.some(x => x.date === day)) return null;
    if (upstoxTokens().length) { callsState.lastScan = 0; await runCallsCycle(true); }
    const db = await loadCalls(); const ev = await loadEvents();
    const x = buildEodAll(db, ev, day);
    if (!force && !x.created.total && !x.closed.total && !x.active.total) return null;
    const out = list.filter(y => y.date !== day); out.push(x); out.sort((a, b) => a.date < b.date ? -1 : 1);
    try { await storeSet('store:calls-eod', out.slice(-45)); } catch (e) {}
    try { await sendTelegram(eodText(x)); } catch (e) {}
    return x;
  } finally { eodRunning = false; }
}
async function maybeEod() {
  const { dow, mins } = istParts();
  if (dow < 1 || dow > 5 || mins < 940) return; // after 15:40 IST on trading days
  try { await runEod(istDateKey(Math.floor(Date.now() / 1000)), false); } catch (e) {}
}


// Daily history strictly from Upstox (the same exchange feed the dashboard's own chart uses). No Yahoo fallback:
// if Upstox cannot supply a symbol it is skipped rather than silently mixing in different numbers.
async function getHistUpstox(sym, maxBars) {
  const rows = await getUpstoxCandles(appSym(sym), '1D');
  if (!rows || rows.length < 80) throw new Error('not enough Upstox history for ' + sym);
  return toBars(rows).slice(-(maxBars || 500));
}

// Index context for gating calls: daily trend bias plus today's move. Cached 3 minutes.
let idxCtx = { t: 0, v: null };
async function getIndexContext() {
  if (idxCtx.v && Date.now() - idxCtx.t < 180000) return idxCtx.v;
  const { dow, mins } = istParts(); const open = dow >= 1 && dow <= 5 && mins >= 555 && mins <= 930;
  let v = { dailyBias: 'MIXED', todayPct: null, intradayBias: 'MIXED' };
  try {
    const rows = await getUpstoxCandles('NIFTY', '1D'); let bars = toBars(rows);
    if (open && mins < 915) bars = bars.slice(0, -1);
    v.dailyBias = Calls.marketBias(bars.slice(-150)); v.idxBars = bars.slice(-400);
    const q = await getUpstoxLTPC(await dataKeyFor('NIFTY'));
    const prev = (open && mins < 915) ? rows[rows.length - 2] : rows[rows.length - 1];
    if (q.price != null && prev && prev.c) v.todayPct = Math.round((q.price / prev.c - 1) * 10000) / 100;
    if (v.todayPct != null) v.intradayBias = v.todayPct > 0.3 ? 'BULL' : v.todayPct < -0.3 ? 'BEAR' : 'MIXED';
  } catch (e) { v.err = e.message; }
  idxCtx = { t: Date.now(), v };
  return v;
}

// ---- Index option BUY calls (Nifty / Bank Nifty / Sensex) -------------------------------------------
// The index engine (calls.js evaluateIndex) gives a SPOT signal. Here it becomes a concrete contract: buy a CE for an
// up signal, a PE for a down signal, on a stated expiry and strike taken from the live Upstox contract list / chain.
const INDEX_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX'];
const COST_OPTION = Number(process.env.COST_OPTION_PCT) || 2; // round-trip % of premium (brokerage, charges, spread)
const optContractCache = {};
async function getOptionContracts(u) {
  const c = optContractCache[u]; if (c && Date.now() - c.t < 30 * 60000) return c.v;
  let key = UPSTOX_INDEX_KEYS[u], list;
  try { list = await upstoxGet(`/option/contract?instrument_key=${encodeURIComponent(key)}`); }
  catch (e) { key = await resolveInstrumentKey(u); list = await upstoxGet(`/option/contract?instrument_key=${encodeURIComponent(key)}`); }
  if (!Array.isArray(list) || !list.length) throw new Error('no option contracts for ' + u);
  const v = { key, list }; optContractCache[u] = { t: Date.now(), v }; return v;
}
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
const fmtDate = d => { const x = new Date(d + 'T00:00:00Z'); return x.getUTCDate() + ' ' + x.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }) + ' ' + x.getUTCFullYear(); };
/** Which expiry to buy, and why. Intraday: avoid expiry day (decay and gamma). Multi-day: need time for the move. */
function pickExpiry(contracts, mode) {
  const today = istDate(0);
  const exps = [...new Set(contracts.map(c => c.expiry))].filter(e => e >= today).sort();
  if (!exps.length) return null;
  const info = e => ({ expiry: e, dte: dayDiff(e, today) });
  if (mode === 'intraday') {
    const e = exps.find(x => dayDiff(x, today) >= 1) || exps[0], i = info(e);
    return { ...i, why: i.dte >= 1 ? `Nearest expiry with at least a day left (${i.dte} day${i.dte === 1 ? '' : 's'}): fast premium response without expiry-day decay` : `Only the expiry-day contract is available; premium decays quickly, keep it short` };
  }
  let e = exps.find(x => dayDiff(x, today) >= 12);
  if (!e) { const ok = exps.filter(x => dayDiff(x, today) >= 7); e = ok[ok.length - 1]; }
  if (!e) return null;
  const i = info(e), hold = Math.max(1, Math.min(Calls.IDX_HOLD_DAYS, i.dte - 2));
  return { ...i, hold, why: `First expiry with 12+ days left (${i.dte} days): enough time for the move, and decay is slow. Plan to exit within ${hold} days (before ${fmtDate(new Date(Date.now() + 19800000 + hold * 86400000).toISOString().slice(0, 10))}) and never carry into the last 2 days` };
}
async function buildOptionCall(u, ev, spotLtp, nowSec) {
  const { key, list } = await getOptionContracts(u);
  const pe = pickExpiry(list, ev.mode); if (!pe) throw new Error('no suitable expiry');
  const optType = ev.side === 'BUY' ? 'CE' : 'PE';
  const chain = await upstoxGet(`/option/chain?instrument_key=${encodeURIComponent(key)}&expiry_date=${pe.expiry}`);
  const rows = (chain || []).filter(r => r && r.strike_price != null).sort((a, b) => a.strike_price - b.strike_price);
  if (rows.length < 5) throw new Error('empty option chain');
  let atm = 0; rows.forEach((r, i) => { if (Math.abs(r.strike_price - spotLtp) < Math.abs(rows[atm].strike_price - spotLtp)) atm = i; });
  const itm = ev.mode === 'swing' ? 1 : 0; // multi-day: one strike in the money (more delta, less decay drag)
  const idx = Math.max(0, Math.min(rows.length - 1, optType === 'CE' ? atm - itm : atm + itm));
  const row = rows[idx], opt = optType === 'CE' ? row.call_options : row.put_options;
  if (!opt || !opt.instrument_key) throw new Error('strike has no ' + optType);
  const md = opt.market_data || {};
  let ltp = md.ltp; if (!(ltp > 0)) { const q = await getUpstoxLTPC(opt.instrument_key); ltp = q.price; }
  if (!(ltp > 0)) throw new Error('no premium');
  if (ltp < 20) throw new Error('premium too low (' + ltp + ')');
  const bid = md.bid_price, ask = md.ask_price;
  if (bid > 0 && ask > 0 && (ask - bid) / ltp > 0.03) throw new Error('wide bid-ask (' + bid + '/' + ask + ')');
  if (md.oi != null && md.oi < 1000) throw new Error('thin open interest (' + md.oi + ')');
  let delta = Math.abs(opt.option_greeks && opt.option_greeks.delta); if (!(delta > 0)) delta = itm ? 0.6 : 0.5;
  delta = Math.max(0.35, Math.min(0.8, delta));
  const spec = list.find(c => c.instrument_key === opt.instrument_key) || list.find(c => c.expiry === pe.expiry && c.strike_price === row.strike_price && c.instrument_type === optType) || {};
  const shift = spotLtp - ev.entry, sgn = ev.side === 'BUY' ? 1 : -1;
  const spotSl = tickN(ev.sl + shift), spotT = ev.targets.map(x => tickN(x + shift));
  const stop = Math.abs(spotLtp - spotSl);
  const tk = x => Math.round(x * 20) / 20;
  const entry = tk(ltp);
  const maxSl = Math.min(0.5, Math.max(0.03, (Number(process.env.OPTION_MAX_SL_PCT) || 10) / 100)), minSl = Math.min(0.06, maxSl * 0.6);
  let sl = Math.max(entry - delta * stop, entry * (1 - maxSl)); sl = tk(Math.min(sl, entry * (1 - minSl))); // never risk more than OPTION_MAX_SL_PCT (default 10%) of the premium
  const targets = [1, 2, 3].map(m => tk(entry + delta * stop * m));
  const hold = pe.hold ? pe.hold : null, limitT = hold ? nowSec + hold * 86400 : undefined;
  const label = `${fmtDate(pe.expiry)}${spec.weekly ? ' (weekly)' : ' (monthly)'}`;
  const symbol = `${u} ${row.strike_price} ${optType}`;
  const risk = (entry - sl) / entry * 100;
  return {
    id: u + '-' + ev.mode + '-' + nowSec, symbol, kind: 'option', underlying: u, dir: ev.side, side: 'BUY', optType, strike: row.strike_price, expiry: pe.expiry, expiryLabel: label, dte: pe.dte,
    expiryWhy: pe.why, weekly: !!spec.weekly, lotSize: spec.lot_size || spec.minimum_lot || null, instrumentKey: opt.instrument_key, mode: ev.mode, delta: Math.round(delta * 100) / 100,
    entry, sl, targets, riskLabel: risk < 8 ? 'MEDIUM' : 'HIGH', riskPct: Math.round(risk * 10) / 10, score: ev.score, setup: ev.setup, engine: ev.engine, rs: null,
    costPct: COST_OPTION, checks: ev.checks, analysis: ev.analysis, limitT, holdDays: hold,
    spot: { entry: spotLtp, sl: spotSl, targets: spotT }, spotSl, t: nowSec,
  };
}
const tickN = x => Math.round(x * 20) / 20;
// ---- WATCH-ONLY index signals: a signal held back because its kind is not proven yet is still written up (strike,
// premium, stop, targets) and followed to its result, but kept apart from the calls: never in P&L, summaries or alerts.
let shadowDb = null;
async function loadShadow() { if (!shadowDb) { const v = await storeGetStrict('store:calls-shadow').catch(() => undefined); if (v === undefined) return []; shadowDb = Array.isArray(v) ? v : []; } return shadowDb; }
async function saveShadow() { if (!shadowDb) return; if (shadowDb.length > 200) shadowDb.splice(0, shadowDb.length - 200); try { await storeSet('store:calls-shadow', shadowDb); } catch (e) {} }
async function addShadow(f, gk, reason, nowSec, st) {
  const L = await loadShadow(); if (!shadowDb) return;
  const dayNo = t => Math.floor((t + 19800) / 86400), today = dayNo(nowSec);
  if (L.some(c => c.underlying === f.u && c.mode === f.mode && (!c.closed || nowSec - (c.closedAt || c.t) < 3600))) return; // one at a time per index and mode
  if (L.some(c => c.underlying === f.u && c.dir === f.side && c.mode === f.mode && c.status === 'SL_HIT' && dayNo(c.closedAt || c.t) === today)) return;
  try {
    const q = await getUpstoxLTPC(await dataKeyFor(f.u)); const ltp = q.price;
    if (ltp == null || Math.abs(ltp - f.entry) > 0.5 * f.atr) return;
    const call = await buildOptionCall(f.u, f, ltp, nowSec);
    Object.assign(call, { id: 'watch-' + call.id, watchOnly: true, status: 'ACTIVE', targetsHit: 0, activeSl: call.sl, ltp: call.entry, exit: null, pnlPct: 0, closed: false, gateKey: gk, gateLabel: gateLabel(gk), heldBack: reason, score: f.score });
    L.push(call); await saveShadow();
    st.skipped.push(f.u + ' ' + f.mode + ' ' + f.side + ' ' + f.setup + ': written up as watch-only');
  } catch (e) {}
}
async function trackShadows() {
  const L = await loadShadow(); if (!shadowDb) return;
  const now = Math.floor(Date.now() / 1000), { mins } = istParts(); let ch = false;
  for (const c of L.filter(x => !x.closed)) {
    try {
      await trackCall(c); ch = true;
      if (c.closed && !c.closedAt) c.closedAt = c.exitT || now;
      if (!c.closed && c.mode === 'intraday' && (istDateKey(c.t) !== istDateKey(now) || mins >= INTRADAY_EXIT_MIN)) { // same time exit as real calls
        const q = await getUpstoxLTPC(c.instrumentKey); if (!(q.price > 0)) continue;
        const gross = (q.price - c.entry) / c.entry * 100, cost = c.costPct != null ? c.costPct : 0;
        Object.assign(c, { status: 'EXPIRED', closed: true, exit: Math.round(q.price * 100) / 100, ltp: Math.round(q.price * 100) / 100, exitT: now, closedAt: now, grossPct: Math.round(gross * 100) / 100, pnlPct: Math.round((gross - cost) * 100) / 100 });
      }
    } catch (e) {}
  }
  if (ch) await saveShadow();
}
async function runIndexScan(db, notes) {
  if (process.env.CALLS_INDEX === 'off') return;
  const { dow, mins } = istParts(); const open = dow >= 1 && dow <= 5 && mins >= 555 && mins <= 930;
  const nowSec = Math.floor(Date.now() / 1000), dayNo = t => Math.floor((t + 19800) / 86400), today = dayNo(nowSec);
  const st = callsState.index = { at: nowSec, open, found: [], skipped: [], err: null };
  if (!open) return;
  const optCalls = db.filter(c => c.kind === 'option');
  const found = [];
  for (const u of INDEX_UNDERLYINGS) {
    try {
      let daily = toBars(await getUpstoxCandles(u, '1D'));
      if (mins < 915) daily = daily.slice(0, -1); // today's still-forming daily bar
      const dailyBias = Calls.marketBias(daily.slice(-150));
      const sideSetup = key => { const p = keyParts(key); return { side: p.side, setups: [p.setup] }; };
      // today's market type for this index: its own move so far (intraday), its daily trend (multi-day)
      let dtI = null; try { const q = await getUpstoxLTPC(await dataKeyFor(u)); if (q.price > 0 && q.prevClose > 0) dtI = Calls.dtOf((q.price / q.prevClose - 1) * 100); } catch (e) {}
      const dtS = Calls.biasDt(dailyBias);
      if (mins >= 570 && mins <= 925) {
        const D = daily.slice(-400), P = Calls.prep(D);
        for (const k of liveKinds('index_swing', ['idx|swing|BUY|pullback', 'idx|swing|BUY|breakout', 'idx|swing|SELL|pullback', 'idx|swing|SELL|breakout'], dtS)) {
          const ev = Calls.evalIndexAt(P, D.length - 1, 'swing', { bias: dailyBias, ...k.params, ...sideSetup(k.key) });
          if (ev && regimeLive(ev.side, k.params.regime)) found.push({ u, gateKey: k.key, ...ev });
        }
      }
      if (mins >= 560 && mins <= 845 && process.env.CALLS_INTRADAY !== 'off') { // EMA 20/50 crossover (5- and 15-minute)
        const xk = liveKinds('index_cross', ['idx|intraday|BUY|x5', 'idx|intraday|SELL|x5', 'idx|intraday|BUY|x15', 'idx|intraday|SELL|x15'], dtI), Xs = {};
        for (const k of xk) {
          const { side, setup } = keyParts(k.key), tf = setup === 'x5' ? '5m' : '15m', step = tf === '5m' ? 300 : 900;
          if (!Xs[tf]) { const D = await getCrossData(u, tf, false); let b = D.bars; if (b.length && b[b.length - 1].t + step > nowSec) b = b.slice(0, -1); Xs[tf] = Calls.prepCross(b, D.vols, tf); }
          const X = Xs[tf], n = X.bars.length - 1; if (n < 60) continue;
          for (const j of [n, n - 1]) { // the scan runs every few minutes: also look at the candle before the latest
            const ev = Calls.evalCross(X, j, { ...k.params, side, setup });
            if (ev && dayNo(ev.barTime) === today && nowSec - (ev.barTime + step) <= 2 * step) { found.push({ u, gateKey: k.key, ...ev }); break; }
          }
        }
      }
      if (mins >= 570 && mins <= 810 && process.env.CALLS_INTRADAY !== 'off') {
        let rows = toBars(await getUpstoxCandles(u, '15m'));
        if (rows.length && rows[rows.length - 1].t + 900 > nowSec) rows = rows.slice(0, -1);
        rows = rows.slice(-400); const P = Calls.prep(rows), n = rows.length - 1;
        const barMin = n >= 0 ? Math.floor(((rows[n].t + 19800) % 86400) / 60) : 0;
        for (const k of liveKinds('index_intraday', ['idx|intraday|BUY|orb', 'idx|intraday|BUY|pullback', 'idx|intraday|BUY|pdhl', 'idx|intraday|BUY|trendday', 'idx|intraday|SELL|orb', 'idx|intraday|SELL|pullback', 'idx|intraday|SELL|pdhl', 'idx|intraday|SELL|trendday'], dtI)) {
          if (barMin > (k.params.endMin || 795)) continue;
          const ev = Calls.evalIndexAt(P, n, 'intraday', { bias: dailyBias, ...k.params, ...sideSetup(k.key) });
          if (ev && dayNo(ev.barTime) === today && regimeLive(ev.side, k.params.regime)) found.push({ u, gateKey: k.key, ...ev });
        }
      }
    } catch (e) { st.skipped.push(u + ': ' + e.message); }
  }
  st.found = found.map(f => `${f.u} ${f.mode} ${f.side} ${f.setup} ${f.score}/6`);
  found.sort((a, b) => b.score - a.score);
  const made = { intraday: 0, swing: 0 };
  const DAY_CAP = { intraday: 3, swing: 2 };
  found.sort((a, b) => (gateCheck(b.gateKey || '').proven ? 1 : 0) - (gateCheck(a.gateKey || '').proven ? 1 : 0)); // proven signals first
  if (dailyStopped(db)) { if (found.length) st.skipped.push('daily loss stop reached: no new calls today'); found.length = 0; }
  for (const f of found) {
    if (CAPS_ON && made[f.mode] >= 1) continue; // one new call per mode per scan
    const gk = f.gateKey || `idx|${f.mode}|${f.side}|${f.setup}`, g = gateCheck(gk);
    if (!g.ok) { gateBlocked(`${f.u} ${f.mode} ${f.side} ${f.setup}`, gk, g.reason); st.skipped.push(f.u + ' ' + f.mode + ': paused by backtest gate'); continue; }
    if (!g.proven && INDEX_GATE !== 'paper') { gateBlocked(`${f.u} ${f.mode} ${f.side} ${f.setup}`, gk, 'index options: proven kinds only (' + g.reason + ')'); st.skipped.push(f.u + ' ' + f.mode + ' ' + f.side + ' ' + f.setup + ': not proven (index options are proven-only)'); await addShadow(f, gk, g.reason, nowSec, st); continue; }
    // proven and unproven calls never block each other: the limits below only look at calls of the same status
    const same = c => !!c.unproven === !g.proven, peers = optCalls.filter(same), openOpt = peers.filter(c => !c.closed);
    if (openOpt.some(c => c.underlying === f.u && (c.mode === f.mode || c.dir !== f.side))) continue; // one open call per index per mode, never both directions on one index
    if (CAPS_ON && openOpt.filter(c => c.dir === f.side).length >= 2) continue; // indices move together: no more than 2 on the same side
    if (CAPS_ON && peers.filter(c => c.mode === f.mode && dayNo(c.t) === today).length >= DAY_CAP[f.mode]) continue;
    if (peers.some(c => c.underlying === f.u && c.closed && nowSec - (c.closedAt || c.t) < (f.mode === 'intraday' ? 3600 : 2 * 86400))) continue;
    // no second try in the same direction on an index after a stop today (the idea already failed)
    if (optCalls.some(c => c.underlying === f.u && c.dir === f.side && c.mode === f.mode && c.closed && c.status === 'SL_HIT' && dayNo(c.closedAt || c.t) === today)) { st.skipped.push(f.u + ' ' + f.mode + ' ' + f.side + ': already stopped out in this direction today'); continue; }
    try {
      const q = await getUpstoxLTPC(await dataKeyFor(f.u)); const ltp = q.price;
      if (ltp == null || Math.abs(ltp - f.entry) > 0.5 * f.atr) { st.skipped.push(f.u + ': price already ran away from the signal'); continue; }
      if (f.mode === 'swing' && ((f.side === 'SELL' && ltp > f.entry + 0.15 * f.atr) || (f.side === 'BUY' && ltp < f.entry - 0.15 * f.atr))) { st.skipped.push(f.u + ': moving against the idea today'); continue; }
      let wall = null; try { wall = oiWallFor(await getOiSnapshot(f.u), f.side); } catch (e) {}
      if (wall && wall.against && process.env.OI_WALL === 'block') { gateBlocked(`${f.u} ${f.mode} ${f.side} oi`, gk, `open-interest wall at ${wall.strike} (${wall.distPct}% away, ${wall.ratio}x typical OI)`); continue; }
      const call = await buildOptionCall(f.u, f, ltp, nowSec); if (wall) call.oiWall = wall;
      Object.assign(call, { provenOn: keyParts(gk).dt || null, status: 'ACTIVE', targetsHit: 0, activeSl: call.sl, ltp: call.entry, exit: null, pnlPct: 0, closed: false, gateKey: gk, unproven: !g.proven, gateReason: g.proven ? null : g.reason, params: (gate.kinds[gk] || {}).paramsText || null });
      sizeCall(call); db.push(call); optCalls.push(call); made[f.mode]++;
      await emitEvent({ id: call.id + ':NEW', callId: call.id, symbol: call.symbol, side: call.side, mode: call.mode, kind: 'NEW', level: 'info', t: nowSec, price: call.entry, pnlPct: null, text: `🆕 BUY ${call.symbol} (${call.mode}) premium ₹${call.entry}, expiry ${call.expiryLabel}` }, false);
      notes.push(`${call.unproven ? '🧪 <b>UNPROVEN (paper)</b> ' : ''}🆕 BUY <b>${call.symbol}</b> (${call.mode === 'swing' ? 'multi-day' : 'intraday'}) expiry ${call.expiryLabel}\nPremium ₹${call.entry}${call.lots ? ' · ' + call.lots + ' lot' + (call.lots > 1 ? 's' : '') + ' (₹' + call.riskRs.toLocaleString('en-IN') + ' at risk' + (call.overRisk ? ', above your limit' : '') + ')' : ''}, SL ₹${call.sl}, T1 ₹${call.targets[0]}, T2 ₹${call.targets[1]}, T3 ₹${call.targets[2]}. Exit if ${f.u} ${f.side === 'BUY' ? 'closes below' : 'closes above'} ${call.spotSl}${call.holdDays ? ', or in ' + call.holdDays + ' days' : ', and by 15:15'}.`);
    } catch (e) { st.skipped.push(f.u + ' ' + f.mode + ': ' + e.message); }
  }
}
async function runCallsCycle(force) {
  if (callsState.running) return;
  if (!force && Date.now() - callsState.lastScan < SCAN_EVERY) return;
  if (!upstoxTokens().length) { callsState.lastErr = 'Upstox not configured'; return; }
  callsState.running = true; callsState.lastScan = Date.now();
  try {
    const db = await loadCalls();
    const notes = [];
    // 1) update outcomes of active calls
    for (const c of db.filter(x => !x.closed)) await applyTrack(c);
    try { await trackShadows(); } catch (e) {}
    // 2) look for new setups
    const { dow, mins } = istParts(); const open = dow >= 1 && dow <= 5 && mins >= 555 && mins <= 930;
    const universe = FNO_FALLBACK;
    if (open) { try { await checkWatches(); } catch (e) {} }
    maybeBuildGate();
    const ictx = await getIndexContext(); callsState.market = ictx; const dtI_ = liveDt(ictx.todayPct); callsState.dayType = dtI_;
    try { await runIndexScan(db, notes); } catch (e) { callsState.index = { ...(callsState.index || {}), err: e.message }; }
    // swing: block trades against the index's daily trend, and against a >0.5% move today
    const swingBias = ictx.todayPct != null && ictx.todayPct > 0.5 ? 'BULL' : ictx.todayPct != null && ictx.todayPct < -0.5 ? 'BEAR' : ictx.dailyBias;
    const found = []; callsState.scanned = 0; let i = 0; const breadth = { n: 0, above50: 0, stUp: 0 };
    const nowSec = Math.floor(Date.now() / 1000);
    async function worker() {
      while (i < universe.length) {
        const sym = universe[i++];
        try {
          // swing: daily bars (drop today's still-forming bar until 15:15)
          let bars = await getHistUpstox(sym, 300);
          if (open && mins < 915) bars = bars.slice(0, -1);
          const rg = Calls.regime(bars); if (rg) { breadth.n++; if (rg.above50) breadth.above50++; if (rg.stUp) breadth.stUp++; }
          // swing entries only 9:30–15:25 IST on trading days (never in the first 15 minutes, never after the close on a stale price)
          const swingWindow = open && mins >= 570 && mins <= 925;
          if (swingWindow) {
            const P = Calls.prep(bars), n = bars.length - 1, got = {};
            for (const k of liveKinds('stock_swing', ['stk|swing|BUY|trend', 'stk|swing|BUY|bounce', 'stk|swing|BUY|squeeze'], Calls.biasDt(ictx.dailyBias))) {
              const { side, setup } = keyParts(k.key);
              const ev = Calls.evalAt(P, n, 'swing', { bias: swingBias, idxBars: ictx.idxBars, ...k.params, side, setup: setup === 'bounce' ? 'trend' : setup });
              if (ev && (ev.setup || 'trend') === setup && regimeLive(side, k.params.regime) && (!got[side] || ev.score > got[side].score)) got[side] = { symbol: sym, gateKey: k.key, ...ev };
            }
            Object.values(got).forEach(x => found.push(x));
          }
          // intraday: 15m completed bars, new entries only 9:30–14:00 IST (off if CALLS_INTRADAY=off)
          if (open && mins >= 570 && mins <= 840 && process.env.CALLS_INTRADAY !== 'off') {
            let rows = toBars(await getUpstoxCandles(sym, '15m'));
            if (rows.length && rows[rows.length - 1].t + 900 > nowSec) rows = rows.slice(0, -1);
            // volume of the day-so-far is compared per bar, so require the same-day bar
            rows = rows.slice(-400); const P = Calls.prep(rows), n = rows.length - 1;
            for (const k of liveKinds('stock_intraday', ['stk|intraday|BUY|trend', 'stk|intraday|SELL|trend', 'stk|intraday|BUY|orbvwap', 'stk|intraday|SELL|orbvwap', 'stk|intraday|BUY|pdhl', 'stk|intraday|SELL|pdhl', 'stk|intraday|BUY|vwap', 'stk|intraday|SELL|vwap'], dtI_)) {
              const { side, setup = 'trend' } = keyParts(k.key);
              const agree = k.params.agree || (k.params.idxAgree ? 'index' : 'none'), sm = agree === 'sector' || k.params.regime === 'b50s' ? await getSectorMove(sectorOf(sym)) : null;
              const id = Calls.evalAt(P, n, 'intraday', { bias: ictx.intradayBias, idxTodayPct: ictx.todayPct, ...k.params, side, setup });
              if (id && (id.setup || 'trend') === setup && istDayEnd0(id.barTime) === istDayEnd0(nowSec) && regimeLive(side, k.params.regime, sm) && Calls.agreeOk(side, agree, ictx.todayPct, sm ? sm.pct : null)) { found.push({ symbol: sym, gateKey: k.key, ...id }); break; }
            }
            // ATR volatility trend (BullsAI 'Volatility Trend ATR'; TCS first in the scan order): paper calls until the lab proves it
            if (!found.some(f => f.symbol === sym && f.mode === 'intraday')) {
              for (const k of liveKinds('stock_atrsq', ['stk|intraday|BUY|atrsq', 'stk|intraday|SELL|atrsq'], dtI_)) {
                const { side } = keyParts(k.key);
                const id = Calls.evalAtrSq(P, n, { ...k.params, side });
                if (id && istDayEnd0(id.barTime) === istDayEnd0(nowSec)) { found.push({ symbol: sym, gateKey: k.key, ...id }); break; }
              }
            }
            // the same strategy on 5-minute candles, for TCS and the 30 most traded F&O stocks
            if (!found.some(f => f.symbol === sym && f.mode === 'intraday') && (sym === 'TCS' || FNO_FALLBACK.slice(0, 30).includes(sym))) {
              const k5s = liveKinds('stock_atrsq5', ['stk|intraday|BUY|atrsq5', 'stk|intraday|SELL|atrsq5'], dtI_);
              if (k5s.length) { let r5 = []; try { r5 = toBars(await getUpstoxCandles(sym, '5m')); } catch (e) {}
                if (r5.length && r5[r5.length - 1].t + 300 > nowSec) r5 = r5.slice(0, -1); r5 = r5.slice(-400);
                if (r5.length > 120) { const P5 = Calls.prep(r5), n5 = r5.length - 1;
                  for (const k of k5s) { const { side } = keyParts(k.key); const id = Calls.evalAtrSq(P5, n5, { ...k.params, side, setup: 'atrsq5' });
                    if (id && istDayEnd0(id.barTime) === istDayEnd0(nowSec)) { found.push({ symbol: sym, gateKey: k.key, ...id }); break; } } } }
            }
            // sector momentum: a stock leading a sector that is running hard today (its own lab-tested kind)
            if (!found.some(f => f.symbol === sym && f.mode === 'intraday')) {
              const sm = await getSectorMove(sectorOf(sym));
              if (sm && Math.abs(sm.pct) >= 1) for (const k of liveKinds('stock_secmom', ['stk|intraday|BUY|secmom', 'stk|intraday|SELL|secmom'], dtI_)) {
                const { side } = keyParts(k.key);
                const id = Calls.evalSecMom(P, n, { ...k.params, side, sec: sm, idxTodayPct: ictx.todayPct });
                if (id && istDayEnd0(id.barTime) === istDayEnd0(nowSec) && regimeLive(side, k.params.regime, sm)) { found.push({ symbol: sym, gateKey: k.key, ...id }); break; }
              }
            }
            // gap and go (rising / falling days) and range fade (sideways days): paper calls until the lab proves each
            if (!found.some(f => f.symbol === sym && f.mode === 'intraday')) {
              for (const k of liveKinds('stock_gapgo', ['stk|intraday|BUY|gapgo', 'stk|intraday|SELL|gapgo'], dtI_)) {
                const { side } = keyParts(k.key);
                const id = Calls.evalGapGo(P, n, { ...k.params, side, idxTodayPct: ictx.todayPct });
                if (id && istDayEnd0(id.barTime) === istDayEnd0(nowSec) && regimeLive(side, k.params.regime)) { found.push({ symbol: sym, gateKey: k.key, ...id }); break; }
              }
            }
            if (!found.some(f => f.symbol === sym && f.mode === 'intraday') && mins >= 645) { // the range needs time to form: from 10:45
              for (const k of liveKinds('stock_fade', ['stk|intraday|BUY|fade', 'stk|intraday|SELL|fade'], dtI_)) {
                const { side } = keyParts(k.key);
                const id = Calls.evalFade(P, n, { ...k.params, side, idxTodayPct: ictx.todayPct });
                if (id && istDayEnd0(id.barTime) === istDayEnd0(nowSec) && regimeLive(side, k.params.regime)) { found.push({ symbol: sym, gateKey: k.key, ...id }); break; }
              }
            }
          }
          callsState.scanned++;
        } catch (e) { /* skip symbol */ }
      }
    }
    function istDayEnd0(t) { return Math.floor((t + 19800) / 86400); }
    await Promise.all(Array.from({ length: 3 }, worker));
    callsState.found = found.length; callsState.found_buy = found.filter(f => f.side === 'BUY').length; callsState.found_sell = found.filter(f => f.side === 'SELL').length; callsState.breadth = breadth;
    if (breadth.n >= 20) callsState.breadthPct = Math.round(breadth.above50 / breadth.n * 1000) / 10; // used by the next scans' market-breadth rules
    // 3) log the best new ones (de-duplicated, capped per cycle)
    // best first: higher score, then the stronger relative-strength gap. Fewer, better calls.
    found.sort((a, b) => b.score - a.score || Math.abs(b.rs || 0) - Math.abs(a.rs || 0));
    const open_ = db.filter(c => !c.closed && c.kind !== 'option' && !c.manual); const CAP = { swing: 5, intraday: 3 }, SIDE_CAP = { swing: 3, intraday: 2 }, DAY_CAP = { swing: 3, intraday: 2 };
    const cnt = (m, side) => open_.filter(c => c.mode === m && (!side || c.side === side)).length;
    const dayNo = t => Math.floor((t + 19800) / 86400), today = dayNo(nowSec);
    const madeToday = m => db.filter(c => c.kind !== 'option' && !c.manual && c.mode === m && dayNo(c.t) === today).length;
    // one new call per mode per scan (no clusters), within open / per-side / per-day caps
    const quota = { swing: Math.min(1, CAP.swing - cnt('swing'), DAY_CAP.swing - madeToday('swing')), intraday: Math.min(1, CAP.intraday - cnt('intraday'), DAY_CAP.intraday - madeToday('intraday')) };
    const stopToday = dailyStopped(db); if (stopToday) callsState.dailyStop = { at: Date.now() };
    for (const f of (stopToday ? [] : found)) {
      if (CAPS_ON && (quota[f.mode] <= 0 || cnt(f.mode, f.side) >= SIDE_CAP[f.mode])) continue;
      const gk = f.gateKey || `stk|${f.mode}|${f.side}|${f.setup || 'trend'}`, g = gateCheck(gk);
      if (!g.ok) { gateBlocked(`${f.symbol} ${f.mode} ${f.side}`, gk, g.reason); continue; }
      if (f.mode === 'intraday' && ((gate.kinds || {})[gk] || {}).params?.safety) { // safety block, only where the lab chose it: no sell while the sector index is up 0.7%+ above its open (mirror for buys)
        const ix = sectorOf(f.symbol), sm = await getSectorMove(ix);
        if (sm && !Calls.safetyOk(f.side, sm.pct, sm.aboveOpen)) { gateBlocked(`${f.symbol} ${f.mode} ${f.side}`, gk, `safety: ${SECTOR_LABEL[ix] || ix} is ${sm.pct > 0 ? 'up' : 'down'} ${Math.abs(sm.pct).toFixed(2)}% and ${sm.pct > 0 ? 'above' : 'below'} its open, no ${f.side === 'SELL' ? 'sell' : 'buy'} against it`); continue; }
      }
      // unproven (paper) intraday calls: none on below-normal volume, and at most UNPROVEN_SIDE_MAX open on one side at a time
      // (19 same-side shorts on 19 Oct were really one bet on Nifty); proven kinds are not limited here
      if (!g.proven && f.mode === 'intraday') {
        if (f.checks && f.checks.vol === false) { gateBlocked(`${f.symbol} ${f.mode} ${f.side} low volume`, gk, 'unproven call on below-normal volume: skipped'); continue; }
        if (open_.filter(c => c.mode === 'intraday' && c.unproven && c.side === f.side).length >= UNPROVEN_SIDE_MAX) { gateBlocked(`unproven ${f.side} cap`, gk, `already ${UNPROVEN_SIDE_MAX} open unproven intraday ${f.side === 'BUY' ? 'buys' : 'sells'}: no more until one closes`); continue; }
      }
      // never two open calls on one stock (blocks opposite-direction conflicts and doubling up); cool-off after a close
      if (db.some(c => !c.manual && c.symbol === f.symbol && (!c.closed || nowSec - (c.closedAt || c.t) < (f.mode === 'intraday' ? 86400 : 5 * 86400)))) continue;
      let ltp = null; try { const q = await getUpstoxLTPC(await dataKeyFor(f.symbol)); ltp = q.price; } catch (e) { continue; }
      if (ltp == null || Math.abs(ltp - f.entry) > 0.5 * f.atr) continue; // stale: price has already run away
      // swing signals come from yesterday's close; skip when today's price is already moving against the idea
      if (f.mode === 'swing' && f.setup !== 'bounce' && ((f.side === 'SELL' && ltp > f.entry + 0.15 * f.atr) || (f.side === 'BUY' && ltp < f.entry - 0.15 * f.atr))) continue;
      const d = ltp - f.entry; const rb = x => Math.round((x + d) * 20) / 20;
      const call = { id: f.symbol + '-' + f.mode + '-' + nowSec, symbol: f.symbol, side: f.side, mode: f.mode, entry: rb(f.entry), sl: rb(f.sl), targets: f.targets.map(rb), trailAtr: f.trailAtr || undefined, riskLabel: f.riskLabel, riskPct: f.riskPct, score: f.score, setup: f.setup || 'trend', engine: f.engine || 'v3', rs: f.rs == null ? null : f.rs, costPct: Calls.costPct(f.mode), checks: f.checks, analysis: f.analysis, t: nowSec, gateKey: gk, unproven: !g.proven, gateReason: g.proven ? null : g.reason, params: (gate.kinds[gk] || {}).paramsText || null };
      Object.assign(call, { status: 'ACTIVE', targetsHit: 0, activeSl: call.sl, ltp: ltp, exit: null, pnlPct: 0, closed: false, provenOn: keyParts(gk).dt || null });
      sizeCall(call); db.push(call); open_.push(call); quota[f.mode]--;
      await emitEvent({ id: call.id + ':NEW', callId: call.id, symbol: call.symbol, side: call.side, mode: call.mode, kind: 'NEW', level: 'info', t: nowSec, price: call.entry, pnlPct: null, text: `🆕 ${call.side} ${call.symbol} (${call.mode}) entry ₹${call.entry}` }, false);
      notes.push(`${call.unproven ? '🧪 UNPROVEN (paper) ' : ''}🆕 ${call.side} ${call.symbol} (${call.mode}) entry ₹${call.entry}${call.qty ? ' · qty ' + call.qty + ' (₹' + call.riskRs.toLocaleString('en-IN') + ' at risk)' : ''}, SL ₹${call.sl}, T1 ₹${call.targets[0]}, T2 ₹${call.targets[1]}, T3 ₹${call.targets[2]}`);
    }
    if (db.length > CALLS_MAX) db.splice(0, db.length - CALLS_MAX);
    await saveCalls();
    callsState.lastErr = null;
    if (notes.length) { try { await sendTelegram('<b>Trade Calls</b>\n' + notes.join('\n') + '\n<i>Rule-based screen, not advice.</i>'); } catch (e) {} }
  } catch (e) { callsState.lastErr = e.message; }
  finally { callsState.running = false; }
}

// ============================================================
// GLOBAL MARKETS (for the second ticker bar). Yahoo carries the big overseas
// indices; GIFT Nifty is read from NSE's own site (needs a session cookie) and
// shown as unavailable if that fails — never as a made-up number.
// ============================================================
const GLOBAL_DEFS = [
  { key: 'GIFTNIFTY', name: 'GIFT NIFTY', mc: 'in;gsx' },
  { key: 'DOW', name: 'DOW JONES', y: '^DJI', mc: 'INDU:FUT' },
  { key: 'SPX', name: 'S&P 500', y: '^GSPC', mc: 'SPX:IND' },
  { key: 'NASDAQ', name: 'NASDAQ', y: '^IXIC', mc: 'CCMP:IND' },
  { key: 'NIKKEI', name: 'NIKKEI 225', y: '^N225', mc: 'JP;N225' },
  { key: 'HSI', name: 'HANG SENG', y: '^HSI', mc: 'cn;hsi' },
];
let nseCookie = { v: '', t: 0 };
async function getGiftNifty() {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  if (!nseCookie.v || Date.now() - nseCookie.t > 10 * 60000) {
    const r = await fetch('https://www.nseindia.com/', { headers: { 'User-Agent': ua, 'Accept': 'text/html' }, signal: AbortSignal.timeout(8000) });
    const sc = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
    nseCookie = { v: sc, t: Date.now() };
  }
  const r = await fetch('https://www.nseindia.com/api/NextApi/apiClient?functionName=getGiftNifty', { headers: { 'User-Agent': ua, 'Accept': 'application/json', 'Referer': 'https://www.nseindia.com/', 'Cookie': nseCookie.v }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('NSE HTTP ' + r.status);
  const j = await r.json();
  // be tolerant about field names: find the first numeric last-price and percent-change anywhere in the payload
  const flat = {}; (function walk(o, p) { if (o && typeof o === 'object') Object.keys(o).forEach(k => walk(o[k], k)); else flat[p] = o; })(j, '');
  const pick = (...names) => { for (const k of Object.keys(flat)) if (names.includes(k.toLowerCase())) { const n = Number(String(flat[k]).replace(/,/g, '')); if (isFinite(n)) return n; } return null; };
  const price = pick('lastprice', 'last_price', 'last', 'ltp', 'close');
  const chg = pick('perchange', 'pchange', 'percentchange', 'changepct', 'change_percent');
  if (price == null) throw new Error('GIFT Nifty price not found in NSE response');
  return { price, changePct: chg == null ? 0 : chg, source: 'nse' };
}
// Moneycontrol's public global-indices listing (the feed their own page uses). One call returns all rows.
let mcCache = { t: 0, rows: null };
async function getMcGlobal() {
  if (mcCache.rows && Date.now() - mcCache.t < 15000) return mcCache.rows;
  const r = await fetch('https://priceapi.moneycontrol.com/technicalCompanyData/globalMarket/getGlobalIndicesListingData?view=overview&deviceType=W', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept': 'application/json', 'Referer': 'https://www.moneycontrol.com/', 'Origin': 'https://www.moneycontrol.com' },
    signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('Moneycontrol HTTP ' + r.status);
  const j = await r.json();
  const idx = {}; (j.header || []).forEach((h, i) => idx[h.name] = i);
  const rows = {};
  (j.dataList || []).forEach(g => (g.data || []).forEach(a => {
    const price = Number(String(a[idx.price]).replace(/,/g, '')), pc = Number(String(a[idx.percent_change]).replace(/,/g, ''));
    if (isFinite(price) && price > 0) rows[a[idx.symbol]] = { price, changePct: isFinite(pc) ? pc : 0, marketState: a[idx.state], source: 'moneycontrol' };
  }));
  mcCache = { t: Date.now(), rows };
  return rows;
}
let globalCache = { t: 0, data: null };
app.get('/api/global-quotes', async (req, res) => {
  if (globalCache.data && Date.now() - globalCache.t < 20000) return res.json(globalCache.data);
  const out = await Promise.all(GLOBAL_DEFS.map(async d => {
    try {
      const fromMc = async () => { const rows = await getMcGlobal(); const x = rows[d.mc]; if (!x) throw new Error('not in Moneycontrol feed'); return { key: d.key, name: d.name, ...x }; };
      if (!d.y) { try { return await fromMc(); } catch (e1) { try { const g = await getGiftNifty(); return { key: d.key, name: d.name, ...g }; } catch (e2) { throw new Error(e1.message + '; ' + e2.message); } } }
      try {
        const c = await getChartData(d.y, '1d', '5m');
        if (!c || c.price == null) throw new Error('no price');
        const changePct = c.prevClose ? (c.price / c.prevClose - 1) * 100 : 0;
        return { key: d.key, name: d.name, price: c.price, changePct, marketState: c.marketState, source: 'yahoo' };
      } catch (e1) { try { return await fromMc(); } catch (e2) { throw new Error(e1.message + '; ' + e2.message); } }
    } catch (e) { return { key: d.key, name: d.name, error: String(e.message || e).slice(0, 120) }; }
  }));
  globalCache = { t: Date.now(), data: { items: out } };
  res.json(globalCache.data);
});

const BUILD = '2026-10-20-r50 (lab v16: 7 months of stock history; gap and go + range fade kinds; readiness scorecard; lab keeps server awake)';
// Walk-forward backtest of the swing engine on ~1 year of daily bars for the call universe.
// Runs in the background (first run takes a minute or two); poll the same URL for the result.
const yieldLoop = () => new Promise(r => setImmediate(r));
let btJob = { state: 'idle', result: null, startedAt: 0, progress: 0, err: null };
let btUni = { t: 0, trades: null, running: false, progress: 0, err: null, loaded: 0, total: 0, exit: 'B' };
let uniBarsCache = { t: 0, bars: null, idx: null };
// History for the call universe, from Upstox only (no Yahoo fallback); symbols Upstox cannot supply are counted and skipped.
async function loadUniverseBars(onProgress) {
  if (uniBarsCache.bars && Date.now() - uniBarsCache.t < 6 * 3600000) return uniBarsCache;
  const bars = {}; const syms = FNO_FALLBACK; let i = 0, done = 0;
  async function worker() { while (i < syms.length) { const sym = syms[i++]; try { bars[sym] = await getHistUpstox(sym, 750); } catch (e) {} done++; if (onProgress) onProgress(Math.round(done / syms.length * 100)); } }
  await Promise.all(Array.from({ length: 3 }, worker));
  let idx = null; try { idx = toBars(await getUpstoxCandles('NIFTY', '1D')).slice(-800); } catch (e) {}
  const res = { t: Date.now(), bars, idx, total: syms.length };
  if (Object.keys(bars).length) uniBarsCache = res; // never cache an empty result (Upstox may just be down)
  return res;
}
const stripTrades = r => ({ all: r.all, buy: r.buy, sell: r.sell, bounce: r.bounce, open: r.open, byBias: r.byBias });
async function runBacktest() {
  btJob = { state: 'running', result: null, startedAt: Date.now(), progress: 0, err: null };
  try {
    const U = await loadUniverseBars(pr => { btJob.progress = Math.round(pr * 0.4); });
    const n = Object.keys(U.bars).length;
    if (!n) throw new Error('Upstox returned no history (is it connected?)');
    const variants = [
      ['oldRules', { engine: 'v2', legacy: true, useGate: false }],
      ['v2Rules', { engine: 'v2', idxBars: U.idx }],
      ['v3ExitA', { exit: 'A', idxBars: U.idx }],
      ['v3ExitB', { exit: 'B', idxBars: U.idx }],
      ['v3ExitC', { exit: 'C', idxBars: U.idx }],
    ];
    const result = { symbols: n, requested: U.total, bars: Math.max(...Object.values(U.bars).map(b => b.length)), indexUsed: !!U.idx, source: 'Upstox daily candles', costPct: { swing: Calls.costPct('swing'), intraday: Calls.costPct('intraday') } };
    for (let k = 0; k < variants.length; k++) {
      const r = await Calls.backtest(U.bars, variants[k][1], yieldLoop);
      result[variants[k][0]] = stripTrades(r);
      if (variants[k][0] === 'v3ExitB') btUni = { ...btUni, t: Date.now(), trades: r.trades, exit: 'B', loaded: n, total: U.total, running: false };
      btJob.progress = 40 + Math.round((k + 1) / variants.length * 60);
    }
    btJob = { state: 'done', result, startedAt: btJob.startedAt, finishedAt: Date.now(), progress: 100, err: null };
  } catch (e) { btJob = { ...btJob, state: 'error', err: e.message }; }
}
app.get('/api/calls/backtest', (req, res) => {
  if (req.query.run === '1' && btJob.state !== 'running') lowPriority.run(true, () => runBacktest());
  res.json(btJob);
});

// Per-call backtest: replay the SAME rules (same side, same setup type, same exits) on the previous data of that
// stock (and, for swing calls, of the whole universe) and report win / loss percentages. Data = Upstox candles, or
// a TradingView CSV export sent by the page (never Yahoo).
async function ensureUniverseTrades() {
  if (btUni.trades && Date.now() - btUni.t < 6 * 3600000) return;
  if (btUni.running || btJob.state === 'running') return;
  btUni.running = true; btUni.progress = 0; btUni.err = null;
  (async () => {
    try {
      const U = await loadUniverseBars(pr => { btUni.progress = Math.round(pr * 0.5); });
      if (!Object.keys(U.bars).length) throw new Error('Upstox returned no history (is it connected?)');
      const r = await Calls.backtest(U.bars, { exit: 'B', idxBars: U.idx }, yieldLoop);
      btUni = { ...btUni, t: Date.now(), trades: r.trades, loaded: Object.keys(U.bars).length, total: U.total, running: false, progress: 100 };
    } catch (e) { btUni.running = false; btUni.err = e.message; }
  })();
}

// ---- Index backtests: the SPOT signal (same engine as the option calls) replayed on real index candles from Upstox ----
// 15-minute history is fetched month by month (Upstox serves it in windows); coverage is reported honestly.
const idxHist = {};
async function getIndex15mHistory(u, maxWindows = 12, noCache) {
  const ck = u + '|' + maxWindows; const c = idxHist[ck]; if (c && Date.now() - c.t < 12 * 3600000) return c.v;
  const key = await dataKeyFor(u); let all = [];
  try { all = await fetchCandlesForKey(key, '15m'); } catch (e) { if (!all.length) throw e; }
  let pages = 1;
  for (let k = 1; k < maxWindows; k++) {
    try {
      const hist = await upstoxFetchJson(`https://api.upstox.com/v3/historical-candle/${encodeURIComponent(key)}/minutes/15/${istDate(k * 28)}/${istDate((k + 1) * 28)}`);
      const rows = parseCandles(hist && hist.candles, 'minutes'); if (!rows.length) break;
      all = all.concat(rows); pages++;
    } catch (e) { break; }
  }
  const seen = new Set(); const out = [];
  all.sort((a, b) => a.t - b.t).forEach(r => { if (!seen.has(r.t)) { seen.add(r.t); out.push(r); } });
  const v = { bars: toBars(out), windows: pages };
  if (v.bars.length > 200 && !noCache) idxHist[ck] = { t: Date.now(), v };
  return v;
}

// ---- Index futures (volume for the index crossover setups: an index itself has no volume) ----
let futKeys = { t: 0, v: null };
async function getIndexFutKeys() { // { NIFTY: [{key, expiry}], BANKNIFTY: [...], SENSEX: [...] }, nearest expiry first; only the keys are kept
  if (futKeys.v && Date.now() - futKeys.t < 12 * 3600000) return futKeys.v;
  const want = { NIFTY: 'NSE', BANKNIFTY: 'NSE', SENSEX: 'BSE' }, out = {};
  for (const ex of ['NSE', 'BSE']) {
    let list = []; try { list = await fetchRawInstrumentFile(ex); } catch (e) { continue; }
    for (const r of list) {
      if (r.instrument_type !== 'FUT' || !r.underlying_symbol || want[r.underlying_symbol] !== ex) continue;
      const exp = typeof r.expiry === 'number' ? r.expiry : Date.parse(r.expiry); if (!(exp > Date.now() - 86400000)) continue;
      (out[r.underlying_symbol] = out[r.underlying_symbol] || []).push({ key: r.instrument_key, expiry: exp });
    }
    list = null;
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.expiry - b.expiry);
  futKeys = { t: Date.now(), v: out }; return out;
}
// minute candles for any instrument key, stitched from 28-day windows going back (Upstox limit per request)
async function getMinuteHistory(key, minutes, windows) {
  let all = [];
  try { all = await fetchCandlesForKey(key, minutes === 5 ? '5m' : '15m'); } catch (e) {}
  for (let k = 1; k < windows; k++) {
    try { const hist = await upstoxFetchJson(`https://api.upstox.com/v3/historical-candle/${encodeURIComponent(key)}/minutes/${minutes}/${istDate(k * 28)}/${istDate((k + 1) * 28)}`);
      const rows = parseCandles(hist && hist.candles, 'minutes'); if (!rows.length) break; all = all.concat(rows); } catch (e) { break; }
  }
  const seen = new Set(), out = []; all.sort((a, b) => a.t - b.t).forEach(r => { if (!seen.has(r.t)) { seen.add(r.t); out.push(r); } });
  return toBars(out);
}
// spot bars + futures volume by bar time (near-month contract; next month fills days before it)
const crossCache = {};
async function getCrossData(u, tf, deep) {
  const mins = tf === '5m' ? 5 : 15, ck = u + '|' + tf + '|' + (deep ? 'd' : 'l'), c = crossCache[ck];
  if (c && Date.now() - c.t < (deep ? 12 * 3600000 : 60000)) return c.v;
  const spotKey = await dataKeyFor(u), W = deep ? (mins === 5 ? 4 : 6) : 1;
  const bars = deep ? await getMinuteHistory(spotKey, mins, W) : toBars(await getUpstoxCandles(u, tf));
  const vols = new Map(); let futNote = 'no index futures found';
  try { const fk = (await getIndexFutKeys())[u] || [];
    for (const f of fk.slice(0, 2).reverse()) { // next month first, near month overwrites: the most liquid contract wins on shared bars
      const fb = deep ? await getMinuteHistory(f.key, mins, W) : toBars(await fetchCandlesForKey(f.key, tf).catch(() => []));
      fb.forEach(b => { if (b.v > 0) vols.set(b.t, b.v); });
    }
    if (fk.length) futNote = 'volume from ' + u + ' futures';
  } catch (e) {}
  const v = { bars, vols, note: futNote }; if (bars.length > 100) crossCache[ck] = { t: Date.now(), v }; return v;
}
const idxTrades = {};
async function getIdxTrades(u, mode, supplied) {
  const ck = u + '|' + mode; const c = idxTrades[ck];
  if (!supplied && c && Date.now() - c.t < 12 * 3600000) return c.v;
  const daily = toBars(await getUpstoxCandles(u, '1D')).slice(-1300);
  let bars, windows = null, source;
  if (supplied && supplied.length >= 120) { bars = supplied; source = 'TradingView export you uploaded'; }
  else if (mode === 'intraday') { const h = await getIndex15mHistory(u); bars = h.bars; windows = h.windows; source = 'Upstox 15-minute index candles'; }
  else { bars = daily; source = 'Upstox daily index candles'; }
  if (!bars || bars.length < 120) throw new Error('Only ' + (bars ? bars.length : 0) + ' candles available for ' + u + ' (need at least 120)');
  const trades = await Calls.walkIndex(u, bars, { mode, dailyBars: daily }, yieldLoop);
  const v = { trades, bars: bars.length, from: bars[0].t, to: bars[bars.length - 1].t, windows, source };
  if (!supplied) idxTrades[ck] = { t: Date.now(), v };
  return v;
}
async function backtestIndexCall(spec, supplied) {
  const u = spec.symbol, mode = spec.mode;
  const main = await getIdxTrades(u, mode, supplied);
  const done = main.trades.filter(x => x.closed);
  const same = done.filter(x => x.side === spec.side && (!spec.setup || x.setup === spec.setup));
  const out = { kind: 'index', symbol: u, mode, side: spec.side, setup: spec.setup || null, source: main.source, candles: main.bars, days: Math.round((main.to - main.from) / 86400), from: main.from, to: main.to,
    costPct: Calls.IDX_COST, note: 'Tested on the index itself (spot). The option adds its own cost (about ' + COST_OPTION + '% round trip) and its premium moves roughly delta x spot, so treat this as the quality of the signal, not option P&L.',
    sameKind: Calls.mkAgg(same), sameSide: Calls.mkAgg(done.filter(x => x.side === spec.side)), allSignals: Calls.mkAgg(done),
    recent: same.slice(-12).reverse().map(x => ({ t: x.t, status: x.status, pnlPct: x.pnlPct, targetsHit: x.targetsHit, bias: x.bias })) };
  if (main.windows != null) out.coverage = `${main.windows} month-window(s) of 15-minute history, about ${out.days} days`;
  // all three indices together (same side and mode): a bigger sample than one index alone
  const others = INDEX_UNDERLYINGS.filter(x => x !== u), agg = [...same]; let missing = 0;
  for (const o of others) {
    const c = idxTrades[o + '|' + mode];
    if (c) agg.push(...c.v.trades.filter(x => x.closed && x.side === spec.side && (!spec.setup || x.setup === spec.setup)));
    else { missing++; lowPriority.run(true, () => getIdxTrades(o, mode).catch(() => {})); }
  }
  out.universe = missing ? { state: 'running', label: 'All indices', note: 'Loading the other two indices; open Backtest again in a minute.' } : { state: 'done', label: 'All indices', stocks: 3, ...Calls.mkAgg(agg) };
  return out;
}

// ============================================================
// BACKTEST GATE: a kind of call (index/stock, intraday/multi-day, up/down, setup) may only go live after it has
// shown an edge on real Upstox history: enough trades, a positive average after costs above a minimum, and
// profitable in both the older and the newer half of the data. Rebuilt in the background every 12 hours.
// ============================================================
const GATE_MIN = { idx_intraday: Number(process.env.GATE_IDX_INTRADAY_MIN) || 0.05, idx_swing: Number(process.env.GATE_IDX_SWING_MIN) || 0.25,
  stk_intraday: Number(process.env.GATE_STK_INTRADAY_MIN) || 0.03, stk_swing: Number(process.env.GATE_STK_SWING_MIN) || 0.10 };
const GATE_MIN_TRADES = Number(process.env.GATE_MIN_TRADES) || 30;
const CAPS_ON = process.env.CALLS_CAPS === 'on';
const UNPROVEN_SIDE_MAX = Number(process.env.UNPROVEN_SIDE_MAX) || 5;
// index option calls: 'strict' (default) = only kinds proven by the lab; 'paper' = unproven ones too (marked). Options lose
// ~25% of premium on every miss, so unproven option calls are far costlier than unproven stock calls.
const INDEX_GATE = (process.env.CALLS_INDEX_GATE || 'strict').toLowerCase(); // count limits on calls; off by default during paper testing
let gate = { t: 0, building: false, progress: '', err: null, kinds: {} };
storeGet('store:calls-gate', null).then(g => { if (g && g.kinds && g.labVersion >= 14 && !gate.t) gate = { ...g, building: false, needsRebuild: g.labVersion !== 16 }; if (gate.needsRebuild) setTimeout(() => maybeBuildGate(), 20000); }).catch(() => {}); // older (pre-lab) results are ignored, so the lab runs
const SETUP_NAME = { atrsq: 'ATR volatility trend', atrsq5: 'ATR volatility trend (5-min)', orb: 'opening-range break', pullback: 'pullback', breakout: '20-day breakout', trend: 'trend pullback', bounce: 'counter-trend bounce', orbvwap: 'opening-range break + VWAP', pdhl: 'previous-day high/low break', squeeze: 'tight-range breakout', trendday: 'trend day', vwap: 'VWAP rejection / hold', x5: '5-min EMA 20/50 crossover', x15: '15-min EMA 20/50 crossover', secmom: 'sector momentum', gapgo: 'gap and go', fade: 'range fade (sideways days)' };
const DT_LABEL = { up: 'up days', down: 'down days', flat: 'sideways days' };
function gateLabel(key) {
  const [base, dt] = String(key).split('@');
  if (dt) return gateLabel(base) + ' · on ' + (DT_LABEL[dt] || dt);
  const [grp, mode, side, setup] = base.split('|');
  if (grp === 'idx') return `Index option · ${mode === 'intraday' ? 'intraday' : 'multi-day'} · ${side === 'BUY' ? 'up (buy CE)' : 'down (buy PE)'} · ${SETUP_NAME[setup] || setup}`;
  return `Stock · ${mode === 'intraday' ? 'intraday' : 'swing'} · ${side}${setup ? ' · ' + (SETUP_NAME[setup] || setup) : ''}`;
}
// ---- STRATEGY LAB: replays every combination in Calls.LAB_GRID on real history. For each kind of call the
// combination with the best average on the OLDER half of the data is chosen; it is then judged on the full
// period and on the NEWER half it never saw. Those numbers decide LIVE (proven) vs unproven.
const GATE_MODE = (process.env.CALLS_GATE || 'paper').toLowerCase(); // paper (default): unproven kinds still issue calls, labelled; strict: only proven; off: no gate
const LAB_MIN_OLDER = 12;
const LAB_STOCK_WINDOWS = Math.max(4, Math.min(12, Number(process.env.LAB_STOCK_WINDOWS) || 8)); // 28-day windows of 15-minute stock candles: 8 = about 7 months (it was 4)
const DEF_PARAMS = { index_cross: { entry: 'cross', volK: 1.3, htf: true, minScore: 4, stopK: 1.25, exit: 'A' }, index_intraday: { veto: true, regime: 'any', minScore: 5, needHtf: false, stopK: 1, exit: 'A', endMin: 795 }, index_swing: { regime: 'any', minScore: 5, needHtf: false, stopK: 1, exit: 'A' },
  stock_swing: { regime: 'any', setup: 'trend', minScore: 5, stopK: 1, exit: process.env.CALLS_EXIT || 'B' }, stock_atrsq: { setup: 'atrsq', k: 1, quiet: 'avg', tk: 2, regime: 'any' }, stock_atrsq5: { setup: 'atrsq5', k: 1, quiet: 'avg', tk: 2, regime: 'any', barSec: 300 }, stock_secmom: { setup: 'secmom', secK: 1.5, entry: 'brk', volK: 0, stopK: 1, exitI: 'A', regime: 'any' }, stock_gapgo: { setup: 'gapgo', gapK: 0.5, entry: 'brk', volK: 0, idxAgree: false, stopK: 1, exitI: 'A', regime: 'any' }, stock_fade: { setup: 'fade', edge: 0.15, rsiHi: 65, stopK: 0.3, tgt: 'near', regime: 'any' }, stock_intraday: { safety: false, agree: 'none', regime: 'any', setup: 'trend', minScore: 5, stopK: 1, exitI: 'A' } };
const famOf = key => { const [g, m] = key.split('|'); return (g === 'idx' ? 'index_' : 'stock_') + m; };
function paramsLabel(p) {
  if (!p) return '';
  const ex = { S: '0.8/1.6/2.4R', A: '1/2/3R', B: '1.5/3/4.5R', C: '2/4/6R' }[p.exit || p.exitI] || '';
  const rg = p.regime === 'b50s' ? ' · only when market breadth agrees, unless its sector index is up (down) 1.5%+ today' : p.regime === 'b50' ? ' · only when market breadth agrees (buys ≥50% of stocks above their 50-day average, sells ≤50%)' : p.regime === 'b60' ? ' · only in a strong market (buys ≥60% above their 50-day average, sells ≤40%)' : '';
  const ia = p.idxAgree || p.agree === 'index' ? ' · only when Nifty agrees on the day (buys while it is up, sells while it is down)' : p.agree === 'sector' ? ' · only when its sector index agrees on the day (buys while it is up, sells while it is down)' : '';
  const vt = (p.veto === false ? ' · may trade against the daily trend' : '') + (p.safety ? ' · no trade against a strong sector move (0.7%+)' : '');
  if (p.setup === 'atrsq' || p.setup === 'atrsq5') return `${p.setup === 'atrsq5' ? '5-minute' : '15-minute'} candle closes ${p.k}× ATR(20) beyond the previous close${p.quiet === 'none' ? '' : p.quiet === 'p25' ? ' after ATR sat in the lowest quarter of the last 70 candles' : ' after ATR sat below its 70-candle average'} · trailing stop ${p.tk}× ATR behind the best close · square-off at day end`;
  if (p.setup === 'gapgo') return `opens ${p.gapK}%+ from yesterday's close with the gap still open and price on the right side of VWAP · ${p.entry === 'pull' ? 'entry on a pullback that holds the opening range / VWAP' : 'entry on the opening-range break'}${p.volK ? ' · volume ≥' + p.volK + '× usual' : ''}${p.idxAgree ? ' · only when Nifty is not against it' : ''} · stop ×${p.stopK} · targets ${{ S: '0.8/1.6/2.4R', A: '1/2/3R' }[p.exitI] || ''} · entries 9:45–14:00`;
  if (p.setup === 'fade') return `only on a sideways Nifty day (within ±0.4%) · the stock's day range is 0.6–3.5% and it has crossed VWAP twice or more · fade the ${Math.round(p.edge * 100)}% edge of the range with RSI ${p.rsiHi}+ (${100 - p.rsiHi}− for buys) and a rejection candle · stop just beyond the day's extreme (+${p.stopK}× ATR) · targets ${p.tgt === 'far' ? '55/80/100%' : '40/65/90%'} of the way back across the range · entries after 10:45`;
  if (p.setup === 'secmom') return `sector index ${p.secK}%+ on the day · ${p.entry === 'pull' ? 'entry on a pullback that holds the opening range / VWAP' : 'entry on the opening-range break'}${p.volK ? ' · volume ≥' + p.volK + '× usual' : ''} · stop ×${p.stopK} · targets ${{ S: '0.8/1.6/2.4R', A: '1/2/3R', B: '1.5/3/4.5R' }[p.exitI] || ''} · entries 9:45–14:00`;
  if (p.entry) return `${p.minScore}/6 checks · ${p.entry === 'retest' ? 'entry on the first pullback to the 20 EMA' : 'entry on the cross candle'}${p.volK ? ' · volume ≥' + p.volK + '× usual (required)' : ' · volume not required'}${p.htf ? ' · bigger trend must agree' : ''} · stop ×${p.stopK} · targets ${{ S: '0.8/1.6/2.4R', A: '1/2/3R', B: '1.5/3/4.5R' }[p.exit] || ''}`;
  return `${p.minScore}/6 checks${p.needHtf ? ' + bigger trend' : ''}${vt}${rg}${ia} · stop ×${p.stopK} · targets ${ex}${p.endMin ? ' · entries until ' + (p.endMin === 720 ? '12:15' : '13:30') : ''}`;
}
// Results are accumulated per (rule combination, kind of call) as running sums, so the lab's memory stays small no
// matter how many trades it replays (keeping every trade of every combination could exhaust the server's memory).
function accum(map, trades, keyFn, cutoff) {
  for (const x of trades) {
    if (!x.closed) continue;
    const k0 = keyFn(x);
    for (const k of x.dt ? [k0, k0 + '@' + x.dt] : [k0]) { // every kind is also measured per market type (up / down / sideways days)
      let a = map.get(k);
      if (!a) { a = { n: 0, sum: 0, oN: 0, oSum: 0, oSq: 0, nN: 0, nSum: 0, w: 0, l: 0, t0: x.t, t1: x.t }; map.set(k, a); }
      a.n++; a.sum += x.pnlPct; if (x.t < a.t0) a.t0 = x.t; if (x.t > a.t1) a.t1 = x.t; // the period the trades span
      if (x.t < cutoff) { a.oN++; a.oSum += x.pnlPct; a.oSq += x.pnlPct * x.pnlPct; } else { a.nN++; a.nSum += x.pnlPct; }
      if (x.status !== 'BREAKEVEN') { if (x.pnlPct > 0.05) a.w++; else if (x.pnlPct < -0.05) a.l++; }
    }
  }
}
function statsOf(a) {
  const r = x => Math.round(x * 100) / 100;
  if (!a || !a.n) return { n: 0, avg: null, older: null, newer: null, olderN: 0, newerN: 0, winRate: null, olderLcb: null };
  let lcb = null; // conservative score for choosing rules: older-half average minus one standard error, so a lucky handful of trades cannot win
  if (a.oN >= 2) { const m = a.oSum / a.oN, v = Math.max(0, (a.oSq - a.oN * m * m) / (a.oN - 1)); lcb = m - Math.sqrt(v) / Math.sqrt(a.oN); }
  return { from: a.t0, to: a.t1, n: a.n, avg: r(a.sum / a.n), older: a.oN ? r(a.oSum / a.oN) : null, newer: a.nN ? r(a.nSum / a.nN) : null, olderN: a.oN, newerN: a.nN, winRate: a.w + a.l ? Math.round(a.w / (a.w + a.l) * 100) : null, olderLcb: lcb };
}
function pickKinds(kinds, fam, combos, perCombo, cutoff) {
  const min = GATE_MIN[fam === 'index_intraday' || fam === 'index_cross' ? 'idx_intraday' : fam === 'index_swing' ? 'idx_swing' : fam === 'stock_intraday' || fam === 'stock_secmom' || fam === 'stock_atrsq' || fam === 'stock_atrsq5' || fam === 'stock_gapgo' || fam === 'stock_fade' ? 'stk_intraday' : 'stk_swing'];
  const def = DEF_PARAMS[fam], defIdx = Math.max(0, combos.findIndex(c => Object.keys(def).every(k => c[k] === def[k])));
  const keys = new Set(); perCombo.forEach(m => m.forEach((_, k) => keys.add(k)));
  for (const key of keys) {
    const cand = combos.map((cb, ci) => ({ ci, st: statsOf(perCombo[ci].get(key)) }));
    const elig = cand.filter(c => c.st.olderN >= LAB_MIN_OLDER && c.st.older != null);
    const win = elig.length ? elig.sort((a, b) => b.st.olderLcb - a.st.olderLcb || b.st.olderN - a.st.olderN)[0] : (cand[defIdx].st.n ? cand[defIdx] : cand.slice().sort((a, b) => b.st.n - a.st.n)[0]);
    const st = win.st, why = [];
    if (st.n < GATE_MIN_TRADES) why.push(`only ${st.n} past trades (need ${GATE_MIN_TRADES})`);
    if (st.avg == null || st.avg <= min) why.push(`average ${st.avg == null ? '—' : (st.avg > 0 ? '+' : '') + st.avg + '%'} is not above +${min}%`);
    if (!(st.older > 0) || !(st.newer > 0) || st.newerN < 5) why.push('not profitable in both the older and the newer half');
    const set = keyParts(key).setup, bars = fam === 'index_swing' || fam === 'stock_swing' ? 'daily candles' : set === 'x5' ? '5-minute candles' : '15-minute candles';
    kinds[key] = { label: gateLabel(key), fam, bars, params: combos[win.ci], paramsText: paramsLabel(combos[win.ci]), tested: combos.length, min, ...st,
      pass: !why.length, reason: why.length ? why.join('; ') : 'passed', current: cand[defIdx].st, cutoff };
  }
}
async function buildGate() {
  if (gate.building && Date.now() - (gate.startedAt || 0) < 150 * 60000) return; // a run stuck for 150+ minutes is abandoned (the deeper history makes a full run about an hour)
  gate.building = true; gate.err = null; gate.startedAt = Date.now(); gate.partial = {};
  const kinds = {}, G = Calls.LAB_GRID, mid = arr => arr.length ? (arr[0].t + arr[arr.length - 1].t) / 2 : 0;
  try {
    gate.progress = 'lab: loading the stock universe (for market breadth)';
    const U = await loadUniverseBars();
    const breadth = Calls.breadthSeries(U.bars); gate.breadthDays = breadth.size;
    if (callsState.breadthPct == null && breadth.size) { const last = [...breadth.entries()].sort((x, y) => y[0] - x[0])[0]; callsState.breadthPct = last[1]; }
    // ---- index option signals, on the index itself, pooled over Nifty / Bank Nifty / Sensex
    for (const mode of ['intraday', 'swing']) {
      const fam = 'index_' + mode, combos = G[fam], perCombo = combos.map(() => new Map()); let cutoff = 0;
      const keyFn = x => `idx|${mode}|${x.side}|${x.setup}`;
      for (const u of INDEX_UNDERLYINGS) {
        gate.progress = `lab: ${u} ${mode === 'intraday' ? 'intraday' : 'multi-day'}`;
        try {
          const daily = toBars(await getUpstoxCandles(u, '1D')).slice(-1300);
          const bars = mode === 'intraday' ? (await getIndex15mHistory(u)).bars : daily;
          if (!cutoff) cutoff = mid(bars);
          const P = Calls.prep(bars);
          for (let ci = 0; ci < combos.length; ci++) accum(perCombo[ci], await Calls.walkIndex(u, bars, { mode, dailyBars: daily, _P: P, breadth, ...combos[ci] }, yieldLoop), keyFn, cutoff);
        } catch (e) {}
      }
      pickKinds(kinds, fam, combos, perCombo, cutoff); gate.partial = { ...kinds };
    }
    // ---- EMA 20/50 crossover on 5- and 15-minute index bars (volume from index futures)
    { const fam = 'index_cross', combos = G[fam], perCombo = combos.map(() => new Map()); let cutoff = 0;
      for (const tf of ['5m', '15m']) {
        const setup = tf === '5m' ? 'x5' : 'x15';
        for (const u of INDEX_UNDERLYINGS) {
          gate.progress = `lab: ${u} ${tf} EMA crossover`;
          try {
            const D = await getCrossData(u, tf, true); if (D.bars.length < 300) continue;
            if (!cutoff) cutoff = mid(D.bars);
            const X = Calls.prepCross(D.bars, D.vols, tf);
            for (let ci = 0; ci < combos.length; ci++) accum(perCombo[ci], await Calls.walkCross(u, X, { ...combos[ci], setup, endMin: 840 }, yieldLoop), x => `idx|intraday|${x.side}|${x.setup}`, cutoff);
          } catch (e) {}
        }
      }
      pickKinds(kinds, fam, combos, perCombo, cutoff); gate.partial = { ...kinds };
    }
    // ---- stock swing (daily candles, ~3 years, 90 stocks)
    if (Object.keys(U.bars).length) {
      const fam = 'stock_swing', combos = G[fam], perCombo = combos.map(() => new Map()); let cutoff = 0, k = 0;
      const keyFn = x => `stk|swing|${x.side}|${x.setup || 'trend'}`;
      const defIdx = combos.findIndex(c => c.regime === 'any' && c.setup === 'trend' && c.minScore === 5 && c.stopK === 1 && c.exit === 'B'), defTrades = [];
      for (const [sym, bars] of Object.entries(U.bars)) {
        gate.progress = `lab: stocks swing ${++k}/${Object.keys(U.bars).length}`;
        if (!cutoff) cutoff = mid(bars);
        const P = Calls.prep(bars);
        for (let ci = 0; ci < combos.length; ci++) {
          const ts = await Calls.walkSwing(sym, bars, { idxBars: U.idx, _P: P, breadth, ...combos[ci] }, yieldLoop);
          accum(perCombo[ci], ts, keyFn, cutoff);
          if (ci === defIdx) ts.forEach(x => defTrades.push({ t: x.t, side: x.side, setup: x.setup, pnlPct: x.pnlPct, closed: x.closed, status: x.status }));
        }
      }
      pickKinds(kinds, fam, combos, perCombo, cutoff); gate.partial = { ...kinds };
      if (defIdx >= 0) btUni = { ...btUni, t: Date.now(), trades: defTrades, loaded: Object.keys(U.bars).length, total: U.total, running: false, progress: 100 };
    }
    // ---- stock intraday (~4 months of 15-minute candles per stock)
    if (process.env.CALLS_INTRADAY !== 'off') {
      let idx15 = null; try { idx15 = (await getIndex15mHistory('NIFTY')).bars; } catch (e) {}
      const fam = 'stock_intraday', combos = G[fam], perCombo = combos.map(() => new Map()); let cutoff = 0, k = 0;
      const smCombos = G.stock_secmom || [], smPer = smCombos.map(() => new Map());
      const ggCombos = G.stock_gapgo || [], ggPer = ggCombos.map(() => new Map()), fdCombos = G.stock_fade || [], fdPer = fdCombos.map(() => new Map());
      const atCombos = G.stock_atrsq || [], atPer = atCombos.map(() => new Map()); let focusBars = null; const FOCUS = 'TCS';
      const keyFn = x => `stk|intraday|${x.side}|${x.setup || 'trend'}`;
      const syms = FNO_FALLBACK, secBars = {};
      // the 'agree' choice is a filter on the same replay: walk each rule set once, then file its trades under every agree option
      const sig = c => JSON.stringify({ ...c, agree: undefined, safety: undefined }), variants = {};
      combos.forEach((c, ci) => { (variants[sig(c)] = variants[sig(c)] || []).push(ci); });
      for (const sym of syms) {
        gate.progress = `lab: stocks intraday ${++k}/${syms.length}`;
        try {
          const ix = sectorOf(sym);
          if (ix !== 'NIFTY' && secBars[ix] === undefined) { secBars[ix] = null; try { secBars[ix] = (await getIndex15mHistory(ix)).bars; } catch (e) {} }
          const h = await getIndex15mHistory(sym, LAB_STOCK_WINDOWS, true); if (!cutoff) cutoff = mid(h.bars);
          const P = Calls.prep(h.bars);
          for (const group of Object.values(variants)) {
            const ts = await Calls.walkIntraday(sym, h.bars, { idxBars15: idx15, secBars15: (ix !== 'NIFTY' && secBars[ix]) || idx15, _P: P, breadth, ...combos[group[0]], agree: 'none', safety: false }, yieldLoop);
            for (const ci of group) { const { agree: ag, safety: sf } = combos[ci]; accum(perCombo[ci], ag === 'none' && !sf ? ts : ts.filter(x => Calls.agreeOk(x.side, ag, x.idxPct, x.secPct) && (!sf || Calls.safetyOk(x.side, x.secPct, x.secUp))), keyFn, cutoff); }
          }
          for (let ci = 0; ci < smCombos.length; ci++) accum(smPer[ci], await Calls.walkIntraday(sym, h.bars, { idxBars15: idx15, secBars15: (ix !== 'NIFTY' && secBars[ix]) || idx15, _P: P, breadth, ...smCombos[ci] }, yieldLoop), keyFn, cutoff);
          for (let ci = 0; ci < ggCombos.length; ci++) accum(ggPer[ci], await Calls.walkIntraday(sym, h.bars, { idxBars15: idx15, secBars15: (ix !== 'NIFTY' && secBars[ix]) || idx15, _P: P, breadth, ...ggCombos[ci] }, yieldLoop), keyFn, cutoff);
          for (let ci = 0; ci < fdCombos.length; ci++) accum(fdPer[ci], await Calls.walkIntraday(sym, h.bars, { idxBars15: idx15, secBars15: (ix !== 'NIFTY' && secBars[ix]) || idx15, _P: P, breadth, ...fdCombos[ci] }, yieldLoop), keyFn, cutoff);
          for (let ci = 0; ci < atCombos.length; ci++) accum(atPer[ci], await Calls.walkIntraday(sym, h.bars, { idxBars15: idx15, secBars15: (ix !== 'NIFTY' && secBars[ix]) || idx15, _P: P, breadth, ...atCombos[ci] }, yieldLoop), keyFn, cutoff);
          if (sym === FOCUS) focusBars = h.bars;
        } catch (e) {}
      }
      pickKinds(kinds, fam, combos, perCombo, cutoff);
      if (smCombos.length) pickKinds(kinds, 'stock_secmom', smCombos, smPer, cutoff);
      if (ggCombos.length) pickKinds(kinds, 'stock_gapgo', ggCombos, ggPer, cutoff);
      if (fdCombos.length) pickKinds(kinds, 'stock_fade', fdCombos, fdPer, cutoff);
      if (atCombos.length) {
        pickKinds(kinds, 'stock_atrsq', atCombos, atPer, cutoff);
        // TCS first: the strategy was published for TCS, so its own record with the chosen rules is kept beside the all-stocks one
        if (focusBars) for (const [key, v] of Object.entries(kinds)) { if (v.fam !== 'stock_atrsq' || key.includes('@')) continue;
          try { const m = new Map(); accum(m, await Calls.walkIntraday(FOCUS, focusBars, { idxBars15: idx15, secBars15: idx15, breadth, ...v.params }, yieldLoop), keyFn, cutoff); v.focus = { sym: FOCUS, ...statsOf(m.get(key)) }; } catch (e) {} }
      }
      gate.partial = { ...kinds };
      // ATR volatility trend on 5-minute candles: TCS + the 30 most traded F&O stocks (5-minute history is heavier to load)
      const a5 = G.stock_atrsq5 || [];
      if (a5.length) { const per5 = a5.map(() => new Map()), syms5 = [...new Set(['TCS', ...FNO_FALLBACK.slice(0, 30)])]; let cut5 = 0, k5 = 0, tcs5 = null;
        for (const sym of syms5) { gate.progress = `lab: ATR 5-minute ${++k5}/${syms5.length}`;
          try { const bars = await getMinuteHistory(await dataKeyFor(sym), 5, 4); if (bars.length < 600) continue; if (!cut5) cut5 = mid(bars); if (sym === 'TCS') tcs5 = bars;
            const P5 = Calls.prep(bars);
            for (let ci = 0; ci < a5.length; ci++) accum(per5[ci], await Calls.walkIntraday(sym, bars, { idxBars15: idx15, secBars15: idx15, _P: P5, breadth, ...a5[ci] }, yieldLoop), keyFn, cut5);
          } catch (e) {} }
        pickKinds(kinds, 'stock_atrsq5', a5, per5, cut5);
        if (tcs5) for (const [key, v] of Object.entries(kinds)) { if (v.fam !== 'stock_atrsq5' || key.includes('@')) continue;
          try { const m = new Map(); accum(m, await Calls.walkIntraday('TCS', tcs5, { idxBars15: idx15, secBars15: idx15, breadth, ...v.params }, yieldLoop), keyFn, cut5); v.focus = { sym: 'TCS', ...statsOf(m.get(key)) }; } catch (e) {} }
        gate.partial = { ...kinds }; }
    }
    if (!Object.keys(kinds).length) throw new Error('no history could be loaded from Upstox');
    gate = { t: Date.now(), labVersion: 16, building: false, progress: '', err: null, kinds, minTrades: GATE_MIN_TRADES, min: GATE_MIN, tookMin: Math.round((Date.now() - gate.startedAt) / 60000) };
    try { await storeSet('store:calls-gate', gate); } catch (e) {}
  } catch (e) { gate.err = e.message; }
  finally { gate.building = false; gate.progress = ''; }
}
function maybeBuildGate() {
  if (GATE_MODE === 'off' || gate.building || !upstoxTokens().length) return;
  if (gate.t && !gate.needsRebuild && Date.now() - gate.t < 12 * 3600000) return;   // results of an older lab version are used until the new lab finishes
  if (gate.lastTry && Date.now() - gate.lastTry < 20 * 60000) return; // after a failure, retry every 20 minutes
  gate.lastTry = Date.now();
  lowPriority.run(true, () => buildGate().catch(() => {}));
}
// Auto-pause: a kind with 100+ past trades whose average AND newer (unseen) half are both below zero issues no calls,
// not even paper ones. It is re-tested at every lab rebuild and comes back by itself if the numbers recover.
const RETIRE_MIN_TRADES = Number(process.env.GATE_RETIRE_MIN_TRADES) || 100;
const isRetired = k => !!(k && !k.pass && k.n >= RETIRE_MIN_TRADES && k.avg != null && k.avg < 0 && k.newer != null && k.newer < 0);
const retireReason = k => `paused: losing over ${k.n} past trades (avg ${k.avg}%, newer half ${k.newer}%); re-tested every 12 hours`;
// { ok: issue the call, proven: passed the lab, reason }
function gateCheck(key) {
  if (GATE_MODE === 'off') return { ok: true, proven: true };
  const k = gate.t && gate.kinds[key];
  if (isRetired(k)) return { ok: false, proven: false, retired: true, reason: retireReason(k) };
  const reason = !gate.t ? (gate.building ? 'strategy lab still running' : 'strategy lab not run yet') : !k ? 'no past trades of this kind' : k.reason;
  const proven = !!(k && k.pass);
  return { ok: proven || GATE_MODE !== 'strict', proven, reason: proven ? 'passed' : reason };
}
// parameter sets to evaluate live for one family: one per kind found by the lab, else the current defaults
// dt = today's market type ('up' / 'down' / 'flat'): a kind proven only on that type of day is added (proven ones first)
// A kind that loses on today's market type (up / down / sideways days) issues no calls today, even when it is proven overall:
// at least DAY_MIN_TRADES past trades on that type of day, average below zero and the newer half below zero too.
const DAY_MIN_TRADES = Number(process.env.GATE_DAY_MIN_TRADES) || 15;
const DT_WORD = { up: 'up days', down: 'down days', flat: 'sideways days' };
// today's market type with a 0.05% buffer: it changes only when Nifty is clearly past the line (stops calls switching on and off
// while Nifty hovers at -0.40% / +0.40%)
const DT_BUF = 0.05; let dtLive = null;
function liveDt(pct) {
  if (pct == null) return null; const L = 0.4, day = Math.floor((Date.now() / 1000 + 19800) / 86400);
  if (!dtLive || dtLive.day !== day) dtLive = { day, dt: Calls.dtOf(pct) };
  const cur = dtLive.dt;
  let nx = cur;
  if (cur === 'down') { if (pct > -L + DT_BUF) nx = pct >= L + DT_BUF ? 'up' : 'flat'; }
  else if (cur === 'up') { if (pct < L - DT_BUF) nx = pct <= -L - DT_BUF ? 'down' : 'flat'; }
  else { if (pct <= -L - DT_BUF) nx = 'down'; else if (pct >= L + DT_BUF) nx = 'up'; }
  dtLive.dt = nx; return nx;
}
function dayLosing(key, dt) { if (!dt) return null; const d = gate.kinds && gate.kinds[key + '@' + dt]; if (!d || d.n < DAY_MIN_TRADES || d.avg == null || d.avg >= 0 || (d.newer != null && d.newer >= 0)) return null; return d; }
function liveKinds(fam, defaults, dt) {
  const all = Object.entries((gate.t && gate.kinds) || {}).filter(([k, v]) => v.fam === fam);
  const base = all.filter(([k]) => !k.includes('@')).filter(([key, v]) => { const d = dayLosing(key, dt); if (!d) return true;
      gateBlocked(key + '|' + dt, key, `loses on ${DT_WORD[dt] || dt}: ${d.n} past trades${d.from && d.to ? ' (' + new Date(d.from * 1000).toISOString().slice(0, 10) + ' to ' + new Date(d.to * 1000).toISOString().slice(0, 10) + ')' : ''}, avg ${d.avg}%, newer half ${d.newer}%`); return false; })
    .map(([key, v]) => ({ key, params: v.params, proven: !!v.pass && !isRetired(v) }));
  const byDay = dt ? all.filter(([k, v]) => k.endsWith('@' + dt) && v.pass && !isRetired(v)).map(([key, v]) => ({ key, params: v.params, proven: true })) : [];
  const ks = byDay.concat(base).sort((a, b) => (b.proven ? 1 : 0) - (a.proven ? 1 : 0));
  if (!all.length && (fam === 'stock_gapgo' || fam === 'stock_fade')) return []; // new kinds: no calls, not even paper ones, until the lab has tested them
  return ks.length || all.length ? ks : defaults.map(key => ({ key, params: DEF_PARAMS[fam] }));
}
// live regime check: an unknown market breadth (just after a restart) blocks rule-filtered calls instead of letting them through
function regimeLive(side, regime, sec) { if (!regime || regime === 'any') return true; if (callsState.breadthPct == null) return false; return Calls.regimeOk(side, callsState.breadthPct, regime, sec); }
const keyParts = key => { const [base, dt] = String(key).split('@'); const [grp, mode, side, setup] = base.split('|'); return { grp, mode, side, setup, dt }; };
function gateBlocked(what, key, reason) {
  const list = callsState.gateBlocked = callsState.gateBlocked || [];
  const t = Math.floor(Date.now() / 1000);
  if (!list.some(x => x.what === what && t - x.t < 3600)) { list.unshift({ t, what, kind: gateLabel(key), reason }); list.length = Math.min(list.length, 15); }
}
app.get('/api/calls/gate', (req, res) => {
  if (req.query.rebuild === '1' && !gate.building) { gate.t = 0; gate.lastTry = 0; maybeBuildGate(); }
  else maybeBuildGate();
  const src = Object.keys(gate.kinds || {}).length ? gate.kinds : (gate.partial || {}); // while the first run is in progress, show finished families
  const one = (key, v) => ({ key, ...v, retired: isRetired(v), reason: isRetired(v) ? retireReason(v) : v.reason });
  // each kind carries its results per market type (up / down / sideways days) as byDay; those can go live on their own
  const kinds = Object.entries(src).filter(([key]) => !key.includes('@')).map(([key, v]) => {
    const byDay = {}; for (const dt of ['up', 'down', 'flat']) { const d = src[key + '@' + dt]; if (d) byDay[dt] = one(key + '@' + dt, d); }
    return { ...one(key, v), byDay };
  }).sort((a, b) => a.key < b.key ? -1 : 1);
  const mem = process.memoryUsage();
  res.json({ server: { upMin: Math.round(process.uptime() / 60), rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576) }, labStartedAt: gate.building ? gate.startedAt : null, tookMin: gate.tookMin || null, enabled: GATE_MODE !== 'off', mode: GATE_MODE, indexGate: INDEX_GATE, retireMinTrades: RETIRE_MIN_TRADES, built: gate.t, building: gate.building, progress: gate.progress, err: gate.err, minTrades: GATE_MIN_TRADES, min: GATE_MIN, kinds, blocked: callsState.gateBlocked || [] });
});
async function backtestOneCall(spec, supplied) {
  if (spec.kind === 'index') return backtestIndexCall(spec, supplied);
  const sym = spec.symbol, intraday = spec.mode === 'intraday';
  let bars, source;
  if (supplied && supplied.length >= 120) { bars = supplied; source = 'TradingView export you uploaded'; }
  else { source = 'Upstox ' + (intraday ? '15-minute' : 'daily') + ' candles'; bars = intraday ? toBars(await getUpstoxCandles(sym, '15m')) : await getHistUpstox(sym, 750); }
  if (!bars || bars.length < 120) throw new Error('Only ' + (bars ? bars.length : 0) + ' candles available for ' + sym + ' (need at least 120)');
  let trades;
  const newSetup = ['orbvwap', 'pdhl', 'squeeze', 'vwap'].includes(spec.setup) ? spec.setup : null;
  const lab = (gate.kinds || {})[`stk|${spec.mode}|${spec.side}|${spec.setup || 'trend'}`], lp = lab && lab.params ? lab.params : {};
  if (intraday) { let idx15 = null; try { idx15 = toBars(await getUpstoxCandles('NIFTY', '15m')); } catch (e) {} trades = await Calls.walkIntraday(sym, bars, { idxBars15: idx15, ...lp, setup: newSetup || 'trend' }, yieldLoop); }
  else { let idx = null; try { idx = toBars(await getUpstoxCandles('NIFTY', '1D')).slice(-800); } catch (e) {} trades = await Calls.walkSwing(sym, bars, { exit: process.env.CALLS_EXIT || 'B', idxBars: idx, ...lp, setup: newSetup || 'trend' }, yieldLoop); }
  const done = trades.filter(x => x.closed);
  const same = done.filter(x => x.side === spec.side && (newSetup ? x.setup === newSetup : (spec.setup === 'bounce') === (x.setup === 'bounce')));
  const days = Math.round((bars[bars.length - 1].t - bars[0].t) / 86400);
  const out = { symbol: sym, mode: spec.mode, side: spec.side, setup: spec.setup || 'trend', source, candles: bars.length, days, from: bars[0].t, to: bars[bars.length - 1].t,
    costPct: Calls.costPct(spec.mode), sameKind: Calls.mkAgg(same), allSignals: Calls.mkAgg(done),
    recent: same.slice(-12).reverse().map(x => ({ t: x.t, status: x.status, pnlPct: x.pnlPct, targetsHit: x.targetsHit, bias: x.bias })) };
  if (lab && lab.n != null) out.universe = { state: 'done', label: 'Strategy lab (all stocks)', stocks: 90, n: lab.n, avgPct: lab.avg, winRate: lab.winRate, wins: null, losses: null, flat: null, note: lab.paramsText };
  else if (intraday || newSetup) out.universe = { state: 'na', note: 'See the Backtest gate in Trade Calls for this kind of call across all stocks.' };
  else {
    await ensureUniverseTrades();
    if (btUni.trades) { const u = btUni.trades.filter(x => x.closed && x.side === spec.side && (spec.setup === 'bounce') === (x.setup === 'bounce')); out.universe = { state: 'done', stocks: btUni.loaded, ...Calls.mkAgg(u) }; }
    else out.universe = { state: btUni.err ? 'error' : 'running', progress: btUni.progress, err: btUni.err };
  }
  return out;
}
async function specFromReq(q) {
  const db = await loadCalls(); const c = q.id ? db.find(x => x.id === q.id) : null;
  if (c && c.kind === 'option') return { kind: 'index', symbol: c.underlying, mode: c.mode, side: c.dir, setup: c.setup };
  if (c) return { symbol: c.symbol, mode: c.mode, side: c.side, setup: c.setup || 'trend' };
  if (q.kind === 'index' && INDEX_UNDERLYINGS.includes(String(q.symbol).toUpperCase()) && /^(BUY|SELL)$/.test(q.side) && /^(swing|intraday)$/.test(q.mode)) return { kind: 'index', symbol: String(q.symbol).toUpperCase(), mode: q.mode, side: q.side, setup: /^(orb|pullback|breakout|pdhl)$/.test(q.setup) ? q.setup : null };
  if (!q.symbol || !/^(BUY|SELL)$/.test(q.side) || !/^(swing|intraday)$/.test(q.mode)) throw new Error('call not found');
  return { symbol: String(q.symbol).toUpperCase().replace(/[^A-Z0-9&_-]/g, ''), mode: q.mode, side: q.side, setup: /^(bounce|orbvwap|pdhl|squeeze|vwap)$/.test(q.setup) ? q.setup : 'trend' };
}
app.get('/api/calls/backtest-call', async (req, res) => {
  try { const spec = await specFromReq(req.query); res.json(await new Promise((ok, no) => lowPriority.run(true, () => backtestOneCall(spec).then(ok, no)))); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/calls/backtest-call', async (req, res) => {
  try {
    const spec = await specFromReq({ ...req.body, id: req.body && req.body.id });
    const raw = Array.isArray(req.body && req.body.bars) ? req.body.bars : [];
    const bars = raw.map(r => ({ t: +r.t, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v || 0 })).filter(r => isFinite(r.t) && r.h >= r.l && r.c > 0).sort((a, b) => a.t - b.t).slice(-3000);
    res.json(await new Promise((ok, no) => lowPriority.run(true, () => backtestOneCall(spec, bars).then(ok, no))));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- Readiness scorecard: is the system ready for real money? Everything stays paper trading; this only measures, on the
// calls the strategy lab had PROVEN when they were issued, whether the live results back the lab up.
// GET /api/calls/readiness
const READY = { minTrades: 30, minDays: 10, minAvg: 0.10, minWin: 40, minPF: 1.2, worstDay: -2 };
function readyStats(list) {
  const n = list.length; if (!n) return { n: 0, days: 0 };
  const sum = list.reduce((a, c) => a + (c.pnlPct || 0), 0), byDay = {}; list.forEach(c => { const d = istDateKey(c.closedAt || c.exitT || c.t); byDay[d] = (byDay[d] || 0) + (c.pnlPct || 0); });
  const w = list.filter(c => c.pnlPct > 0.05), l = list.filter(c => c.pnlPct < -0.05), gw = w.reduce((a, c) => a + c.pnlPct, 0), gl = -l.reduce((a, c) => a + c.pnlPct, 0), days = Object.keys(byDay).sort();
  const r = x => Math.round(x * 100) / 100;
  return { n, days: days.length, from: days[0], to: days[days.length - 1], avg: r(sum / n), sum: r(sum), winRate: w.length + l.length ? Math.round(w.length / (w.length + l.length) * 100) : null, profitFactor: gl > 0 ? r(gw / gl) : (gw > 0 ? null : 0), worstDay: r(Math.min(...Object.values(byDay))), bestDay: r(Math.max(...Object.values(byDay))) };
}
app.get('/api/calls/readiness', async (req, res) => {
  try {
    const db = await loadCalls(), all = db.filter(c => c.closed && !c.manual && c.pnlPct != null), done = all.filter(c => c.kind !== 'option'); // stock calls only: option calls are % of premium (a miss costs about 25%), a different unit that would swamp the sums
    const proven = readyStats(done.filter(c => c.unproven === false)), paper = readyStats(done.filter(c => c.unproven !== false)), opts = readyStats(all.filter(c => c.kind === 'option'));
    const checks = [
      { k: 'trades', label: `at least ${READY.minTrades} closed stock calls from proven kinds`, ok: proven.n >= READY.minTrades, have: proven.n + ' so far' },
      { k: 'days', label: `spread over at least ${READY.minDays} trading days`, ok: proven.days >= READY.minDays, have: proven.days + ' so far' },
      { k: 'avg', label: `average at least +${READY.minAvg}% per call after costs`, ok: proven.n > 0 && proven.avg >= READY.minAvg, have: proven.n ? (proven.avg > 0 ? '+' : '') + proven.avg + '%' : '—' },
      { k: 'win', label: `win rate at least ${READY.minWin}%`, ok: proven.winRate != null && proven.winRate >= READY.minWin, have: proven.winRate != null ? proven.winRate + '%' : '—' },
      { k: 'pf', label: `profit factor at least ${READY.minPF} (money won ÷ money lost)`, ok: proven.n > 0 && (proven.profitFactor == null || proven.profitFactor >= READY.minPF), have: proven.profitFactor == null ? (proven.n ? 'no losses yet' : '—') : String(proven.profitFactor) },
      { k: 'dd', label: `no day worse than ${READY.worstDay}% (sum of the day's calls)`, ok: proven.n > 0 && proven.worstDay >= READY.worstDay, have: proven.n ? proven.worstDay + '%' : '—' }
    ];
    // which proven kinds can go live in each market type (same rule as the live scan: proven overall and not losing that day type, or proven on that day type alone)
    const kinds = gate.t ? Object.entries(gate.kinds || {}) : [], byType = {};
    for (const dt of ['up', 'down', 'flat']) {
      const base = kinds.filter(([k, v]) => !k.includes('@') && v.pass && !isRetired(v) && !dayLosing(k, dt)).map(([k]) => gateLabel(k));
      const day = kinds.filter(([k, v]) => k.endsWith('@' + dt) && v.pass && !isRetired(v)).map(([k]) => gateLabel(k));
      byType[dt] = [...new Set(base.concat(day))];
    }
    const passed = checks.filter(c => c.ok).length;
    const verdict = !gate.t ? 'lab' : passed === checks.length ? 'ready' : proven.n < READY.minTrades || proven.days < READY.minDays ? 'collecting' : 'not-yet';
    res.json({ verdict, passed, total: checks.length, checks, proven, paper, options: opts, byType, lab: { built: gate.t || null, version: gate.labVersion || null, building: !!gate.building, progress: gate.progress || '' }, criteria: READY,
      note: 'All of this is paper trading. "Ready" means the live results of lab-proven calls match the lab, not that profit is guaranteed. If you start with real money, keep the size small, trade only proven kinds and keep the daily loss stop on.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Excel export of the Calls Monitor: the day's calls (entered that day) plus older calls still open or closed that day.
// GET /api/calls/monitor/export?date=YYYY-MM-DD (default today, IST)
app.get('/api/calls/monitor/export', async (req, res) => {
  try {
    const { buildCallsWorkbook } = require('./export');
    const today = istDateKey(Math.floor(Date.now() / 1000)), date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : today;
    const db = await loadCalls();
    const rows = db.filter(c => istDateKey(c.t) === date || istDateKey(c.closedAt || c.exitT || 0) === date || (!c.closed && date === today));
    const wb = await buildCallsWorkbook(rows, { from: date, to: date, title: 'Calls Monitor summary · ' + date });
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="calls-' + date + '.xlsx"');
    res.send(Buffer.from(buf));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/calls/monitor', async (req, res) => {
  const db = await loadCalls();
  lowPriority.run(true, async () => { try { await runCallsCycle(false); await liveMonitor(); await maybeEod(); } catch (e) {} });
  const ev = await loadEvents(); const eod = await loadEod(); const W = await loadWatch();
  const active = db.filter(c => !c.closed).sort((a, b) => b.t - a.t);
  const day = istDateKey(Math.floor(Date.now() / 1000));
  const closed = db.filter(c => c.closed && istDateKey(c.closedAt || c.exitT || c.t) === day).sort((a, b) => (b.closedAt || b.exitT || 0) - (a.closedAt || a.exitT || 0));
  const A = await loadAcks();
  res.json({ build: BUILD, market: marketState(), now: Math.floor(Date.now() / 1000), risk: { ...riskCfg, today: dayRs(db), stopped: dailyStopped(db) }, active: active.map(withRs), closed: closed.map(withRs), events: ev.slice(-80).reverse().map(e => A.ids.includes(e.id) ? { ...e, acked: true } : e),
    today: buildEodAll(db, ev, day), sources: SOURCES, watch: W.items, watchDone: W.done.slice(0, 8), eod: eod.slice(-30).reverse(), persisted: !!process.env.UPSTASH_REDIS_REST_URL, lastScan: callsState.lastScan, upstox: upstoxTokens().length > 0 });
});
// Manually added items (from Chart patterns / Screener & scans): tracked, alerted and summarised like calls,
// but never counted in the Trade Calls stats or caps, and removable by the user.
app.post('/api/calls/monitor/add', async (req, res) => {
  try { const r = await addManualItem(req.body || {}); res.status(r.status).json(r.body); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
async function addManualItem(b) {
  {
    const source = ['pattern', 'screener', 'agreement'].includes(b.source) ? b.source : null;
    const symbol = String(b.symbol || '').toUpperCase().replace(/[^A-Z0-9&_-]/g, '');
    const side = b.side === 'SELL' ? 'SELL' : b.side === 'BUY' ? 'BUY' : null, mode = b.mode === 'intraday' ? 'intraday' : 'swing';
    if (!source || !symbol || !side) return { status: 400, body: { error: 'source, symbol and side are required' } };
    if (!upstoxTokens().length) return { status: 503, body: { error: 'Upstox is not connected, so the item cannot be priced and tracked' } };
    const db = await loadCalls();
    const dup = db.find(c => c.manual && !c.closed && c.symbol === symbol && srcOf(c) === source && c.side === side);
    if (dup) return { status: 409, body: { error: symbol + ' is already in the monitor from this section', id: dup.id } };
    // agreement signals are daily: the same stock and side is not re-added within 5 days of the last one, even after it closed
    if (source === 'agreement') { const recent = db.find(c => c.manual && srcOf(c) === 'agreement' && c.symbol === symbol && c.side === side && Date.now() / 1000 - c.t < 5 * 86400); if (recent) return { status: 409, body: { error: symbol + ' agreement signal already taken in the last 5 days', id: recent.id } }; }
    const q = await getUpstoxLTPC(await dataKeyFor(symbol)); const ltp = q.price;
    if (!(ltp > 0)) throw new Error('no live price for ' + symbol);
    const sgn = side === 'BUY' ? 1 : -1;
    let sl = Number(b.sl);
    const okSl = x => isFinite(x) && x > 0 && sgn * (ltp - x) > 0.001 * ltp && Math.abs(ltp - x) <= (mode === 'intraday' ? 0.04 : 0.15) * ltp;
    let slNote = 'stop from the ' + (source === 'pattern' ? 'pattern' : 'signal');
    if (!okSl(sl)) { // volatility stop: 2x daily ATR (swing) or 1.6x 15-minute ATR (intraday)
      const bars = mode === 'intraday' ? toBars(await getUpstoxCandles(symbol, '15m')).slice(-200) : (await getHistUpstox(symbol, 200));
      const A = Calls.atr(bars.map(x => x.h), bars.map(x => x.l), bars.map(x => x.c)); const a = A[A.length - 1];
      if (!(a > 0)) throw new Error('not enough history to set a stop');
      sl = ltp - sgn * Math.max((mode === 'intraday' ? 1.6 : 2) * a, (mode === 'intraday' ? 0.004 : 0.015) * ltp); slNote = 'volatility stop (' + (mode === 'intraday' ? '1.6x 15-min' : '2x daily') + ' ATR)';
    }
    const risk = Math.abs(ltp - sl), tk = x => Math.round(x * 20) / 20;
    let targets = (mode === 'intraday' ? [1, 2, 3] : [1.5, 3, 4.5]).map(m => tk(ltp + sgn * risk * m));
    const tg = Number(b.target);
    if (isFinite(tg) && sgn * (tg - ltp) > 1.2 * risk) targets = [tk(ltp + sgn * risk), tk(tg)]; // pattern target as the final target
    const now = Math.floor(Date.now() / 1000);
    const call = { id: source + '-' + symbol + '-' + now, symbol, side, mode, source, manual: true, label: String(b.label || '').slice(0, 80),
      entry: tk(ltp), sl: tk(sl), targets, riskLabel: (risk / ltp * 100).toFixed(1) + '% risk', riskPct: Math.round(risk / ltp * 1000) / 10, score: null, setup: 'manual', engine: 'manual',
      costPct: Calls.costPct(mode), analysis: (String(b.note || '').slice(0, 400) + ' Entry at the live price when added; ' + slNote + '.').trim(), t: now,
      status: 'ACTIVE', targetsHit: 0, activeSl: tk(sl), ltp, exit: null, pnlPct: 0, closed: false };
    db.push(call); if (db.length > CALLS_MAX) db.splice(0, db.length - CALLS_MAX); await saveCalls();
    await emitEvent({ id: call.id + ':NEW', callId: call.id, source, symbol, side, mode, kind: 'NEW', level: 'info', t: now, price: call.entry, pnlPct: null, text: `➕ [${source === 'pattern' ? 'Pattern' : source === 'agreement' ? 'Agreement' : 'Screener'}] ${side} ${symbol} (${mode}) added to monitor at ₹${call.entry}, SL ₹${call.sl}` + (b.notify ? `, targets ₹${call.targets.join(' / ₹')}${call.label ? '\n' + call.label : ''}${b.paper ? '\n🧪 Paper: the agreement test has not passed yet.' : ''}` : '') }, !!b.notify);
    return { status: 200, body: { ok: true, call } };
  }
}
// ---- Agreement strategy, run by the server (no need for the dashboard to be open) -----------------------------------------
// Screener signal + daily chart pattern + daily breakout (+1 when the weekly breakout agrees), computed with the page's own code
// (engines.js runs it here). Checked once a day at 15:05 IST on the nearly finished daily candle, because the agreement test
// enters at the day's close: a morning check reads a half-formed candle, which is what the test never saw.
const Engines = require('./engines');
const AG_VARS = []; [2, 3, 4].forEach(N => [1, 2].forEach(W => ['atr', 'pat'].forEach(X => AG_VARS.push({ N, W, X, key: N + '|' + W + '|' + X }))));
const AG_DEFAULT = { N: 3, W: 1, X: 'atr', key: '3|1|atr' }, AG_MAX_DAY = 10, AG_AT = 905, AG_UNTIL = 920;
let agState = { day: null, running: false, last: null };
function agScoreS(sig, p, b, w, W) { const s = /buy/.test(sig || '') ? 1 : /sell/.test(sig || '') ? -1 : 0, sv = s * (W === 2 && /strong/.test(sig || '') ? 2 : 1); let a = sv + p + b; if (w && a !== 0 && Math.sign(w) === Math.sign(a)) a += Math.sign(a); return a; }
function agWeekly(C) { const W = []; let cur = null; C.forEach(b => { const d = new Date((b.t + 19800) * 1000), wk = Math.floor((d.getTime() / 86400000 + 3) / 7); if (!cur || cur.wk !== wk) { cur = { wk, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }; W.push(cur); } else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v || 0; } cur.last = b.t; }); return W; }
// one stock on its daily candles (last = today so far): the same inputs the agreement test replays
function agEval(E, sym, C, v) {
  const k = C.length - 1, cl = C.map(x => x.c), hh = C.map(x => x.h), ll = C.map(x => x.l), last = cl[k];
  const dd = { symbol: sym, prices: cl, histHL: { h: hh, l: ll }, realHistory: true, price: last, support1: Math.min(...ll.slice(-20)), resistance1: Math.max(...hh.slice(-20)) };
  dd.support2 = dd.support1 * 0.97; dd.resistance2 = dd.resistance1 * 1.03; dd.targetMean = last;
  let h = null; try { h = E.buildHorizons(dd).swing; } catch (e) {}
  const sig = h ? h.signal : 'hold';
  let bk = null; try { bk = E.xsBreak(C, 'D'); } catch (e) {}
  const b = bk && bk.type === 'break' ? bk.d : 0;
  let pt = null; try { pt = E.xsPattern(C.slice(-320), '1D'); } catch (e) {}
  const p = pt ? pt.d : 0;
  let w = 0, wk = null; try { const Wk = agWeekly(C); if (Wk.length > 30) { wk = E.xsBreak(Wk, 'W'); w = wk && wk.type === 'break' ? wk.d : 0; } } catch (e) {}
  const a = agScoreS(sig, p, b, w, v.W);
  let atr = null; try { atr = E.B.atrAt(C, k, 14); } catch (e) {}
  return { sym, a, sig, sigLabel: h ? h.signalLabel : sig, score: h ? h.score : null, pt, bk, wk, w, atr, price: last };
}
let agRuleMem; // undefined = not read yet
async function agRule() { if (agRuleMem === undefined) agRuleMem = await storeGet('store:agreement-rule', null).catch(() => null); const r = agRuleMem; const v = r && AG_VARS.find(x => x.key === r.key); return { v: v || AG_DEFAULT, passed: !!(r && v && r.pass), rule: r }; }
app.post('/api/agreement/rule', async (req, res) => {
  const b = req.body || {}, v = AG_VARS.find(x => x.key === b.key);
  if (b.key !== 'auto' && !v) return res.status(400).json({ error: 'unknown rule set' });
  const r = b.key === 'auto' ? null : { key: v.key, pass: !!b.pass, n: Number(b.n) || null, avg: b.avg != null ? Number(b.avg) : null, t0: b.t0 || null, t1: b.t1 || null, testedAt: b.testedAt || null, chosenBy: b.chosenBy === 'user' ? 'user' : 'test', at: Date.now() };
  agRuleMem = r; try { await storeSet('store:agreement-rule', r); } catch (e) {}
  res.json({ ok: true, rule: r });
});
app.get('/api/agreement', async (req, res) => { const R = await agRule(); res.json({ rule: R.rule, using: R.v.key, passed: R.passed, at: AG_AT, engines: Engines.load() ? 'ok' : Engines.error(), state: agState }); });
app.post('/api/agreement/run', async (req, res) => { if (!(req.body && req.body.dry)) return res.status(400).json({ error: 'only dry runs can be started by hand' }); try { res.json(await runAgreement({ dry: true })); } catch (e) { res.status(500).json({ error: e.message }); } });
async function runAgreement(opts = {}) {
  const E = Engines.load(); if (!E) throw new Error('browser engines failed to load: ' + Engines.error());
  if (agState.running) return { busy: true }; agState.running = true;
  const t0 = Date.now(), { v, passed } = await agRule(), out = [];
  try {
    for (const sym of FNO_FALLBACK) {
      try { const C = (await getHistUpstox(sym, 400)).filter(x => x.c > 0); if (C.length >= 200) { const r = agEval(E, sym, C, v); if (Math.abs(r.a) >= v.N) out.push(r); } } catch (e) {}
      await new Promise(r => setImmediate(r));
    }
    out.sort((p, q) => Math.abs(q.a) - Math.abs(p.a) || (q.a > 0 ? (q.score || 0) - (p.score || 0) : (p.score || 0) - (q.score || 0)));
    const added = [], skipped = [];
    if (!opts.dry) {
      const db = await loadCalls(), day = Math.floor((Date.now() / 1000 + 19800) / 86400);
      let room = AG_MAX_DAY - db.filter(c => c.manual && srcOf(c) === 'agreement' && Math.floor((c.t + 19800) / 86400) === day).length;
      for (const r of out) {
        if (room <= 0) break;
        const dir = Math.sign(r.a); let sl = r.atr ? r.price - dir * 1.5 * r.atr : undefined, target = r.atr ? r.price + dir * 3 * r.atr : undefined; const pt = r.pt;
        if (v.X === 'pat' && pt && pt.d === dir && pt.stop && pt.target) { sl = pt.stop; target = pt.target; }
        const lab = 'Agreement ' + (dir > 0 ? '▲' : '▼').repeat(Math.min(Math.abs(r.a), 4)) + ' (' + Math.abs(r.a) + ' agree)';
        const note = lab + ': screener ' + r.sigLabel + (pt && pt.d === dir ? ', ' + pt.name : '') + (r.bk && r.bk.type === 'break' ? ', broke ' + r.bk.name : '') + (r.w && Math.sign(r.w) === dir ? ', weekly breakout agrees' : '') + '. Checked at 15:05 on the daily candle. Rule set ' + v.key + '.' + (passed ? '' : ' Paper: the agreement test has not passed yet.');
        const res = await addManualItem({ source: 'agreement', symbol: r.sym, side: dir > 0 ? 'BUY' : 'SELL', mode: 'swing', label: lab, note, sl, target, notify: true, paper: !passed });
        if (res.status === 200) { added.push(r.sym); room--; } else skipped.push(r.sym + ': ' + (res.body && res.body.error));
      }
    }
    agState.last = { at: Date.now(), tookS: Math.round((Date.now() - t0) / 1000), rule: v.key, passed, dry: !!opts.dry, found: out.map(r => ({ sym: r.sym, a: r.a, sig: r.sigLabel, pattern: r.pt ? (r.pt.d > 0 ? '▲ ' : r.pt.d < 0 ? '▼ ' : '') + r.pt.name : null, breakout: r.bk && r.bk.type === 'break' ? (r.bk.d > 0 ? '▲ ' : '▼ ') + r.bk.name : null, weekly: r.w || 0 })), added, skipped };
    return agState.last;
  } finally { agState.running = false; }
}
setInterval(() => { const p = istParts(); if (p.dow === 0 || p.dow === 6 || p.mins < AG_AT || p.mins > AG_UNTIL || !upstoxTokens().length) return;
  const day = new Date(Date.now() + 19800000).toISOString().slice(0, 10); if (agState.day === day || agState.running) return;
  storeGet('store:agreement-ran', null).catch(() => null).then(d => { if (d === day) { agState.day = day; return; } agState.day = day;
    runAgreement().then(r => storeSet('store:agreement-ran', day).catch(() => {}))
      .catch(e => { agState.last = { at: Date.now(), err: e.message }; sendTelegram('⚠️ Agreement check failed today: ' + e.message).catch(() => {}); }); });
}, 60000).unref();

// ---- Trigger watch (Chart patterns "decision zone"): wait for a 15-minute close beyond a pattern's trigger level, then add
// the item to the Calls Monitor at that price. Cancelled if price closes beyond the invalidation level first, or on expiry.
let watchMem = null;
async function loadWatch() { if (!watchMem) { try { watchMem = await storeGet('store:calls-watch', null); } catch (e) {} if (!watchMem || !Array.isArray(watchMem.items)) watchMem = { items: [], done: [] }; } return watchMem; }
async function saveWatch() { try { await storeSet('store:calls-watch', watchMem); } catch (e) {} }
app.post('/api/calls/watch/add', async (req, res) => {
  const b = req.body || {}, W = await loadWatch();
  const symbol = String(b.symbol || '').toUpperCase().replace(/[^A-Z0-9&_-]/g, ''), side = b.side === 'SELL' ? 'SELL' : b.side === 'BUY' ? 'BUY' : null;
  const level = Number(b.level), sl = Number(b.sl), target = Number(b.target), mode = b.mode === 'intraday' ? 'intraday' : 'swing';
  if (!symbol || !side || !(level > 0)) return res.status(400).json({ error: 'symbol, side and trigger level are required' });
  if (W.items.some(w => w.symbol === symbol && w.side === side && Math.abs(w.level / level - 1) < 0.002)) return res.status(409).json({ error: 'Already watching this trigger' });
  const now = Math.floor(Date.now() / 1000), days = mode === 'intraday' ? 3 : 10;
  const w = { id: 'w-' + symbol + '-' + now, symbol, side, level, sl: sl > 0 ? sl : null, target: target > 0 ? target : null, mode, label: String(b.label || '').slice(0, 120), note: String(b.note || '').slice(0, 400), t: now, expires: now + days * 86400 };
  W.items.push(w); await saveWatch(); res.json({ ok: true, watch: w });
});
app.post('/api/calls/watch/remove', async (req, res) => {
  const W = await loadWatch(), i = W.items.findIndex(w => w.id === (req.body && req.body.id));
  if (i < 0) return res.status(404).json({ error: 'not found' });
  W.items.splice(i, 1); await saveWatch(); res.json({ ok: true });
});
async function checkWatches() {
  const W = await loadWatch(); if (!W.items.length) return;
  const now = Math.floor(Date.now() / 1000); let changed = false;
  for (const w of W.items.slice()) {
    let outcome = null, px = null;
    if (now > w.expires) outcome = 'expired';
    else {
      try {
        let rows = toBars(await getUpstoxCandles(w.symbol, '15m')); if (rows.length && rows[rows.length - 1].t + 900 > now) rows = rows.slice(0, -1);
        const b = rows[rows.length - 1]; if (!b || b.t + 900 < w.t) continue; // only closes after the watch was set
        px = b.c; const sg = w.side === 'BUY' ? 1 : -1;
        if (w.sl && sg * (w.sl - b.c) >= 0) outcome = 'invalidated';
        else if (sg * (b.c - w.level) > 0.0005 * w.level) outcome = 'triggered';
      } catch (e) { continue; }
    }
    if (!outcome) continue;
    W.items.splice(W.items.indexOf(w), 1); changed = true;
    let note = '';
    if (outcome === 'triggered') {
      try { const r = await addManualItem({ source: 'pattern', symbol: w.symbol, side: w.side, mode: w.mode, sl: w.sl, target: w.target, label: ('Triggered: ' + w.label).slice(0, 80), note: w.note + ' Triggered by a 15-minute close at ' + px + ' beyond ' + w.level + '.' });
        note = r.status === 200 ? 'added to the monitor' : (r.body && r.body.error) || 'could not add'; } catch (e) { note = e.message; }
    } else if (outcome === 'invalidated') {
      await emitEvent({ id: w.id + ':INV', callId: w.id, source: 'pattern', symbol: w.symbol, side: w.side, mode: w.mode, kind: 'EXPIRED', level: 'info', t: now, price: px, pnlPct: null, text: `✖ Watch cancelled: ${w.symbol} closed beyond the invalidation level ${w.sl} before triggering (${w.label})` }, true);
    }
    W.done.unshift({ ...w, outcome, at: now, px, note }); W.done.length = Math.min(W.done.length, 20);
  }
  if (changed) await saveWatch();
}

app.post('/api/calls/monitor/remove', async (req, res) => {
  const db = await loadCalls(); const id = req.body && req.body.id; const i = db.findIndex(c => c.id === id);
  if (i < 0) return res.status(404).json({ error: 'not found' });
  if (!db[i].manual && !db[i].restored) return res.status(400).json({ error: 'Trade Calls are tracked automatically and cannot be removed' });
  db.splice(i, 1); await saveCalls(); res.json({ ok: true });
});
// Manual exit: close a Monitor item you added yourself at the live price; it counts in results and summaries like any exit.
app.post('/api/calls/monitor/exit', async (req, res) => {
  try {
    const db = await loadCalls(); const id = req.body && req.body.id; const c = db.find(x => x.id === id);
    if (!c) return res.status(404).json({ error: 'not found' });
    if (!c.manual && !c.restored) return res.status(400).json({ error: 'Trade Calls run to their stop, targets or time exit' });
    if (c.closed) return res.status(400).json({ error: 'already closed' });
    if (c.watchOnly || c.status === 'WATCH') return res.status(400).json({ error: 'not triggered yet; use Remove' });
    let price = null;
    try { const q = await getUpstoxLTPC(c.instrumentKey || await dataKeyFor(c.symbol)); if (q && q.price > 0) price = q.price; } catch (e) {}
    if (!(price > 0)) return res.status(503).json({ error: 'live price unavailable right now; try again' });
    const now = Math.floor(Date.now() / 1000), sg = c.side === 'BUY' ? 1 : -1, cost = c.costPct != null ? c.costPct : Calls.costPct(c.mode), gross = sg * (price - c.entry) / c.entry * 100;
    Object.assign(c, { status: 'MANUAL_EXIT', closed: true, exit: Math.round(price * 100) / 100, ltp: Math.round(price * 100) / 100, exitT: now, closedAt: now, grossPct: Math.round(gross * 100) / 100, pnlPct: Math.round((gross - cost) * 100) / 100 });
    await saveCalls();
    try { await emitEvent({ id: c.id + ':MANUAL', callId: c.id, source: srcOf(c), symbol: c.symbol, side: c.side, mode: c.mode, kind: 'MANUAL', level: 'info', t: now, price: c.exit, pnlPct: c.pnlPct, text: `✋ Manual exit: ${c.side} ${c.symbol} at ₹${c.exit} (${c.pnlPct > 0 ? '+' : ''}${c.pnlPct}%)` }, true); } catch (e) {}
    res.json({ ok: true, exit: c.exit, pnlPct: c.pnlPct });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/calls/eod/run', async (req, res) => {
  try { const day = istDateKey(Math.floor(Date.now() / 1000)); const x = await runEod(day, true); res.json({ ok: true, summary: x }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/calls/reset', async (req, res) => {
  const db = await loadCalls();
  try { await redisCmd('SET', 'store:trade-calls:bak:reset', JSON.stringify(db), 'EX', '604800'); } catch (e) {} // undo copy, kept 7 days
  const keep = db.filter(c => !c.closed || c.manual); // open calls and manual Monitor items stay
  const removed = db.length - keep.length; db.length = 0; db.push(...keep); await saveCalls(); callsState.lastScan = 0;
  res.json({ ok: true, removed, kept: keep.length });
});
// Put back a call lost before this fix (e.g. an open swing trade removed by the old Reset). The stop and targets are rebuilt
// from the swing engine on the daily bars before the call's day, moved to the original entry price.
app.post('/api/calls/restore', async (req, res) => {
  try {
    const b = req.body || {}, sym = String(b.symbol || '').toUpperCase().replace(/[^A-Z0-9&_-]/g, ''), side = b.side === 'SELL' ? 'SELL' : 'BUY';
    const entry = Number(b.entry), t = Number(b.t), mode = b.mode === 'intraday' ? 'intraday' : 'swing';
    if (!sym || !(entry > 0) || !(t > 0)) return res.status(400).json({ error: 'symbol, entry and t are required' });
    const db = await loadCalls();
    if (db.some(c => c.symbol === sym && !c.closed && !c.manual)) return res.status(409).json({ error: sym + ' already has an open call' });
    const bars = await getHistUpstox(sym, 400), dayStart = t - ((t + 19800) % 86400), k = bars.filter(x => x.t < dayStart).length - 1;
    const P = Calls.prep(bars.slice(0, k + 1)); let ev = null;
    for (const kd of liveKinds('stock_swing', ['stk|swing|BUY|trend'])) { const [, , sd, setup] = kd.key.split('|'); if (sd !== side) continue;
      const e = Calls.evalAt(P, k, 'swing', { ...kd.params, side, setup: setup === 'bounce' ? 'trend' : setup }); if (e) { ev = { ...e, gateKey: kd.key }; break; } }
    const sg = side === 'BUY' ? 1 : -1, A = Calls.atr(bars.map(x => x.h), bars.map(x => x.l), bars.map(x => x.c))[k];
    const dist = ev ? Math.abs(ev.entry - ev.sl) : 2 * A, mult = ev ? ev.targets.map(x => Math.abs(x - ev.entry) / dist) : [1.5, 3, 4.5], tk = x => Math.round(x * 20) / 20;
    const sl = Number(b.sl) > 0 ? Number(b.sl) : tk(entry - sg * dist), targets = Array.isArray(b.targets) && b.targets.length ? b.targets.map(Number) : mult.map(m => tk(entry + sg * dist * m));
    const call = { id: 'restored-' + sym + '-' + t, symbol: sym, side, mode, entry, sl, activeSl: sl, targets, t, status: 'ACTIVE', targetsHit: 0, ltp: entry, exit: null, pnlPct: 0, closed: false,
      riskLabel: (dist / entry * 100 < 3 ? 'LOW' : dist / entry * 100 < 5.5 ? 'MEDIUM' : 'HIGH'), riskPct: Math.round(dist / entry * 1000) / 10, score: ev ? ev.score : null, setup: ev ? ev.setup : 'trend', engine: 'v3',
      gateKey: ev ? ev.gateKey : 'stk|swing|BUY|trend', unproven: true, restored: true, costPct: Calls.costPct(mode),
      analysis: 'Restored after it was removed by the old Reset button. ' + (ev ? 'Stop and targets rebuilt from the swing rules on the daily bars before the call. ' + ev.analysis : 'Stop at 2x the daily ATR, targets 1.5/3/4.5x the risk (the swing signal could not be re-derived).') };
    await trackCall(call); if (call.closed) call.closedAt = call.exitT || Math.floor(Date.now() / 1000);
    db.push(call); await saveCalls(); res.json({ ok: true, call });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/calls', async (req, res) => {
  const db = await loadCalls();
  if (req.query.scan === '1') lowPriority.run(true, () => runCallsCycle(true));
  else lowPriority.run(true, () => runCallsCycle(false));
  const own = db.filter(c => !c.manual);
  const calls = own.slice().sort((a, b) => b.t - a.t).map(withRs);
  let shadow = []; try { shadow = (await loadShadow()).slice().sort((a, b) => b.t - a.t).slice(0, 60); } catch (e) {}
  res.json({ build: BUILD, calls, shadow, stats: Calls.summarize(own), scan: { ...callsState, nextInSec: Math.max(0, Math.round((SCAN_EVERY - (Date.now() - callsState.lastScan)) / 1000)), universe: FNO_FALLBACK.length, persisted: !!(process.env.UPSTASH_REDIS_REST_URL) } });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

if (process.env.CALLS_TEST_HOOKS) global.__hooks = { buildOptionCall, pickExpiry, trackCall, runIndexScan, backtestIndexCall, loadCalls, getOptionContracts, callsState };
// Upstox daily tokens expire at 3:30 am IST; reload today's login token after a restart.
function oauthExpiry(t) { const ist = t + 19800000, d = new Date(ist); const cut = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 3, 30); return (ist < cut ? cut : cut + 86400000) - 19800000; }
(async () => { try { const o = await storeGet('upstox:oauth', null); if (o && o.token && Date.now() < oauthExpiry(o.t)) { process.env.UPSTOX_OAUTH_TOKEN = o.token; if (UpstoxClient) initUpstoxAuth(); console.log('Restored today\'s Upstox login token'); setTimeout(() => { try { maybeBuildGate(); } catch (e) {} }, 30000); } } catch (e) {} })();
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
