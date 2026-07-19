import { describe, expect, test } from 'bun:test';
import type { Block, DocState, Op } from '../src/core/ir';
import { PromptParseError, parsePrompt, renderPrompt } from '../src/core/promptmd';

const blk = (id: string, text: string, lineStart: number, kind: Block['kind'] = 'para'): Block => ({
  id,
  kind,
  text,
  lineStart,
  lineEnd: lineStart + text.split('\n').length - 1,
});

const HASHES = { docHash: 'blake3:9f3ac2aa', baseHash: 'blake3:71be04bb' };
const st = (file: DocState['file'], base: Block[], cur: Block[], ops: Op[], withdrawn: Op[] = []): DocState => ({
  file,
  base,
  cur,
  ops,
  withdrawn,
});

describe('SPEC §3 示例 round-trip（协议 1.1.0）', () => {
  const cur = [
    blk('b1', '# 报告', 1, 'heading'),
    blk('b8', '把文件修改的内容连同位置与意图完整导出', 8),
    blk('b12', '我们认为协议比编辑器重要\n中间两行\n论证如下\n……因此插件只是薄层。', 12),
  ];
  const ops: Op[] = [
    {
      id: 'op1',
      type: 'replace',
      blockId: 'b8',
      before: '把文件修改的内容完整导出',
      after: '把文件修改的内容连同位置与意图完整导出',
      time: '13:22',
      note: '可选',
    },
    { id: 'op2', type: 'move', blockId: 'b21', first: '导出协议示例', from: [21, 23], to: 9, time: '13:40' },
    { id: 'op3', type: 'note', blockId: 'b12', note: '这段逻辑跳跃，请补一个过渡论证', time: '13:35' },
  ];
  const text = renderPrompt(st({ name: 'report.md', kind: 'md' }, [], cur, ops), HASHES);

  test('render 符合冻结格式（kind/updated 已移出协议）', () => {
    expect(
      text.startsWith(
        '---\nprotocol: md2prompt/1.2.0\ndoc: report.md\ndoc-hash: blake3:9f3ac2aa\nbase-hash: blake3:71be04bb\npending: 3\nwithdrawn: 0\n---\n',
      ),
    ).toBe(true);
    expect(text).toContain('# 修改记录 · report.md');
    expect(text).toContain('<request id="B1" lines="12-15" time="13:35">');
    expect(text).toContain('<first>我们认为协议比编辑器重要</first>');
    expect(text).toContain('<last>……因此插件只是薄层。</last>');
    expect(text).toContain('<note>这段逻辑跳跃，请补一个过渡论证</note>');
    expect(text).toContain('<edit id="A1" type="replace" line="8" time="13:22">');
    expect(text).toContain('<before>把文件修改的内容完整导出</before>');
    expect(text).toContain('<after>把文件修改的内容连同位置与意图完整导出</after>');
    expect(text).toContain('<note>可选</note>');
    expect(text).toContain('<edit id="A2" type="move" from="21-23" to="9" time="13:40">');
    expect(text).toContain('<first>导出协议示例</first>');
    // B 类在前，'---' 分隔线，A 类在后
    const iReq = text.indexOf('<requests>');
    const iSep = text.indexOf('\n---\n', text.indexOf('</requests>'));
    const iEdt = text.indexOf('<edits>');
    expect(iReq).toBeGreaterThan(-1);
    expect(iSep).toBeGreaterThan(iReq);
    expect(iEdt).toBeGreaterThan(iSep);
  });

  test('parse 还原 meta 与 ops（id 按类重排、blockId 为协议外信息、line 保留）', () => {
    const { meta, ops: got } = parsePrompt(text);
    expect(meta).toEqual({
      protocol: 'md2prompt/1.2.0',
      doc: 'report.md',
      kind: 'md',
      docHash: HASHES.docHash,
      baseHash: HASHES.baseHash,
      pending: 3,
      withdrawn: 0,
    });
    expect(got).toEqual([
      { id: 'B1', type: 'note', blockId: '', note: '这段逻辑跳跃，请补一个过渡论证', time: '13:35', line: 12 },
      {
        id: 'A1',
        type: 'replace',
        blockId: '',
        before: '把文件修改的内容完整导出',
        after: '把文件修改的内容连同位置与意图完整导出',
        time: '13:22',
        note: '可选',
        line: 8,
      },
      { id: 'A2', type: 'move', blockId: '', first: '导出协议示例', from: [21, 23], to: 9, time: '13:40' },
    ]);
  });
});

test('多行内容与反引号自适应围栏 round-trip', () => {
  const before = '````markdown\n内含 ``` 三反引号\n行尾 `` 双反引号\n````';
  const after = '新第一行\n新第二行';
  const ops: Op[] = [{ id: 'x', type: 'replace', blockId: 'b3', before, after, time: '09:05', note: '多行\n批注' }];
  const text = renderPrompt(st({ name: 'a.md', kind: 'md' }, [blk('b3', before, 3)], [blk('b3', after, 3)], ops), HASHES);
  expect(text).toContain('<edit id="A1" type="replace" lines="3-4" time="09:05">');
  // 内容最长反引号串为 4 → 围栏 5
  const f5 = '`'.repeat(5);
  expect(text).toContain(`<before>\n${f5}\n${before}\n${f5}\n</before>`);
  const { ops: got } = parsePrompt(text);
  expect(got).toEqual([{ id: 'A1', type: 'replace', blockId: '', before, after, time: '09:05', note: '多行\n批注', line: 3 }]);
});

test('行内特殊字符 XML 转义 round-trip', () => {
  const before = 'a < b & c > d 含 </before> 字样';
  const ops: Op[] = [{ id: 'x', type: 'replace', blockId: 'b1', before, after: 'ok', time: '10:00' }];
  const text = renderPrompt(st({ name: 'a.md', kind: 'md' }, [blk('b1', before, 1)], [blk('b1', 'ok', 1)], ops), HASHES);
  expect(text).toContain('<before>a &lt; b &amp; c &gt; d 含 &lt;/before&gt; 字样</before>');
  const { ops: got } = parsePrompt(text);
  expect(got).toEqual([{ id: 'A1', type: 'replace', blockId: '', before, after: 'ok', time: '10:00', line: 1 }]);
});

test('JSONL 记录 before/after 一律 ```json 围栏；kind 由扩展名推断', () => {
  const rec = '{"text":"你好","label":1}';
  const ops: Op[] = [
    { id: 'x', type: 'replace', blockId: 'b2', before: rec, after: '{"text":"改后","label":2}', time: '11:11' },
    { id: 'y', type: 'insert', blockId: 'b3', after: '{"text":"新增"}', time: '11:12' },
  ];
  const text = renderPrompt(
    st(
      { name: 'd.jsonl', kind: 'jsonl' },
      [blk('b2', rec, 2, 'record')],
      [blk('b2', '{"text":"改后","label":2}', 2, 'record'), blk('b3', '{"text":"新增"}', 3, 'record')],
      ops,
    ),
    HASHES,
  );
  expect(text).toContain(`<before>\n\`\`\`json\n${rec}\n\`\`\`\n</before>`);
  const { meta, ops: got } = parsePrompt(text);
  expect(meta.kind).toBe('jsonl'); // front matter 无 kind 行，从 d.jsonl 推断
  expect(got).toEqual([
    { id: 'A1', type: 'replace', blockId: '', before: rec, after: '{"text":"改后","label":2}', time: '11:11', line: 2 },
    { id: 'A2', type: 'insert', blockId: '', after: '{"text":"新增"}', time: '11:12', line: 3 },
  ]);
});

test('delete 锚点 = 插入点行号（下一个幸存块起始行；文末为末行+1）', () => {
  const base = [blk('b1', '一', 1), blk('b2', '二', 2), blk('b3', '三', 3)];
  // 中间删除：锚到下一个幸存块 b3 的现行号 2
  const mid: Op[] = [{ id: 'x', type: 'delete', blockId: 'b2', before: '二', time: '12:00' }];
  const t1 = renderPrompt(st({ name: 'a.md', kind: 'md' }, base, [blk('b1', '一', 1), blk('b3', '三', 2)], mid), HASHES);
  expect(t1).toContain('<edit id="A1" type="delete" line="2" time="12:00">');
  expect(parsePrompt(t1).ops).toEqual([{ id: 'A1', type: 'delete', blockId: '', before: '二', time: '12:00', line: 2 }]);
  // 文末删除：锚到全文末行 +1（恢复时越出全文即落回文末）
  const tail: Op[] = [{ id: 'x', type: 'delete', blockId: 'b3', before: '三', time: '12:01' }];
  const t2 = renderPrompt(st({ name: 'a.md', kind: 'md' }, base, [blk('b1', '一', 1), blk('b2', '二', 2)], tail), HASHES);
  expect(t2).toContain('type="delete" line="3"');
});

test('行内批注 quote 往返（v1.3）：<quote> 元素保留原文', () => {
  const cur = [blk('b1', '他认为协议比编辑器重要，因此插件只是薄层。', 1)];
  const ops: Op[] = [
    { id: 'o1', type: 'note', blockId: 'b1', note: '这里逻辑跳跃', quote: '协议比编辑器重要', time: '14:02' },
  ];
  const text = renderPrompt(st({ name: 'a.md', kind: 'md' }, cur, cur, ops), HASHES);
  expect(text).toContain('<quote>协议比编辑器重要</quote>');
  const { ops: got } = parsePrompt(text);
  expect(got).toEqual([
    { id: 'B1', type: 'note', blockId: '', note: '这里逻辑跳跃', quote: '协议比编辑器重要', time: '14:02', line: 1 },
  ]);
});

test('pending 0 空结构 round-trip', () => {
  const text = renderPrompt(st({ name: 'a.md', kind: 'md' }, [], [], []), HASHES);
  expect(text).toContain('pending: 0');
  expect(text).toContain('<requests>\n</requests>');
  expect(text).toContain('<edits>\n</edits>');
  const { meta, ops } = parsePrompt(text);
  expect(meta.pending).toBe(0);
  expect(ops).toEqual([]);
});

describe('生命周期（v1.2）：hidden 属性与 C 类墓碑区段', () => {
  const cur = [blk('b1', '旧文', 1), blk('b2', '乙', 3)];
  const ops: Op[] = [
    { id: 'a:b1:replace', type: 'replace', blockId: 'b1', before: '旧文', after: '新文', time: '09:41', state: 'hidden' },
    { id: 'a:b2:delete', type: 'delete', blockId: 'b2', before: '乙', time: '09:42', state: 'withdrawing' }, // 预令按 pending 导出
  ];
  const tombs: Op[] = [
    { id: 'a:b9:replace', type: 'replace', blockId: 'b9', before: '撤前', after: '撤后', time: '09:30', state: 'withdrawn' },
    { id: 'o7', type: 'note', blockId: 'b1', note: '撤掉的批注', time: '09:31', state: 'withdrawn' },
  ];
  const full = renderPrompt(st({ name: 'a.md', kind: 'md' }, cur, cur, ops, tombs), HASHES);

  test('hidden 写 state 属性；withdrawing 不写；墓碑进 <withdrawn> 且重排 C 编号', () => {
    expect(full).toContain('<edit id="A1" type="replace" line="1" time="09:41" state="hidden">');
    expect(full).toContain('<edit id="A2" type="delete" line="4" time="09:42">');
    expect(full).toContain('withdrawn: 2\n');
    expect(full).toContain('<withdrawn>');
    expect(full).toContain('<edit id="C1" type="replace" time="09:30">');
    expect(full).toContain('<request id="C2" line="1" time="09:31">'); // 墓碑批注锚可解析即保留
    expect(parsePrompt(full).ops).toEqual([
      { id: 'A1', type: 'replace', blockId: '', before: '旧文', after: '新文', time: '09:41', line: 1, state: 'hidden' },
      { id: 'A2', type: 'delete', blockId: '', before: '乙', time: '09:42', line: 4 },
      { id: 'C1', type: 'replace', blockId: '', before: '撤前', after: '撤后', time: '09:30', state: 'withdrawn' },
      { id: 'C2', type: 'note', blockId: '', note: '撤掉的批注', time: '09:31', line: 1, state: 'withdrawn' },
    ]);
  });

  test('复制版本（includeWithdrawn:false）省略 C 类，B/A 原样', () => {
    const copy = renderPrompt(st({ name: 'a.md', kind: 'md' }, cur, cur, ops, tombs), HASHES, {
      includeWithdrawn: false,
    });
    expect(copy).not.toContain('<withdrawn>');
    expect(copy).toContain('<edit id="A1" type="replace"');
  });

  test('indentHint 开启时头部带排版要求行（解析器忽略，不伤结构）', () => {
    const t = renderPrompt(st({ name: 'a.md', kind: 'md' }, cur, cur, ops), HASHES, { indentHint: true });
    expect(t).toContain('> 排版要求：正文段落首行缩进两字符（已写入文档本体）。');
    expect(parsePrompt(t).ops.length).toBe(2);
  });
});

test('旧版协议 md2prompt/1（含 kind/updated 字段）向下兼容', () => {
  const legacy = [
    '---',
    'protocol: md2prompt/1',
    'doc: a.md',
    'kind: md',
    'doc-hash: blake3:aa',
    'base-hash: blake3:bb',
    'updated: 2026-07-17T08:00:00+08:00',
    'pending: 1',
    '---',
    '',
    '<requests>',
    '</requests>',
    '',
    '<edits>',
    '<edit id="A1" type="insert" line="1" time="08:30">',
    '<after>新段</after>',
    '</edit>',
    '</edits>',
    '',
  ].join('\n');
  const { meta, ops } = parsePrompt(legacy);
  expect(meta.protocol).toBe('md2prompt/1');
  expect(meta.kind).toBe('md');
  expect(meta.withdrawn).toBe(0);
  expect(ops).toEqual([{ id: 'A1', type: 'insert', blockId: '', after: '新段', time: '08:30', line: 1 }]);
});

test('容忍正文手工文字、CRLF、sha3-256 前缀、front matter 行尾注释', () => {
  const ops: Op[] = [{ id: 'x', type: 'insert', blockId: 'b1', after: '新段', time: '08:30' }];
  const good = renderPrompt(st({ name: 'a.md', kind: 'md' }, [], [blk('b1', '新段', 1)], ops), HASHES);
  const messy = good
    .split('blake3:')
    .join('sha3-256:')
    .replace('doc-hash: sha3-256:9f3ac2aa', 'doc-hash: sha3-256:9f3ac2aa      # 当前文档全文哈希')
    .replace('<requests>', '手工加的一段话，应被忽略。\n\n<requests>')
    .replace('<edits>', '<edits>\n区段内的手工注释')
    .replace('<edit id="A1"', '元素前的手工注\n<edit id="A1"')
    .split('\n')
    .join('\r\n');
  const { meta, ops: got } = parsePrompt(messy);
  expect(meta.docHash.startsWith('sha3-256:')).toBe(true);
  expect(meta.baseHash.startsWith('sha3-256:')).toBe(true);
  expect(got).toEqual([{ id: 'A1', type: 'insert', blockId: '', after: '新段', time: '08:30', line: 1 }]);
});

describe('协议 1.2.0：patch 形 / 稳定编号 / 摘要行', () => {
  const pad = '用于填充长度的中性铺垫句子，反复出现以撑过二百字符门槛。'.repeat(6);
  const before = `第一段不变的铺垫文字，${pad}第三句会被改掉。第四句仍然不变，收尾也一样不动。`;
  const after = `第一段不变的铺垫文字，${pad}第三句已经改过了。第四句仍然不变，收尾也一样不动。`;
  const op: Op = { id: 'a:b7:replace', type: 'replace', blockId: 'b7', before, after, time: '15:00' };

  test('planPatch：配对句级 hunk；小块/非配对不入', async () => {
    const { planPatch } = await import('../src/core/promptmd');
    expect(planPatch(op)).toEqual([{ del: '第三句会被改掉。', ins: '第三句已经改过了。' }]);
    expect(planPatch({ ...op, before: '短块', after: '短块改' })).toBeNull();
    expect(planPatch({ ...op, after: before + '纯追加的句子。' })).toBeNull(); // 纯插入段退全文
  });

  test('planPatch：重复句唯一性守卫（B1）', async () => {
    const { planPatch } = await import('../src/core/promptmd');
    // 块内已有 Y，后句 X 改成 Y：ins 在 after 出现 2 次 → 必须退全文
    const pad = '用于填充长度的中性铺垫句子，反复出现以撑过二百字符门槛。'.repeat(6);
    const b = `相同句在前。${pad}目标旧句甲。结尾句。`;
    const a = `相同句在前。${pad}相同句在前。结尾句。`;
    expect(planPatch({ id: 'x', type: 'replace', blockId: 'b1', before: b, after: a, time: 't' })).toBeNull();
  });

  test('patch 形携带 note（B2）', () => {
    const cur = [blk('b7', after, 1)];
    const noted = { ...op, note: '这句改得好不好' };
    const { hashShort } = require('../src/core/hash') as typeof import('../src/core/hash');
    const text = renderPrompt(st({ name: 'a.md', kind: 'md' }, cur, cur, [noted]), HASHES, {
      patchHashes: new Map([[op.id, hashShort(after)]]),
    });
    expect(text).toContain('form="patch"');
    expect(text).toContain('<note>这句改得好不好</note>');
    const { ops: got } = parsePrompt(text);
    expect(got[0]).toMatchObject({ note: '这句改得好不好', patch: [{ del: '第三句会被改掉。', ins: '第三句已经改过了。' }] });
  });

  test('applyPatch：按序定位应用；定位失败抛错', async () => {
    const { applyPatch } = await import('../src/core/promptmd');
    expect(applyPatch(before, [{ del: '第三句会被改掉。', ins: '第三句已经改过了。' }])).toBe(after);
    expect(() => applyPatch('无关文本', [{ del: '不存在。', ins: 'x' }])).toThrow(/定位/);
  });

  test('patch 形 render → parse 往返：无 before/after 全文，有 after-hash', () => {
    const cur = [blk('b7', after, 1)];
    const { hashShort } = require('../src/core/hash') as typeof import('../src/core/hash');
    const text = renderPrompt(st({ name: 'a.md', kind: 'md' }, cur, cur, [op]), HASHES, {
      patchHashes: new Map([[op.id, hashShort(after)]]),
    });
    expect(text).toContain('form="patch"');
    expect(text).toContain('<del>第三句会被改掉。</del>');
    expect(text).toContain('<ins>第三句已经改过了。</ins>');
    expect(text).toMatch(/<after-hash>blake3:[0-9a-f]{16}<\/after-hash>/);
    expect(text).not.toContain('<before>');
    const { ops: got } = parsePrompt(text);
    expect(got).toEqual([
      {
        id: 'A1',
        type: 'replace',
        blockId: '',
        before: '',
        after: '',
        patch: [{ del: '第三句会被改掉。', ins: '第三句已经改过了。' }],
        afterHash: hashShort(after),
        time: '15:00',
        line: 1,
      },
    ]);
  });

  test('patchHashes 缺该 op 时退回全文形', () => {
    const text = renderPrompt(st({ name: 'a.md', kind: 'md' }, [blk('b7', after, 1)], [blk('b7', after, 1)], [op]), HASHES, {
      patchHashes: new Map(),
    });
    expect(text).not.toContain('form="patch"');
    expect(text).toContain('<before>');
  });

  test('稳定编号：ids 解析器生效；摘要行计数正确', () => {
    const ops: Op[] = [
      { id: 'o3', type: 'note', blockId: 'b1', note: 'n', time: '15:01', seq: 7 },
      { ...op, seq: 3 },
    ];
    const cur = [blk('b1', 'x', 1), blk('b7', after, 3)];
    const text = renderPrompt(st({ name: 'a.md', kind: 'md' }, cur, cur, ops), HASHES, {
      ids: (o) => `${o.type === 'note' ? 'B' : 'A'}${o.seq ?? 0}`,
    });
    expect(text).toContain('<request id="B7"');
    expect(text).toContain('<edit id="A3"');
    expect(text).toContain('> 本次：B 类请求 1 条，A 类直接修改 1 条。');
  });
});

test('insert 墓碑在块已离开 cur 后仍导出原 line 锚点', () => {
  const cur = [blk('a', 'A', 1), blk('b', 'B', 3)];
  const tomb: Op = { id: 'old', type: 'insert', blockId: 'gone', after: 'X', line: 3, time: '12:00', state: 'withdrawn' };
  const text = renderPrompt(st({ name: 'a.md', kind: 'md' }, cur, cur, [], [tomb]), HASHES);
  expect(text).toContain('<edit id="C1" type="insert" line="3" time="12:00">');
  expect(parsePrompt(text).ops).toEqual([
    { id: 'C1', type: 'insert', blockId: '', after: 'X', line: 3, time: '12:00', state: 'withdrawn' },
  ]);
});

test('解析器拒绝计数不符或缺少 requests/edits 固定区段的截断协议', () => {
  const empty = renderPrompt(st({ name: 'a.md', kind: 'md' }, [], [], []), HASHES);
  expect(() => parsePrompt(empty.replace('pending: 0', 'pending: 1'))).toThrow(/pending/);
  expect(() => parsePrompt(empty.replace('<requests>\n</requests>\n', ''))).toThrow(/requests/);
  expect(() => parsePrompt(empty.replace('<edits>\n</edits>\n', ''))).toThrow(/edits/);

  const tomb: Op = { id: 'old', type: 'insert', blockId: 'gone', after: 'X', line: 1, time: '12:00', state: 'withdrawn' };
  const withTomb = renderPrompt(st({ name: 'a.md', kind: 'md' }, [], [], [], [tomb]), HASHES);
  expect(() => parsePrompt(withTomb.replace('withdrawn: 1', 'withdrawn: 2'))).toThrow(/withdrawn/);
});

describe('坏输入：抛带行号的 PromptParseError', () => {
  const FM = 'protocol: md2prompt/1.2.0\ndoc: a.md\ndoc-hash: blake3:aa\nbase-hash: blake3:bb\npending: 0';
  const bad: [string, RegExp][] = [
    ['', /缺少 front matter/],
    ['---\nprotocol: md2prompt/1.2.0\n没有闭合', /未闭合/],
    [`---\n${FM.replace('md2prompt/1.2.0', 'other/9')}\n---\n<requests>\n</requests>\n<edits>\n</edits>\n`, /未知 protocol/],
    [`---\n${FM.replace('md2prompt/1.2.0', 'md2prompt/2.0.0')}\n---\n<requests>\n</requests>\n<edits>\n</edits>\n`, /未知 protocol/],
    [`---\n${FM}\nkind: txt\n---\n<requests>\n</requests>\n<edits>\n</edits>\n`, /未知 kind/],
    [`---\n${FM.replace('doc-hash: blake3:aa', 'doc-hash: md5:aa')}\n---\n<requests>\n</requests>\n<edits>\n</edits>\n`, /blake3/],
    [`---\n${FM.replace('pending: 0', 'pending: x')}\n---\n<requests>\n</requests>\n<edits>\n</edits>\n`, /pending/],
    [`---\n${FM}\n---\n正文没有结构\n`, /requests/],
    [`---\n${FM}\n---\n<edits>\n<edit id="A1" line="1">\n<after>x</after>\n</edit>\n</edits>\n`, /未知 edit type/],
    [
      `---\n${FM}\n---\n<edits>\n<edit id="A1" type="move" to="3" time="13:40">\n<first>x</first>\n</edit>\n</edits>\n`,
      /from/,
    ],
    [`---\n${FM}\n---\n<requests>\n<request id="B1" line="2">\n<first>x</first>\n</request>\n</requests>\n`, /<note>/],
    [
      `---\n${FM}\n---\n<edits>\n<edit id="A1" type="delete" line="2" time="12:00">\n<before>\n\`\`\`\n围栏没合上\n</edits>\n`,
      /围栏未闭合/,
    ],
    [`---\n${FM}\n---\n<edits>\n<edit id="A1" type="insert" line="1" time="1:00">\n<after>x</after>\n`, /未闭合/],
  ];
  for (const [input, re] of bad) {
    test(`拒绝：${re.source}`, () => {
      expect(() => parsePrompt(input)).toThrow(re);
      try {
        parsePrompt(input);
      } catch (e) {
        expect(e).toBeInstanceOf(PromptParseError);
        expect((e as PromptParseError).line).toBeGreaterThan(0);
        expect((e as Error).message).toContain(`第 ${(e as PromptParseError).line} 行`);
        return;
      }
      throw new Error('应当抛错');
    });
  }
});
