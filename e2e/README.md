# e2e 测试说明

## 目录语义

- **顶层 `*.mjs` = 回归套件**：全部带断言，由 `run.mjs` 顺序执行，是合并前的硬门槛之一。
- **`probes/` = 探针层**：
  - `full-sim.mjs` —— 真实浏览器仿真门禁（维护中）：像用户一样操作（冷启动/装载/调换/打字/批注三型/亮度对比度/面板折叠/转义符双路径/UI 截图/像素 sanity），第三道硬门槛。
  - `readme-shots.mjs` —— 重拍 README 展示图（`docs/assets/`，非测试）。
  - `精灵式生活指南.md` —— 仿真与展示共用夹具（90 行中文长文：h1+4×h2、多行引用块×4、脚注×4、hr×5、斜体、`D&D`/引号强调等序列化怪癖触发点）。
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

bun 1.3.14 实测（2026-07-23 本机，`bun smoke.mjs`）：chromium 进程起得来，但 playwright 的 CDP 管道连不上，`chromium.launch` 挂到 180s 超时。node（24）正常。所以套件入口 `package.json` 的 `test:e2e` 是 `node e2e/run.mjs`，e2e 一律用 node 跑。

## run.mjs 失败判定（三者任一）

1. 子进程退出码非 0 或被信号杀死（核心脚本自带 `process.exit`）；
2. 单脚本超时（默认 120s，`E2E_TIMEOUT_MS` 可改）；
3. 输出出现行首 `FAIL` —— `qa15-s*` 场景脚本只打印 PASS/FAIL 汇总、不置退出码，runner 补一道输出扫描，不为此改它们的逻辑。

## 已知备案（full-sim 内的 SKIP 项，产品侧结论，非测试缺陷）

- 主线无拖放打开（无 `#drop-veil`/dragover 处理），装载走「打开」按钮；
- D1：`canonText`（`src/core/ir.ts`）未覆盖 `\&` `\"` 与强调星号配对移位三类序列化怪癖，精灵指南夹具首次 flush 恒出 3 条幻影 replace；
- D2：多段落引用块 `Alt+↓` 的 swap 消歧对不上（`moveBlock` 取 `textContent` 首行，多段落无换行黏连），调换静默不记账；
- 窄屏自动折叠与细轨计数徽标、快捷键冲突警告（`.sc-warn`）主线均无对应功能。
