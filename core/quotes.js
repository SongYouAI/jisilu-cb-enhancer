(function (root) {
  'use strict';
  const SHANGHAI = /^(6|68)/;
  const SHENZHEN = /^(0|3)/;
  const BEIJING = /^(4|8|92)/;
  function normalise(code) { return String(code || '').replace(/\D/g, ''); }
  function tencentSymbol(code) {
    const value = normalise(code);
    if (!/^\d{6}$/.test(value)) return null;
    if (SHANGHAI.test(value)) return `sh${value}`;
    if (SHENZHEN.test(value)) return `sz${value}`;
    if (BEIJING.test(value)) return `bj${value}`;
    return null;
  }
  function eastmoneySecId(code) {
    const value = normalise(code);
    if (!/^\d{6}$/.test(value)) return null;
    if (SHANGHAI.test(value)) return `1.${value}`;
    if (SHENZHEN.test(value) || BEIJING.test(value)) return `0.${value}`;
    return null;
  }
  // Tencent accepts many symbols in a single request, so one round trip covers a whole page.
  function tencentUrl(codes) {
    const symbols = [...new Set((codes || []).map(tencentSymbol).filter(Boolean))];
    return symbols.length ? `https://qt.gtimg.cn/q=${symbols.join(',')}` : null;
  }
  // Body is GBK. Sample: v_sh600000="1~浦发银行~600000~9.43~9.27~..."; field 3 is last price.
  function parseTencent(body, code) {
    const symbol = tencentSymbol(code);
    const match = String(body || '').match(new RegExp(`v_${symbol}="([^"]*)"`));
    if (!match) throw new Error('腾讯行情未返回该代码的数据');
    const fields = match[1].split('~');
    const price = Number(fields[3]);
    if (!Number.isFinite(price) || price <= 0) throw new Error('腾讯行情价格无效（可能停牌或代码不存在）');
    return { code, price, name: fields[1] || '', source: '腾讯财经' };
  }
  // Eastmoney f43 is quoted in cents. Never infer the unit from magnitude: ¥9.23 arrives as 923.
  function parseEastmoney(body, code) {
    const data = body && body.data;
    if (!data) throw new Error('东方财富行情返回为空');
    const price = Number(data.f43) / 100;
    if (!Number.isFinite(price) || price <= 0) throw new Error('东方财富价格无效（可能停牌或无权限）');
    return { code, price, name: data.f58 || '', source: '东方财富' };
  }
  const api = { tencentSymbol, eastmoneySecId, tencentUrl, parseTencent, parseEastmoney };
  root.JisiluQuotes = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
