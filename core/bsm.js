/*
 * bsm.js — B-S 欧式期权 + XNPV 贴现（纯函数，浏览器/Node 通用）
 * 移植自 bond-valuator/js/bsm.js（已单测验证），供转债列表页计算期权价值/纯债价值。
 * 约定：XNPV 按 Excel 式年复利贴现 PV = Σ amount/(1+rate)^(days/365)；
 *       B-S 用年化小数参数（r、sigma 均为小数，T 为年）。
 */
(function (root) {
  'use strict';

  // 标准正态分布累计概率 N(x) — Abramowitz & Stegun 26.2.17 近似
  function normCDF(x) {
    var t = 1 / (1 + 0.2316419 * Math.abs(x));
    var d = 0.3989422804014327 * Math.exp(-x * x / 2);
    var p =
      d * t * (0.319381530 +
      t * (-0.356563782 +
      t * (1.781477937 +
      t * (-1.821255978 +
      t * 1.330274429))));
    return x >= 0 ? 1 - p : p;
  }

  // Black-Scholes 欧式看涨期权（单股）
  function bsCall(S, K, r, sigma, T) {
    if (T <= 0 || sigma <= 0) return Math.max(S - K, 0);
    var sqrtT = Math.sqrt(T);
    var d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
    var d2 = d1 - sigma * sqrtT;
    return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
  }

  function toTime(d) {
    return d instanceof Date ? d.getTime() : new Date(d + 'T00:00:00').getTime();
  }

  // Excel 式 XNPV：cashflows = [{date, amount}]，按 baseDate 贴现
  function xnpv(cashflows, rate, baseDate) {
    if (!cashflows || !cashflows.length) return 0;
    var d0 = toTime(baseDate || cashflows[0].date);
    var pv = 0;
    for (var i = 0; i < cashflows.length; i++) {
      var y = (toTime(cashflows[i].date) - d0) / (365 * 24 * 3600 * 1000);
      if (y < -1e-9) continue;
      pv += cashflows[i].amount / Math.pow(1 + rate, y);
    }
    return pv;
  }

  // 转股比例（股/张）= 面值 100 / 转股价
  function conversionRatio(K) { return K > 0 ? 100 / K : 0; }
  // 转股价值 = 正股价 × 转股比例
  function conversionValue(S, K) { return S * conversionRatio(K); }
  // 偏离度 = (市价 - 理论) / 理论，正=高估
  function deviation(marketPrice, theory) {
    return theory > 0 ? (marketPrice - theory) / theory : NaN;
  }

  const api = { normCDF, bsCall, xnpv, toTime, conversionRatio, conversionValue, deviation };
  root.JisiluBSM = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
