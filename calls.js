'use strict';
/*
 * Trade Calls engine (pure functions, no network) — rule-based stock calls
 * in the style of research-desk dashboards: entry, SL, T1..T3, risk label,
 * horizon (intraday / swing), plus an outcome tracker that replays candles.
 *
 * A call is only generated when a fixed checklist passes (>= MIN_SCORE of 6).
 * Nothing here is advice; it is a rule-based screen, logged and measured.
 */

function ema(a, n) { const k = 2 / (n + 1); const o = []; let e = a[0]; for (let i = 0; i < a.length; i++) { e = i === 0 ? a[0] : a[i] * k + e * (1 - k); o.push(e); } return o; }
function rsi(c, n = 14) {
  if (c.length < n + 1) return c.map(() => null);
  const o = c.map(() => null); let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= n; l /= n; o[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  return o;
}
function atr(h, l, c, n = 14) {
  const tr = c.map((_, i) => i === 0 ? h[0] - l[0] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  const o = []; let a = 0;
  for (let i = 0; i < tr.length; i++) { if (i < n) { a += tr[i]; o.push(i === n - 1 ? a / n : null); } else { a = (o[i - 1] * (n - 1) + tr[i]) / n; o.push(a); } }
  return o;
}
function stoch(h, l, c, n = 14, d = 3) {
  const k = c.map((_, i) => { if (i < n - 1) return null; const hh = Math.max(...h.slice(i - n + 1, i + 1)), ll = Math.min(...l.slice(i - n + 1, i + 1)); return hh === ll ? 50 : (c[i] - ll) / (hh - ll) * 100; });
  const sig = k.map((_, i) => { if (i < n - 1 + d - 1) return null; const s = k.slice(i - d + 1, i + 1); return s.reduce((a, b) => a + b, 0) / d; });
  return { k, d: sig };
}
function supertrend(h, l, c, n = 10, m = 3) {
  const a = atr(h, l, c, n); const dir = []; const line = [];
  let fu = null, fl = null, d = 1;
  for (let i = 0; i < c.length; i++) {
    if (a[i] == null) { dir.push(null); line.push(null); continue; }
    const mid = (h[i] + l[i]) / 2; let bu = mid + m * a[i], bl = mid - m * a[i];
    if (fu == null) { fu = bu; fl = bl; d = c[i] >= mid ? 1 : -1; }
    else {
      bu = (bu < fu || c[i - 1] > fu) ? bu : fu;
      bl = (bl > fl || c[i - 1] < fl) ? bl : fl;
      if (d === 1 && c[i] < fl) d = -1; else if (d === -1 && c[i] > fu) d = 1;
      fu = bu; fl = bl;
    }
    dir.push(d); line.push(d === 1 ? fl : fu);
  }
  return { dir, line };
}
const r2 = x => Math.round(x * 100) / 100;
function tick(x) { return Math.round(x * 20) / 20; } // NSE price tick 0.05

/**
 * bars: [{t,o?,h,l,c,v}] oldest -> newest. mode: 'swing' | 'intraday'.
 * Returns a call object or null (no setup), plus the checklist for transparency.
 */
function evaluate(bars, mode, opts = {}) {
  const MIN_SCORE = opts.minScore || 5;
  if (!bars || bars.length < 60) return null;
  const c = bars.map(b => b.c), h = bars.map(b => b.h), l = bars.map(b => b.l), v = bars.map(b => b.v || 0);
  const n = c.length - 1, px = c[n];
  const e5 = ema(c, 5), e20 = ema(c, 20), e50 = ema(c, 50);
  const R = rsi(c), A = atr(h, l, c), S = stoch(h, l, c), ST = supertrend(h, l, c);
  if (A[n] == null || R[n] == null || S.k[n] == null || S.d[n] == null || ST.dir[n] == null) return null;
  const vAvg = v.slice(n - 20, n).reduce((a, b) => a + b, 0) / 20;
  const volOk = vAvg > 0 && v[n] >= 1.2 * vAvg;
  const hi20 = Math.max(...h.slice(n - 20, n)), lo20 = Math.min(...l.slice(n - 20, n));
  const sides = {
    BUY: {
      ema: px > e5[n] && e5[n] > e20[n],
      trend: px > e50[n] && e20[n] >= e20[n - 3],
      st: ST.dir[n] === 1,
      stoch: S.k[n] > S.d[n] && S.k[n] < 90,
      rsi: R[n] >= 55 && R[n] <= 72,
      vol: volOk && px >= hi20 * 0.995, // breakout (or within 0.5%) on volume
    },
    SELL: {
      ema: px < e5[n] && e5[n] < e20[n],
      trend: px < e50[n] && e20[n] <= e20[n - 3],
      st: ST.dir[n] === -1,
      stoch: S.k[n] < S.d[n] && S.k[n] > 10,
      rsi: R[n] <= 45 && R[n] >= 28,
      vol: volOk && px <= lo20 * 1.005,
    },
  };
  let best = null;
  for (const side of ['BUY', 'SELL']) {
    const chk = sides[side]; const score = Object.values(chk).filter(Boolean).length;
    if (!best || score > best.score) best = { side, chk, score };
  }
  // Counter-trend bounce (swing only): oversold stock turning up with volume. Offered only when
  // the trend-following checklist found nothing, and always labelled so it is not mistaken for a trend trade.
  let bounce = false;
  if (mode === 'swing' && !(best.score >= MIN_SCORE && best.chk.st && best.chk.ema)) {
    const turnUp = R[n] > R[n - 1] && R[n - 1] > R[n - 2];
    const stochCross = S.k[n] > S.d[n] && S.k[n - 1] <= S.d[n - 1] + 1 && S.k[n] < 45;
    if (R[n - 1] <= 38 && R[n] <= 50 && turnUp && stochCross && px > e5[n] && px > c[n - 1] && c[n - 1] < e20[n - 1] && volOk && px > Math.max(h[n - 1], h[n - 2])) {
      bounce = true;
      best = { side: 'BUY', chk: { ema: px > e5[n], trend: false, st: ST.dir[n] === 1, stoch: true, rsi: true, vol: true }, score: 5 };
    }
  }
  if (!bounce) {
  if (best.score < MIN_SCORE) return null;
  // trend + supertrend are mandatory: never fight them
  if (!best.chk.st || !best.chk.ema) return null;
  }
  // never chase an exhausted move: a short at RSI<25 (or long at >78) is a bounce waiting to happen
  if (!bounce && ((best.side === 'SELL' && R[n] < 25) || (best.side === 'BUY' && R[n] > 78))) return null;

  const side = best.side, sgn = side === 'BUY' ? 1 : -1, a = A[n];
  const stopMult = mode === 'intraday' ? 1.5 : 1.5;
  let stopDist = stopMult * a;
  // structure: stay beyond the recent swing low/high if that is further, capped
  const look = mode === 'intraday' ? 8 : 10;
  const swing = side === 'BUY' ? Math.min(...l.slice(n - look, n + 1)) : Math.max(...h.slice(n - look, n + 1));
  const structDist = Math.abs(px - swing) + 0.25 * a;
  stopDist = Math.min(Math.max(stopDist, Math.min(structDist, 2.2 * a)), (mode === 'intraday' ? 0.02 : 0.06) * px);
  stopDist = Math.max(stopDist, 0.004 * px);
  const entry = tick(px), sl = tick(entry - sgn * stopDist);
  const rr = bounce ? [1.2, 2, 3] : mode === 'intraday' ? [1.2, 2, 3] : [1.5, 2.5, 4];
  const targets = rr.map(m => tick(entry + sgn * stopDist * m));
  const risk = stopDist / px * 100;
  const lim = mode === 'intraday' ? [0.8, 1.6] : [2.5, 4.5]; // % stop distance bands
  let riskLabel = risk < lim[0] ? 'LOW' : risk < lim[1] ? 'MEDIUM' : 'HIGH';
  if (bounce && riskLabel === 'LOW') riskLabel = 'MEDIUM'; // counter-trend is never "low risk"
  const reasons = [];
  const f = x => r2(x);
  if (bounce) {
    reasons.push(`Counter-trend bounce: RSI turned up from ${f(R[n - 2])} to ${f(R[n])} and Stochastic ${f(S.k[n])}/${f(S.d[n])} just crossed up`);
    reasons.push(`Price ₹${f(px)} reclaimed the 5 EMA (₹${f(e5[n])}) and cleared the last two highs on volume ${f(v[n] / vAvg)}x average`);
    reasons.push(`Still below the 50 EMA (₹${f(e50[n])}), so this is a short bounce, not a trend change; use the stop`);
  } else if (side === 'BUY') {
    reasons.push(`Price ₹${f(px)} is above the 5 EMA (₹${f(e5[n])}) and 20 EMA (₹${f(e20[n])})`);
    reasons.push(`Supertrend supportive near ₹${f(ST.line[n])}`);
    reasons.push(`Stochastic ${f(S.k[n])}/${f(S.d[n])} with the fast line above the signal`);
    reasons.push(`RSI ${f(R[n])} shows strength without being extreme`);
    if (best.chk.vol) reasons.push(`Breakout near the 20-bar high ₹${f(hi20)} on volume ${f(v[n] / vAvg)}x average`);
  } else {
    reasons.push(`Price ₹${f(px)} is below the 5 EMA (₹${f(e5[n])}) and 20 EMA (₹${f(e20[n])})`);
    reasons.push(`Supertrend resistance near ₹${f(ST.line[n])}`);
    reasons.push(`Stochastic ${f(S.k[n])}/${f(S.d[n])} with the fast line below the signal`);
    reasons.push(`RSI ${f(R[n])} shows weakness without being at an extreme`);
    if (best.chk.vol) reasons.push(`Breakdown near the 20-bar low ₹${f(lo20)} on volume ${f(v[n] / vAvg)}x average`);
  }
  return {
    side, mode, entry, sl, targets, riskLabel, score: best.score, checks: best.chk,
    riskPct: r2(risk), rr: rr[0], setup: bounce ? 'bounce' : 'trend', atr: r2(a), analysis: reasons.join('. ') + '.',
    barTime: bars[n].t,
  };
}

/**
 * Replays bars after the call's creation time and returns the call's state.
 * Conservative: if SL and a target sit inside one bar, the SL is assumed first.
 * After T1 the stop trails to entry (breakeven). Intraday calls expire at the
 * close of the day they were made (square-off); swing calls after 30 days.
 */
function track(call, bars, nowSec) {
  const sgn = call.side === 'BUY' ? 1 : -1;
  let sl = call.sl, hit = 0, status = 'ACTIVE', exit = null, exitT = null, last = call.entry;
  const after = bars.filter(b => b.t > call.t);
  const limitT = call.mode === 'intraday' ? istDayEnd(call.t) : call.t + 30 * 86400;
  for (const b of after) {
    if (b.t > limitT) { status = 'EXPIRED'; exit = last; exitT = limitT; break; }
    const stopHit = sgn === 1 ? b.l <= sl : b.h >= sl;
    if (stopHit) { status = hit >= 1 && sl === call.entry ? 'BREAKEVEN' : (hit >= 1 ? 'PROFIT' : 'SL_HIT'); exit = sl; exitT = b.t; break; }
    for (let i = hit; i < call.targets.length; i++) {
      const tHit = sgn === 1 ? b.h >= call.targets[i] : b.l <= call.targets[i];
      if (!tHit) break;
      hit = i + 1; if (hit === 1) sl = call.entry; // trail to entry
      if (hit === call.targets.length) { status = 'TARGET_HIT'; exit = call.targets[i]; exitT = b.t; }
    }
    last = b.c;
    if (status !== 'ACTIVE') break;
  }
  if (status === 'ACTIVE' && nowSec > limitT) { status = 'EXPIRED'; exit = last; exitT = limitT; }
  const ltp = after.length ? after[after.length - 1].c : call.entry;
  const closed = status !== 'ACTIVE';
  const px = closed ? exit : ltp;
  const pnlPct = sgn * (px - call.entry) / call.entry * 100;
  return { status, targetsHit: hit, activeSl: sl, ltp: r2(ltp), exit: closed ? r2(exit) : null, exitT, pnlPct: r2(pnlPct), closed };
}
// 15:30 IST of the day containing epoch seconds t
function istDayEnd(t) { const d = new Date((t + 19800) * 1000); const mid = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000 - 19800; return mid + 15 * 3600 + 30 * 60; }

function summarize(calls) {
  const done = calls.filter(c => c.closed);
  const wins = done.filter(c => c.pnlPct > 0.05), loss = done.filter(c => c.pnlPct < -0.05);
  const avg = a => a.length ? a.reduce((s, c) => s + c.pnlPct, 0) / a.length : 0;
  const decided = wins.length + loss.length;
  return {
    total: calls.length, active: calls.length - done.length, closed: done.length, wins: wins.length, losses: loss.length,
    winRate: decided ? r2(wins.length / decided * 100) : null,
    avgWin: r2(avg(wins)), avgLoss: r2(avg(loss)),
    expectancy: decided ? r2((wins.length * avg(wins) + loss.length * avg(loss)) / decided) : null,
  };
}

// Simple market-regime read of one stock: above its 50 EMA? Supertrend up?
function regime(bars) {
  if (!bars || bars.length < 60) return null;
  const c = bars.map(b => b.c), h = bars.map(b => b.h), l = bars.map(b => b.l), n = c.length - 1;
  const e50 = ema(c, 50), st = supertrend(h, l, c);
  if (st.dir[n] == null) return null;
  return { above50: c[n] > e50[n], stUp: st.dir[n] === 1 };
}

module.exports = { regime, ema, rsi, atr, stoch, supertrend, evaluate, track, summarize, istDayEnd };
