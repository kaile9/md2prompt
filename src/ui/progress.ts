/** ui/progress.ts — 进度双模式（v1.4）：顶部传统细条 / 右侧 minimap（VS Code 式直观预览）。
 *  minimap：块级骨架条（高度 ∝ 块文本量，不渲文字缩略——太贵）、修订标记、viewport 框、点击跳转。 */
import type { DocState } from '../core/ir';

let page: HTMLElement | null = null;
let scroller: HTMLElement | null = null;
let bar: HTMLElement | null = null;
let map: HTMLElement | null = null;
let mode: 'bar' | 'map' | 'off' = 'bar';

export function mountProgress(): void {
  page = document.getElementById('page');
  scroller = document.getElementById('scroller');
  if (!page || !scroller) return;
  bar = Object.assign(document.createElement('div'), { id: 'progress-bar' });
  bar.appendChild(document.createElement('i'));
  map = Object.assign(document.createElement('div'), { id: 'minimap' });
  page.append(bar, map); // 挂壳（#page 不滚动），不随内容跑
  scroller.addEventListener('scroll', paint, { passive: true });
  window.addEventListener('resize', paint);
  // 骨架条之间的缝隙也是有效击区：按纵向比例滚动
  const mm = map;
  mm.addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).dataset?.bid || !scroller) return;
    const r = mm.getBoundingClientRect();
    scroller.scrollTo({
      top: ((ev.clientY - r.top) / r.height) * scroller.scrollHeight - scroller.clientHeight / 2,
      behavior: 'smooth',
    });
  });
  paint();
}

export function setProgressMode(m: 'bar' | 'map' | 'off'): void {
  mode = m;
  paint();
}

/** 跳转统一居中（main/editor 共用）：自算 scrollTop，不受嵌套滚动容器与 section 巨块影响。
 *  scrollIntoView 的 block:'center' 在「活动节=编辑器、目标=整节」场景会把整节推中——
 *  2000 行的节一推就飞，v1.5 起一切跳转走这里。
 *  v1.5.1：容器自适应——目标在 .split-view（分屏独立滚动容器）内时滚动它而非 #scroller；
 *  目标矩形全 0（折叠 XML 卡的隐藏 contentDOM 等）时上溯到首个可见祖先。 */
export function centerOn(el: HTMLElement): void {
  let target = el;
  let r = target.getBoundingClientRect();
  while (r.width === 0 && r.height === 0 && target.parentElement) {
    target = target.parentElement;
    r = target.getBoundingClientRect();
  }
  const sc = target.closest<HTMLElement>('.split-view') ?? scroller;
  if (!sc) return;
  const s = sc.getBoundingClientRect();
  sc.scrollTo({ top: sc.scrollTop + (r.top - s.top) - (s.height - r.height) / 2, behavior: 'smooth' });
}

/** 落点闪烁（只加 class，绝不再滚动）；重触发时重启动画并清理旧定时器（v1.5.1）。 */
const flashTimers = new WeakMap<HTMLElement, number>();
export function flashEl(el: HTMLElement): void {
  el.classList.remove('jump-flash');
  void el.offsetWidth; // 强制回流，重启 animation
  el.classList.add('jump-flash');
  window.clearTimeout(flashTimers.get(el));
  flashTimers.set(
    el,
    window.setTimeout(() => el.classList.remove('jump-flash'), 1300),
  );
}

/** 状态刷新时重建 minimap 骨架（HTML 未变不动 DOM，保滚动位置）。
 *  高度用 flex-grow ∝ 块文本量（容器 flex 自然压缩，>50 块不裁尾，评审 M4）。 */
export function refreshProgress(st: DocState | null): void {
  if (!map) return;
  const blocks = st?.cur ?? [];
  const opIds = new Set((st?.ops ?? []).filter((o) => !o.state || o.state === 'withdrawing').map((o) => o.blockId));
  const html = blocks
    .map(
      (b) =>
        `<i data-bid="${b.id}" style="flex-grow:${Math.max(1, b.text.length)}"${opIds.has(b.id) ? ' class="hasop"' : ''}></i>`,
    )
    .join('');
  if (map.dataset.html !== html) {
    map.innerHTML = html;
    map.dataset.html = html;
  }
  paint();
}

function paint(): void {
  if (!page || !bar || !map || !scroller) return;
  bar.style.display = mode === 'bar' ? '' : 'none';
  map.style.display = mode === 'map' ? '' : 'none';
  if (mode === 'bar') {
    const max = scroller.scrollHeight - scroller.clientHeight;
    (bar.firstElementChild as HTMLElement).style.width = `${max > 0 ? (scroller.scrollTop / max) * 100 : 0}%`;
  } else if (mode === 'map') {
    const ratio = scroller.scrollHeight > 0 ? scroller.clientHeight / scroller.scrollHeight : 1;
    const top = scroller.scrollHeight > 0 ? scroller.scrollTop / scroller.scrollHeight : 0;
    map.style.setProperty('--vp-top', `${top * 100}%`);
    map.style.setProperty('--vp-h', `${Math.min(1, ratio) * 100}%`);
  }
}

// minimap 点击 → 跳转（md2p-jump 事件，main 落位）
document.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest('#minimap i[data-bid]') as HTMLElement | null;
  if (!el?.dataset.bid) return;
  document.dispatchEvent(new CustomEvent('md2p-jump', { detail: { blockId: el.dataset.bid, line: null } }));
});
