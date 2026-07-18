// test/htmlguard.test.ts — protect/restore round-trip（SPEC §4.1 flush 忠实）
import { describe, expect, test } from 'bun:test';
import { protectHtmlBlocks, restoreHtmlBlocks } from '../src/editor/htmlguard';

const TOK = 'x7f3ab';
const rt = (src: string): string => restoreHtmlBlocks(protectHtmlBlocks(src, TOK), TOK);

describe('protect/restore round-trip', () => {
  const cases: [string, string][] = [
    ['XML 标签块', '前文\n\n<identity>\n我们是 Luciole。\n</identity>\n\n后文'],
    ['危险标签 script', '前文\n\n<script>alert(1)</script>\n\n后文'],
    ['段中 script（type1 可中断段落）', '文字\n<script>alert(1)</script>\n续行'],
    ['孤立 img 块', '前文\n\n<img src="a/b.png" alt="图">\n\n后文'],
    ['含反引号的 xml', '<note>\n内含 ``` 三反引号\n</note>'],
    ['嵌套围栏（4 反引号内含 ```js）', '````\n```js\n\n<div>\n```\n````'],
    ['已有 md2prompt 外来围栏', '```md2prompt-xml\nx\n```'],
    ['注释块（raw 转义）', '<!-- 批注 -->\n\n正文'],
    ['属性含 > 的标签', '<a title="x>y">z</a>'],
    ['单字母块级标签 <p>', '前文\n\n<p>段落</p>\n\n后文'],
  ];
  for (const [name, src] of cases) {
    test(name, () => {
      expect(rt(src)).toBe(src);
    });
  }

  test('外来他会话 token 围栏原样保留', () => {
    const src = '```md2prompt-q9z9-xml\n<note>x</note>\n```';
    expect(rt(src)).toBe(src);
  });

  test('protect 分类：script→raw、标签→xml、孤立 img→img、注释→raw', () => {
    expect(protectHtmlBlocks('<script>x</script>', TOK)).toContain(`md2prompt-${TOK}-raw`);
    expect(protectHtmlBlocks('<note>x</note>', TOK)).toContain(`md2prompt-${TOK}-xml`);
    expect(protectHtmlBlocks('<img src="a.png">', TOK)).toContain(`md2prompt-${TOK}-img`);
    expect(protectHtmlBlocks('<!-- c -->', TOK)).toContain(`md2prompt-${TOK}-raw`);
  });

  test('段尾紧贴的标签（type7 不可中断段落）不保护、文本不变', () => {
    const src = '文字\n<note>x</note>';
    expect(protectHtmlBlocks(src, TOK)).toBe(src);
  });

  test('v1.3 提示词式标签：带属性开标签跨空行配对，闭标签不成孤魂', () => {
    const src = '<identity intent="干活">\n\n正文一段。\n\n**加粗**二段。\n\n</identity>\n\n后文';
    const out = protectHtmlBlocks(src, TOK);
    // 开标签行起、闭标签行止，整块一个围栏（含中间空行）
    const m = out.match(/`{3,}md2prompt-x7f3ab-xml\n([\s\S]*?)\n`{3,}/);
    expect(m?.[1]).toBe('<identity intent="干活">\n\n正文一段。\n\n**加粗**二段。\n\n</identity>');
    expect(rt(src)).toBe(src);
  });

  test('v1.3 孤立闭标签/自闭合行 → 单行 xml 卡（不再是裸文本）', () => {
    const src = '前文\n\n</identity>\n\n<work-object choice="exactly-one"/>\n\n后文';
    const out = protectHtmlBlocks(src, TOK);
    expect(out).toContain('md2prompt-x7f3ab-xml\n</identity>\n');
    expect(out).toContain('md2prompt-x7f3ab-xml\n<work-object choice="exactly-one"/>\n');
    expect(rt(src)).toBe(src);
  });

  test('v1.3 标准 HTML 标签不走提示词档（div 仍按 CommonMark 渲染档）', () => {
    const src = '前文\n\n<div>\n内容\n</div>\n\n后文';
    const out = protectHtmlBlocks(src, TOK);
    expect(out).toContain('md2prompt-x7f3ab-xml\n<div>\n内容\n</div>');
    expect(rt(src)).toBe(src);
  });

  test('链接定义块不做围栏保护（走 linkDef schema 节点，linkref.ts）', () => {
    const src = '[a][x] 引用\n\n[x]: https://example.com "标题"\n\n正文';
    expect(protectHtmlBlocks(src, TOK)).toBe(src);
  });

  test('脚注定义不进围栏（gfm 原生承接）', () => {
    const src = '文[^1]\n\n[^1]: 脚注内容';
    expect(protectHtmlBlocks(src, TOK)).toBe(src);
  });

  test('v1.5.1 XML 内容含 ``` 仍成一张卡（内容里的围栏不是文档围栏，QA F3）', () => {
    const src = '<identity>\n```js\nlet a = 1;\n```\n</identity>';
    const out = protectHtmlBlocks(src, TOK);
    // 整块一个围栏，且外层反引号数 > 内容最长反引号串
    const m = out.match(/^(`{3,})md2prompt-x7f3ab-xml\n([\s\S]*?)\n\1$/);
    expect(m?.[2]).toBe(src);
    expect(m?.[1].length).toBeGreaterThan(3);
    expect(rt(src)).toBe(src);
  });

  test('v1.5.1 script 块含 ``` 仍是一个 raw 块（HTML 块优先于围栏，QA F3）', () => {
    const src = '<script>\n```\nlet x = 1;\n```\n</script>';
    const out = protectHtmlBlocks(src, TOK);
    const m = out.match(/^(`{3,})md2prompt-x7f3ab-raw\n([\s\S]*?)\n\1$/);
    expect(m?.[2]).toBe(src);
    expect(rt(src)).toBe(src);
  });

  test('保护后未闭合的围栏不被 restore 吞掉', () => {
    const broken = `\`\`\`md2prompt-${TOK}-xml\n<note>没闭合`;
    expect(restoreHtmlBlocks(broken, TOK)).toBe(broken);
  });
});
