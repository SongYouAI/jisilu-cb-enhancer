#!/usr/bin/env node
/* 真页验收（需网络）：打开集思录待发转债页，严格按 manifest.json 的 js/css 清单注入，
   验证新两列「表头↔表体 x 对齐」「悬浮详情弹出」「右滚后完整可见」。
   用法：npm run verify:live
   注意：依赖本机 Chrome（/Applications/Google Chrome.app）与 puppeteer-core。
*/
const fs = require('fs');
const path = require('path');
const puppeteer = require('/Users/niusl321/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const EXEC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'https://www.jisilu.cn/web/data/cb/pre/';
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EXEC, headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 900 });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await new Promise(r => setTimeout(r, 3500));

  await page.evaluate(() => {
    window.chrome = { runtime: { sendMessage: () => Promise.resolve({ prices: {}, errors: {} }) } };
    const g = { defaultEstimatedProfitTen: null, defaultRestrictedRatio: 0, defaultAllocationRatio: 90, thresholds: [0.02, 0.04, 0.06, 0.08], cacheTtlSeconds: 30, mood: 'neutral' };
    window.__state = { schemaVersion: 1, global: g, bonds: {} };
    window.JisiluStorage = { defaults: g, read: () => Promise.resolve(window.__state), bondSettings: () => Promise.resolve(g), saveBond: () => Promise.resolve(), resetBond: () => Promise.resolve(), saveGlobal: () => Promise.resolve() };
  });
  for (const f of manifest.content_scripts[0].css || []) await page.addStyleTag({ content: fs.readFileSync(path.join(ROOT, f), 'utf8') });
  for (const f of manifest.content_scripts[0].js) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) { console.error('清单文件不存在:', f); await browser.close(); process.exit(1); }
    await page.addScriptTag({ content: fs.readFileSync(p, 'utf8') });
  }
  await new Promise(r => setTimeout(r, 2500));

  const res = await page.evaluate(() => {
    const out = {};
    const r = el => el ? { x: Math.round(el.getBoundingClientRect().x), right: Math.round(el.getBoundingClientRect().right) } : null;
    const hAmt = document.querySelector('table.el-table__header th.je-header-amount');
    const bAmt = document.querySelector('table.el-table__body td.je-cell-amount');
    out.tooltipDefined = typeof window.JisiluTooltip;
    out.headerCount = document.querySelectorAll('table.el-table__header th[data-jisilu-enhancer]').length;
    out.headerTexts = [...document.querySelectorAll('table.el-table__header th[data-jisilu-enhancer]')].map(t => t.textContent);
    out.delta = (r(hAmt) && r(bAmt)) ? r(hAmt).x - r(bAmt).x : null;
    const active = [...document.querySelectorAll('table.el-table__body td.je-cell-amount')]
      .filter(td => td.querySelector('.je-main') && td.querySelector('.je-main').textContent.includes('¥'));
    out.activeRowCount = active.length;
    if (active.length) {
      active[0].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      const tip = document.getElementById('jisilu-enhancer-tooltip');
      out.amountTip = tip ? { display: tip.style.display, len: tip.innerHTML.length } : null;
      const ptd = active[0].parentElement.querySelector('td.je-cell-profit');
      if (ptd) {
        ptd.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        const t2 = document.getElementById('jisilu-enhancer-tooltip');
        out.profitTip = t2 ? { display: t2.style.display, len: t2.innerHTML.length } : null;
      }
    }
    const hEl = document.querySelector('table.el-table__header th.je-header-amount');
    if (hEl) {
      hEl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      const t3 = document.getElementById('jisilu-enhancer-tooltip');
      out.headerTip = t3 ? { display: t3.style.display, len: t3.innerHTML.length } : null;
    }
    return out;
  });

  const afterScroll = await page.evaluate(async () => {
    // 真页横向滚动可能发生在 wrapper 层（窄窗口）或文档层（宽 wrapper），两层都滚到位
    const bw = document.querySelector('.el-table__body-wrapper');
    if (bw) bw.scrollLeft = bw.scrollWidth;
    window.scrollTo(document.documentElement.scrollWidth, 0);
    await new Promise(r => setTimeout(r, 400));
    const x = el => el ? Math.round(el.getBoundingClientRect().x) : null;
    const hAmt = document.querySelector('table.el-table__header th.je-header-amount');
    const hPro = document.querySelector('table.el-table__header th.je-header-profit');
    const bAmt = document.querySelector('table.el-table__body td.je-cell-amount');
    const bPro = document.querySelector('table.el-table__body td.je-cell-profit');
    const vis = sel => { const el = document.querySelector(sel); if (!el) return false; const b = el.getBoundingClientRect(); return b.x >= 0 && b.right <= window.innerWidth; };
    return {
      scrolledAlignAmount: hAmt && bAmt ? x(hAmt) - x(bAmt) : null,
      scrolledAlignProfit: hPro && bPro ? x(hPro) - x(bPro) : null,
      amountHeaderVisible: vis('table.el-table__header th.je-header-amount'),
      profitHeaderVisible: vis('table.el-table__header th.je-header-profit'),
      amountBodyVisible: vis('table.el-table__body td.je-cell-amount'),
      profitBodyVisible: vis('table.el-table__body td.je-cell-profit')
    };
  });

  console.log('=== 真页验收（按 manifest 清单注入）===');
  console.log(JSON.stringify({ ...res, ...afterScroll }, null, 2));

  const checks = [
    ['JisiluTooltip 已加载', res.tooltipDefined === 'object'],
    ['表头注入 2 列', res.headerCount === 2],
    ['表头文字正确', JSON.stringify(res.headerTexts) === JSON.stringify(['配债所需资金', '预估盈利·安全垫'])],
    ['表头↔表体 x 对齐(delta=0)', res.delta === 0],
    ['横向滚动后仍对齐(delta=0)', afterScroll.scrolledAlignAmount === 0 && afterScroll.scrolledAlignProfit === 0],
    ['可潜伏行存在', res.activeRowCount > 0],
    ['金额列悬浮详情弹出', !!res.amountTip && res.amountTip.display === 'block' && res.amountTip.len > 100],
    ['盈利列悬浮详情弹出', !!res.profitTip && res.profitTip.display === 'block' && res.profitTip.len > 100],
    ['表头悬浮详情弹出', !!res.headerTip && res.headerTip.display === 'block' && res.headerTip.len > 50],
    ['右滚后表头两列可见', afterScroll.amountHeaderVisible && afterScroll.profitHeaderVisible],
    ['右滚后表体两列可见', afterScroll.amountBodyVisible && afterScroll.profitBodyVisible]
  ];
  console.log('\n=== 检查项 ===');
  let fail = 0;
  for (const [name, pass] of checks) { if (!pass) fail++; console.log(`${pass ? '✓' : '✗'} ${name}`); }
  console.log(`\n${fail === 0 ? '✅ 真页验收全部通过' : `❌ ${fail} 项未通过`}`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('VERIFY-LIVE ERROR', e.message); process.exit(1); });
