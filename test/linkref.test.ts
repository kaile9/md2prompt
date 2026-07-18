// test/linkref.test.ts — 行内引用链接 → html 原子（B1 回归：Milkdown parser 无 schema 承接）
import { describe, expect, test } from 'bun:test';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { linkrefToHtml, LINK_DEF } from '../src/editor/linkref';

interface N {
  type: string;
  value?: string;
  children?: N[];
}

const parse = (src: string): N => {
  const proc = unified().use(remarkParse).use(linkrefToHtml);
  return proc.runSync(proc.parse(src), src) as unknown as N; // 与 Milkdown 同样传原文作 file
};

describe('linkrefToHtml', () => {
  test('linkReference/imageReference 转 html 原子且 value 为原文切片', () => {
    // CommonMark：引用有定义才成 linkReference
    const tree = parse('[a][x] 与 ![i][y] 混排\n\n[x]: https://e.com\n\n[y]: https://e2.com');
    const para = tree.children?.[0];
    const htmls = (para?.children ?? []).filter((n) => n.type === 'html');
    expect(htmls.map((n) => n.value)).toEqual(['[a][x]', '![i][y]']);
  });

  test('简写引用 [x] 同样转换', () => {
    const tree = parse('见 [x] 即可\n\n[x]: https://e.com');
    const htmls = (tree.children?.[0]?.children ?? []).filter((n) => n.type === 'html');
    expect(htmls.map((n) => n.value)).toEqual(['[x]']);
  });

  test('块级 definition → linkDef 节点且 value 为原文切片', () => {
    const tree = parse('[a][x]\n\n[x]: https://example.com');
    const defs = (tree.children ?? []).filter((n) => n.type === LINK_DEF);
    expect(defs.map((n) => n.value)).toEqual(['[x]: https://example.com']);
    const inlineHtml = (tree.children?.[0]?.children ?? []).some((n) => n.type === 'html');
    expect(inlineHtml).toBe(true);
  });

  test('普通行内链接 [a](url) 不受影响', () => {
    const tree = parse('[a](https://e.com)');
    expect((tree.children?.[0]?.children ?? []).some((n) => n.type === 'link')).toBe(true);
    expect((tree.children?.[0]?.children ?? []).some((n) => n.type === 'html')).toBe(false);
  });
});
