// SPDX-License-Identifier: MPL-2.0
// editor/mddom.ts — 唯一 markdown→DOM 渲染器（SPEC §4.1 静态渲染路线，v1.1 批准偏离 rehype）。
// 不变量：源文只经 textContent 进 DOM；innerHTML 仅用于 katex/mermaid 的输出（richmedia）。
// 消费方：static.ts（非活动节）、views.ts（XML 卡片/浮层预览）。
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Block } from '../core/ir';
import { S } from '../ui/strings';
import { katexInto, mermaidInto, mermaidLazy } from './richmedia';
import { openPopover } from './floater';

/** 图片解析契约（§4.1）：调用方负责缓存与异步回填，当场或稍后设置 img.src。 */
export type ResolveImage = (src: string, img: HTMLImageElement) => void;

// gfm/math 节点不在 mdast 官方联合类型里，用扁平结构承接 parser 输出
interface N {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  title?: string | null;
  lang?: string | null;
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  checked?: boolean | null;
  identifier?: string;
  align?: (string | null)[];
  children?: N[];
}

/** 渲染上下文：defs/fns 跨块共享（§4.1 脚注/引用链接）；fnp 为锚 id 前缀（每次渲染会话唯一）。 */
export interface MdCtx {
  defs: Map<string, N>;
  fns: Map<string, N>;
  fnp: string;
  resolveImage?: ResolveImage;
}

let ctxSeq = 0;
export const newCtx = (resolveImage?: ResolveImage): MdCtx => ({
  defs: new Map(),
  fns: new Map(),
  fnp: `s${++ctxSeq}-`,
  resolveImage,
});

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/** URL 白名单（§4.1）：http(s)/mailto/相对路径/blob；img 额外放行 data:image/。
 *  probe 按 WHATWG 规则先删 ASCII 空白/控制符再判 scheme，防 java\tscript: 绕过。 */
export const safeUrl = (u: string, img = false): string | null => {
  const s = u.trim();
  const probe = s.replace(/[\x00-\x20]/g, '');
  if (/^(https?:|mailto:|blob:)/i.test(probe)) return s;
  if (img && /^data:image\//i.test(probe)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(probe) || probe.startsWith('//')) return null;
  return s || null;
};

const BAD_TAG = /<\s*\/?\s*(script|style|iframe|object|embed)(?=[\s>/])/i;
// 属性容忍引号包裹的 >（如 title="x>y"）
const ATTRS = /(?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*/;
const XML_ONE = new RegExp(`^\\s*<([a-z][a-z0-9-]{1,24})${ATTRS.source}\\s*(?:\\/>|>([\\s\\S]*)<\\/\\1>)\\s*$`);

const codeSpan = (v: string, cls?: string): HTMLElement => {
  const c = document.createElement('code');
  c.textContent = v;
  if (cls) c.className = cls;
  return c;
};

/** XML 卡片骨架（views.ts 共用，两处卡片同构）：点头折叠。 */
export function cardShell(tag: string): { dom: HTMLElement; head: HTMLElement; body: HTMLElement } {
  const dom = document.createElement('div');
  dom.className = 'xml-card';
  const head = document.createElement('div');
  head.className = 'xml-card-head';
  const badge = document.createElement('span');
  badge.className = 'xml-badge';
  badge.textContent = tag ? `<${tag}>` : 'xml';
  const body = document.createElement('div');
  body.className = 'xml-card-body';
  head.appendChild(badge);
  dom.append(head, body);
  head.addEventListener('mousedown', (e) => e.preventDefault()); // 不把 PM 光标引进隐藏 contentDOM（v1.5.1）
  head.addEventListener('click', (e) => {
    e.stopPropagation();
    body.hidden = !body.hidden;
    dom.classList.toggle('xml-card-folded', body.hidden);
  });
  return { dom, head, body };
}

// 段落子树按上下文混排：paragraph → 行内，其余 → 块级（列表项/脚注/弹窗共用）
const mixed = (c: N, el: HTMLElement, ctx: MdCtx): void => {
  if (c.type === 'paragraph') renderInline(c.children ?? [], el, ctx);
  else renderBlocks([c], el, ctx);
};

// ---- 行内节点 ----
const refDef = (n: N, ctx: MdCtx): N | undefined =>
  n.type.endsWith('Reference') ? ctx.defs.get(n.identifier ?? '') : undefined;

function renderInline(nodes: N[], el: HTMLElement, ctx: MdCtx): void {
  for (const n of nodes) switch (n.type) {
    case 'text':
      el.append(n.value ?? '');
      break;
    case 'emphasis':
    case 'strong':
    case 'delete':
      el.appendChild(inlineWrap(n.type === 'emphasis' ? 'em' : n.type === 'strong' ? 'strong' : 'del', n, ctx));
      break;
    case 'inlineCode':
      el.appendChild(codeSpan(n.value ?? ''));
      break;
    case 'html':
      el.appendChild(codeSpan(n.value ?? '', 'html-chip')); // 行内未知标签：等宽 chip 原样可见（§4.2）
      break;
    case 'inlineMath':
      el.appendChild(mathEl(n, false));
      break;
    case 'break':
      el.appendChild(document.createElement('br'));
      break;
    case 'link':
    case 'linkReference':
      el.appendChild(linkEl(n, ctx));
      break;
    case 'image':
    case 'imageReference':
      el.appendChild(imgEl(n, ctx));
      break;
    case 'footnoteReference':
      el.appendChild(fnRef(n, ctx));
      break;
    default:
      if (n.children) renderInline(n.children, el, ctx);
      else if (n.value != null) el.append(n.value);
  }
}

const inlineWrap = (tag: string, n: N, ctx: MdCtx): HTMLElement => {
  const w = document.createElement(tag);
  renderInline(n.children ?? [], w, ctx);
  return w;
};

function linkEl(n: N, ctx: MdCtx): HTMLElement {
  const def = refDef(n, ctx);
  const a = document.createElement('a');
  const url = safeUrl(n.url ?? def?.url ?? '');
  if (url) {
    a.href = url;
    if (/^https?:/i.test(url)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  }
  a.title = n.title ?? def?.title ?? '';
  renderInline(n.children ?? [], a, ctx);
  a.addEventListener('click', (e) => e.stopPropagation()); // 不触发切节
  return a;
}

function imgEl(n: N, ctx: MdCtx): HTMLElement {
  const def = refDef(n, ctx);
  const raw = safeUrl(n.url ?? def?.url ?? '', true);
  if (raw) {
    const img = document.createElement('img');
    img.alt = n.alt ?? '';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.classList.add('img-broken'), { once: true });
    if (ctx.resolveImage) ctx.resolveImage(raw, img);
    else img.src = raw;
    return img;
  }
  const ph = document.createElement('span'); // 未授权/不安全 src → 占位
  ph.className = 'img-ph';
  ph.textContent = n.alt ? `${S.image}：${n.alt}` : S.image;
  return ph;
}

function fnRef(n: N, ctx: MdCtx): HTMLElement {
  const id = n.identifier ?? '';
  const sup = document.createElement('sup');
  sup.className = 'footnote-ref';
  sup.textContent = `[${id}]`;
  if (!ctx.fns.has(id)) return sup;
  sup.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(sup, (body) => {
      for (const c of ctx.fns.get(id)?.children ?? []) mixed(c, body, ctx);
      const jump = document.createElement('a');
      jump.href = '#';
      jump.textContent = S.jump;
      jump.addEventListener('click', (ev) => {
        ev.preventDefault();
        document.getElementById(`fn-${ctx.fnp}${id}`)?.scrollIntoView({ block: 'center' });
      });
      body.appendChild(jump);
    });
  });
  return sup;
}

// ---- 块级节点 ----
function renderBlocks(nodes: N[], el: HTMLElement, ctx: MdCtx): void {
  for (const n of nodes) switch (n.type) {
    case 'heading': {
      const h = document.createElement(`h${Math.min(6, Math.max(1, n.depth ?? 1))}`);
      renderInline(n.children ?? [], h, ctx);
      el.appendChild(h);
      break;
    }
    case 'paragraph':
      el.appendChild(inlineWrap('p', n, ctx));
      break;
    case 'blockquote': {
      const q = document.createElement('blockquote');
      renderBlocks(n.children ?? [], q, ctx);
      el.appendChild(q);
      break;
    }
    case 'list':
      el.appendChild(listEl(n, ctx));
      break;
    case 'code':
      el.appendChild((n.lang ?? '').toLowerCase() === 'mermaid' ? mermaidEl(n) : preCode(n));
      break;
    case 'math':
      el.appendChild(mathEl(n, true));
      break;
    case 'thematicBreak':
      el.appendChild(document.createElement('hr'));
      break;
    case 'table':
      el.appendChild(tableEl(n, ctx));
      break;
    case 'html':
      el.appendChild(htmlEl(n.value ?? '', ctx));
      break;
    default:
      if (n.value != null) el.appendChild(preCode(n));
      else renderBlocks(n.children ?? [], el, ctx);
  }
}

function listEl(n: N, ctx: MdCtx): HTMLElement {
  const l = document.createElement(n.ordered ? 'ol' : 'ul');
  if (n.ordered && n.start != null && n.start !== 1) l.setAttribute('start', String(n.start));
  for (const it of n.children ?? []) {
    const li = document.createElement('li');
    if (it.checked != null) {
      const cb = li.appendChild(document.createElement('input'));
      cb.type = 'checkbox';
      cb.disabled = true;
      cb.checked = it.checked;
      li.append(' ');
    }
    for (const c of it.children ?? []) mixed(c, li, ctx);
    l.appendChild(li);
  }
  return l;
}

function tableEl(n: N, ctx: MdCtx): HTMLElement {
  const table = document.createElement('table');
  const cell = (c: N, tag: 'th' | 'td', j: number): HTMLElement => {
    const td = document.createElement(tag);
    const a = n.align?.[j];
    if (a === 'left' || a === 'center' || a === 'right') td.style.textAlign = a;
    renderInline(c.children ?? [], td, ctx);
    return td;
  };
  const fill = (r: N | undefined, tag: 'th' | 'td', sec: HTMLTableSectionElement): void => {
    const tr = sec.insertRow();
    (r?.children ?? []).forEach((c, j) => tr.appendChild(cell(c, tag, j)));
  };
  const [head, ...rows] = n.children ?? [];
  fill(head, 'th', table.createTHead());
  const tb = table.createTBody();
  for (const r of rows) fill(r, 'td', tb);
  return table;
}

function mathEl(n: N, display: boolean): HTMLElement {
  const d = document.createElement(display ? 'div' : 'span');
  d.className = display ? 'math-block' : 'math-inline';
  katexInto(d, n.value ?? '', display);
  return d;
}

function preCode(n: N): HTMLElement {
  const c = codeSpan(n.value ?? '');
  if (n.lang) c.className = `language-${n.lang}`;
  const pre = document.createElement('pre');
  pre.appendChild(c);
  return pre;
}

function mermaidEl(n: N): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'mermaid-block';
  const box = document.createElement('div');
  box.className = 'mermaid-svg';
  dom.appendChild(box);
  mermaidLazy(box, n.value ?? ''); // 视口懒渲染（批次 3 性能）
  return dom;
}

function htmlEl(raw: string, ctx: MdCtx): HTMLElement {
  if (!BAD_TAG.test(raw)) {
    const m = XML_ONE.exec(raw);
    if (m) {
      const { dom, body } = cardShell(m[1]);
      renderMd((m[2] ?? '').trim(), body, newCtx(ctx.resolveImage)); // 卡片自含，独立定义作用域
      return dom;
    }
    // 提示词式标签整行（开/闭/自闭合，含属性）：chip 卡片原样显示标签（v1.3 三档契约）
    const t = raw.trim();
    if (/^<\/??[a-z][a-z0-9-]{1,24}(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?\/?>$/.test(t)) {
      const { dom, head } = cardShell('');
      const badge = head.querySelector('.xml-badge');
      if (badge) badge.textContent = t;
      return dom;
    }
  }
  const pre = document.createElement('pre'); // 危险/未知 html：转义代码块，永不执行
  pre.textContent = raw;
  return pre;
}

/** md 源 → DOM。definition/footnoteDefinition 提升进共享 ctx；本块脚注定义就地渲染（可跳转锚）。 */
export function renderMd(src: string, el: HTMLElement, ctx: MdCtx): void {
  const root = parser.parse(src) as unknown as N;
  const kids: N[] = [];
  const localFns: [string, N][] = [];
  for (const n of root.children ?? []) {
    if (n.type === 'definition' && n.identifier) ctx.defs.set(n.identifier, n);
    else if (n.type === 'footnoteDefinition' && n.identifier) {
      ctx.fns.set(n.identifier, n);
      localFns.push([n.identifier, n]);
    } else kids.push(n);
  }
  renderBlocks(kids, el, ctx);
  if (localFns.length) {
    const ol = document.createElement('ol');
    ol.className = 'footnote-defs';
    for (const [id, def] of localFns) {
      const li = Object.assign(ol.appendChild(document.createElement('li')), { id: `fn-${ctx.fnp}${id}` });
      for (const c of def.children ?? []) mixed(c, li, ctx);
    }
    el.appendChild(ol);
  }
}

/** 预扫描各块的链接/脚注定义进共享查找表（跨块引用，§4.1）。code/record 块跳过，防误中围栏文本。 */
export function scanDefs(blocks: Block[], ctx: MdCtx): void {
  for (const b of blocks) {
    if (b.kind === 'code' || b.kind === 'record') continue;
    if (!/^\s{0,3}\[[^\]]+\]:/m.test(b.text)) continue; // 定义行特征，省一次全量 parse
    for (const n of (parser.parse(b.text) as unknown as N).children ?? []) {
      if (n.type === 'definition' && n.identifier) ctx.defs.set(n.identifier, n);
      else if (n.type === 'footnoteDefinition' && n.identifier) ctx.fns.set(n.identifier, n);
    }
  }
}

/** 单块 → 根 div（带 data-line/data-block-id，§5 行号徽标与跳转锚）。 */
export function renderBlock(b: Block, ctx: MdCtx): HTMLElement {
  const root = document.createElement('div');
  root.className = `blk blk-${b.kind}`;
  root.dataset.line = String(b.lineStart);
  root.dataset.blockId = b.id;
  if (b.kind === 'code' && b.meta?.lang === 'xml') {
    const pre = document.createElement('pre'); // .xml 文件整体：转义代码块，不当 md 重解析（§2）
    pre.textContent = b.text;
    root.appendChild(pre);
    return root;
  }
  renderMd(b.text, root, ctx);
  return root;
}
