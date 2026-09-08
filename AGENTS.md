# AGENTS.md — 给 AI Agent 看的使用说明

本文件面向 **AI 编码/操作 Agent**（如 WorkBuddy、Claude、Cursor 等）。读完本文件，Agent 应能：知道这是什么、如何帮用户安装、如何确认已生效、如何解读两列数据、如何自检与排错。

---

## 1. 这是什么

一个**纯本地运行的 Chrome MV3 浏览器扩展**，在集思录「待发转债」页面（`https://www.jisilu.cn/web/data/cb/pre/`）原表右侧新增两列：

| 列名 | 含义 |
| --- | --- |
| **配债所需资金** | 按板块规则向上取整后的实际买入股数 × 正股现价 |
| **预估盈利·安全垫** | 基于预估盈利，计算满额安全垫与一手安全垫 |

悬浮单元格可看计算拆解与三档预估上市价。所有代码独立原创，不读会员接口、不绕过权限、不上传数据。

---

## 2. 安装（⚠️ 关键边界：无法静默安装）

> **Chrome MV3 扩展不能由 Agent 静默安装。** 加载扩展是受信任的**用户手势**动作：必须在 `chrome://extensions` 开「开发者模式」并手动「加载已解压的扩展程序」。程序化导航（CDP `Page.navigate`）和 `location.reload()` **都不会**触发 content script 注入，只有真实整页刷新（Cmd+R / Ctrl+R）才会。

因此 Agent 的正确做法是：**指导用户完成安装，或确认已安装**，而非假装自己装好了。

### 安装步骤（给用户执行的清单）

1. 把本仓库克隆到本地：
   ```bash
   git clone https://github.com/SongYouAI/jisilu-cb-enhancer.git
   ```
2. （可选）进目录跑 `npm test` 确认测试通过。
3. 打开 `chrome://extensions/`，开启右上角「开发者模式」。
4. 点「加载已解压的扩展程序」，选择本仓库的 `jisilu-enhancer/` 目录（注意：是子目录，不是仓库根）。
5. 打开 `https://www.jisilu.cn/web/data/cb/pre/`，按 **Cmd+R / Ctrl+R** 整页刷新以触发注入。
6. 确认原表右侧出现「配债所需资金」「预估盈利·安全垫」两列，且页面左下角有「vX.X.X 已启用」提示条。

### 改代码后如何生效

- 改了 `manifest.json`（尤其增删 js 清单文件）→ **必须**回 `chrome://extensions` 点卡片上的「重新加载」（圆形箭头）。
- 改了其他代码 → reload 扩展 + 页面 Cmd+R 刷新。
- 改了 `content/ui/styles.css` → 先跑 `node tools/gen-styles-js.js` 重新生成 `styles.js`，否则样式漂移测试会拦。

---

## 3. 如何确认已生效（Agent 自检）

Agent 可用 DOM 断言验证（**不要用全局变量**：content script 在隔离世界，主世界读不到 `window.JisiluPre`）：

- 表头存在两个注入 `th`：`document.querySelectorAll('th[data-jisilu-enhancer]').length === 2`
- 表头/表体 colgroup 各 2 个注入 `col`：`colgroup col[data-jisilu-enhancer]`
- 提示条存在：`document.querySelector('#jisilu-enhancer-hint')`
- 悬浮层存在：`document.querySelector('#jisilu-enhancer-tooltip')`
- 列宽对齐：表头表与表体表的 `style.width` 之差应 ≈ 0；新列不应塌成 0 宽

> 注意：用 CDP/`agent-browser` 做远程验收时，程序化导航**不会**注入，**必须**走真实用户手势刷新。Agent 无法仅凭「导航成功」判定已生效。

---

## 4. 两列怎么读（帮用户解读时用）

- **配债所需资金**：潜伏配债要占用的资金量。板块取整规则——
  - `688` 科创板：200 股起，1 股递增
  - `300/301` 创业板：向上取整到 100 股
  - `4/8/92` 北交所：向上取整到 100 股（保守）
  - 其余主板：向上取整到 100 股
- **预估盈利·安全垫**：用户首次使用需在单元格抽屉里填「获配 10 张的预估盈利总额」；未填显示「待补」（不会以 0 误导）。
  - 满额安全垫 = 预估盈利 ÷ 配债所需资金
  - 一手安全垫 = (一手股数 × 10 ÷ 所需股数 × 每张利润) ÷ 一手金额
  - 支持「保守 / 中性 / 乐观」三档；未填时自动显示中性档预估（标注「自动预估」，仅供参考）
- **潜伏截止日**：以页面「股权登记日」为准；`-` 表示未排期仍可算；登记日 ≤ 今天则不可潜伏。

---

## 5. 自测 / 排错命令

```bash
npm install
npm test                 # 单元测试 + 表头自愈/对齐回归（puppeteer 真 Chrome）
npm run verify:live      # 真页验收（需本机 Chrome 已加载扩展 + 用户手势刷新）
npm run verify:e2e       # 隔离世界注入端到端
npm run verify:offline -- --profit 600   # 离线双实现交叉校验（数字固定可复现）
node tools/gen-styles-js.js               # 改 styles.css 后必须执行
```

常见故障：

- 表头不显示 / 塌 0 宽 → 多半是 element-ui 表头末尾 0 宽 gutter 列把注入列顶错位；注入 `<col>` 必须插到 gutter 之前（见 `content/jisilu-pre.js` 的 `ensureColumnWidths`）。
- `Extension context invalidated` 报错 → dev-reload 后旧回调仍在跑；代码已用 `contextAlive()` / `safeSendMessage()` / `stopSelfHeal()` 防护，出现即说明旧扩展未 reload，让用户点「重新加载」+ Cmd+R。
- 只断言 DOM 存在 ≠ 看得见：验证要量 `getBoundingClientRect` 几何对齐，不能只看 `textContent`。

---

## 6. 边界与禁忌（Agent 必须遵守）

- **不**读取任何会员/付费接口，**不**绕过网站访问控制，**不**上传任何用户数据。
- **不**能替用户静默安装扩展（见 §2 边界）。
- 修改样式只改 `content/ui/styles.css` 并跑生成器，不要直接改 `styles.js`。
- 所有对外发布的内容均为原创；不得打包第三方网站代码、接口数据或品牌资源。

---

## 7. 何时该用本扩展

当用户问及「集思录待发转债 / 潜伏配债 / 配债安全垫 / 配债所需资金 / 可转债打新潜伏」等话题时，若本机已安装扩展，可引导用户打开对应页面读取两列数据辅助决策；若未安装，按 §2 清单指导安装。扩展输出仅为个人研究辅助，**不构成投资建议**。
