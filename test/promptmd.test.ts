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

describe('协议 2.0 示例 round-trip（单流 <changes> 按 n 排）', () => {
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
      seq: 3,
    },
    { id: 'op2', type: 'swap', blockId: 'b5', otherId: 'b9', a: 5, b: 9, firstA: '甲块首行', firstB: '乙块首行', time: '13:40', seq: 5 },
    { id: 'op3', type: 'note', blockId: 'b12', note: '这段逻辑跳跃，请补一个过渡论证', kind: 'request', time: '13:35', seq: 1 },
  ];
  const text = renderPrompt(st({ name: 'report.md', kind: 'md' }, [], cur, ops), HASHES);

  test('render 符合 2.0 冻结格式（front matter + 注释行 + 单流按 n 排）', () => {
    expect(
      text.startsWith(
        '---\nprotocol: md2prompt/2.0.0\ndoc: report.md\ndoc-hash: blake3:9f3ac2aa\nbase-hash: blake3:71be04bb\nchanges: 3\n---\n',
      ),
    ).toBe(true);
    expect(text).toContain('# 修改记录 · report.md');
    expect(text).toContain('revise/swap=人已改完');
    expect(text).toContain('<changes>\n');
    expect(text).not.toContain('<requests>');
    expect(text).not.toContain('<edits>');
    // note 收进属性单行
    expect(text).toContain('<note n="1" lines="12-15" request="这段逻辑跳跃，请补一个过渡论证"></note>');
    // revise 单行压行：original+alter+note
    expect(text).toContain(
      '<revise n="3" line="8"><original>把文件修改的内容完整导出</original><alter>把文件修改的内容连同位置与意图完整导出</alter><note>可选</note></revise>',
    );
    // swap 单行
    expect(text).toContain('<swap n="5" a="5" b="9"><first>甲块首行</first><first>乙块首行</first></swap>');
    // 按 n（修改顺序）排：note(1) → revise(3) → swap(5)，与 ops 输入顺序无关
    const iN = text.indexOf('<note n="1"');
    const iR = text.indexOf('<revise n="3"');
    const iS = text.indexOf('<swap n="5"');
    expect(iN).toBeGreaterThan(-1);
    expect(iR).toBeGreaterThan(iN);
    expect(iS).toBeGreaterThan(iR);
  });

  test('parse 还原 meta 与 ops（n 进 seq、blockId 协议外、kind 缺省 request）', () => {
    const { meta, ops: got } = parsePrompt(text);
    expect(meta).toEqual({
      protocol: 'md2prompt/2.0.0',
      doc: 'report.md',
      kind: 'md',
      docHash: HASHES.docHash,
      baseHash: HASHES.baseHash,
      changes: 3,
      withdrawn: 0,
    });
    expect(got).toEqual([
      { id: 'n1', seq: 1, blockId: '', time: '', type: 'note', note: '这段逻辑跳跃，请补一个过渡论证', kind: 'request', line: 12 },
      {
        id: 'n3',
        seq: 3,
        blockId: '',
        time: '',
        type: 'replace',
        before: '把文件修改的内容完整导出',
        after: '把文件修改的内容连同位置与意图完整导出',
        note: '可选',
        line: 8,
      },
      { id: 'n5', seq: 5, blockId: '', time: '', type: 'swap', a: 5, b: 9, firstA: '甲块首行', firstB: '乙块首行' },
    ]);
  });
});

describe('note 三型与 range', () => {
  const cur = [blk('b1', '他认为协议比编辑器重要，因此插件只是薄层。', 1)];

  test('suggest/discuss 属性形；quote 进 <range>', () => {
    const ops: Op[] = [
      { id: 'o1', type: 'note', blockId: 'b1', note: '此处建议拆分', kind: 'suggest', quote: '协议比编辑器重要', time: '14:02', seq: 1 },
      { id: 'o2', type: 'note', blockId: 'b1', note: '这段想和你讨论', kind: 'discuss', time: '14:03', seq: 2 },
    ];
    const text = renderPrompt(st({ name: 'a.md', kind: 'md' }, cur, cur, ops), HASHES);
    expect(text).toContain('<note n="1" line="1" suggest="此处建议拆分"><range>协议比编辑器重要</range></note>');
    expect(text).toContain('<note n="2" line="1" discuss="这段想和你讨论"></note>');
    expect(parsePrompt(text).ops).toEqual([
      { id: 'n1', seq: 1, blockId: '', time: '', type: 'note', note: '此处建议拆分', kind: 'suggest', quote: '协议比编辑器重要', line: 1 },
      { id: 'n2', seq: 2, blockId: '', time: '', type: 'note', note: '这段想和你讨论', kind: 'discuss', line: 1 },
    ]);
  });

  test('kind 缺省 = request；多行批注走子元素；属性引号转义', () => {
    const ops: Op[] = [
      { id: 'o1', type: 'note', blockId: 'b1', note: '默认类型', time: 't', seq: 1 },
      { id: 'o2', type: 'note', blockId: 'b1', note: '第一行\n第二行', kind: 'suggest', time: 't', seq: 2 },
      { id: 'o3', type: 'note', blockId: 'b1', note: '含 "引号" 与 <尖括号>', time: 't', seq: 3 },
    ];
    const text = renderPrompt(st({ name: 'a.md', kind: 'md' }, cur, cur, ops), HASHES);
    expect(text).toContain('<note n="1" line="1" request="默认类型"></note>');
    expect(text).toContain('<suggest>\n```\n第一行\n第二行\n```\n</suggest>');
    expect(text).toContain('request="含 &quot;引号&quot; 与 &lt;尖括号&gt;"');
    expect(parsePrompt(text).ops).toEqual([
      { id: 'n1', seq: 1, blockId: '', time: '', type: 'note', note: '默认类型', kind: 'request', line: 1 },
      { id: 'n2', seq: 2, blockId: '', time: '', type: 'note', note: '第一行\n第二行', kind: 'suggest', line: 1 },
      { id: 'n3', seq: 3, blockId: '', time: '', type: 'note', note: '含 "引号" 与 <尖括号>', kind: 'request', line: 1 },
    ]);
  });

  test('一条 note 只允许一种类型（属性与子元素互斥）', () => {
    const FM = 'protocol: md2prompt/2.0.0\ndoc: a.md\ndoc-hash: blake3:aa\nbase-hash: blake3:bb\nchanges: 1';
    const bad = `---\n${FM}\n---\n<changes>\n<note n="1" request="x" suggest="y"></note>\n</changes>\n`;
    expect(() => parsePrompt(bad)).toThrow(/只能有一种类型/);
  });
});

test('多行内容与反引号自适应围栏 round-trip', () => {
  const before = '````markdown\n内含 ``` 三反引号\n行尾 `` 双反引号\n````';
  const after = '新第一行\n新第二行';
  const ops: Op[] = [{ id: 'x', type: 'replace', blockId: 'b3', before, after, time: '09:05', note: '多行\n批注', seq: 1 }];
  const text = renderPrompt(st({ name: 'a.md', kind: 'md' }, [blk('b3', before, 3)], [blk('b3', after, 3)], ops), HASHES);
  expect(text).toContain('<revise n="1" lines="3-4">');
  const f5 = '`'.repeat(5); // 内容最长反引号串为 4 → 围栏 5
  expect(text).toContain(`<original>\n${f5}\n${before}\n${f5}\n</original>`);
  const { ops: got } = parsePrompt(text);
  expect(got).toEqual([{ id: 'n1', seq: 1, blockId: '', time: '', type: 'replace', before, after, note: '多行\n批注', line: 3 }]);
});

test('行内特殊字符 XML 转义 round-trip', () => {
  const before = 'a < b & c > d 含 </original> 字样';
  const ops: Op[] = [{ id: 'x', type: 'replace', blockId: 'b1', before, after: 'ok', time: '10:00', seq: 1 }];
  const text = renderPrompt(st({ name: 'a.md', kind: 'md' }, [blk('b1', before, 1)], [blk('b1', 'ok', 1)], ops), HASHES);
  expect(text).toContain('<original>a &lt; b &amp; c &gt; d 含 &lt;/original&gt; 字样</original>');
  expect(parsePrompt(text).ops).toEqual([{ id: 'n1', seq: 1, blockId: '', time: '', type: 'replace', before, after: 'ok', line: 1 }]);
});

test('JSONL 记录 original/alter 一律 ```json 围栏；kind 由扩展名推断', () => {
  const rec = '{"text":"你好","label":1}';
  const ops: Op[] = [
    { id: 'x', type: 'replace', blockId: 'b2', before: rec, after: '{"text":"改后","label":2}', time: '11:11', seq: 1 },
    { id: 'y', type: 'insert', blockId: 'b3', after: '{"text":"新增"}', time: '11:12', seq: 2 },
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
  expect(text).toContain(`<original>\n\`\`\`json\n${rec}\n\`\`\`\n</original>`);
  const { meta, ops: got } = parsePrompt(text);
  expect(meta.kind).toBe('jsonl'); // front matter 无 kind 行，从 d.jsonl 推断
  expect(got).toEqual([
    { id: 'n1', seq: 1, blockId: '', time: '', type: 'replace', before: rec, after: '{"text":"改后","label":2}', line: 2 },
    { id: 'n2', seq: 2, blockId: '', time: '', type: 'insert', after: '{"text":"新增"}', line: 3 },
  ]);
});

test('delete 锚点 = 插入点行号（下一个幸存块起始行；文末为末行+1）；insert 无 original', () => {
  const base = [blk('b1', '一', 1), blk('b2', '二', 2), blk('b3', '三', 3)];
  const mid: Op[] = [{ id: 'x', type: 'delete', blockId: 'b2', before: '二', time: '12:00', seq: 1 }];
  const t1 = renderPrompt(st({ name: 'a.md', kind: 'md' }, base, [blk('b1', '一', 1), blk('b3', '三', 2)], mid), HASHES);
  expect(t1).toContain('<revise n="1" line="2"><original>二</original></revise>');
  expect(parsePrompt(t1).ops).toEqual([{ id: 'n1', seq: 1, blockId: '', time: '', type: 'delete', before: '二', line: 2 }]);
  const tail: Op[] = [{ id: 'x', type: 'delete', blockId: 'b3', before: '三', time: '12:01', seq: 1 }];
  const t2 = renderPrompt(st({ name: 'a.md', kind: 'md' }, base, [blk('b1', '一', 1), blk('b2', '二', 2)], tail), HASHES);
  expect(t2).toContain('<revise n="1" line="3">');
  const ins: Op[] = [{ id: 'y', type: 'insert', blockId: 'b4', after: '新段', time: '12:02', seq: 1 }];
  const t3 = renderPrompt(st({ name: 'a.md', kind: 'md' }, base, [...base, blk('b4', '新段', 4)], ins), HASHES);
  expect(t3).toContain('<revise n="1" line="4"><alter>新段</alter></revise>');
});

test('changes: 0 空结构 round-trip', () => {
  const text = renderPrompt(st({ name: 'a.md', kind: 'md' }, [], [], []), HASHES);
  expect(text).toContain('changes: 0');
  expect(text).toContain('<changes>\n</changes>');
  expect(text).not.toContain('withdrawn:');
  const { meta, ops } = parsePrompt(text);
  expect(meta.changes).toBe(0);
  expect(ops).toEqual([]);
});

describe('生命周期：hidden 属性与墓碑区段', () => {
  const cur = [blk('b1', '旧文', 1), blk('b2', '乙', 3)];
  const ops: Op[] = [
    { id: 'a:b1:replace', type: 'replace', blockId: 'b1', before: '旧文', after: '新文', time: '09:41', state: 'hidden', seq: 1 },
    { id: 'a:b2:delete', type: 'delete', blockId: 'b2', before: '乙', time: '09:42', state: 'withdrawing', seq: 2 }, // 预令按 pending 导出
  ];
  const tombs: Op[] = [
    { id: 'a:b9:replace', type: 'replace', blockId: 'b9', before: '撤前', after: '撤后', time: '09:30', state: 'withdrawn', seq: 0 },
    { id: 'o7', type: 'note', blockId: 'b1', note: '撤掉的批注', kind: 'discuss', time: '09:31', state: 'withdrawn', seq: 4 },
  ];
  const full = renderPrompt(st({ name: 'a.md', kind: 'md' }, cur, cur, ops, tombs), HASHES);

  test('hidden 写 state 属性；withdrawing 不写；墓碑进 <withdrawn> 同形元素', () => {
    expect(full).toContain('<revise n="1" line="1" state="hidden"><original>旧文</original><alter>新文</alter></revise>');
    expect(full).toContain('<revise n="2" line="4"><original>乙</original></revise>');
    expect(full).toContain('withdrawn: 2\n');
    expect(full).toContain('<withdrawn>');
    expect(full).toContain('<revise n="0"><original>撤前</original><alter>撤后</alter></revise>');
    expect(full).toContain('<note n="4" line="1" discuss="撤掉的批注"></note>');
    expect(parsePrompt(full).ops).toEqual([
      { id: 'n1', seq: 1, blockId: '', time: '', type: 'replace', before: '旧文', after: '新文', line: 1, state: 'hidden' },
      { id: 'n2', seq: 2, blockId: '', time: '', type: 'delete', before: '乙', line: 4 },
      { id: 'n0', seq: 0, blockId: '', time: '', type: 'replace', before: '撤前', after: '撤后', state: 'withdrawn' },
      { id: 'n4', seq: 4, blockId: '', time: '', type: 'note', note: '撤掉的批注', kind: 'discuss', line: 1, state: 'withdrawn' },
    ]);
  });

  test('复制版本（includeWithdrawn:false）省略 <withdrawn> 区段与 withdrawn 计数行', () => {
    const copy = renderPrompt(st({ name: 'a.md', kind: 'md' }, cur, cur, ops, tombs), HASHES, {
      includeWithdrawn: false,
    });
    expect(copy).not.toContain('<withdrawn>');
    expect(copy).not.toContain('withdrawn:');
    expect(copy).toContain('<revise n="1"');
  });

  test('formats 排版命令：有才发行（解析器忽略，不伤结构）', () => {
    const withFmt = renderPrompt(st({ name: 'a.md', kind: 'md' }, cur, cur, ops), HASHES, { formats: ['中文首行缩进两字符'] });
    expect(withFmt).toContain('<format>中文首行缩进两字符</format>');
    expect(parsePrompt(withFmt).ops.length).toBe(2);
    const noFmt = renderPrompt(st({ name: 'a.md', kind: 'md' }, cur, cur, ops), HASHES, { formats: [] });
    expect(noFmt).not.toContain('<format>');
  });
});

test('旧版协议 md2prompt/1.x 一律拒绝（2.0 无旧版兼容）', () => {
  const legacy = [
    '---',
    'protocol: md2prompt/1.2.0',
    'doc: a.md',
    'doc-hash: blake3:aa',
    'base-hash: blake3:bb',
    'pending: 0',
    '---',
    '',
    '<requests>',
    '</requests>',
    '',
    '<edits>',
    '</edits>',
    '',
  ].join('\n');
  expect(() => parsePrompt(legacy)).toThrow(/未知 protocol/);
  expect(() => parsePrompt(legacy.replace('md2prompt/1.2.0', 'md2prompt/1'))).toThrow(/未知 protocol/);
});

test('容忍正文手工文字、注释、format、CRLF、sha3-256 前缀、front matter 行尾注释', () => {
  const ops: Op[] = [{ id: 'x', type: 'insert', blockId: 'b1', after: '新段', time: '08:30', seq: 1 }];
  const good = renderPrompt(st({ name: 'a.md', kind: 'md' }, [], [blk('b1', '新段', 1)], ops), HASHES, {
    formats: ['中文首行缩进两字符'],
  });
  const messy = good
    .split('blake3:')
    .join('sha3-256:')
    .replace('doc-hash: sha3-256:9f3ac2aa', 'doc-hash: sha3-256:9f3ac2aa      # 当前文档全文哈希')
    .replace('<changes>', '手工加的一段话，应被忽略。\n\n<changes>\n区段内的手工注释')
    .replace('<revise n="1"', '元素前的手工注\n<revise n="1"')
    .split('\n')
    .join('\r\n');
  const { meta, ops: got } = parsePrompt(messy);
  expect(meta.docHash.startsWith('sha3-256:')).toBe(true);
  expect(meta.baseHash.startsWith('sha3-256:')).toBe(true);
  expect(got).toEqual([{ id: 'n1', seq: 1, blockId: '', time: '', type: 'insert', after: '新段', line: 1 }]);
});

describe('patch 形 / alter-hash', () => {
  const pad = '用于填充长度的中性铺垫句子，反复出现以撑过二百字符门槛。'.repeat(6);
  const before = `第一段不变的铺垫文字，${pad}第三句会被改掉。第四句仍然不变，收尾也一样不动。`;
  const after = `第一段不变的铺垫文字，${pad}第三句已经改过了。第四句仍然不变，收尾也一样不动。`;
  const op: Op = { id: 'a:b7:replace', type: 'replace', blockId: 'b7', before, after, time: '15:00', seq: 1 };

  test('planPatch：配对句级 hunk；小块/非配对不入', async () => {
    const { planPatch } = await import('../src/core/promptmd');
    expect(planPatch(op)).toEqual([{ del: '第三句会被改掉。', ins: '第三句已经改过了。' }]);
    expect(planPatch({ ...op, before: '短块', after: '短块改' })).toBeNull();
    expect(planPatch({ ...op, after: before + '纯追加的句子。' })).toBeNull(); // 纯插入段退全文
  });

  test('planPatch：重复句唯一性守卫（B1）', async () => {
    const { planPatch } = await import('../src/core/promptmd');
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

  test('patch 形 render → parse 往返：无 original/alter 全文，有 alter-hash', () => {
    const cur = [blk('b7', after, 1)];
    const { hashShort } = require('../src/core/hash') as typeof import('../src/core/hash');
    const text = renderPrompt(st({ name: 'a.md', kind: 'md' }, cur, cur, [op]), HASHES, {
      patchHashes: new Map([[op.id, hashShort(after)]]),
    });
    expect(text).toContain('form="patch"');
    expect(text).toContain('<del>第三句会被改掉。</del><ins>第三句已经改过了。</ins>');
    expect(text).toMatch(/<alter-hash>blake3:[0-9a-f]{16}<\/alter-hash>/);
    expect(text).not.toContain('<original>');
    expect(parsePrompt(text).ops).toEqual([
      {
        id: 'n1',
        seq: 1,
        blockId: '',
        time: '',
        type: 'replace',
        before: '',
        after: '',
        patch: [{ del: '第三句会被改掉。', ins: '第三句已经改过了。' }],
        afterHash: hashShort(after),
        line: 1,
      },
    ]);
  });

  test('patchHashes 缺该 op 时退回全文形', () => {
    const text = renderPrompt(st({ name: 'a.md', kind: 'md' }, [blk('b7', after, 1)], [blk('b7', after, 1)], [op]), HASHES, {
      patchHashes: new Map(),
    });
    expect(text).not.toContain('form="patch"');
    expect(text).toContain('<original>');
  });
});

test('insert 墓碑在块已离开 cur 后仍导出原 line 锚点', () => {
  const cur = [blk('a', 'A', 1), blk('b', 'B', 3)];
  const tomb: Op = { id: 'old', type: 'insert', blockId: 'gone', after: 'X', line: 3, time: '12:00', state: 'withdrawn', seq: 2 };
  const text = renderPrompt(st({ name: 'a.md', kind: 'md' }, cur, cur, [], [tomb]), HASHES);
  expect(text).toContain('<revise n="2" line="3"><alter>X</alter></revise>');
  expect(parsePrompt(text).ops).toEqual([
    { id: 'n2', seq: 2, blockId: '', time: '', type: 'insert', after: 'X', line: 3, state: 'withdrawn' },
  ]);
});

test('解析器拒绝计数不符、重复区段或缺少 <changes> 的截断协议', () => {
  const empty = renderPrompt(st({ name: 'a.md', kind: 'md' }, [], [], []), HASHES);
  expect(() => parsePrompt(empty.replace('changes: 0', 'changes: 1'))).toThrow(/changes/);
  expect(() => parsePrompt(empty.replace('<changes>\n</changes>\n', ''))).toThrow(/changes/);
  expect(() => parsePrompt(empty.replace('</changes>', '</changes>\n<changes>\n</changes>'))).toThrow(/重复 <changes>/);

  const tomb: Op = { id: 'old', type: 'insert', blockId: 'gone', after: 'X', line: 1, time: '12:00', state: 'withdrawn', seq: 1 };
  const withTomb = renderPrompt(st({ name: 'a.md', kind: 'md' }, [], [], [], [tomb]), HASHES);
  expect(() => parsePrompt(withTomb.replace('withdrawn: 1', 'withdrawn: 2'))).toThrow(/withdrawn/);
  expect(() => parsePrompt(withTomb.replace('</withdrawn>', '</withdrawn>\n<withdrawn>\n</withdrawn>'))).toThrow(/重复 <withdrawn>/);
});

describe('坏输入：抛带行号的 PromptParseError', () => {
  const FM = 'protocol: md2prompt/2.0.0\ndoc: a.md\ndoc-hash: blake3:aa\nbase-hash: blake3:bb\nchanges: 0';
  const BODY = '<changes>\n</changes>\n';
  const bad: [string, RegExp][] = [
    ['', /缺少 front matter/],
    ['---\nprotocol: md2prompt/2.0.0\n没有闭合', /未闭合/],
    [`---\n${FM.replace('md2prompt/2.0.0', 'other/9')}\n---\n${BODY}`, /未知 protocol/],
    [`---\n${FM.replace('md2prompt/2.0.0', 'md2prompt/3.0.0')}\n---\n${BODY}`, /未知 protocol/],
    [`---\n${FM}\nkind: txt\n---\n${BODY}`, /未知 kind/],
    [`---\n${FM.replace('doc-hash: blake3:aa', 'doc-hash: md5:aa')}\n---\n${BODY}`, /blake3/],
    [`---\n${FM.replace('changes: 0', 'changes: x')}\n---\n${BODY}`, /changes/],
    [`---\n${FM}\n---\n正文没有结构\n`, /changes/],
    [`---\n${FM}\n---\n<changes>\n<note line="2" request="x"></note>\n</changes>\n`, /合法 n 属性/],
    [`---\n${FM}\n---\n<changes>\n<note n="1" line="2">\n</note>\n</changes>\n`, /request\/suggest\/discuss/],
    [`---\n${FM}\n---\n<changes>\n<revise n="1" line="1">\n</revise>\n</changes>\n`, /original\/alter 至少其一/],
    [`---\n${FM}\n---\n<changes>\n<revise n="1" line="1" form="patch">\n<del>x</del>\n<del>y</del>\n</revise>\n</changes>\n`, /严格交替/],
    [`---\n${FM}\n---\n<changes>\n<swap n="1" a="5" b="2">\n<first>x</first>\n<first>y</first>\n</swap>\n</changes>\n`, /a < b/],
    [`---\n${FM}\n---\n<changes>\n<swap n="1" a="2" b="5">\n<first>x</first>\n</swap>\n</changes>\n`, /两个 <first>/],
    [
      `---\n${FM}\n---\n<changes>\n<revise n="1" line="2">\n<original>\n\`\`\`\n围栏没合上\n</changes>\n`,
      /围栏未闭合/,
    ],
    [`---\n${FM}\n---\n<changes>\n<revise n="1" line="1">\n<alter>x</alter>\n`, /未闭合/],
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
