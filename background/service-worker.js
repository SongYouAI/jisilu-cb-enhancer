/* global importScripts, chrome */
importScripts('../core/rounding.js', '../core/calc.js', '../core/quotes.js', '../core/bond-math.js');

const PRICE_CACHE_TTL_MS = 30_000;
const cache = new Map();
let inflight = null;
let inflightKey = '';

function freshQuote(code) {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.fetchedAt < PRICE_CACHE_TTL_MS) return hit;
  return null;
}
function remember(quote) {
  const record = { ...quote, fetchedAt: Date.now() };
  cache.set(quote.code, record);
  return record;
}
// Tencent answers many symbols in one request, so a whole page costs a single round trip.
async function fetchTencentBatch(codes) {
  const url = JisiluQuotes.tencentUrl(codes);
  if (!url) throw new Error('没有可识别的正股代码');
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`腾讯行情 HTTP ${response.status}`);
  // The payload is GBK. Decoding it as UTF-8 would corrupt names and break the split.
  const text = new TextDecoder('gbk').decode(await response.arrayBuffer());
  const found = {};
  codes.forEach(code => {
    try { found[code] = JisiluQuotes.parseTencent(text, code); } catch (_) { /* handled by the fallback */ }
  });
  if (!Object.keys(found).length) throw new Error('腾讯行情未返回任何有效价格');
  return found;
}
async function fetchEastmoney(code) {
  const secid = JisiluQuotes.eastmoneySecId(code);
  if (!secid) throw new Error(`不支持的正股代码：${code}`);
  const url = new URL('https://push2.eastmoney.com/api/qt/stock/get');
  url.searchParams.set('secid', secid);
  url.searchParams.set('fields', 'f43,f57,f58');
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`东方财富 HTTP ${response.status}`);
  return JisiluQuotes.parseEastmoney(await response.json(), code);
}
async function resolve(codes) {
  const prices = {};
  const errors = {};
  const pending = [];
  codes.forEach(code => {
    const hit = freshQuote(code);
    if (hit) prices[code] = { ...hit, cached: true };
    else pending.push(code);
  });
  if (pending.length) {
    try {
      const batch = await fetchTencentBatch(pending);
      Object.values(batch).forEach(remember);
    } catch (_) {
      // Fall back per code instead of retrying the batch in a loop.
    }
    for (const code of pending) {
      if (freshQuote(code)) continue;
      try {
        remember(await fetchEastmoney(code));
      } catch (error) {
        errors[code] = error.message;
      }
    }
    // Show the last known price rather than blanking the column when both sources fail.
    pending.forEach(code => {
      if (prices[code]) return;
      const fresh = freshQuote(code);
      if (fresh) { prices[code] = { ...fresh, cached: true }; return; }
      const stale = cache.get(code);
      if (stale) prices[code] = { ...stale, cached: true, stale: true };
      else errors[code] = errors[code] || '两个行情源都暂不可用';
    });
  }
  return { prices, errors };
}
function resolveShared(codes) {
  const key = codes.join(',');
  if (inflight && inflightKey === key) return inflight;
  inflightKey = key;
  inflight = resolve(codes).finally(() => { inflight = null; inflightKey = ''; });
  return inflight;
}

/* ============================================================================
 * 转债列表页（cb/list）数据代理：东财条款全表 + 腾讯K线波动率
 * ==========================================================================*/

const TERMS_CACHE_KEY = 'cbTermsV1';
const TERMS_TTL_MS = 7 * 24 * 3600 * 1000; // 条款几乎不变，缓存 7 天
const EM_COLUMNS = 'SECURITY_CODE,SECURITY_NAME_ABBR,RATING,VALUE_DATE,EXPIRE_DATE,INTEREST_RATE_EXPLAIN,REDEEM_CLAUSE,RESALE_CLAUSE,DELIST_DATE,BOND_EXPIRE,PAY_INTEREST_DAY,RESALE_TRIG_PRICE,REDEEM_TRIG_PRICE,CONVERT_STOCK_CODE';

function dateOnly(s) { return s ? String(s).slice(0, 10) : null; }

// 拉一页东财转债全表
async function fetchEmTermsPage(pageNumber) {
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_BOND_CB_LIST' +
    '&columns=' + EM_COLUMNS + '&pageSize=500&pageNumber=' + pageNumber +
    '&sortColumns=PUBLIC_START_DATE&sortTypes=-1';
  const response = await fetch(url, { credentials: 'omit', headers: { 'Referer': 'https://data.eastmoney.com/' } });
  if (!response.ok) throw new Error(`东财条款 HTTP ${response.status}`);
  const body = await response.json();
  return (body && body.result) || { pages: 0, data: [] };
}

// 全量拉取 + 解析条款（过滤已退市）
async function buildTermsMap() {
  const first = await fetchEmTermsPage(1);
  const pages = Math.min(first.pages || 1, 6); // 防御性上限
  const rest = [];
  for (let p = 2; p <= pages; p++) rest.push(fetchEmTermsPage(p));
  const others = await Promise.all(rest);
  const rows = [...(first.data || []), ...others.flatMap(r => r.data || [])];
  const terms = {};
  let skipped = 0;
  for (const row of rows) {
    if (row.DELIST_DATE) { skipped++; continue; } // 已退市
    const code = String(row.SECURITY_CODE || '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) { skipped++; continue; }
    const coupons = JisiluBondMath.parseCoupons(row.INTEREST_RATE_EXPLAIN);
    const redeemPrice = JisiluBondMath.parseRedeemPrice(row.REDEEM_CLAUSE);
    const resale = JisiluBondMath.parseResale(row.RESALE_CLAUSE);
    terms[code] = {
      name: row.SECURITY_NAME_ABBR || '',
      stockCode: String(row.CONVERT_STOCK_CODE || '').replace(/\D/g, ''),
      rating: row.RATING || '',
      coupons, redeemPrice, resale,
      valueDate: dateOnly(row.VALUE_DATE),
      maturityDate: dateOnly(row.EXPIRE_DATE),
      expireYears: Number(row.BOND_EXPIRE) || 6,
      putTriggerPrice: Number(row.RESALE_TRIG_PRICE) || null,
      callTriggerPrice: Number(row.REDEEM_TRIG_PRICE) || null
    };
  }
  return { terms, count: Object.keys(terms).length, skipped, fetchedAt: Date.now() };
}

async function getCbTerms(force) {
  if (!force) {
    try {
      const stored = await chrome.storage.local.get(TERMS_CACHE_KEY);
      const hit = stored && stored[TERMS_CACHE_KEY];
      if (hit && Date.now() - hit.fetchedAt < TERMS_TTL_MS && hit.terms) return { ...hit, cached: true };
    } catch (_) { /* storage 不可用时直接拉 */ }
  }
  const fresh = await buildTermsMap();
  try { await chrome.storage.local.set({ [TERMS_CACHE_KEY]: fresh }); } catch (_) { /* 超限则只留内存 */ }
  return { ...fresh, cached: false };
}

/* ---------- 腾讯K线波动率 ---------- */
const VOL_CACHE_KEY = 'volCacheV1';
const VOL_TTL_MS = 24 * 3600 * 1000;
const volMem = new Map();
let volStoreLoaded = false;

async function loadVolStore() {
  if (volStoreLoaded) return;
  volStoreLoaded = true;
  try {
    const stored = await chrome.storage.local.get(VOL_CACHE_KEY);
    const map = stored && stored[VOL_CACHE_KEY];
    if (map) Object.entries(map).forEach(([code, rec]) => volMem.set(code, rec));
  } catch (_) { /* ignore */ }
}
async function saveVolStore() {
  try {
    const obj = {};
    volMem.forEach((rec, code) => { obj[code] = rec; });
    await chrome.storage.local.set({ [VOL_CACHE_KEY]: obj });
  } catch (_) { /* ignore */ }
}
function freshVol(code) {
  const hit = volMem.get(code);
  if (hit && Date.now() - hit.fetchedAt < VOL_TTL_MS && Number.isFinite(hit.value)) return hit;
  return null;
}

// 拉一只正股的 320 条日K，算年化波动率
async function fetchOneVol(code) {
  const symbol = JisiluQuotes.tencentSymbol(code);
  if (!symbol) throw new Error(`不支持的代码：${code}`);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,320,qfq`;
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`腾讯K线 HTTP ${response.status}`);
  const body = await response.json();
  const node = body && body.data && body.data[symbol];
  const days = (node && (node.qfqday || node.day)) || [];
  const closes = days.map(d => Number(d[2])).filter(v => Number.isFinite(v) && v > 0);
  const value = JisiluBondMath.annualizedVolatility(closes);
  if (!Number.isFinite(value)) throw new Error('K线数据不足');
  return { code, value, points: closes.length, fetchedAt: Date.now() };
}

// 批量波动率：并发 4、间隔 120ms，缓存优先
async function resolveVolatility(codes) {
  await loadVolStore();
  const out = {};
  const errors = {};
  const pending = [];
  [...new Set(codes)].forEach(code => {
    const hit = freshVol(code);
    if (hit) out[code] = { ...hit, cached: true };
    else pending.push(code);
  });
  const CONCURRENCY = 4;
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const slice = pending.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(slice.map(fetchOneVol));
    results.forEach((res, idx) => {
      const code = slice[idx];
      if (res.status === 'fulfilled') { volMem.set(code, res.value); out[code] = res.value; }
      else errors[code] = (res.reason && res.reason.message) || 'K线拉取失败';
    });
    if (i + CONCURRENCY < pending.length) await new Promise(r => setTimeout(r, 120));
  }
  if (pending.length) saveVolStore();
  return { vol: out, errors };
}

/* ---------- 消息路由 ---------- */
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!message || !message.type) return undefined;
  if (message.type === 'GET_STOCK_PRICES') {
    const codes = [...new Set((message.codes || []).map(code => String(code).replace(/\D/g, '')).filter(code => /^\d{6}$/.test(code)))].slice(0, 100);
    resolveShared(codes).then(result => respond(result));
    return true;
  }
  if (message.type === 'GET_CB_TERMS') {
    getCbTerms(!!message.force)
      .then(result => respond(result))
      .catch(error => respond({ terms: null, error: error.message }));
    return true;
  }
  if (message.type === 'GET_VOLATILITY') {
    const codes = [...new Set((message.codes || []).map(code => String(code).replace(/\D/g, '')).filter(code => /^\d{6}$/.test(code)))].slice(0, 500);
    resolveVolatility(codes)
      .then(result => respond(result))
      .catch(error => respond({ vol: {}, errors: { '*': error.message } }));
    return true;
  }
  return undefined;
});
