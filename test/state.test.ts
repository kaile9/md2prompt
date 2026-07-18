// test/state.test.ts — store 接线与生命周期（v1.2 隐藏/撤回/墓碑）。
// 使用真实 prompt/hash/fsio；fsio 无句柄时安全空转，避免进程级模块 mock 污染其他测试文件。
import { test, expect, describe, beforeAll, beforeEach } from 'bun:test';
import type { Block } from '../src/core/ir';

const blk = (id: string, text: string): Block => ({ id, kind: 'para', text, lineStart: 0, lineEnd: 0 });
const FILE = { name: 'a.md', kind: 'md' as const };

let store: any, getSaveState: any;
beforeAll(async () => ({ store, getSaveState } = await import('../src/core/state')));
beforeEach(() => store.dispatch({ type: 'new' }));

const load1 = (text = '旧') => {
  store.dispatch({ type: 'load', file: FILE, cur: [blk('b1', text)] });
  store.dispatch({ type: 'patchCur', cur: [blk('b1', '新')] });
  return () => store.state.ops[0];
};

test('初值 null；new 建空文档', async () => {
  const fresh: any = (await import('../src/core/state')).store;
  expect(fresh.state.ops).toEqual([]);
  expect(fresh.state.withdrawn).toEqual([]);
  expect(fresh.state.file.kind).toBe('md');
});

test('load + patchCur：ops 恒等于 diff(base,cur)', () => {
  store.dispatch({ type: 'load', file: FILE, cur: [blk('b1', '甲'), blk('b2', '乙')] });
  expect(store.state.ops).toEqual([]);
  store.dispatch({ type: 'patchCur', cur: [blk('b1', '甲'), blk('b2', '乙改')] });
  expect(store.state.ops.map((o: any) => o.type)).toEqual(['replace']);
  expect(store.state.ops[0].after).toBe('乙改');
});

test('addNote/recordMove 与 diff 合并按行排序', () => {
  store.dispatch({ type: 'load', file: FILE, cur: [blk('b1', '甲'), blk('b2', '乙'), blk('b3', '丙')] });
  store.dispatch({ type: 'patchCur', cur: [blk('b1', '甲'), blk('b3', '丙'), blk('b2', '乙改')] });
  store.dispatch({ type: 'addNote', blockId: 'b1', note: '批注' });
  store.dispatch({ type: 'recordMove', blockId: 'b2', first: '乙', from: [3, 3], to: 5 });
  expect(store.state.ops.map((o: any) => o.type)).toEqual(['note', 'replace', 'move']);
});

describe('隐藏（hide/unhide/hideAll）', () => {
  test('hide：文本不动、op 保留、状态 hidden；unhide 还原', () => {
    const op = load1()();
    store.dispatch({ type: 'hide', id: op.id });
    expect(store.state.cur[0].text).toBe('新');
    expect(store.state.ops[0].state).toBe('hidden');
    store.dispatch({ type: 'unhide', id: op.id });
    expect(store.state.ops[0].state).toBeUndefined();
  });

  test('hidden 跨击键存活（flags 依附确定性 diff id）', () => {
    store.dispatch({ type: 'load', file: FILE, cur: [blk('b1', '一'), blk('b2', '二')] });
    store.dispatch({ type: 'patchCur', cur: [blk('b1', '一改'), blk('b2', '二')] });
    store.dispatch({ type: 'hide', id: store.state.ops[0].id });
    store.dispatch({ type: 'patchCur', cur: [blk('b1', '一改'), blk('b2', '二改')] }); // 别处再敲
    expect(store.state.ops.find((o: any) => o.blockId === 'b1').state).toBe('hidden');
    expect(store.state.ops.find((o: any) => o.blockId === 'b2').state).toBeUndefined();
  });

  test('hideAll：全部 pending 转 hidden；预令中的不受影响', () => {
    store.dispatch({ type: 'load', file: FILE, cur: [blk('b1', '一'), blk('b2', '二')] });
    store.dispatch({ type: 'patchCur', cur: [blk('b1', '一改'), blk('b2', '二改')] });
    const [o1] = store.state.ops;
    store.dispatch({ type: 'withdraw', id: o1.id });
    store.dispatch({ type: 'hideAll' });
    expect(store.state.ops.find((o: any) => o.id === o1.id).state).toBe('withdrawing');
    expect(store.state.ops.filter((o: any) => o.id !== o1.id).every((o: any) => o.state === 'hidden')).toBe(true);
  });
});

describe('撤回两阶段 + 墓碑', () => {
  test('withdraw 进预令（文本不动）；cancelWithdraw 回 pending', () => {
    const op = load1()();
    store.dispatch({ type: 'withdraw', id: op.id });
    expect(store.state.ops[0].state).toBe('withdrawing');
    expect(store.state.cur[0].text).toBe('新');
    store.dispatch({ type: 'cancelWithdraw', id: op.id });
    expect(store.state.ops[0].state).toBeUndefined();
  });

  test('withdrawCommit：cur 回滚、op 转墓碑、可清空', () => {
    const op = load1()();
    store.dispatch({ type: 'withdraw', id: op.id });
    store.dispatch({ type: 'withdrawCommit', id: op.id });
    expect(store.state.cur[0].text).toBe('旧');
    expect(store.state.ops).toEqual([]);
    expect(store.state.withdrawn).toHaveLength(1);
    expect(store.state.withdrawn[0]).toMatchObject({ id: op.id, state: 'withdrawn', before: '旧', after: '新' });
    store.dispatch({ type: 'clearWithdrawn' });
    expect(store.state.withdrawn).toEqual([]);
  });

  test('未预令直接 withdrawCommit / 重复 withdraw：静默不动账', () => {
    const op = load1()();
    store.dispatch({ type: 'withdrawCommit', id: op.id });
    expect(store.state.cur[0].text).toBe('新');
    store.dispatch({ type: 'withdraw', id: op.id });
    store.dispatch({ type: 'withdraw', id: op.id }); // 已预令，再点 withdraw 不推进
    expect(store.state.cur[0].text).toBe('新');
    expect(store.state.withdrawn).toEqual([]);
  });

  test('hidden 的 op 可直接 withdraw（跳入预令）', () => {
    const op = load1()();
    store.dispatch({ type: 'hide', id: op.id });
    store.dispatch({ type: 'withdraw', id: op.id });
    expect(store.state.ops[0].state).toBe('withdrawing');
  });

  test('note 撤回：文本不动，直接立碑', () => {
    store.dispatch({ type: 'load', file: FILE, cur: [blk('b1', '甲')] });
    store.dispatch({ type: 'addNote', blockId: 'b1', note: 'n' });
    const op = store.state.ops[0];
    store.dispatch({ type: 'withdraw', id: op.id });
    store.dispatch({ type: 'withdrawCommit', id: op.id });
    expect(store.state.cur[0].text).toBe('甲');
    expect(store.state.withdrawn[0].type).toBe('note');
  });
});

describe('墓碑复活（restore）', () => {
  test('replace 墓碑复活：重新施加，op 回到 pending', () => {
    const op = load1()();
    store.dispatch({ type: 'withdraw', id: op.id });
    store.dispatch({ type: 'withdrawCommit', id: op.id });
    expect(store.state.cur[0].text).toBe('旧');
    store.dispatch({ type: 'restore', id: store.state.withdrawn[0].id });
    expect(store.state.cur[0].text).toBe('新');
    expect(store.state.withdrawn).toEqual([]);
    expect(store.state.ops[0].type).toBe('replace');
    expect(store.state.ops[0].state).toBeUndefined();
  });

  test('note 墓碑复活：回到人工集；目标文本消失的墓碑复活失败且保留', () => {
    store.dispatch({ type: 'load', file: FILE, cur: [blk('b1', '甲')] });
    store.dispatch({ type: 'addNote', blockId: 'b1', note: 'n' });
    const op = store.state.ops[0];
    store.dispatch({ type: 'withdraw', id: op.id });
    store.dispatch({ type: 'withdrawCommit', id: op.id });
    store.dispatch({ type: 'restore', id: store.state.withdrawn[0].id });
    expect(store.state.ops.some((o: any) => o.type === 'note')).toBe(true);
    // replace 墓碑在文本再被改动后复活失败
    const op2 = load1('甲2')();
    store.dispatch({ type: 'withdraw', id: op2.id });
    store.dispatch({ type: 'withdrawCommit', id: op2.id });
    store.dispatch({ type: 'patchCur', cur: [blk('b1', '完全不同的文本')] });
    const tombId = store.state.withdrawn.at(-1).id;
    store.dispatch({ type: 'restore', id: tombId });
    expect(store.state.withdrawn.some((o: any) => o.id === tombId)).toBe(true);
  });
});

test('未知 id：全部动作静默不动账', () => {
  load1()();
  for (const t of ['hide', 'unhide', 'withdraw', 'withdrawCommit', 'cancelWithdraw', 'restore'])
    store.dispatch({ type: t, id: '不存在' });
  expect(store.state.ops).toHaveLength(1);
  expect(store.state.cur[0].text).toBe('新');
  expect(store.state.withdrawn).toEqual([]);
});

test('load 恢复：ops 参数分流——note/move 进人工集，墓碑进 withdrawn，A 类由 diff 重算', () => {
  const recovered = [
    { id: 'x', type: 'replace', blockId: 'b1', before: '甲', after: '乙', time: '' },
    { id: 'y', type: 'note', blockId: 'b1', note: 'n', time: '' },
    { id: 'z', type: 'delete', blockId: 'b9', before: '撤', time: '', state: 'withdrawn' },
  ];
  store.dispatch({ type: 'load', file: FILE, base: [blk('b1', '甲')], cur: [blk('b1', '乙')], ops: recovered as any });
  expect(store.state.ops.map((o: any) => o.type).sort()).toEqual(['note', 'replace']);
  expect(store.state.withdrawn).toHaveLength(1);
  expect(store.state.withdrawn[0].state).toBe('withdrawn');
});

test('M1：hidden 的 diff op 跨会话复活（load 播种 flags）', () => {
  const recovered = [
    { id: 'A1', type: 'replace', blockId: 'b1', before: '甲', after: '乙', time: '', state: 'hidden' },
  ];
  store.dispatch({ type: 'load', file: FILE, base: [blk('b1', '甲')], cur: [blk('b1', '乙')], ops: recovered as any });
  expect(store.state.ops).toHaveLength(1);
  expect(store.state.ops[0].state).toBe('hidden');
  // 别处再编辑，hidden 仍存活
  store.dispatch({ type: 'patchCur', cur: [blk('b1', '乙'), blk('b2', '新')] });
  expect(store.state.ops.find((o: any) => o.blockId === 'b1').state).toBe('hidden');
});

test('M5：hidden 的 delete 跨会话播种（blockId \'\' 按 before 补绑）', () => {
  const base = [blk('b1', '一'), blk('b2', '二')];
  const cur = [blk('b1', '一')];
  const recovered = [{ id: 'A2', type: 'delete', blockId: '', before: '二', time: '', state: 'hidden' }];
  store.dispatch({ type: 'load', file: FILE, base, cur, ops: recovered as any });
  const del = store.state.ops.find((o: any) => o.type === 'delete');
  expect(del.state).toBe('hidden');
  expect(del.blockId).toBe('b2');
});

test('load 可延迟 Prompt 持久化，配对决策完成后再显式启动 state→fsio 写入链', async () => {
  const promptWrites: string[] = [];
  const docHandle = {
    name: 'deferred.md',
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async getFile() { return { text: async () => '初始', lastModified: 1 }; },
    async createWritable() { return { async write() {}, async close() {} }; },
  };
  const promptHandle = {
    async createWritable() {
      return { async write(text: string) { promptWrites.push(text); }, async close() {} };
    },
  };
  const dir = { async getFileHandle() { return promptHandle; } };
  const original = (globalThis as any).window;
  (globalThis as any).window = {
    showOpenFilePicker: async () => [docHandle],
    showDirectoryPicker: async () => dir,
  };

  try {
    const fs = await import('../src/core/fsio');
    await fs.openDoc();
    store.dispatch({ type: 'load', file: FILE, cur: [blk('b1', '初始')], deferPrompt: true });
    await Bun.sleep(1700);
    expect(promptWrites).toEqual([]);
    store.dispatch({ type: 'persistPrompt' });
    await Bun.sleep(1700);
    expect(promptWrites).toHaveLength(1);
    expect(promptWrites[0]).toContain('protocol: md2prompt/1.2.0');
    fs.resetDoc();
  } finally {
    if (original === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = original;
  }
});

test('subscribe 通知与 setSaveState', () => {
  let n = 0, seen: any = undefined;
  const off = store.subscribe((s: any) => { n++; seen = s; });
  store.dispatch({ type: 'setSaveState', save: 'saving' });
  expect(getSaveState()).toBe('saving');
  expect(seen).toBe(store.state);
  store.dispatch({ type: 'addNote', blockId: 'b1', note: 'n' });
  expect(n).toBe(2);
  off();
  store.dispatch({ type: 'setSaveState', save: 'saved' });
});
