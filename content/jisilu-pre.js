(function (root) {
  'use strict';
  const VERSION = '0.4.8';
  const { mapColumns } = root.JisiluSelectors;
  const { inactiveReason } = root.JisiluRules;
  const number = value => { const n = Number(String(value ?? '').replace(/[,%，\s]/g, '')); return Number.isFinite(n) ? n : null; };
  const text = node => (node?.textContent || '').trim().replace(/\s+/g, ' ');
  const fmtMoney = value => Number.isFinite(value) ? `¥${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '待补';
  const fmtRate = value => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '待补';
  const escapeHtml = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // MV3 扩展被 dev-reload/unload 后，旧 content script 的异步回调（setInterval/MutationObserver/定时
  // schedule）仍可能在已失效的上下文里触发。此时 chrome.runtime.id 变为 undefined，任何 chrome.* 调用
  // 会同步抛「Extension context invalidated」。用 contextAlive() 在每次 chrome 调用前判死，避免污染
  // chrome://extensions 错误面板，也避免旧循环在页面重载前反复破坏已注入的表头。
  const contextAlive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };
  // 永远不抛错、不 reject 的 sendMessage 封装：context 失效或 lastError 时返回 null，让上层走兜底分支。
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
  // 扩展上下文失效时停掉自身定时自检，防止旧上下文反复抛错（清不掉旧 timer，但新检测先停自己）。
  function stopSelfHeal() { if (selfHealTimer) { try { clearInterval(selfHealTimer); } catch (_) {} selfHealTimer = 0; } }
  function columnMap(table) {
    const header = [...table.querySelectorAll('thead tr')].at(-1) || [...table.querySelectorAll('tr')].find(tr => text(tr).includes('配售'));
    if (!header) return null;
    // The header is re-read on every repaint, after our own cells are already in the DOM. Mapping
    // columns over the enhanced header would shift every index, so the injected cells must be
    // excluded to keep the indices aligned with the untouched body cells.
    const own = cell => cell.dataset.jisiluEnhancer;
    const labels = [...header.querySelectorAll('th,td')].filter(cell => !own(cell)).map(text);
    const map = mapColumns(labels);
    return map.requiredShares >= 0 && (map.bondCode >= 0 || map.bondName >= 0) ? { header, map } : null;
  }
  function codeFromCell(cell) { return (text(cell).match(/\b\d{6}\b/) || [])[0] || ''; }
  function marketFor(code) {
    const value = String(code || '').replace(/\D/g, '');
    if (/^688/.test(value)) return 'KCB';
    if (/^(300|301)/.test(value)) return 'CYB';
    if (/^(4|8|92)/.test(value)) return 'BJ';
    return 'MAIN';
  }
  function extractRow(tr, map) {
    const cells = [...tr.querySelectorAll(':scope > td')].filter(td => !td.dataset.jisiluEnhancer); if (!cells.length) return null;
    const at = key => map[key] >= 0 ? cells[map[key]] : null;
    const allLinks = [...tr.querySelectorAll('a')];
    const linkCodes = allLinks.map(a => `${text(a)} ${a.href}`).flatMap(v => v.match(/\d{6}/g) || []);
    const codeCellCodes = (text(at('bondCode')).match(/\b\d{6}\b/g) || []);
    // Current Jisilu rows put stock code first and, when issued, bond code second in the same cell.
    // For pre-announcement rows without a bond code, the stock code is a stable local-settings key.
    const bondCode = codeCellCodes[1] || codeFromCell(at('bondCode')) || linkCodes[1] || linkCodes[0] || '';
    let stockCode = codeFromCell(at('stockCode')) || codeCellCodes[0] || linkCodes.find(code => code !== bondCode) || '';
    // A stock link generally carries sh/sz/bj in its href; prefer it over arbitrary table IDs.
    const stockLink = allLinks.find(a => /(?:SH|SZ|BJ|stock|quote)/i.test(a.href) && /\d{6}/.test(a.href));
    if (stockLink) stockCode = (stockLink.href.match(/\d{6}/) || [stockCode])[0];
    const requiredShares = number(text(at('requiredShares')));
    if (!bondCode || !Number.isFinite(requiredShares) || requiredShares <= 0) return null;
    return {
      bondCode, bondName: text(at('bondName')), stockCode, stockName: text(at('stockName')), requiredShares,
      pagePrice: number(text(at('stockPrice'))), issueSize: number(text(at('issueSize'))),
      conversionPrice: number(text(at('conversionPrice'))), rating: text(at('rating')),
      registrationDate: text(at('registrationDate')), progress: text(at('progress')),
      market: marketFor(stockCode), tr
    };
  }
  const COLUMN_WIDTHS = [180, 180];
  // 表头悬浮说明（方案 B 自定义浮层）：讲清这一列是什么、怎么用，取代简陋的原生 title。
  function headerTipHtml(kind) {
    return kind === 'amount'
      ? `<div class="je-tip"><div class="je-tip-title">配债所需资金</div>
        <div class="je-tip-note">潜伏配债需要占用的资金 = 实际买入股数 × 正股现价（配 1 手 = 10 张）。</div>
        <div class="je-tip-note">股数按板块规则取整：主板/创业板/北交所整百，科创板 200 股起、可 1 股递增。</div>
        <div class="je-tip-note">它是第 2 列安全垫的分母——占用越大，安全垫越薄。</div></div>`
      : `<div class="je-tip"><div class="je-tip-title">预估盈利 · 安全垫</div>
        <div class="je-tip-note">预估盈利 = 获配 10 张转债上市后的预计总利润；未填写时由模型自动预估（显示 ~ 前缀）。</div>
        <div class="je-tip-note">满额安全垫 = 预估盈利 ÷ 配债所需资金，含义是「正股跌多少你就白干」。</div>
        <div class="je-tip-note">点击单元格可手填预估盈利，并切换保守/中性/乐观三档。</div></div>`;
  }
  function headerCell(label, kind) {
    const th = document.createElement('th');
    th.className = `je-header je-header-${kind}`;
    th.dataset.jisiluEnhancer = '1';
    th.textContent = label;
    // 表头宽度直接设在 th 上：element-ui 表头 colgroup 比表体多一个 0 宽的 gutter 列，
    // 若靠 <col> 定义宽度会被 gutter 顶错位一位（amount 列塌成 0、profit 列占 amount 位），
    // 故表头改用单元格自身宽度（fixed 布局下无对应 col 时以首行单元格宽度为准）。
    const w = COLUMN_WIDTHS[kind === 'amount' ? 0 : 1];
    th.style.width = `${w}px`;
    th.style.minWidth = `${w}px`;
    th.style.maxWidth = `${w}px`;
    th.addEventListener('mouseenter', () => root.JisiluTooltip.show(th, headerTipHtml(kind)));
    th.addEventListener('mouseleave', () => root.JisiluTooltip.hide());
    return th;
  }
  // The two columns are APPENDED AFTER the last original column, never inserted mid-row. The table
  // is managed by Vue (element-ui): on data refresh Vue re-patches its own cells by position, so
  // cells inserted in the middle get overwritten or push the real ones aside — which shipped once
  // as visibly shifted data. Trailing cells sit beyond every index Vue manages and stay safe.
  // 此外：两列用 position:sticky 固定在视口右侧，避免 element-ui header/body 水平滚动同步失效时
  // 表头被「漏滚」一列（老板 2026-09-08 截图反馈）。
  // Vue 重绘时可能只删掉其中一个注入 th（例如保留 profit、删掉 amount），旧的「有一个就跳过」
  // guard 会漏补。改为：每次先清掉已注入的 th，再重新追加两个，保证数量永远对。
  function addHeaders(header) {
    header.querySelectorAll('[data-jisilu-enhancer]').forEach(node => node.remove());
    header.append(headerCell('配债所需资金', 'amount'), headerCell('预估盈利·安全垫', 'profit'));
  }
  // Element-UI renders the header and the body as two separate <table> elements whose widths are
  // fixed by a <colgroup>. Adding <th>/<td> alone leaves the new columns with no <col>, so they
  // collapse to 0px and get clipped by the wrapper's overflow:hidden. Both tables need the extra
  // <col> entries and a wider table, otherwise the enhancement is invisible on screen.
  // 与 addHeaders 同理：Vue 可能只清掉两个注入 <col> 中的一个，「有一个就跳过」的 guard 会让表头
  // 表永远比表体窄一列（老板 2026-09-08 第二张截图：表头横向错位 180px）。所以：
  //   ① 先删光再补齐，不用存在性 guard；
  //   ② 基准宽度优先取「原生 col 的 width 属性之和」（真页 25 列全带 width，确定性最强），
  //      取不到再回退 WeakMap 缓存 / 当前宽度扣除；宽度每次确定性写 base+extra，杜绝漂移。
  const baseWidth = new WeakMap();
  function ensureColumnWidths(tables) {
    const extra = COLUMN_WIDTHS.reduce((sum, width) => sum + width, 0);
    tables.forEach(table => {
      if (!table) return;
      const group = table.querySelector('colgroup');
      if (!group) return;
      const had = group.querySelectorAll('col[data-jisilu-enhancer]').length;
      group.querySelectorAll('col[data-jisilu-enhancer]').forEach(col => col.remove());
      // 插入锚点：element-ui 表头 colgroup 末尾有一个 0 宽 gutter <col>（滚动条占位），表体没有。
      // 若把注入 <col> 直接 append 到末尾，会被 gutter 顶错位一位——amount 列映射到 gutter(w:0)塌成 0 宽、
      // profit 列占了 amount 的位置（真页实测：amount th w:0、profit th x:1030 与 amount 重叠）。
      // 故：当末尾 col 是 0 宽（gutter 特征）时，把注入 <col> 插到它前面，让 amt/profit 列落在 gutter 之前，
      // 与表体（无 gutter）注入列同位置对齐；无 gutter 时直接 append。保留 gutter 不与 element-ui 打架。
      let anchor = null;
      const cols = [...group.children].filter(c => c.tagName === 'COL');
      const last = cols[cols.length - 1];
      if (last && parseFloat(last.getAttribute('width')) === 0) anchor = last;
      COLUMN_WIDTHS.forEach(width => {
        const col = document.createElement('col'); col.setAttribute('width', String(width)); col.dataset.jisiluEnhancer = '1';
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
      // 表宽 = 原生 col 宽度之和(base，gutter 为 0 不计入) + 两注入列(extra)，表头/表体必然相等。
      if (base > 0) table.style.width = `${Math.round(base + extra)}px`;
    });
  }
  // Element-UI keeps the header wrapper clipped and mirrors the body's horizontal scroll onto it,
  // so the body wrapper must be able to scroll for the new columns to be reachable at all.
  function allowHorizontalScroll(table) {
    const wrapper = table?.closest('.el-table__body-wrapper') || table?.parentElement;
    if (!wrapper) return;
    const style = getComputedStyle(wrapper);
    if (style.overflowX === 'hidden' || style.overflowX === 'clip') wrapper.style.overflowX = 'auto';
  }
  // 板块取整措辞（用于 tooltip 说明「实际买入股数」为何与理论配售股数不同）
  function boardName(market) {
    return market === 'KCB' ? '科创板（200 股起，1 股递增）' : market === 'CYB' ? '创业板（整百）' : market === 'BJ' ? '北交所（整百）' : '沪深主板（整百）';
  }
  // 第 1 列悬浮（方案 B：自定义 HTML 浮层）：只讲「这笔钱怎么算」
  function amountTipHtml(row, funding) {
    return `<div class="je-tip">
      <div class="je-tip-title">配债所需资金 · 怎么算</div>
      <div class="je-tip-sec">
        <div class="je-tip-row"><span class="je-tip-k">正股现价</span><span class="je-tip-v">${row.price.toFixed(2)} 元</span></div>
        <div class="je-tip-row"><span class="je-tip-k">理论配售股数</span><span class="je-tip-v">${row.requiredShares} 股</span></div>
        <div class="je-tip-row"><span class="je-tip-k">实际需买入</span><span class="je-tip-v je-tip-strong">${funding.actualShares} 股</span></div>
        <div class="je-tip-row"><span class="je-tip-k">板块规则</span><span class="je-tip-v">${boardName(row.market)}</span></div>
      </div>
      <div class="je-tip-formula">实际买 ${funding.actualShares} 股 × 现价 ${row.price.toFixed(2)} = <b>${fmtMoney(funding.actualAmount)}</b></div>
      <div class="je-tip-note">这是潜伏配债需占用的资金（配 1 手 = 10 张）。第 2 列的安全垫用它作分母。</div>
    </div>`;
  }
  // 第 2 列悬浮（方案 B）：只讲「赚多少 / 跌多少白干」
  function profitTipHtml(row, safety, estimate) {
    const pred = estimate.prediction;
    const profitText = `${estimate.auto ? '~' : ''}${fmtMoney(safety.estimatedProfitTen)}${estimate.auto ? '（自动预估）' : ''}`;
    const predictSec = (estimate.auto && pred) ? `<div class="je-tip-sec">
        <div class="je-tip-row"><span class="je-tip-k">转股价值</span><span class="je-tip-v">${pred.cv.toFixed(1)}</span></div>
        <div class="je-tip-row"><span class="je-tip-k">债底</span><span class="je-tip-v">${pred.bondFloor.toFixed(1)}</span></div>
        <div class="je-tip-row"><span class="je-tip-k">三档上市价</span><span class="je-tip-v">保守 ${pred.conservative.price.toFixed(1)} · 中性 ${pred.neutral.price.toFixed(1)} · 乐观 ${pred.optimistic.price.toFixed(1)}</span></div>
      </div>` : '';
    const breakWarn = (pred && pred.isBreak) ? `<div class="je-tip-warn">⚠ 模型预估价低于 100 元面值，存在破发风险</div>` : '';
    return `<div class="je-tip">
      <div class="je-tip-title">预估盈利 · 安全垫 · 怎么看</div>
      <div class="je-tip-sec">
        <div class="je-tip-row"><span class="je-tip-k">预估盈利（10 张）</span><span class="je-tip-v je-tip-up">${profitText}</span></div>
        <div class="je-tip-row"><span class="je-tip-k">满额安全垫</span><span class="je-tip-v je-tip-up">${fmtRate(safety.fullRate)}</span></div>
        <div class="je-tip-row"><span class="je-tip-k">一手安全垫</span><span class="je-tip-v je-tip-up">${fmtRate(safety.oneLotRate)}</span></div>
      </div>
      ${predictSec}
      <div class="je-tip-formula">正股要跌 <b class="je-tip-down">${fmtRate(safety.fullRate)}</b> 你才白干（盈利被股价跌幅吃掉）</div>
      ${breakWarn}
      <div class="je-tip-note">${estimate.auto ? '自动预估为模型参考，非承诺；转股价发行前会按正股均价重定。' : '盈利为你手填的预期；点单元格可改。'}</div>
    </div>`;
  }
  function emptyProfitTipHtml() {
    return `<div class="je-tip"><div class="je-tip-title">预估盈利 · 安全垫</div><div class="je-tip-note">尚未填写预估盈利。点此单元格填「获配 10 张的预估总利润（元）」，即可看到满额与一手安全垫并自动着色。</div></div>`;
  }
  function enhancedCell(className, html, tipHtml, row, kind) {
    const cell = document.createElement('td');
    cell.className = `je-cell je-cell-${kind} ${className}`;
    cell.dataset.jisiluEnhancer = '1';
    cell.innerHTML = html;
    cell.onclick = () => root.JisiluPanel.open(row);
    if (tipHtml) {
      cell.addEventListener('mouseenter', () => root.JisiluTooltip.show(cell, tipHtml));
      cell.addEventListener('mouseleave', () => root.JisiluTooltip.hide());
    }
    return cell;
  }
  function rowTableFor(headerTable) {
    const tables = [...document.querySelectorAll('table')]; const position = tables.indexOf(headerTable);
    return tables.slice(position + 1).find(candidate => candidate.querySelector('tbody tr')) || headerTable;
  }
  // --- Rendering pipeline -------------------------------------------------------------
  // Every rows-table render runs as two passes:
  //   pass 1 (synchronous): render immediately with the page's own price and default settings,
  //     so a rebuilt row is complete again within milliseconds — the table is never left with a
  //     short body under a long header (the shifted-data bug users saw).
  //   pass 2 (after quotes/settings arrive): silently rewrite with real quotes.
  // A per-table generation counter drops stale pass-2 writes: if anything re-renders the table
  // while pass 2 was awaiting the network, the older pipeline must not write (it used to append a
  // second, duplicate pair of cells).
  const generation = new WeakMap();
  let lastWriteAt = 0;
  function collectRows(rowsTable, map) {
    const rows = [];
    [...rowsTable.querySelectorAll('tbody tr')].forEach(tr => {
      tr.querySelectorAll('[data-jisilu-enhancer]').forEach(node => node.remove());
      const row = extractRow(tr, map); if (row) rows.push(row);
    });
    return rows;
  }
  function priceFor(row, response) {
    const quote = response?.prices?.[row.stockCode];
    if (quote) return { price: quote.price, fetchedAt: quote.fetchedAt, source: quote.source, stale: !!quote.stale };
    // The visible Jisilu free-page price is a safe fallback when both public sources are unavailable.
    if (row.pagePrice > 0) return { price: row.pagePrice, fetchedAt: Date.now(), source: '集思录当前页面', stale: false };
    return null;
  }
  function writeCells(rows, response, state) {
    lastWriteAt = Date.now();
    for (const row of rows) {
      if (!row.tr.isConnected) continue;
      row.tr.querySelectorAll('[data-jisilu-enhancer]').forEach(node => node.remove());
      const setting = { ...root.JisiluStorage.defaults, ...(state?.global || {}), ...(state?.bonds?.[row.bondCode] || {}) };
      let message = inactiveReason(row); let funding; let safety;
      const quote = priceFor(row, response);
      if (quote) { row.price = quote.price; row.priceTimestamp = quote.fetchedAt; row.priceSource = quote.source; row.priceStale = quote.stale; }
      else if (!response) message = message || '正在获取行情…';
      if (!message && !row.price) message = response?.errors?.[row.stockCode] || '行情暂不可用';
      // 预估盈利：手动填写优先；否则用两层模型自动预估（转股价值锚 + 债底/涨停边界）。
      let estimate = { profit: setting.estimatedProfitTen, auto: false };
      if (!message && setting.estimatedProfitTen == null && row.conversionPrice && row.price) {
        try {
          const prediction = root.JisiluPredict.predict({ conversionPrice: row.conversionPrice, stockPrice: row.price, issueSize: row.issueSize, rating: row.rating, mood: setting.mood });
          estimate = { profit: prediction.neutral.profit, auto: true, prediction };
          row.prediction = prediction;
        } catch (_) { /* 预估失败则回退到手动填写 */ }
      }
      try { if (!message) { funding = root.JisiluCalc.calculateFunding({ requiredShares: row.requiredShares, stockPrice: row.price, market: row.market }); safety = root.JisiluCalc.calculateSafetyCushion({ funding, estimatedProfitTen: estimate.profit, requiredShares: row.requiredShares }); } } catch (error) { message = error.message; }
      // 「代号标签」显示在金额列顶部，让用户即使在最右也能立刻知道这行对应哪只转债
      const bondId = `<span class="je-bond-id">${escapeHtml(row.bondName || '').slice(0, 10)} <em>${escapeHtml(row.stockCode || '')}</em></span>`;
      let amount; let profit;
      if (message) {
        amount = enhancedCell('je-unknown', `${bondId}<span class="je-main">−</span><span class="je-meta">${escapeHtml(message).slice(0, 16)}</span>`, message, row, 'amount');
        profit = enhancedCell('je-unknown', '<span class="je-main">−</span><span class="je-meta">待补</span>', message, row, 'profit');
      } else {
        const color = root.JisiluColor.safetyClass(safety.fullRate, setting.thresholds);
        // 金额列副标题：实际买入股数（板块取整后）· 现价。主值已是配 1 手（10 张）所需资金，
        // 不再写「1手债 ¥X」（那是 1 张资金，旧版标错）。
        amount = enhancedCell('je-amount', `${bondId}<span class="je-main">${fmtMoney(funding.actualAmount)}</span><span class="je-meta">实际买 ${funding.actualShares} 股 · 现价 ${fmtMoney(row.price)}</span>`, amountTipHtml(row, funding), row, 'amount');
        // Without an estimated profit the safety margin is unknown by design, but "待补" alone reads
        // like a broken plugin, so the empty state has to tell the user what to do next.
        // 破发保护：自动预估中性价 < 100（老板共识：新债破发概率极低）→ 灰底 + 「⚠ 破发风险」标记
        if (Number.isFinite(safety.estimatedProfitTen)) {
          const isBreak = estimate.prediction && estimate.prediction.isBreak;
          const breakBadge = isBreak ? '<span class="je-break-badge" title="模型预估价低于面值（破发风险）">⚠ 破发</span>' : '';
          const profitClass = isBreak ? 'je-break' : `je-${color}`;
          profit = enhancedCell(profitClass, `<span class="je-main">${estimate.auto ? '~' : ''}${fmtMoney(safety.estimatedProfitTen)}</span>${breakBadge}<span class="je-meta">满额 ${fmtRate(safety.fullRate)}${isBreak ? ' ⚠' : ''}</span>`, profitTipHtml(row, safety, estimate), row, 'profit');
        } else {
          profit = enhancedCell('je-empty', '<span class="je-main">−</span><span class="je-cta">点击填预估盈利</span><span class="je-meta">填后自动算安全垫</span>', emptyProfitTipHtml(), row, 'profit');
        }
      }
      row.tr.append(amount, profit);
    }
  }
  async function renderTable(table) {
    // 扩展上下文失效：停掉自身定时自检并放弃本次渲染，避免同步抛「Extension context invalidated」。
    if (!contextAlive()) { stopSelfHeal(); return; }
    const data = columnMap(table); if (!data) return; const { header, map } = data;
    addHeaders(header);
    const rowsTable = rowTableFor(table);
    ensureColumnWidths([table, rowsTable]); allowHorizontalScroll(rowsTable);
    const rows = collectRows(rowsTable, map); if (!rows.length) return;
    const myGen = (generation.get(rowsTable) || 0) + 1; generation.set(rowsTable, myGen);
    writeCells(rows, null, null);
    syncHeaderScroll(rowsTable); // element-ui header/body 水平同步失效 → 手动同步（sticky 才有效）
    // The background service worker can be asleep or broken; losing it must not blank the table.
    // 用 safeSendMessage，扩展被 reload 后旧上下文的回调触发到这里也不会同步抛「context invalidated」。
    const [response, state] = await Promise.all([
      safeSendMessage({ type: 'GET_STOCK_PRICES', codes: rows.map(row => row.stockCode).filter(Boolean) }),
      root.JisiluStorage.read().catch(() => null)
    ]);
    if (generation.get(rowsTable) !== myGen) return; // superseded: a newer render owns this table
    writeCells(rows, response, state);
    syncHeaderScroll(rowsTable);
  }
  // element-ui 的 .el-table__header-wrapper 是 overflow:hidden + position:sticky，当 body wrapper 横向滚动
  // 时它本身不滚、也不通过 transform 同步（被 colgroup 改宽后失效）。手动同步 header.scrollLeft 是最稳的修法。
  function syncHeaderScroll(rowsTable) {
    const bodyWrapper = rowsTable.closest('.el-table__body-wrapper');
    const headerWrapper = bodyWrapper?.previousElementSibling?.querySelector?.('.el-table__header-wrapper')
      || document.querySelector('.el-table__header-wrapper');
    if (!bodyWrapper || !headerWrapper) return;
    if (headerWrapper._jeSync) return; // 单次绑定
    headerWrapper._jeSync = true;
    headerWrapper.scrollLeft = bodyWrapper.scrollLeft;
    headerWrapper.addEventListener('scroll', () => {
      if (Math.abs(headerWrapper.scrollLeft - bodyWrapper.scrollLeft) > 0.5) bodyWrapper.scrollLeft = headerWrapper.scrollLeft;
    });
    bodyWrapper.addEventListener('scroll', () => {
      if (Math.abs(headerWrapper.scrollLeft - bodyWrapper.scrollLeft) > 0.5) headerWrapper.scrollLeft = bodyWrapper.scrollLeft;
    });
  }
  // The enhancement is easy to miss: the two columns live at the far right of a wide, horizontally
  // scrolling table, and the safety margin stays empty until a profit is entered.
  let hintChecked = false;
  async function showHint() {
    if (hintChecked || document.querySelector('#jisilu-enhancer-hint')) return;
    // body 尚未创建时不能置 hintChecked，否则提示条会永久失效（它用于展示版本号，是核对是否生效的关键）
    if (!document.body) return;
    hintChecked = true;
    // storage 可能不可用或永远挂起（扩展 context 失效等），加超时兜底，提示条不能因此永远不出现
    let state = null;
    try {
      state = await Promise.race([
        root.JisiluStorage.read().catch(() => null),
        new Promise(resolve => setTimeout(() => resolve(null), 1500))
      ]);
    } catch (_) { state = null; }
    if (state && state.global && state.global.hintDismissed) return;
    const bar = document.createElement('div'); bar.id = 'jisilu-enhancer-hint';
    bar.innerHTML = `<span><strong>集思录潜伏配债增强 v${VERSION} 已启用</strong>：表格最右侧新增「配债所需资金」「预估盈利·安全垫」两列（深蓝金表头），需<strong>向右横向滚动</strong>查看。<strong>鼠标悬停</strong>单元格看计算口径，<strong>点击</strong>填写获配 10 张的预估盈利，即可自动算出安全垫。</span><button type="button">知道了</button>`;
    document.body.prepend(bar);
    bar.querySelector('button').onclick = async () => { bar.remove(); try { await root.JisiluStorage.saveGlobal({ hintDismissed: true }); } catch (_) { /* ignore */ } };
  }
  let timer;
  function renderAll() { for (const table of document.querySelectorAll('table')) renderTable(table); }
  // Mutations caused by our own writes would re-trigger rendering in a loop, so writes are muted
  // for a short window; everything else (including full element-ui tbody rebuilds) re-renders fast.
  function schedule() {
    if (!contextAlive()) { stopSelfHeal(); return; }
    if (Date.now() - lastWriteAt < 150) return;
    clearTimeout(timer); timer = setTimeout(() => { renderAll(); showHint(); }, 50);
  }
  // 兜底自检守护（老板 2026-09-08 第五张截图：表头在某些我无法复现的 element-ui 破坏路径下
  // 持续出现"只剩一列"。MutationObserver+schedule 已被证明覆盖不到全部触发场景，
  // 所以再叠一层 setInterval：每 1.5 秒检查三件不变量（注入 th 数、注入 col 数、两表等宽），
  // 任何一个不满足就全量重渲染 renderAll。1.5 秒窗口内自愈完成，老板视觉上几乎无感。
  function selfHealCheck() {
    // 扩展被 reload/unload 后旧 content script 的 setInterval 仍会触发；此时 chrome.runtime.id 已置空，
    // 立刻停掉自身定时自检，避免旧上下文反复抛「Extension context invalidated」污染错误面板。
    if (!contextAlive()) { stopSelfHeal(); return; }
    try {
      const hTbl = document.querySelector('table.el-table__header');
      const bTbl = document.querySelector('table.el-table__body');
      if (!hTbl || !bTbl) return;
      const hThs = hTbl.querySelectorAll('th[data-jisilu-enhancer]');
      const hCols = hTbl.querySelectorAll('colgroup col[data-jisilu-enhancer]');
      const bCols = bTbl.querySelectorAll('colgroup col[data-jisilu-enhancer]');
      const thW = hThs.length ? hThs[0].getBoundingClientRect().width : 0;
      const hW = parseFloat(hTbl.style.width);
      const bW = parseFloat(bTbl.style.width);
      // 四件不变量（无论 element-ui 表头有无 0 宽 gutter 列都成立）：
      // ① 表头注入 th 数=2；② 表头注入 col 数=2（插在 gutter 之前）；③ 表体注入 col 数=2；
      // ④ 表头首列 th 实际渲染宽度≥180（防 Vue 重绘剥掉宽度塌缩）；⑤ 两表等宽。
      const dirty =
        hThs.length !== 2 ||
        hCols.length !== 2 ||
        bCols.length !== 2 ||
        thW < 100 ||
        !Number.isFinite(hW) || !Number.isFinite(bW) || Math.abs(hW - bW) > 0.5;
      if (dirty) renderAll();
    } catch (_) { /* 单次自检失败不影响下次 */ }
  }
  const observer = new MutationObserver(records => { if (records.some(record => record.addedNodes.length || record.removedNodes.length)) schedule(); });
  // 第二层观察器：直接盯 element-ui 的表头表体表格，变化时绕过 schedule 抑制立即自愈
  // （比全文档 observer 反应更快、且不受 lastWriteAt 150ms 抑制影响）
  const tableObserver = new MutationObserver(() => { try { selfHealCheck(); } catch (_) {} });
  // 兜底定时自检：捕获所有我无法预测/复现的破坏路径
  let selfHealTimer = 0;
  // 脚本可能在 documentElement 创建之前就运行（content script 注入时机波动 / document_start）。
  // 老代码无条件 observe(document.documentElement) 会抛 TypeError 并让整段脚本中断，
  // 表现为「样式在但内容全无」的坏状态。这里改成：DOM 未就绪就挂事件等就绪后再启动。
  let booted = false;
  function boot() {
    // 必须等 body 就绪：renderAll 需要 table，showHint 需要 document.body
    if (booted || !document.documentElement || !document.body) return;
    booted = true;
    try { observer.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) { /* 观察失败不影响渲染 */ }
    // 给 el-table 内的 header/body table 各装一个直接观察器（结构变化时立即自愈）
    try {
      for (const tbl of document.querySelectorAll('table.el-table__header, table.el-table__body')) {
        tableObserver.observe(tbl, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
      }
    } catch (_) {}
    try { renderAll(); showHint(); } catch (_) { /* 单次渲染失败静默降级，后续 mutation 会重试 */ }
    // 1.5 秒一次的兜底定时自检
    if (!selfHealTimer) selfHealTimer = setInterval(selfHealCheck, 1500);
  }
  boot();
  if (!booted) {
    document.addEventListener('readystatechange', boot, { once: false });
    document.addEventListener('DOMContentLoaded', boot, { once: true });
    window.addEventListener('load', boot, { once: true });
  }
  root.JisiluPre = { refresh: () => { clearTimeout(timer); renderAll(); showHint(); }, version: VERSION };
})(globalThis);
