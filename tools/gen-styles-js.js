/* 一次性生成器：把 content/ui/styles.css 转成 content/ui/styles.js（JS 注入样式，替代 manifest css 通道） */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'content/ui/styles.css'), 'utf8');
if (css.includes('${')) { console.error('CSS 含模板字符串风险字符，终止'); process.exit(1); }
const js = `(function (root) {
  'use strict';
  // 样式经 JS 注入（与其它脚本同通道），替代 manifest 的 css 注入——
  // 避免扩展半更新时出现「脚本生效但样式丢失」的坏状态（老板 2026-09-08 第四张截图）。
  const CSS = ${JSON.stringify(css)};
  function inject() {
    const old = document.getElementById('jisilu-enhancer-styles');
    if (old) old.remove();
    const style = document.createElement('style');
    style.id = 'jisilu-enhancer-styles';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject, { once: true });
  else inject();
  root.JisiluStyles = { inject };
})(globalThis);
`;
fs.writeFileSync(path.join(ROOT, 'content/ui/styles.js'), js);
console.log('styles.js written,', js.length, 'bytes');
