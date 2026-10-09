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
  const after = bars.filter(b => b.t > call.t);
  const limitT = call.mode === 'intraday' ? istDayEnd(call.t) : call.t + 30 * 86400;
  for (const b of after) {
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
  const ltp = after.length ? after[after.length - 1].c : call.entry;
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


// ---------------------------------------------------------------------------------------------
// Engine v3. Six checks from different families (so the score is real evidence, not one signal
// counted five times): trend, pullback entry, momentum, strength vs the index, participation, market.
// ---------------------------------------------------------------------------------------------
const EXITS = { A: [1, 2, 3], B: [1.5, 3, 4.5], C: [2, 4, 6] };
function upto(arr, t) { // index of last element with .t <= t, or -1
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t <= t) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
const istDayNo = t => Math.floor((t + 19800) / 86400);
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
  const intraday = mode === 'intraday';
  const c = bars.map(b => b.c), h = bars.map(b => b.h), l = bars.map(b => b.l), v = bars.map(b => b.v || 0);
  const n = c.length - 1, px = c[n];
  const e5 = ema(c, 5), e20 = ema(c, 20), e50 = ema(c, 50);
  const R = rsi(c), A = atr(h, l, c), S = stoch(h, l, c), ST = supertrend(h, l, c);
  if (A[n] == null || R[n] == null || S.k[n] == null || S.d[n] == null || ST.dir[n] == null || !R[n - 2]) return null;
  const a = A[n];
  const hi3 = Math.max(...h.slice(n - 3, n + 1)), lo3 = Math.min(...l.slice(n - 3, n + 1));
  const extended = Math.abs(px - e20[n]) / a > 1.6;
  // participation: swing = volume vs 20-day average; intraday = vs the same time slot on earlier days
  let volRatio;
  if (intraday) volRatio = slotVolRatio(bars, n);
  else { const va = v.slice(n - 20, n).reduce((x, y) => x + y, 0) / 20; volRatio = va > 0 ? v[n] / va : null; }
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
    const chk = sides[side]; const score = Object.values(chk).filter(Boolean).length;
    if (!best || score > best.score) best = { side, chk, score };
  }
  let setup = 'trend';
  const trendOk = best.score >= 5 && best.chk.trend && best.chk.entry && !(bias === 'BULL' && best.side === 'SELL') && !(bias === 'BEAR' && best.side === 'BUY');
  // counter-trend bounce (swing only), labelled as such
  let bounceCalc = false;
  if (!trendOk) {
    if (intraday) return null;
    const va = v.slice(n - 20, n).reduce((x, y) => x + y, 0) / 20;
    const turnUp = R[n] > R[n - 1] && R[n - 1] > R[n - 2];
    const stochCross = S.k[n] > S.d[n] && S.k[n - 1] <= S.d[n - 1] + 1 && S.k[n] < 45;
    if (R[n - 1] <= 38 && R[n] <= 50 && turnUp && stochCross && px > e5[n] && px > c[n - 1] && c[n - 1] < e20[n - 1] && va > 0 && v[n] >= 1.2 * va && px > Math.max(h[n - 1], h[n - 2]) && bias !== 'BEAR') {
      bounceCalc = true; setup = 'bounce';
      const chk = { trend: false, entry: true, mom: true, rs: rs != null && rs > 0, vol: true, mkt: bias === 'BULL' };
      best = { side: 'BUY', chk, score: Object.values(chk).filter(Boolean).length };
    } else return null;
  }
  const side = best.side, sgn = side === 'BUY' ? 1 : -1;
  const stopMult = intraday ? 1.6 : 2.0;
  const extreme = side === 'BUY' ? lo3 : hi3;
  const structDist = Math.abs(px - extreme) + 0.25 * a;
  let stopDist = Math.max(stopMult * a, Math.min(structDist, (intraday ? 2.4 : 3.0) * a));
  stopDist = Math.min(stopDist, (intraday ? 0.025 : 0.075) * px); stopDist = Math.max(stopDist, 0.004 * px);
  const entry = tick(px), sl = tick(entry - sgn * stopDist);
  const rr = intraday || bounceCalc ? [1, 2, 3] : (EXITS[opts.exit] || EXITS.B);
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
  for (let i = 60; i < bars.length - 1; i++) {
    const t = bars[i].t, mins = Math.floor(((t + 19800) % 86400) / 60);
    if (mins < 600 || mins > 825 || t < freeFrom) continue; // bars that close between 10:15 and 14:00 IST
    if (yieldFn && ++cnt % 50 === 0) await yieldFn();
    let todayPct = null, bias = 'MIXED';
    if (opts.idxBars15 && opts.useGate !== false) {
      const k = upto(opts.idxBars15, t);
      if (k >= 0) { let j = k; while (j > 0 && istDayNo(opts.idxBars15[j].t) === istDayNo(t)) j--; const pc = opts.idxBars15[j].c; if (istDayNo(opts.idxBars15[j].t) !== istDayNo(t) && pc > 0) { todayPct = (opts.idxBars15[k].c / pc - 1) * 100; bias = todayPct > 0.3 ? 'BULL' : todayPct < -0.3 ? 'BEAR' : 'MIXED'; } }
    }
    const ev = evaluate(bars.slice(Math.max(0, i - 300), i + 1), 'intraday', { engine: opts.engine, minScore: 5, bias, idxTodayPct: todayPct });
    if (!ev) continue;
    const call = { t: t + 899, side: ev.side, mode: 'intraday', entry: ev.entry, sl: ev.sl, targets: ev.targets };
    const st = track(call, bars, far);
    out.push(tradeOf(sym, call, ev, st, bias));
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
function summarizeTrades(trades) {
  const done = trades.filter(x => x.closed);
  return { trades, all: mkAgg(done), buy: mkAgg(done.filter(x => x.side === 'BUY')), sell: mkAgg(done.filter(x => x.side === 'SELL')), bounce: mkAgg(done.filter(x => x.setup === 'bounce')), open: trades.length - done.length,
    byBias: ['BULL', 'BEAR', 'MIXED'].reduce((o, b) => (o[b] = mkAgg(done.filter(x => x.bias === b)), o), {}) };
}

module.exports = { marketBias, backtest, walkSwing, walkIntraday, mkAgg, summarizeTrades, costPct, EXITS, evaluateV2, regime, ema, rsi, atr, stoch, supertrend, evaluate, track, summarize, istDayEnd };
