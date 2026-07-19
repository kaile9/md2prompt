// SPDX-License-Identifier: MPL-2.0
/** §4.1 活动节 Milkdown 装配；修订可视化全走 ProseMirror decoration，不污染文本。
 *  flush 忠实（§4.1）：过滤默认改写源文的 remarkInlineLink 插件；XML/危险 html/孤立 img 经
 *  会话标记围栏保护（只拆自己生成的）；destroyEditor 返回最终文本（防抖尾巴不丢字）。
 *  切节由调用方驱动：destroyEditor() → 新节 mountEditor()。 */
import {
  Editor,
  EditorStatus,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  nodeViewCtx,
  prosePluginsCtx,
  rootCtx,
  serializerCtx,
} from '@milkdown/core';
import * as presetCommonmark from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { history } from '@milkdown/plugin-history';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { $nodeSchema, $remark } from '@milkdown/utils';
import remarkMath from 'remark-math';
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, Selection, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { setBlockType, toggleMark, wrapIn } from 'prosemirror-commands';
import { wrapInList } from 'prosemirror-schema-list';
import type { Block, Op } from '../core/ir';
import { project, sentDiff } from '../core/diffview';
import { protectHtmlBlocks, restoreHtmlBlocks, MD2P_LANG } from './htmlguard';
import { linkrefToHtml } from './linkref';
import { nodeViews, setViewHooks } from './views';
import { centerOn, flashEl } from '../ui/progress';
import { S } from '../ui/strings';
import type { ResolveImage } from './mddom';

// remarkInlineLinkPlugin 是 $Plugin 包装，commonmark 数组装的是其 .plugin 成员（实测 indexOf 验证）：
// 必须按 .plugin 引用过滤——它把引用链接转 inline 并删定义块（§4.1 flush 忠实）
const { remarkInlineLinkPlugin } = presetCommonmark as unknown as { remarkInlineLinkPlugin: { plugin: unknown } };
const commonmarkFaithful = presetCommonmark.commonmark.filter((p) => p !== remarkInlineLinkPlugin.plugin);

export interface EditorHooks {
  /** flush 当前节文本 → cur（防抖 200ms 后回调；切节时以 destroyEditor 返回值兜底）。 */
  onChange(sectionSource: string): void;
  /** Alt+↑/↓ 显式调换已发生；first/firstOther = 被移动块与对调块的 PM 现场首行纯文本。 */
  onMoveBlock(dir: 1 | -1, blockIndex?: number, first?: string, otherFirst?: string): void;
  /** 批注入口（Alt+M 或点击批注钉）；blockIndex = 顶层块序号，quote = 行内选段原文（无选区则缺省）。 */
  onAnnotate?(blockIndex: number, quote?: string): void;
  /** 选区变化：有非空选区时给纯文本与锚点坐标（批注浮钮用）；收起时给 null。 */
  onSelectText?(text: string | null, at?: { left: number; top: number }): void;
  /** 光标/选区变化：blockIndex = 顶层块序号，lineOff = 块内行偏移，col = 行内字符列（0 起）。 */
  onCursor?(blockIndex: number, lineOff: number, col: number): void;
  /** 相对路径图片 → object URL；缺省按原 src 渲染。 */
  resolveImage?: ResolveImage;
}

/* ---------- math 节点（remark-math 管线，§4.2） ---------- */

const mathRemark = $remark('remarkMath', () => remarkMath);

// 行内引用链接 → html 原子（linkref.ts）；definition → linkDef 节点（下方 schema）
const linkrefRemark = $remark('linkrefToHtml', () => linkrefToHtml);

// linkDef 块节点：承载链接定义原文；序列化经 html 原子逐字回吐（§4.1 flush 忠实）
const linkDef = $nodeSchema('link_def', () => ({
  content: 'text*',
  group: 'block',
  marks: '',
  defining: true,
  toDOM: () => ['div', { class: 'link-def' }, 0],
  parseMarkdown: {
    match: ({ type }) => type === 'linkDef',
    runner: (state, node, type) => {
      state.openNode(type);
      if (node.value) state.addText(String(node.value));
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'link_def',
    runner: (state, node) => state.addNode('html', undefined, node.textContent),
  },
}));

const mathBlock = $nodeSchema('math_block', () => ({
  content: 'text*',
  group: 'block',
  marks: '',
  code: true,
  defining: true,
  toDOM: () => ['div', { class: 'math-block' }, 0],
  parseMarkdown: {
    match: ({ type }) => type === 'math',
    runner: (state, node, type) => {
      state.openNode(type);
      if (node.value) state.addText(String(node.value));
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_block',
    runner: (state, node) => state.addNode('math', undefined, node.textContent),
  },
}));

const mathInline = $nodeSchema('math_inline', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  attrs: { value: { default: '', validate: 'string' } },
  toDOM: (node) => ['span', { class: 'math-inline' }, String(node.attrs.value)],
  parseMarkdown: {
    match: ({ type }) => type === 'inlineMath',
    runner: (state, node, type) => state.addNode(type, { value: String(node.value ?? '') }),
  },
  toMarkdown: {
    match: (node) => node.type.name === 'math_inline',
    runner: (state, node) => state.addNode('inlineMath', undefined, String(node.attrs.value)),
  },
}));

/* ---------- html 预处理：editor/htmlguard.ts（纯函数，§4.1 flush 忠实） ---------- */

/* ---------- 修订 decoration ---------- */

interface RevState {
  ops: Op[];
  /** 当前节块序（文档序）：delete 幽灵块（墓碑）按位置插在 cur 块之间、按 blockId 对齐、不消耗顶层节点。 */
  blocks: Block[];
}

const revKey = new PluginKey<DecorationSet>('md2prompt-revisions');
let pendingRev: RevState | null = null,
  currentHooks: EditorHooks | null = null;

function posOfChild(doc: PMNode, idx: number): number {
  let pos = 0;
  for (let k = 0; k < idx; k++) pos += doc.child(k).nodeSize;
  return pos;
}

function widget(tagName: 'span' | 'div', className: string, text: string): () => HTMLElement {
  return () => {
    const el = document.createElement(tagName);
    el.className = className;
    el.textContent = text;
    return el;
  };
}

/** 节点纯文本 + 文本偏移 → doc pos 映射；atom 叶子占 1 个占位字符。 */
function nodeTextMap(node: PMNode, pos: number): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  node.descendants((child, off) => {
    if (child.isText) {
      for (let k = 0; k < (child.text ?? '').length; k++) map.push(pos + 1 + off + k);
      text += child.text ?? '';
    } else if (child.isLeaf) {
      map.push(pos + 1 + off);
      text += String.fromCharCode(0xfffc); // 占位，保持偏移与位置一一对应
    }
    return true;
  });
  map.push(pos + node.nodeSize - 1);
  return { text, map };
}

/** code_block/math_block 的源文侧投影：PM 节点纯文本是「去围栏原文」，project() 会误吞字面标记，改用恒等投影。
 *  XML 卡（md2prompt- 围栏）：before/after 即节点全文；真围栏/数学块：剥首末围栏行。 */
const identityProj = (s: string): { plain: string; map: number[] } => ({
  plain: s,
  map: Array.from({ length: s.length }, (_, k) => k),
});

const stripFence = (s: string): string => {
  const lines = s.split('\n');
  if (/^(`{3,}|~{3,})/.test(lines[0] ?? '')) lines.shift();
  if (/^\s*(`{3,}|~{3,})\s*$/.test(lines[lines.length - 1] ?? '')) lines.pop();
  return lines.join('\n');
};

function replaceDecos(node: PMNode, pos: number, op: Extract<Op, { type: 'replace' }>): Decoration[] {
  // 撤回预令：新文本整句删除线预览 + 原文以「将恢复」幽灵块预置
  if (op.state === 'withdrawing') {
    return [
      Decoration.node(pos, pos + node.nodeSize, { class: 'rev-will' }),
      Decoration.widget(pos, widget('div', 'rev-ghost rev-restore', op.before), { side: -1, key: `re-${op.id}` }),
    ];
  }
  const { text, map } = nodeTextMap(node, pos);
  let pb: { plain: string; map: number[] };
  let pa: { plain: string; map: number[] };
  if (node.type.name === 'code_block') {
    const isCard = MD2P_LANG.test(String(node.attrs.language ?? ''));
    pb = identityProj(isCard ? op.before : stripFence(op.before));
    pa = identityProj(isCard ? op.after : stripFence(op.after));
  } else if (node.type.name === 'math_block') {
    pb = identityProj(stripFence(op.before));
    pa = identityProj(stripFence(op.after));
  } else {
    pb = project(op.before);
    pa = project(op.after);
  }
  const out: Decoration[] = [];
  let curA = 0; // pa.plain 游标（≈ PM 纯文本坐标）
  let curB = 0; // pb.plain 游标
  for (const seg of sentDiff(pb.plain, pa.plain)) {
    if (seg.type === 'del') {
      // 经 map 回切源文，旧句连行内标记一起展示
      const from = pb.map[curB] ?? 0;
      const to = (pb.map[curB + seg.text.length - 1] ?? from + seg.text.length - 1) + 1;
      const at = map[Math.min(curA, text.length)] ?? pos;
      out.push(
        Decoration.widget(at, widget('span', 'rev-del', op.before.slice(from, to)), {
          side: -1,
          key: `del-${op.id}-${curB}`,
        }),
      );
      curB += seg.text.length;
      continue;
    }
    const idx = text.indexOf(seg.text, curA);
    if (idx === -1) {
      // 投影退化（行内码/转义字面标记）：跳过该段高亮，游标按投影长度推进，绝不影响编辑
      curA += seg.text.length;
      curB += seg.type === 'same' ? seg.text.length : 0;
      continue;
    }
    if (seg.type === 'ins')
      out.push(Decoration.inline(map[idx] ?? pos, map[idx + seg.text.length] ?? pos + node.nodeSize - 1, { class: 'rev-ins' }));
    curA = idx + seg.text.length;
    if (seg.type === 'same') curB += seg.text.length;
  }
  return out;
}

function buildDecorations(doc: PMNode, rev: RevState): DecorationSet {
  try {
    const byId = new Map<string, Op[]>();
    // hidden 的 op 不产生任何标记（用户已确认收起）
    for (const op of rev.ops)
      if (op.state !== 'hidden') byId.set(op.blockId, [...(byId.get(op.blockId) ?? []), op]);
    const decos: Decoration[] = [];
    let nodeIdx = 0;
    for (const block of rev.blocks) {
      const ops = byId.get(block.id) ?? [];
      const del = ops.find((o): o is Extract<Op, { type: 'delete' }> => o.type === 'delete');
      if (del) {
        const at = nodeIdx < doc.childCount ? posOfChild(doc, nodeIdx) : doc.content.size;
        // 撤回预令的删除墓碑换「将恢复」样式；data-block-id 供跳转锚定。
        // key 带状态：同 key widget 被 PM 复用不换 DOM，预令换样式必须换 key（E2E 抓的 bug）
        const cls = del.state === 'withdrawing' ? 'rev-ghost rev-restore' : 'rev-ghost';
        decos.push(
          Decoration.widget(
            at,
            () => {
              const el = document.createElement('div');
              el.className = cls;
              el.textContent = del.before;
              el.dataset.blockId = del.blockId;
              return el;
            },
            { side: -1, key: `ghost-${del.id}-${del.state ?? 'p'}` },
          ),
        );
        continue; // 幽灵块不消耗顶层节点
      }
      if (nodeIdx >= doc.childCount) break;
      const node = doc.child(nodeIdx);
      const pos = posOfChild(doc, nodeIdx);
      const blockIndex = nodeIdx;
      for (const op of ops) {
        if (op.type === 'replace') decos.push(...replaceDecos(node, pos, op));
        else if (op.type === 'insert')
          decos.push(
            Decoration.node(pos, pos + node.nodeSize, { class: op.state === 'withdrawing' ? 'rev-will' : 'rev-ins' }),
          );
        else if (op.type === 'swap')
          decos.push(Decoration.widget(pos + 1, widget('span', 'rev-moved', S.opSwap), { side: -1, key: `sw-${op.id}` }));
        else if (op.type === 'note') {
          // 行内批注：选段加虚线下划线（quote 可能含行内标记，投影后定位）
          if (op.quote) {
            const { text, map } = nodeTextMap(node, pos);
            const q = project(op.quote).plain;
            const idx = q ? text.indexOf(q) : -1;
            if (idx >= 0)
              decos.push(
                Decoration.inline(map[idx] ?? pos, map[idx + q.length] ?? pos + node.nodeSize - 1, {
                  class: 'rev-note-span',
                }),
              );
          }
          decos.push(
            Decoration.widget(
              pos + node.nodeSize - 1,
              () => {
                const s = document.createElement('span');
                s.className = op.state === 'withdrawing' ? 'rev-pin rev-warn' : 'rev-pin';
                s.textContent = '✎';
                s.dataset.note = op.note;
                s.title = op.note;
                s.addEventListener('click', (e) => {
                  e.stopPropagation();
                  currentHooks?.onAnnotate?.(blockIndex);
                });
                return s;
              },
              { side: 1, key: `pin-${op.id}` },
            ),
          );
        }
      }
      nodeIdx++;
    }
    return DecorationSet.create(doc, decos);
  } catch {
    return DecorationSet.empty; // 装饰是显示层，任何异常都不允许波及编辑
  }
}

const revPlugin = new Plugin<DecorationSet>({
  key: revKey,
  state: {
    init: () => DecorationSet.empty,
    apply: (tr, old) => {
      const meta = tr.getMeta(revKey) as RevState | null | undefined;
      if (meta !== undefined) return meta ? buildDecorations(tr.doc, meta) : DecorationSet.empty;
      return tr.docChanged ? old.map(tr.mapping, tr.doc) : old;
    },
  },
  props: { decorations: (state) => revKey.getState(state) },
});

/** Ctrl+A 护栏（QA F1/F2）：光标在 code_block / math_block（A-2 同型漏洞）内时，
 *  全选只收拢到本块文本——默认的 selectAll 会选满全文，接着打字就把受保护块换成普通段落，
 *  序列化器再把 `<` 转义成 `\<`、整块炸碎成多段。收拢后重打 = 块内文本替换，围栏存活。 */
const codeSelectAllPlugin = new Plugin({
  key: new PluginKey('md2prompt-code-select-all'),
  props: {
    handleKeyDown(view, ev) {
      if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== 'a' || ev.shiftKey || ev.altKey) return false;
      const { $from } = view.state.selection;
      const tn = $from.parent.type.name;
      if (tn !== 'code_block' && tn !== 'math_block') return false;
      const start = $from.start();
      const end = start + $from.parent.content.size;
      if (end <= start) return false;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start, end)));
      return true;
    },
  },
});

/** 传入当前节的未决 ops 与块序，重建修订 decoration（ops 变化/切节后调用）。 */
export function setRevisions(ops: Op[], sectionBlocks: Block[]): void {
  const view = currentView();
  if (view) view.dispatch(view.state.tr.setMeta(revKey, { ops, blocks: sectionBlocks }));
  else pendingRev = { ops, blocks: sectionBlocks };
}

/* ---------- 节内跳转（按非幽灵序 → 顶层子节点；v1.2 跳转锚 = blockId 的落点） ---------- */

let pendingScroll: { ordinal: number; blockId?: string; tries: number } | null = null;

/** 编辑器暂不可取时的重试（创建竞态：10×300ms 窗口；E2E 抓到的一次性不闪根因）。 */
function retryScroll(): void {
  const p = pendingScroll;
  if (!p || p.tries >= 10) {
    pendingScroll = null;
    return;
  }
  p.tries++;
  setTimeout(() => {
    const q = pendingScroll;
    if (!q) return;
    if (currentView()) {
      pendingScroll = null;
      scrollEditorBlock(q.ordinal, q.blockId);
    } else retryScroll();
  }, 300);
}

/** 滚动到活动节第 ordinal 个顶层块并闪烁；编辑器未就绪时挂起+重试。
 *  v1.5：居中走 centerOn（自算 scrollTop）——旧实现先滚块、又对整节 scrollIntoView，
 *  大节被二次推中直接跳飞（用户报的「随机跳转」根因）。闪烁只挂外层 <section>（自有 DOM）：
 *  PM 的 domObserver 会把外部对托管 DOM 的 class 改写当入侵并重建节点。
 *  blockId 写到 section 的 data-block-id 上（跳转命中证据/测试锚）。 */
export function scrollEditorBlock(ordinal: number, blockId?: string): void {
  const view = currentView();
  if (!view) {
    pendingScroll = { ordinal, blockId, tries: 0 };
    retryScroll();
    return;
  }
  if (ordinal < 0 || ordinal >= view.state.doc.childCount) return;
  const pos = posOfChild(view.state.doc, ordinal);
  const { node } = view.domAtPos(pos + 1);
  const el = node instanceof HTMLElement ? node : node.parentElement;
  if (el) centerOn(el);
  const sec = view.dom.closest('section') as HTMLElement | null;
  if (sec) {
    if (blockId) sec.dataset.blockId = blockId;
    flashEl(sec);
  }
}

/** 光标位置 → 顶层块序号 + 块内行/列（状态栏「行 X · 列 Y」数据源）。
 *  leafText 给 ''：atom 叶子（行内公式/图片）不产生幻影行（只有真换行计数）。 */
function reportCursor(view: EditorView): void {
  if (!currentHooks?.onCursor) return;
  const sel = view.state.selection;
  const idx = sel.$from.index(0);
  if (idx >= view.state.doc.childCount) return;
  const before = view.state.doc.textBetween(posOfChild(view.state.doc, idx) + 1, sel.from, '\n', '');
  const rows = before.split('\n');
  currentHooks.onCursor(idx, rows.length - 1, rows[rows.length - 1].length);
}

/* ---------- 编辑器生命周期 ---------- */

let editor: Editor | null = null;
let currentTok = '';

function currentView(): EditorView | null {
  if (!editor || editor.status !== EditorStatus.Created) return null;
  try {
    return editor.ctx.get(editorViewCtx);
  } catch {
    return null;
  }
}

export function mountEditor(el: HTMLElement, sectionSource: string, hooks: EditorHooks): void {
  destroyEditor();
  currentHooks = hooks;
  setViewHooks(hooks);
  currentTok = Math.random().toString(36).slice(2, 8);
  const tok = currentTok;
  const ed = Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, el);
      ctx.set(defaultValueCtx, protectHtmlBlocks(sectionSource, tok));
      ctx.update(prosePluginsCtx, (ps) => [...ps, revPlugin, codeSelectAllPlugin]);
      ctx.update(nodeViewCtx, (vs) => [...vs, ...Object.entries(nodeViews)]);
      ctx.set(editorViewOptionsCtx, {
        // 快捷键统一走 main 的 document 捕获层（可自定义）；此处置空防幽灵双触发（评审 m3）
        handleKeyDown: () => false,
        // 选区/文档变化后上报光标（状态栏行列显示）与选区（批注浮钮）；默认行为先行，绝不吃事务
        dispatchTransaction(this: EditorView, tr) {
          this.updateState(this.state.apply(tr));
          if (tr.selectionSet || tr.docChanged) {
            reportCursor(this);
            const sel = this.state.selection;
            if (sel.empty || !currentHooks?.onSelectText) {
              currentHooks?.onSelectText?.(null);
            } else {
              const text = this.state.doc.textBetween(sel.from, sel.to, '\n', '').trim();
              const at = this.coordsAtPos(sel.to);
              currentHooks.onSelectText(text || null, { left: at.left, top: at.top });
            }
          }
        },
      });
      ctx.get(listenerCtx).markdownUpdated((_ctx, md) => hooks.onChange(restoreHtmlBlocks(md, tok)));
    })
    .use(commonmarkFaithful)
    .use(gfm)
    .use(history)
    .use(listener)
    .use(mathRemark)
    .use(linkrefRemark)
    .use(linkDef)
    .use(mathBlock)
    .use(mathInline);
  editor = ed;
  void ed
    .create()
    .then(() => {
      if (editor !== ed) return void ed.destroy(); // 创建期间已换节/销毁
      const rev = pendingRev;
      pendingRev = null;
      if (rev) setRevisions(rev.ops, rev.blocks);
      const sc = pendingScroll;
      pendingScroll = null;
      if (sc) scrollEditorBlock(sc.ordinal, sc.blockId);
    })
    .catch(() => {
      if (editor === ed) editor = null;
    });
}

/** 不销毁地取当前节文本（批注等高频路径的非破坏性 flush；编辑器未就绪时 undefined）。 */
export function peekText(): string | undefined {
  const ed = editor;
  if (!ed || ed.status !== EditorStatus.Created) return undefined;
  try {
    return restoreHtmlBlocks(ed.ctx.get(serializerCtx)(ed.ctx.get(editorViewCtx).state.doc), currentTok);
  } catch {
    return undefined;
  }
}

/** 销毁并返回最终文本（防抖尾巴不丢字，§4.1 切节语义）；编辑器未就绪时 undefined。 */
export function destroyEditor(): string | undefined {
  pendingRev = null;
  pendingScroll = null;
  currentHooks = null;
  const ed = editor;
  editor = null;
  let out: string | undefined;
  if (ed && ed.status === EditorStatus.Created) {
    try {
      const view = ed.ctx.get(editorViewCtx);
      out = restoreHtmlBlocks(ed.ctx.get(serializerCtx)(view.state.doc), currentTok);
    } catch {
      out = undefined;
    }
  }
  if (ed) void ed.destroy().catch(() => undefined);
  return out;
}

/** 光标所在顶层块序号（Alt+M 批注等）。 */
export function currentBlockIndex(): number {
  const view = currentView();
  return view ? view.state.selection.$from.index(0) : 0;
}

/* ---------- 格式命令（批次 4 工具轨/选区浮卡；全部经 PM 命令，flush 管线不变） ---------- */

export type BlockAction = 'h1' | 'h2' | 'h3' | 'quote' | 'bullet' | 'ordered' | 'codeblock' | 'hr';
export type InlineAction = 'bold' | 'italic' | 'strike' | 'code';

export function runBlock(a: BlockAction): void {
  const view = currentView();
  if (!view) return;
  const { state } = view;
  const n = state.schema.nodes;
  if (a === 'hr') {
    view.dispatch(state.tr.replaceSelectionWith(n.hr.create()).scrollIntoView());
    view.focus();
    return;
  }
  const cmd =
    a === 'quote'
      ? wrapIn(n.blockquote)
      : a === 'bullet'
        ? wrapInList(n.bullet_list)
        : a === 'ordered'
          ? wrapInList(n.ordered_list)
          : a === 'codeblock'
            ? setBlockType(n.code_block)
            : setBlockType(n.heading, { level: Number(a[1]) });
  cmd(state, view.dispatch);
  view.focus();
}

export function runInline(a: InlineAction): void {
  const view = currentView();
  if (!view) return;
  const m = view.state.schema.marks;
  const type = a === 'bold' ? m.strong : a === 'italic' ? m.emphasis : a === 'strike' ? m.strike_through : m.code_inline;
  toggleMark(type)(view.state, view.dispatch);
  view.focus();
}

/** 选区加链接（href 为空则整链移除）。 */
export function runLink(href: string): void {
  const view = currentView();
  if (!view) return;
  toggleMark(view.state.schema.marks.link, href ? { href } : {})(view.state, view.dispatch);
  view.focus();
}

/** 光标处插入 md 片段（图片/链接等，走 flush 入账）。 */
export function runInsert(md: string): void {
  const view = currentView();
  if (!view) return;
  view.dispatch(view.state.tr.insertText(md).scrollIntoView());
  view.focus();
}

/** 显式移动当前块（Alt+↑/↓），交换顶层块并回调 onMoveBlock；dir: -1 上 / 1 下。 */
export function moveBlock(dir: 1 | -1): void {
  const view = currentView();
  if (!view) return;
  const { state } = view;
  const idx = state.selection.$from.index(0);
  const target = idx + dir;
  if (idx >= state.doc.childCount || target < 0 || target >= state.doc.childCount) return;
  const cur = state.doc.child(idx);
  const other = state.doc.child(target);
  const pos = posOfChild(state.doc, idx);
  const tr = state.tr;
  if (dir === 1) tr.replaceWith(pos, pos + cur.nodeSize + other.nodeSize, [other, cur]);
  else tr.replaceWith(pos - other.nodeSize, pos + cur.nodeSize, [cur, other]);
  const newPos = dir === 1 ? pos + other.nodeSize : pos - other.nodeSize;
  tr.setSelection(Selection.near(tr.doc.resolve(newPos + 1)));
  view.dispatch(tr.scrollIntoView());
  currentHooks?.onMoveBlock(dir, target, cur.textContent.split('\n', 1)[0] ?? '', other.textContent.split('\n', 1)[0] ?? '');
}
