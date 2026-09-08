/*
 * jisilu-cb-list.js — 集思录转债列表页（/web/data/cb/list）增强
 * 在表格行末追加 5 列（把会员功能用公开数据自己算出来）：
 *   纯债价值 | 期权价值 | 理论价值(含偏离度) | 正股波动率 | 回售收益
 * 数据链路：DOM 行(价/K/评级/剩余年限) + 东财条款(service-worker 缓存7天)
 *           + 腾讯K线波动率(缓存24h) + 评级映射贴现率。
 * 模式与 jisilu-pre.js 一致：插列铁律 / 两阶段渲染 / generation 防陈旧写 / 自愈三件套。
 */
(function (root) {
  'use strict';
  const VERSION = '0.5.0';
  const BSM = root.JisiluBSM;
  const BM = root.JisiluBondMath;
  if (!BSM || !BM) return; // 依赖未加载则静默退出（manifest 顺序保证）

  // 提取第一个数字串：转股价列常带下修标注（"6.43*转股价下修1次"），整体 Number() 会 NaN
  const number = value => {
    const m = String(value ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const text = node => (node?.textContent || '').trim().replace(/\s+/g, ' ');
  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt2 = v => Number.isFinite(v) ? v.toFixed(2) : '—';
  const fmtPct = v => Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—';

  // ---- MV3 防护（与 jisilu-pre.js 同款） ----
  const contextAlive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };
  function safeSendMessage(message) {
    return new Promise(resolve => {
      try {
        if (!chrome.runtime || !chrome.runtime.id) { resolve(null); return; }
        chrome.runtime.sendMessage(message, response => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(response || null);
        });
      } catch (_) { resolve(null); }
    });
  }
  function stopSelfHeal() { if (selfHealTimer) { try { clearInterval(selfHealTimer); } catch (_) { } selfHealTimer = 0; } }

  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  // ---- 表头列名 → 索引映射 ----
  const COLUMN_ALIASES = {
    bondCode: ['代码'], bondName: ['转债名称'], price: ['现价'],
    stockCode: ['正股代码'], stockName: ['正股名称'], stockPrice: ['正股价'],
    convertPrice: ['转股价'], convertValue: ['转股价值'], premiumRt: ['转股溢价率'],
    rating: ['评级'], putTrigger: ['回售触发价'], callTrigger: ['强赎触发价'],
    maturityDate: ['到期时间'], yearLeft: ['剩余年限'], remainSize: ['剩余规模(亿元)', '剩余规模'],
    ytmRt: ['到期税前收益']
  };
  function columnMap(table) {
    const header = [...table.querySelectorAll('thead tr')].at(-1);
    if (!header) return null;
    const own = cell => cell.dataset.jisiluEnhancer;
    const labels = [...header.querySelectorAll('th,td')].filter(cell => !own(cell)).map(text);
    const map = {};
    for (const key of Object.keys(COLUMN_ALIASES)) {
      map[key] = -1;
      for (const alias of COLUMN_ALIASES[key]) {
        const idx = labels.findIndex(label => label === alias || label.replace(/\s/g, '') === alias);
        if (idx >= 0) { map[key] = idx; break; }
      }
    }
    // 主表判定：代码/现价/转股价/评级 都能映射上（固定列表、下修 tab 表自动跳过）
    return map.bondCode >= 0 && map.price >= 0 && map.convertPrice >= 0 && map.rating >= 0 ? { header, map } : null;
  }

  // ---- 行数据提取 ----
  function parseMaturity(raw) {
    // 到期时间列格式："30-07-10"（YY-MM-DD）→ 2030-07-10
    const m = String(raw || '').match(/(\d{2})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return '20' + m[1] + '-' + m[2] + '-' + m[3];
  }
  function parseYearLeft(raw, maturityISO) {
    // 剩余年限列："3.84年" / "31天" / "6.0"
    const s = String(raw || '');
    let m = s.match(/(\d+(?:\.\d+)?)\s*年/);
    if (m) return parseFloat(m[1]);
    m = s.match(/(\d+)\s*天/);
    if (m) return parseInt(m[1], 10) / 365;
    const n = number(s);
    if (Number.isFinite(n) && n > 0 && n < 20) return n;
    if (maturityISO) {
      const ms = new Date(maturityISO + 'T00:00:00') - new Date(todayISO() + 'T00:00:00');
      return Math.max(0.01, ms / (365 * 24 * 3600 * 1000));
    }
    return null;
  }
  function extractRow(tr, map) {
    const cells = [...tr.querySelectorAll(':scope > td')].filter(td => !td.dataset.jisiluEnhancer);
    if (!cells.length) return null;
    const at = key => map[key] >= 0 ? cells[map[key]] : null;
    const bondCode = (text(at('bondCode')).match(/\b\d{6}\b/) || [])[0] || '';
    const price = number(text(at('price')));
    const stockPrice = number(text(at('stockPrice')));
    const convertPrice = number(text(at('convertPrice')));
    if (!bondCode || !Number.isFinite(price) || !Number.isFinite(stockPrice) || !Number.isFinite(convertPrice)) return null;
    const maturityISO = parseMaturity(text(at('maturityDate')));
    return {
      bondCode, bondName: text(at('bondName')), price,
      stockCode: (text(at('stockCode')).match(/\b\d{6}\b/) || [])[0] || '',
      stockName: text(at('stockName')), stockPrice,
      convertPrice, convertValue: number(text(at('convertValue'))),
      rating: text(at('rating')).replace(/会员/g, '').trim() || 'AA',
      maturityDate: maturityISO,
      yearLeft: parseYearLeft(text(at('yearLeft')), maturityISO),
      remainSize: number(text(at('remainSize'))),
      ytmRt: number(text(at('ytmRt'))),
      tr
    };
  }

  // ---- 注入列定义 ----
  const COLUMNS = [
    { key: 'pureBond', label: '纯债价值', width: 92, tip: '纯债价值（债底）\n剩余票息 + 到期赎回价，按同评级企业债收益率折现（XNPV）。\n票息/赎回价来自东财条款；贴现率按评级映射（AAA 2.0% … A 5.8%）。' },
    { key: 'optionVal', label: '期权价值', width: 88, tip: '期权价值（B-S 欧式看涨 × 转股比例）\nS=正股价、K=转股价、σ=正股年化波动率、T=剩余年限、r=1.7%。\n波动率由腾讯日K 250 条计算（未加载时暂用 30%）。' },
    { key: 'theory', label: '理论价值', width: 108, tip: '理论价值 = 纯债价值 + 期权价值（分离定价，鹏元口径）。\n副值为偏离度 =（市价-理论）/理论：红=市价高估，绿=市价低估。' },
    { key: 'volatility', label: '正股波动率', width: 92, tip: '正股年化波动率 = 日收益率样本标准差 × √250。\n数据源：腾讯日K（前复权）最近约 320 条，缓存 24 小时。' },
    { key: 'resaleYield', label: '回售收益', width: 90, tip: '回售收益率（税前 YTM）\n假设回售期首日即触发回售：现金流 = 剩余票息 + 回售价（面值+当期利息或条款价），按现价解年化收益率。\n银行/券商债无回售条款显示 —。' }
  ];

  function headerCell(col) {
    const th = document.createElement('th');
    th.className = 'jcb-header jcb-header-' + col.key;
    th.dataset.jisiluEnhancer = '1';
    th.textContent = col.label;
    th.style.width = col.width + 'px';
    th.style.minWidth = col.width + 'px';
    th.style.maxWidth = col.width + 'px';
    th.title = col.tip;
    return th;
  }
  function addHeaders(header) {
    header.querySelectorAll('[data-jisilu-enhancer]').forEach(node => node.remove());
    COLUMNS.forEach(col => header.append(headerCell(col)));
  }

  const baseWidth = new WeakMap();
  function ensureColumnWidths(tables) {
    const extra = COLUMNS.reduce((sum, c) => sum + c.width, 0);
    tables.forEach(table => {
      if (!table) return;
      const group = table.querySelector('colgroup');
      if (!group) return;
      const had = group.querySelectorAll('col[data-jisilu-enhancer]').length;
      group.querySelectorAll('col[data-jisilu-enhancer]').forEach(col => col.remove());
      // gutter 陷阱：element-ui 表头 colgroup 末尾 0 宽 gutter col，注入 col 要插它前面
      let anchor = null;
      const cols = [...group.children].filter(c => c.tagName === 'COL');
      const last = cols[cols.length - 1];
      if (last && parseFloat(last.getAttribute('width')) === 0) anchor = last;
      COLUMNS.forEach(c => {
        const col = document.createElement('col');
        col.setAttribute('width', String(c.width));
        col.dataset.jisiluEnhancer = '1';
        if (anchor) group.insertBefore(col, anchor);
        else group.append(col);
      });
      let base = 0;
      group.querySelectorAll('col:not([data-jisilu-enhancer])').forEach(col => {
        const w = parseFloat(col.getAttribute('width'));
        if (Number.isFinite(w)) base += w;
      });
      if (!base) {
        const cached = baseWidth.get(table);
        if (cached !== undefined) base = cached;
        else {
          const current = parseFloat(table.style.width);
          base = Number.isFinite(current) && current > 0 ? Math.max(0, current - (had ? extra : 0)) : 0;
        }
        baseWidth.set(table, base);
      }
      if (base > 0) table.style.width = Math.round(base + extra) + 'px';
    });
  }
  function allowHorizontalScroll(table) {
    const wrapper = table?.closest('.jsl-table-body-wrapper, .el-table__body-wrapper') || table?.parentElement;
    if (!wrapper) return;
    const style = getComputedStyle(wrapper);
    if (style.overflowX === 'hidden' || style.overflowX === 'clip') wrapper.style.overflowX = 'auto';
  }

  // ---- 行计算 ----
  // state: { terms: {bondCode: terms}, vol: {stockCode: {value}} }
  function computeRow(row, state) {
    const terms = state.terms ? state.terms[row.bondCode] : null;
    const today = todayISO();
    const rating = (terms && terms.rating) || row.rating || 'AA';
    const ytm = BM.discountFor(rating);
    const maturityDate = (terms && terms.maturityDate) || row.maturityDate;
    const yearLeft = row.yearLeft ||
      (maturityDate ? Math.max(0.01, (new Date(maturityDate + 'T00:00:00') - new Date(today + 'T00:00:00')) / (365 * 24 * 3600 * 1000)) : 3);
    // 波动率：缓存命中用真值，否则默认 30%
    const volRec = state.vol ? state.vol[row.stockCode] : null;
    const sigma = (volRec && Number.isFinite(volRec.value)) ? volRec.value : 0.30;
    const volEstimated = !(volRec && Number.isFinite(volRec.value));

    // 纯债价值（需要条款票息+赎回价）
    let pureBond = NaN;
    if (terms && terms.coupons && terms.coupons.length && terms.redeemPrice && maturityDate) {
      pureBond = BM.pureBondFromTerms({
        coupons: terms.coupons, valueDate: terms.valueDate || maturityDate,
        maturityDate, redeemPrice: terms.redeemPrice, ytm, baseDate: today
      }).value;
    }
    // 期权价值（B-S 单股 × 转股比例）
    const ratio = BSM.conversionRatio(row.convertPrice);
    const optionPerShare = BSM.bsCall(row.stockPrice, row.convertPrice, 0.017, sigma, yearLeft);
    const optionVal = optionPerShare * ratio;
    // 理论价值 = 纯债 + 期权
    const theory = Number.isFinite(pureBond) ? pureBond + optionVal : NaN;
    const dev = Number.isFinite(theory) && theory > 0 ? BSM.deviation(row.price, theory) : NaN;
    // 回售收益率：分 4 态——无条款 / 未到回售期 / 有解 / 深亏无解
    let resaleY = NaN, resaleState = 'none';
    if (terms && terms.resale && terms.coupons && terms.coupons.length && maturityDate) {
      const inResaleWindow = yearLeft <= terms.resale.lastYears + 0.5;
      if (!inResaleWindow) {
        resaleState = 'early'; // 集思录口径：未到回售期不显示
      } else {
        resaleY = BM.resaleYieldFromTerms({
          price: row.price, coupons: terms.coupons,
          valueDate: terms.valueDate || maturityDate, maturityDate,
          resale: terms.resale, baseDate: today
        });
        resaleState = Number.isFinite(resaleY) ? 'value' : 'deep';
      }
    }
    return { pureBond, optionVal, theory, dev, sigma, volEstimated, resaleY, resaleState, hasTerms: !!terms, ytm, rating };
  }

  function cellHtml(row, calc) {
    const bondTag = `<span class="jcb-bond-id">${escapeHtml(row.bondName).slice(0, 8)}</span>`;
    if (!calc.hasTerms) {
      const waiting = '<span class="jcb-main jcb-wait">…</span><span class="jcb-meta">条款加载中</span>';
      const optCell = `<span class="jcb-main">${fmt2(calc.optionVal)}</span><span class="jcb-meta">B-S 估算</span>`;
      const volCell = `<span class="jcb-main">${fmtPct(calc.sigma)}</span><span class="jcb-meta">${calc.volEstimated ? '默认30%' : '年化'}</span>`;
      return [bondTag + waiting, optCell, '<span class="jcb-main jcb-wait">…</span>', volCell, '<span class="jcb-main">—</span>'];
    }
    const pureHtml = `<span class="jcb-main">${fmt2(calc.pureBond)}</span><span class="jcb-meta">债底 · ${escapeHtml(calc.rating)}</span>`;
    const optHtml = `<span class="jcb-main">${fmt2(calc.optionVal)}</span><span class="jcb-meta">B-S × ${(100 / row.convertPrice).toFixed(2)}股</span>`;
    let theoryHtml;
    if (Number.isFinite(calc.theory)) {
      const devCls = calc.dev > 0 ? 'jcb-up' : 'jcb-down';
      const devTxt = (calc.dev >= 0 ? '+' : '') + fmtPct(calc.dev);
      theoryHtml = `<span class="jcb-main jcb-strong">${fmt2(calc.theory)}</span><span class="jcb-meta ${devCls}">${devTxt}${calc.dev > 0 ? ' 高估' : ' 低估'}</span>`;
    } else {
      theoryHtml = '<span class="jcb-main">—</span>';
    }
    const volHtml = `<span class="jcb-main">${fmtPct(calc.sigma)}</span><span class="jcb-meta">${calc.volEstimated ? '默认30%' : '年化'}</span>`;
    let resaleHtml;
    if (calc.resaleState === 'value') {
      const cls = calc.resaleY > 0 ? 'jcb-down' : 'jcb-up'; // 回售收益率为正=保底收益→绿；为负→红
      resaleHtml = `<span class="jcb-main ${cls}">${fmtPct(calc.resaleY)}</span><span class="jcb-meta">税前YTM</span>`;
    } else if (calc.resaleState === 'deep') {
      resaleHtml = '<span class="jcb-main jcb-up">≪-95%</span><span class="jcb-meta">远低于回售价</span>';
    } else if (calc.resaleState === 'early') {
      resaleHtml = '<span class="jcb-main">—</span><span class="jcb-meta">未到回售期</span>';
    } else {
      resaleHtml = '<span class="jcb-main">—</span><span class="jcb-meta">无回售条款</span>';
    }
    return [bondTag + pureHtml, optHtml, theoryHtml, volHtml, resaleHtml];
  }

  function makeCell(className, html, tipTitle, kind) {
    const cell = document.createElement('td');
    cell.className = `jcb-cell jcb-cell-${kind} ${className || ''}`;
    cell.dataset.jisiluEnhancer = '1';
    cell.innerHTML = html;
    if (tipTitle) cell.title = tipTitle;
    return cell;
  }

  // ---- 渲染管线（两阶段 + generation） ----
  const generation = new WeakMap();
  let lastWriteAt = 0;
  function rowTableFor(headerTable) {
    const tables = [...document.querySelectorAll('table')];
    const position = tables.indexOf(headerTable);
    return tables.slice(position + 1).find(candidate => candidate.querySelector('tbody tr')) || headerTable;
  }
  function collectRows(rowsTable, map) {
    const rows = [];
    [...rowsTable.querySelectorAll('tbody tr')].forEach(tr => {
      tr.querySelectorAll('[data-jisilu-enhancer]').forEach(node => node.remove());
      const row = extractRow(tr, map);
      if (row) rows.push(row);
    });
    return rows;
  }
  function writeCells(rows, state) {
    lastWriteAt = Date.now();
    for (const row of rows) {
      if (!row.tr.isConnected) continue;
      row.tr.querySelectorAll('[data-jisilu-enhancer]').forEach(node => node.remove());
      const calc = computeRow(row, state);
      const htmls = cellHtml(row, calc);
      const tips = COLUMNS.map(c => c.tip);
      COLUMNS.forEach((col, i) => {
        row.tr.append(makeCell('', htmls[i] || '<span class="jcb-main">—</span>', tips[i], col.key));
      });
    }
  }
  async function renderTable(table) {
    if (!contextAlive()) { stopSelfHeal(); return; }
    const data = columnMap(table);
    if (!data) return;
    const { header, map } = data;
    addHeaders(header);
    const rowsTable = rowTableFor(table);
    ensureColumnWidths([table, rowsTable]);
    allowHorizontalScroll(rowsTable);
    const rows = collectRows(rowsTable, map);
    if (!rows.length) return;
    const myGen = (generation.get(rowsTable) || 0) + 1;
    generation.set(rowsTable, myGen);
    // pass 1：用已缓存的条款/波动率立即渲染（首次可能为空 → 占位）
    const state = { terms: cachedTerms, vol: cachedVol };
    writeCells(rows, state);
    syncHeaderScroll(rowsTable);
    // pass 2：条款到达后重算（generation 防陈旧写）
    const termsResp = await ensureTerms();
    if (generation.get(rowsTable) !== myGen) return;
    if (termsResp) {
      writeCells(rows, { terms: cachedTerms, vol: cachedVol });
      syncHeaderScroll(rowsTable);
    }
    // pass 3：波动率懒加载（分批，不阻塞主渲染）
    ensureVolatility(rows.map(r => r.stockCode).filter(Boolean)).then(got => {
      if (!got || generation.get(rowsTable) !== myGen) return;
      writeCells(rows, { terms: cachedTerms, vol: cachedVol });
      syncHeaderScroll(rowsTable);
    });
  }
  function syncHeaderScroll(rowsTable) {
    const bodyWrapper = rowsTable.closest('.jsl-table-body-wrapper, .el-table__body-wrapper');
    const headerWrapper = document.querySelector('.jsl-table-header-wrapper, .el-table__header-wrapper');
    if (!bodyWrapper || !headerWrapper) return;
    if (headerWrapper._jcbSync) return;
    headerWrapper._jcbSync = true;
    headerWrapper.scrollLeft = bodyWrapper.scrollLeft;
    headerWrapper.addEventListener('scroll', () => {
      if (Math.abs(headerWrapper.scrollLeft - bodyWrapper.scrollLeft) > 0.5) bodyWrapper.scrollLeft = headerWrapper.scrollLeft;
    });
    bodyWrapper.addEventListener('scroll', () => {
      if (Math.abs(headerWrapper.scrollLeft - bodyWrapper.scrollLeft) > 0.5) headerWrapper.scrollLeft = bodyWrapper.scrollLeft;
    });
  }

  // ---- 条款与波动率缓存（content 侧镜像） ----
  let cachedTerms = null;
  let cachedVol = {};
  let termsPromise = null;
  let volPromise = null;
  async function ensureTerms() {
    if (cachedTerms) return cachedTerms;
    if (termsPromise) return termsPromise;
    termsPromise = safeSendMessage({ type: 'GET_CB_TERMS' }).then(resp => {
      if (resp && resp.terms) { cachedTerms = resp.terms; return resp; }
      return null;
    }).finally(() => { if (!cachedTerms) termsPromise = null; });
    return termsPromise;
  }
  async function ensureVolatility(stockCodes) {
    if (volPromise) return volPromise;
    const missing = stockCodes.filter(c => !(cachedVol[c] && Number.isFinite(cachedVol[c].value)));
    if (!missing.length) return true;
    volPromise = safeSendMessage({ type: 'GET_VOLATILITY', codes: missing }).then(resp => {
      if (resp && resp.vol) { Object.assign(cachedVol, resp.vol); return true; }
      return false;
    }).finally(() => { volPromise = null; });
    return volPromise;
  }

  // ---- 提示条 ----
  let hintChecked = false;
  function showHint() {
    if (hintChecked || document.querySelector('#jisilu-cb-list-hint')) return;
    if (!document.body) return;
    hintChecked = true;
    const bar = document.createElement('div');
    bar.id = 'jisilu-cb-list-hint';
    bar.innerHTML = `<span><strong>转债估值增强 v${VERSION} 已启用</strong>：表格最右侧新增 <strong>纯债价值 / 期权价值 / 理论价值 / 正股波动率 / 回售收益</strong> 五列（会员功能公开数据自算），向右滚动查看；鼠标悬停表头看计算口径。</span><button type="button">知道了</button>`;
    document.body.prepend(bar);
    bar.querySelector('button').onclick = () => bar.remove();
  }

  // ---- 自愈三件套 ----
  let timer;
  function renderAll() { for (const table of document.querySelectorAll('table')) renderTable(table); }
  function schedule() {
    if (!contextAlive()) { stopSelfHeal(); return; }
    if (Date.now() - lastWriteAt < 150) return;
    clearTimeout(timer);
    timer = setTimeout(() => { renderAll(); showHint(); }, 50);
  }
  function selfHealCheck() {
    if (!contextAlive()) { stopSelfHeal(); return; }
    try {
      // 兼容两套表格组件：cb/list 用集思录自研 jsl-table，pre 页用 element-ui
      const hTbl = document.querySelector('table.jsl-table-header, table.el-table__header');
      const bTbl = document.querySelector('table.jsl-table-body, table.el-table__body');
      if (!hTbl || !bTbl) return;
      const need = COLUMNS.length;
      const hThs = hTbl.querySelectorAll('th[data-jisilu-enhancer]');
      const hCols = hTbl.querySelectorAll('colgroup col[data-jisilu-enhancer]');
      const bCols = bTbl.querySelectorAll('colgroup col[data-jisilu-enhancer]');
      const thW = hThs.length ? hThs[0].getBoundingClientRect().width : 0;
      const hW = parseFloat(hTbl.style.width);
      const bW = parseFloat(bTbl.style.width);
      const dirty =
        hThs.length !== need ||
        hCols.length !== need ||
        bCols.length !== need ||
        thW < 60 ||
        !Number.isFinite(hW) || !Number.isFinite(bW) || Math.abs(hW - bW) > 0.5;
      if (dirty) renderAll();
    } catch (_) { /* 单次自检失败不影响下次 */ }
  }
  const observer = new MutationObserver(records => { if (records.some(r => r.addedNodes.length || r.removedNodes.length)) schedule(); });
  const tableObserver = new MutationObserver(() => { try { selfHealCheck(); } catch (_) { } });
  let selfHealTimer = 0;
  let booted = false;
  function boot() {
    if (booted || !document.documentElement || !document.body) return;
    booted = true;
    try { observer.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) { }
    try {
      for (const tbl of document.querySelectorAll('table.jsl-table-header, table.jsl-table-body, table.el-table__header, table.el-table__body')) {
        tableObserver.observe(tbl, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
      }
    } catch (_) { }
    try { renderAll(); showHint(); } catch (_) { }
    if (!selfHealTimer) selfHealTimer = setInterval(selfHealCheck, 1500);
  }
  boot();
  if (!booted) {
    document.addEventListener('readystatechange', boot, { once: false });
    document.addEventListener('DOMContentLoaded', boot, { once: true });
    window.addEventListener('load', boot, { once: true });
  }
  root.JisiluCbList = { refresh: () => { clearTimeout(timer); renderAll(); showHint(); }, version: VERSION };
})(globalThis);
