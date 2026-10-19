// Calls Monitor -> Excel workbook (Summary + Trades). Prices and costs are written as values; every derived number (buy/sell
// price, points, %, result, rupee P&L and the whole Summary sheet) is an Excel formula, so editing a price or the cost cell
// recalculates the file.
const ExcelJS = require('exceljs');

const STATUS = { SL_HIT: 'STOP HIT', TARGET_HIT: 'ALL TARGETS', PROFIT: 'PROFIT (trailed)', BREAKEVEN: 'AT ENTRY', EXPIRED: 'TIME EXIT', MANUAL_EXIT: 'MANUAL EXIT' };
const SRC = { agreement: 'Agreement', pattern: 'Pattern', screener: 'Screener' };
const ist = t => new Date((t + 19800) * 1000);
const dayStr = t => ist(t).toISOString().slice(0, 10);
const hm = t => ist(t).toISOString().slice(11, 16);
const sourceOf = c => c.kind === 'option' ? 'Index option' : c.manual ? (SRC[c.source] || 'Manual') : 'Trade call';
const statusOf = c => c.closed ? (STATUS[c.status] || c.status) : (c.targetsHit ? 'T' + c.targetsHit + ' done' : 'OPEN');

// columns of the Trades sheet: [header, width, numFmt]
const COLS = [
  ['Date', 11], ['Entry time', 9], ['Exit time', 9], ['Symbol', 16], ['Source', 13], ['Proven', 8], ['Side', 6], ['Mode', 9], ['Setup / label', 26],
  ['Entry price (₹)', 13, '#,##0.00'], ['Exit / LTP (₹)', 13, '#,##0.00'], ['State', 8], ['Status', 16],
  ['Buy price (₹)', 13, '#,##0.00'], ['Sell price (₹)', 13, '#,##0.00'], ['Points (₹/share)', 14, '#,##0.00;[Red]-#,##0.00;-'],
  ['Gross %', 9, '0.00%;[Red]-0.00%;-'], ['Costs %', 8, '0.00%'], ['Net %', 9, '0.00%;[Red]-0.00%;-'], ['Result', 10],
  ['Qty', 7, '#,##0'], ['P&L (₹)', 12, '#,##0;[Red]-#,##0;-'], ['Stop (₹)', 11, '#,##0.00'], ['T1 (₹)', 11, '#,##0.00'], ['T2 (₹)', 11, '#,##0.00'], ['T3 (₹)', 11, '#,##0.00'],
  ['Targets hit', 8], ['Notes', 60]
];
const L = i => { let s = '', n = i + 1; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const col = name => L(COLS.findIndex(c => c[0] === name));

async function buildCallsWorkbook(calls, { from, to, title } = {}) {
  const wb = new ExcelJS.Workbook(); wb.creator = 'NSE/BSE dashboard'; wb.created = new Date();
  const font = { name: 'Arial', size: 10 }, bold = { ...font, bold: true }, blue = { ...font, color: { argb: 'FF0000FF' } };
  const head = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2A44' } };
  const rows = calls.slice().sort((a, b) => a.t - b.t);

  const Sx = wb.addWorksheet('Summary'); // first tab
  // ---- Trades ----
  const T = wb.addWorksheet('Trades', { views: [{ state: 'frozen', ySplit: 1, xSplit: 4 }] });
  T.columns = COLS.map(([h, w, f]) => ({ header: h, width: w, style: { font, numFmt: f } }));
  T.getRow(1).eachCell(c => { c.font = { ...bold, color: { argb: 'FFFFFFFF' } }; c.fill = head; c.alignment = { vertical: 'middle', wrapText: true }; });
  T.getRow(1).height = 30;
  rows.forEach((c, i) => {
    const r = i + 2, exit = c.closed ? c.exit : (c.ltp != null ? c.ltp : c.exit), tg = c.targets || [];
    const v = {
      'Date': dayStr(c.t), 'Entry time': hm(c.t), 'Exit time': c.closed && (c.exitT || c.closedAt) ? hm(c.exitT || c.closedAt) + (dayStr(c.exitT || c.closedAt) !== dayStr(c.t) ? ' (' + dayStr(c.exitT || c.closedAt).slice(5) + ')' : '') : '',
      'Symbol': c.symbol, 'Source': sourceOf(c), 'Proven': c.manual ? '—' : (c.unproven ? 'No' : 'Yes'), 'Side': c.side, 'Mode': c.mode,
      'Setup / label': c.manual ? (c.label || '') : (c.kind === 'option' ? (c.setup || '') + (c.expiryLabel ? ' · ' + c.expiryLabel : '') : (c.setup || 'trend') + (c.score != null ? ' · score ' + c.score : '')),
      'Entry price (₹)': c.entry, 'Exit / LTP (₹)': exit, 'State': c.closed ? 'Closed' : 'Open', 'Status': statusOf(c),
      'Costs %': (c.costPct || 0) / 100, 'Qty': c.qty || null,
      'Stop (₹)': c.sl, 'T1 (₹)': tg[0] ?? null, 'T2 (₹)': tg[1] ?? null, 'T3 (₹)': tg[2] ?? null, 'Targets hit': c.targetsHit || 0,
      'Notes': String(c.analysis || '').slice(0, 300)
    };
    COLS.forEach(([h], k) => { if (v[h] !== undefined) T.getCell(r, k + 1).value = v[h]; });
    const J = col('Entry price (₹)') + r, K = col('Exit / LTP (₹)') + r, G = col('Side') + r, N = col('Buy price (₹)') + r, O = col('Sell price (₹)') + r, P = col('Points (₹/share)') + r;
    const Q = col('Gross %') + r, R = col('Costs %') + r, S = col('Net %') + r, Lc = col('State') + r, M = col('Status') + r, U = col('Qty') + r;
    T.getCell(N).value = { formula: `IF(${G}="BUY",${J},${K})` };
    T.getCell(O).value = { formula: `IF(${G}="BUY",${K},${J})` };
    T.getCell(P).value = { formula: `${O}-${N}` };
    T.getCell(Q).value = { formula: `IF(${J}>0,${P}/${J},0)` };
    T.getCell(S).value = { formula: `ROUND(${Q}-${R},4)` }; // rounded to 0.01% like the Calls Monitor
    T.getCell(col('Result') + r).value = { formula: `IF(${Lc}="Open","Open",IF(${M}="AT ENTRY","Breakeven",IF(${S}>0,"Win","Loss")))` };
    T.getCell(col('P&L (₹)') + r).value = { formula: `IF(${U}="","",${P}*${U}-${R}*${J}*${U})` };
    [J, K, R].forEach(a => { T.getCell(a).font = blue; });               // inputs from the app: blue
    if (c.side === 'SELL') T.getCell(G).font = { ...font, color: { argb: 'FFC0392B' } }; else T.getCell(G).font = { ...font, color: { argb: 'FF1E8449' } };
  });
  const n = rows.length, last = n + 1;
  if (n) T.autoFilter = { from: 'A1', to: L(COLS.length - 1) + '1' };
  T.getCell('A' + (last + 2)).value = 'Blue = prices and costs from the dashboard (Exit / LTP is the live price for open calls). Buy / sell price, points, %, result and P&L are formulas. Points = sell − buy per share (or per option unit). Net % = gross % − costs. P&L (₹) only when risk sizing gave a quantity. Paper trading, not advice.';
  T.getCell('A' + (last + 2)).font = { ...font, italic: true, color: { argb: 'FF666666' } };

  // ---- Summary ----
  Sx.columns = [{ width: 34 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }];
  const rg = name => `Trades!$${col(name)}$2:$${col(name)}$${Math.max(2, last)}`;
  const RES = rg('Result'), NET = rg('Net %'), PTS = rg('Points (₹/share)'), STATE = rg('State'), SOURCE = rg('Source'), PNL = rg('P&L (₹)'), STAT = rg('Status');
  Sx.getCell('A1').value = title || 'Calls Monitor summary'; Sx.getCell('A1').font = { ...bold, size: 14 };
  Sx.getCell('A2').value = 'Calls entered ' + (from === to ? from : from + ' to ' + to) + ' (IST), plus older calls still open or closed in that period · paper trading'; Sx.getCell('A2').font = { ...font, color: { argb: 'FF666666' } };
  const lines = [
    ['Calls', `COUNTA(${rg('Symbol')})`, '0'],
    ['Closed', `COUNTIF(${STATE},"Closed")`, '0'],
    ['Still open', `COUNTIF(${STATE},"Open")`, '0'],
    ['Wins', `COUNTIF(${RES},"Win")`, '0'],
    ['Losses', `COUNTIF(${RES},"Loss")`, '0'],
    ['Breakeven', `COUNTIF(${RES},"Breakeven")`, '0'],
    ['Win rate (closed)', `IF(B5>0,B7/B5,0)`, '0%'],
    ['Targets fully hit', `COUNTIF(${STAT},"ALL TARGETS")`, '0'],
    ['Stops hit', `COUNTIF(${STAT},"STOP HIT")`, '0'],
    ['Net % closed (sum, after costs)', `SUMIF(${STATE},"Closed",${NET})`, '0.00%;[Red]-0.00%'],
    ['Average net % per closed call', `IF(B5>0,B13/B5,0)`, '0.00%;[Red]-0.00%'],
    ['Best closed call', `IF(B5>0,MAX(IF(${STATE}="Closed",${NET})),0)`, '0.00%;[Red]-0.00%', true],
    ['Worst closed call', `IF(B5>0,MIN(IF(${STATE}="Closed",${NET})),0)`, '0.00%;[Red]-0.00%', true],
    ['Running % on open calls (sum)', `SUMIF(${STATE},"Open",${NET})`, '0.00%;[Red]-0.00%'],
    ['Points gained (closed winners, ₹/share)', `SUMIFS(${PTS},${STATE},"Closed",${PTS},">0")`, '#,##0.00'],
    ['Points lost (closed losers, ₹/share)', `SUMIFS(${PTS},${STATE},"Closed",${PTS},"<0")`, '#,##0.00;[Red]-#,##0.00'],
    ['P&L closed (₹, sized calls only)', `SUMIF(${STATE},"Closed",${PNL})`, '#,##0;[Red]-#,##0;-']
  ];
  lines.forEach(([lab, f, fmt, arr], i) => { const r = i + 4; Sx.getCell('A' + r).value = lab; Sx.getCell('A' + r).font = font;
    const c = Sx.getCell('B' + r); c.value = arr ? { formula: f, shareType: 'array', ref: 'B' + r } : { formula: f }; c.numFmt = fmt; c.font = bold; });
  // by source
  let r0 = 4 + lines.length + 2;
  Sx.getCell('A' + r0).value = 'By source'; Sx.getCell('A' + r0).font = { ...bold, size: 12 };
  const hdr = ['Source', 'Calls', 'Closed', 'Wins', 'Losses', 'Net % closed', 'Open running %'];
  hdr.forEach((h, k) => { const c = Sx.getCell(r0 + 1, k + 1); c.value = h; c.font = { ...bold, color: { argb: 'FFFFFFFF' } }; c.fill = head; });
  const srcs = [...new Set(rows.map(sourceOf))];
  srcs.forEach((s, i) => { const r = r0 + 2 + i, A = '$A' + r;
    Sx.getCell('A' + r).value = s;
    Sx.getCell('B' + r).value = { formula: `COUNTIF(${SOURCE},${A})` };
    Sx.getCell('C' + r).value = { formula: `COUNTIFS(${SOURCE},${A},${STATE},"Closed")` };
    Sx.getCell('D' + r).value = { formula: `COUNTIFS(${SOURCE},${A},${RES},"Win")` };
    Sx.getCell('E' + r).value = { formula: `COUNTIFS(${SOURCE},${A},${RES},"Loss")` };
    Sx.getCell('F' + r).value = { formula: `SUMIFS(${NET},${SOURCE},${A},${STATE},"Closed")` }; Sx.getCell('F' + r).numFmt = '0.00%;[Red]-0.00%;-';
    Sx.getCell('G' + r).value = { formula: `SUMIFS(${NET},${SOURCE},${A},${STATE},"Open")` }; Sx.getCell('G' + r).numFmt = '0.00%;[Red]-0.00%;-';
    for (let k = 1; k <= 7; k++) if (!Sx.getCell(r, k).font || !Sx.getCell(r, k).font.bold) Sx.getCell(r, k).font = font;
  });
  const rn = r0 + 3 + srcs.length;
  Sx.getCell('A' + rn).value = 'Points are ₹ per share and are summed across stocks of very different prices, so the % columns are the fairer comparison. All figures are formulas over the Trades sheet.';
  Sx.getCell('A' + rn).font = { ...font, italic: true, color: { argb: 'FF666666' } };
  return wb;
}
module.exports = { buildCallsWorkbook, dayStr };
