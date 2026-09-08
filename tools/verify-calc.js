#!/usr/bin/env node
/**
 * 复算校验脚本 —— 把插件在页面上显示的两个数字，从头到尾手工推导一遍，
 * 并同时给出「页面显示值」与「手工推导值」的逐项对照，用于人工复核。
 *
 * 用法：
 *   node tools/verify-calc.js                          # 用内置 fixture（2026-09-06 真实快照）+ 实时行情
 *   node tools/verify-calc.js --profit 600             # 额外指定「获配10张的预估总盈利（元）」，看安全垫
 *   node tools/verify-calc.js --code 001380 --shares 471 --profit 600   # 只验一只，可脱离 fixture
 *   node tools/verify-calc.js --offline                # 不联网，用 fixture 里页面上的正股价
 *
 * 说明：本脚本刻意不使用插件的 calc.js 作为「唯一算法」，而是用最朴素的四则运算
 * 独立推一遍（见 manual()），再与 calc.js 的输出对照。两套独立实现结果一致，
 * 才能说明公式实现没写错。
 */
'use strict';

const path = require('path');
const rounding = require(path.join(__dirname, '..', 'core', 'rounding.js'));
const calc = require(path.join(__dirname, '..', 'core', 'calc.js'));
const quotes = require(path.join(__dirname, '..', 'core', 'quotes.js'));
const dates = require(path.join(__dirname, '..', 'core', 'dates.js'));
const rules = require(path.join(__dirname, '..', 'core', 'rules.js'));
const selectors = require(path.join(__dirname, '..', 'config', 'selectors.js'));
const fixture = require(path.join(__dirname, '..', 'tests', 'fixtures', 'pre-page-2026-09-06.json'));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hasFlag = name => process.argv.includes(`--${name}`);

const MONEY = v => (Number.isFinite(v) ? `¥${v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '待补');
const RATE = v => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '待补');
const num = v => { const n = Number(String(v ?? '').replace(/[,%，\s]/g, '')); return Number.isFinite(n) ? n : null; };

/** 市场判定：与 content/jisilu-pre.js 的 marketFor() 完全一致 */
function marketFor(code) {
  const v = String(code || '').replace(/\D/g, '');
  if (/^688/.test(v)) return 'KCB';
  if (/^(300|301)/.test(v)) return 'CYB';
  if (/^(4|8|92)/.test(v)) return 'BJ';
  return 'MAIN';
}
const BOARD_NAME = { KCB: '科创板', CYB: '创业板', BJ: '北交所', MAIN: '沪深主板' };
/** 一手股数 + 取整规则（core/rounding.js） */
function lotOf(market) { return rounding.lotShares(market); }
function roundShares(shares, market) { return rounding.roundSharesForBoard(shares, market); }

/** 独立手写推导：不依赖 calc.js，用最直白的四则运算 */
function manual({ requiredShares, price, market, profitTen }) {
  const lot = market === 'KCB' ? 200 : 100;
  // 1) 实际买入股数：科创板最小 200 股且可 1 股递增；其余板块必须整百
  const actual = market === 'KCB' ? Math.max(200, Math.ceil(requiredShares)) : Math.ceil(requiredShares / 100) * 100;
  // 2) 买这些股要花多少钱
  const amount = actual * price;
  // 3) 一手（最小可买单位）要花多少钱
  const oneLotAmount = lot * price;
  // 4) 一手能配到多少张债：requiredShares 股配 10 张 → 1 股配 10/required 张
  const bondsPerLot = (lot * 10) / requiredShares;
  // 5) 一手的预估盈利 = 配到张数 × 每张利润(profitTen/10)
  const oneLotProfit = Number.isFinite(profitTen) ? bondsPerLot * (profitTen / 10) : null;
  return {
    lot, actual, amount, oneLotAmount, bondsPerLot,
    fullRate: Number.isFinite(profitTen) ? profitTen / amount : null,
    oneLotProfit,
    oneLotRate: Number.isFinite(oneLotProfit) ? oneLotProfit / oneLotAmount : null
  };
}

async function livePrice(codes) {
  const url = quotes.tencentUrl(codes);
  if (!url) return {};
  const res = await fetch(url);
  const body = new TextDecoder('gbk').decode(await res.arrayBuffer());
  const out = {};
  codes.forEach(code => { try { out[code] = quotes.parseTencent(body, code); } catch (_) { /* 单只失败不影响其余 */ } });
  return out;
}

async function main() {
  const profitArg = arg('profit', null);
  const profitTen = profitArg === null ? null : Number(profitArg);
  const offline = hasFlag('offline');
  const singleCode = arg('code', null);
  const singleShares = arg('shares', null);

  let cases = [];
  if (singleCode && singleShares) {
    const priceArg = arg('price', null);
    cases = [{
      bondCode: singleCode, bondName: '（命令行指定）', stockCode: singleCode,
      requiredShares: Number(singleShares),
      pagePrice: priceArg === null ? null : Number(priceArg),
      registrationDate: arg('reg', '-'), progress: '同意注册'
    }];
  } else {
    const map = selectors.mapColumns(fixture.headers);
    cases = fixture.rows.map(row => {
      const cells = row.cells;
      const codes = (cells[map.bondCode] || '').match(/\d{6}/g) || [];
      const stockCode = codes[0] || (row.links[0] || '').match(/\d{6}/)?.[0] || '';
      return {
        bondCode: codes[1] || codes[0] || '', bondName: cells[map.bondName] || '', stockCode,
        requiredShares: num(cells[map.requiredShares]), pagePrice: num(cells[map.stockPrice]),
        registrationDate: cells[map.registrationDate] || '-', progress: cells[map.progress] || ''
      };
    }).filter(c => c.stockCode && c.requiredShares > 0);
  }

  const prices = offline ? {} : await livePrice(cases.map(c => c.stockCode)).catch(() => ({}));

  console.log('='.repeat(78));
  console.log('集思录潜伏配债增强 —— 计算复算校验');
  console.log(`数据源：${offline ? '离线（fixture 页面价）' : '腾讯财经 qt.gtimg.cn 实时行情'}`);
  console.log(`今日（Asia/Shanghai）：${dates.shanghaiToday().toLocaleDateString('zh-CN')}`);
  if (profitTen === null) console.log('提示：未加 --profit，安全垫将显示「待补」（与页面首次使用一致）');
  console.log('='.repeat(78));

  let mismatch = 0;
  for (const c of cases) {
    const market = marketFor(c.stockCode);
    const quote = prices[c.stockCode];
    const price = quote ? quote.price : (c.pagePrice > 0 ? c.pagePrice : null);
    const priceSource = quote ? quote.source : (c.pagePrice > 0 ? '集思录页面价' : '无');

    console.log(`\n【${c.bondName}】正股 ${c.stockCode}（${BOARD_NAME[market]}）  方案进展：${c.progress}`);
    console.log(`  股权登记日：${c.registrationDate}`);

    const inactive = rules.inactiveReason({ stockCode: c.stockCode, progress: c.progress, registrationDate: c.registrationDate });
    if (inactive) { console.log(`  → 插件判定不可潜伏：${inactive}（两列显示「待补 −」，不参与计算）\n${'-'.repeat(78)}`); continue; }
    if (!price) { console.log(`  → 行情不可用，无法计算\n${'-'.repeat(78)}`); continue; }

    const funding = calc.calculateFunding({ requiredShares: c.requiredShares, stockPrice: price, market });
    const safety = calc.calculateSafetyCushion({ funding, estimatedProfitTen: profitTen, requiredShares: c.requiredShares });
    const m = manual({ requiredShares: c.requiredShares, price, market, profitTen });

    console.log('  ── 第 1 列：配债所需资金 ─────────────────────────────');
    console.log(`  ① 页面「配售10张所需股数」     = ${c.requiredShares} 股   ← 表格原始字段，未加工`);
    console.log(`  ② 现价（${priceSource}）          = ${price.toFixed(2)} 元`);
    console.log(`  ③ 板块最小单位 / 取整规则       = ${BOARD_NAME[market]}：一手 ${m.lot} 股，${market === 'KCB' ? '最小200股、可1股递增' : '必须整百股'}`);
    console.log(`  ④ 实际需买入 = ${market === 'KCB' ? `max(200, ceil(${c.requiredShares}))` : `ceil(${c.requiredShares}/100)×100`} = ${m.actual} 股`);
    console.log(`  ⑤ 所需金额   = ${m.actual} 股 × ${price.toFixed(2)} 元 = ${MONEY(m.amount)}`);
    console.log(`     插件显示：${MONEY(funding.actualAmount)}（副标题 实际买 ${funding.actualShares} 股 · 现价 ${MONEY(price)}）`);

    console.log('  ── 第 2 列：预估盈利·安全垫 ─────────────────────────');
    if (!Number.isFinite(profitTen)) {
      console.log(`     未填写预估盈利 → 显示「点击填预估盈利」（安全垫公式需要你先给 profit）`);
    } else {
      console.log(`  ⑦ 你填的预估盈利（获配10张总利润）= ${MONEY(profitTen)}  →  每张约 ${MONEY(profitTen / 10)}`);
      console.log(`  ⑧ 满额安全垫 = 盈利 ÷ 满额占用资金 = ${profitTen} ÷ ${MONEY(m.amount)} = ${RATE(m.fullRate)}`);
      console.log(`     （含义：为配满 10 张而买入 ${m.actual} 股正股期间，若正股跌 ${RATE(m.fullRate)}，债的收益刚好被吃掉）`);
      console.log(`  ⑨ 一手配到张数 = ${m.lot} × 10 ÷ ${c.requiredShares} = ${m.bondsPerLot.toFixed(3)} 张`);
      console.log(`  ⑩ 一手盈利 = ${m.bondsPerLot.toFixed(3)} 张 × ${MONEY(profitTen / 10)} = ${MONEY(m.oneLotProfit)}`);
      console.log(`  ⑪ 一手安全垫 = ${MONEY(m.oneLotProfit)} ÷ ${MONEY(m.oneLotAmount)} = ${RATE(m.oneLotRate)}`);
      console.log(`     插件显示：${MONEY(safety.estimatedProfitTen)}（副标题 满额 ${RATE(safety.fullRate)} · 一手 ${RATE(safety.oneLotRate)}）`);
      console.log(`     恒等校验：一手安全垫 ${RATE(m.oneLotRate)} ≥ 满额安全垫 ${RATE(m.fullRate)} ？ ${m.oneLotRate >= m.fullRate ? '是 ✓（取整损耗使满额更低，符合预期）' : '否 ✗ 异常'}`);
    }

    // 两套独立实现必须一致
    const ok = Math.abs(funding.actualAmount - m.amount) < 1e-9
      && Math.abs(funding.oneLotAmount - m.oneLotAmount) < 1e-9
      && funding.actualShares === m.actual
      && (!Number.isFinite(profitTen) || (Math.abs(safety.fullRate - m.fullRate) < 1e-12 && Math.abs(safety.oneLotRate - m.oneLotRate) < 1e-12));
    if (!ok) mismatch++;
    console.log(`  交叉校验（插件 calc.js vs 手工推导）：${ok ? '一致 ✓' : '不一致 ✗✗'}`);
    console.log('-'.repeat(78));
  }

  console.log(`\n结论：${cases.length} 行参与校验，交叉校验不一致 ${mismatch} 行。`);
  console.log('说明：行情为实时值，与你打开页面的时刻不同属正常；若用 --offline 则与 fixture 快照一致。');
}

main().catch(error => { console.error('运行失败：', error.message); process.exit(1); });
