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
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\nDashboard running at http://localhost:${PORT}`);
  console.log(`Live data proxied from Yahoo Finance (cache TTL ${CACHE_TTL_MS / 1000}s)\n`);
});
