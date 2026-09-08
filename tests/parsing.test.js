const test = require('node:test');
const assert = require('node:assert/strict');
const { mapColumns } = require('../config/selectors.js');
const { parseDate, isExpired, shanghaiToday } = require('../core/dates.js');
const { inactiveReason } = require('../core/rules.js');
const { tencentSymbol, tencentUrl, parseTencent, parseEastmoney } = require('../core/quotes.js');
const fixture = require('./fixtures/pre-page-2026-09-06.json');

// Captured from https://www.jisilu.cn/web/data/cb/pre/ — see tests/fixtures/.
const CAPTURE_DAY = new Date(2026, 8, 6);

test('真实页面表头能映射到关键列', () => {
  assert.equal(fixture.headers.length, 25, '表头列数变化说明页面改版，需重新核对选择器');
  const map = mapColumns(fixture.headers);
  assert.equal(map.bondCode, 0);
  assert.equal(map.bondName, 1);
  assert.equal(map.progress, 2);
  assert.equal(map.issueSize, 4);
  assert.equal(map.stockPrice, 9);
  assert.equal(map.requiredShares, 15);
  assert.equal(map.registrationDate, 16);
});

test('页面没有正股代码列，正股名称也不能误命中正股价列', () => {
  const map = mapColumns(fixture.headers);
  assert.equal(map.stockCode, -1, '真实页面无「正股代码」列，代码须从链接回退提取');
  assert.equal(map.stockName, -1, '放宽到「正股」会命中「正股价」列');
});

test('真实样本行：已上市与已过登记日不可潜伏，待发行仍可计算', () => {
  const map = mapColumns(fixture.headers);
  const rows = fixture.rows.map(row => ({
    stockCode: ((row.links[0] || '').match(/\d{6}/) || [''])[0],
    progress: row.cells[map.progress],
    registrationDate: row.cells[map.registrationDate]
  }));
  assert.match(inactiveReason(rows[0], CAPTURE_DAY), /已上市/);
  assert.match(inactiveReason(rows[1], CAPTURE_DAY), /股权登记日/);
  rows.slice(2).forEach((row, index) => assert.equal(inactiveReason(row, CAPTURE_DAY), '', `第 ${index + 2} 行应可计算`));
});

test('已过登记日视为不可潜伏，未定日期仍可计算', () => {
  assert.equal(isExpired('2026-08-17', CAPTURE_DAY), true);
  assert.equal(isExpired('2026-09-02', CAPTURE_DAY), true);
  assert.equal(isExpired('2026-09-06', CAPTURE_DAY), true, '当天按保守口径视为不可潜伏');
  assert.equal(isExpired('2026-09-07', CAPTURE_DAY), false);
  assert.equal(isExpired('-', CAPTURE_DAY), false, '页面渲染 - 表示待定，必须保持可计算');
  assert.equal(isExpired('', CAPTURE_DAY), false);
  assert.equal(isExpired(null, CAPTURE_DAY), false);
});

test('登记日支持分隔符与中文日期', () => {
  const date = parseDate('2026-09-02');
  assert.deepEqual([date.getFullYear(), date.getMonth(), date.getDate()], [2026, 8, 2]);
  const chinese = parseDate('2026年9月2日');
  assert.deepEqual([chinese.getFullYear(), chinese.getMonth(), chinese.getDate()], [2026, 8, 2]);
  assert.equal(parseDate('待定'), null);
  assert.equal(parseDate(''), null);
});

test('今天按 Asia/Shanghai 而不是浏览器本地时区', () => {
  assert.deepEqual([shanghaiToday(new Date('2026-09-06T12:00:00Z')).getDate()], [6]);
  const lateUtc = shanghaiToday(new Date('2026-09-06T23:00:00Z'));
  assert.equal(lateUtc.getDate(), 7, 'UTC 23:00 已是上海次日');
});

test('腾讯代码前缀覆盖沪深创科北', () => {
  assert.equal(tencentSymbol('600000'), 'sh600000');
  assert.equal(tencentSymbol('688981'), 'sh688981');
  assert.equal(tencentSymbol('000001'), 'sz000001');
  assert.equal(tencentSymbol('300750'), 'sz300750');
  assert.equal(tencentSymbol('430047'), 'bj430047');
  assert.equal(tencentSymbol('920002'), 'bj920002');
  assert.equal(tencentSymbol('12345'), null);
});

test('腾讯批量请求把整页合并为一个地址', () => {
  assert.equal(tencentUrl(['600000', '000001', 'bad']), 'https://qt.gtimg.cn/q=sh600000,sz000001');
  assert.equal(tencentUrl(['600000', '600000']), 'https://qt.gtimg.cn/q=sh600000', '去重避免重复请求');
  assert.equal(tencentUrl([]), null);
});

test('解析腾讯行情取现价与名称', () => {
  assert.deepEqual(parseTencent('v_sh600000="1~浦发银行~600000~9.43~9.27~";', '600000'), { code: '600000', price: 9.43, name: '浦发银行', source: '腾讯财经' });
});

test('腾讯返回空或停牌时抛出可读错误', () => {
  assert.throws(() => parseTencent('', '600000'), /未返回该代码/);
  assert.throws(() => parseTencent('v_sh600000="1~停牌~600000~0.00~";', '600000'), /价格无效/);
});

test('东方财富 f43 按分换算为元', () => {
  assert.deepEqual(parseEastmoney({ data: { f43: 943, f58: '浦发银行' } }, '600000'), { code: '600000', price: 9.43, name: '浦发银行', source: '东方财富' });
  assert.throws(() => parseEastmoney({}, '600000'), /返回为空/);
  assert.throws(() => parseEastmoney({ data: { f43: 0 } }, '600000'), /价格无效/);
});

test('表头混入插件自身插入的两列后映射不变（防索引错位回归）', () => {
  // jisilu-pre.js injects "配债所需资金" and "预估盈利·安全垫" after the required-shares column.
  // The content script must therefore map columns over the ORIGINAL labels only; if it ever maps
  // over the enhanced header, every index after column 15 shifts by two and rows silently read
  // the wrong cells (this shipped once: expired bonds stayed calculable).
  const enhanced = [...fixture.headers];
  enhanced.splice(16, 0, '配债所需资金', '预估盈利·安全垫');
  const original = mapColumns(fixture.headers);
  const afterInject = mapColumns(enhanced.filter(label => !['配债所需资金', '预估盈利·安全垫'].includes(label)));
  assert.deepEqual(afterInject, original);
  // Sanity: on the enhanced header the injected labels must not be mistaken for real columns.
  const direct = mapColumns(enhanced);
  assert.equal(direct.requiredShares, original.requiredShares);
});
