#!/usr/bin/env node
/* 端到端验收（环境允许的最高保真）：
   用 CDP 的 Page.addScriptToEvaluateOnNewDocument，在页面导航前、按 manifest.json 的 js 顺序、
   注入到独立世界（isolated world）——与真实 content script 的运行方式一致（独立世界 + 先于页面脚本）。
   DOM 与事件跨世界共享，因此可在本世界（main）里检查渲染结果并触发悬浮。
   注：本机沙箱的 Chrome 禁止 --load-extension 装载扩展（已验证 itemCount=0），
   故「Chrome 真实装载」这一环由 tests/manifest.test.js 的清单静态校验兜底。
   用法：npm run verify:e2e
*/
const fs = require('fs');
const path = require('path');
const puppeteer = require('/Users/niusl321/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const EXEC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'https://www.jisilu.cn/web/data/cb/pre/';
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 独立世界里没有 chrome API，用 mock 顶上（sendMessage 走降级路径，页面价兜底）
const CHROME_MOCK = `
  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};
  window.chrome.runtime.id = 'je-e2e-test';
  window.chrome.runtime.sendMessage = () => Promise.resolve({ prices: {}, errors: {} });
  // 注意：repository.js 用的是 Chrome 回调式 API get(KEY, cb)，mock 必须支持回调形式，
  // 只实现 Promise 会让 await read() 永远挂起（曾导致提示条测试假失败）。
  const store = {};
  const storageArea = {
    get: (keys, cb) => {
      const out = {};
      const list = Array.isArray(keys) ? keys : (keys == null ? Object.keys(store) : [keys]);
      list.forEach(k => { if (k in store) out[k] = store[k]; });
      if (typeof cb === 'function') { cb(out); return undefined; }
      return Promise.resolve(out);
    },
    set: (obj, cb) => { Object.assign(store, obj); if (typeof cb === 'function') { cb(); return undefined; } return Promise.resolve(); }
  };
  window.chrome.storage = { local: storageArea, sync: storageArea, onChanged: { addListener() {} } };
`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EXEC, headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 900 });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e).slice(0, 200)));

  const client = await page.createCDPSession();
  await client.send('Page.enable');
  // 1) mock chrome API  2) 按 manifest 顺序注入所有脚本 —— 都在独立世界、都在导航前
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: CHROME_MOCK, worldName: 'je-content' });
  for (const f of manifest.content_scripts[0].js) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) { console.error('清单文件不存在:', f); await browser.close(); process.exit(1); }
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(p, 'utf8'), worldName: 'je-content' });
  }

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let injected = false;
  for (let i = 0; i < 40 && !injected; i++) {
    await sleep(500);
    injected = await page.evaluate(() => !!document.querySelector('table.el-table__header th.je-header-amount') && !!document.querySelector('table.el-table__body td.je-cell-amount'));
  }

  const res = await page.evaluate(() => {
    const out = {};
    const ht = document.querySelector('table.el-table__header');
    const bt = document.querySelector('table.el-table__body');
    const styleEl = document.getElementById('jisilu-enhancer-styles');
    const r = el => el ? Math.round(el.getBoundingClientRect().x) : null;
    const w = el => el ? Math.round(el.getBoundingClientRect().width) : null;
    const cs = el => el ? getComputedStyle(el) : null;
    const hint = document.getElementById('jisilu-enhancer-hint');

    out.hintVersion = hint ? (hint.textContent.match(/v([0-9.]+)/) || [])[1] : null;
    out.styleInjected = !!styleEl && styleEl.textContent.length > 5000;

    const injectedTh = ht ? [...ht.querySelectorAll('th[data-jisilu-enhancer]')] : [];
    out.headerCount = injectedTh.length;
    out.headerTexts = injectedTh.map(t => t.textContent);
    const hAmt = ht && ht.querySelector('th.je-header-amount');
    out.headerBg = cs(hAmt) && cs(hAmt).backgroundColor;
    out.headerColor = cs(hAmt) && cs(hAmt).color;
    out.headerPosition = cs(hAmt) && cs(hAmt).position;
    out.injectedColCount = ht ? ht.querySelectorAll('colgroup col[data-jisilu-enhancer]').length : 0;
    out.headerTableWidth = w(ht); out.bodyTableWidth = w(bt);
    out.widthDelta = (w(ht) != null && w(bt) != null) ? w(ht) - w(bt) : null;

    const bAmt = bt && bt.querySelector('td.je-cell-amount');
    const bPro = bt && bt.querySelector('td.je-cell-profit');
    out.alignAmount = hAmt && bAmt ? r(hAmt) - r(bAmt) : null;
    out.alignProfit = (ht && ht.querySelector('th.je-header-profit') && bPro) ? r(ht.querySelector('th.je-header-profit')) - r(bPro) : null;

    const active = [...(bt ? bt.querySelectorAll('td.je-cell-amount') : [])]
      .filter(td => td.querySelector('.je-main') && td.querySelector('.je-main').textContent.includes('¥'));
    out.activeRowCount = active.length;
    out.sample = active[0] ? {
      main: active[0].querySelector('.je-main').textContent,
      meta: active[0].querySelector('.je-meta') ? active[0].querySelector('.je-meta').textContent : null,
      bondId: active[0].querySelector('.je-bond-id') ? active[0].querySelector('.je-bond-id').textContent.trim() : null
    } : null;

    const hover = (el) => {
      if (!el) return null;
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      const t = document.getElementById('jisilu-enhancer-tooltip');
      if (!t) return null;
      return { display: t.style.display, len: t.innerHTML.length, bg: getComputedStyle(t).backgroundColor, html: t.innerHTML.slice(0, 60) };
    };
    out.tipAmount = hover(active[0]);
    out.tipProfit = hover(active[0] && active[0].parentElement.querySelector('td.je-cell-profit'));
    out.tipHeader = hover(hAmt);
    out.tipsDiffer = out.tipAmount && out.tipProfit && out.tipAmount.html !== out.tipProfit.html;
    return out;
  });

  const afterScroll = await page.evaluate(async () => {
    const bw = document.querySelector('.el-table__body-wrapper');
    if (bw) bw.scrollLeft = bw.scrollWidth;
    window.scrollTo(document.documentElement.scrollWidth, 0);
    await new Promise(r => setTimeout(r, 400));
    const r = el => el ? Math.round(el.getBoundingClientRect().x) : null;
    const hAmt = document.querySelector('table.el-table__header th.je-header-amount');
    const bAmt = document.querySelector('table.el-table__body td.je-cell-amount');
    const hPro = document.querySelector('table.el-table__header th.je-header-profit');
    const bPro = document.querySelector('table.el-table__body td.je-cell-profit');
    const vis = sel => { const el = document.querySelector(sel); if (!el) return false; const b = el.getBoundingClientRect(); return b.x >= 0 && b.right <= window.innerWidth; };
    return {
      scrolledAlignAmount: hAmt && bAmt ? r(hAmt) - r(bAmt) : null,
      scrolledAlignProfit: hPro && bPro ? r(hPro) - r(bPro) : null,
      amountHeaderVisible: vis('table.el-table__header th.je-header-amount'),
      profitHeaderVisible: vis('table.el-table__header th.je-header-profit'),
      amountBodyVisible: vis('table.el-table__body td.je-cell-amount'),
      profitBodyVisible: vis('table.el-table__body td.je-cell-profit')
    };
  });

  console.log('=== 端到端验收（CDP 导航前注入 · 独立世界 · manifest 顺序）===');
  console.log('manifest version:', manifest.version);
  console.log(JSON.stringify({ ...res, ...afterScroll }, null, 2));
  if (pageErrors.length) console.log('页面错误:', JSON.stringify(pageErrors.slice(0, 8), null, 2));

  const checks = [
    ['插件完成注入（表头+表体都在）', injected],
    ['提示条版本号 = manifest (0.4.4)', res.hintVersion === manifest.version],
    ['样式经 JS 通道注入', res.styleInjected === true],
    ['表头注入 2 列', res.headerCount === 2],
    ['表头文字正确', JSON.stringify(res.headerTexts) === JSON.stringify(['配债所需资金', '预估盈利·安全垫'])],
    ['表头深蓝底 #0b1b34', res.headerBg === 'rgb(11, 27, 52)'],
    ['表头金字 #f5b64a', res.headerColor === 'rgb(245, 182, 74)'],
    ['表头 sticky 定位', res.headerPosition === 'sticky'],
    ['colgroup 注入 2 个 col', res.injectedColCount === 2],
    ['表头表与表体表等宽', res.widthDelta === 0],
    ['表头↔表体对齐(delta=0)', res.alignAmount === 0 && res.alignProfit === 0],
    ['横向滚动后仍对齐', afterScroll.scrolledAlignAmount === 0 && afterScroll.scrolledAlignProfit === 0],
    ['右滚后四格完整可见', afterScroll.amountHeaderVisible && afterScroll.profitHeaderVisible && afterScroll.amountBodyVisible && afterScroll.profitBodyVisible],
    ['有可潜伏行', res.activeRowCount > 0],
    ['代号标签/主值/副标题渲染', !!res.sample && !!res.sample.main && !!res.sample.meta && !!res.sample.bondId],
    ['金额列悬浮详情弹出', !!res.tipAmount && res.tipAmount.display === 'block' && res.tipAmount.len > 100],
    ['盈利列悬浮详情弹出', !!res.tipProfit && res.tipProfit.display === 'block' && res.tipProfit.len > 100],
    ['表头悬浮详情弹出', !!res.tipHeader && res.tipHeader.display === 'block' && res.tipHeader.len > 50],
    ['两列悬浮内容不同', res.tipsDiffer === true],
    ['悬浮卡片深蓝底', !!res.tipAmount && res.tipAmount.bg === 'rgb(11, 27, 52)'],
    ['无页面 JS 错误', pageErrors.length === 0]
  ];

  console.log('\n=== 检查项 ===');
  let fail = 0;
  for (const [name, pass] of checks) { if (!pass) fail++; console.log(`${pass ? '✓' : '✗'} ${name}`); }
  console.log(`\n${fail === 0 ? '✅ 端到端验收全部通过' : `❌ ${fail} 项未通过`}`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('E2E ERROR', e.message); process.exit(1); });
