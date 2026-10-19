// Runs the dashboard's own browser code (screener signal, chart-pattern engine, breakout scanner) inside Node, so the server can
// compute exactly what the Scanner page shows without the page being open. The page's scripts are read from public/index.html and
// run in a sandbox whose window/document are inert stand-ins: anything that touches the page does nothing.
const fs = require('fs'), path = require('path'), vm = require('vm');
function inert() {
  const fn = function () {};
  const p = new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => 0;
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then') return undefined;           // not a promise
      if (k === 'length') return 0;
      if (k === 'toString' || k === 'valueOf') return () => '';
      return p;
    },
    set() { return true; }, apply() { return p; }, construct() { return p; }, has() { return true; }
  });
  return p;
}
let ENG = null, ERR = null;
function load() {
  if (ENG || ERR) return ENG;
  try {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    const blocks = []; const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi; let m;
    while ((m = re.exec(html))) { const attrs = m[1] || ''; if (/\bsrc=/.test(attrs) || /type=["'](?!text\/javascript)/.test(attrs)) continue; blocks.push(m[2]); }
    const I = inert(), store = {};
    const sandbox = {
      console: { log() {}, warn() {}, error() {}, info() {} }, Math, Date, JSON, Intl, Number, String, Array, Object, Promise, Set, Map, WeakMap, RegExp, Error, Symbol, isFinite, isNaN, parseFloat, parseInt, Proxy, Reflect, Float64Array, Uint8Array,
      setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, queueMicrotask() {},
      fetch: () => new Promise(() => {}), document: I, navigator: I, location: I, history: I, screen: I, matchMedia: () => I, getComputedStyle: () => I,
      localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; }, key: () => null, length: 0 },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, alert() {}, confirm: () => false, Notification: I, Audio: I, AudioContext: I, ResizeObserver: I, IntersectionObserver: I, MutationObserver: I, Image: I, CustomEvent: I, Event: I, LightweightCharts: I,
      innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1
    };
    sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox); const errs = [];
    blocks.forEach((src, i) => { try { vm.runInContext(src, ctx, { filename: 'index.html#script' + i, timeout: 20000 }); } catch (e) { errs.push('script' + i + ': ' + e.message); } });
    const get = n => { try { return vm.runInContext('typeof ' + n + "!=='undefined'?" + n + ':undefined', ctx); } catch (e) { return undefined; } };
    const E = { buildHorizons: get('buildHorizons'), xsPattern: get('xsPattern'), xsBreak: get('xsBreak'), xsCandlesFromHist: get('xsCandlesFromHist'), PatternEngine: get('PatternEngine'), B: sandbox.BreakoutScanner, help: sandbox.__patHelp, errs };
    const miss = ['buildHorizons', 'xsPattern', 'xsBreak', 'PatternEngine', 'B', 'help'].filter(k => !E[k]);
    if (miss.length) throw new Error('browser engines missing: ' + miss.join(', ') + (errs.length ? ' (' + errs.slice(0, 3).join('; ') + ')' : ''));
    ENG = E; return ENG;
  } catch (e) { ERR = e; return null; }
}
module.exports = { load, error: () => ERR && ERR.message };
