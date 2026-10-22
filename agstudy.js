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
    out[k] = { a: scoreOf(sig, pt ? pt.d : 0, b, wkDir(k)), score: hz ? hz.score : 0 };
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
module.exports = { study, aggregate, VARIANTS, LIM };
