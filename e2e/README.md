# e2e 测试说明

## 目录语义

- **顶层 `*.mjs` = 回归套件**：全部带断言，由 `run.mjs` 顺序执行，是合并前的硬门槛之一。
- **`probes/` = 探针层**：
  - `full-sim.mjs` —— 真实浏览器仿真门禁（维护中）：像用户一样操作（冷启动/拖放/调换/打字+hover/批注三型/亮度对比度/智能折叠/转义符双路径/快捷键冲突/UI 截图/像素 sanity），第三道硬门槛。
  - `readme-shots.mjs` —— 重拍 README 展示图（`docs/assets/`，非测试）。
  - `fixture-茶馆笔记.md` —— 仿真与展示共用夹具（自写中文长文：h1+3×h2、加粗段、引用块、列表、代码围栏、XML 块、mermaid、行内公式、GFM 表格、snake_case、脚注、hr）。
  - 其余 `qa15-*` / `perf*` / `visual` / `shots15` / `jsonl-rail` / `jumprepro` 等 —— 一次性 QA 探针、复现与性能/截图脚本的历史归档，**不进套件、不维护**；归档时未改相对路径（`../dist` 在 probes/ 下已失效），要复跑需自行把 `../dist` 改成 `../../dist`。
  - `qa15-s1-xml.mjs` 特殊说明：它的前提是「.xml 走 md 管线出 XML 卡」，v1.6 起 .xml 恒由 CodeMirror 源码承载（`xmlmode.mjs` 为门禁），前提已死，故归档；md 内嵌 XML 卡的边界由 `srcmode.mjs` 与 htmlguard 单测覆盖。

## 运行

```bash
bun install                 # 根依赖（bunfig.toml 已配 npmmirror）
bun run build               # 产出 dist/2youg1-md2prompt.html（所有 e2e 都跑在它上面）
cd e2e && bun install       # playwright
bunx playwright install chromium   # 首次

node run.mjs                # 全量回归（或 bun test:e2e，等价）
node run.mjs smoke life     # 只跑子集（文件名，可省 .mjs）
node probes/full-sim.mjs    # 浏览器仿真门禁
E2E_TIMEOUT_MS=180000 node run.mjs   # 慢机器放宽单脚本超时（默认 120s）
```

## 为什么必须 node 不能 bun

bun 实测始终卡在 CDP：chromium 进程起得来，playwright 的 CDP 管道连不上，`chromium.launch` 挂到 180s 超时（2026-07-23 bun 1.3.14 首测；2026-07-24 bun 1.4.0-canary.1 复测依旧）。node（24）正常。所以套件入口 `package.json` 的 `test:e2e` 是 `node e2e/run.mjs`，e2e 一律用 node 跑。

## run.mjs 失败判定（三者任一）

1. 子进程退出码非 0 或被信号杀死（核心脚本自带 `process.exit`）；
2. 单脚本超时（默认 120s，`E2E_TIMEOUT_MS` 可改）；
3. 输出出现行首 `FAIL` —— `qa15-s*` 场景脚本只打印 PASS/FAIL 汇总、不置退出码，runner 补一道输出扫描，不为此改它们的逻辑。

## 已知备案（产品侧结论，非测试缺陷）

- **现场输入文本按序列化器规则落盘**：渲染模式新输入的 `user_name` 一类文本落盘为 `user\_name`（canonText 只豁免未编辑文档的规范化差异；已编辑块保守保留 PM 序列化形——渲染等价、显示层逐字保真、CM 源码路径不受影响）。
