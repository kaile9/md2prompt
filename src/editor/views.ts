/** §7 node view 注册表：mermaid / math / xmlcard / html-img / footnote / image，供 editor.ts 注册。
 *  渲染一律走 mddom/richmedia 统一管线（SPEC §4.2）；文案集中 ui/strings。 */
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView, NodeViewConstructor } from 'prosemirror-view';
import { S } from '../ui/strings';
import { cardShell, type ResolveImage } from './mddom';
import { MD2P_LANG } from './htmlguard';
import { katexInto, mermaidInto } from './richmedia';
import { openFloater, openPopover } from './floater';

export interface ViewHooks {
  /** 相对路径 → object URL（§4.1 目录句柄解析，可异步回填）。 */
  resolveImage?: ResolveImage;
}

let hooks: ViewHooks = {};

/** editor.ts 在 mountEditor 时注入。 */
export function setViewHooks(h: ViewHooks): void {
  hooks = h;
}

/* ---------- 工具 ---------- */

/** 替换 textblock（code_block / math_block）全部文本。 */
function replaceBlockText(view: EditorView, pos: number, node: PMNode, next: string): void {
  const tr = view.state.tr;
  const from = pos + 1;
  const to = pos + node.nodeSize - 1;
  view.dispatch(next ? tr.insertText(next, from, to) : tr.delete(from, to));
}

const tagOf = (raw: string): string => /^<\/??([a-z][a-z0-9-]{1,24})/.exec(raw)?.[1] ?? '';

const imgAttr = (raw: string, name: string): string =>
  new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(raw)?.[1] ??
  new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(raw)?.[1] ??
  new RegExp(`${name}\\s*=\\s*([^\\s>]+)`).exec(raw)?.[1] ??
  '';

function selectToggle(dom: HTMLElement): Pick<NodeView, 'selectNode' | 'deselectNode'> {
  return {
    selectNode: () => dom.classList.add('ProseMirror-selectednode'),
    deselectNode: () => dom.classList.remove('ProseMirror-selectednode'),
  };
}

const resolveImg = (src: string, img: HTMLImageElement): void => {
  if (hooks.resolveImage) hooks.resolveImage(src, img);
  else img.src = src;
};

/* ---------- code_block：按 language 分派 ---------- */

const codeBlockView: NodeViewConstructor = (node, view, getPos) => {
  const lang = String(node.attrs.language ?? '');
  if (lang === 'mermaid') return mermaidView(node, view, getPos);
  const special = MD2P_LANG.exec(lang);
  if (special?.[1] === 'xml') return xmlCardView(node);
  if (special?.[1] === 'img') return htmlImgView(node, view, getPos);
  return plainCodeView(node); // 普通围栏 + -raw（危险 html）一律转义代码块
};

function plainCodeView(node: PMNode): NodeView {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  const lang = String(node.attrs.language ?? '');
  if (lang) pre.dataset.language = lang;
  pre.appendChild(code);
  return {
    dom: pre,
    contentDOM: code,
    update(n) {
      if (n.type.name !== 'code_block') return false;
      if (n.attrs.language) pre.dataset.language = String(n.attrs.language);
      else delete pre.dataset.language;
      return true;
    },
  };
}

function mermaidView(node: PMNode, view: EditorView, getPos: () => number | undefined): NodeView {
  const dom = document.createElement('div');
  dom.className = 'mermaid-block';
  const box = document.createElement('div');
  box.className = 'mermaid-svg';
  dom.appendChild(box);
  let cur = node;
  mermaidInto(box, cur.textContent);
  dom.addEventListener('click', () => {
    openFloater({
      title: S.mermaidSource,
      lang: 'mermaid',
      source: cur.textContent,
      renderPreview: (el, src) => mermaidInto(el, src),
      onSave: (next) => {
        const pos = getPos();
        if (pos != null) replaceBlockText(view, pos, cur, next);
      },
    });
  });
  return {
    dom,
    update(n) {
      if (n.type.name !== 'code_block' || n.attrs.language !== 'mermaid') return false;
      cur = n;
      mermaidInto(box, n.textContent);
      return true;
    },
    ...selectToggle(dom),
  };
}

/** XML 卡（v1.5 直编）：正文 = 围栏内源文，contentDOM 直接可改——点击即编辑、
 *  逐字入账成句级 diff（Word 直觉），不再弹浮层整块替换。头部徽标仍显标签名、点头折叠。 */
function xmlCardView(node: PMNode): NodeView {
  const { dom, head, body } = cardShell('');
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  pre.appendChild(code);
  body.appendChild(pre);
  const badge = head.querySelector('.xml-badge');
  const paint = (n: PMNode): void => {
    const one = n.textContent.trim();
    const tag = tagOf(one);
    // 单行标签（开/闭/自闭合）徽标原样显示标签文本；多行块显示 <tag> 统一样式；空卡兜底
    if (badge) badge.textContent = one ? (one.includes('\n') ? (tag ? `<${tag}>` : 'xml') : one) : 'xml';
  };
  paint(node);
  return {
    dom,
    contentDOM: code,
    update(n) {
      // 只接 -xml 档：language 漂移到 -img/-raw 时必须换 view（与 codeBlockView 分派同口径）
      if (n.type.name !== 'code_block' || MD2P_LANG.exec(String(n.attrs.language ?? ''))?.[1] !== 'xml') return false;
      paint(n);
      return true;
    },
    ...selectToggle(dom),
  };
}

/** 孤立 <img> 块（§4.1）：渲染为图；无 src 或加载失败降级转义。 */
function htmlImgView(node: PMNode, view: EditorView, getPos: () => number | undefined): NodeView {
  const dom = document.createElement('div');
  dom.className = 'html-img';
  let cur = node;
  const draw = (n: PMNode): void => {
    dom.textContent = '';
    const raw = n.textContent;
    const src = imgAttr(raw, 'src');
    if (!src) {
      const pre = document.createElement('pre');
      pre.textContent = raw;
      dom.appendChild(pre);
      return;
    }
    const img = document.createElement('img');
    img.alt = imgAttr(raw, 'alt');
    img.addEventListener('error', () => img.classList.add('img-broken'), { once: true });
    resolveImg(src, img);
    dom.appendChild(img);
  };
  draw(node);
  dom.addEventListener('click', () => {
    openFloater({
      title: S.htmlImg,
      lang: 'html',
      source: cur.textContent,
      renderPreview: (el, src) => {
        const url = imgAttr(src, 'src');
        if (url) {
          const im = document.createElement('img');
          im.alt = imgAttr(src, 'alt');
          resolveImg(url, im);
          el.appendChild(im);
        } else el.textContent = src;
      },
      onSave: (next) => {
        const pos = getPos();
        if (pos != null) replaceBlockText(view, pos, cur, next);
      },
    });
  });
  return {
    dom,
    update(n) {
      if (n.type.name !== 'code_block') return false;
      cur = n;
      draw(n);
      return true;
    },
    ...selectToggle(dom),
  };
}

/* ---------- math ---------- */

function openMathFloater(source: string, displayMode: boolean, onSave: (next: string) => void): void {
  openFloater({
    title: S.mathSource,
    lang: 'latex',
    source,
    renderPreview: (el, src) => katexInto(el, src, displayMode),
    onSave,
  });
}

const mathBlockView: NodeViewConstructor = (node, view, getPos) => {
  const dom = document.createElement('div');
  dom.className = 'math-block';
  let cur = node;
  katexInto(dom, cur.textContent, true);
  dom.addEventListener('click', () =>
    openMathFloater(cur.textContent, true, (next) => {
      const pos = getPos();
      if (pos != null) replaceBlockText(view, pos, cur, next);
    }),
  );
  return {
    dom,
    update(n) {
      if (n.type.name !== 'math_block') return false;
      cur = n;
      katexInto(dom, n.textContent, true);
      return true;
    },
    ...selectToggle(dom),
  };
};

const mathInlineView: NodeViewConstructor = (node, view, getPos) => {
  const dom = document.createElement('span');
  dom.className = 'math-inline';
  let cur = node;
  katexInto(dom, String(cur.attrs.value ?? ''), false);
  dom.addEventListener('click', () =>
    openMathFloater(String(cur.attrs.value ?? ''), false, (next) => {
      const pos = getPos();
      if (pos != null)
        view.dispatch(view.state.tr.replaceWith(pos, pos + cur.nodeSize, cur.type.create({ value: next })));
    }),
  );
  return {
    dom,
    update(n) {
      if (n.type.name !== 'math_inline') return false;
      cur = n;
      katexInto(dom, String(n.attrs.value ?? ''), false);
      return true;
    },
    ...selectToggle(dom),
  };
};

/* ---------- footnote / image ---------- */

const footnoteRefView: NodeViewConstructor = (node, view) => {
  const dom = document.createElement('sup');
  dom.className = 'footnote-ref';
  dom.textContent = `[${String(node.attrs.label ?? '')}]`;
  dom.addEventListener('click', () => {
    const label = String(node.attrs.label ?? '');
    let def = '';
    view.state.doc.descendants((n) => {
      if (n.type.name !== 'footnote_definition' || n.attrs.label !== label) return true;
      def = n.textContent;
      return false;
    });
    openPopover(dom, (body) => {
      body.textContent = def || `${S.noFootnote}：${label}`;
    });
  });
  return { dom };
};

const imageView: NodeViewConstructor = (node) => {
  const img = document.createElement('img');
  const sync = (n: PMNode): void => {
    resolveImg(String(n.attrs.src ?? ''), img);
    img.alt = String(n.attrs.alt ?? '');
    img.title = String(n.attrs.title ?? '');
  };
  sync(node);
  // 相对路径未授权/缺失时降级占位样式
  img.addEventListener('error', () => img.classList.add('img-broken'), { once: true });
  return {
    dom: img,
    update(n) {
      if (n.type.name !== 'image') return false;
      sync(n);
      return true;
    },
  };
};

/* ---------- 注册表 ---------- */

export const nodeViews: Readonly<Record<string, NodeViewConstructor>> = {
  code_block: codeBlockView,
  math_block: mathBlockView,
  math_inline: mathInlineView,
  footnote_reference: footnoteRefView,
  image: imageView,
};
