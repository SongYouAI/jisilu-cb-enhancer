/* 回归测试：manifest 完整性
   曾出过的事故：content_scripts.js 漏了 content/ui/tooltip.js，
   导致 JisiluTooltip 在真实扩展里从未定义，悬浮详情永远不出现。
*/
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

test('content_scripts 引用的所有 js/css 文件都真实存在', () => {
  for (const entry of manifest.content_scripts) {
    for (const f of entry.js) {
      assert.ok(fs.existsSync(path.join(ROOT, f)), `js 文件不存在: ${f}`);
    }
    for (const f of entry.css || []) {
      assert.ok(fs.existsSync(path.join(ROOT, f)), `css 文件不存在: ${f}`);
    }
  }
});

test('悬浮浮层模块 tooltip.js 必须在 js 清单里且在 jisilu-pre.js 之前', () => {
  const js = manifest.content_scripts[0].js;
  assert.ok(js.includes('content/ui/tooltip.js'), 'content_scripts 缺少 content/ui/tooltip.js');
  assert.ok(
    js.indexOf('content/ui/tooltip.js') < js.indexOf('content/jisilu-pre.js'),
    'tooltip.js 必须在 jisilu-pre.js 之前加载'
  );
});

test('jisilu-pre.js 引用到的全局模块都有对应文件被注入', () => {
  const js = manifest.content_scripts[0].js;
  const src = fs.readFileSync(path.join(ROOT, 'content/jisilu-pre.js'), 'utf8');
  // 脚本里用到的 root.JisiluXxx 必须有来源文件
  const needed = {
    JisiluRounding: 'core/rounding.js',
    JisiluCalc: 'core/calc.js',
    JisiluColor: 'core/color.js',
    JisiluRules: 'core/dates.js',
    JisiluPredict: 'core/predict.js',
    JisiluSelectors: 'config/selectors.js',
    JisiluTooltip: 'content/ui/tooltip.js',
    JisiluPanel: 'content/ui/panel.js'
  };
  for (const [globalName, file] of Object.entries(needed)) {
    if (src.includes(`root.${globalName}`)) {
      assert.ok(js.includes(file), `用到 root.${globalName}，但清单缺少 ${file}`);
    }
  }
});

test('样式必须走 JS 注入通道（styles.js 在清单且先于 tooltip.js）', () => {
  const js = manifest.content_scripts[0].js;
  assert.ok(js.includes('content/ui/styles.js'), 'content_scripts 缺少 content/ui/styles.js');
  assert.ok(
    js.indexOf('content/ui/styles.js') < js.indexOf('content/ui/tooltip.js'),
    'styles.js 必须在 tooltip.js 之前加载'
  );
  assert.ok(
    !manifest.content_scripts[0].css || manifest.content_scripts[0].css.length === 0,
    '不应再依赖 manifest 的 css 注入通道（样式统一走 styles.js）'
  );
});

test('styles.js 内嵌的 CSS 必须与 content/ui/styles.css 完全一致（防漂移）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'content/ui/styles.css'), 'utf8');
  const src = fs.readFileSync(path.join(ROOT, 'content/ui/styles.js'), 'utf8');
  const m = src.match(/const CSS = (".*");/s);
  assert.ok(m, 'styles.js 里找不到 const CSS = "..." 定义');
  let embedded;
  assert.doesNotThrow(() => { embedded = JSON.parse(m[1]); }, 'styles.js 的 CSS 字符串不是合法 JSON');
  assert.strictEqual(embedded, css, 'styles.js 内嵌 CSS 与 styles.css 不一致——改了 styles.css 后请运行 node tools/gen-styles-js.js');
});

test('manifest / package.json / jisilu-pre.js 三处版本号一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const src = fs.readFileSync(path.join(ROOT, 'content/jisilu-pre.js'), 'utf8');
  const m = src.match(/const VERSION = '([^']+)'/);
  assert.ok(m, 'jisilu-pre.js 里找不到 VERSION 常量');
  assert.strictEqual(manifest.version, pkg.version, `manifest(${manifest.version}) != package.json(${pkg.version})`);
  assert.strictEqual(manifest.version, m[1], `manifest(${manifest.version}) != jisilu-pre.js VERSION(${m[1]})`);
});
