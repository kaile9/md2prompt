# 2youg1的MD2Prompt

[English](README.en.md) · [下载最新版](../../releases) · [设计基准 SPEC](SPEC.md) · [反馈](https://github.com/kaile9)

> 本项目从设计到实现完全由 [Kimi K3](https://www.moonshot.cn) 搭建，未使用任何其它模型。

**一个 HTML 文件，就是你和 AI 之间的修订工作台。**

双击打开，像 Word 一样改 Markdown；你的每一处改动自动留痕；改完点一下「复制 Prompt」，AI 不用看原文、不用调工具，就能逐条读懂你改了什么、还想让它做什么。

![渲染模式](docs/assets/render.png)

## 为什么做这个

和 AI 远程协作改文案，有三个老毛病：

1. **Word 浪费 token**——AI 原生说 Markdown，没人想贴 `.docx`；
2. **普通 Markdown 渲染器吃掉提示词式 XML 标签**——`<identity>` 这类给 Agent 看的结构标签，渲染器 silently 吞掉，排版全乱；记事本直改图表源码又是转义灾难；
3. **每轮都要重新上传整个文件**——改了三句话，传了三百 KB。

MD2Prompt 的答案是：**协议比编辑器重要**。编辑器只是薄层，真正的产品是一份协议精确的 `Prompt.md` 日记——你的修改、你的批注，实时落盘成 AI 能精确消费的格式。

## 30 秒上手

1. 去 [Releases](../../releases) 下载 `2youg1-md2prompt.html`（就一个文件，6 MB，依赖全部内嵌，无后端、API 或遥测；编辑本地文件无需联网，远程图片与外链仍按浏览器规则请求网络）；
2. 双击，用 Chrome / Edge 打开，点「打开」选你的 `.md` / `.jsonl` / `.xml`；
3. 直接改。右侧「修订」栏立刻出卡片；
4. 点「复制 Prompt」，粘给 AI。AI 拿到：文档名、BLAKE3 哈希、每条修改（原文+新文+行号+时间）、每条批注；
5. AI 改完新版本发回来，保存成文件再「打开」——哈希配对成功，**你之前的全部留痕自动恢复**，接着改。

> 误触防护：原文始终干净，每个动作实时落盘。就算直接关网页，打开同目录的 `文档名.prompt.md` 复制内容照样能当提示词用。

## 功能一览

- **编辑即留痕**：替换/插入/删除/移动/批注五类变更自动记录，句级粒度展示（旧句删除线、新句高亮），像 Word 修订但不用点"接受"。
- **批注（B 类请求）**：选中文字 → 浮卡「✎」（或 `Alt+M`）；选段虚线下划线 + 批注钉；侧栏 B 卡显示引文（截断可展开）、可改注、可撤回——AI 拿到「源文本 + 你的批注」。
- **隐藏 / 撤回（两阶段）**：确认过的点「隐藏」收起；反悔点「撤回」——先预览删除线（可取消），再确认才回滚；撤掉的进 C 类墓碑（上限 50），随时「复活」。
- **渲染 / 源码 / 分屏三模式**：渲染所见即所得；源码是 CodeMirror（语法高亮、行号、查找替换）；分屏左源码右预览、双栏同步滚动。
- **XML 卡片直接改**：`<identity>` 等标签块渲染成卡片，点进卡内直接编辑源文，逐字留痕——不吞标签，也不弹窗整块替换。
- **渲染保真**：Mermaid 图、KaTeX 公式、Markdown 表格、图片（相对路径经目录授权）、脚注弹窗。
- **JSONL 数据集模式**：虚拟化记录卡片流（万行流畅），表单/原始 JSON 双页签编辑——可当 AI 训练数据清洗台。
- **大文档友好**：超 300KB / 2000 行自动切节，编辑器只扛一节，其余静态渐进渲染（950KB 文档半秒开）。
- **三主题 × 两风格**：纯黑 / 云石 / 暖纸 × 极客 / 人文；字号、字重、行距、页宽、对齐、亮度/对比度、中西文字体栈、首行缩进、行号栏、行引导线——长文案写作可以直接替代 Word。
- **编辑工具**：竖直工具轨（标题/引用/列表/代码块/分割线/链接/图片）+ 选区浮卡（B/I/S/行内码/链接/批注）+ 可自定义快捷键。
- **导出**：复制 Prompt（省略墓碑）/ 下载 Prompt.md / 下载干净副本 / 导出 PDF（页眉源文件完成时间、页脚导出时间）。

![纯黑主题](docs/assets/night.png)
![分屏对比](docs/assets/split.png)

## Prompt.md 长什么样（协议一瞥）

```xml
---
protocol: md2prompt/1.2.0
doc: 宪法中译.md
doc-hash: blake3:9f2c…
本次：B 类请求 1 条，A 类直接修改 2 条，C 类墓碑 0 条（无需执行）。
---
<requests>
<request id="B1" type="note" line="56" time="14:22">
这句太长，请拆成两句并补一个例子。
<quote>本宪法旨在指导 Claude 的价值观与行为……</quote>
</request>
</requests>
---
<edits>
<edit id="A1" type="replace" line="102" time="14:25">
<before>…原文…</before>
<after>…新文…</after>
</edit>
</edits>
```

- 协议 semver，major 相同即向下兼容；
- op 编号跨导出稳定（AI 端缓存友好）；大块修改走 `<del>/<ins>` patch 形（省 token）；
- C 类墓碑只留在日记里，复制时自动省略。

完整协议见 [SPEC.md](SPEC.md)（唯一权威设计基准，含全部修订记录）。

## 构建与开发

```bash
bun install
bun run dev      # 开发服务器
bun run build    # 产出单个 dist/2youg1-md2prompt.html
bun run check    # tsc --noEmit
bun test         # 153 例单元测试（11 个文件）
```

E2E（Playwright，需 Node）：`life.mjs`、`v13.mjs`、`note.mjs`、`srcmode.mjs`、`export.mjs`、`look.mjs` 这 6 个脚本会以非零退出码报告失败；`qa15-*`、`perf*`、截图脚本是人工探针，不作为自动门禁。

## FAQ

**为什么不做成 VS Code 插件？** 因为要服务的不是程序员场景，而是文案场景：双击即用、不改工作流、不装运行时。一个 HTML 文件是门槛最低的形态。

**AI 不会用工具也能配合吗？** 能。这正是设计目标：Prompt.md 里的一切都是自解释文本，AI 读完就知道该改哪、怎么改；它返回新全文即可，不需要任何函数调用。

**数据去哪了？** 应用不向服务端上传文档，没有服务端 API 或遥测；文件读写走浏览器 File System Access API，句柄存在你自己的 IndexedDB。文档中的远程图片会由浏览器按其 URL 加载，点击外链也会访问对应网站。

## 许可证

MPL-2.0（见 [LICENSE](LICENSE)）。作者：[2youg1](https://github.com/kaile9)。
