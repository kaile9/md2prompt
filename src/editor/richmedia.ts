// editor/richmedia.ts — mermaid 与 katex 的唯一加载点（SPEC §1：惰性初始化，首用才 import）。
import 'katex/dist/katex.min.css';

type Katex = { renderToString(tex: string, opts?: { displayMode?: boolean; throwOnError?: boolean }): string };
type Mermaid = {
  render(id: string, src: string): Promise<{ svg: string }>;
  initialize(cfg: Record<string, unknown>): void;
};

const unwrap = <T>(m: unknown): T => ((m as { default?: unknown }).default ?? m) as T;

let katexP: Promise<Katex> | null = null;
const loadKatex = (): Promise<Katex> => (katexP ??= import('katex').then((m) => unwrap<Katex>(m)));

let mermaidP: Promise<Mermaid> | null = null;
const loadMermaid = (): Promise<Mermaid> =>
  (mermaidP ??= import('mermaid').then((m) => {
    const api = unwrap<Mermaid>(m);
    // suppressErrorRendering：失败不在 body 残留临时节点，由调用方兜底显示源码
    api.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'neutral' });
    return api;
  }));

/** KaTeX 渲染进 el（加载期以源码占位防空洞）；错误公式由 KaTeX 自身转义显示。 */
export function katexInto(el: HTMLElement, tex: string, displayMode: boolean): void {
  el.textContent = tex;
  void loadKatex().then((k) => {
    el.innerHTML = k.renderToString(tex, { displayMode, throwOnError: false });
  });
}

let seq = 0;
/** mermaid 渲染进 el；迟到渲染经代际守卫丢弃（el 可能已被更新源码重渲）；失败显示源码 + .mermaid-error。 */
export function mermaidInto(el: HTMLElement, src: string): void {
  const my = `md2p-mm-${++seq}`;
  el.dataset.mmSeq = my;
  void loadMermaid()
    .then((m) => m.render(my, src))
    .then(({ svg }) => {
      if (el.dataset.mmSeq === my) el.innerHTML = svg;
    })
    .catch(() => {
      if (el.dataset.mmSeq === my) {
        el.classList.add('mermaid-error');
        el.textContent = src;
      }
    });
}

/** mermaid 视口懒渲染（批次 3 性能）：占位先绘，接近视口才真渲染（静态节大图不再阻塞首屏）。 */
export function mermaidLazy(el: HTMLElement, src: string): void {
  const io = new IntersectionObserver(
    (ents) => {
      if (!ents.some((e) => e.isIntersecting)) return;
      io.disconnect();
      mermaidInto(el, src);
    },
    { rootMargin: '600px 0px' },
  );
  io.observe(el);
}
