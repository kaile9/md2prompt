// SPDX-License-Identifier: MPL-2.0
/** §4.2 通用块浮层：文本域 + 预览槽 + 保存/取消。消费者：mermaid / math / xmlcard / html-img。
 *  另提供 openPopover（脚注定义等轻量弹窗）与 registerCloser（records.ts 自建模态复用单例语义）。 */
import type { NoteKind } from '../core/ir';
import { S } from '../ui/strings';

export interface FloaterOptions {
  title: string;
  source: string;
  lang?: string;
  /** 批注三型选择器（协议 2.0）：存在才渲染；onSave 第二参回传选中型。 */
  kinds?: { current: NoteKind };
  renderPreview(el: HTMLElement, src: string): void;
  onSave(next: string, kind?: NoteKind): void;
}

/** DOM 契约：浮层挂载点 #floater、弹窗 #popover（§5）；缺失时兜底自建。 */
function host(id: string): HTMLElement {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
  }
  return el;
}

let closeCurrent: (() => void) | null = null;

/** 关闭当前浮层（若有）。幂等。 */
export function closeFloater(): void {
  closeCurrent?.();
}

/** 注销自建浮层的关闭函数（仅当它是当前注册者，防残留 closer 误抹新模态）。 */
export function releaseCloser(fn: () => void): void {
  if (closeCurrent === fn) closeCurrent = null;
}

/** 记录编辑器等自建模态复用同一挂载点。 */
export const floatRoot = (id: 'floater' | 'popover'): HTMLElement => host(id);

/** 注册自建浮层的关闭函数（先关闭既有浮层，保持单例）。 */
export function registerCloser(fn: () => void): void {
  closeFloater();
  closeCurrent = fn;
}

export function openFloater(opts: FloaterOptions): void {
  closeFloater();
  const root = host('floater');
  root.textContent = '';
  const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const backdrop = document.createElement('div');
  backdrop.className = 'floater-backdrop';
  const modal = document.createElement('div');
  modal.className = 'floater-modal';
  modal.addEventListener('click', (e) => e.stopPropagation());

  const head = document.createElement('div');
  head.className = 'floater-title';
  head.textContent = opts.title;

  const textarea = document.createElement('textarea');
  textarea.className = 'floater-source';
  if (opts.lang) textarea.dataset.lang = opts.lang;
  textarea.value = opts.source;
  textarea.spellcheck = false;
  textarea.rows = 12;

  const preview = document.createElement('div');
  preview.className = 'floater-preview';
  preview.setAttribute('aria-label', S.preview);

  const bar = document.createElement('div');
  bar.className = 'floater-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = S.save;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = S.cancel;
  bar.append(save, cancel);

  // 批注三型（request/suggest/discuss）：选中型随 onSave 回传
  let kindSel: HTMLElement | null = null;
  let curKind: NoteKind = opts.kinds?.current ?? 'request';
  if (opts.kinds) {
    kindSel = document.createElement('div');
    kindSel.className = 'note-kinds';
    const kinds: [NoteKind, string][] = [
      ['request', S.noteKindRequest],
      ['suggest', S.noteKindSuggest],
      ['discuss', S.noteKindDiscuss],
    ];
    for (const [k, label] of kinds) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mini-btn kind-' + k;
      b.textContent = label;
      b.title = S.noteKindTips[k];
      b.classList.toggle('on', k === curKind);
      b.addEventListener('click', () => {
        curKind = k;
        kindSel!.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      });
      kindSel.appendChild(b);
    }
  }

  modal.append(head, ...(kindSel ? [kindSel] : []), textarea, preview, bar);
  backdrop.appendChild(modal);
  root.appendChild(backdrop);

  let timer = 0;
  const refresh = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      preview.textContent = '';
      opts.renderPreview(preview, textarea.value);
    }, 300);
  };
  textarea.addEventListener('input', refresh);
  opts.renderPreview(preview, textarea.value);

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const close = (): void => {
    if (closeCurrent !== close) return; // 已被新浮层替换
    closeCurrent = null;
    window.clearTimeout(timer);
    document.removeEventListener('keydown', onKey, true);
    root.textContent = '';
    prevFocus?.focus();
  };
  closeCurrent = close;

  save.addEventListener('click', () => {
    const next = textarea.value;
    close();
    opts.onSave(next, curKind);
  });
  cancel.addEventListener('click', close);
  // 仅当按下就发生在背板上才关（文本域内拖选、背板松手不误关）
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey, true);
  textarea.focus();
}

/** 轻量弹窗：锚定 anchor 下方，点外部或 Esc 关闭。 */
export function openPopover(anchor: HTMLElement, build: (body: HTMLElement) => void): void {
  const root = host('popover');
  root.textContent = '';
  const card = document.createElement('div');
  card.className = 'popover-card';
  card.style.position = 'absolute';
  const r = anchor.getBoundingClientRect();
  card.style.left = `${r.left + window.scrollX}px`;
  card.style.top = `${r.bottom + window.scrollY + 4}px`;
  build(card);
  root.appendChild(card);

  const dismiss = (e: Event): void => {
    if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
    if (e instanceof MouseEvent && card.contains(e.target as Node)) return;
    root.textContent = '';
    document.removeEventListener('mousedown', dismiss, true);
    document.removeEventListener('keydown', dismiss, true);
  };
  document.addEventListener('mousedown', dismiss, true);
  document.addEventListener('keydown', dismiss, true);
}
