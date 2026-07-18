# 2youg1的MD2Prompt · 设计冻结稿（SPEC v1.5）

> 本文件是唯一权威设计基准。任何模块实现与本文冲突时，改模块，不改本文（除非用户明示）。
> 产品名：**2youg1的MD2Prompt**（UI 显示名；仓库/路径用 `md2prompt`）。作者 ID：2youg1，反馈入口 https://github.com/kaile9 。许可证：MPL-2.0。

> **v1.1 修订记录**（八路代码审查后，用户批准三项裁决）：
> 1. `Op` 各变体加可选 `line?: number`（内存态锚点，协议文件格式不变）：parse 保留行号、恢复按「行号邻近+文本匹配」重绑定、reject/恢复精确落位。
> 2. 新增 `editor/records.ts`（JSONL 卡片流，自 static.ts 拆出）；依赖删 `remark-stringify`。
> 3. move 撤销失同步：commit 时校验，失效 move 自动销账（v1 缓解）。
> 批准的实现偏离：`<request>` 带 `time` 属性（示例未列，信息必要）；跨行 edit 以围栏全文为锚，不重复 `<first>/<last>`；静态渲染走自建 mdast→DOM（textContent 不变量，优于 rehype-sanitize 的 schema 维护）；行号走块根 `data-line` 徽标，`#gutter` 留空。

> **v1.2 修订记录**（试用反馈二十条 + 两轮对齐，用户批准的十项变更）：
> 1. **接受/拒绝 → 隐藏/撤回**：op 生命周期 pending → hidden（已确认收起，仍导出）→ 可撤回；撤回两阶段（withdrawing 预令可取消 → withdrawn 墓碑）；墓碑进 Prompt.md 的 **C 类区段** `<withdrawn>`（复制 Prompt 时省略），上限 50 条可清空，可复活（restore，move 类导入墓碑除外）。base 不再会话内推进，只随「新基线」前进——accept 语义及其函数移除。
> 2. **句级 diff**：行内修订显示从词级改为句级（`sentDiff`），整句旧文删除线 + 整句新文高亮，消灭逐字碎片。
> 3. **协议 1.1.0**：`protocol: md2prompt/1.1.0`；删 `kind`（扩展名推断）、删 `updated`（op.time 已覆盖）；front matter 加 `withdrawn: n`；hidden op 写 `state="hidden"` 属性；semver 策略 = major 相同即向下兼容（含旧裸 `md2prompt/1`），哈希仍是配对唯一依据。
> 4. **跳转锚 = blockId**（行号只做展示与兜底）：修复编辑后行号漂移导致的随机跳转；活动节内经 PM 节点序落位，幽灵块 widget 带 `data-block-id`。
> 5. **状态栏**：光标「行 X · 列 Y」实时显示；文档/日记路径展示（浏览器安全限制只有文件名，无绝对路径；点击展开/收起，⧉ 复制）。
> 6. **导出 PDF**：打印样式表 + `window.print()`，保持屏幕排版不切换模式；页眉 = 源文件完成时间（File.lastModified），页脚 = 导出时间；干净 md 副本不含这两项。docx 方案取消（用户裁决）。
> 7. **首行缩进**：设置三档（关闭/仅渲染/写入文档）；写入档在导出与落盘文本前置两个全角空格（内存态不含，零 diff 噪音），且 Prompt.md 头部附自然语言排版要求行。
> 8. **行号栏开关**（设置，默认开）；块首行徽标照旧。
> 9. 修订面板分组：B → A → 已隐藏 → 已撤回（C 类）；「全部隐藏」替代「全部接受」。
> 10. 用户确认：批注选区创建路径（`<quote>` 扩展）、源码模式（CodeMirror）、XML 三档契约强化、性能前置渲染、外观批次为下一轮（批次 2/3/4），不在 v1.2。

> **v1.3 修订记录**（批次 1 验收修复 + 批次 2 批注打磨与协议 1.2.0，全部落地并经 131 例单测 + E2E 验证）：
> 1. **验收修复**：hidden 跨会话复活（load 播种 flags）；防抖窗连发移动按块合并；indentWrite 免缩进补 hr/setext/脚注/表格上下文 + 载入侧 indentStrip 闭环；句级 diff 经 `project()` 投影对齐 PM 纯文本（含行内标记句不再丢高亮）；跳转三修——widget key 带状态（PM 同 key 复用 DOM）、withTombstones 插入块不吞紧邻墓碑（prevBase 记 bi-1）、闪烁改挂 `<section>`（PM domObserver 会抹外部对托管 DOM 的 class 改写）；修复恢复链其余断点（墓碑 cap/导入 insert 墓碑补 id/坏 Prompt.md 不覆写）。
> 2. **批注（B 类）完整链路**：选区 → 浮钮「✎ 批注」→ 浮层输入（选段原文存 `quote`）；Alt+M 带选区自动附选段；同块重进为编辑模式（editNote）；文档内选段虚线下划线 + 批注钉；侧栏 B 卡显示引文 + 「改注」。
> 3. **协议 1.2.0**（解析端按 major 兼容，minor 增量）：① `<quote>` 元素（行内批注选段原文）；② **op 稳定编号**——导出 id = 类字母 + 诞生序号（`Op.seq`，diff op 经 seqs 表跨 commit 持有，恢复按文件最大编号续），跨导出 id 不变 → Agent 端缓存命中；③ **patch 形**——replace 块 >200 字符、改动全为「整句换整句」配对、patch 体量 ≤ 全文 60%、且 del/ins 锚点全唯一时，导出 `<del>/<ins>` 句对 + `<after-hash>`（截断 BLAKE3-16hex）替代 before/after 全文；恢复时 cur 块即 after 态（先验 hash）再反向应用 patch 得 before；JSONL 永远全文形；④ 头部摘要行（B/A/C 计数）。

> **v1.3.1 批次 2/3 收尾记录**（两轮验收 2 blocker + 5 major 全修，E2E 全绿）：
> 1. 审查修复：planPatch 锚点唯一性守卫（重复句退全文）；patch 形携带 note；协议号抬 1.2.0；seq/hidden 的 load 播种（含 delete 按 before 补绑）；annotateFlow 改 peekText 非破坏 flush（保撤销历史）；indentWrite 免缩进补链接定义；patch 恢复多候选逐一验哈希；parse 校验 del/ins 严格交替；noteFab 滚屏/失焦收起。
> 2. **批次 3 落地**：源码模式（CodeMirror 6，`editor/sourcemode.ts`，语法高亮/行号/查找替换/历史，与渲染模式同一 flush 管线）；XML 三档契约（提示词式标签开/闭/自闭合整行 → xml 卡片、开标签跨空行配对，标准 HTML 渲染档，危险标签转义档）；性能（节渐进渲染：活动节 ±1 同步、其余 12ms/帧空闲渐进；mermaid 视口懒渲染）——950KB 文档载入 1222→521ms、编辑器就绪 3060→720ms。

> **v1.4 批次 4 记录**（外观层，全部落地并经 E2E 13 项验收）：
> 1. **排版扩展**：字重滑杆（300–700，拖满展开数字输入可输 100–900 任意值，页宽同机制可超 60rem）；亮度/对比度滑杆（50–150%）+ 顶栏 ☀ 快切「标准 ↔ 我的自定义」；行引导线（人文风格专属，默认开）。
> 2. **进度双模式**：顶部传统细条 / 右侧 minimap（块级骨架 ∝ 文本量、修订标记、viewport 框、点击跳转）/ 关。
> 3. **侧栏拖拽调宽**：左右栏均可（280–560 / 160–360，localStorage 持久化；折叠轨不受影响）。
> 4. **编辑工具**：竖直工具轨（编辑栏右缘，块级动作 H1–H3/引用/列表/代码块/分割线/链接/图片，纯图标+tooltip）；选区浮卡（行内 B/I/S/行内码/链接/批注，选中才现、半透明、滚动失焦即隐）；快捷键自定义（7 个动作，设置面板捕获录入，document 捕获阶段分发先于 PM keymap）。
> 5. **视觉语言**：顶栏按钮 SVG 图标化（打开/新建/设置/亮度，不识字也能认路）；首启三步引导（coach marks，localStorage 记忆只出现一次）。

> **v1.4.1 批次 4 验收修复记录**（评审 2 blocker + 6 major 全修，E2E look 21 项全绿）：
> 1. **pinned 件统一范式**：`#page` 改为不滚动的壳，新增 `#scroller` 滚动容器——进度细条/工具轨/minimap 挂壳上（修复细条沉底、工具轨随滚动跑两例 blocker）；打印样式同步。
> 2. **快捷键收口**：document 捕获层为唯一分发入口（PM 内 Alt 组合删除）；Alt+M 带选区 quote；录入拒收无修饰键（防锁死输入）；源码/分屏下仅切模式键生效。
> 3. **设置联动**：滑杆/数字输入互斥修正（滑杆为源时清空数字框）；页宽持久上限与控件一致（200rem）；中性亮度/对比度不挂滤镜（night 性能）；prefs 模块级缓存（击键路径不读 storage）；reset 连 ☀ 自定义一并清。
> 4. **minimap**：骨架高度改 flex-grow ∝ 文本量（>50 块不裁尾）。
> 5. **分屏对比**：模式钮三态循环（渲染/源码/分屏）——左 CM 源码可编辑、右静态渲染随 flush 实时预览。
> 6. 选区浮卡贴顶翻下、右缘夹视口；coach 支持 Esc；toolbar/shortcuts 文案归位 strings.ts。

> **v1.5 记录**（界面收敛九条反馈，全部落地；tsc + 140 例单测 + E2E 六套全绿）：
> 1. **界面收敛**：删底部状态栏——光标「行 X · 列 Y」进顶栏右区；路径行进修订面板（⧉ 复制 = 设置里的「目录前缀」+ 文件名拼出的完整路径，浏览器不暴露绝对路径，此为唯一诚实通道）。顶栏 ☀ 钮删除，亮度/对比度只住设置面板。
> 2. **修订面板页签化**：修订 / 批注 / 墓碑 三分栏（各带计数，选择持久化 `md2prompt.tab`），替代 B→A→隐藏→撤回长列表。
> 3. **进度单件化**：默认 minimap（骨架条跳转 + 空白点击按比例滚动），细条/minimap/关三选一互斥；原生滚动条瘦身（10px 半透明）退居次视觉。
> 4. **XML 卡片直编**：编辑器内 XML 卡正文 = 围栏内源文（contentDOM），点击即改、逐字入账成句级 diff（Word 直觉），不再弹浮层整块替换；stripTag/renderSnippet/xmlSource 死代码移除。
> 5. **跳转精确居中**：统一 `centerOn(el)`（自算 scrollTop，progress.ts 导出）——根治旧实现「先滚块、再对整节 scrollIntoView 二次推中」的大节跳飞；行号兜底查找优先 `.blk[data-line]`（节容器自身也带 data-line，直中整节会乱跳）。
> 6. **分屏重做**：页宽放开（`#page[data-mode=split]` 去 measure 上限）；双侧等高独立滚动 + 比例同步（rAF 解回声）；右侧不画行号徽标（块首行号非逐行，与 CM 行号并排必显错乱），左 CM 行号为准。
> 7. **潜伏层级 bug 修复**：`#floater`（fixed 自带层叠上下文）z-auto → 内部 backdrop 的 z-60 出不来，根层级的 minimap(z-5) 压在整个浮层子树上吞点击（v1.4 潜伏，默认开 minimap 后暴露）；`#floater/#popover` 显式 z-70。
> 8. **引文/批注可展开**：修订卡的选段引文与批注行全文完整进 DOM、截断纯 CSS，点击展开/收起——默认不占版面，展开后与 Prompt 内容逐字一致，便于对着想象实际 Prompt。

> **v1.5.1 审查/QA 修复记录**（explore 审查 1B+4M+10m、QA 代理 8 场景实测 4 缺陷，全部修复并复验）：
> 1. **分屏预览**：文本未变不重渲（hide/撤回等轻动作不打断阅读）；重渲按比例恢复滚动（renderStatic 加 onDone）；打印重置分屏布局、只输出渲染侧。
> 2. **跳转**：`centerOn` 容器自适应（`.split-view` 独立滚动容器）+ 全 0 矩形上溯可见祖先（折叠 XML 卡）；DOM 直查排除 section（节容器携带上次跳转的 id 标记，二次跳转曾命中整节巨块，QA F4）；源码/分屏新增 `scrollSourceTo` 按行居中；行号兜底落前一块不飞下节；卡头补 mousedown 守卫。
> 3. **XML 卡直编护栏**：Ctrl+A 在 code_block 内只全选本块文本（默认 selectAll 会让重打内容逃逸成普通段落并被序列化转义 `\<`，QA F1/F2）；档一配对跨围栏（XML 内容里的 ``` 是内容不是文档围栏，fenceScan 曾把块劈碎，QA F3）；`xmlCardView.update` 收窄 `-xml` 档；空卡徽标兜底 `xml`。
> 4. **杂项**：快捷键捕获层 `return`→`continue`（源码/分屏下切模式键复活，v1.4.1 遗留）；minimap 改 flex basis 0 高度全 ∝ 文本量（万块不裁尾）；flashEl 重触发重启动画；换文档清旧行列；`joinPath` 分隔符跟随前缀风格；`#floater/#popover` z-70（另见 v1.5-7）。

## 0. 产品一句话

本地、单文件 HTML、免安装、秒开的 Markdown/JSONL 修改器：所见即所得编辑即留痕（Word 修订心智），把人的修改与批注实时落盘为一份**协议精确的 Prompt.md**，复制即可回传任何 Agent，无需重传原文、无需 Agent 调工具。

不做：接任何 API、版本历史浏览、多人协作、vault 管理、任务列表、反向 diff 导入（AI 回改的新版本按「新基线」处理）。

## 1. 技术与构建

- 运行时：浏览器单页应用。构建：Bun + Vite + `vite-plugin-singlefile`，产出**单个 HTML**（`dist/2youg1-md2prompt.html`），双击即用。
- 源：`bunfig.toml` 配 `[install] registry = "https://registry.npmmirror.com"`（npmjs 直连不通）。
- 运行依赖（全部经 npmmirror；无 Web 字体，只用系统字体栈）：
  - 编辑：`@milkdown/core` `@milkdown/ctx` `@milkdown/preset-commonmark` `@milkdown/preset-gfm` `@milkdown/plugin-history` `@milkdown/plugin-listener` `@milkdown/utils` `prosemirror-commands` `prosemirror-model` `prosemirror-schema-list` `prosemirror-state` `prosemirror-view`
  - 源码模式：`@codemirror/commands` `@codemirror/lang-markdown` `@codemirror/language` `@codemirror/search` `@codemirror/state` `@codemirror/view` `@lezer/highlight`
  - Markdown AST/静态渲染：`unified` `remark-parse` `remark-gfm` `remark-math`（v1.1 起静态渲染走自建 mddom，不再需要 rehype 系）
  - 哈希：`@noble/hashes`（BLAKE3 为主，SHA-3 备用）
  - 图与公式：`mermaid`、`katex`（均打包进单文件；初始化惰性——首次用到才 `initialize`，避免白屏成本）
- `vite-plugin-singlefile` 关闭代码分片并内联动态依赖；`assetsInlineLimit` 拉满（KaTeX 字体 base64 内联）。
- TS strict。目标：应用代码总量 < 4000 行；单文件 TS 模块 < 400 行，CSS < 420 行（紧凑格式）；注释只写非显然不变量；UI 文案全部中文、集中在 `ui/strings.ts`。超线备案：main.ts（870，装配集中）、styles.css（约 550，三主题变量密集）——v1.5.1 评审确认暂不拆，新增功能优先向对应小模块归位。
- 工程质量红线（用户原话转述）：鲁棒、简洁、概念清晰、易扩展，K3 级模型可轻松 debug/加功能。**禁止**投机性抽象、死代码、重复实现。

## 2. 核心架构：Block IR 一个原语

```
文件 ──parse──▶ Block[] ──┐
                          ├─▶ diff(base, cur) ─▶ Op[] ─▶ render ─▶ Prompt.md（实时落盘）
编辑器（活动节/记录浮层）──┘                                   │
界面（大纲/行号槽/修订面板/静态渲染）◀── Block[] + Op[] ◀───────┘
```

- **Block** 是唯一文档单位。Markdown 块（heading/para/code/table/html/list/quote/hr/math）；JSONL 每条记录一行 = 一个 `record` 块；.xml 文件整体 = 一个 code 块。
- **变更引擎不认编辑器事件，只 diff Block 数组**：粘贴、撤销、批量替换全部天然正确。移动（move）无法从 diff 推断，由**显式命令**（Alt+↑/↓、拖拽为 v2）记录；commit 时校验，失效 move（如被撤销）自动销账。
- 按键成本 = O(活动节)：commit 只重算 ops 与行号；序列化+哈希+Prompt 渲染在 800ms 防抖落盘通道内异步完成，不进按键同步路径。

```ts
interface Block {
  id: string;            // 会话内稳定：装载时 'b'+序号；新块发新 id
  kind: 'heading'|'para'|'code'|'table'|'html'|'list'|'quote'|'hr'|'math'|'record';
  text: string;          // 该块的规范序列化源文（md 源或 JSONL 原始行）
  lineStart: number;     // 1-based，相对当前序列化全文
  lineEnd: number;
  meta?: { level?: number; lang?: string; json?: unknown; [k: string]: unknown };
  gap?: string;          // 块前分隔符原文（首块 ''）；新建块缺省 '\n\n'。serialize = Σ(gap+text)
}

type OpState = 'hidden' | 'withdrawing' | 'withdrawn'; // 缺省 = pending
interface OpBase { id: string; blockId: string; time: string; note?: string; line?: number; state?: OpState }
type Op =
  | OpBase & { type: 'replace'; before: string; after: string }
  | OpBase & { type: 'insert';  after: string }
  | OpBase & { type: 'delete';  before: string }
  | OpBase & { type: 'move';    first: string; from: [number, number]; to: number }
  | OpBase & { type: 'note';    note: string };  // B 类：文本不动

interface DocState {
  file: { name: string; kind: 'md'|'jsonl'|'xml' };
  base: Block[];   // 基线（导入/新基线时；会话内不推进）
  cur: Block[];    // 当前
  ops: Op[];       // 未决变更（pending/hidden/withdrawing；A 类 + B 类 note），按文档位置排序
  withdrawn?: Op[]; // C 类墓碑（state='withdrawn'），可复活，上限 50 条
}
```

- `diffBlocks(base, cur)`：先按 id 对齐，未匹配块走 LCS（归一化相似度 > 0.6 判 replace，否则 delete+insert；长度积超护栏直接 delete+insert，防主线程冻结）。`time` 一律本地 `HH:MM`。diff op id 为 `a:{blockId}:{type}` 确定性串——生命周期标记（flags）依附其上，跨 commit 存活。
- **生命周期**：pending →（hide/unhide）hidden；任意非预令态 →（withdraw）withdrawing：文档内预览「将消失文本删除线、将恢复文本绿虚框」，可 cancelWithdraw 回 pending；再击（withdrawCommit）真正回滚 cur（rejectOp 语义），op 转 withdrawn 墓碑；restore 复活 = `applyOps(cur,[op],1)` 重放（note/move 回人工集）。
- 恢复/导入：读 Prompt.md → 校验 `doc-hash == hash(打开的文件)` → parse 得 ops（带 `line`；墓碑直通）→ 活跃 op `rebindOps` 按「行号邻近 + 文本匹配」重绑 blockId → 按 ops **逆序取反**重建 base（replace 放回 before、insert 移除、delete 按行号插回、move 移回），每步验证文本相等（`\r\n`/`\n` 归一化后比较）；任一步失败 → 提示用户「以当前文件为新基线」。

## 3. Prompt.md 协议（产品灵魂，冻结格式）

文件名：`<文档名去扩展>.prompt.md`，与文档同目录。**每次变更防抖 800ms 重写**，即使页面被关，本地打开即可复制为提示词。

```markdown
---
protocol: md2prompt/1.2.0
doc: report.md
doc-hash: blake3:9f3ac2…      # 当前文档全文哈希 —— 导入配对唯一依据
base-hash: blake3:71be04…     # 基线哈希
pending: 3
withdrawn: 1
---

# 修改记录 · report.md
> 由 2youg1的MD2Prompt 生成。B 类 = 请求 Agent 修改；A 类 = 人已直接修改。行号基于当前文档。
> 本次：B 类请求 1 条，A 类直接修改 2 条，C 类墓碑 1 条（无需执行）。

<requests>
<request id="B3" lines="12-15" time="13:05">
<first>我们认为协议比编辑器重要</first>
<last>……因此插件只是薄层。</last>
<quote>协议比编辑器</quote>
<note>这段逻辑跳跃，请补一个过渡论证</note>
</request>
</requests>

---

<edits>
<edit id="A1" type="replace" line="8" time="13:22">
<before>把文件修改的内容完整导出</before>
<after>把文件修改的内容连同位置与意图完整导出</after>
<note>可选</note>
</edit>
<edit id="A2" type="replace" lines="21-23" time="13:40" form="patch">
<del>被替换掉的旧句子。</del>
<ins>换入的新句子。</ins>
<after-hash>blake3:9f3ac2aa71be04bb</after-hash>
</edit>
</edits>

---

> C 类 = 已撤回的修改（墓碑记录，无需执行；复制 Prompt 时自动省略）。

<withdrawn>
<edit id="C1" type="replace" time="13:02">
<before>撤回前的原文</before>
<after>已撤掉的新文</after>
</edit>
</withdrawn>
```

规则（render 与 parse 双方必须一致）：

1. 顺序：B 类在前，`---` 分隔线，A 类在后；各自按文档位置从头到尾。C 类殿后（仅日记文件含墓碑；**复制 Prompt 版本省略**）。
2. 锚点：单行目标给完整文本 + `line`；跨行目标给首行 `<first>` + 末行 `<last>` + `lines="a-b"`。replace 的 before/after 为块全文本：单行内联，多行放进自适应长度围栏（``` 数量 > 内容中最长反引号串），跨行 edit 以围栏全文为锚，不再重复 first/last。JSONL 记录的 before/after 一律 ```json 围栏。**patch 形**（1.2.0）：满足 §3 patch 条件的 replace 改发 `<del>/<ins>` 有序句对 + `<after-hash>`（`blake3:` + 16 hex 截断）；恢复时以 cur 块为 after 态验哈希，再反向应用 patch 得 before。行内批注的选段原文入 `<quote>`（1.2.0）。
3. `time` 为本地 `HH:MM`。解析端对 ISO 格式 time 宽容并归一化（防御外部生产者）。
4. 协议解析器只认 front matter + `<requests>/<edits>/<withdrawn>` 结构；正文其余文字（标题、引言）忽略，容忍人手工加注。
5. 哈希函数默认 BLAKE3（`blake3:` 前缀），解析器也接受 `sha3-256:`。大字符串分块异步计算（1MB 片），不阻塞 UI。
6. **版本策略（semver）**：`md2prompt/M.m.p`；major 相同即向下兼容（含旧裸 `md2prompt/1`），major 不符拒绝。minor = 字段增删（解析端容忍未知行、缺省补齐）；patch = 文案级。墓碑元素与活跃元素同构（`state` 由区段隐含，不写属性）；hidden 活跃 op 写 `state="hidden"`；withdrawing 按 pending 导出（预令不落盘）。
7. **缓存与注意力（1.2.0）**：op 导出 id = 类字母 + 诞生序号，跨导出不变（会话内 seq 持久，恢复按文件最大编号续）——前缀逐字节稳定，Agent 端缓存命中最大化；头部摘要行给出 B/A/C 计数，Agent 首行即得全局地图。

## 4. 编辑体验（两种文件形态，一个变更协议）

### 4.1 Markdown：活动节 WYSIWYG

- 阈值：文档 < 300KB 且 < 2000 行 → 全文一节；否则按 h2（无 h2 按 h1）切节。
- **活动节**：Milkdown（ProseMirror）全文所见即所得，直接像 Word 一样改。**非活动节**：自建 mdast→DOM 静态渲染（createElement+textContent，源文永不注入 innerHTML；便宜、可随滚动惰性挂载）。
- 切节：点击静态节 → 该节变活动（flush 当前节文本 → cur，销毁，装载新节源文）。**flush 必须忠实**：装配时过滤 Milkdown 默认改写源文的插件（remarkInlineLinks 等）；`destroyEditor` 返回最终文本（防抖尾巴不丢字）；XML 保护围栏带会话随机标记，只拆自己生成的。
- 修订可视化（Word 心智，全部走 ProseMirror decoration，不污染文本）：
  - 替换：块内**句级** diff（`core/diffview.ts` sentDiff，v1.2）——旧句删除线、新句高亮；
  - 删除块：灰色幽灵块 + 删除线；插入块：左侧高亮条；移动：块首移动徽标；批注：块右侧批注钉，悬停显示；
  - hidden 的 op 无任何标记；withdrawing 预令：将消失文本删除线、将恢复原文绿虚框幽灵块（二次确认的可视化）；
  - 非活动节不渲染行内痕迹，只在节左边框显示「含 N 条修订」徽标（不计 hidden）。
- 命令：Alt+↑/↓ 移动当前块（记 move）；**批注（v1.3 完整链路）**：选中文字 → 浮钮「✎ 批注」（或 Alt+M，带选区自动附选段）→ 浮层输入（选段原文存 `quote`，同块重进为编辑模式可改注）；文档内选段虚线下划线 + 批注钉；侧栏 B 卡显示引文 + 「改注」。撤销/重做（history 插件）。
- **源码模式（批次 3）**：顶栏「〈/〉 源码」切换——活动节由 CodeMirror 6 承载（Markdown 语法高亮、行号栏、查找替换、历史），与渲染模式同一 flush 管线（200ms 防抖 → applySectionText）；XML/图表永远以原文可见可改。修订痕迹、批注浮钮属渲染模式，源码模式不画；状态栏行列照常。渲染模式是默认主战场。
- 表格：单元格直接编辑（gfm preset）；图片：标准 `![]()` 与 `<img>` 均渲染，相对路径经目录句柄解析为 object URL（打开文档时一次性请求父目录授权，可拒绝，拒绝则占位图）；脚注：上标渲染，点击弹窗显示内容+跳转；链接正常可点（URL 白名单：http(s)/mailto/相对路径/blob，img 额外放行 data:image/）。

### 4.2 特殊块：一个浮层模式，三个消费者

`editor/floater.ts` 提供通用块浮层编辑器（文本域 + 预览槽 + 保存/取消）。消费者：

- **mermaid**：渲染为图，点击进入浮层改源码、即时预览；
- **math**（remark-math + KaTeX）：渲染公式，点击浮层改 LaTeX；
- **提示词式 XML 标签块**：白名单规则 `/^[a-z][a-z0-9-]{1,24}$/` 的标签块渲染为「区块卡片」——标签名徽标 + 可折叠；**编辑器内卡片正文即源文，点击直接改**（v1.5，contentDOM，句级 diff 入账）；静态节渲染为内部 markdown 卡片（共享渲染助手）。行内未知标签渲染为等宽 chip 原样可见。`script/style/iframe/object/embed` 一律显示为转义代码块，永不执行。

### 4.3 JSONL 数据集模式

- 虚拟化记录卡片流：IntersectionObserver 窗口化，视口 ±50 条；无编辑器开销，万行级流畅。
- 卡片渲染：常见字段优待（`messages` → role 标签对话轮；`text`/`prompt`/`completion` → 折行长文），其余键值平铺；解析失败的行显示原始文本 + 语法错误徽标。
- 点卡片 → 记录浮层编辑器：已知字段表单 / 原始 JSON（带校验）两个页签。保存 = 整行替换（replace），批注 = B 类（数据清洗指令）。新增记录 = 在指定行后插入一行（insert）。
- 行号即记录号，锚定天然稳定。

## 5. 界面布局与主题

- 布局三栏（均可折叠 + 拖拽调宽，v1.4；v1.5 删底状态栏）：左 = 大纲（标题树/记录号，点击跳转）；中 = 页面（行号走块根 `data-line` 徽标，可关；右缘竖直工具轨）；右 = 修订面板（**页签：修订 / 批注 / 墓碑**，v1.5；逐条 隐藏/撤回/跳转，预令卡 确认撤回/取消，墓碑卡 复活，全部隐藏，导出按钮组：复制 Prompt / 下载 Prompt.md / 下载干净 md / 导出 PDF，下嵌文档与日记路径行）。
- 光标行列（顶栏右区，v1.5）：「行 X · 列 Y」实时（PM 选区 → 块行号 + 块内偏移）。路径行（修订面板内）：文档 + 日记，缩略可展开，⧉ 复制「目录前缀 + 文件名」拼出的完整路径（浏览器不暴露绝对路径；前缀在设置中给，可为空）。
- 编辑工具（v1.4）：竖直工具轨（块级动作，纯图标）；选区浮卡（行内格式 B/I/S/行内码/链接/批注，选中才现）；快捷键 7 动作可自定义（设置面板捕获录入，document 捕获阶段分发）。
- 进度单件化（v1.5）：默认右侧 minimap（块级骨架 ∝ 文本量、修订标记、viewport 框、点骨架跳转、点空白按比例滚动）；可换顶部细条或关闭；原生滚动条瘦身退居次视觉。
- 跳转（v1.2 锚 = blockId；v1.5 居中修正）：静态节/虚拟列表/幽灵块 widget 均有 `data-block-id` 直查；活动节内经节内非幽灵序映射 PM 顶层节点（跨节先切节、编辑器就绪后挂起滚动）；行号仅作兜底（墓碑/无 id 场合，优先 `.blk[data-line]` 精确命中）；落点一律 `centerOn` 自算 scrollTop 居中，闪烁只加 class 不再滚动。
- EPUB 式排版设置（持久化 localStorage，CSS 变量驱动）：字号、**字重**（滑杆+满档数字输入，v1.4）、行距、页宽、两端/左对齐、**亮度/对比度**（滑杆+顶栏 ☀ 快切，v1.4）、首行缩进三档（关闭/仅渲染/写入文档）、行号栏开关、**行引导线**（人文专属，v1.4）、中文字体栈、西文字体栈（各给策划栈 + 自定义输入）。
- 打印（v1.2）：保持屏幕排版（不切换主题/样式），只藏界面件与修订标记；页眉 = 源文件完成时间（`File.lastModified`），页脚 = 导出时间；`@page` 页边留白。干净 md 副本不含页眉页脚。
- 主题 3 × 风格 2，独立两轴：
  - 主题：`night` 纯黑 #000（无渐变无阴影，极致性能）｜`marble` 灰蓝（纸面 #eef1f4 墨 #2b3440）｜`paper` 暖稿纸（#f7f2e8 墨 #3a3128）；
  - 风格：`geek` 几何无衬线 + 等宽点缀、紧凑节奏｜`humanist` 衬线中文 + 打字机西文、宽松节奏。
- DOM 契约（id 冻结）：`#app` > `#outline` `#page`（内 `#scroller` > `#gutter` + `#doc`；壳上挂 `#tool-rail` `#minimap` `#progress-bar`）`#changes`；顶栏 `#topbar`（打开/新建钮、文件名、保存状态 `#save-state`、`#cursor-pos`、`#mode-btn`、设置钮）；浮层挂载点 `#floater`；弹窗 `#popover`；选区浮卡 `#sel-card`；打印专用 `#print-head` `#print-foot`。
- 关于/设置页底部放反馈链接 https://github.com/kaile9 。

## 6. 文件 IO（双后端，缺一不可）

- **FS Access 后端**（Chrome/Edge 主路径）：`showOpenFilePicker`/`showSaveFilePicker`；句柄存 IndexedDB（自写 <40 行 store，不引库），重启后一键恢复；保存状态指示（已存/写入中/失败）。
- **降级后端**（Firefox/自动化测试）：`<input type=file>` 打开 + Blob 下载保存；Autosave 退化为「内存保留 + 提示下载」。
- 打开文档即请求父目录句柄（图片解析用，可拒绝；选后试读文档名探测选错目录）。同目录找 `<名>.prompt.md` 自动尝试配对恢复；哈希不符 → 提示「新基线 / 仍尝试恢复 / 忽略」。
- 新建文档：空白起步，首次保存走 save-as。

## 7. 模块地图（文件即契约；并行开发以本节签名为准）

| 文件 | 责任 | 冻结的公开签名 |
|---|---|---|
| `core/ir.ts` | Block/Op 类型；md/JSONL → Block[]；Block[] → 全文文本；行号重算 | `parseDoc(text, kind): Block[]` `serializeBlocks(blocks): string` `blockLineMap(blocks): void`（原地写 lineStart/End） |
| `core/changes.ts` | diff/撤回回滚/逆序恢复/重绑定 | `diffBlocks(base, cur): Op[]` `applyOps(base, ops, dir: 1\|-1): Block[]` `rejectOp(base, cur, op): Block[]` `rebindOps(blocks, ops): Op[]` `withTombstones(base, cur, ops): Block[]` |
| `core/promptmd.ts` | 协议 render/parse（1.1.0+1.2.0 增量） | `renderPrompt(state, hashes, opts?): string` `parsePrompt(text): { meta, ops }` `planPatch(op): hunks\|null` `applyPatch(text, hunks): string` |
| `core/hash.ts` | BLAKE3/SHA-3 分块异步 + 同步短哈希 | `hashText(text, algo?): Promise<string>`（返回 `blake3:…` 带前缀） `hashShort(text): string`（patch 校验，16 hex 截断） |
| `core/diffview.ts` | 句级行内 diff（显示用，v1.2） | `sentDiff(before, after): { type: 'same'\|'del'\|'ins'; text: string }[]` |
| `core/indent.ts` | 首行缩进写入/载入剥离变换（v1.2） | `indentWrite(text): string`（导出侧，仅 md） `indentStrip(text): string`（载入侧逆变换，写入档开启时） |
| `core/fsio.ts` | 双后端、句柄库、跨通道串行防抖自动存 | `openDoc(): Promise<DocFile\|null>` `restoreDoc(): Promise<DocFile\|null>` `resetDoc(name?)` `saveDoc(t)` `saveDocAs(t)` `capturePromptTarget(): PromptTarget\|null` `writePrompt(t, target?)` `cancelPrompt(target)` `findSiblingPrompt(name)` `onSaveState(cb)` |
| `core/state.ts` | DocState + 生命周期（flags/墓碑）+ 恢复编排 + 缩进开关 | `store = { state, dispatch(action), subscribe(fn) }` `restoreFromPrompt(file, cur, promptText)` `buildPrompt(state, copy?)` `exportText(blocks, kind)` `setIndentWrite(b)` |
| `editor/editor.ts` | Milkdown 工厂、切节、命令、修订 decoration、光标上报 | `mountEditor(el, sectionSource, hooks)` `destroyEditor(): string \| undefined`（返回最终文本） `peekText(): string \| undefined`（非破坏性取值） `moveBlock(dir)` `scrollEditorBlock(ordinal, blockId?)` `setRevisions(ops, blocks)` |
| `editor/sourcemode.ts` | 源码模式（CodeMirror 6，批次 3） | `mountSource(el, text, hooks)` `peekSource(): string \| undefined`（非破坏性取值并清尾回调） `destroySource(): string \| undefined` `scrollSourceTo(line)`（v1.5.1） |
| `editor/floater.ts` | 通用块浮层 | `openFloater({ title, source, lang, renderPreview(el, src), onSave })` |
| `editor/views.ts` | node view：mermaid/math/xmlcard/footnote/image | 供 editor.ts 注册的 `nodeViews` 表 |
| `editor/static.ts` | 静态节渲染 + 后处理（卡片/图/公式/脚注） | `renderStatic(blocks, el, resolveImage?): void` |
| `editor/htmlguard.ts` | XML/危险 html/孤立 img 的会话标记围栏（flush 忠实） | `protectHtmlBlocks(src, tok)` `restoreHtmlBlocks(md, tok)` `MD2P_LANG` |
| `editor/linkref.ts` | 引用式链接保真（definition→linkDef、行内引用→html 原子） | `linkrefToHtml()` `LINK_DEF` |
| `editor/mddom.ts` | 唯一 md→DOM 渲染器 + URL 白名单 + 卡片骨架 | `renderMd/renderBlock/scanDefs/cardShell/newCtx/safeUrl` `ResolveImage` |
| `editor/richmedia.ts` | mermaid/katex 唯一加载点（惰性初始化） | `katexInto(el, tex, display)` `mermaidInto(el, src)` |
| `editor/records.ts` | JSONL 记录卡片 + 虚拟列表 + 记录浮层 | `mountVirtualList(el, blocks, onOpenRecord): () => void` |
| `ui/panels.ts` | 大纲/修订面板（页签：修订/批注/墓碑 + 路径行，v1.5） | `mountPanels(store)` `copyText(t)` |
| `ui/settings.ts` | 排版/主题设置 UI + 持久化（含目录前缀，v1.5） | `mountSettings()` `applyPrefs()` `onPrefsChange(cb)` `currentPrefs()` |
| `ui/progress.ts` | 进度单件化（细条/minimap/关）+ 跳转居中（v1.5） | `mountProgress()` `setProgressMode(m)` `refreshProgress(st)` `centerOn(el)` `flashEl(el)` |
| `ui/toolbar.ts` | 竖直工具轨 + 选区浮卡（v1.4） | `mountToolbar(hooks)` `showSelection(at\|null)` |
| `ui/shortcuts.ts` | 快捷键表与捕获录入（v1.4） | `SC_DEFAULT` `SC_LABEL` `comboOf(ev)` `captureCombo(input, ev)` |
| `ui/strings.ts` | 全部中文文案常量 | `export const S = { … }` |
| `styles.css` | 布局 + 3 主题 × 2 风格（CSS 变量） | — |
| `main.ts` | 装配：布局骨架、打开/新建、store 接线、模式分发 | — |

当前测试（`bun test`）：11 个文件、154 例。`test/ir.test.ts` `test/changes.test.ts` `test/diffview.test.ts`（句级 diff）`test/promptmd.test.ts`（§3 往返 + 生命周期/C 类 + semver 兼容）`test/state.test.ts`（隐藏/撤回两阶段/复活/清空 + 延迟 Prompt 持久化全链路）`test/hash.test.ts` `test/roundtrip.test.ts`（diff→render→parse→rebind→applyOps 全链路，含墓碑直通）`test/fsio.test.ts`（路径 helper + 跨目标/跨通道串行化、save-as 顺序/失败、目标代次/取消、同名 Prompt 错误分流）`test/htmlguard.test.ts` `test/indent.test.ts` `test/linkref.test.ts`。

## 8. 已知边界（v2 候选，现在不写）

卡片内富文本就地编辑；拖拽移动；超大 md 的编辑器内虚拟滚动；AI 回改反向 diff；多文档标签页；恢复路径的 gap 保真（恢复只承诺文本相等，非标准空行/行尾以当前文档风格归一）；move 类导入墓碑的复活（blockId 缺失，按首行文本重绑，重复首行歧义时不保证原位）。

## 9. 已知限制（终验确认，接受并备案）

1. **跨节引用**：定义在末节、引用在前节的大文档，编辑前节时引用行可能被序列化转义（`[a][x]`→`\[a]\[x]`），幻影 replace 可在面板隐藏/撤回；同节引用逐字保真（终验 15/15）。
2. **表格归一化**：Milkdown 序列化器会归一表格分隔行与补空格，首笔编辑时整表记一条 replace（库行为，可隐藏）。
3. **每节首次 flush 末块吸收一个尾换行**（内容等价、字节 +1/节）；diff 的 trimEnd 抑制保证不产生噪音 op（终验 39/39）。
4. **hideAll 在防抖窗内**点击时，尾部输入以一条新 pending op 入账（再点一次即清，不丢字）。
5. **编辑器载入后极快速点按 Enter** 有选区竞态（PM 挂载时序），自动化连发可复现，日常输入未触发。
6. **路径显示只有文件名**（浏览器安全模型不给绝对路径）；打印页眉的「源文件完成时间」来自 `File.lastModified`，新建文档未保存前回退为当前时间。
