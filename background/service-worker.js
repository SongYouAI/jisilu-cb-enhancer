/* global importScripts, chrome */
importScripts('../core/rounding.js', '../core/calc.js', '../core/quotes.js');

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
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!message || message.type !== 'GET_STOCK_PRICES') return undefined;
  const codes = [...new Set((message.codes || []).map(code => String(code).replace(/\D/g, '')).filter(code => /^\d{6}$/.test(code)))].slice(0, 100);
  resolveShared(codes).then(result => respond(result));
  return true;
});
