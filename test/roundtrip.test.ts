// test/roundtrip.test.ts — 全链路：diffBlocks → renderPrompt → parsePrompt → rebindOps → applyOps(-1)
// SPEC §2 恢复流程与 §3 协议的集成回归（审查发现的 blocker 多死在这条缝上）。
// 注意：base 与 cur 必须共享块 id（app 中 cur 由 base 派生）；两次 parseDoc 会各自编号，不可混用。
import { describe, expect, test } from 'bun:test';
import { parseDoc, serializeBlocks, blockLineMap, type Block, type DocState, type Op } from '../src/core/ir';
import { diffBlocks, applyOps, rejectOp, rebindOps } from '../src/core/changes';
import { renderPrompt, parsePrompt } from '../src/core/promptmd';
import { restoreFromPrompt } from '../src/core/state';

const HASHES = { docHash: 'blake3:x', baseHash: 'blake3:y' };
const texts = (bs: Block[]) => bs.map((b) => b.text);
const B = (id: string, text: string, gap?: string): Block => ({ id, kind: 'para', text, lineStart: 0, lineEnd: 0, gap });
const mapped = (bs: Block[]): Block[] => {
  blockLineMap(bs);
  return bs;
};

function roundTrip(base: Block[], cur: Block[], kind: 'md' | 'jsonl' = 'md', extraOps: Op[] = []) {
  blockLineMap(base);
  blockLineMap(cur);
  const ops = [...diffBlocks(base, cur), ...extraOps];
  const state: DocState = { file: { name: `t.${kind}`, kind }, base, cur, ops };
  const prompt = renderPrompt(state, HASHES);
  const parsed = parsePrompt(prompt); // blocker 回归点：真实 op 的 time 必须能读回
  const rebound = rebindOps(cur, parsed.ops);
  const restored = applyOps(cur, rebound, -1);
  blockLineMap(restored);
  return { ops, prompt, restored };
}

describe('全链路 round-trip', () => {
  test('替换+插入+删除混合：重建 base 逐字节相等', () => {
    const base = mapped([B('b1', '甲', ''), B('b2', '乙'), B('b3', '丙'), B('b4', '丁')]);
    const cur = mapped([B('b1', '甲改', ''), B('b2', '乙'), B('bx', '新段'), B('b4', '丁')]);
    const { ops, restored } = roundTrip(base, cur);
    expect(ops.map((o) => o.type)).toEqual(['replace', 'delete', 'insert']); // diff 按 base 序发射，排序在 state
    expect(texts(restored)).toEqual(['甲', '乙', '丙', '丁']);
    expect(serializeBlocks(restored)).toBe('甲\n\n乙\n\n丙\n\n丁');
  });

  test('协议 2.0：time 不落盘；n 按 seq（修改顺序）排列', () => {
    const { prompt } = roundTrip(mapped([B('b1', '一', ''), B('b2', '二')]), mapped([B('b1', '一改', ''), B('b2', '二')]));
    expect(prompt).not.toContain('time=');
    expect(prompt).toMatch(/<revise n="\d+"/);
  });

  test('外部生产者的多余属性（time 等）被忽略', () => {
    const base = mapped([B('b1', '一', ''), B('b2', '二')]);
    const cur = mapped([B('b1', '一改', ''), B('b2', '二')]);
    const ops = diffBlocks(base, cur);
    const prompt = renderPrompt({ file: { name: 't.md', kind: 'md' }, base, cur, ops }, HASHES);
    const withTime = prompt.replace('<revise n="1"', '<revise n="1" time="2026-07-17T08:22:31Z"');
    expect(parsePrompt(withTime).ops[0]).toMatchObject({ type: 'replace', time: '' });
  });

  test('重复文本块的删除按行号落回原位（不落文末）', () => {
    const base = mapped([B('b1', '同', ''), B('b2', '同'), B('b3', '尾')]);
    const cur = mapped([B('b1', '同', ''), B('b3', '尾')]);
    const { restored } = roundTrip(base, cur);
    expect(texts(restored)).toEqual(['同', '同', '尾']);
  });

  test('文末删除：恢复后落回文末原位', () => {
    const base = mapped([B('b1', '一', ''), B('b2', '二'), B('b3', '三')]);
    const cur = mapped([B('b1', '一', ''), B('b2', '二')]);
    const { restored } = roundTrip(base, cur);
    expect(texts(restored)).toEqual(['一', '二', '三']);
  });

  test('note 往返：行号保留并重绑到目标块', () => {
    const base = mapped([B('b1', '一', ''), B('b2', '二'), B('b3', '三')]);
    const note: Op = { id: 'o1', type: 'note', blockId: 'b2', note: '这段重写', kind: 'request', time: '13:05', line: base[1].lineStart };
    const { prompt, restored } = roundTrip(base, base.map((b) => ({ ...b })), 'md', [note]);
    expect(prompt).toContain('<note n="1" line="3" request="这段重写"></note>');
    expect(texts(restored)).toEqual(['一', '二', '三']);
  });

  test('swap 全链路：导出 → 恢复重绑 → 自逆还原块序', () => {
    const base = mapped([B('b1', '甲', ''), B('b2', '乙'), B('b3', '丙')]);
    const cur = mapped([B('b1', '甲', ''), B('b3', '丙'), B('b2', '乙')]);
    const swap: Op = { id: 'o1', type: 'swap', blockId: 'b3', otherId: 'b2', a: 3, b: 5, firstA: '丙', firstB: '乙', time: '13:40', seq: 1 };
    const { prompt, restored } = roundTrip(base, cur, 'md', [swap]);
    expect(prompt).toContain('<swap n="1" a="3" b="5"><first>丙</first><first>乙</first></swap>');
    expect(texts(restored)).toEqual(['甲', '乙', '丙']);
  });

  test('CRLF 文档：载荷含 \\r\\n 的块恢复不抛错且归一化相等', () => {
    const eq = (a: string, b: string) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
    const base = mapped([B('b1', '```js\r\na\r\nb\r\n```', ''), B('b2', '二')]);
    const cur = mapped([B('b1', '```js\r\na\r\nc\r\n```', ''), B('b2', '二')]);
    const { restored } = roundTrip(base, cur);
    expect(restored.length).toBe(2);
    expect(eq(restored[0].text, '```js\r\na\r\nb\r\n```')).toBe(true);
  });

  test('相似度护栏：超长块对不配对、不冻结', () => {
    const big1 = `首${'甲'.repeat(2000)}尾`;
    const big2 = `首${'乙'.repeat(2000)}尾`;
    const t0 = Date.now();
    const ops = diffBlocks(mapped([B('x1', '一', ''), B('x2', big1)]), mapped([B('y1', '一', ''), B('y2', big2)]));
    expect(Date.now() - t0).toBeLessThan(1000);
    // 一 因文本全同按相似度配对（免费），超长块对走护栏判 delete+insert
    expect(ops.filter((o) => o.type !== 'replace' || o.blockId === 'x2').map((o) => o.type)).toEqual(['delete', 'insert']);
  });

  test('jsonl：restoreFromPrompt 恢复 base 且重建块 kind 为 record', () => {
    const baseText = '{"a":1}\n{"a":2}\n{"a":3}';
    const curText = '{"a":1}\n{"a":2,"b":1}\n{"a":3}';
    const base = parseDoc(baseText, 'jsonl');
    const cur = base.map((b, i) => (i === 1 ? { ...b, text: '{"a":2,"b":1}' } : { ...b }));
    blockLineMap(cur);
    const ops = diffBlocks(base, cur);
    const prompt = renderPrompt({ file: { name: 't.jsonl', kind: 'jsonl' }, base, cur, ops }, HASHES);
    const r = restoreFromPrompt({ name: 't.jsonl', kind: 'jsonl' }, cur, prompt);
    expect(serializeBlocks(r.base)).toBe(baseText);
    expect(r.base.every((b) => b.kind === 'record')).toBe(true);
  });

  test('墓碑（C 类）直通：不参与 base 重建，恢复后仍在 ops 尾部', () => {
    const base = mapped([B('b1', '一', ''), B('b2', '二')]);
    const cur = mapped([B('b1', '一改', ''), B('b2', '二')]);
    const tomb: Op = {
      id: 'a:b9:replace',
      type: 'replace',
      blockId: 'b9',
      before: '撤前',
      after: '撤后',
      time: '09:30',
      state: 'withdrawn',
    };
    const prompt = renderPrompt({ file: { name: 't.md', kind: 'md' }, base, cur, ops: diffBlocks(base, cur), withdrawn: [tomb] }, HASHES);
    expect(prompt).toContain('<withdrawn>');
    const r = restoreFromPrompt({ name: 't.md', kind: 'md' }, cur.map((b) => ({ ...b })), prompt);
    expect(texts(r.base)).toEqual(['一', '二']); // 墓碑不干扰重建
    expect(r.ops.at(-1)).toMatchObject({ state: 'withdrawn', before: '撤前', after: '撤后' });
  });

  test('patch 形全链路：导出 patch → 恢复展开 → base 逐字节相等', async () => {
    const { hashShort } = await import('../src/core/hash');
    const pad = '用于填充长度的中性铺垫句子，反复出现以撑过二百字符门槛。'.repeat(6);
    const b7before = `第一段不变的铺垫文字，${pad}第三句会被改掉。第四句仍然不变，收尾也一样不动。`;
    const b7after = b7before.replace('第三句会被改掉。', '第三句已经改过了。');
    const base = mapped([B('b1', '头', ''), B('b7', b7before)]);
    const cur = mapped([B('b1', '头', ''), B('b7', b7after)]);
    const ops = diffBlocks(base, cur);
    const op = ops.find((o) => o.type === 'replace')!;
    const prompt = renderPrompt(
      { file: { name: 't.md', kind: 'md' }, base, cur, ops },
      HASHES,
      { patchHashes: new Map([[op.id, hashShort((op as { after: string }).after)]]) },
    );
    expect(prompt).toContain('form="patch"');
    const r = restoreFromPrompt({ name: 't.md', kind: 'md' }, cur.map((b) => ({ ...b })), prompt);
    expect(texts(r.base)).toEqual(['头', b7before]); // patch 展开 + 逆序取反，逐字节相等
    // 篡改 after-hash → 恢复必须拒绝
    const forged = prompt.replace(/<alter-hash>blake3:[0-9a-f]{16}<\/alter-hash>/, '<alter-hash>blake3:0000000000000000</alter-hash>');
    expect(() => restoreFromPrompt({ name: 't.md', kind: 'md' }, cur.map((b) => ({ ...b })), forged)).toThrow(/校验失败/);
  });
});

describe('rejectOp 精确落位', () => {
  test('reject(delete) 中间块回原位且保留 gap（不落文末、空行不被规范化）', () => {
    const base = mapped([B('b1', '一', ''), B('b2', '二', '\n\n\n'), B('b3', '三', '\n\n')]);
    const cur = mapped([B('b1', '一', ''), B('b3', '三', '\n\n\n')]);
    const op = diffBlocks(base, cur).find((o) => o.type === 'delete');
    expect(op).toBeDefined();
    const rejected = rejectOp(base, cur, op!);
    expect(texts(rejected)).toEqual(['一', '二', '三']);
    expect(serializeBlocks(rejected)).toBe('一\n\n\n二\n\n三');
  });

  test('reject(swap) 再换一次回原位', () => {
    const base = mapped([B('b1', '甲', ''), B('b2', '乙'), B('b3', '丙')]);
    const cur = mapped([B('b1', '甲', ''), B('b3', '丙'), B('b2', '乙')]);
    const op: Op = { id: 'o1', type: 'swap', blockId: 'b3', otherId: 'b2', a: 3, b: 5, firstA: '丙', firstB: '乙', time: '13:40' };
    const rejected = rejectOp(base, cur, op);
    expect(texts(rejected)).toEqual(['甲', '乙', '丙']);
  });

  test('reject(replace) 重复文本块按行号选目标', () => {
    const base = mapped([B('b1', '同', ''), B('b2', '同'), B('b3', '尾')]);
    const cur = mapped([B('b1', '同改', ''), B('b2', '同'), B('b3', '尾')]);
    const op = diffBlocks(base, cur).find((o) => o.type === 'replace');
    const rejected = rejectOp(base, cur, op!);
    expect(texts(rejected)).toEqual(['同', '同', '尾']);
  });
});
