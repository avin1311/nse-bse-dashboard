// Quick automated checks — run with:  npm test
// Starts the server locally (no network/tokens needed) and verifies the basics still work.
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

// 1. the page's scripts must parse, and the pattern engine must run
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((m, i) => { let e = null; try { new Function(m[1]); } catch (x) { e = x; } ok(!e, 'inline script #' + i + ' parses' + (e ? ': ' + e.message : '')); });
ok(/id="viewTabs"/.test(html) && (html.match(/class="vtab-pane"/g) || []).length === 6, 'six tab panes present');
{
  const i = html.indexOf('const PatternEngine'), j = html.indexOf('CHART PATTERNS SECTION');
  const E = new Function(html.slice(i, j).replace(/\/\*\s*=+\s*$/, '') + '\nreturn PatternEngine;')();
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  let p = 500; const C = []; for (let k = 0; k < 400; k++) { const o = p; p *= 1 + (rnd() - 0.48) * 0.03; C.push({ t: 1.6e9 + k * 86400, o, h: Math.max(o, p) * 1.004, l: Math.min(o, p) * 0.996, c: p, v: 1e6 }); }
  const r = E.detect(C); ok(Array.isArray(r.patterns), 'pattern engine runs (' + r.patterns.length + ' patterns on random data)');
  const w = E.walk(C, { step: 8 }); ok(Array.isArray(w), 'walk-forward backtest runs (' + w.length + ' signals)');
}

// 2. server behaviour
function start(env, port) { return spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), ...env }, stdio: 'ignore' }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitUp(base) { for (let i = 0; i < 40; i++) { try { const r = await fetch(base + '/healthz'); if (r.ok) return true; } catch (e) {} await sleep(250); } return false; }
(async () => {
  const s1 = start({ DASHBOARD_PASSCODE: '', CHECK_ALERTS_SECRET: '' }, 3911), b1 = 'http://localhost:3911';
  ok(await waitUp(b1), 'server starts');
  ok((await (await fetch(b1 + '/healthz')).text()) === 'ok', '/healthz answers ok');
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
