(function (root) {
  'use strict';
  /*
   * predict.js — 上市首日盈利预估引擎（纯函数，浏览器/Node 通用）
   *
   * 两层模型（合并「经验法」与「理论定价」）：
   *   底层锚（经验法）  ：转股价值 → 上市首日基础溢价率，来自历史首日成交价反推，
   *                       是「打新者首日卖出 vs 游资承接」的博弈定价，最贴近我们要预测的目标。
   *   边界校准（理论法）：债底（纯债价值 XNPV）作保守下限、首日涨停 157.30 与强赎顶作乐观上限。
   *                       这两个边界是经验曲线给不了的，来自 bond-valuator 的期权定价模型认知。
   *
   * 为什么不用 LSM 理论价值直接当首日价：LSM 算的是「理性持有 6 年的完整期权价值」，
   * 系统性高于「首日抛售博弈价」（实测 CV=100 时 LSM≈122、现实首日≈110-120）。
   * 故 LSM/债底只作「边界」，不作「锚」。
   *
   * 关键诚实点（写入 tooltip）：预估盈利是模型参考，非承诺；转股价在发行前会按正股均价重定。
   */

  // 评级 → 纯债贴现率（%，近似中债企业债收益率；数据同 bond-valuator/js/data.js）
  var RATING_DISCOUNT = {
    'AAA': 2.0, 'AA+': 2.4, 'AA': 3.0, 'AA-': 3.8, 'A+': 4.8, 'A': 5.8,
    'BBB+': 7.0, 'BBB': 7.5, 'BBB-': 9.0, 'BB': 12.0
  };
  // 评级 → 首日溢价率修正（高评级债底厚、更抗破发，市场愿给略高溢价）
  var RATING_ADJ = {
    'AAA': 0.03, 'AA+': 0.02, 'AA': 0.00, 'AA-': -0.01, 'A+': -0.03, 'A': -0.04
  };
  // 情绪档位 → 溢价率修正
  var MOOD_ADJ = { conservative: -0.03, neutral: 0.00, optimistic: 0.05 };
  var LISTING_CAP = 157.30; // 沪/深可转债上市首日涨幅上限 +57.3%
  var FACE = 100;           // 面值

  // 标准待发转债条款（6 年期、梯度票息；募集说明书未披露前的合理默认）
  var STD_COUPONS = [0.2, 0.4, 0.8, 1.2, 1.6, 2.0];
  var STD_REDEMPTION = 108; // 到期赎回价（含补偿利率）

  function num(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  // 金额归整到分，消除浮点毛刺（157.3-100 会得到 57.3000000001）
  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  // 转股价值 = 正股价 / 转股价 × 100
  function conversionValue(stockPrice, conversionPrice) {
    var s = num(stockPrice), k = num(conversionPrice);
    if (s === null || s <= 0 || k === null || k <= 0) return null;
    return s / k * 100;
  }

  // 上市首日基础溢价率（转股价值 → 溢价，经验曲线，向上校准到 2024-2025 实际首日均价 ~121）
  // 老板策略依据：小盘（<4 亿）妖债开盘常顶 157.3；大票/低评级上市首日破发概率约 1.6%
  // 形状依据：转股价值越低，债底托底 → 溢价越高；转股价值越高，强赎压顶 → 溢价趋零。
  function basePremium(cv) {
    if (cv >= 130) return 0.00;     // 强赎压顶
    if (cv >= 120) return 0.05;     // CV=120 中性价 126
    if (cv >= 110) return 0.12;     // CV=110 中性价 123
    if (cv >= 100) return 0.20;     // CV=100 中性价 120（2024-2025 实际首日均价 121）
    if (cv >= 92)  return 0.28;
    if (cv >= 85)  return 0.35;
    if (cv >= 78)  return 0.42;
    return 0.50;                    // 极低价债债底托底，溢价高
  }

  // 规模修正：小盘易被游资炒作，大盘溢价偏低
  function sizeAdj(size) {
    var s = num(size);
    if (s === null) return 0;
    if (s >= 10) return -0.03;     // 10 亿+ 大盘债
    if (s > 4)  return 0.00;
    if (s >= 3)  return 0.08;      // 3-4 亿（准妖债）
    return 0.15;                    // <3 亿（妖债高发）
  }

  function ratingAdj(rating) {
    var r = String(rating || '').trim().toUpperCase();
    return RATING_ADJ[r] != null ? RATING_ADJ[r] : 0; // 未知评级不惩罚
  }

  // 债底（纯债价值）：标准票息按评级贴现率 XNPV 折现。理论下限。
  function bondFloor(rating) {
    var r = String(rating || '').trim().toUpperCase();
    var disc = (RATING_DISCOUNT[r] != null ? RATING_DISCOUNT[r] : 3.0) / 100;
    var pv = 0;
    for (var i = 0; i < STD_COUPONS.length; i++) {
      pv += STD_COUPONS[i] / Math.pow(1 + disc, i + 1);
    }
    pv += STD_REDEMPTION / Math.pow(1 + disc, STD_COUPONS.length);
    return pv;
  }

  // 单档预估
  function estimateMood(cv, premium, mood) {
    var p = premium + (MOOD_ADJ[mood] != null ? MOOD_ADJ[mood] : 0);
    var price = cv * (1 + p);
    return price;
  }

  /*
   * predict(params) — 主入口
   * params: {
   *   conversionPrice,  // 转股价（页面「转股价」列）
   *   stockPrice,       // 正股价（行情/页面）
   *   issueSize,        // 发行规模（亿元，页面「发行规模(亿元)」列）
   *   rating,           // 评级（页面「评级」列，待发阶段常为「-」）
   *   mood              // 可选：'conservative' | 'neutral' | 'optimistic'，默认 neutral
   * }
   * 返回：{ cv, bondFloor, premium, sizeAdj, ratingAdj,
   *         conservative:{price,profit}, neutral:{price,profit}, optimistic:{price,profit} }
   */
  function predict(params) {
    if (!params) throw new Error('predict 缺少参数');
    var cv = conversionValue(params.stockPrice, params.conversionPrice);
    if (cv === null) throw new Error('转股价值无法计算（转股价或正股价缺失）');
    var base = basePremium(cv);
    var size = sizeAdj(params.issueSize);
    var rate = ratingAdj(params.rating);
    var premium = base + size + rate;
    var floor = bondFloor(params.rating);

    function clamp(price) {
      return Math.min(Math.max(price, floor), LISTING_CAP);
    }
    function profit(price) { return (price - FACE) * 10; }

    var moods = ['conservative', 'neutral', 'optimistic'];
    var out = { cv: cv, bondFloor: round2(floor), basePremium: base, sizeAdj: size, ratingAdj: rate, premium: premium };
    out.breakCount = 0; // 三档里有几档破发（< 100 元）
    for (var i = 0; i < moods.length; i++) {
      var m = moods[i];
      var price = round2(clamp(estimateMood(cv, premium, m)));
      if (price < FACE) out.breakCount++;
      out[m] = { price: price, profit: round2(profit(price)) };
    }
    out.isBreak = out.breakCount > 0; // 至少一档破发就标记
    return out;
  }

  // 供 UI 展示推导过程的分解
  function breakdown(params) {
    var r = predict(params);
    return {
      转股价值: r.cv,
      基础溢价率: r.basePremium,
      规模修正: r.sizeAdj,
      评级修正: r.ratingAdj,
      债底: r.bondFloor,
      中性上市价: r.neutral.price,
      中性盈利: r.neutral.profit
    };
  }

  var api = {
    conversionValue: conversionValue,
    basePremium: basePremium,
    sizeAdj: sizeAdj,
    ratingAdj: ratingAdj,
    bondFloor: bondFloor,
    predict: predict,
    breakdown: breakdown,
    RATING_DISCOUNT: RATING_DISCOUNT,
    LISTING_CAP: LISTING_CAP
  };
  root.JisiluPredict = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
