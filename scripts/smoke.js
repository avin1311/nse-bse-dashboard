// Quick automated checks — run with:  npm test
// Starts the server locally (no network/tokens needed) and verifies the basics still work.
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

// 1. the page's scripts must parse, and the pattern engine must run
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((m, i) => { let e = null; try { new Function(m[1]); } catch (x) { e = x; } ok(!e, 'inline script #' + i + ' parses' + (e ? ': ' + e.message : '')); });
{ const E = require('../engines').load(); ok(!!E, 'browser engines run on the server (agreement strategy)' + (E ? '' : ': ' + require('../engines').error()));
  if (E) { const C = []; let p = 1000; for (let i = 0; i < 300; i++) { const o = p; p *= 1 + Math.sin(i / 9) * 0.01; C.push({ t: 1700000000 + i * 86400, o, h: Math.max(o, p) * 1.005, l: Math.min(o, p) * 0.995, c: p, v: 1e5 }); }
    let okk = true; try { E.xsPattern(C, '1D'); E.xsBreak(C, 'D'); E.B.atrAt(C, C.length - 1, 14); const d = { symbol: 'X', prices: C.map(x => x.c), histHL: { h: C.map(x => x.h), l: C.map(x => x.l) }, realHistory: true, price: p, support1: p * 0.95, resistance1: p * 1.05, support2: p * 0.92, resistance2: p * 1.08, targetMean: p }; okk = !!E.buildHorizons(d).swing.signal; } catch (e) { okk = false; }
    ok(okk, 'agreement inputs compute on the server'); } }
{ let okx = false; try { const { buildCallsWorkbook } = require('../export'); buildCallsWorkbook([{ id: 'a', symbol: 'X', side: 'BUY', mode: 'swing', entry: 10, exit: 11, ltp: 11, t: 1792400000, closed: true, status: 'EXPIRED', costPct: 0.1, sl: 9, targets: [11, 12] }], { from: '2026-10-19', to: '2026-10-19' }).then(wb => { ok(wb.worksheets.length === 2, 'Excel export builds (Summary + Trades)'); }); okx = true; } catch (e) { console.log(e.message); } ok(okx, 'Excel export module loads'); }
ok(/function newsAgo\(/.test(html) && /function newsEsc\(/.test(html), 'news helpers defined');
ok(/id="viewTabs"/.test(html) && (html.match(/class="vtab-pane"/g) || []).length === 4 && /id="scanView"/.test(html) && /id="portView"/.test(html), 'four stock tabs plus the Scanner and Portfolio pages');
{
  const i = html.indexOf('const PatternEngine'), j = html.indexOf('CHART PATTERNS SECTION');
  const E = new Function(html.slice(i, j).replace(/\/\*\s*=+\s*$/, '') + '\nreturn PatternEngine;')();
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  let p = 500; const C = []; for (let k = 0; k < 400; k++) { const o = p; p *= 1 + (rnd() - 0.48) * 0.03; C.push({ t: 1.6e9 + k * 86400, o, h: Math.max(o, p) * 1.004, l: Math.min(o, p) * 0.996, c: p, v: 1e6 }); }
  const r = E.detect(C); ok(Array.isArray(r.patterns), 'pattern engine runs (' + r.patterns.length + ' patterns on random data)');
  const w = E.walk(C, { step: 8 }); ok(Array.isArray(w), 'walk-forward backtest runs (' + w.length + ' signals)');
  ok(r.patterns.every(p => p.pa === undefined || p.pa === null || /^(enter|wait|watch|avoid)$/.test(p.pa.action)), 'price-action layer gives every pattern an action');
  ok(w.every(o => o.mode === 'breakout' || o.mode === 'retest'), 'walk-forward tags breakout and retest entries');
}

{
  const i = html.indexOf('const TradePlanner'), j = html.indexOf('const PlannerUI');
  const TP = new Function('document', html.slice(i, j) + '\nreturn TradePlanner;')({ getElementById: () => null });
  const near = (a, b) => Math.abs(a - b) < 0.01;
  ok(near(TP.touchProb(0.6745 * 0.02 * Math.sqrt(10), 0.02, 10), 0.5), 'trade planner: 50% touch probability maths');
  ok(near(TP.touchProb(0.3186 * 0.02 * Math.sqrt(10), 0.02, 10), 0.75) && near(TP.touchProb(1.1503 * 0.02 * Math.sqrt(10), 0.02, 10), 0.25), 'trade planner: 25%/75% touch probabilities');
  const D = []; let q = 100; for (let k = 0; k < 120; k++) { const o = q; q *= 1 + Math.sin(k / 5) * 0.01; D.push({ t: k, h: Math.max(o, q) * 1.005, l: Math.min(o, q) * 0.995, c: q }); }
  const st = TP.dailyStats(D), Lg = TP.calc(q, 1, st, null), Sh = TP.calc(q, -1, st, null);
  ok(Lg.stop < q && Lg.t1 > q && Lg.t2 > Lg.t1, 'trade planner: long levels ordered stop < price < T1 < T2');
  ok(Sh.stop > q && Sh.t1 < q && Sh.t2 < Sh.t1, 'trade planner: short levels ordered T2 < T1 < price < stop');
}

// calls engine: levels ordered, tracker conservative
{
  const C = require('../calls.js'); let sd = 3; const rn = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  let p = 500; const bars = []; for (let i = 0; i < 400; i++) { const o = p; p *= 1 + 0.002 + 0.012 * (rn() - 0.5); bars.push({ t: 1.7e9 + i * 86400, h: Math.max(o, p) * 1.003, l: Math.min(o, p) * 0.997, c: p, v: 1e6 * (0.8 + rn()) }); }
  let n = 0, bad = 0; for (let i = 80; i < 400; i++) { const r = C.evaluate(bars.slice(0, i + 1), 'swing'); if (!r) continue; n++; const s = r.side === 'BUY' ? 1 : -1; if (!(s * (r.entry - r.sl) > 0 && s * (r.targets[0] - r.entry) > 0 && s * (r.targets[1] - r.targets[0]) > 0 && s * (r.targets[2] - r.targets[1]) > 0)) bad++; }
  ok(bad === 0, 'trade calls: levels ordered on ' + n + ' generated calls');
  { // index engine: levels ordered, option tracker closes on spot invalidation
    let s2 = 5; const r2n = () => ((s2 = (s2 * 16807) % 2147483647) / 2147483647); let q = 20000; const D = [];
    for (let i = 0; i < 400; i++) { const o = q; q *= 1 + 0.001 + (r2n() - 0.5) * 0.01; D.push({ t: 1.7e9 + i * 86400, o, h: Math.max(o, q) * 1.003, l: Math.min(o, q) * 0.997, c: q, v: 0 }); }
    let n2 = 0, bad2 = 0; for (let i = 210; i < 400; i++) { const r = C.evaluateIndex(D.slice(0, i + 1), 'swing', { bias: 'MIXED' }); if (!r) continue; n2++; const sg = r.side === 'BUY' ? 1 : -1; if (!(sg * (r.entry - r.sl) > 0 && sg * (r.targets[0] - r.entry) > 0 && sg * (r.targets[2] - r.targets[1]) > 0)) bad2++; }
    ok(bad2 === 0, 'index engine: levels ordered on ' + n2 + ' generated signals');
    const oc = { side: 'BUY', mode: 'intraday', dir: 'BUY', entry: 100, sl: 80, targets: [120, 140, 160], t: 1.7e9, spotSl: 24000, costPct: 2 };
    const ob = [{ t: 1.7e9 + 900, h: 105, l: 99, c: 103 }, { t: 1.7e9 + 1800, h: 110, l: 100, c: 108 }];
    const sb = [{ t: 1.7e9 + 900, c: 24100 }, { t: 1.7e9 + 1800, c: 23950 }];
    const tr = C.trackOption(oc, ob, sb, 1.7e9 + 5000);
    ok(tr.closed && tr.status === 'SL_HIT' && tr.exit === 108, 'index options: closes at the premium when the index breaks the stop level');
  }
  const call = { side: 'BUY', mode: 'swing', entry: 100, sl: 95, targets: [105, 110, 120], t: 0 };
  ok(C.track(call, [{ t: 1, h: 106, l: 94, c: 100 }], 1e9).status === 'SL_HIT', 'trade calls: SL assumed first when both hit in one bar');
  ok(C.track(call, [{ t: 1, h: 106, l: 99, c: 105 }, { t: 2, h: 106, l: 100, c: 101 }], 1e9).status === 'BREAKEVEN', 'trade calls: stop trails to entry after T1');
}

// 2. server behaviour
function start(env, port) { return spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), ...env }, stdio: 'ignore' }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitUp(base) { for (let i = 0; i < 40; i++) { try { const r = await fetch(base + '/healthz'); if (r.ok) return true; } catch (e) {} await sleep(250); } return false; }
(async () => {
  const s1 = start({ DASHBOARD_PASSCODE: '', CHECK_ALERTS_SECRET: '' }, 3911), b1 = 'http://localhost:3911';
  ok(await waitUp(b1), 'server starts');
  ok((await (await fetch(b1 + '/healthz')).text()) === 'ok', '/healthz answers ok');
  { const r = await (await fetch(b1 + '/api/calls/backtest')).json(); ok(r && typeof r.state === 'string', '/api/calls/backtest responds'); }
  { const r = await (await fetch(b1 + '/api/calls/backtest-call?symbol=WIPRO&side=SELL&mode=swing')).json(); ok(r && (r.error || r.symbol), '/api/calls/backtest-call responds'); }
  { const r = await fetch(b1 + '/api/calls/monitor/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'pattern', symbol: 'TCS', side: 'BUY', mode: 'swing' }) }); ok(r.status === 503 || r.status === 200 || r.status === 502, '/api/calls/monitor/add responds (' + r.status + ')'); }
  { const r = await (await fetch(b1 + '/api/calls/gate')).json(); ok(r && Array.isArray(r.kinds) && r.enabled === true, '/api/calls/gate responds (gate on by default)'); }
  { const r = await fetch(b1 + '/api/calls/monitor/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'nope' }) }); ok(r.status === 404, '/api/calls/monitor/remove rejects unknown ids'); }
  { const r = await (await fetch(b1 + '/api/calls/backtest-call?kind=index&symbol=NIFTY&side=BUY&mode=intraday')).json(); ok(r && (r.error || r.kind === 'index'), '/api/calls/backtest-call (index) responds'); }
  { const r = await (await fetch(b1 + '/api/calls/monitor')).json(); ok(Array.isArray(r.active) && Array.isArray(r.events) && r.today && r.today.date, '/api/calls/monitor responds'); }
  { const r = await (await fetch(b1 + '/api/calls')).json(); ok(Array.isArray(r.calls) && r.stats && r.scan, '/api/calls responds (' + r.calls.length + ' calls)'); }
  const pg = await fetch(b1 + '/'); ok(pg.ok && (await pg.text()).includes('viewTabs'), 'home page served');
  const st = await (await fetch(b1 + '/api/status')).json(); ok(st && st.market && st.telegram, '/api/status returns health info');
  ok((await (await fetch(b1 + '/api/auth/status')).json()).required === false, 'no passcode -> open');
  s1.kill();

  const s2 = start({ DASHBOARD_PASSCODE: 'test-pass-123', CHECK_ALERTS_SECRET: 'sec' }, 3912), b2 = 'http://localhost:3912';
  ok(await waitUp(b2), 'server with passcode starts');
  ok((await fetch(b2 + '/api/status')).status === 401, 'API locked without passcode');
  ok((await fetch(b2 + '/api/check-alerts')).status === 403, 'check-alerts needs its secret');
  ok((await fetch(b2 + '/healthz')).ok, '/healthz stays public');
  const bad = await fetch(b2 + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: 'nope' }) }); ok(bad.status === 401, 'wrong passcode rejected');
  const good = await fetch(b2 + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: 'test-pass-123' }) });
  ok(good.ok, 'right passcode accepted');
  const cookie = (good.headers.get('set-cookie') || '').split(';')[0];
  ok((await fetch(b2 + '/api/status', { headers: { cookie } })).ok, 'cookie unlocks the API');
  let last = 0; for (let i = 0; i < 12; i++) { last = (await fetch(b2 + '/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: 'x' }) })).status; }
  ok(last === 429, 'repeated wrong passcodes are rate limited');
  s2.kill();
  console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nAll checks passed'); process.exit(fails ? 1 : 0);
})();
