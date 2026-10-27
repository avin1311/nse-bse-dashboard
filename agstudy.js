// Agreement exit study: replays the agreement signal (rule 3|1|atr: stop 1.5x ATR, T1 = 1x risk, T2 = 2x risk = 3x ATR) on each
// F&O stock's daily history and compares exit rules on the SAME signals. Read-only: it never touches calls or the monitor.
const LIM = 21;                         // the live monitor expires a swing item after 30 calendar days (about 21 sessions)
const R_ATR = 1.5;                      // stop distance in ATR
const VARIANTS = [
  { key: 'now',       label: 'Now: T1 then stop to entry, T2 exit, 30 days',        lock: 0,   trail: false, t2: true,  hold: LIM, flip: false },
  { key: 'lock',      label: 'After T1 stop to entry + 0.5 risk, T2 exit',            lock: 0.5, trail: false, t2: true,  hold: LIM, flip: false },
  { key: 'trail',     label: 'After T1 trail 1.5 ATR from best close, no T2',         lock: 0,   trail: true,  t2: false, hold: LIM, flip: false },
  { key: 'trailT2',   label: 'After T1 trail 1.5 ATR from best close, T2 kept',       lock: 0,   trail: true,  t2: true,  hold: LIM, flip: false },
  { key: 'now10',     label: 'Now + exit at day 10',                                  lock: 0,   trail: false, t2: true,  hold: 10,  flip: false },
  { key: 'lock10',    label: 'Lock 0.5 risk + exit at day 10',                        lock: 0.5, trail: false, t2: true,  hold: 10,  flip: false },
  { key: 'nowFlip',   label: 'Now + exit when the agreement flips the other way',     lock: 0,   trail: false, t2: true,  hold: LIM, flip: true },
  { key: 'lockFlip10', label: 'Lock 0.5 risk + flip exit + day 10',                   lock: 0.5, trail: false, t2: true,  hold: 10,  flip: true }
];
function weeklyOf(C) { const W = []; let cur = null; C.forEach(b => { const d = new Date((b.t + 19800) * 1000), wk = Math.floor((d.getTime() / 86400000 + 3) / 7); if (!cur || cur.wk !== wk) { cur = { wk, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }; W.push(cur); } else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v || 0; } cur.last = b.t; }); return W; }
function scoreOf(sig, p, b, w) { const s = /buy/.test(sig || '') ? 1 : /sell/.test(sig || '') ? -1 : 0; let a = s + p + b; if (w && a !== 0 && Math.sign(w) === Math.sign(a)) a += Math.sign(a); return a; }

// agreement score for every session of one stock (the days where neither the screener nor the daily breakout has an opinion are skipped, as in the page's own test)
function scores(E, sym, C, k0, k1) {
  const out = {}, Wk = weeklyOf(C), wkBrk = {};
  const wkDir = k => { const wi = Wk.findIndex(w => w.t <= C[k].t && w.last >= C[k].t); if (wi < 30) return 0; if (wkBrk[wi] != null) return wkBrk[wi]; let d = 0; try { const r = E.xsBreak(Wk.slice(0, wi), 'W'); d = r && r.type === 'break' ? r.d : 0; } catch (e) {} return wkBrk[wi] = d; };
  const cl = C.map(x => x.c), hh = C.map(x => x.h), ll = C.map(x => x.l);
  for (let k = k0; k <= k1; k++) {
    const c = cl.slice(0, k + 1), h = hh.slice(0, k + 1), l = ll.slice(0, k + 1), last = c[k];
    const dd = { symbol: sym, prices: c, histHL: { h, l }, realHistory: true, price: last, support1: Math.min(...l.slice(-20)), resistance1: Math.max(...h.slice(-20)) };
    dd.support2 = dd.support1 * 0.97; dd.resistance2 = dd.resistance1 * 1.03; dd.targetMean = last;
    let hz = null; try { hz = E.buildHorizons(dd).swing; } catch (e) {}
    const sig = hz ? hz.signal : 'hold', s = /buy/.test(sig) ? 1 : /sell/.test(sig) ? -1 : 0;
    let bk = null; try { bk = E.xsBreak(C.slice(0, k + 1), 'D'); } catch (e) {}
    const b = bk && bk.type === 'break' ? bk.d : 0;
    if (Math.abs(s) + Math.abs(b) === 0) continue;
    let pt = null; try { pt = E.xsPattern(C.slice(Math.max(0, k - 319), k + 1), '1D'); } catch (e) {}
    out[k] = { a: scoreOf(sig, pt ? pt.d : 0, b, wkDir(k)), score: hz ? hz.score : 0, pname: pt && pt.d ? pt.name : null, bname: bk && bk.type === 'break' ? bk.name : null };
  }
  return out;
}

function sim(C, k, dir, atr, v, sc, cost) {
  const entry = C[k].c, risk = R_ATR * atr, T1 = entry + dir * risk, T2 = entry + dir * 2 * risk;
  let stop = entry - dir * risk, hit1 = false, best = entry, exit = null, xi = null;
  const end = Math.min(C.length - 1, k + v.hold);
  for (let j = k + 1; j <= end; j++) {
    const b = C[j];
    if (dir > 0 ? b.l <= stop : b.h >= stop) { exit = stop; xi = j; break; }
    if (!hit1 && (dir > 0 ? b.h >= T1 : b.l <= T1)) { hit1 = true; stop = v.trail ? entry : entry + dir * v.lock * risk; }
    if (hit1 && v.t2 && (dir > 0 ? b.h >= T2 : b.l <= T2)) { exit = T2; xi = j; break; }
    if (v.trail && hit1) { best = dir > 0 ? Math.max(best, b.c) : Math.min(best, b.c); const ns = best - dir * risk; if (dir > 0 ? ns > stop : ns < stop) stop = ns; }
    if (v.flip && sc[j] && Math.abs(sc[j].a) >= 3 && Math.sign(sc[j].a) === -dir) { exit = b.c; xi = j; break; }
  }
  if (exit == null) { xi = end; exit = C[end].c; }
  return { ret: dir * (exit - entry) / entry * 100 - cost, hold: xi - k, xi };
}

function study(E, sym, C, cost) {
  const k0 = Math.max(130, C.length - 260), k1 = C.length - 1 - LIM - 1;
  if (C.length < 200 || k1 <= k0) return [];
  const sc = scores(E, sym, C, k0, C.length - 1), free = {}, sigs = [];
  for (let k = k0; k <= k1; k++) {
    const s = sc[k]; if (!s || Math.abs(s.a) < 3) continue;
    let atr = null; try { atr = E.B.atrAt(C, k, 14); } catch (e) {} if (!(atr > 0)) continue;
    const dir = Math.sign(s.a), rec = { sym, t: C[k].t, k, a: s.a, dir, score: s.score || 0, r: {} };
    VARIANTS.forEach(v => { if (free[v.key] != null && k < free[v.key]) { rec.r[v.key] = null; return; } const o = sim(C, k, dir, atr, v, sc, cost); rec.r[v.key] = { ret: o.ret, hold: o.hold }; free[v.key] = o.xi + 1; });
    sigs.push(rec);
  }
  return sigs;
}

function aggregate(all, nStocks) {
  const r2 = x => Math.round(x * 100) / 100, avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const ts = all.map(s => s.t).sort((a, b) => a - b), mid = ts[Math.floor(ts.length / 2)];
  const rows = VARIANTS.map(v => {
    const taken = all.filter(s => s.r[v.key]).map(s => ({ ...s.r[v.key], t: s.t, dir: s.dir, a: s.a }));
    if (!taken.length) return { key: v.key, label: v.label, n: 0 };
    const w = taken.filter(x => x.ret > 0), l = taken.filter(x => x.ret <= 0), grossW = w.reduce((s, x) => s + x.ret, 0), grossL = -l.reduce((s, x) => s + x.ret, 0);
    return { key: v.key, label: v.label, n: taken.length, win: Math.round(w.length / taken.length * 100), avg: r2(avg(taken.map(x => x.ret))), avgWin: r2(avg(w.map(x => x.ret))), avgLoss: r2(avg(l.map(x => x.ret))), pf: grossL > 0 ? r2(grossW / grossL) : null,
      avgHold: r2(avg(taken.map(x => x.hold))), older: r2(avg(taken.filter(x => x.t < mid).map(x => x.ret))), newer: r2(avg(taken.filter(x => x.t >= mid).map(x => x.ret))),
      buyAvg: r2(avg(taken.filter(x => x.dir > 0).map(x => x.ret))), sellAvg: r2(avg(taken.filter(x => x.dir < 0).map(x => x.ret))), nBuy: taken.filter(x => x.dir > 0).length, nSell: taken.filter(x => x.dir < 0).length,
      s3: r2(avg(taken.filter(x => Math.abs(x.a) === 3).map(x => x.ret))), n3: taken.filter(x => Math.abs(x.a) === 3).length, s4: r2(avg(taken.filter(x => Math.abs(x.a) >= 4).map(x => x.ret))), n4: taken.filter(x => Math.abs(x.a) >= 4).length };
  });
  // pile-up: average number of positions open at once if every qualifying signal were taken
  const days = new Set(all.map(s => s.t)); const sess = Math.max(1, ts.length ? Math.round((ts[ts.length - 1] - ts[0]) / 86400 * 5 / 7) : 1);
  rows.forEach(r => { const v = r.key, h = all.filter(s => s.r[v]).reduce((s, x) => s + x.r[v].hold, 0); r.openAtOnce = r2(h / sess); });
  // daily selection: top 10 by strength vs 10 with at most 6 per side vs 10 picked at random, on the 'now' and 'lock' exits
  const byDay = {}; all.forEach(s => { (byDay[s.t] = byDay[s.t] || []).push(s); });
  const rank = (a, b) => Math.abs(b.a) - Math.abs(a.a) || (b.dir * b.score - a.dir * a.score);
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const sel = {};
  ['now', 'lock'].forEach(vk => {
    const P = { top10: [], cap6: [], random10: [], all: [] };
    Object.values(byDay).forEach(list => {
      const c = list.filter(s => s.r[vk]).sort(rank); if (!c.length) return;
      P.all.push(...c.map(s => s.r[vk].ret)); P.top10.push(...c.slice(0, 10).map(s => s.r[vk].ret));
      const cnt = { 1: 0, '-1': 0 }, pick = []; c.forEach(s => { if (pick.length < 10 && cnt[s.dir] < 6) { pick.push(s); cnt[s.dir]++; } }); P.cap6.push(...pick.map(s => s.r[vk].ret));
      const sh = c.slice(); for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; } P.random10.push(...sh.slice(0, 10).map(s => s.r[vk].ret));
    });
    sel[vk] = Object.fromEntries(Object.entries(P).map(([k, a]) => [k, { n: a.length, avg: a.length ? r2(avg(a)) : null }]));
  });
  const d0 = ts.length ? ts[0] : null, d1 = ts.length ? ts[ts.length - 1] : null;
  return { stocks: nStocks, signals: all.length, from: d0, to: d1, signalDays: days.size, rows, selection: sel, note: 'Signals at the daily close; one open trade per stock per exit rule; stop 1.5 ATR; T1 = 1 risk, T2 = 2 risk; same-day stop and target: stop first; costs included.' };
}

// ---- Target study: how often does a stock move +3% / +4% before a 2% / 3% stop within 10 sessions?  Signals (agreement 3+) against a no-signal baseline.
const TG = [3, 4], SP = [2, 3], HOLD = 10;
function outcome(C, k, dir, stopPct, tgtPct, cost) {
  const e = C[k].c, st = e * (1 - dir * stopPct / 100), tg = e * (1 + dir * tgtPct / 100), end = Math.min(C.length - 1, k + HOLD);
  let mfe = 0;
  for (let j = k + 1; j <= end; j++) {
    const b = C[j], fav = dir > 0 ? (b.h - e) / e * 100 : (e - b.l) / e * 100; mfe = Math.max(mfe, fav);
    if (dir > 0 ? b.l <= st : b.h >= st) return { o: 'S', ret: -stopPct - cost, mfe };
    if (dir > 0 ? b.h >= tg : b.l <= tg) return { o: 'T', ret: tgtPct - cost, mfe };
  }
  return { o: 'N', ret: dir * (C[end].c - e) / e * 100 - cost, mfe };
}
function targetStudy(E, sym, C, cost) {
  const k0 = Math.max(130, C.length - 260), k1 = C.length - 1 - HOLD - 1; if (C.length < 200 || k1 <= k0) return [];
  const sc = scores(E, sym, C, k0, k1), recs = [];
  const add = (grp, k, dir, tag) => { SP.forEach(sp => TG.forEach(tg => { const r = outcome(C, k, dir, sp, tg, cost); recs.push({ g: grp, dir, sp, tg, t: C[k].t, o: r.o, ret: r.ret, mfe: r.mfe, tag }); })); };
  for (let k = k0; k <= k1; k++) {
    const s = sc[k];
    if (s && Math.abs(s.a) >= 3) add('signal', k, Math.sign(s.a), (s.bname && /52-week/.test(s.bname) ? '52wk' : s.bname ? 'range' : 'nobreak') + (s.pname ? '+pattern' : ''));
    if ((k - k0) % 5 === 0) { add('base', k, 1, null); add('base', k, -1, null); }
  }
  return recs;
}
function aggregateTargets(all, nStocks) {
  const r2 = x => Math.round(x * 100) / 100, avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const ts = all.map(x => x.t).sort((a, b) => a - b), mid = ts[Math.floor(ts.length / 2)], rows = [], key = {};
  all.forEach(x => { const k = [x.g, x.dir > 0 ? 'BUY' : 'SELL', x.sp, x.tg].join('|'); (key[k] = key[k] || []).push(x); if (x.tag) { const k2 = [x.g + ':' + x.tag, x.dir > 0 ? 'BUY' : 'SELL', x.sp, x.tg].join('|'); (key[k2] = key[k2] || []).push(x); } });
  Object.entries(key).forEach(([k, a]) => { const [g, side, sp, tg] = k.split('|'); if (a.length < 30) return; const T = a.filter(x => x.o === 'T').length, S = a.filter(x => x.o === 'S').length;
    rows.push({ group: g, side, stop: +sp, target: +tg, n: a.length, hitT: Math.round(T / a.length * 100), hitS: Math.round(S / a.length * 100), neither: Math.round((a.length - T - S) / a.length * 100), avg: r2(avg(a.map(x => x.ret))), older: r2(avg(a.filter(x => x.t < mid).map(x => x.ret))), newer: r2(avg(a.filter(x => x.t >= mid).map(x => x.ret))), reachedAtAnyPoint: Math.round(a.filter(x => x.mfe >= +tg).length / a.length * 100), needWin: r2(((+sp + 0.15) / (+sp + +tg)) * 100) }); });
  rows.sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : a.side < b.side ? -1 : a.side > b.side ? 1 : a.stop - b.stop || a.target - b.target));
  return { stocks: nStocks, from: ts[0] || null, to: ts[ts.length - 1] || null, hold: HOLD, rows };
}

// ---- Target study v2: the same signals and baseline, split by market type and by entry filters (to see whether any filter lifts the hit rate above break-even)
const DT2 = 0.4;
function niftyMap(N) { // per Nifty session: that day's move, and whether it closed above its own 50-day average with a rising 20-day slope
  const m = {}, cl = N.map(x => x.c);
  for (let i = 1; i < N.length; i++) {
    const day = Math.floor((N[i].t + 19800) / 86400), pct = (cl[i] / cl[i - 1] - 1) * 100; let tr = 0;
    if (i >= 50) { const ma = cl.slice(i - 49, i + 1).reduce((a, b) => a + b, 0) / 50, ma20 = cl.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20, ma20p = i >= 25 ? cl.slice(i - 24, i - 4).reduce((a, b) => a + b, 0) / 20 : ma20; tr = cl[i] > ma && ma20 > ma20p ? 1 : cl[i] < ma && ma20 < ma20p ? -1 : 0; }
    m[day] = { pct, dt: pct >= DT2 ? 'up' : pct <= -DT2 ? 'down' : 'flat', tr };
  }
  return m;
}
function feat(C, k, dir, NM) {
  const day = Math.floor((C[k].t + 19800) / 86400), n = NM[day] || { dt: 'flat', tr: 0 }, f = new Set(['all']);
  f.add('mkt-' + n.dt); f.add(n.tr === 0 ? 'trend-neutral' : n.tr === dir ? 'trend-with' : 'trend-against');
  const vs = C.slice(Math.max(0, k - 20), k).map(x => x.v || 0), va = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0, volHi = va > 0 && (C[k].v || 0) >= 1.5 * va; if (volHi) f.add('volume 1.5x');
  const w = C.slice(Math.max(0, k - 251), k + 1), hi = Math.max(...w.map(x => x.h)), lo = Math.min(...w.map(x => x.l)), near = dir > 0 ? C[k].c >= hi * 0.95 : C[k].c <= lo * 1.05; if (near) f.add('near 52wk extreme');
  const rng = C.slice(Math.max(0, k - 13), k + 1).reduce((a, x) => a + (x.h - x.l), 0) / Math.min(14, k + 1) / C[k].c * 100; if (rng >= 2) f.add('wide range (2%+/day)');
  if (n.tr === dir && volHi) f.add('with trend AND volume');
  if (n.tr === dir && near) f.add('with trend AND near extreme');
  return [...f];
}
function targetStudy2(E, sym, C, cost, NM) {
  const k0 = Math.max(130, C.length - 260), k1 = C.length - 1 - HOLD - 1; if (C.length < 200 || k1 <= k0) return [];
  const sc = scores(E, sym, C, k0, k1), recs = [];
  const add = (grp, k, dir) => { const fs = feat(C, k, dir, NM); SP.forEach(sp => TG.forEach(tg => { const r = outcome(C, k, dir, sp, tg, cost); fs.forEach(fl => recs.push({ g: grp, dir, sp, tg, t: C[k].t, o: r.o, ret: r.ret, fl })); })); };
  for (let k = k0; k <= k1; k++) { const s = sc[k]; if (s && Math.abs(s.a) >= 3) add('signal', k, Math.sign(s.a)); if ((k - k0) % 5 === 0) { add('base', k, 1); add('base', k, -1); } }
  return recs;
}
function aggregateTargets2(all, nStocks) {
  const r2 = x => Math.round(x * 100) / 100, avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const ts = all.map(x => x.t).sort((a, b) => a - b), mid = ts[Math.floor(ts.length / 2)], key = {}, rows = [];
  all.forEach(x => { const k = [x.g, x.dir > 0 ? 'BUY' : 'SELL', x.sp, x.tg, x.fl].join('|'); (key[k] = key[k] || []).push(x); });
  Object.entries(key).forEach(([k, a]) => { const [g, side, sp, tg, fl] = k.split('|'); if (a.length < 30) return; const T = a.filter(x => x.o === 'T').length, S = a.filter(x => x.o === 'S').length, o = a.filter(x => x.t < mid), nw = a.filter(x => x.t >= mid);
    rows.push({ group: g, side, stop: +sp, target: +tg, filter: fl, n: a.length, hitT: Math.round(T / a.length * 100), hitS: Math.round(S / a.length * 100), avg: r2(avg(a.map(x => x.ret))), older: r2(avg(o.map(x => x.ret))), newer: r2(avg(nw.map(x => x.ret))), nOld: o.length, nNew: nw.length, needWin: r2(((+sp + 0.15) / (+sp + +tg)) * 100) }); });
  rows.forEach(r => { r.both = r.older > 0 && r.newer > 0; });
  return { stocks: nStocks, from: ts[0] || null, to: ts[ts.length - 1] || null, hold: HOLD, rows, note: 'Signal and baseline trades by market type (Nifty daily move at the signal, +-0.4%), Nifty trend (above/below its 50-day average with the 20-day average rising/falling) and entry filters. 10 sessions, costs included. Many combinations are compared, so a few will look good by chance: only trust one that is positive in BOTH halves with a large n.' };
}

// ---- Options study (index spot proxy): the history of an option premium is not available, so each intraday index trade is replayed with a simple model:
// option % move = delta x spot move / premium (delta 0.5, ATM premium = P % of spot), stop -12%, target +25% or +30%, out at 15:30, round-trip cost 2% of premium.
// Theta (time decay) and gamma are ignored: decay would make the real result a little worse on slow days.
const O_DELTA = 0.5, O_P = [0.5, 0.8], O_STOP = 12, O_TG = [25, 30], O_COST = 2;
function optStudy(trades, bars) {
  const idx = new Map(); bars.forEach((b, i) => idx.set(b.t, i)); const recs = [];
  trades.forEach(tr => {
    if (!tr.closed || !tr.entry) return; const dir = /^(BUY|LONG|UP|CALL)/i.test(tr.side) ? 1 : -1;
    let i = idx.get(tr.t - 899); if (i == null) { i = bars.findIndex(b => b.t + 899 >= tr.t); if (i < 0) return; }
    const day = Math.floor((tr.t + 19800) / 86400), e = tr.entry;
    O_P.forEach(P => O_TG.forEach(TG => {
      let o = 'E', ret = null, mfe = 0;
      for (let j = i + 1; j < bars.length; j++) {
        const b = bars[j]; if (Math.floor((b.t + 19800) / 86400) !== day) { ret = ret == null ? 0 : ret; break; }
        const fav = O_DELTA * (dir > 0 ? (b.h - e) / e * 100 : (e - b.l) / e * 100) / P * 100, adv = O_DELTA * (dir > 0 ? (e - b.l) / e * 100 : (b.h - e) / e * 100) / P * 100; mfe = Math.max(mfe, fav);
        if (adv >= O_STOP) { o = 'S'; ret = -O_STOP; break; }
        if (fav >= TG) { o = 'T'; ret = TG; break; }
        const last = Math.floor(((b.t + 19800) % 86400) / 60) >= 915 - 15; if (last) { ret = O_DELTA * dir * (b.c - e) / e * 100 / P * 100; break; }
      }
      if (ret == null) ret = 0; recs.push({ kind: (tr.sym || '') + ' ' + (tr.setup || tr.engine || 'idx') + ' ' + (dir > 0 ? 'CALL' : 'PUT'), k2: (tr.setup || tr.engine || 'idx') + ' ' + (dir > 0 ? 'CALL' : 'PUT'), dt: tr.dt || 'n/a', P, tg: TG, t: tr.t, o, ret: ret - O_COST, mfe });
    }));
  });
  return recs;
}
function aggregateOpt(all) {
  const r2 = x => Math.round(x * 100) / 100, avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const ts = all.map(x => x.t).sort((a, b) => a - b), mid = ts[Math.floor(ts.length / 2)], key = {}, rows = [];
  const put = (k, x) => (key[k] = key[k] || []).push(x);
  all.forEach(x => { [['ALL', 'all'], ['ALL', 'day ' + x.dt], [x.k2, 'all'], [x.k2, 'day ' + x.dt]].forEach(([g, d]) => put([g, d, x.P, x.tg].join('|'), x)); });
  Object.entries(key).forEach(([k, a]) => { const [g, d, P, tg] = k.split('|'); if (a.length < 20) return; const T = a.filter(x => x.o === 'T').length, S = a.filter(x => x.o === 'S').length, o = a.filter(x => x.t < mid), nw = a.filter(x => x.t >= mid);
    rows.push({ kind: g, when: d, premiumPct: +P, target: +tg, n: a.length, hitT: Math.round(T / a.length * 100), hitS: Math.round(S / a.length * 100), exitEOD: Math.round((a.length - T - S) / a.length * 100), avg: r2(avg(a.map(x => x.ret))), older: r2(avg(o.map(x => x.ret))), newer: r2(avg(nw.map(x => x.ret))), needWin: r2((O_STOP + O_COST) / (O_STOP + +tg) * 100) }); });
  rows.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.when < b.when ? -1 : a.when > b.when ? 1 : a.premiumPct - b.premiumPct || a.target - b.target));
  return { trades: all.length / (O_P.length * O_TG.length), from: ts[0] || null, to: ts[ts.length - 1] || null, rows, model: { delta: O_DELTA, premiumPctOfSpot: O_P, stop: O_STOP, targets: O_TG, cost: O_COST } };
}

// ---- Research studies on daily history (read-only): relative-strength momentum, gap reversal vs continuation, and index behaviour by weekday (expiry day).
const dayKey = t => Math.floor((t + 19800) / 86400);
const r2_ = x => Math.round(x * 100) / 100, avg_ = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

// Momentum: every REB sessions rank the stocks on their return from L sessions ago to SKIP sessions ago; hold the top fifth (long) and the bottom fifth (short) for H sessions.
function momentumStudy(D, cal, cost) {
  const maps = {}; Object.entries(D).forEach(([sym, bars]) => { const m = new Map(); bars.forEach(b => m.set(dayKey(b.t), b.c)); maps[sym] = m; });
  const days = cal.map(b => dayKey(b.t)), SKIP = 5, REB = 10, rows = [];
  [60, 120, 250].forEach(L => [10, 21].forEach(H => {
    const reb = [];
    for (let i = L + SKIP; i + H < days.length; i += REB) {
      const sc = [];
      Object.keys(maps).forEach(sym => { const m = maps[sym], c0 = m.get(days[i]), cs = m.get(days[i - SKIP]), cl = m.get(days[i - L]), cf = m.get(days[i + H]); if (c0 > 0 && cs > 0 && cl > 0 && cf > 0) sc.push({ s: cs / cl - 1, f: (cf / c0 - 1) * 100 }); });
      if (sc.length < 50) continue; sc.sort((a, b) => b.s - a.s); const q = Math.floor(sc.length / 5), top = sc.slice(0, q), bot = sc.slice(-q), all = avg_(sc.map(x => x.f));
      reb.push({ t: cal[i].t, top: avg_(top.map(x => x.f)), bot: avg_(bot.map(x => x.f)), all, q });
    }
    if (reb.length < 6) return; const mid = reb[Math.floor(reb.length / 2)].t, half = (f, a) => a.length ? r2_(avg_(a.map(f))) : null;
    const topN = r => r.top - cost, shortN = r => -r.bot - cost, ls = r => r.top - r.bot - 2 * cost;
    rows.push({ lookback: L, hold: H, rebalances: reb.length, perLeg: reb[0].q, trades: reb.reduce((s, r) => s + r.q, 0), from: reb[0].t, to: reb[reb.length - 1].t,
      topAvg: half(topN, reb), universeAvg: half(r => r.all, reb), bottomAvg: half(r => r.bot, reb), longVsUniverse: half(r => r.top - r.all, reb), shortAvg: half(shortN, reb), longShort: half(ls, reb),
      topBeatUniversePct: Math.round(reb.filter(r => r.top > r.all).length / reb.length * 100), longShortPositivePct: Math.round(reb.filter(r => ls(r) > 0).length / reb.length * 100),
      older: half(topN, reb.filter(r => r.t < mid)), newer: half(topN, reb.filter(r => r.t >= mid)), olderLS: half(ls, reb.filter(r => r.t < mid)), newerLS: half(ls, reb.filter(r => r.t >= mid)) });
  }));
  return rows;
}

// Gaps: a stock that opens 1%+ away from yesterday's close. Daily bars only: if the stop and the target both fall inside the day the stop is assumed first.
function gapOutcome(b, dir, stopPct, tgtPct, cost) {
  const o = b.o, st = o * (1 - dir * stopPct / 100), tg = o * (1 + dir * tgtPct / 100);
  if (dir > 0 ? b.l <= st : b.h >= st) return -stopPct - cost;
  if (dir > 0 ? b.h >= tg : b.l <= tg) return tgtPct - cost;
  return dir * (b.c - o) / o * 100 - cost;
}
function gapStudy(D, nifty, cost) {
  const ng = new Map(); for (let i = 1; i < nifty.length; i++) ng.set(dayKey(nifty[i].t), (nifty[i].o / nifty[i - 1].c - 1) * 100);
  const ev = [];
  Object.entries(D).forEach(([sym, bars]) => { for (let k = 1; k < bars.length; k++) { const b = bars[k], p = bars[k - 1]; if (!(b.o > 0 && p.c > 0)) continue; const gap = (b.o / p.c - 1) * 100; if (Math.abs(gap) < 1 || Math.abs(gap) > 12) continue;
    const n = ng.get(dayKey(b.t)), broad = n != null && Math.sign(n) === Math.sign(gap) && Math.abs(n) >= 0.4, fade = -Math.sign(gap), ga = Math.abs(gap);
    ev.push({ t: b.t, side: gap < 0 ? 'gap down' : 'gap up', bucket: ga < 2 ? '1-2%' : ga < 3 ? '2-3%' : '3%+', ctx: broad ? 'market-wide' : 'stock-specific',
      V: { 'fade: back to yesterday close (stop 1%)': gapOutcome(b, fade, 1, ga, cost), 'fade: +1.5% (stop 1%)': gapOutcome(b, fade, 1, 1.5, cost), 'follow: 1.5% (stop 1%)': gapOutcome(b, -fade, 1, 1.5, cost), 'fade: hold to close': fade * (b.c - b.o) / b.o * 100 - cost, 'follow: hold to close': -fade * (b.c - b.o) / b.o * 100 - cost } }); } });
  if (!ev.length) return { events: 0, rows: [] };
  const ts = ev.map(e => e.t).sort((a, b) => a - b), mid = ts[Math.floor(ts.length / 2)], rows = [];
  [['all', () => true], ['market-wide', e => e.ctx === 'market-wide'], ['stock-specific', e => e.ctx === 'stock-specific'], ['1-2%', e => e.bucket === '1-2%'], ['2-3%', e => e.bucket === '2-3%'], ['3%+', e => e.bucket === '3%+']].forEach(([lab, f]) => ['gap down', 'gap up'].forEach(side => {
    const a = ev.filter(e => e.side === side && f(e)); if (a.length < 30) return;
    Object.keys(a[0].V).forEach(v => { const x = a.map(e => e.V[v]), o = a.filter(e => e.t < mid).map(e => e.V[v]), nw = a.filter(e => e.t >= mid).map(e => e.V[v]);
      rows.push({ group: lab, side, variant: v, n: a.length, win: Math.round(x.filter(y => y > 0).length / x.length * 100), avg: r2_(avg_(x)), older: r2_(avg_(o)), newer: r2_(avg_(nw)), both: avg_(o) > 0 && avg_(nw) > 0 }); }); }));
  return { events: ev.length, from: ts[0], to: ts[ts.length - 1], rows };
}

// Index behaviour by weekday (the expiry weekday is read from the live contract list): range, direction, trend days.
function expiryStudy(bars, splitDay) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], out = [];
  [['since ' + new Date(splitDay * 86400000).toISOString().slice(0, 10), b => dayKey(b.t) >= splitDay], ['before', b => dayKey(b.t) < splitDay]].forEach(([lab, f]) => {
    const g = {}; for (let k = 1; k < bars.length; k++) { const b = bars[k], p = bars[k - 1]; if (!f(b) || !(b.o > 0 && p.c > 0 && b.h > b.l)) continue; const wd = new Date(b.t * 1000 + 19800000).getUTCDay(); if (wd < 1 || wd > 5) continue;
      (g[wd] = g[wd] || []).push({ rng: (b.h - b.l) / p.c * 100, oc: (b.c - b.o) / b.o * 100, gap: (b.o / p.c - 1) * 100, cc: (b.c / p.c - 1) * 100, trend: Math.abs(b.c - b.o) / (b.h - b.l) >= 0.6, closeTop: (b.c - b.l) / (b.h - b.l) >= 0.8, closeBot: (b.c - b.l) / (b.h - b.l) <= 0.2 }); }
    Object.keys(g).forEach(wd => { const a = g[wd]; out.push({ period: lab, weekday: names[wd], n: a.length, avgRange: r2_(avg_(a.map(x => x.rng))), avgAbsOpenClose: r2_(avg_(a.map(x => Math.abs(x.oc)))), avgOpenClose: r2_(avg_(a.map(x => x.oc))), avgCloseVsPrev: r2_(avg_(a.map(x => x.cc))), avgAbsGap: r2_(avg_(a.map(x => Math.abs(x.gap)))), upPct: Math.round(a.filter(x => x.cc > 0).length / a.length * 100), trendDayPct: Math.round(a.filter(x => x.trend).length / a.length * 100), closeNearHighPct: Math.round(a.filter(x => x.closeTop).length / a.length * 100), closeNearLowPct: Math.round(a.filter(x => x.closeBot).length / a.length * 100) }); }); });
  return out;
}

module.exports = { momentumStudy, gapStudy, expiryStudy, study, aggregate, VARIANTS, LIM, targetStudy, aggregateTargets, niftyMap, targetStudy2, aggregateTargets2, optStudy, aggregateOpt };
