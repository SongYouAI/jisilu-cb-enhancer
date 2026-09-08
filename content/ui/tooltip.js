(function (root) {
  'use strict';
  // 方案 B：自定义 HTML 悬浮浮层（取代原生 title）。两列的悬浮内容不同：
  //   - 第 1 列（配债所需资金）：只讲「这笔钱怎么算」
  //   - 第 2 列（预估盈利·安全垫）：只讲「赚多少 / 跌多少白干」
  // 浮层跟随单元格左侧显示，靠近视口边界时自动翻到右侧；任意滚动立即隐藏（sticky 单元格会移动）。
  let el = null;
  function ensure() {
    if (el) return el;
    el = document.createElement('div');
    el.id = 'jisilu-enhancer-tooltip';
    el.setAttribute('role', 'tooltip');
    el.style.display = 'none';
    document.body.appendChild(el);
    // 任意滚动（含表格 wrapper 内部横向滚动）都让浮层失效，避免 sticky 单元格移动后浮层错位
    window.addEventListener('scroll', hide, true);
    return el;
  }
  function position(cell, tip) {
    const r = cell.getBoundingClientRect();
    tip.style.visibility = 'hidden';
    tip.style.display = 'block';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    // 优先放在单元格左侧；左侧放不下再放右侧；仍放不下则贴边
    let left = r.left - tw - 10;
    if (left < 8) left = Math.min(r.right + 10, window.innerWidth - tw - 8);
    if (left < 8) left = 8;
    let top = r.top + r.height / 2 - th / 2;
    if (top < 8) top = 8;
    if (top + th > window.innerHeight - 8) top = window.innerHeight - th - 8;
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
    tip.style.visibility = 'visible';
  }
  function show(cell, html) {
    const tip = ensure();
    tip.innerHTML = html;
    position(cell, tip);
  }
  function hide() { if (el) el.style.display = 'none'; }
  root.JisiluTooltip = { show, hide, position };
})(globalThis);
