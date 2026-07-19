/** editor/sourcemode.ts — 源码模式（批次 3）：CodeMirror 6 承载节源文。
 *  与渲染模式同一条 flush 管线（onChange 200ms 防抖 → applySectionText）；
 *  XML/图表在此永远以原文可见可改（转义灾难的最终保险）。修订痕迹属渲染模式，此处不画。 */
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';

export interface SourceHooks {
  onChange(text: string): void;
  /** 光标行列（相对节内文本 1-based；状态栏复用渲染模式同一槽位）。 */
  onCursor?(line: number, col: number): void;
}

/** Markdown 语法高亮（VS Code 式 token 着色，颜色走主题 CSS 变量，三主题自适应）。 */
const mdStyle = HighlightStyle.define([
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4], fontWeight: '700', color: 'var(--ink)' },
  { tag: t.heading1, fontSize: '1.45em' },
  { tag: t.heading2, fontSize: '1.25em' },
  { tag: t.heading3, fontSize: '1.1em' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent, #3b6ea5)' },
  { tag: t.url, color: 'var(--muted, #707b89)' },
  { tag: t.quote, color: 'var(--muted, #707b89)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', color: 'var(--c-note, #96690f)' },
  { tag: [t.meta, t.processingInstruction, t.comment], color: 'var(--muted, #707b89)' }, // 标记符号/围栏淡化
]);

const cmTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--ink, #2b3440)', fontSize: 'var(--font-size)' },
  '.cm-content': {
    fontFamily: 'var(--font-mono)',
    caretColor: 'var(--accent, #3b6ea5)',
    lineHeight: 'var(--line-height)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink, #2b3440)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent, #3b6ea5) 7%, transparent)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--muted, #707b89)',
    border: 'none',
    fontFamily: 'var(--font-mono)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink, #2b3440)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent, #3b6ea5) 18%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--paper, #f7f9fb)', color: 'var(--ink, #2b3440)', borderColor: 'var(--line, #d5dce4)' },
  '.cm-textfield': {
    backgroundColor: 'var(--bg, #eef1f4)',
    color: 'var(--ink, #2b3440)',
    border: '1px solid var(--line, #d5dce4)',
  },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--paper, #f7f9fb)', color: 'var(--ink, #2b3440)', border: '1px solid var(--line, #d5dce4)' },
});

let view: EditorView | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function mountSource(el: HTMLElement, text: string, hooks: SourceHooks): void {
  destroySource();
  view = new EditorView({
    parent: el,
    state: EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        markdown(), // codeLanguages 缺省为空：不装 language-data（体积红线）
        syntaxHighlighting(mdStyle),
        cmTheme,
        EditorView.lineWrapping,
        search({ top: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            clearTimeout(timer);
            timer = setTimeout(() => {
              const v = view;
              if (v) hooks.onChange(v.state.doc.toString());
            }, 200);
          }
          if (u.selectionSet || u.docChanged) {
            const pos = u.state.selection.main.head;
            const line = u.state.doc.lineAt(pos);
            hooks.onCursor?.(line.number, pos - line.from + 1);
          }
        }),
      ],
    }),
  });
}

/** 非破坏性读取当前源码文本并清除已被该快照覆盖的尾回调；取消选择时保留撤销历史。 */
export function peekSource(): string | undefined {
  clearTimeout(timer);
  timer = undefined;
  return view?.state.doc.toString();
}

/** 销毁并返回最终文本（防抖尾巴不丢字，语义同 destroyEditor）；未挂载时 undefined。 */
export function destroySource(): string | undefined {
  clearTimeout(timer);
  const v = view;
  view = null;
  if (!v) return undefined;
  const t = v.state.doc.toString();
  v.destroy();
  return t;
}

/** 顶部可见行（节相对 1-based）与行内偏移比（分屏块锚滚动同步用，v1.6）。 */
export function sourceTopLine(): { line: number; frac: number } | null {
  const v = view;
  if (!v) return null;
  const st = v.scrollDOM.scrollTop;
  const block = v.lineBlockAtHeight(st);
  const line = v.state.doc.lineAt(block.from).number;
  const frac = block.height > 0 ? Math.min(1, Math.max(0, (st - block.top) / block.height)) : 0;
  return { line, frac };
}

/** 滚动到节内第 line 行并附加行内偏移比（分屏块锚滚动同步用，v1.6）。 */
export function scrollSourceToFrac(line: number, frac: number): void {
  const v = view;
  if (!v) return;
  const l = v.state.doc.line(Math.min(v.state.doc.lines, Math.max(1, line)));
  const block = v.lineBlockAt(l.from);
  v.scrollDOM.scrollTop = block.top + frac * block.height;
}

/** 滚动到节内第 line 行（1-based，节相对）并居中（源码/分屏跳转落点，v1.5.1）。 */
export function scrollSourceTo(line: number): void {
  const v = view;
  if (!v) return;
  const l = v.state.doc.line(Math.min(v.state.doc.lines, Math.max(1, line)));
  v.dispatch({ effects: EditorView.scrollIntoView(l.from, { y: 'center' }) });
}
