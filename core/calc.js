(function (root) {
  'use strict';
  const rounding = root.JisiluRounding || (typeof require !== 'undefined' && require('./rounding.js'));
  // `Number(null)` and `Number('')` both equal zero; settings blanks must remain missing values.
  function numberOrNull(value) {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
    const n = Number(value); return Number.isFinite(n) ? n : null;
  }
  function percent(value, name) {
    const n = numberOrNull(value);
    if (n === null || n < 0 || n > 100) throw new Error(`${name} 必须在 0 到 100 之间`);
    return n / 100;
  }
  function calculateFunding({ requiredShares, stockPrice, market }) {
    const price = numberOrNull(stockPrice);
    if (price === null || price <= 0) throw new Error('正股现价必须大于 0');
    const actualShares = rounding.roundSharesForBoard(requiredShares, market);
    const theoreticalShares = numberOrNull(requiredShares);
    if (theoreticalShares === null || theoreticalShares <= 0) throw new Error('所需股数无效');
    const lot = rounding.lotShares(market); // 1 手正股股数（主板/创业板 100、科创板 200）
    return {
      theoreticalShares,
      actualShares,
      theoreticalAmount: theoreticalShares * price,
      actualAmount: actualShares * price,          // 满额：配 1 手转债（10 张）所需资金
      lotShares: lot,
      oneLotAmount: lot * price,                    // 1 手正股（最小买入单位）所需资金
      bondsPerLot: (lot * 10) / theoreticalShares   // 1 手正股可配到的转债张数
    };
  }
  // estimatedProfitTen is the user's total expected profit when the "10 bonds" target is met.
  // 满额安全垫 = 盈利 ÷ 配 1 手(10张)资金；一手安全垫 = 1 手正股维度（配到的张数 × 每张利润 ÷ 1手正股资金）。
  function calculateSafetyCushion({ funding, estimatedProfitTen }) {
    const profit = numberOrNull(estimatedProfitTen);
    if (!funding || !Number.isFinite(funding.actualAmount) || funding.actualAmount <= 0) throw new Error('配债所需金额无效');
    if (profit === null) return { estimatedProfitTen: null, fullRate: null, oneLotRate: null, oneLotProfit: null };
    const oneLotProfit = funding.bondsPerLot * (profit / 10); // 1 手正股配到的转债盈利
    return {
      estimatedProfitTen: profit,
      fullRate: profit / funding.actualAmount,
      oneLotProfit,
      oneLotRate: oneLotProfit / funding.oneLotAmount
    };
  }
  function calculateLiquidity({ issueSize, restrictedRatio, allocationRatio }) {
    const size = numberOrNull(issueSize);
    if (size === null || size < 0) throw new Error('发行规模必须是非负数字');
    const lockedAmount = size * percent(restrictedRatio, '限售比例') * percent(allocationRatio, '预估配售比例');
    return { issueSize: size, lockedAmount, estimatedFloat: size - lockedAmount };
  }
  const api = { numberOrNull, calculateFunding, calculateSafetyCushion, calculateLiquidity };
  root.JisiluCalc = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
