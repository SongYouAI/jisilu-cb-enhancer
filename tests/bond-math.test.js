/*
 * tests/bond-math.test.js — 条款解析 + 纯债价值 + 回售收益率 + 波动率
 * 验证基准来自公开文章（雪球/东财财富号）给出的手算案例。
 */
const test = require('node:test');
const assert = require('node:assert');

const BSM = require('../core/bsm.js');
const M = require('../core/bond-math.js');

// ---------- 票息解析 ----------
test('parseCoupons: 标准六段式', () => {
  const text = '第一年0.20%、第二年0.40%、第三年0.80%、第四年1.50%、第五年2.00%、第六年2.50%。';
  assert.deepStrictEqual(M.parseCoupons(text), [0.2, 0.4, 0.8, 1.5, 2.0, 2.5]);
});
test('parseCoupons: 带前缀长句', () => {
  const text = '本次发行的可转债票面利率为:第一年0.10%、第二年0.30%、第三年0.60%、第四年1.00%、第五年1.50%、第六年2.00%。';
  assert.deepStrictEqual(M.parseCoupons(text), [0.1, 0.3, 0.6, 1.0, 1.5, 2.0]);
});
test('parseCoupons: 「年为」变体（长高转债/神宇转债格式）', () => {
  const text = '第一年为0.2%、第二年为0.4%、第三年为0.6%、第四年为1.0%、第五年为1.5%、第六年为2.0%。';
  assert.deepStrictEqual(M.parseCoupons(text), [0.2, 0.4, 0.6, 1.0, 1.5, 2.0]);
});
test('parseCoupons: 空/异常输入返回空数组', () => {
  assert.deepStrictEqual(M.parseCoupons(''), []);
  assert.deepStrictEqual(M.parseCoupons(null), []);
  assert.deepStrictEqual(M.parseCoupons('无固定利率'), []);
});

// ---------- 到期赎回价解析 ----------
test('parseRedeemPrice: 面值的110%（含最后一期利息）', () => {
  const clause = '1、到期赎回条款在本次发行的可转换公司债券期满后五个交易日内,公司将按债券面值的110%(含最后一期利息)赎回全部未转股的可转换公司债券。';
  assert.strictEqual(M.parseRedeemPrice(clause), 110);
});
test('parseRedeemPrice: 106%', () => {
  assert.strictEqual(M.parseRedeemPrice('按债券面值的106%赎回'), 106);
});
test('parseRedeemPrice: 「票面面值110.00%」变体（奥普/鼎通转债格式）', () => {
  const clause = '1、到期赎回条款在本次可转债期满后五个交易日内,公司将以本次可转债票面面值110.00%(含最后一期年度利息)的价格赎回全部未转股的本次可转债。2、有条件赎回条款...130%...';
  assert.strictEqual(M.parseRedeemPrice(clause), 110);
});
test('parseRedeemPrice: 「票面面值113%」变体', () => {
  const clause = '1、到期赎回条款...公司将以本次可转换公司债券的票面面值113%(含最后一期年度利息)的价格...赎回。2、有条件赎回条款...';
  assert.strictEqual(M.parseRedeemPrice(clause), 113);
});
test('parseRedeemPrice: 空输入返回 null', () => {
  assert.strictEqual(M.parseRedeemPrice(''), null);
  assert.strictEqual(M.parseRedeemPrice(null), null);
});

// ---------- 回售条款解析 ----------
test('parseResale: 标准最后两年 70% 条款', () => {
  const clause = '在本次发行的可转换公司债券最后两个计息年度,如果公司股票在任何连续三十个交易日的收盘价格低于当期转股价格的70%时,可转换公司债券持有人有权将其持有的可转换公司债券全部或部分按债券面值加当期应计利息的价格回售给公司。';
  const r = M.parseResale(clause);
  assert.strictEqual(r.lastYears, 2);
  assert.strictEqual(r.triggerPct, 0.70);
  // 回售价 = 面值 + 当期利息（price 字段为 null 表示按面值+利息）
  assert.strictEqual(r.price, null);
});
test('parseResale: 103% 回售', () => {
  const clause = '最后两个计息年度,连续三十个交易日低于当期转股价格的70%时,按面值的103%(含当期计息年度利息)回售给公司';
  const r = M.parseResale(clause);
  assert.strictEqual(r.lastYears, 2);
  assert.strictEqual(r.triggerPct, 0.70);
  assert.strictEqual(r.price, 103);
});
test('parseResale: 无回售条款（银行/券商债）返回 null', () => {
  assert.strictEqual(M.parseResale(''), null);
  assert.strictEqual(M.parseResale(null), null);
});
test('parseResale: 「最后一个计息年度」变体（润禾转02 格式）', () => {
  const clause = '1、有条件回售条款本次发行的可转债最后一个计息年度,如果公司股票在任意连续三十个交易日的收盘价格低于当期转股价格的70%时,持有人有权按面值加当期应计利息回售';
  const r = M.parseResale(clause);
  assert.strictEqual(r.lastYears, 1);
  assert.strictEqual(r.triggerPct, 0.70);
  assert.strictEqual(r.price, null);
});

// ---------- 剩余现金流构造 ----------
test('buildRemainingCashflows: 中间票息 + 到期赎回价(含末息)', () => {
  // 2022-01-15 起息，6 年，票息 [0.2,0.4,0.8,1.5,2.0,2.5]，赎回价 110(含末息)
  // 基准日 2026-09-08：已付 2023/2024/2025/2026 四期，剩 2027-01-15(2.0) + 2028-01-15(110)
  const cf = M.buildRemainingCashflows({
    coupons: [0.2, 0.4, 0.8, 1.5, 2.0, 2.5],
    valueDate: '2022-01-15',
    maturityDate: '2028-01-15',
    redeemPrice: 110,
    baseDate: '2026-09-08'
  });
  assert.strictEqual(cf.length, 2);
  assert.strictEqual(cf[0].date, '2027-01-15');
  assert.strictEqual(cf[0].amount, 2.0);
  assert.strictEqual(cf[1].date, '2028-01-15');
  assert.strictEqual(cf[1].amount, 110);
});
test('buildRemainingCashflows: 全部票息已付只剩赎回', () => {
  const cf = M.buildRemainingCashflows({
    coupons: [0.2, 0.4, 0.8, 1.5, 2.0, 2.5],
    valueDate: '2020-06-15',
    maturityDate: '2026-06-15',
    redeemPrice: 108,
    baseDate: '2026-06-20'
  });
  assert.strictEqual(cf.length, 0); // 已到期
});

// ---------- 纯债价值（XNPV 口径，对照公开手算案例） ----------
test('pureBondValue: 单笔到期现金流 ≈ 公开案例（浦发转债 116.8 折现）', () => {
  // 雪球案例：到期拿回 110 + 三年利息 1.5+2.1+3.2 = 116.8，YTM 3.13%，T=3.93 → ≈103.25~103.5
  const pv = M.pureBondValue({
    cashflows: [{ date: '2030-09-08', amount: 116.8 }],
    ytm: 0.0313,
    baseDate: '2026-09-08'
  });
  const expected = 116.8 / Math.pow(1.0313, 4.0);
  assert.ok(Math.abs(pv - expected) < 0.05, `pv=${pv} expected≈${expected}`);
});
test('pureBondValue: 多期票息 + 赎回价（搜特转债口径验证）', () => {
  // 搜特转债：票息 [0.4,0.6,1.0,1.5,1.8,2.0]，剩余年限 0.98/1.98/2.98/3.98 年各付一期，末期 100+2.0
  // 用统一 YTM 折现，纯债价值应介于 [债底-2, 面值+全票息] 之间且 > 0
  const cf = [
    { date: '2027-03-18', amount: 1.5 },
    { date: '2028-03-18', amount: 1.8 },
    { date: '2029-03-18', amount: 102.0 }
  ];
  const pv = M.pureBondValue({ cashflows: cf, ytm: 0.05, baseDate: '2026-03-18' });
  assert.ok(pv > 90 && pv < 108, `pv=${pv} 应在合理区间`);
});

// ---------- 回售收益率（YTM 解方程，税前） ----------
test('resaleYield: 单期场景（1 年后 103.8 回售，现价 90）', () => {
  // 现金流：1 年后 103.8；price=90 → r = 103.8/90 - 1 = 15.33%
  const y = M.resaleYield({
    price: 90,
    cashflows: [{ t: 1.0, amount: 103.8 }]
  });
  assert.ok(Math.abs(y - (103.8 / 90 - 1)) < 0.001, `y=${y}`);
});
test('resaleYield: 多期票息 + 回售价（本钢转债口径 ≈5.16%）', () => {
  // 东财财富号案例：现价 90，3.22 年后 103.8 回售，中间利息共 5.8（简化均匀 1.45/年）
  // 精确 YTM 应落在 4.5%~6.5% 区间（文章给 5.16% 税前，口径略有差异）
  const y = M.resaleYield({
    price: 90,
    cashflows: [
      { t: 0.72, amount: 1.45 },
      { t: 1.72, amount: 1.45 },
      { t: 2.72, amount: 1.45 },
      { t: 3.22, amount: 103.8 }
    ]
  });
  assert.ok(y > 0.04 && y < 0.07, `y=${(y * 100).toFixed(2)}% 应在 4%~7%`);
});
test('resaleYield: 亏损情形为负（现价高于回售现金流现值）', () => {
  const y = M.resaleYield({ price: 120, cashflows: [{ t: 1.0, amount: 103 }] });
  assert.ok(y < 0, `y=${y} 应为负`);
});
test('resaleYield: 无现金流返回 NaN', () => {
  assert.ok(Number.isNaN(M.resaleYield({ price: 100, cashflows: [] })));
});

// ---------- 年化波动率 ----------
test('annualizedVolatility: 固定涨跌序列手算对照', () => {
  // 3 日收盘价 100, 102, 100 → 日收益率 [0.02, -0.0196078...]
  // std(样本) × √250
  const closes = [100, 102, 100];
  const v = M.annualizedVolatility(closes);
  const rets = [102 / 100 - 1, 100 / 102 - 1];
  const mean = (rets[0] + rets[1]) / 2;
  const variance = ((rets[0] - mean) ** 2 + (rets[1] - mean) ** 2) / (rets.length - 1);
  const expected = Math.sqrt(variance) * Math.sqrt(250);
  assert.ok(Math.abs(v - expected) < 1e-9, `v=${v} expected=${expected}`);
});
test('annualizedVolatility: 少于 2 个数据点返回 NaN', () => {
  assert.ok(Number.isNaN(M.annualizedVolatility([100])));
  assert.ok(Number.isNaN(M.annualizedVolatility([])));
});

// ---------- B-S 对照（与 bond-valuator 同基准） ----------
test('BSM.bsCall: S=K=100 r=3% σ=30% T=1 ≈ 13.28（wiki 标准例）', () => {
  const c = BSM.bsCall(100, 100, 0.03, 0.30, 1);
  assert.ok(Math.abs(c - 13.283) < 0.01, `c=${c}`);
});
test('BSM.xnpv: 与 bond-math.pureBondValue 同口径', () => {
  const cf = [{ date: '2029-09-08', amount: 112 }];
  const a = BSM.xnpv(cf, 0.02, '2026-09-08');
  const b = M.pureBondValue({ cashflows: cf, ytm: 0.02, baseDate: '2026-09-08' });
  assert.ok(Math.abs(a - b) < 1e-9, `a=${a} b=${b}`);
});
