// SPDX-License-Identifier: MPL-2.0
// editor/static.ts — 非活动节静态渲染（SPEC §4.1）：mddom 统一管线，分片挂载不阻塞。
import type { Block } from '../core/ir';
import { newCtx, renderBlock, scanDefs, type ResolveImage } from './mddom';

export type { ResolveImage } from './mddom';

const gens = new WeakMap<HTMLElement, object>();
const later = (cb: () => void): void => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(cb, { timeout: 300 });
  else setTimeout(cb, 16);
};

/** 渲染 blocks 到 el：先扫定义（跨块引用共享查找表），再 30 块/片分段挂载；重入丢弃过期切片。
 *  onDone：末片挂载后回调（分屏预览恢复滚动位置用，v1.5.1）。 */
export function renderStatic(blocks: Block[], el: HTMLElement, resolveImage?: ResolveImage, onDone?: () => void): void {
  el.textContent = '';
  const ctx = newCtx(resolveImage);
  scanDefs(blocks, ctx);
  const token = {};
  gens.set(el, token);
  let i = 0;
  const step = (): void => {
    if (gens.get(el) !== token) return; // 已被新一轮渲染接管
    for (let n = 0; n < 30 && i < blocks.length; n++, i++) el.appendChild(renderBlock(blocks[i], ctx));
    if (i < blocks.length) later(step);
    else onDone?.();
  };
  step();
}
