/** test/reparse.test.ts — core/ir.ts reparseSection 增量重解析（v1.6 性能专项）。
 *  两条不变量：serialize(结果) ≡ 新文本；未变块保旧 id（同文精确配对 → 原位同 kind 继承）、新块发 n 系新 id。 */
import { describe, expect, test } from 'bun:test';
import { parseDoc, reparseSection, serializeBlocks, type Block } from '../src/core/ir';

const NEW = expect.stringMatching(/^n\d+$/) as unknown as string;
const src = [
  '# 甲', '',
  '乙段，含 *标记*。', '',
  '```js', 'code', '```', '',
  '<xtag>', '', '卡内容', '', '</xtag>', '',
  '丙段。', '',
].join('\n');
// src 块：b1 heading / b2 para 乙段 / b3 code / b4 html 标签区域（b5/b6 被合并消化）/ b7 para 丙段
// 注意：合并发生在 id 分配之后，id 有跳号属正常（稳定性 ≠ 连续）

const cases: [string, string, (string | typeof NEW)[]][] = [
  ['中段单块改（同 kind 继承 id）', src.replace('乙段，含 *标记*。', '乙段改，含 *标记*。'), ['b1', 'b2', 'b3', 'b4', 'b7']],
  ['文首改（前缀碰撞：# 甲 ≠ # 甲改）', src.replace('# 甲', '# 甲改'), ['b1', 'b2', 'b3', 'b4', 'b7']],
  ['文末改', src.replace('丙段。', '丙段改。'), ['b1', 'b2', 'b3', 'b4', 'b7']],
  ['插入新块（发 n 系新 id）', src.replace('丙段。', '新块。\n\n丙段。'), ['b1', 'b2', 'b3', 'b4', NEW, 'b7']],
  ['删除块（其余 id 不动）', src.replace('乙段，含 *标记*。\n\n', ''), ['b1', 'b3', 'b4', 'b7']],
  ['纯 gap 变更', src.replace('乙段，含 *标记*。\n\n', '乙段，含 *标记*。\n\n\n\n'), ['b1', 'b2', 'b3', 'b4', 'b7']],
  ['卡内改（区域块继承 id）', src.replace('卡内容', '卡内容改'), ['b1', 'b2', 'b3', 'b4', 'b7']],
  ['无变更', src, ['b1', 'b2', 'b3', 'b4', 'b7']],
  ['全文替换', '完全不同的全新文档。\n\n另一段。\n', [NEW, NEW]],
];

describe('reparseSection（增量重解析）', () => {
  for (const [name, text2, ids] of cases) {
    test(name, () => {
      const before = parseDoc(src, 'md');
      const got = reparseSection(text2, before);
      expect(serializeBlocks(got)).toBe(text2); // 不变量一：序列化 ≡ 新文本
      expect(got.map((b) => b.id)).toEqual(ids); // 不变量二：id 账稳定
    });
  }

  test('头/尾对齐块复用旧引用（id/meta 全保，非重编）', () => {
    const before = parseDoc(src, 'md');
    const got = reparseSection(src.replace('乙段，含 *标记*。', '乙段改。'), before);
    expect(got[0]).toBe(before[0]); // 头块同引用
    expect(got[got.length - 1]).toBe(before[before.length - 1]); // 尾块同引用
    expect(got[1].text).toBe('乙段改。');
  });

  test('连续两次增量编辑：id 稳定不漂移（diff 账不破）', () => {
    const before = parseDoc(src, 'md');
    const step1 = reparseSection(src.replace('乙段，含 *标记*。', '乙段改一。'), before);
    const step2 = reparseSection(src.replace('乙段，含 *标记*。', '乙段改二。'), step1);
    expect(step2[0].id).toBe(before[0].id);
    expect(step2[1].id).toBe(step1[1].id); // 编辑块继承上一轮的 id
    expect(step2[2].id).toBe(before[2].id);
  });
});
