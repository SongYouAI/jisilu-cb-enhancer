/* 回归测试：表头在 element-ui 式重绘/部分清理后必须保持两列完整且与表体对齐
   覆盖两类真实事故（均为「存在即跳过」guard 引起）：
   1) Vue 只删一个注入 th → addHeaders 漏补（v0.4.1 修复）
   2) Vue 只删一个注入 <col> → ensureColumnWidths 漏补，表头表比表体窄 180px，
      表头整体横向错位一列（v0.4.3 修复，老板 2026-09-08 第二张截图）
   fixture 模拟真页 element-ui：table-layout:fixed + 原生 col 带 width（25 列合计 1652）。
*/
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('/Users/niusl321/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const EXEC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const fixture = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/pre-page-2026-09-06.json'), 'utf8'));

function buildHtml() {
  const headers = fixture.headers;
  const rowCells = fixture.rows[0].cells.slice();
  rowCells[2] = '同意注册';
  rowCells[16] = '-';
  rowCells[0] = '301459';
  const base = Math.floor(1652 / 25);
  const nativeWidths = Array.from({ length: 25 }, (_, i) => (i < 24 ? base : 1652 - base * 24));
  const colHtml = nativeWidths.map(w => `<col width="${w}">`).join('');
  // 表头 colgroup 末尾多一个 0 宽 gutter 列，正是 element-ui 真页的离线占位（表体没有）。
  // 这是之前漏测、导致 amount 列塌 0 的回归根因：注入 col 若 append 到末尾会被 gutter 顶错位一位。
  const headerColHtml = `${colHtml}<col width="0">`;
  const headerThs = headers.map(h => `<th>${h}</th>`).join('');
  const bodyTds = rowCells.map(c => `<td>${c}</td>`).join('');
  return `<style>table{table-layout:fixed;border-collapse:collapse}th,td{padding:4px 6px;font-size:12px;white-space:nowrap}</style>
    <div class="el-table" style="width:1280px;overflow:hidden;">
      <div class="el-table__header-wrapper" style="overflow:hidden;">
        <table id="htab"><colgroup>${headerColHtml}</colgroup><thead><tr id="hrow">${headerThs}</tr></thead></table>
      </div>
      <div class="el-table__body-wrapper" style="overflow-x:auto;width:1280px;">
        <table id="btab"><colgroup>${colHtml}</colgroup><tbody><tr id="row1">${bodyTds}</tr></tbody></table>
      </div>
    </div>`;
}

async function injectScripts(page) {
  await page.evaluate(() => {
    window.chrome = { runtime: { id: 'test-extension-id', sendMessage: () => Promise.resolve({ prices: {}, errors: {} }) } };
    const g = { defaultEstimatedProfitTen: null, defaultRestrictedRatio: 0, defaultAllocationRatio: 90, thresholds: [0.02, 0.04, 0.06, 0.08], cacheTtlSeconds: 30, mood: 'neutral' };
    window.__state = { schemaVersion: 1, global: g, bonds: {} };
    window.JisiluStorage = { defaults: g, read: () => Promise.resolve(window.__state), bondSettings: () => Promise.resolve(g), saveBond: () => Promise.resolve(), resetBond: () => Promise.resolve(), saveGlobal: () => Promise.resolve() };
  });
  await page.evaluate(h => { document.body.innerHTML = h; }, buildHtml());
  // 样式走 styles.js（与真实扩展同通道），不再直接注入 css 文件
  for (const f of ['core/rounding.js', 'core/calc.js', 'core/color.js', 'core/dates.js', 'core/rules.js', 'core/predict.js', 'config/selectors.js', 'content/ui/styles.js', 'content/ui/tooltip.js', 'content/ui/panel.js', 'content/jisilu-pre.js']) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, f), 'utf8') });
  }
}

async function measure(page) {
  return page.evaluate(() => {
    const ht = document.getElementById('htab');
    const bt = document.getElementById('btab');
    const injected = [...ht.querySelectorAll('th[data-jisilu-enhancer]')];
    const w = el => Math.round(el.getBoundingClientRect().width);
    const x = el => Math.round(el.getBoundingClientRect().x);
    const bw = document.querySelector('.el-table__body-wrapper');
    if (bw) bw.scrollLeft = bw.scrollWidth; // 老板场景：横向滚动后检查对齐
    const hAmt = ht.querySelector('th.je-header-amount');
    const hPro = ht.querySelector('th.je-header-profit');
    const bAmt = bt.querySelector('td.je-cell-amount');
    const bPro = bt.querySelector('td.je-cell-profit');
    return {
      injectedThCount: injected.length,
      texts: injected.map(t => t.textContent),
      injectedColCount: ht.querySelectorAll('colgroup col[data-jisilu-enhancer]').length,
      headerWidth: w(ht), bodyWidth: w(bt), widthDelta: w(ht) - w(bt),
      amountThWidth: hAmt ? w(hAmt) : 0,
      alignAmount: hAmt && bAmt ? x(hAmt) - x(bAmt) : null,
      alignProfit: hPro && bPro ? x(hPro) - x(bPro) : null,
      hasTitle: injected.some(t => t.title)
    };
  });
}

async function withBrowser(fn) {
  const browser = await puppeteer.launch({ executablePath: EXEC, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 900 });
  await page.setContent('<!DOCTYPE html><html><head></head><body></body></html>');
  await injectScripts(page);
  await new Promise(r => setTimeout(r, 700));
  try { await fn(page); } finally { await browser.close(); }
}

test('初始渲染：两列表头 + 两个 col + 宽度一致 + 滚动后对齐 + 无原生 title', async () => {
  await withBrowser(async page => {
    const m = await measure(page);
    assert.strictEqual(m.injectedThCount, 2);
    assert.deepStrictEqual(m.texts, ['配债所需资金', '预估盈利·安全垫']);
    assert.strictEqual(m.injectedColCount, 2);
    assert.strictEqual(m.widthDelta, 0, `表头表 ${m.headerWidth}px vs 表体表 ${m.bodyWidth}px`);
    assert.strictEqual(m.amountThWidth, 180);
    assert.strictEqual(m.alignAmount, 0, '滚动到最右后金额列表头应与表体对齐');
    assert.strictEqual(m.alignProfit, 0, '滚动到最右后盈利列表头应与表体对齐');
    assert.strictEqual(m.hasTitle, false);
  });
});

test('Vue 式整表头重绘（th+colgroup 全部重建）后自愈', async () => {
  await withBrowser(async page => {
    await page.evaluate(() => {
      const hrow = document.getElementById('hrow');
      const oldThs = [...hrow.querySelectorAll('th')].slice(0, 25).map(th => th.textContent);
      hrow.innerHTML = '';
      oldThs.forEach(text => { const th = document.createElement('th'); th.textContent = text; hrow.appendChild(th); });
      const group = document.querySelector('#htab colgroup');
      const native = [...group.querySelectorAll('col:not([data-jisilu-enhancer])')];
      group.innerHTML = '';
      native.forEach(c => group.appendChild(c));
      document.getElementById('htab').style.width = '1652px'; // Vue 重置宽度
    });
    await new Promise(r => setTimeout(r, 1000));
    const m = await measure(page);
    assert.strictEqual(m.injectedThCount, 2);
    assert.strictEqual(m.injectedColCount, 2);
    assert.strictEqual(m.widthDelta, 0);
    assert.strictEqual(m.alignAmount, 0);
  });
});

test('只删 amount 表头（th）后自愈，不能因 profit 存在就跳过', async () => {
  await withBrowser(async page => {
    await page.evaluate(() => {
      const th = document.querySelector('#htab th.je-header-amount');
      if (th) th.remove();
    });
    await new Promise(r => setTimeout(r, 1000));
    const m = await measure(page);
    assert.strictEqual(m.injectedThCount, 2);
    assert.deepStrictEqual(m.texts, ['配债所需资金', '预估盈利·安全垫']);
    assert.strictEqual(m.alignProfit, 0);
  });
});

test('只删一个注入 <col>（colgroup 残缺）后自愈，表头表不得比表体窄一列', async () => {
  await withBrowser(async page => {
    await page.evaluate(() => {
      const group = document.querySelector('#htab colgroup');
      const cols = [...group.querySelectorAll('col[data-jisilu-enhancer]')];
      if (cols[0]) cols[0].remove();
      const ht = document.getElementById('htab');
      const cur = parseFloat(ht.style.width) || 0;
      if (cur) ht.style.width = `${Math.round(cur - 180)}px`; // 模拟 Vue 同步重置宽度
    });
    await new Promise(r => setTimeout(r, 1000));
    const m = await measure(page);
    assert.strictEqual(m.injectedColCount, 2, `colgroup 应补齐 2 个 col，实际 ${m.injectedColCount}`);
    assert.strictEqual(m.injectedThCount, 2);
    assert.strictEqual(m.widthDelta, 0, `自愈后表头表 ${m.headerWidth}px vs 表体表 ${m.bodyWidth}px，不得差 180`);
    assert.strictEqual(m.amountThWidth, 180);
    assert.strictEqual(m.alignAmount, 0, 'colgroup 残缺自愈后滚动对齐必须恢复');
    assert.strictEqual(m.alignProfit, 0);
  });
});

test('整个 thead 被替换成原生 25 列（极激进破坏）后自愈，1.5s setInterval 兜底', async () => {
  await withBrowser(async page => {
    await page.evaluate(() => {
      // 模拟 element-ui 在某些边界情况下把整个 thead 替换（罕见但真实可能）
      const ht = document.getElementById('htab');
      const thead = ht.querySelector('thead');
      const oldTr = thead.querySelector('tr');
      const labels = [...oldTr.querySelectorAll('th')].slice(0, 25).map(th => th.textContent);
      const newTr = document.createElement('tr');
      labels.forEach(t => { const th = document.createElement('th'); th.textContent = t; newTr.appendChild(th); });
      thead.innerHTML = '';
      thead.appendChild(newTr);
      // 同时重置表宽到自然
      ht.style.width = '1652px';
      // 同时删 colgroup 里所有注入 col
      const g = ht.querySelector('colgroup');
      g.querySelectorAll('col[data-jisilu-enhancer]').forEach(c => c.remove());
    });
    // 等待 1.5s setInterval 兜底触发
    await new Promise(r => setTimeout(r, 2200));
    const m = await measure(page);
    assert.strictEqual(m.injectedThCount, 2, '整 thead 替换后两个 th 应被补回');
    assert.deepStrictEqual(m.texts, ['配债所需资金', '预估盈利·安全垫']);
    assert.strictEqual(m.injectedColCount, 2, 'colgroup 应补齐');
    assert.strictEqual(m.widthDelta, 0, `表头表 ${m.headerWidth}px vs 表体表 ${m.bodyWidth}px`);
    assert.strictEqual(m.alignAmount, 0, '自愈后滚动对齐必须恢复');
  });
});
