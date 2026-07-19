// SPDX-License-Identifier: MPL-2.0
// editor/linkref.ts — 引用式链接保真（SPEC §4.1 flush 忠实）。
// definition → linkDef 自定义节点（editor.ts 注册 schema，序列化经 html 原子逐字回吐）；
// linkReference/imageReference → inline html 原子（Milkdown 原生逐字往返）。
// 定义必须留在解析域内，引用才会被识别为 linkReference——故不用围栏隔离。
// 纯 mdast 变换，不依赖 Milkdown，可单测。

interface Pos {
  start: { offset?: number };
  end: { offset?: number };
}
interface N {
  type: string;
  value?: string;
  position?: Pos;
  children?: N[];
}

export const LINK_DEF = 'linkDef';

/** remark 插件：definition → linkDef 节点；行内引用 → html 原子。value 均为原文 offset 切片。 */
export function linkrefToHtml() {
  return (tree: N, file: { value: unknown }) => {
    const src = String(file?.value ?? '');
    const raw = (n: N): string => src.slice(n.position?.start.offset ?? 0, n.position?.end.offset ?? 0);
    const walk = (n: N): void => {
      if (n.type === 'definition') {
        n.type = LINK_DEF;
        n.value = raw(n);
        delete n.children;
        return;
      }
      if (n.type === 'linkReference' || n.type === 'imageReference') {
        n.type = 'html';
        n.value = raw(n);
        delete n.children;
        return;
      }
      for (const c of n.children ?? []) walk(c);
    };
    walk(tree);
  };
}
