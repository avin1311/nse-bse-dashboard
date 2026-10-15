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
function evaluateV2(bars, mode, opts = {}) {
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
  const V2 = !opts.legacy;
  // v2: prefer pullbacks inside a trend over extended breakouts. A "rejection" is a recent poke at the
  // 20 EMA that failed (price back below/above the 5 EMA and the prior close).
  const hi3 = Math.max(...h.slice(n - 3, n + 1)), lo3 = Math.min(...l.slice(n - 3, n + 1));
  const rejSell = hi3 >= e20[n] * 0.995 && px < e5[n] && px < c[n - 1];
  const rejBuy = lo3 <= e20[n] * 1.005 && px > e5[n] && px > c[n - 1];
  const extended = Math.abs(px - e20[n]) / A[n] > 1.6;
  const sides = {
    BUY: {
      ema: px > e5[n] && e5[n] > e20[n],
      trend: px > e50[n] && e20[n] >= e20[n - 3],
      st: ST.dir[n] === 1,
      stoch: S.k[n] > S.d[n] && S.k[n] < 90,
      rsi: V2 ? (R[n] >= 48 && R[n] <= 66) : (R[n] >= 55 && R[n] <= 72),
      vol: (volOk && px >= hi20 * 0.995) || (V2 && volOk && rejBuy), // breakout on volume, or a volume-backed pullback bounce
    },
    SELL: {
      ema: px < e5[n] && e5[n] < e20[n],
      trend: px < e50[n] && e20[n] <= e20[n - 3],
      st: ST.dir[n] === -1,
      stoch: S.k[n] < S.d[n] && S.k[n] > 10,
      rsi: V2 ? (R[n] <= 52 && R[n] >= 34) : (R[n] <= 45 && R[n] >= 28),
      vol: (volOk && px <= lo20 * 1.005) || (V2 && volOk && rejSell),
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
  if (V2) {
    if (extended) return null; // already stretched away from the 20 EMA: the move has been made, risk of snap-back
    // never trade against the market's own trend / today's direction (opts.bias comes from the index)
    if (opts.bias === 'BULL' && best.side === 'SELL') return null;
    if (opts.bias === 'BEAR' && best.side === 'BUY') return null;
  }
  }
  // never chase an exhausted move: a short at RSI<25 (or long at >78) is a bounce waiting to happen
  if (!bounce && ((best.side === 'SELL' && R[n] < 25) || (best.side === 'BUY' && R[n] > 78))) return null;

  const side = best.side, sgn = side === 'BUY' ? 1 : -1, a = A[n];
  const stopMult = V2 ? (mode === 'intraday' ? 1.8 : 2.0) : 1.5;
  let stopDist = stopMult * a;
  // structure: stay beyond the recent swing low/high if that is further, capped
  const look = mode === 'intraday' ? 8 : 10;
  const swing = side === 'BUY' ? Math.min(...l.slice(n - look, n + 1)) : Math.max(...h.slice(n - look, n + 1));
  const structDist = Math.abs(px - swing) + 0.25 * a;
  stopDist = Math.min(Math.max(stopDist, Math.min(structDist, (V2 ? 2.8 : 2.2) * a)), (mode === 'intraday' ? 0.025 : (V2 ? 0.075 : 0.06)) * px);
  stopDist = Math.max(stopDist, 0.004 * px);
  const entry = tick(px), sl = tick(entry - sgn * stopDist);
  const rr = V2 ? (mode === 'intraday' ? [1, 1.8, 2.8] : [1, 2, 3]) : (bounce ? [1.2, 2, 3] : mode === 'intraday' ? [1.2, 2, 3] : [1.5, 2.5, 4]);
  const targets = rr.map(m => tick(entry + sgn * stopDist * m));
  const risk = stopDist / px * 100;
  const lim = mode === 'intraday' ? (V2 ? [0.9, 1.8] : [0.8, 1.6]) : (V2 ? [3, 5.5] : [2.5, 4.5]); // % stop distance bands
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
const COST = { intraday: Number(process.env.COST_INTRADAY_PCT) || 0.10, swing: Number(process.env.COST_SWING_PCT) || 0.15 }; // round-trip % (brokerage, charges, slippage)
function costPct(mode) { return COST[mode] != null ? COST[mode] : COST.swing; }
function track(call, bars, nowSec) {
  const sgn = call.side === 'BUY' ? 1 : -1;
  let sl = call.sl, hit = 0, status = 'ACTIVE', exit = null, exitT = null, last = call.entry;
  const limitT = call.limitT || (call.mode === 'intraday' ? istDayEnd(call.t) : call.t + 30 * 86400);
  let j = upto(bars, call.t) + 1; const start = j;
  for (; j < bars.length; j++) {
    const b = bars[j];
    if (b.t > limitT) { status = 'EXPIRED'; exit = last; exitT = limitT; break; }
    const stopHit = sgn === 1 ? b.l <= sl : b.h >= sl;
    if (stopHit) { status = hit >= 1 && sl === call.entry ? 'BREAKEVEN' : (hit >= 1 ? 'PROFIT' : 'SL_HIT'); exit = sl; exitT = b.t; break; }
    for (let i = hit; i < call.targets.length; i++) {
      const tHit = sgn === 1 ? b.h >= call.targets[i] : b.l <= call.targets[i];
      if (!tHit) break;
      hit = i + 1; if (hit === 1) sl = call.entry; else if (hit === 2) sl = call.targets[0]; // trail: entry after T1, T1 after T2
      if (hit === call.targets.length) { status = 'TARGET_HIT'; exit = call.targets[i]; exitT = b.t; }
    }
    last = b.c;
    if (status !== 'ACTIVE') break;
  }
  if (status === 'ACTIVE' && nowSec > limitT) { status = 'EXPIRED'; exit = last; exitT = limitT; }
  const ltp = bars.length > start ? bars[bars.length - 1].c : call.entry;
  const closed = status !== 'ACTIVE';
  const px = closed ? exit : ltp;
  const gross = sgn * (px - call.entry) / call.entry * 100;
  const cost = call.costPct != null ? call.costPct : costPct(call.mode);
  return { status, targetsHit: hit, activeSl: sl, ltp: r2(ltp), exit: closed ? r2(exit) : null, exitT, pnlPct: r2(gross - cost), grossPct: r2(gross), costPct: cost, closed };
}
// 15:30 IST of the day containing epoch seconds t
function istDayEnd(t) { const d = new Date((t + 19800) * 1000); const mid = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000 - 19800; return mid + 15 * 3600 + 30 * 60; }

function summarize(calls) {
  const done = calls.filter(c => c.closed);
  const wins = done.filter(c => c.pnlPct > 0.05 && c.status !== 'BREAKEVEN'), loss = done.filter(c => c.pnlPct < -0.05 && c.status !== 'BREAKEVEN');
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


// Market bias from index daily bars: BULL / BEAR / MIXED. Used as a gate so calls never fight the index.
function marketBias(idxBars) {
  if (!idxBars || idxBars.length < 60) return 'MIXED';
  const c = idxBars.map(b => b.c), h = idxBars.map(b => b.h), l = idxBars.map(b => b.l), n = c.length - 1;
  const e20 = ema(c, 20), e50 = ema(c, 50), st = supertrend(h, l, c);
  const up = (c[n] > e50[n] ? 1 : 0) + (e20[n] > e50[n] ? 1 : 0) + (st.dir[n] === 1 ? 1 : 0);
  return up === 3 ? 'BULL' : up === 0 ? 'BEAR' : 'MIXED';
}


// Indicators computed once over a whole series, so backtests and the strategy lab can evaluate every bar cheaply.
function prep(bars) {
  const c = bars.map(b => b.c), h = bars.map(b => b.h), l = bars.map(b => b.l), v = bars.map(b => b.v || 0), o = bars.map(b => b.o != null ? b.o : b.c);
  // session VWAP, first bar of the IST day, and the previous day's high / low (meaningful on intraday bars)
  const vwap = [], dayFirst = [], pdh = [], pdl = [];
  let day = null, first = 0, pv = 0, vv = 0, curH = -Infinity, curL = Infinity, prevH = null, prevL = null;
  for (let i = 0; i < bars.length; i++) {
    const d = Math.floor((bars[i].t + 19800) / 86400);
    if (d !== day) { if (day !== null) { prevH = curH; prevL = curL; } day = d; first = i; pv = 0; vv = 0; curH = -Infinity; curL = Infinity; }
    pv += (h[i] + l[i] + c[i]) / 3 * v[i]; vv += v[i];
    vwap.push(vv > 0 ? pv / vv : null); dayFirst.push(first); pdh.push(prevH); pdl.push(prevL);
    curH = Math.max(curH, h[i]); curL = Math.min(curL, l[i]);
  }
  return { bars, c, h, l, v, o, vwap, dayFirst, pdh, pdl, e5: ema(c, 5), e20: ema(c, 20), e50: ema(c, 50), e100: ema(c, 100), e200: ema(c, 200), R: rsi(c), A: atr(h, l, c), S: stoch(h, l, c), ST: supertrend(h, l, c) };
}
// Market breadth: % of universe stocks closing above their 50-day EMA, per IST trading day (dayNo -> pct).
function breadthSeries(barsBySym) {
  const cnt = new Map();
  for (const bars of Object.values(barsBySym || {})) {
    if (!bars || bars.length < 60) continue;
    const c = bars.map(b => b.c), e = ema(c, 50);
    for (let i = 50; i < bars.length; i++) { const d = Math.floor((bars[i].t + 19800) / 86400), x = cnt.get(d) || [0, 0]; x[1]++; if (c[i] > e[i]) x[0]++; cnt.set(d, x); }
  }
  const out = new Map(); for (const [d, [a, t]] of cnt) if (t >= 20) out.set(d, Math.round(a / t * 1000) / 10);
  return out;
}
function breadthAt(map, t, prevDayOnly) { // breadth of the day of t (swing, signal at the close) or of the last day before it (intraday)
  if (!map || !map.size) return null;
  let d = Math.floor((t + 19800) / 86400) - (prevDayOnly ? 1 : 0);
  for (let k = 0; k < 7; k++, d--) if (map.has(d)) return map.get(d);
  return null;
}
// regime param: 'any' | 'b50' | 'b60'. Buys need breadth >= threshold, sells need breadth <= 100 - threshold.
function regimeOk(side, pct, regime) {
  if (!regime || regime === 'any' || pct == null) return true;
  const thr = regime === 'b60' ? 60 : 50;
  return side === 'BUY' ? pct >= thr : pct <= 100 - thr;
}
// "Index must agree" (stock intraday): buys only while Nifty is up on the day, sells only while it is down.
function idxAgreeOk(side, todayPct, on) { if (!on) return true; if (todayPct == null) return false; return side === 'BUY' ? todayPct > 0 : todayPct < 0; }
const biasCache = new WeakMap();
function biasSeries(bars) { // the market-bias rule of marketBias(), for every bar of a daily index series
  if (!bars || !bars.length) return [];
  if (biasCache.has(bars)) return biasCache.get(bars);
  const c = bars.map(b => b.c), h = bars.map(b => b.h), l = bars.map(b => b.l), e20 = ema(c, 20), e50 = ema(c, 50), st = supertrend(h, l, c);
  const out = c.map((_, i) => { if (i < 59) return 'MIXED'; const up = (c[i] > e50[i] ? 1 : 0) + (e20[i] > e50[i] ? 1 : 0) + (st.dir[i] === 1 ? 1 : 0); return up === 3 ? 'BULL' : up === 0 ? 'BEAR' : 'MIXED'; });
  biasCache.set(bars, out); return out;
}

// ---------------------------------------------------------------------------------------------
// Engine v3. Six checks from different families (so the score is real evidence, not one signal
// counted five times): trend, pullback entry, momentum, strength vs the index, participation, market.
// ---------------------------------------------------------------------------------------------
const EXITS = { S: [0.8, 1.6, 2.4], A: [1, 2, 3], B: [1.5, 3, 4.5], C: [2, 4, 6] };
function upto(arr, t) { // index of last element with .t <= t, or -1
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
const istDayNo = t => Math.floor((t + 19800) / 86400);
// Move of an intraday series on the day of t, using only bars up to t: { pct vs the previous day's last close, aboveOpen }
function dayMove(I, t) {
  if (!I || !I.length) return null;
  const k = upto(I, t); if (k < 0) return null;
  const day = istDayNo(I[k].t); let j = k; while (j > 0 && istDayNo(I[j].t) === day) j--;
  if (istDayNo(I[j].t) === day || !(I[j].c > 0)) return null;
  const open = I[j + 1].o != null ? I[j + 1].o : I[j + 1].c;
  return { pct: (I[k].c / I[j].c - 1) * 100, aboveOpen: I[k].c >= open };
}
// Market type of a day, known at signal time: 'up' / 'down' / 'flat' (index move so far today, or the daily trend for multi-day)
const DT_PCT = 0.4;
function dtOf(pct) { return pct == null ? null : pct >= DT_PCT ? 'up' : pct <= -DT_PCT ? 'down' : 'flat'; }
function biasDt(bias) { return bias === 'BULL' ? 'up' : bias === 'BEAR' ? 'down' : 'flat'; }
// Agreement with the market: 'none' | 'index' (Nifty today) | 'sector' (the stock's sector index today)
function agreeOk(side, agree, idxPct, secPct) {
  if (!agree || agree === 'none') return true;
  const p = agree === 'sector' ? secPct : idxPct; if (p == null) return false;
  return side === 'BUY' ? p > 0 : p < 0;
}
// Safety block: never sell a stock while its sector is up 0.7%+ and holding above its open (mirror for buys)
const SAFETY_PCT = 0.7;
function safetyOk(side, secPct, aboveOpen) {
  if (secPct == null) return true;
  if (side === 'SELL') return !(secPct >= SAFETY_PCT && aboveOpen);
  return !(secPct <= -SAFETY_PCT && aboveOpen === false);
}
function slotVolRatio(bars, n) { // volume vs the same 15-minute slot on previous days
  const slot = Math.floor(((bars[n].t + 19800) % 86400) / 900), day = istDayNo(bars[n].t);
  const prev = [];
  for (let i = n - 1; i >= 0 && prev.length < 10; i--) if (istDayNo(bars[i].t) !== day && Math.floor(((bars[i].t + 19800) % 86400) / 900) === slot) prev.push(bars[i].v || 0);
  if (prev.length < 4) return null;
  const avg = prev.reduce((a, b) => a + b, 0) / prev.length;
  return avg > 0 ? (bars[n].v || 0) / avg : null;
}
function evaluate(bars, mode, opts = {}) {
  if (opts.engine === 'v2') return evaluateV2(bars, mode, opts);
  if (!bars || bars.length < 60) return null;
  return evalAt(prep(bars), bars.length - 1, mode, opts);
}
// opts: bias, idxBars / idxTodayPct, exit (swing targets), exitI (intraday targets), minScore (default 5), stopK (stop size factor), side (restrict)
const SWING_SELL = process.env.CALLS_SWING_SELL === 'on'; // stock swing shorts: off (they lost money in every test, and cash-market shorts cannot be held overnight)
function evalAt(P, n, mode, opts = {}) {
  if (n < 60) return null;
  if (opts.setup === 'orbvwap' || opts.setup === 'pdhl') return mode === 'intraday' ? evalBreakIntra(P, n, opts) : null;
  if (opts.setup === 'vwap') return mode === 'intraday' ? evalVwapIntra(P, n, opts) : null;
  if (opts.setup === 'squeeze') return mode === 'swing' ? evalSqueeze(P, n, opts) : null;
  if (mode === 'swing' && opts.side === 'SELL' && !SWING_SELL) return null;
  const intraday = mode === 'intraday', bars = P.bars;
  const { c, h, l, v, e5, e20, e50, R, A, S, ST } = P;
  const px = c[n];
  if (A[n] == null || R[n] == null || S.k[n] == null || S.d[n] == null || ST.dir[n] == null || !R[n - 2]) return null;
  const a = A[n];
  const hi3 = Math.max(...h.slice(n - 3, n + 1)), lo3 = Math.min(...l.slice(n - 3, n + 1));
  const extended = Math.abs(px - e20[n]) / a > 1.6;
  // participation: swing = volume vs 20-day average; intraday = vs the same time slot on earlier days
  let volRatio;
  if (intraday) volRatio = slotVolRatio(bars, n);
  else { let va = 0; for (let j = n - 20; j < n; j++) va += v[j]; va /= 20; volRatio = va > 0 ? v[n] / va : null; }
  const volNeed = intraday ? 1.2 : 1.1;
  // relative strength vs the index
  let rs = null;
  if (intraday) {
    if (opts.idxTodayPct != null) { let k = n; while (k > 0 && istDayNo(bars[k].t) === istDayNo(bars[n].t)) k--; const pc = c[k]; if (pc > 0 && istDayNo(bars[k].t) !== istDayNo(bars[n].t)) rs = (px / pc - 1) * 100 - opts.idxTodayPct; }
  } else if (opts.idxBars && opts.idxBars.length > 30 && n >= 20) {
    const i1 = upto(opts.idxBars, bars[n].t), i0 = upto(opts.idxBars, bars[n - 20].t);
    if (i1 >= 0 && i0 >= 0 && opts.idxBars[i0].c > 0) rs = ((px / c[n - 20] - 1) - (opts.idxBars[i1].c / opts.idxBars[i0].c - 1)) * 100;
  }
  const rsNeed = intraday ? 0.3 : 1.0;
  const bias = opts.bias || 'MIXED';
  const sides = {
    BUY: {
      trend: px > e50[n] && e20[n] > e50[n] && e20[n] >= e20[n - 3] && ST.dir[n] === 1,
      entry: !extended && lo3 <= e20[n] * 1.005 && px > e5[n] && px > c[n - 1],
      mom: R[n] >= 45 && R[n] <= 68 && S.k[n] > S.d[n] && S.k[n] < 88,
      rs: rs != null && rs > rsNeed,
      vol: volRatio != null && volRatio >= volNeed,
      mkt: bias === 'BULL',
    },
    SELL: {
      trend: px < e50[n] && e20[n] < e50[n] && e20[n] <= e20[n - 3] && ST.dir[n] === -1,
      entry: !extended && hi3 >= e20[n] * 0.995 && px < e5[n] && px < c[n - 1],
      mom: R[n] >= 32 && R[n] <= 55 && S.k[n] < S.d[n] && S.k[n] > 12,
      rs: rs != null && rs < -rsNeed,
      vol: volRatio != null && volRatio >= volNeed,
      mkt: bias === 'BEAR',
    },
  };
  let best = null;
  for (const side of ['BUY', 'SELL']) {
    if (opts.side && side !== opts.side) continue;
    if (side === 'SELL' && !intraday && !SWING_SELL) continue;
    const chk = sides[side]; const score = Object.values(chk).filter(Boolean).length;
    if (!best || score > best.score) best = { side, chk, score };
  }
  if (!best) return null;
  let setup = 'trend';
  const trendOk = best.score >= (opts.minScore || 5) && best.chk.trend && best.chk.entry && !(bias === 'BULL' && best.side === 'SELL') && !(bias === 'BEAR' && best.side === 'BUY');
  // counter-trend bounce (swing only), labelled as such
  let bounceCalc = false;
  if (!trendOk) {
    if (intraday || opts.side === 'SELL') return null;
    let va = 0; for (let j = n - 20; j < n; j++) va += v[j]; va /= 20;
    const turnUp = R[n] > R[n - 1] && R[n - 1] > R[n - 2];
    const stochCross = S.k[n] > S.d[n] && S.k[n - 1] <= S.d[n - 1] + 1 && S.k[n] < 45;
    if (R[n - 1] <= 38 && R[n] <= 50 && turnUp && stochCross && px > e5[n] && px > c[n - 1] && c[n - 1] < e20[n - 1] && va > 0 && v[n] >= 1.2 * va && px > Math.max(h[n - 1], h[n - 2]) && bias !== 'BEAR') {
      bounceCalc = true; setup = 'bounce';
      const chk = { trend: false, entry: true, mom: true, rs: rs != null && rs > 0, vol: true, mkt: bias === 'BULL' };
      best = { side: 'BUY', chk, score: Object.values(chk).filter(Boolean).length };
    } else return null;
  }
  const side = best.side, sgn = side === 'BUY' ? 1 : -1;
  const sk = opts.stopK || 1, stopMult = (intraday ? 1.6 : 2.0) * sk;
  const extreme = side === 'BUY' ? lo3 : hi3;
  const structDist = Math.abs(px - extreme) + 0.25 * a;
  let stopDist = Math.max(stopMult * a, Math.min(structDist, (intraday ? 2.4 : 3.0) * sk * a));
  stopDist = Math.min(stopDist, (intraday ? 0.025 : 0.075) * px); stopDist = Math.max(stopDist, 0.004 * px);
  const entry = tick(px), sl = tick(entry - sgn * stopDist);
  const rr = bounceCalc ? [1, 2, 3] : intraday ? (EXITS[opts.exitI] || EXITS.A) : (EXITS[opts.exit] || EXITS.B);
  const targets = rr.map(m => tick(entry + sgn * stopDist * m));
  const risk = stopDist / px * 100, lim = intraday ? [0.9, 1.8] : [3, 5.5];
  let riskLabel = risk < lim[0] ? 'LOW' : risk < lim[1] ? 'MEDIUM' : 'HIGH';
  if (bounceCalc && riskLabel === 'LOW') riskLabel = 'MEDIUM';
  const f = x => r2(x), reasons = [];
  if (bounceCalc) {
    reasons.push(`Counter-trend bounce: RSI turned up from ${f(R[n - 2])} to ${f(R[n])} and Stochastic ${f(S.k[n])}/${f(S.d[n])} just crossed up`);
    reasons.push(`Price ₹${f(px)} reclaimed the 5 EMA (₹${f(e5[n])}) and cleared the last two highs`);
    reasons.push(`Still below the 50 EMA (₹${f(e50[n])}), so this is a short bounce, not a trend change; use the stop`);
  } else {
    reasons.push(side === 'BUY' ? `Uptrend: price ₹${f(px)} above the 50 EMA (₹${f(e50[n])}), 20 EMA above 50 EMA, Supertrend up` : `Downtrend: price ₹${f(px)} below the 50 EMA (₹${f(e50[n])}), 20 EMA below 50 EMA, Supertrend down`);
    reasons.push(side === 'BUY' ? `Pullback to the 20 EMA (₹${f(e20[n])}) held and price turned back up through the 5 EMA` : `Rally to the 20 EMA (₹${f(e20[n])}) failed and price turned back down through the 5 EMA`);
    reasons.push(`RSI ${f(R[n])}, Stochastic ${f(S.k[n])}/${f(S.d[n])}: momentum agrees without being stretched`);
    if (rs != null) reasons.push(`${side === 'BUY' ? 'Stronger' : 'Weaker'} than the index by ${f(Math.abs(rs))}${intraday ? ' points today' : ' points over 20 days'}`);
    if (volRatio != null) reasons.push(`Volume ${f(volRatio)}x ${intraday ? 'the usual for this time of day' : 'the 20-day average'}`);
    reasons.push(`Market backdrop: ${bias === 'MIXED' ? 'mixed (no clear index trend)' : bias === 'BULL' ? 'index in an uptrend' : 'index in a downtrend'}`);
  }
  return {
    side, mode, entry, sl, targets, riskLabel, score: best.score, checks: best.chk, setup, engine: 'v3', rs: rs == null ? null : f(rs),
    riskPct: r2(risk), rr: rr[0], atr: r2(a), analysis: reasons.join('. ') + '.', barTime: bars[n].t,
  };
}

// ---------------------------------------------------------------------------------------------
// Index engine (Nifty / Bank Nifty / Sensex). Produces a SPOT signal; the server turns it into an
// option BUY (CE for up, PE for down). Index spot candles carry no volume, so participation is
// replaced by a bar-range check. Six checks: trend, trigger, momentum, day structure, bigger trend, range.
// Intraday (15m): opening-range breakout or pullback-resume. Multi-day (daily): pullback-resume or 20-day breakout.
// ---------------------------------------------------------------------------------------------
const IDX_COST = Number(process.env.COST_INDEX_SPOT_PCT) || 0.03; // spot-level backtest cost, %
const IDX_HOLD_DAYS = 14;
function evaluateIndex(bars, mode, opts = {}) {
  if (!bars || bars.length < 60) return null;
  return evalIndexAt(prep(bars), bars.length - 1, mode, opts);
}
// opts: bias, minScore (5), needHtf (false), stopK (1), exit ('A'), setups (allowed triggers), side (restrict)
function evalIndexAt(P, n, mode, opts = {}) {
  if (n < 60) return null;
  const intraday = mode === 'intraday', bars = P.bars;
  const { c, h, l, o, e5, e20, e50, e100, e200, R, A, S, ST } = P;
  const px = c[n];
  if (A[n] == null || R[n] == null || S.k[n] == null || S.d[n] == null || ST.dir[n] == null) return null;
  const a = A[n], bias = opts.bias || 'MIXED';
  const rng = h[n] - l[n], body = c[n] - o[n];
  const lo3 = Math.min(...l.slice(n - 3, n + 1)), hi3 = Math.max(...h.slice(n - 3, n + 1));
  const extended = Math.abs(px - e20[n]) / a > (intraday ? 2.2 : 2.0);
  let orHi = null, orLo = null, dayOpen = null, prevClose = null; const tl = { BUY: [], SELL: [] }; // every trigger that fired on this bar, in priority order
  if (intraday) {
    const day = istDayNo(bars[n].t); let k = n; while (k >= 0 && istDayNo(bars[k].t) === day) k--;
    const first = k + 1;
    if (k < 0 || n - first + 1 < 2) return null; // need the opening range (first 15-minute bar) plus at least one more bar
    prevClose = c[k]; dayOpen = o[first];
    orHi = h[first]; orLo = l[first]; // 15-minute opening range
    let above = 0, below = 0; for (let j = first + 1; j < n; j++) { if (c[j] > orHi) above++; if (c[j] < orLo) below++; } // closes between the opening range and the signal bar
    if (px > orHi && above <= 1) tl.BUY.push('orb');
    if (px < orLo && below <= 1) tl.SELL.push('orb');
    if (P.pdh[n] != null && px > P.pdh[n] && c[n - 1] <= P.pdh[n]) tl.BUY.push('pdhl');
    if (P.pdl[n] != null && px < P.pdl[n] && c[n - 1] >= P.pdl[n]) tl.SELL.push('pdhl');
    if (!extended && lo3 <= e20[n] * 1.001 && px > e5[n] && px > c[n - 1]) tl.BUY.push('pullback');
    if (!extended && hi3 >= e20[n] * 0.999 && px < e5[n] && px < c[n - 1]) tl.SELL.push('pullback');
    // trend day: the index is already 0.5%+ away from yesterday's close, has never gone back through the far side of the
    // opening range, and this bar closes at a new closing extreme of the day. Rides strong one-way days in either direction,
    // including relief rallies inside a falling market (which the trend-following setups above cannot take).
    if (n - first >= 2) {
      const move = (px / prevClose - 1) * 100; let lowAfter = Infinity, highAfter = -Infinity, cMax = -Infinity, cMin = Infinity;
      for (let j = first + 1; j <= n; j++) { lowAfter = Math.min(lowAfter, l[j]); highAfter = Math.max(highAfter, h[j]); }
      for (let j = first; j < n; j++) { cMax = Math.max(cMax, c[j]); cMin = Math.min(cMin, c[j]); }
      if (move >= 0.5 && px > orHi && lowAfter >= orLo && px > cMax) tl.BUY.push('trendday');
      if (move <= -0.5 && px < orLo && highAfter <= orHi && px < cMin) tl.SELL.push('trendday');
    }
  } else {
    prevClose = c[n - 1]; dayOpen = o[n];
    const hh = Math.max(...h.slice(n - 20, n)), ll = Math.min(...l.slice(n - 20, n));
    if (px > hh && c[n - 1] <= hh) tl.BUY.push('breakout');
    if (px < ll && c[n - 1] >= ll) tl.SELL.push('breakout');
    if (!extended && lo3 <= e20[n] * 1.003 && px > e5[n] && px > c[n - 1]) tl.BUY.push('pullback');
    if (!extended && hi3 >= e20[n] * 0.997 && px < e5[n] && px < c[n - 1]) tl.SELL.push('pullback');
  }
  const trig = {}; for (const sd of ['BUY', 'SELL']) trig[sd] = tl[sd].find(x => !opts.setups || opts.setups.includes(x)) || null;
  const td = { BUY: trig.BUY === 'trendday', SELL: trig.SELL === 'trendday' };
  const big = n >= 200 ? { BUY: px > e200[n] && e50[n] > e200[n], SELL: px < e200[n] && e50[n] < e200[n] } : { BUY: px > e100[n], SELL: px < e100[n] };
  const strongBar = rng >= 0.7 * a;
  const sides = {
    BUY: {
      // a trend day is judged on today's own structure (above the fast averages, Supertrend up), not on the slower 50 EMA
      trend: td.BUY ? px > e20[n] && e5[n] > e20[n] && ST.dir[n] === 1 : px > e50[n] && e20[n] > e50[n] && e20[n] >= e20[n - 3] && ST.dir[n] === 1,
      trigger: !!trig.BUY,
      mom: td.BUY ? R[n] >= 55 && R[n] <= 85 : R[n] >= 50 && R[n] <= 74 && S.k[n] > S.d[n] && S.k[n] < 92,
      day: px > prevClose && px > dayOpen,
      htf: intraday ? bias === 'BULL' : big.BUY,
      range: strongBar && body > 0 && (c[n] - l[n]) >= 0.6 * rng,
    },
    SELL: {
      trend: td.SELL ? px < e20[n] && e5[n] < e20[n] && ST.dir[n] === -1 : px < e50[n] && e20[n] < e50[n] && e20[n] <= e20[n - 3] && ST.dir[n] === -1,
      trigger: !!trig.SELL,
      mom: td.SELL ? R[n] >= 15 && R[n] <= 45 : R[n] >= 26 && R[n] <= 50 && S.k[n] < S.d[n] && S.k[n] > 8,
      day: px < prevClose && px < dayOpen,
      htf: intraday ? bias === 'BEAR' : big.SELL,
      range: strongBar && body < 0 && (h[n] - c[n]) >= 0.6 * rng,
    },
  };
  let best = null;
  for (const side of ['BUY', 'SELL']) { if (opts.side && side !== opts.side) continue; const chk = sides[side]; const score = Object.values(chk).filter(Boolean).length; if (!best || score > best.score) best = { side, chk, score }; }
  if (!best || !(best.score >= (opts.minScore || 5) && best.chk.trend && best.chk.trigger)) return null;
  if (opts.needHtf && !best.chk.htf) return null;
  const setup = trig[best.side];
  // against the daily trend: blocked unless the lab chose veto:false, and a trend day (the market's own move today) is never blocked
  const against = (bias === 'BULL' && best.side === 'SELL') || (bias === 'BEAR' && best.side === 'BUY');
  if (against && opts.veto !== false && setup !== 'trendday') return null;
  const side = best.side, sgn = side === 'BUY' ? 1 : -1;
  const extreme = side === 'BUY' ? lo3 : hi3;
  let stopDist;
  const sk = opts.stopK || 1;
  if (intraday) { stopDist = Math.max(1.3 * sk * a, Math.min(Math.abs(px - extreme) + 0.2 * a, 2.2 * a)); if (setup === 'orb') stopDist = Math.max(stopDist, Math.min(Math.abs(px - (side === 'BUY' ? orLo : orHi)) * 0.6, 2.4 * a)); stopDist = Math.min(stopDist, 0.006 * px); }
  else { stopDist = Math.max(2 * sk * a, Math.min(Math.abs(px - extreme) + 0.25 * a, 3 * sk * a)); stopDist = Math.min(stopDist, 0.04 * sk * px); }
  stopDist = Math.max(stopDist, 0.002 * px);
  const entry = tick(px), sl = tick(entry - sgn * stopDist);
  const rr = EXITS[opts.exit] || EXITS.A, targets = rr.map(m => tick(entry + sgn * stopDist * m));
  const f = x => r2(x), up = side === 'BUY';
  const why = [];
  why.push(up ? `Uptrend: ${intraday ? '15-minute' : 'daily'} price ${f(px)} above the 50 EMA (${f(e50[n])}), 20 EMA above 50 EMA, Supertrend up` : `Downtrend: ${intraday ? '15-minute' : 'daily'} price ${f(px)} below the 50 EMA (${f(e50[n])}), 20 EMA below 50 EMA, Supertrend down`);
  if (setup === 'orb') why.push(`Opening-range ${up ? 'breakout above' : 'breakdown below'} ${f(up ? orHi : orLo)} (first 15 minutes)`);
  else if (setup === 'trendday') why.push(`Trend day: ${f(Math.abs(px / prevClose - 1) * 100)}% ${up ? 'up' : 'down'} from yesterday's close, never back through the opening range (${f(orLo)}–${f(orHi)}), new closing ${up ? 'high' : 'low'} of the day`);
  else if (setup === 'pdhl') why.push(`Broke the previous day's ${up ? 'high' : 'low'} (${f(up ? P.pdh[n] : P.pdl[n])})`);
  else if (setup === 'breakout') why.push(`Closed ${up ? 'above the 20-day high' : 'below the 20-day low'}, a fresh break`);
  else why.push(up ? `Pullback to the 20 EMA (${f(e20[n])}) held and price turned up through the 5 EMA` : `Rally to the 20 EMA (${f(e20[n])}) failed and price turned down through the 5 EMA`);
  why.push(`RSI ${f(R[n])}, Stochastic ${f(S.k[n])}/${f(S.d[n])} agree`);
  why.push(intraday ? `Day structure: ${up ? 'above' : 'below'} both the previous close (${f(prevClose)}) and today's open (${f(dayOpen)})` : `Bigger trend: ${up ? 'above' : 'below'} the long-term average`);
  why.push(`Signal bar range ${f(rng / a)}x ATR`);
  if (against) why.push(`Note: this is against the index's falling/rising daily trend (${bias === 'BEAR' ? 'down' : 'up'}), so treat it as a shorter, faster trade`);
  return { side, mode, entry, sl, targets, riskLabel: stopDist / px * 100 < (intraday ? 0.35 : 1.6) ? 'LOW' : stopDist / px * 100 < (intraday ? 0.5 : 2.5) ? 'MEDIUM' : 'HIGH',
    score: best.score, checks: best.chk, setup, engine: 'idx1', kind: 'index', rr: 1, riskPct: r2(stopDist / px * 100), atr: r2(a), analysis: why.join('. ') + '.', barTime: bars[n].t };
}
async function walkIndex(sym, bars, opts, yieldFn) {
  const out = [], far = 4e9, intraday = opts.mode === 'intraday'; let freeFrom = 0, cnt = 0, perDay = {};
  if (!bars || bars.length < 120) return out;
  const P = opts._P || prep(bars), daily = opts.dailyBars || [], dBias = biasSeries(intraday ? daily : bars), endMin = opts.endMin || 795;
  for (let i = intraday ? 60 : 210; i < bars.length - 1; i++) {
    const t = bars[i].t;
    if (t < freeFrom) continue;
    if (intraday) { const m = Math.floor(((t + 19800) % 86400) / 60); if (m < 570 || m > endMin) continue; } // bars starting 9:30 to endMin
    if (yieldFn && ++cnt % 200 === 0) await yieldFn();
    let bias = 'MIXED';
    if (intraday) { const dayStart = t - ((t + 19800) % 86400); const k = upto(daily, dayStart - 1); if (k >= 60) bias = dBias[k]; } // daily bars strictly before today
    else bias = dBias[i];
    const ev = evalIndexAt(P, i, intraday ? 'intraday' : 'swing', { ...opts, bias });
    if (!ev || !regimeOk(ev.side, breadthAt(opts.breadth, t, intraday), opts.regime)) continue;
    if (intraday) { const dk = istDayNo(t); if ((perDay[dk] || 0) >= 2) continue; perDay[dk] = (perDay[dk] || 0) + 1; }
    const call = { t: intraday ? t + 899 : t, side: ev.side, mode: ev.mode, entry: ev.entry, sl: ev.sl, targets: ev.targets, costPct: IDX_COST, limitT: intraday ? undefined : t + IDX_HOLD_DAYS * 86400 };
    const st = track(call, bars, far);
    const dt = intraday ? (m => m ? dtOf(m.pct) : null)(dayMove(bars, t)) : biasDt(bias); // intraday: the index's own move so far today
    out.push({ ...tradeOf(sym, call, ev, st, bias), mode: ev.mode, dt });
    freeFrom = st.closed ? (st.exitT || t) + (intraday ? 60 : 86400) : bars[bars.length - 1].t + 1;
  }
  return out;
}


// ---------------------------------------------------------------------------------------------
// EMA 20/50 CROSSOVER (index options, intraday) on 5-minute ('x5') or 15-minute ('x15') bars.
// Price from the index spot; VOLUME from the index's near-month futures (an index itself has no volume).
// Six checks: volume surge on the cross, bigger-timeframe trend, VWAP side, the averages actually separating
// (not a flat market), trend strength (ADX), and a strong candle. Entry on the cross candle or on the first pullback
// to the 20 EMA after it. The lab picks the combination; nothing goes live unless it is proven.
// ---------------------------------------------------------------------------------------------
function prepCross(bars, vols, tf) {
  const c = bars.map(b => b.c), h = bars.map(b => b.h), l = bars.map(b => b.l), o = bars.map(b => b.o != null ? b.o : b.c), n = bars.length;
  const v = bars.map(b => (vols && vols.get(b.t)) || 0), k = tf === '5m' ? 3 : 4; // bigger-timeframe proxy: 15-min (x3) or hourly (x4) 20/50
  const e20 = ema(c, 20), e50 = ema(c, 50), eF = ema(c, 20 * k), eS = ema(c, 50 * k), A = atr(h, l, c);
  // ADX(14), Wilder
  const adx = new Array(n).fill(null); { let tr = 0, pd = 0, md = 0, ax = null, cnt = 0;
    for (let i = 1; i < n; i++) { const up = h[i] - h[i - 1], dn = l[i - 1] - l[i], t = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
      const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
      if (i <= 14) { tr += t; pd += p; md += m; if (i === 14) cnt = 1; continue; }
      tr = tr - tr / 14 + t; pd = pd - pd / 14 + p; md = md - md / 14 + m;
      const pdi = tr ? 100 * pd / tr : 0, mdi = tr ? 100 * md / tr : 0, dx = pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
      ax = ax == null ? dx : (ax * 13 + dx) / 14; adx[i] = ax; } }
  // session VWAP (futures volume) and volume vs the same time slot on the last 10 sessions
  const vwap = [], volR = [], dayFirst = []; let day = null, pv = 0, vv = 0, first = 0; const slots = new Map();
  for (let i = 0; i < n; i++) {
    const d = Math.floor((bars[i].t + 19800) / 86400), slot = Math.floor(((bars[i].t + 19800) % 86400) / 60);
    if (d !== day) { day = d; pv = 0; vv = 0; first = i; }
    const tp = (h[i] + l[i] + c[i]) / 3; pv += tp * v[i]; vv += v[i]; vwap.push(vv > 0 ? pv / vv : null); dayFirst.push(first);
    const hist = slots.get(slot) || []; const avg = hist.length >= 4 ? hist.reduce((a, b) => a + b, 0) / hist.length : null;
    volR.push(avg && v[i] > 0 ? v[i] / avg : null);
    if (v[i] > 0) { hist.push(v[i]); if (hist.length > 10) hist.shift(); slots.set(slot, hist); }
  }
  return { bars, c, h, l, o, v, e20, e50, eF, eS, A, adx, vwap, volR, dayFirst, tf };
}
// opts: side, entry ('cross'|'retest'), volK (0 = volume not required, else minimum volume ratio, mandatory), htf (bigger trend
// required), minScore (of 6), stopK, exit (EXITS key), setup ('x5'|'x15')
function evalCross(X, n, opts = {}) {
  const { bars, c, h, l, o, e20, e50, eF, eS, A, adx, vwap, volR, dayFirst } = X;
  if (n < 60 || A[n] == null) return null;
  const a = A[n], px = c[n], dir = i => Math.sign(e20[i] - e50[i]);
  let crossAt = -1, side = null;
  if (opts.entry === 'retest') { // first pullback to the 20 EMA within 6 bars after a cross, closing back in the trend's direction
    for (let j = n - 1; j >= Math.max(dayFirst[n], n - 6); j--) if (dir(j) !== dir(j - 1) && dir(j) !== 0) { crossAt = j; break; }
    if (crossAt < 0 || dir(n) !== dir(crossAt)) return null;
    const d = dir(n); for (let j = crossAt + 1; j < n; j++) if (d > 0 ? l[j] <= e20[j] : h[j] >= e20[j]) return null; // only the FIRST touch counts
    if (!(d > 0 ? l[n] <= e20[n] * 1.0005 && px > e20[n] && px > o[n] : h[n] >= e20[n] * 0.9995 && px < e20[n] && px < o[n])) return null;
    side = d > 0 ? 'BUY' : 'SELL';
  } else {
    if (dir(n) === dir(n - 1) || dir(n) === 0) return null; crossAt = n; side = dir(n) > 0 ? 'BUY' : 'SELL';
  }
  if (opts.side && side !== opts.side) return null;
  if (n - dayFirst[n] < 1) return null; // never on the day's first candle
  const d = side === 'BUY' ? 1 : -1, rng = Math.max(1e-9, h[n] - l[n]), vr = volR[crossAt] != null ? volR[crossAt] : volR[n];
  const chk = {
    vol: vr != null && vr >= Math.max(1.2, opts.volK || 0),
    htf: d > 0 ? eF[n] > eS[n] && px > eS[n] : eF[n] < eS[n] && px < eS[n],
    vwap: vwap[n] != null && (d > 0 ? px > vwap[n] : px < vwap[n]),
    spread: Math.abs(e20[n] - e50[n]) >= 0.1 * a && (d > 0 ? e20[n] >= e20[n - 2] : e20[n] <= e20[n - 2]),
    adx: adx[n] != null && adx[n] >= 20,
    candle: d > 0 ? px > o[n] && (px - l[n]) / rng >= 0.6 : px < o[n] && (h[n] - px) / rng >= 0.6,
  };
  if (opts.volK && !(vr != null && vr >= opts.volK)) return null; // volume is mandatory when the lab chooses it
  if (opts.htf && !chk.htf) return null;
  const score = Object.values(chk).filter(Boolean).length; if (score < (opts.minScore || 4)) return null;
  // stop: beyond the last 5 candles' extreme (or the 50 EMA), at least 1x ATR x stopK, at most 0.6% of price
  const sk = opts.stopK || 1; let ext = d > 0 ? Math.min(...l.slice(n - 4, n + 1)) : Math.max(...h.slice(n - 4, n + 1));
  let stopDist = Math.max(sk * a, Math.abs(px - ext) + 0.2 * a); stopDist = Math.min(stopDist, 0.006 * px); stopDist = Math.max(stopDist, 0.0015 * px);
  const entry = tick(px), sl = tick(entry - d * stopDist), rr = EXITS[opts.exit] || EXITS.A, targets = rr.map(m => tick(entry + d * stopDist * m));
  const f = x => r2(x), tfw = X.tf === '5m' ? '5-minute' : '15-minute', up = d > 0;
  const why = [`${tfw} 20 EMA crossed ${up ? 'above' : 'below'} the 50 EMA${opts.entry === 'retest' ? ', then price pulled back to the 20 EMA and turned ' + (up ? 'up' : 'down') : ''}`,
    vr != null ? `Volume ${f(vr)}x the usual for this time of day (index futures)` : 'Futures volume not available',
    `Bigger trend (${X.tf === '5m' ? '15-minute' : 'hourly'} 20/50): ${chk.htf ? 'agrees' : 'does not agree'}`, vwap[n] != null ? `${px > vwap[n] ? 'Above' : 'Below'} session VWAP (${f(vwap[n])})` : '',
    adx[n] != null ? `ADX ${f(adx[n])} (${adx[n] >= 20 ? 'trending' : 'weak trend'})` : ''].filter(Boolean);
  return { side, mode: 'intraday', entry, sl, targets, riskLabel: stopDist / px * 100 < 0.35 ? 'LOW' : stopDist / px * 100 < 0.5 ? 'MEDIUM' : 'HIGH', score, checks: chk,
    setup: opts.setup || (X.tf === '5m' ? 'x5' : 'x15'), engine: 'x1', kind: 'index', rr: 1, riskPct: r2(stopDist / px * 100), atr: r2(a), analysis: why.join('. ') + '.', barTime: bars[n].t };
}
async function walkCross(sym, X, opts, yieldFn) {
  const out = [], far = 4e9, bars = X.bars, step = X.tf === '5m' ? 300 : 900; let freeFrom = 0, cnt = 0; const perDay = {};
  for (let i = 60; i < bars.length - 1; i++) {
    const t = bars[i].t; if (t < freeFrom) continue;
    const m = Math.floor(((t + 19800) % 86400) / 60); if (m < 555 || m > (opts.endMin || 840)) continue; // candles starting 9:15 (closing 9:20/9:30) to the cut-off
    if (yieldFn && ++cnt % 400 === 0) await yieldFn();
    const ev = evalCross(X, i, opts); if (!ev) continue;
    const dk = Math.floor((t + 19800) / 86400); if ((perDay[dk] || 0) >= 3) continue; perDay[dk] = (perDay[dk] || 0) + 1;
    const call = { t: t + step - 1, side: ev.side, mode: 'intraday', entry: ev.entry, sl: ev.sl, targets: ev.targets, costPct: IDX_COST };
    const st = track(call, bars, far);
    const dm = dayMove(bars, t);
    out.push({ ...tradeOf(sym, call, ev, st, 'MIXED'), mode: 'intraday', dt: dm ? dtOf(dm.pct) : null });
    freeFrom = st.closed ? (st.exitT || t) + 60 : bars[bars.length - 1].t + 1;
  }
  return out;
}

/** Tracks an option-premium call; if the index spot closes beyond call.spotSl first, the call is closed at that bar's premium. */
function trackOption(call, optBars, spotBars, nowSec) {
  let tInv = null;
  if (call.spotSl != null && spotBars && spotBars.length) {
    for (const b of spotBars) {
      if (b.t <= call.t) continue;
      if (call.dir === 'BUY' ? b.c <= call.spotSl : b.c >= call.spotSl) { tInv = b.t + (call.mode === 'intraday' ? 900 : 0); break; }
    }
  }
  let st = track(call, optBars, nowSec);
  if (tInv != null && (!st.closed || (st.exitT || 0) > tInv)) {
    const part = optBars.filter(b => b.t <= tInv);
    const st2 = track({ ...call, limitT: tInv }, part, tInv + 1);
    st = { ...st2, status: st2.targetsHit >= 1 ? 'PROFIT' : 'SL_HIT', closed: true, exit: st2.exit != null ? st2.exit : st2.ltp, exitT: tInv };
    const gross = (st.exit - call.entry) / call.entry * 100; st.grossPct = r2(gross); st.pnlPct = r2(gross - st.costPct);
  }
  return st;
}


// ---- Stock intraday breakouts. orbvwap: close beyond the first 15-minute range; pdhl: close beyond the previous day's
// high / low. Both must be on the right side of session VWAP (mandatory) and fresh (at most one earlier close beyond).
function evalBreakIntra(P, n, opts = {}) {
  const { bars, c, h, l, o, A, R, vwap, dayFirst, pdh, pdl } = P;
  const a = A[n], vw = vwap[n], first = dayFirst[n];
  if (a == null || R[n] == null || vw == null || n - first < 1 || first < 1) return null;
  const px = c[n], setup = opts.setup, bias = opts.bias || 'MIXED';
  const lvlB = setup === 'orbvwap' ? h[first] : pdh[n], lvlS = setup === 'orbvwap' ? l[first] : pdl[n];
  if (lvlB == null || lvlS == null) return null;
  const from = setup === 'orbvwap' ? first + 1 : first;
  let above = 0, below = 0; for (let j = from; j < n; j++) { if (c[j] > lvlB) above++; if (c[j] < lvlS) below++; }
  const rng = Math.max(1e-9, h[n] - l[n]), volR = slotVolRatio(bars, n), prevClose = c[first - 1], dayOpen = o[first];
  const sides = {
    BUY: { trigger: px > lvlB && above <= 1 && (c[n] - l[n]) / rng >= 0.6, vwap: px > vw, vol: volR != null && volR >= 1.5, mom: R[n] >= 52 && R[n] <= 76, day: px > prevClose && px > dayOpen, mkt: bias === 'BULL' },
    SELL: { trigger: px < lvlS && below <= 1 && (h[n] - c[n]) / rng >= 0.6, vwap: px < vw, vol: volR != null && volR >= 1.5, mom: R[n] >= 24 && R[n] <= 48, day: px < prevClose && px < dayOpen, mkt: bias === 'BEAR' },
  };
  let best = null;
  for (const side of ['BUY', 'SELL']) { if (opts.side && side !== opts.side) continue; const chk = sides[side], score = Object.values(chk).filter(Boolean).length; if (!best || score > best.score) best = { side, chk, score }; }
  if (!best || !best.chk.trigger || !best.chk.vwap || best.score < (opts.minScore || 5)) return null;
  if ((bias === 'BULL' && best.side === 'SELL') || (bias === 'BEAR' && best.side === 'BUY')) return null;
  const side = best.side, sgn = side === 'BUY' ? 1 : -1, sk = opts.stopK || 1;
  const struct = side === 'BUY' ? Math.min(l[n], vw) : Math.max(h[n], vw);
  let stopDist = Math.max(1.2 * sk * a, Math.abs(px - struct) + 0.2 * a); stopDist = Math.min(stopDist, 0.025 * px); stopDist = Math.max(stopDist, 0.004 * px);
  const entry = tick(px), sl = tick(entry - sgn * stopDist), rr = EXITS[opts.exitI] || EXITS.A, targets = rr.map(m => tick(entry + sgn * stopDist * m));
  const risk = stopDist / px * 100, f = x => r2(x), up = side === 'BUY';
  const why = [setup === 'orbvwap' ? `Broke the first 15-minute ${up ? 'high' : 'low'} (${f(up ? lvlB : lvlS)}) and closed near the bar's ${up ? 'high' : 'low'}` : `Broke the previous day's ${up ? 'high' : 'low'} (${f(up ? lvlB : lvlS)}), a fresh break`,
    `${up ? 'Above' : 'Below'} session VWAP (${f(vw)})`, volR != null ? `Volume ${f(volR)}x the usual for this time of day` : 'Volume vs usual not available', `RSI ${f(R[n])}`,
    `Market backdrop: ${bias === 'MIXED' ? 'mixed' : bias === 'BULL' ? 'index up today' : 'index down today'}`];
  return { side, mode: 'intraday', entry, sl, targets, riskLabel: risk < 0.9 ? 'LOW' : risk < 1.8 ? 'MEDIUM' : 'HIGH', score: best.score, checks: best.chk, setup, engine: 'v4', rs: null,
    riskPct: r2(risk), rr: rr[0], atr: r2(a), analysis: why.join('. ') + '.', barTime: bars[n].t };
}
// ---- Stock intraday VWAP rejection / VWAP hold. Built to work in both directions and in any market:
// SELL: a stock already weak on the day (below its open and yesterday's close, mostly below VWAP) bounces up to VWAP and
// is rejected (closes back below it with a red bar). Shorts the failed bounce, not the breakdown: breakdowns in Indian
// stocks often snap back as shorts cover. BUY is the mirror: a stock strong on the day dips to VWAP and holds.
// Six checks: reject (mandatory), day (mandatory), vs Nifty today, Nifty's direction, momentum, volume.
function evalVwapIntra(P, n, opts = {}) {
  const { bars, c, h, l, o, A, R, vwap, dayFirst } = P;
  const a = A[n], vw = vwap[n], first = dayFirst[n];
  if (a == null || R[n] == null || vw == null || first < 1 || n - first < 2) return null;
  const px = c[n], prevClose = c[first - 1], dayOpen = o[first], rng = Math.max(1e-9, h[n] - l[n]);
  const dayPct = (px / prevClose - 1) * 100, idx = opts.idxTodayPct, rs = idx != null ? dayPct - idx : null;
  let below = 0, above = 0; for (let j = first; j < n; j++) { if (vwap[j] == null) continue; if (c[j] < vwap[j]) below++; else if (c[j] > vwap[j]) above++; }
  const tot = Math.max(1, n - first), hi2 = Math.max(h[n], h[n - 1]), lo2 = Math.min(l[n], l[n - 1]), volR = slotVolRatio(bars, n);
  const sides = {
    BUY: { reject: lo2 <= vw * 1.001 && px > vw && c[n] > o[n] && (c[n] - l[n]) / rng >= 0.6 && above / tot >= 0.6,
      day: dayPct >= 0.3 && px > dayOpen, rs: rs != null && rs >= 0.5, mkt: idx != null && idx > 0, mom: R[n] >= 48 && R[n] <= 70, vol: volR != null && volR >= 1.0 },
    SELL: { reject: hi2 >= vw * 0.999 && px < vw && c[n] < o[n] && (h[n] - c[n]) / rng >= 0.6 && below / tot >= 0.6,
      day: dayPct <= -0.3 && px < dayOpen, rs: rs != null && rs <= -0.5, mkt: idx != null && idx < 0, mom: R[n] >= 30 && R[n] <= 52, vol: volR != null && volR >= 1.0 },
  };
  let best = null;
  for (const side of ['BUY', 'SELL']) { if (opts.side && side !== opts.side) continue; const chk = sides[side], score = Object.values(chk).filter(Boolean).length; if (!best || score > best.score) best = { side, chk, score }; }
  if (!best || !best.chk.reject || !best.chk.day || best.score < (opts.minScore || 5)) return null;
  const side = best.side, sgn = side === 'BUY' ? 1 : -1, sk = opts.stopK || 1, up = side === 'BUY';
  let stopDist = Math.max(1.0 * sk * a, (up ? px - lo2 : hi2 - px) + 0.2 * a); stopDist = Math.min(stopDist, 0.025 * px); stopDist = Math.max(stopDist, 0.004 * px);
  const entry = tick(px), sl = tick(entry - sgn * stopDist), rr = EXITS[opts.exitI] || EXITS.A, targets = rr.map(m => tick(entry + sgn * stopDist * m));
  const risk = stopDist / px * 100, f = x => r2(x);
  const why = [up ? `Strong day: ${f(dayPct)}% up and above today's open, mostly above VWAP` : `Weak day: ${f(dayPct)}% down and below today's open, mostly below VWAP`,
    up ? `Dipped to VWAP (${f(vw)}) and held: closed back above it near the bar's high` : `Bounced up to VWAP (${f(vw)}) and was rejected: closed back below it near the bar's low`,
    rs != null ? `${rs >= 0 ? 'Stronger' : 'Weaker'} than Nifty today by ${f(Math.abs(rs))} points` : 'Nifty move today not available',
    idx != null ? `Nifty ${idx >= 0 ? 'up' : 'down'} ${f(Math.abs(idx))}% today` : '', `RSI ${f(R[n])}`, volR != null ? `Volume ${f(volR)}x the usual for this time of day` : ''].filter(Boolean);
  return { side, mode: 'intraday', entry, sl, targets, riskLabel: risk < 0.9 ? 'LOW' : risk < 1.8 ? 'MEDIUM' : 'HIGH', score: best.score, checks: best.chk, setup: 'vwap', engine: 'v4', rs: rs == null ? null : f(rs),
    riskPct: r2(risk), rr: rr[0], atr: r2(a), analysis: why.join('. ') + '.', barTime: bars[n].t };
}
// ---- Stock swing "squeeze" breakout: after an inside day or the narrowest range of 7 days, a close at a fresh 20-day high
// on volume. Buy only.
function evalSqueeze(P, n, opts = {}) {
  const { bars, c, h, l, v, e20, e50, R, A } = P;
  const a = A[n]; if (a == null || R[n] == null || n < 30) return null;
  const px = c[n], bias = opts.bias || 'MIXED';
  if (bias === 'BEAR') return null;
  let hh = -Infinity; for (let j = n - 20; j < n; j++) hh = Math.max(hh, h[j]);
  const r = j => h[j] - l[j]; let nr7 = true; for (let j = n - 7; j < n - 1; j++) if (r(j) < r(n - 1)) { nr7 = false; break; }
  const inside = h[n - 1] <= h[n - 2] && l[n - 1] >= l[n - 2];
  let va = 0; for (let j = n - 20; j < n; j++) va += v[j]; va /= 20;
  const rng = Math.max(1e-9, r(n));
  let rs = null;
  if (opts.idxBars && opts.idxBars.length > 30) { const i1 = upto(opts.idxBars, bars[n].t), i0 = upto(opts.idxBars, bars[n - 20].t); if (i1 >= 0 && i0 >= 0 && opts.idxBars[i0].c > 0) rs = ((px / c[n - 20] - 1) - (opts.idxBars[i1].c / opts.idxBars[i0].c - 1)) * 100; }
  const chk = { trigger: (inside || nr7) && px > hh && c[n - 1] <= hh && (c[n] - l[n]) / rng >= 0.7, trend: px > e50[n] && e20[n] > e50[n], vol: va > 0 && v[n] >= 1.5 * va, mom: R[n] >= 55 && R[n] <= 78, rs: rs != null && rs > 0, mkt: bias === 'BULL' };
  const score = Object.values(chk).filter(Boolean).length;
  if (!chk.trigger || score < (opts.minScore || 5) || opts.side === 'SELL') return null;
  const sk = opts.stopK || 1, low2 = Math.min(l[n], l[n - 1]);
  let stopDist = Math.max(1.5 * sk * a, px - low2 + 0.2 * a); stopDist = Math.min(stopDist, 0.08 * px); stopDist = Math.max(stopDist, 0.01 * px);
  const entry = tick(px), sl = tick(entry - stopDist), rr = EXITS[opts.exit] || EXITS.B, targets = rr.map(m => tick(entry + stopDist * m));
  const risk = stopDist / px * 100, f = x => r2(x);
  const why = [`${inside ? 'Inside day' : 'Narrowest range of 7 days'} yesterday, then a close at a fresh 20-day high above ${f(hh)}`, `Closed in the top of today's range on ${va > 0 ? f(v[n] / va) + 'x' : '—'} the 20-day volume`,
    chk.trend ? 'Uptrend: above the 50 EMA with the 20 EMA above it' : 'Trend not confirmed by the averages', `RSI ${f(R[n])}`, rs != null ? `${rs > 0 ? 'Stronger' : 'Weaker'} than the index by ${f(Math.abs(rs))} points over 20 days` : ''].filter(Boolean);
  return { side: 'BUY', mode: 'swing', entry, sl, targets, riskLabel: risk < 3 ? 'LOW' : risk < 5.5 ? 'MEDIUM' : 'HIGH', score, checks: chk, setup: 'squeeze', engine: 'v4', rs: rs == null ? null : f(rs),
    riskPct: r2(risk), rr: rr[0], atr: r2(a), analysis: why.join('. ') + '.', barTime: bars[n].t };
}
// ---- backtests (async so a long run yields to the server; yieldFn = () => new Promise(r => setImmediate(r))) ----
function mkAgg(a) {
  const win = x => x.pnlPct > 0.05 && x.status !== 'BREAKEVEN', loss = x => x.pnlPct < -0.05 && x.status !== 'BREAKEVEN';
  const w = a.filter(win), l = a.filter(loss), sum = a.reduce((s, x) => s + x.pnlPct, 0), avg = z => z.length ? z.reduce((s, x) => s + x.pnlPct, 0) / z.length : 0;
  return { n: a.length, wins: w.length, losses: l.length, flat: a.length - w.length - l.length,
    winRate: w.length + l.length ? r2(w.length / (w.length + l.length) * 100) : null, avgPct: a.length ? r2(sum / a.length) : null, totalPct: r2(sum), avgWin: r2(avg(w)), avgLoss: r2(avg(l)) };
}
function tradeOf(sym, call, ev, st, bias) {
  return { sym, t: call.t, side: ev.side, setup: ev.setup || 'trend', risk: ev.riskLabel, status: st.status, pnlPct: st.pnlPct, grossPct: st.grossPct, closed: st.closed, bias, entry: ev.entry, exit: st.exit, exitT: st.exitT, targetsHit: st.targetsHit };
}
async function walkSwing(sym, bars, opts, yieldFn) {
  const out = [], far = 4e9; let freeFrom = 0, cnt = 0;
  if (!bars || bars.length < 120) return out;
  if (opts.engine === 'v2') return walkSwingV2(sym, bars, opts, yieldFn);
  const P = opts._P || prep(bars), idx = opts.idxBars, iBias = idx && opts.useGate !== false ? biasSeries(idx) : null;
  for (let i = 80; i < bars.length - 1; i++) {
    if (bars[i].t < freeFrom) continue;
    if (yieldFn && ++cnt % 200 === 0) await yieldFn();
    let bias = 'MIXED';
    if (iBias) { const k = upto(idx, bars[i].t); if (k >= 0) bias = iBias[k]; }
    const ev = evalAt(P, i, 'swing', { ...opts, bias, idxBars: idx });
    if (!ev || !regimeOk(ev.side, breadthAt(opts.breadth, bars[i].t, false), opts.regime)) continue;
    const call = { t: bars[i].t, side: ev.side, mode: 'swing', entry: ev.entry, sl: ev.sl, targets: ev.targets };
    const st = track(call, bars, far);
    out.push({ ...tradeOf(sym, call, ev, st, bias), dt: biasDt(bias) });
    freeFrom = st.closed ? (st.exitT || bars[i].t) + 5 * 86400 : bars[bars.length - 1].t + 1;
  }
  return out;
}
async function walkSwingV2(sym, bars, opts, yieldFn) { // older engines (comparison rows in the strategy backtest)
  const out = [], far = 4e9; let freeFrom = 0, cnt = 0;
  for (let i = 80; i < bars.length - 1; i++) {
    if (bars[i].t < freeFrom) continue;
    if (yieldFn && ++cnt % 50 === 0) await yieldFn();
    let bias = 'MIXED';
    if (opts.idxBars && opts.useGate !== false) { const k = upto(opts.idxBars, bars[i].t); if (k >= 0) bias = marketBias(opts.idxBars.slice(Math.max(0, k - 120), k + 1)); }
    const ev = evaluate(bars.slice(Math.max(0, i - 260), i + 1), 'swing', { engine: opts.engine, legacy: opts.legacy, minScore: 5, exit: opts.exit, bias, idxBars: opts.idxBars });
    if (!ev) continue;
    const call = { t: bars[i].t, side: ev.side, mode: 'swing', entry: ev.entry, sl: ev.sl, targets: ev.targets };
    const st = track(call, bars, far);
    out.push(tradeOf(sym, call, ev, st, bias));
    freeFrom = st.closed ? (st.exitT || bars[i].t) + 5 * 86400 : bars[bars.length - 1].t + 1;
  }
  return out;
}
async function walkIntraday(sym, bars, opts, yieldFn) {
  const out = [], far = 4e9; let freeFrom = 0, cnt = 0;
  if (!bars || bars.length < 120) return out;
  const P = opts._P || prep(bars), I = opts.idxBars15;
  for (let i = 60; i < bars.length - 1; i++) {
    const t = bars[i].t, mins = Math.floor(((t + 19800) % 86400) / 60);
    if (mins < 555 || mins > 825 || t < freeFrom) continue; // bars that close between 9:30 and 14:00 IST
    if (yieldFn && ++cnt % 200 === 0) await yieldFn();
    let todayPct = null, bias = 'MIXED';
    if (I && opts.useGate !== false) {
      const m = dayMove(I, t);
      if (m) { todayPct = m.pct; bias = todayPct > 0.3 ? 'BULL' : todayPct < -0.3 ? 'BEAR' : 'MIXED'; }
    }
    const ev = evalAt(P, i, 'intraday', { ...opts, bias, idxTodayPct: todayPct });
    if (!ev || !regimeOk(ev.side, breadthAt(opts.breadth, t, true), opts.regime) || !idxAgreeOk(ev.side, todayPct, opts.idxAgree)) continue;
    const sm = dayMove(opts.secBars15 || I, t); // the stock's sector index (Nifty when it has none)
    if (opts.safety === true && sm && !safetyOk(ev.side, sm.pct, sm.aboveOpen)) continue; // the lab normally applies it as a filter instead
    const call = { t: t + 899, side: ev.side, mode: 'intraday', entry: ev.entry, sl: ev.sl, targets: ev.targets };
    const st = track(call, bars, far);
    out.push({ ...tradeOf(sym, call, ev, st, bias), idxPct: todayPct, secPct: sm ? sm.pct : null, secUp: sm ? sm.aboveOpen : null, dt: dtOf(todayPct) });
    freeFrom = st.closed ? (st.exitT || t) + 60 : bars[bars.length - 1].t + 1;
  }
  return out;
}
/** Universe backtest: barsBySym = { SYM: bars }. Returns { trades, summary }. */
async function backtest(barsBySym, opts = {}, yieldFn) {
  let trades = [];
  for (const sym of Object.keys(barsBySym)) trades = trades.concat(await walkSwing(sym, barsBySym[sym], opts, yieldFn));
  return summarizeTrades(trades);
}
// Strategy-lab parameter grids (every combination is replayed; the best on the OLDER half of the data is chosen and
// then judged on the NEWER half it never saw).
function product(spec) { return Object.entries(spec).reduce((acc, [k, vals]) => acc.flatMap(a => vals.map(v => ({ ...a, [k]: v }))), [{}]); }
const LAB_GRID = {
  // veto: true = never trade against the index's daily trend (old behaviour); false = allowed (tested, not assumed)
  index_intraday: product({ veto: [true, false], regime: ['any', 'b50'], minScore: [4, 5, 6], needHtf: [false, true], stopK: [0.75, 1, 1.4], exit: ['S', 'A', 'B'], endMin: [720, 795] }),
  index_swing: product({ regime: ['any', 'b50', 'b60'], minScore: [4, 5, 6], needHtf: [false, true], stopK: [0.75, 1, 1.4], exit: ['S', 'A', 'B'] }),
  stock_swing: product({ regime: ['any', 'b50', 'b60'], setup: ['trend', 'squeeze'], minScore: [4, 5, 6], stopK: [0.75, 1, 1.3], exit: ['A', 'B'] }),
  // trimmed to what earlier runs actually chose (5-6 checks, tighter stops, nearer targets) so the lab fits the server's small CPU
  // 'index must agree' was never chosen in earlier runs, so it is dropped to make room for the VWAP setup (built-in index check)
  // EMA 20/50 crossover on 5- and 15-minute index bars (run once per timeframe; the setup key says which)
  index_cross: product({ entry: ['cross', 'retest'], volK: [0, 1.3, 1.8], htf: [false, true], minScore: [3, 4, 5], stopK: [0.75, 1.25], exit: ['S', 'A'] }),
  // agree: must the stock's side agree with Nifty ('index') or with its sector index ('sector') on the day? Applied as a
  // filter on one replay, so the extra choices cost almost no lab time
  // safety: block sells while the sector is up 0.7%+ above its open (mirror for buys) — tested, not assumed
  stock_intraday: product({ safety: [false, true], agree: ['none', 'index', 'sector'], regime: ['any', 'b50'], setup: ['trend', 'orbvwap', 'pdhl', 'vwap'], minScore: [5, 6], stopK: [0.75, 1], exitI: ['S', 'A'] }),
};
function summarizeTrades(trades) {
  const done = trades.filter(x => x.closed);
  return { trades, all: mkAgg(done), buy: mkAgg(done.filter(x => x.side === 'BUY')), sell: mkAgg(done.filter(x => x.side === 'SELL')), bounce: mkAgg(done.filter(x => x.setup === 'bounce')), open: trades.length - done.length,
    byBias: ['BULL', 'BEAR', 'MIXED'].reduce((o, b) => (o[b] = mkAgg(done.filter(x => x.bias === b)), o), {}) };
}

module.exports = { dayMove, dtOf, biasDt, agreeOk, safetyOk, SAFETY_PCT, DT_PCT, prepCross, evalCross, walkCross, evalVwapIntra, idxAgreeOk, breadthSeries, breadthAt, regimeOk, evalBreakIntra, evalSqueeze, prep, evalAt, evalIndexAt, biasSeries, LAB_GRID, upto, marketBias, backtest, walkSwing, walkIntraday, walkIndex, evaluateIndex, trackOption, IDX_COST, IDX_HOLD_DAYS, mkAgg, summarizeTrades, costPct, EXITS, evaluateV2, regime, ema, rsi, atr, stoch, supertrend, evaluate, track, summarize, istDayEnd };
