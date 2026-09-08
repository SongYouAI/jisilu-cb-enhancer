const test = require('node:test');
const assert = require('node:assert/strict');
const { roundSharesForBoard, lotShares } = require('../core/rounding.js');
const { calculateFunding, calculateSafetyCushion, calculateLiquidity } = require('../core/calc.js');
const { safetyClass, validateThresholds } = require('../core/color.js');

test('主板及创业板按 100 股整手向上取整', () => {
  assert.equal(roundSharesForBoard(1, 'MAIN'), 100);
  assert.equal(roundSharesForBoard(100, 'CYB'), 100);
  assert.equal(roundSharesForBoard(101, 'MAIN'), 200);
});
test('科创板 200 股起，超出部分可一股递增', () => {
  assert.equal(roundSharesForBoard(1, 'KCB'), 200);
  assert.equal(roundSharesForBoard(200, 'KCB'), 200);
  assert.equal(roundSharesForBoard(201.2, 'KCB'), 202);
  assert.equal(lotShares('KCB'), 200);
});
test('资金金额使用实际可买入股数而非理论股数', () => {
  const funding = calculateFunding({ requiredShares: 101, stockPrice: 10.5, market: 'MAIN' });
  // 满额（配 1 手转债=10 张）资金 = 200 股 × 10.5 = 2100
  // 1 手正股（100 股）资金 = 100 × 10.5 = 1050；可配转债 = 100×10/101 ≈ 9.90 张
  assert.equal(funding.actualAmount, 2100);
  assert.equal(funding.oneLotAmount, 1050);
  assert.equal(funding.lotShares, 100);
  assert.equal(funding.theoreticalAmount, 1060.5);
  assert.ok(Math.abs(funding.bondsPerLot - 1000 / 101) < 1e-9);
});
test('安全垫计算满额与一手两个口径（满额=配1手10张；一手=1手正股100股）', () => {
  const funding = calculateFunding({ requiredShares: 1000, stockPrice: 10, market: 'MAIN' });
  // 满额资金 = 1000 股 × 10 = 10000；1 手正股(100股)资金 = 100 × 10 = 1000
  // 1 手正股可配转债 = 100×10/1000 = 1 张；每张盈利 = 800/10 = 80
  const result = calculateSafetyCushion({ funding, estimatedProfitTen: 800 });
  assert.equal(result.fullRate, 800 / 10000);    // 满额安全垫 8.00%
  assert.equal(result.oneLotProfit, 80);         // 1 手正股配 1 张债的盈利
  assert.equal(result.oneLotRate, 80 / 1000);    // 1 手安全垫 8.00%（此处满额=10手正股，故相等）
});
test('未填预估盈利时不伪造安全垫', () => {
  const funding = calculateFunding({ requiredShares: 100, stockPrice: 10, market: 'MAIN' });
  assert.deepEqual(calculateSafetyCushion({ funding, estimatedProfitTen: null, requiredShares: 100 }), { estimatedProfitTen: null, fullRate: null, oneLotRate: null, oneLotProfit: null });
});
test('流通规模的锁定额按三个输入计算', () => {
  assert.deepEqual(calculateLiquidity({ issueSize: 10, restrictedRatio: 20, allocationRatio: 90 }), { issueSize: 10, lockedAmount: 1.8, estimatedFloat: 8.2 });
});
test('安全垫颜色边界固定且可验证', () => {
  const t = [0.02, 0.04, 0.06, 0.08];
  assert.equal(safetyClass(0.0199, t), 'danger'); assert.equal(safetyClass(0.02, t), 'warning');
  assert.equal(safetyClass(0.04, t), 'caution'); assert.equal(safetyClass(0.06, t), 'good'); assert.equal(safetyClass(0.08, t), 'excellent');
  assert.throws(() => validateThresholds([0.02, 0.04, 0.04, 0.08]));
});
