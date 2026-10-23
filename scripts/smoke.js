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
{ let okk = false, msg = ''; try { const E = require('../engines').load(), St = require('../agstudy'); let sd = 7; const C = []; let p = 1000; for (let i = 0; i < 400; i++) { sd = (sd * 1664525 + 1013904223) % 4294967296; const o = p; p *= 1 + ((sd / 4294967296) - 0.5) * 0.04; C.push({ t: 1700000000 + i * 86400, o, h: Math.max(o, p) * 1.003, l: Math.min(o, p) * 0.997, c: p, v: 1e5 }); }
  const sg = St.study(E, 'X', C, 0.2), A = St.aggregate(sg, 1); okk = Array.isArray(sg) && A.rows.length === St.VARIANTS.length && A.selection && A.selection.now && sg.every(x => Object.keys(x.r).length === St.VARIANTS.length); msg = ' (' + sg.length + ' signals)'; } catch (e) { msg = ': ' + e.message; }
  ok(okk, 'agreement exit study runs on synthetic data' + msg); }
{ let okk = false, msg = ''; try { const E = require('../engines').load(), St = require('../agstudy'); let sd = 11; const C = []; let p = 1000; for (let i = 0; i < 400; i++) { sd = (sd * 1664525 + 1013904223) % 4294967296; const o = p; p *= 1 + ((sd / 4294967296) - 0.5) * 0.04; C.push({ t: 1700000000 + i * 86400, o, h: Math.max(o, p) * 1.003, l: Math.min(o, p) * 0.997, c: p, v: 1e5 }); }
  const r = St.targetStudy(E, 'X', C, 0.15), A = St.aggregateTargets(r, 1); okk = r.length > 0 && A.rows.some(x => x.group === 'base' && x.n >= 30 && x.hitT + x.hitS + x.neither >= 99); msg = ' (' + r.length + ' records)'; } catch (e) { msg = ': ' + e.message; }
  ok(okk, 'target study runs on synthetic data' + msg); }
{ const C = require('../calls.js'); const mk = (t, o, h, l, c) => ({ t, o, h, l, c, v: 1 });
  const buy = C.track({ side: 'BUY', mode: 'swing', entry: 100, sl: 90, targets: [110, 120], t: 1000 }, [mk(2000, 100, 111, 99, 108), mk(3000, 108, 109, 94, 96)], 4000);
  const sell = C.track({ side: 'SELL', mode: 'intraday', entry: 200, sl: 210, targets: [190, 180], t: 1000 }, [mk(2000, 200, 201, 189, 192), mk(3000, 192, 201, 191, 199)], 4000);
  ok(buy.closed && buy.status === 'BREAKEVEN' && buy.exit === 100.15 && Math.abs(buy.pnlPct) < 0.02 && sell.status === 'BREAKEVEN' && sell.exit === 199.8 && Math.abs(sell.pnlPct) < 0.02, 'after T1 the stop sits at entry plus costs and a stop-out there nets about zero'); }
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
  { // gap and go + range fade: signals fire on built-up days, levels are ordered, fade refuses trending index days
    let sd = 11; const rn = () => (sd = (sd * 16807) % 2147483647) / 2147483647, D0 = Date.UTC(2026, 5, 1) / 1000 - 19800;
    const mk = (nd, gen) => { const bars = []; let prev = 100; for (let d = 0; d < nd; d++) { const dow = new Date((D0 + d * 86400 + 19800) * 1000).getUTCDay(); if (dow === 0 || dow === 6) continue; const st = {}; let last = prev;
      for (let i = 0; i < 25; i++) { const b = gen(d, i, prev, st, last); b.t = D0 + d * 86400 + 9 * 3600 + 900 + i * 900; bars.push(b); last = b.c; } prev = last; } return bars; };
    const nz = (x, k) => x * (1 + (rn() - 0.5) * k);
    const gb = mk(60, (d, i, prev, st, last) => { if (i === 0) { st.g = d % 3 === 0 ? 1.012 : 1; st.dr = d % 3 === 0 ? 0.0006 : 0; const o = prev * st.g, c = nz(o, 0.002); return { o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, v: 3e5 }; }
      const o = last, c = nz(last * (1 + st.dr), 0.004); return { o, h: Math.max(o, c) * 1.0015, l: Math.min(o, c) * 0.9985, c, v: 1e5 * (0.6 + rn()) }; });
    const cb = mk(80, (d, i, prev, st, last) => { const w = Math.sin(i / 2.3 + d) * 0.006 + (rn() - 0.5) * 0.003, c = prev * (1 + w), o = i ? last : prev; return { o, h: Math.max(o, c) * (1 + rn() * 0.0015), l: Math.min(o, c) * (1 - rn() * 0.0015), c, v: 1e5 * (0.6 + rn()) }; });
    const lv = (ev) => { const g = ev.side === 'BUY' ? 1 : -1; return g * (ev.entry - ev.sl) > 0 && ev.targets.every((x, i) => g * (x - ev.entry) > 0 && (!i || g * (x - ev.targets[i - 1]) > 0)); };
    const PG = C.prep(gb), PC = C.prep(cb); let ng = 0, bg = 0, nf = 0, bf = 0;
    for (let n = 60; n < gb.length - 1; n++) { const e = C.evalGapGo(PG, n, { gapK: 0.5, entry: 'brk', stopK: 1, exitI: 'A' }); if (e) { ng++; if (!lv(e)) bg++; } }
    for (let n = 60; n < cb.length - 1; n++) { const e = C.evalFade(PC, n, { idxTodayPct: 0.1, edge: 0.25, rsiHi: 60, stopK: 0.3, tgt: 'near' }); if (e) { nf++; if (!lv(e)) bf++; } }
    ok(ng > 0 && bg === 0, 'gap and go: ' + ng + ' signals on gap days, levels ordered');
    ok(nf > 0 && bf === 0, 'range fade: ' + nf + ' signals on choppy days, levels ordered');
    ok(C.evalFade(PC, 100, { idxTodayPct: 1.2, edge: 0.25, rsiHi: 60 }) === null, 'range fade refuses a trending index day');
    ok(C.LAB_GRID.stock_gapgo.length > 0 && C.LAB_GRID.stock_fade.length > 0, 'lab grids include gap and go and range fade');
  }
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
  { const post = b => fetch(b1 + '/api/prefs/ticker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); const g0 = await (await fetch(b1 + '/api/prefs/ticker')).json();
    await post({ order: ['b', 'a'], hidden: ['c'] }); const g1 = await (await fetch(b1 + '/api/prefs/ticker')).json(); const bad = await post({ order: 'x' }); await post({ reset: true }); const g2 = await (await fetch(b1 + '/api/prefs/ticker')).json();
    ok(g0 && g1.pref && g1.pref.order.join() === 'b,a' && g1.pref.hidden.join() === 'c' && bad.status === 400 && g2.pref === null, 'index bar order is saved on the server and can be reset'); }
  { const r = await (await fetch(b1 + '/api/calls/readiness')).json(); ok(r && Array.isArray(r.checks) && r.checks.length === 6 && typeof r.verdict === 'string', '/api/calls/readiness responds (' + (r && r.verdict) + ')'); }
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
