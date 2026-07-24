# AGENTS.md — md2prompt 工作契约

产品：本地单文件 HTML 的 Markdown/JSONL 修改器，编辑即留痕、实时落盘协议精确的 Prompt.md 回传 AI。`SPEC.md` 是唯一权威设计基准；实现与 SPEC 冲突时改实现，不改 SPEC（除非用户明示）。

1. **完全理解前不动代码**：必读 `SPEC.md` → 目标模块全文 → 它的测试。
2. **语言**：TypeScript(strict) + Bun（e2e 用 node，bun 连不上 CDP）；原生 CSS，无框架、无 UI 库；不引新依赖。
3. **代码洁癖**：一行表达一个完整意思；删解释性临时变量、浅封装、仪式控制流；抽象必须守一条不变量或隔离一个变化点。
4. **极致性能 × 极简**：O(n²) 是事故不是设计；不拿正确性换性能；功能、配置、文件皆负债，先决定不做什么。
5. **不做任何在线**：无网络请求、无 API、无遥测、无 Web 字体；单文件双击即用，数据不出本机。

命令：`bun install / dev / check / test / build`；e2e 用 `node e2e/run.mjs`（CI 同口径，见 `.github/workflows/ci.yml`）。

测试三道硬门槛（协议/交互改动全跑）：`bun test`；`node e2e/run.mjs`；`node e2e/probes/full-sim.mjs`（真实浏览器操作级仿真，测试文档自写、不指定具体文案）。**断言通过不等于功能正确**——改 UI/交互必跑第三道并人眼过截图。

PR 四件（缺一件不收）：**问题**（现象+复现）、**解决方案**（思路与取舍+否决项）、**代码实现**（致密 diff）、**测试结果**（三道门槛实录+仿真截图）。

不变量（违反即 bug）：源文永不进 innerHTML（katex/mermaid 输出除外）；`serializeBlocks ≡ 原文`（Σ gap+text 逐字节）；账本纯由 base/cur diff 导出，swap 由显式命令记录并校验存活；协议 semver（当前 2.x，major 不符拒绝，2.x 不兼容 1.x），doc-hash 是导入配对唯一依据。

规模红线（SPEC §1）：总量 < 4000 行、单 TS 模块 < 400 行、CSS < 420 行；注释只写非显然不变量；UI 文案全部中文，集中在 `src/ui/strings.ts`。
