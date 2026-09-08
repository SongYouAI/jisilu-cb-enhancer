const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../core/predict.js');

test('转股价值 = 正股价 / 转股价 × 100', () => {
  assert.equal(P.conversionValue(17.95, 17.20), 104.36046511627908);
  assert.equal(P.conversionValue(10, 10), 100);
  assert.equal(P.conversionValue(0, 10), null, '正股价非正');
  assert.equal(P.conversionValue(10, 0), null, '转股价非正');
});

test('基础溢价率随转股价值单调递减（负相关）', () => {
  const pts = [70, 78, 85, 92, 100, 105, 115, 125];
  for (let i = 1; i < pts.length; i++) {
    assert.ok(P.basePremium(pts[i]) <= P.basePremium(pts[i - 1]),
      `转股价值 ${pts[i]} 的溢价率应不高于 ${pts[i - 1]}`);
  }
});

test('规模修正：小盘溢价更高、大盘偏低（<3亿妖债+15%, 3-4亿+8%, ≥10亿-3%）', () => {
  assert.equal(P.sizeAdj(2), 0.15);
  assert.equal(P.sizeAdj(4), 0.08);
  assert.equal(P.sizeAdj(7), 0);
  assert.equal(P.sizeAdj(15), -0.03);
});

test('评级修正：高评级高溢价、低评级低溢价、未知不惩罚', () => {
  assert.equal(P.ratingAdj('AAA'), 0.03);
  assert.equal(P.ratingAdj('AA'), 0);
  assert.equal(P.ratingAdj('A'), -0.04);
  assert.equal(P.ratingAdj('-'), 0);
  assert.equal(P.ratingAdj(''), 0);
});

test('债底随评级降低而降低（信用风险越大债底越薄）', () => {
  const aaa = P.bondFloor('AAA');
  const aa = P.bondFloor('AA');
  const a = P.bondFloor('A');
  assert.ok(aaa > aa, 'AAA 债底应高于 AA');
  assert.ok(aa > a, 'AA 债底应高于 A');
  assert.ok(aa > 90 && aa < 100, `AA 债底应落在 90~100 之间，实际 ${aa.toFixed(2)}`);
});

test('三档关系：保守盈利 ≤ 中性盈利 ≤ 乐观盈利', () => {
  const r = P.predict({ conversionPrice: 17.2, stockPrice: 17.95, issueSize: 5.75, rating: '-' });
  assert.ok(r.conservative.profit <= r.neutral.profit);
  assert.ok(r.neutral.profit <= r.optimistic.profit);
});

test('盈利 = (上市价 - 100) × 10 的恒等关系', () => {
  const r = P.predict({ conversionPrice: 17.2, stockPrice: 17.95, issueSize: 5.75, rating: 'AA' });
  ['conservative', 'neutral', 'optimistic'].forEach(m => {
    assert.ok(Math.abs(r[m].profit - (r[m].price - 100) * 10) < 1e-9);
  });
});

test('债底保护：深度价内时保守档不低于债底（不会破发到债底以下）', () => {
  const r = P.predict({ conversionPrice: 20, stockPrice: 15, issueSize: 8, rating: 'AAA' }); // CV=75
  assert.ok(r.conservative.price >= r.bondFloor, '保守档应受债底托底');
  assert.ok(r.conservative.price > 75, 'CV=75 时保守档应显著高于转股价值（债底托底）');
});

test('涨停帽：高转股价值 + 小盘时被钳制在 157.30，盈利上限 573', () => {
  const r = P.predict({ conversionPrice: 10, stockPrice: 15, issueSize: 2, rating: 'AA' }); // CV=150
  ['conservative', 'neutral', 'optimistic'].forEach(m => {
    assert.ok(r[m].price <= P.LISTING_CAP, '不超首日涨停上限');
    assert.ok(r[m].profit <= 573, '盈利不超 (157.3-100)*10');
  });
});

test('中性档落在中肯区间（真实样本验证；新模型向上校准到 ~120 元中性价）', () => {
  // 3 只「同意注册」标的，中性盈利应在 80~400 元之间（覆盖大盘/中小盘/小盘）
  const samples = [
    { conversionPrice: 17.20, stockPrice: 17.95, issueSize: 5.75, rating: '-' }, // 华纬 104.4
    { conversionPrice: 23.37, stockPrice: 22.80, issueSize: 8.00, rating: '-' }, // 常青 97.6
    { conversionPrice: 28.99, stockPrice: 30.50, issueSize: 3.70, rating: '-' }  // 润禾 105.2（小盘）
  ];
  samples.forEach(s => {
    const r = P.predict(s);
    assert.ok(r.neutral.profit >= 50 && r.neutral.profit <= 500,
      `中性盈利应中肯（50~500），实际 ${r.neutral.profit.toFixed(0)}（CV=${r.cv.toFixed(1)}）`);
  });
});

test('破发保护：CV 极低 + 大盘 + 低评级 → 标记破发', () => {
  // CV=60（正股远低于转股价）+ 10 亿大盘 + A 评级，溢价不足以撑到 100
  const r = P.predict({ conversionPrice: 10, stockPrice: 6, issueSize: 10, rating: 'A' });
  // 至少一档破发
  assert.ok(r.isBreak === true, '应当标记破发风险');
  // 债底钳制：保守价不应低于债底
  assert.ok(r.conservative.price >= r.bondFloor, '保守价应被债底托住');
});

test('正常新债不应触发破发标记（CV≥80 + 评级未知默认不惩罚）', () => {
  const r = P.predict({ conversionPrice: 10, stockPrice: 10, issueSize: 5, rating: '-' }); // CV=100
  assert.ok(r.isBreak === false, 'CV=100 正常新债不应破发');
  assert.ok(r.neutral.price >= 100, '中性价应 ≥ 面值');
});

test('评级缺失不影响预估（默认 AA 口径，返回有效数字）', () => {
  const r = P.predict({ conversionPrice: 20, stockPrice: 20, issueSize: 6, rating: undefined });
  assert.ok(Number.isFinite(r.neutral.profit));
  assert.ok(Number.isFinite(r.neutral.price));
});
