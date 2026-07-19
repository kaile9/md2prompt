import { describe, expect, test } from 'bun:test';
import { applyOps, diffBlocks, rebindOps } from '../src/core/changes';
import { blockLineMap, serializeBlocks, type Block, type Op } from '../src/core/ir';
import { parsePrompt, renderPrompt } from '../src/core/promptmd';

const B = (id: string, text: string, kind: Block['kind'] = 'para'): Block => ({
  id,
  kind,
  text,
  lineStart: 0,
  lineEnd: 0,
});
const sig = (bs: Block[]) => bs.map((b) => `${b.id}::${b.text}`).join('|');
const mapped = (bs: Block[]): Block[] => {
  bs.forEach((b, i) => (b.gap = i ? '\n\n' : ''));
  blockLineMap(bs);
  return bs;
};

describe('diffBlocks', () => {
  test('替换：同 id 文本变化 → 单条 replace', () => {
    const ops = diffBlocks([B('b1', '甲'), B('b2', '乙')], [B('b1', '甲'), B('b2', '丙')]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: 'a:b2:replace', type: 'replace', blockId: 'b2', before: '乙', after: '丙' });
  });

  test('插入：cur 多出新 id 块 → 单条 insert', () => {
    const ops = diffBlocks([B('b1', '甲'), B('b2', '乙')], [B('b1', '甲'), B('bx', '新'), B('b2', '乙')]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: 'a:bx:insert', type: 'insert', blockId: 'bx', after: '新' });
  });

  test('删除：cur 缺少块 → 单条 delete', () => {
    const ops = diffBlocks([B('b1', '甲'), B('b2', '乙')], [B('b1', '甲')]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: 'a:b2:delete', type: 'delete', blockId: 'b2', before: '乙' });
  });

  test('混合：replace+delete+insert 按文档位置排序', () => {
    const base = [B('b1', '一'), B('b2', '二旧'), B('b3', '三删'), B('b4', '四'), B('b5', '五旧')];
    const cur = [B('b1', '一'), B('b2', '二新'), B('b4', '四'), B('bx', '插'), B('b5', '五新')];
    const ops = diffBlocks(base, cur);
    expect(ops.map((o) => o.id)).toEqual(['a:b2:replace', 'a:b3:delete', 'a:bx:insert', 'a:b5:replace']);
  });

  test('稳定性：同输入两次 diff 得同 id 序列（生命周期 flags 依赖此确定性）', () => {
    const base = [B('b1', '一'), B('b2', '二旧'), B('b3', '三删')];
    const cur = [B('b2', '二新'), B('bx', '插'), B('b1', '一改')];
    const ids1 = diffBlocks(base, cur).map((o) => o.id);
    const ids2 = diffBlocks(base, cur).map((o) => o.id);
    expect(ids1).toEqual(ids2);
  });

  test('LCS：未匹配块相似度 >0.6 判 replace，否则 delete+insert', () => {
    const old_ = '今天天气不错我们一起出去走走吧';
    const mid = '今天天气不错我们一起出去散步吧';
    const far = '完全无关的另一段内容xyz';
    const [r] = diffBlocks([B('b9', old_)], [B('c9', mid)]);
    expect(r).toMatchObject({ type: 'replace', blockId: 'b9', before: old_, after: mid });
    const ops = diffBlocks([B('b9', old_)], [B('c9', far)]);
    expect(ops.map((o) => o.type)).toEqual(['delete', 'insert']);
  });

  test('LCS：7×7 候选在 DP 回溯时复用相似度结果，不因预算二次消耗退化', () => {
    const base = Array.from({ length: 7 }, (_, i) => B(`b${i}`, `块${i}-${String.fromCharCode(0x4e00 + i).repeat(24)}`));
    const cur = Array.from({ length: 7 }, (_, i) => B(`c${i}`, `块${i}-${String.fromCharCode(0x4e00 + i).repeat(23)}改`));
    expect(diffBlocks(base, cur).map((o) => o.type)).toEqual(Array(7).fill('replace'));
  });

  test('空 diff：两侧一致 → 无 op', () => {
    expect(diffBlocks([B('b1', '甲')], [B('b1', '甲')])).toEqual([]);
  });
});

describe('applyOps', () => {
  const base = [B('b1', '一'), B('b2', '二旧'), B('b3', '三删'), B('b4', '四'), B('b5', '五旧')];
  const cur = [B('b1', '一'), B('b2', '二新'), B('b4', '四'), B('bx', '插'), B('b5', '五新')];
  const ops = diffBlocks(base, cur);

  test('dir=1 正向施加得到 cur（墓碑复活的数据源）', () => {
    expect(sig(applyOps(base, ops, 1))).toBe(sig(cur));
  });

  test('往返：dir=1 后 dir=-1 还原 base', () => {
    const applied = applyOps(base, ops, 1);
    expect(sig(applyOps(applied, ops, -1))).toBe(sig(base));
  });

  test('撤回语义：applyOps(cur, [op], -1) 回滚单条', () => {
    const ins = ops.find((o) => o.type === 'insert');
    expect(ins).toBeDefined();
    expect(sig(applyOps(cur, [ins!], -1))).toBe(sig(cur.filter((b) => b.id !== 'bx')));
  });

  test('目标文本缺失时抛带 op id 的错', () => {
    const stale = [{ id: 'a:b9:replace', type: 'replace', blockId: 'b9', before: '不存在', after: '新', time: 't' } as const];
    expect(() => applyOps(base, [...stale], 1)).toThrow(/a:b9:replace/);
  });

  test('多个相邻 insert 正向重放保持目标顺序', () => {
    const before = mapped([B('a', 'A'), B('b', 'B'), B('c', 'C')]);
    const after = mapped([B('a', 'A'), B('x', 'X'), B('y', 'Y'), B('b', 'B'), B('c', 'C')]);
    expect(applyOps(before, diffBlocks(before, after), 1).map((b) => b.text)).toEqual(after.map((b) => b.text));
  });

  test('文首 insert 迁移首块前缀后，后续 insert 的 line 锚仍准确', () => {
    const before = mapped([B('a', 'A'), B('b', 'B'), B('c', 'C')]);
    const after = mapped([B('x', 'X'), B('a', 'A'), B('y', 'Y'), B('b', 'B'), B('c', 'C')]);
    const applied = applyOps(before, diffBlocks(before, after), 1);
    expect(applied.map((b) => b.text)).toEqual(after.map((b) => b.text));
    expect(serializeBlocks(applied)).toBe(serializeBlocks(after));
  });

  test('Prompt 恢复：多个相邻 delete 共享锚点时仍按原顺序插回', () => {
    const before = mapped([B('a', 'A'), B('b', 'B'), B('c', 'C')]);
    const after = mapped([B('a', 'A')]);
    const prompt = renderPrompt(
      { file: { name: 'a.md', kind: 'md' }, base: before, cur: after, ops: diffBlocks(before, after) },
      { docHash: 'blake3:aa', baseHash: 'blake3:bb' },
    );
    expect(applyOps(after, parsePrompt(prompt).ops, -1).map((b) => b.text)).toEqual(before.map((b) => b.text));
  });

  test('Prompt 恢复：清除后续 insert 后，delete 优先锚到仍存活的后继块', () => {
    const before = mapped([B('a', 'A'), B('b', 'B'), B('c', 'C'), B('d', 'D'), B('e', 'E')]);
    const after = mapped([B('a', 'A'), B('c', 'C'), B('x', 'X'), B('y', 'Y'), B('z', 'Z'), B('e', 'E changed')]);
    const prompt = renderPrompt(
      { file: { name: 'a.md', kind: 'md' }, base: before, cur: after, ops: diffBlocks(before, after) },
      { docHash: 'blake3:aa', baseHash: 'blake3:bb' },
    );
    expect(applyOps(after, parsePrompt(prompt).ops, -1).map((b) => b.text)).toEqual(before.map((b) => b.text));
  });

  test('swap 自逆：dir=±1 同形，再换一次还原', () => {
    const before = mapped([B('a', 'A'), B('b', 'B'), B('c', 'C')]);
    const swapped = mapped([B('b', 'B'), B('a', 'A'), B('c', 'C')]);
    // 记录时居 a（小行号）侧者为 blockId：swapped 状态下 b 在 line1、a 在 line3
    const swap: Op = { id: 's1', type: 'swap', blockId: 'b', otherId: 'a', a: 1, b: 3, firstA: 'B', firstB: 'A', time: '12:00' };
    expect(applyOps(swapped, [swap], -1).map((x) => x.text)).toEqual(['A', 'B', 'C']);
    expect(applyOps(before, [swap], 1).map((x) => x.text)).toEqual(['B', 'A', 'C']);
  });

  test('swap 恢复重绑：blockId 空时按首行文本 + 行号邻近定位两块', () => {
    const cur = mapped([B('b', 'B'), B('a', 'A'), B('c', 'C')]);
    const parsed: Op = { id: 'n2', seq: 2, type: 'swap', blockId: '', a: 1, b: 3, firstA: 'B', firstB: 'A', time: '' };
    const [bound] = rebindOps(cur, [parsed]);
    expect(bound).toMatchObject({ type: 'swap', blockId: 'b', otherId: 'a' });
  });

  test('swap 定位失败抛带 op id 的错（首行文本对不上）', () => {
    const cur = mapped([B('a', 'A'), B('b', 'B')]);
    const swap: Op = { id: 's9', type: 'swap', blockId: 'a', otherId: 'b', a: 1, b: 3, firstA: '不存在', firstB: 'B', time: '' };
    expect(() => applyOps(cur, [swap], 1)).toThrow(/s9/);
  });
});
