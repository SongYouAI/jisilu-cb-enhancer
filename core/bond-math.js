/*
 * bond-math.js — 转债估值纯函数库（浏览器/Node 通用）
 * 职责：
 *   1. 解析东财条款文字：票息结构 / 到期赎回价 / 回售条款
 *   2. 构造剩余现金流（中间票息 + 到期赎回价(含末息)）
 *   3. 纯债价值（XNPV，贴现率用集思录 ref_yield_info 的同评级 YTM）
 *   4. 回售收益率（假设回售期首日触发，YTM 二分法解方程，税前）
 *   5. 正股年化波动率（日收益率样本标准差 × √250）
 * 口径参考：集思录公开算法（雪球/东财财富号文章）+ 中债估值说明。
 */
(function (root) {
  'use strict';

  // ---------- 1. 票息结构解析 ----------
  // 输入："第一年0.20%、第二年0.40%..." 或变体 "第一年为0.2%、第二年为0.4%..."
  // 输出：[0.2, 0.4, 0.8, 1.5, 2.0, 2.5]（元/张，面值 100）
  function parseCoupons(text) {
    if (!text) return [];
    var out = [];
    var re = /第[一二三四五六七八九十\d]+年(?:为)?\s*(\d+(?:\.\d+)?)\s*%/g;
    var m;
    while ((m = re.exec(text)) !== null) out.push(parseFloat(m[1]));
    return out;
  }

  // ---------- 2. 到期赎回价解析 ----------
  // 覆盖变体："面值的110%（含最后一期利息）" / "票面面值110.00%（含最后一期年度利息）"
  // 注意排除「有条件赎回」段的 130%（强赎触发价，非到期赎回价）。
  function parseRedeemPrice(clause) {
    if (!clause) return null;
    // 只在「有条件赎回」出现之前的文本里找（到期赎回条款通常排第 1 段）
    var head = clause.split(/有条件赎回|强制赎回/)[0];
    var m = head.match(/面值[的]?\s*(\d+(?:\.\d+)?)\s*%/);
    if (m) return parseFloat(m[1]);
    return null;
  }

  // ---------- 3. 回售条款解析 ----------
  // 返回 { lastYears: 1|2|3, triggerPct: 0.70, price: 103|null }
  //   price 为 null 表示「面值 100 + 当期利息」；为数字表示按面值 X%（已含当期利息）
  // 覆盖变体：「最后两个计息年度」「最后一个计息年度」（润禾转02 等新债）
  // 无回售条款（银行/券商债）返回 null
  function parseResale(clause) {
    if (!clause) return null;
    var years = clause.match(/最后([一两二三\d])\s*个?计息年度/);
    if (!years) return null;
    var CN = { '一': 1, '两': 2, '二': 2, '三': 3 };
    var lastYears = CN[years[1]] || parseInt(years[1], 10) || 2;
    var pct = clause.match(/(\d+(?:\.\d+)?)\s*%\s*时/);
    var triggerPct = pct ? parseFloat(pct[1]) / 100 : 0.70;
    var priceM = clause.match(/面值的\s*(\d+(?:\.\d+)?)\s*%[\s\S]{0,20}?回售/);
    var price = priceM ? parseFloat(priceM[1]) : null;
    return { lastYears: lastYears, triggerPct: triggerPct, price: price };
  }

  // ---------- 4. 剩余现金流构造 ----------
  // terms: { coupons:[元/张...], valueDate:'YYYY-MM-DD', maturityDate:'YYYY-MM-DD',
  //          redeemPrice:Number(含末息), baseDate:'YYYY-MM-DD' }
  // 输出：[{date, amount}]：未付的中间票息 + 到期赎回价（含末息，故末息不再单列）
  function buildRemainingCashflows(terms) {
    var coupons = terms.coupons || [];
    var base = toTime(terms.baseDate);
    var maturity = toTime(terms.maturityDate);
    if (!coupons.length || !(maturity > base)) return [];
    var cf = [];
    for (var i = 1; i <= coupons.length; i++) {
      var payDate = addYears(terms.valueDate, i);
      var t = toTime(payDate);
      if (t > maturity) break;
      if (t <= base) continue; // 已付
      if (t >= maturity) break; // 到期日现金流走 redeemPrice（含末息）
      cf.push({ date: payDate, amount: coupons[i - 1] });
    }
    cf.push({ date: terms.maturityDate, amount: terms.redeemPrice });
    return cf;
  }

  function toTime(d) {
    return d instanceof Date ? d.getTime() : new Date(d + 'T00:00:00').getTime();
  }
  function toISO(ms) {
    var d = new Date(ms);
    var m = ('0' + (d.getMonth() + 1)).slice(-2);
    var day = ('0' + d.getDate()).slice(-2);
    return d.getFullYear() + '-' + m + '-' + day;
  }
  function addYears(dateISO, n) {
    var d = new Date(dateISO + 'T00:00:00');
    d.setFullYear(d.getFullYear() + n);
    return toISO(d.getTime());
  }

  // ---------- 5. 纯债价值（XNPV） ----------
  // params: { cashflows:[{date, amount}], ytm: 小数, baseDate }
  function pureBondValue(params) {
    var cf = params.cashflows || [];
    if (!cf.length) return 0;
    var d0 = toTime(params.baseDate);
    var pv = 0;
    for (var i = 0; i < cf.length; i++) {
      var y = (toTime(cf[i].date) - d0) / (365 * 24 * 3600 * 1000);
      if (y < -1e-9) continue;
      pv += cf[i].amount / Math.pow(1 + params.ytm, y);
    }
    return pv;
  }

  // ---------- 6. 回售收益率（YTM 二分法，税前） ----------
  // params: { price, cashflows:[{t: 年(小数), amount}] }
  // 解 r 使 Σ amount/(1+r)^t = price；r ∈ (-0.95, 10)
  function resaleYield(params) {
    var cf = params.cashflows || [];
    var price = params.price;
    if (!cf.length || !(price > 0)) return NaN;
    function pv(r) {
      var sum = 0;
      for (var i = 0; i < cf.length; i++) sum += cf[i].amount / Math.pow(1 + r, cf[i].t);
      return sum;
    }
    var lo = -0.95, hi = 10;
    if (pv(lo) < price) return NaN; // 即便利率 -95% 现值仍低于价格，无实数解
    for (var i = 0; i < 100; i++) {
      var mid = (lo + hi) / 2;
      if (pv(mid) > price) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // ---------- 7. 年化波动率 ----------
  // closes: 日收盘价数组（时间升序）→ 日收益率样本标准差 × √250
  function annualizedVolatility(closes) {
    if (!closes || closes.length < 2) return NaN;
    var rets = [];
    for (var i = 1; i < closes.length; i++) {
      if (closes[i - 1] > 0 && closes[i] > 0) rets.push(closes[i] / closes[i - 1] - 1);
    }
    if (rets.length < 2) return NaN;
    var mean = rets.reduce(function (s, x) { return s + x; }, 0) / rets.length;
    var variance = rets.reduce(function (s, x) { return s + (x - mean) * (x - mean); }, 0) / (rets.length - 1);
    return Math.sqrt(variance) * Math.sqrt(250);
  }

  // ---------- 8. 解析集思录 ref_yield_info ----------
  // 输入："计算使用6.1年期 评级为A+ 债参考YTM：5.3604" → 0.053604；失败返回 null
  function parseRefYield(text) {
    if (!text) return null;
    var m = String(text).match(/YTM[：:]\s*(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) / 100 : null;
  }

  // ---------- 8b. 评级 → XNPV 贴现率（近似中债企业债 YTM，%） ----------
  // 与 bond-valuator 同表；当接口 ref_yield_info 不可得（翻页/无接口）时的统一口径。
  var RATING_YTM = {
    'AAA': 2.0, 'AA+': 2.4, 'AA': 3.0, 'AA-': 3.8, 'A+': 4.8, 'A': 5.8,
    'BBB+': 7.0, 'BBB': 7.5, 'BBB-': 9.0, 'BB': 12.0, 'B': 15.0, 'C': 20.0
  };
  // 返回小数形式贴现率（如 0.03）；未知评级按 AA(3.0%) 兜底
  function discountFor(rating) {
    var key = String(rating || '').trim().toUpperCase();
    var pct = RATING_YTM[key] != null ? RATING_YTM[key] : 3.0;
    return pct / 100;
  }

  // ---------- 9. 组合：从条款对象到纯债价值（一站式） ----------
  // args: { coupons, valueDate, maturityDate, redeemPrice, ytm, baseDate }
  function pureBondFromTerms(args) {
    var cf = buildRemainingCashflows({
      coupons: args.coupons, valueDate: args.valueDate,
      maturityDate: args.maturityDate, redeemPrice: args.redeemPrice,
      baseDate: args.baseDate
    });
    return { cashflows: cf, value: pureBondValue({ cashflows: cf, ytm: args.ytm, baseDate: args.baseDate }) };
  }

  // ---------- 10. 回售收益率（从条款到数值，一站式） ----------
  // args: { price, coupons, valueDate, maturityDate, resale:{lastYears, price|null},
  //         yearLeft, baseDate }
  // 逻辑：回售日 = 到期日 - lastYears 年；已在回售期则视为立即触发（t 小量）。
  //       现金流 = 回售日前未付票息 + 回售日(回售价)；回售价 = resale.price || (100 + 当年票息)
  function resaleYieldFromTerms(args) {
    if (!args.resale || !(args.price > 0)) return NaN;
    var base = toTime(args.baseDate);
    var maturity = toTime(args.maturityDate);
    var resaleTime = addYearsTime(args.maturityDate, -args.resale.lastYears);
    if (resaleTime <= base) resaleTime = base + 30 * 24 * 3600 * 1000; // 已在回售期 → 约 30 个自然日后触发
    var cf = [];
    var coupons = args.coupons || [];
    for (var i = 1; i <= coupons.length; i++) {
      var payTime = toTime(addYears(args.valueDate, i));
      if (payTime <= base || payTime >= resaleTime) continue;
      cf.push({ t: (payTime - base) / (365 * 24 * 3600 * 1000), amount: coupons[i - 1] });
    }
    // 回售日当年票息（按回售日落在第几个计息年度确定）
    var yearIdx = Math.min(coupons.length, Math.max(1, Math.ceil((resaleTime - toTime(args.valueDate)) / (365 * 24 * 3600 * 1000))));
    var yearCoupon = coupons[yearIdx - 1] || 0;
    var resalePrice = args.resale.price != null ? args.resale.price : 100 + yearCoupon;
    cf.push({ t: (resaleTime - base) / (365 * 24 * 3600 * 1000), amount: resalePrice });
    return resaleYield({ price: args.price, cashflows: cf });
  }
  function addYearsTime(dateISO, n) {
    var d = new Date(dateISO + 'T00:00:00');
    d.setFullYear(d.getFullYear() + n);
    return d.getTime();
  }

  const api = {
    parseCoupons, parseRedeemPrice, parseResale,
    buildRemainingCashflows, pureBondValue, resaleYield,
    annualizedVolatility, parseRefYield,
    pureBondFromTerms, resaleYieldFromTerms,
    RATING_YTM, discountFor
  };
  root.JisiluBondMath = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
