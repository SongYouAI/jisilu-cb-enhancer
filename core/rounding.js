(function (root) {
  'use strict';
  function finitePositive(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} 必须是大于 0 的数字`);
    return number;
  }
  function normaliseMarket(market) { return String(market || '').toUpperCase(); }
  function roundSharesForBoard(requiredShares, market) {
    const shares = finitePositive(requiredShares, '所需股数');
    const board = normaliseMarket(market);
    if (board === 'KCB' || board === 'STAR' || board === '科创板') return Math.max(200, Math.ceil(shares));
    return Math.ceil(shares / 100) * 100;
  }
  function lotShares(market) { return ['KCB', 'STAR', '科创板'].includes(normaliseMarket(market)) ? 200 : 100; }
  const api = { roundSharesForBoard, lotShares };
  root.JisiluRounding = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
