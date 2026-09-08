(function (root) {
  'use strict';
  const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const value = (form, name) => form.elements[name].value.trim();
  function field(label, name, value, hint, step = 'any') { return `<label>${label}<input name="${name}" type="number" step="${step}" value="${escape(value ?? '')}" placeholder="继承全局默认">${hint ? `<small>${hint}</small>` : ''}</label>`; }
  const MOODS = { conservative: '保守', neutral: '中性（默认）', optimistic: '乐观' };
  const moodSelect = current => {
    const opts = Object.entries(MOODS).map(([v, label]) => `<option value="${v}"${current === v ? ' selected' : ''}>${label}</option>`).join('');
    return `<label>预估口径（市场情绪）<select name="mood">${opts}</select><small>影响「自动预估盈利」的三档区间，不影响手填值</small></label>`;
  };
  async function open(row) {
    document.querySelector('#jisilu-enhancer-panel')?.remove();
    const saved = await root.JisiluStorage.bondSettings(row.bondCode);
    const mood = saved.mood || 'neutral';
    // 自动预估（两层模型：转股价值锚 + 债底/涨停边界）
    let prediction = null;
    if (row.conversionPrice && row.price) {
      try { prediction = root.JisiluPredict.predict({ conversionPrice: row.conversionPrice, stockPrice: row.price, issueSize: row.issueSize, rating: row.rating, mood }); } catch (_) { /* 无预测能力则省略 */ }
    }
    const predBlock = prediction ? `<div class="je-predict">
      <p class="je-note">转股价值 <strong>${prediction.cv.toFixed(1)}</strong> · 债底 <strong>${prediction.bondFloor.toFixed(1)}</strong></p>
      <p class="je-note">自动预估盈利（10张）：保守 <strong>¥${prediction.conservative.profit.toFixed(0)}</strong> · 中性 <strong>¥${prediction.neutral.profit.toFixed(0)}</strong> · 乐观 <strong>¥${prediction.optimistic.profit.toFixed(0)}</strong></p>
      <p class="je-note">模型参考，非承诺；转股价发行前会按正股均价重定</p>
    </div>` : '';
    const panel = document.createElement('aside'); panel.id = 'jisilu-enhancer-panel';
    panel.innerHTML = `<header><strong>潜伏配债设置</strong><button type="button" data-close aria-label="关闭">×</button></header>
      <p class="je-subtitle">${escape(row.bondName || row.bondCode)} · ${escape(row.stockName || row.stockCode || '未识别正股')}</p>
      <p class="je-note">行情：${row.price ? `${row.price.toFixed(2)} 元` : '待获取'}${row.priceTimestamp ? ` · ${new Date(row.priceTimestamp).toLocaleTimeString('zh-CN')}` : ''}</p>
      ${predBlock}
      <form>
        ${field('预估盈利（获配10张总额，元）', 'estimatedProfitTen', saved.estimatedProfitTen ?? saved.defaultEstimatedProfitTen, '留空则用自动预估')}
        ${field('限售股份比例（%）', 'restrictedRatio', saved.restrictedRatio ?? saved.defaultRestrictedRatio)}
        ${field('预估配售比例（%）', 'allocationRatio', saved.allocationRatio ?? saved.defaultAllocationRatio)}
        ${moodSelect(mood)}
        <label>备注<textarea name="note" placeholder="例如：优配 30%">${escape(saved.note || '')}</textarea></label>
        <details><summary>计算说明</summary><p>金额按正股实际可买入股数计算；安全垫 = 预估盈利 ÷ 资金占用。自动预估采用「转股价值锚 + 债底/涨停边界」两层模型，输出保守/中性/乐观三档，仅供参考。</p></details>
        <footer><button type="button" data-reset>恢复继承</button><button type="submit">保存并重算</button></footer>
      </form>`;
    document.body.append(panel);
    panel.querySelector('[data-close]').onclick = () => panel.remove();
    panel.querySelector('[data-reset]').onclick = async () => { await root.JisiluStorage.resetBond(row.bondCode); panel.remove(); root.JisiluPre.refresh(); };
    panel.querySelector('form').onsubmit = async event => {
      event.preventDefault(); const form = event.currentTarget;
      const numeric = name => { const raw = value(form, name); return raw === '' ? undefined : Number(raw); };
      try {
        const input = { estimatedProfitTen: numeric('estimatedProfitTen'), restrictedRatio: numeric('restrictedRatio'), allocationRatio: numeric('allocationRatio'), note: value(form, 'note') };
        ['restrictedRatio', 'allocationRatio'].forEach(key => { if (input[key] !== undefined && (!Number.isFinite(input[key]) || input[key] < 0 || input[key] > 100)) throw new Error(`${key === 'restrictedRatio' ? '限售比例' : '预估配售比例'}必须在 0 到 100 之间`); });
        if (input.estimatedProfitTen !== undefined && !Number.isFinite(input.estimatedProfitTen)) throw new Error('预估盈利必须是数字');
        await root.JisiluStorage.saveBond(row.bondCode, input);
        await root.JisiluStorage.saveGlobal({ mood: value(form, 'mood') });
        panel.remove(); root.JisiluPre.refresh();
      } catch (error) { alert(error.message); }
    };
  }
  root.JisiluPanel = { open };
})(globalThis);
