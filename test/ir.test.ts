/** test/ir.test.ts — core/ir.ts 纯函数测试（bun test）。 */

import { describe, expect, test } from 'bun:test';
import { blockLineMap, parseDoc, serializeBlocks, type Block } from '../src/core/ir';

const MD = [
  '# 标题',
  '',
  '第一段，*强调* 与 `代码`。',
  '',
  '## 二级',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '| A | B |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '- 甲',
  '- 乙',
  '',
  '> 引用',
  '> 续行',
  '',
  '---',
  '',
  '<div class="x">',
  'html 块',
  '</div>',
  '',
  '$$',
  'x^2 + y^2 = z^2',
  '$$',
  '',
].join('\n');

describe('md 解析', () => {
  test('各种块型 round-trip 逐字节相等', () => {
    expect(serializeBlocks(parseDoc(MD, 'md'))).toBe(MD);
    expect(serializeBlocks(parseDoc(MD.slice(0, -1), 'md'))).toBe(MD.slice(0, -1));
    expect(serializeBlocks(parseDoc(MD + '\n\n', 'md'))).toBe(MD + '\n\n'); // 末尾多余空行
  });

  test('kind 映射与顺序', () => {
    expect(parseDoc(MD, 'md').map((b) => b.kind)).toEqual([
      'heading', 'para', 'heading', 'code', 'table',
      'list', 'quote', 'hr', 'html', 'math',
    ]);
  });

  test('meta：heading level / code lang', () => {
    const blocks = parseDoc(MD, 'md');
    expect(blocks[0].meta?.level).toBe(1);
    expect(blocks[2].meta?.level).toBe(2);
    expect(blocks[3].meta?.lang).toBe('js');
    expect(blocks[1].meta).toBeUndefined();
  });

  test('块 text 为原文切片（不重新 stringify）', () => {
    const blocks = parseDoc(MD, 'md');
    expect(blocks[3].text).toBe('```js\nconst a = 1;\n```');
    expect(blocks[6].text).toBe('> 引用\n> 续行');
    expect(blocks[9].text).toBe('$$\nx^2 + y^2 = z^2\n$$\n'); // 末块收编尾部换行
    expect(blocks[0].gap).toBe('');
    expect(blocks[1].gap).toBe('\n\n');
  });

  test('松散/紧凑空行混合 round-trip + 行号', () => {
    const src = '# A\n甲\n\n\n\n# B\n\n乙\n';
    const blocks = parseDoc(src, 'md');
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'para', 'heading', 'para']);
    expect(serializeBlocks(blocks)).toBe(src);
    expect(blocks.map((b) => [b.lineStart, b.lineEnd])).toEqual([[1, 1], [2, 2], [6, 6], [8, 8]]);
  });

  test('多行块行号：代码/表格/引用/数学', () => {
    const blocks = parseDoc(MD, 'md');
    expect(blocks.map((b) => [b.lineStart, b.lineEnd])).toEqual([
      [1, 1], [3, 3], [5, 5], [7, 9], [11, 13],
      [15, 16], [18, 19], [21, 21], [23, 25], [27, 29],
    ]);
  });

  test('文档起始空行计入首块 gap 与行号', () => {
    const src = '\n\n# A\n';
    const blocks = parseDoc(src, 'md');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].gap).toBe('\n\n');
    expect(blocks[0].lineStart).toBe(3);
    expect(serializeBlocks(blocks)).toBe(src);
  });

  test('setext 标题、松散列表（块内空行不拆块）', () => {
    const setext = '标题\n===\n';
    const b1 = parseDoc(setext, 'md');
    expect(b1.map((b) => b.kind)).toEqual(['heading']);
    expect(b1[0].meta?.level).toBe(1);
    expect([b1[0].lineStart, b1[0].lineEnd]).toEqual([1, 2]);
    expect(serializeBlocks(b1)).toBe(setext);

    const loose = '- a\n\n- b\n';
    const b2 = parseDoc(loose, 'md');
    expect(b2).toHaveLength(1);
    expect(b2[0].kind).toBe('list');
    expect([b2[0].lineStart, b2[0].lineEnd]).toEqual([1, 3]);
    expect(serializeBlocks(b2)).toBe(loose);
  });

  test('空文档与纯空白文档', () => {
    expect(parseDoc('', 'md')).toEqual([]);
    const blank = '\n \n\n';
    const blocks = parseDoc(blank, 'md');
    expect(blocks).toHaveLength(1);
    expect(serializeBlocks(blocks)).toBe(blank);
  });

  test('CRLF round-trip', () => {
    const src = '# A\r\n\r\n乙\r\n';
    expect(serializeBlocks(parseDoc(src, 'md'))).toBe(src);
  });
});

describe('jsonl 解析', () => {
  test('正常行：record 块 + meta.json + round-trip', () => {
    const src = '{"a":1}\n{"b":[1,2],"s":"x"}\n';
    const blocks = parseDoc(src, 'jsonl');
    expect(blocks.map((b) => b.kind)).toEqual(['record', 'record']);
    expect(blocks.map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(blocks[0].meta?.json).toEqual({ a: 1 });
    expect(blocks[1].meta?.json).toEqual({ b: [1, 2], s: 'x' });
    expect(serializeBlocks(blocks)).toBe(src);
  });

  test('坏行：meta.parseError + text 存原始行', () => {
    const src = '{"ok":1}\n{bad json}\n';
    const blocks = parseDoc(src, 'jsonl');
    expect(blocks).toHaveLength(2);
    expect(blocks[1].text).toBe('{bad json}\n');
    expect(typeof blocks[1].meta?.parseError).toBe('string');
    expect(blocks[1].meta?.json).toBeUndefined();
    expect(serializeBlocks(blocks)).toBe(src);
  });

  test('行间空行并入 gap，行号即记录所在源行', () => {
    const src = '{"a":1}\n\n\n{"b":2}\n';
    const blocks = parseDoc(src, 'jsonl');
    expect(blocks.map((b) => [b.lineStart, b.lineEnd])).toEqual([[1, 1], [4, 4]]);
    expect(serializeBlocks(blocks)).toBe(src);
  });

  test('无尾换行 + CRLF round-trip', () => {
    const src1 = '{"a":1}\n{"b":2}';
    expect(serializeBlocks(parseDoc(src1, 'jsonl'))).toBe(src1);
    const src2 = '{"a":1}\r\n{"b":2}\r\n';
    const blocks = parseDoc(src2, 'jsonl');
    expect(blocks[0].meta?.json).toEqual({ a: 1 });
    expect(serializeBlocks(blocks)).toBe(src2);
  });

  test('空文档与纯空行文档', () => {
    expect(parseDoc('', 'jsonl')).toEqual([]);
    const blank = '\n\n';
    const blocks = parseDoc(blank, 'jsonl');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('record');
    expect(serializeBlocks(blocks)).toBe(blank);
  });
});

describe('xml 解析', () => {
  test('全文一个 code 块', () => {
    const src = '<root>\n  <a x="1"/>\n</root>\n';
    const blocks = parseDoc(src, 'xml');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('code');
    expect(blocks[0].meta?.lang).toBe('xml');
    expect(blocks[0].text).toBe(src);
    expect([blocks[0].lineStart, blocks[0].lineEnd]).toEqual([1, 3]);
    expect(serializeBlocks(blocks)).toBe(src);
  });
});

describe('提示词标签区域合并（IR 块 ≡ 编辑器 XML 卡围栏，BUG5 根治）', () => {
  test('开标签跨空行配对到同名闭标签：整个区域并为一块，序列化逐字节相等', () => {
    const src = '前文段落。\n\n<zero-trust source="s" intent="i">\n\n第一段，含 *标记* 与 `代码`。\n\n## 区域里的标题\n\n</zero-trust>\n\n后文段落。\n';
    const blocks = parseDoc(src, 'md');
    expect(blocks.map((b) => b.kind)).toEqual(['para', 'html', 'para']);
    const region = blocks[1];
    expect(region.text).toBe('<zero-trust source="s" intent="i">\n\n第一段，含 *标记* 与 `代码`。\n\n## 区域里的标题\n\n</zero-trust>');
    expect([region.lineStart, region.lineEnd]).toEqual([3, 9]);
    expect(serializeBlocks(blocks)).toBe(src);
  });

  test('区域内含代码围栏照常合并（围栏文本逐字保留）', () => {
    const src = '<xtag>\n\n```\ncode\n```\n\n</xtag>\n';
    const blocks = parseDoc(src, 'md');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('html');
    expect(serializeBlocks(blocks)).toBe(src);
  });

  test('未闭合/标准标签/img/自闭合不合并', () => {
    const unclosed = '<identity>\n\n段落。\n';
    expect(parseDoc(unclosed, 'md').map((b) => b.kind)).toEqual(['html', 'para']);
    const std = '<div>\n\n段落。\n\n</div>\n';
    expect(parseDoc(std, 'md').map((b) => b.kind)).toEqual(['html', 'para', 'html']); // div 走 CommonMark 渲染档，不进合并
    const selfClose = '<br/>\n';
    expect(parseDoc(selfClose, 'md')).toHaveLength(1);
  });

  test('相邻两段同名标签各自配对', () => {
    const src = '<xtag>\n\n甲\n\n</xtag>\n\n<xtag>\n\n乙\n\n</xtag>\n';
    const blocks = parseDoc(src, 'md');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain('甲');
    expect(blocks[1].text).toContain('乙');
    expect(serializeBlocks(blocks)).toBe(src);
  });
});

describe('serializeBlocks / blockLineMap 编辑行为', () => {
  test('新建块缺省 gap：中部 "\\n\\n"，首部 ""', () => {
    const blocks = parseDoc('# A\n\n乙\n', 'md');
    const fresh: Block = { id: 'bX', kind: 'para', text: '新块', lineStart: 0, lineEnd: 0 };
    blocks.splice(1, 0, fresh);
    expect(serializeBlocks(blocks)).toBe('# A\n\n新块\n\n乙\n');
    blockLineMap(blocks);
    expect([fresh.lineStart, fresh.lineEnd]).toEqual([3, 3]);
    expect(blocks[2].lineStart).toBe(5);

    const head: Block = { id: 'bY', kind: 'para', text: '首', lineStart: 0, lineEnd: 0 };
    const blocks2 = parseDoc('# A\n\n乙\n', 'md');
    blocks2.unshift(head);
    expect(serializeBlocks(blocks2)).toBe('首# A\n\n乙\n');
  });

  test('块文本变长后 blockLineMap 原地重算后续行号', () => {
    const blocks = parseDoc('# A\n\n乙\n', 'md');
    blocks[0].text = '# A\n副标题';
    blockLineMap(blocks);
    expect([blocks[0].lineStart, blocks[0].lineEnd]).toEqual([1, 2]);
    expect([blocks[1].lineStart, blocks[1].lineEnd]).toEqual([4, 4]);
    expect(serializeBlocks(blocks)).toBe('# A\n副标题\n\n乙\n');
  });
});
