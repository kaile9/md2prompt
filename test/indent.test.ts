import { describe, expect, test } from 'bun:test';
import { indentStrip, indentWrite } from '../src/core/indent';

describe('indentWrite（首行缩进·写入文档，v1.2）', () => {
  test('正文段落行前置两个全角空格；结构行不动', () => {
    const src = ['# 标题', '', '第一段正文。', '', '- 列表项', '1. 有序项', '', '> 引用', '', '| a | b |', '|---|---|', '', '<div>html</div>', '', '    缩进代码'].join('\n');
    const out = indentWrite(src).split('\n');
    expect(out[0]).toBe('# 标题');
    expect(out[2]).toBe('　　第一段正文。');
    expect(out[4]).toBe('- 列表项');
    expect(out[5]).toBe('1. 有序项');
    expect(out[7]).toBe('> 引用');
    expect(out[9]).toBe('| a | b |');
    expect(out[12]).toBe('<div>html</div>');
    expect(out[14]).toBe('    缩进代码');
  });

  test('围栏内外代码行均不缩进；~~~ 围栏同理', () => {
    const src = ['正文。', '```js', 'const a = 1', '正文样式的代码', '```', '第二段。', '~~~', 'raw', '~~~', '第三段。'].join('\n');
    const out = indentWrite(src).split('\n');
    expect(out[0]).toBe('　　正文。');
    expect(out[2]).toBe('const a = 1');
    expect(out[3]).toBe('正文样式的代码');
    expect(out[5]).toBe('　　第二段。');
    expect(out[7]).toBe('raw');
    expect(out[9]).toBe('　　第三段。');
  });

  test('幂等：已缩进行不重复添加；空白行不动', () => {
    const once = indentWrite('段落。\n\n第二段。');
    expect(indentWrite(once)).toBe(once);
    expect(once).toBe('　　段落。\n\n　　第二段。');
  });

  test('indentStrip：写入→剥离闭环（跨会话恢复前提）；围栏内不剥', () => {
    const src = '# 标题\n\n段落。\n\n```\n　　代码里故意的缩进\n```\n\n第二段。';
    const written = indentWrite(src);
    expect(written).toContain('　　段落。');
    expect(indentStrip(written)).toBe(src);
    expect(indentStrip(src)).toBe(src); // 无缩进文件原样
  });

  test('M3 假阴性：hr / setext / 脚注定义 / 表格上下文全部免缩进', () => {
    const src = [
      '段落。',
      '---', // hr
      '***',
      '标题文字',
      '===', // setext 下划线
      '[^1]: 脚注定义',
      'a | b', // 表格行（前后皆含竖线）
      '---|---',
      'c | d',
      '',
      '行文里一根 | 孤立竖线', // 隔行无竖线 → 正常缩进
    ].join('\n');
    const out = indentWrite(src).split('\n');
    expect(out[0]).toBe('　　段落。');
    expect(out[1]).toBe('---');
    expect(out[2]).toBe('***');
    expect(out[4]).toBe('===');
    expect(out[5]).toBe('[^1]: 脚注定义');
    expect(out[6]).toBe('a | b');
    expect(out[8]).toBe('c | d');
    expect(out[10]).toBe('　　行文里一根 | 孤立竖线');
  });
});
