/** ui/toolbar.ts — 竖直工具轨 + 选区浮卡（批次 4）。
 *  轨：块级动作（H1–H3/引用/列表/代码块/分割线/链接/图片），钉在编辑栏右缘、修订栏左边，纯图标+tooltip。
 *  卡：行内动作（B/I/S/行内码/链接/批注），选中文字才弹出，半透明不遮字，失焦/滚动即隐。 */
import { runBlock, runInsert, type BlockAction, type InlineAction } from '../editor/editor';
import { openPopover } from '../editor/floater';
import { S } from './strings';

export interface ToolbarHooks {
  annotate(): void; // 批注（main 的 annotateFlow，带当前选区）
  swap(anchor: HTMLElement): void; // 与第 N 行所在块调换（协议 2.0 swap）
  inline(a: InlineAction): void; // 行内格式（渲染=PM 命令；源码/分屏=文本包裹，由 main 分发）
  link(href: string): void; // 选区链接（同上）
}

const RAIL: [BlockAction | 'link' | 'image' | 'swap', string, string][] = [
  ['h1', 'H₁', S.tbH1],
  ['h2', 'H₂', S.tbH2],
  ['h3', 'H₃', S.tbH3],
  ['quote', '❝', S.tbQuote],
  ['bullet', '•≡', S.tbBullet],
  ['ordered', '1.', S.tbOrdered],
  ['codeblock', '{ }', S.tbCodeblock],
  ['hr', '——', S.tbHr],
  ['link', '⛓', S.tbLink],
  ['image', '▣', S.tbImage],
  ['swap', '⇄', S.tbSwap],
];

const CARD: [InlineAction | 'link' | 'annotate', string][] = [
  ['bold', 'B'],
  ['italic', 'I'],
  ['strike', 'S'],
  ['code', '〈〉'],
  ['link', '⛓'],
  ['annotate', '✎'],
];

let card: HTMLElement | null = null;

/** 输入小弹窗（链接/图片 URL），Enter 确认。 */
function askUrl(anchor: HTMLElement, label: string, apply: (url: string) => void): void {
  openPopover(anchor, (body) => {
    const input = document.createElement('input');
    input.className = 'txt';
    input.placeholder = label;
    input.style.width = '16rem';
    body.appendChild(input);
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      const url = input.value.trim();
      if (url) apply(url);
      body.parentElement?.replaceChildren();
      document.dispatchEvent(new MouseEvent('mousedown'));
    });
    input.focus();
  });
}

export function mountToolbar(hooks: ToolbarHooks): void {
  const page = document.getElementById('page');
  if (!page) return;
  // 竖直工具轨
  const rail = document.createElement('div');
  rail.id = 'tool-rail';
  for (const [act, icon, tip] of RAIL) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tb-btn';
    b.textContent = icon;
    b.title = tip;
    b.addEventListener('mousedown', (ev) => ev.preventDefault()); // 不抢编辑器焦点
    b.addEventListener('click', () => {
      if (act === 'link') askUrl(b, 'https://', (url) => runInsert(`[${S.tbSeedText}](${url})`));
      else if (act === 'image') askUrl(b, S.tbUrlImage, (url) => runInsert(`![${S.tbSeedImage}](${url})`));
      else if (act === 'swap') hooks.swap(b);
      else runBlock(act);
    });
    rail.appendChild(b);
  }
  page.appendChild(rail);
  // 选区浮卡（滚屏/失焦即隐）
  card = document.createElement('div');
  card.id = 'sel-card';
  card.hidden = true;
  for (const [act, icon] of CARD) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tb-btn';
    b.textContent = icon;
    b.title = S[`tb_${act}` as keyof typeof S] as string;
    b.addEventListener('mousedown', (ev) => ev.preventDefault()); // 不抢选区
    b.addEventListener('click', () => {
      if (act === 'annotate') {
        card!.hidden = true;
        hooks.annotate();
      } else if (act === 'link') askUrl(b, 'https://', (url) => hooks.link(url));
      else hooks.inline(act);
    });
    card.appendChild(b);
  }
  document.body.appendChild(card);
  document.getElementById('scroller')?.addEventListener('scroll', () => {
    card!.hidden = true;
  });
  window.addEventListener('blur', () => {
    card!.hidden = true;
  });
}

/** 选区变化驱动浮卡显隐（editor 的 onSelectText 转发）。
 *  贴顶时翻到选区下方，右缘夹进视口（评审 nit）。 */
export function showSelection(at: { left: number; top: number } | null): void {
  if (!card) return;
  if (!at) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const w = card.offsetWidth || 180;
  const left = Math.min(at.left, window.innerWidth - w - 8);
  card.style.left = `${Math.max(8, left) + window.scrollX}px`;
  const up = at.top + window.scrollY - 42;
  card.style.top = `${up > window.scrollY + 4 ? up : at.top + window.scrollY + 24}px`;
}
