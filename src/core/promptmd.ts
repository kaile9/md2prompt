import type { DocState, Op } from './ir';
import { sentDiff } from './diffview';

/** §3 front matter 需要的两个哈希；pending/withdrawn 由 render 内部生成。 */
export interface PromptHashes {
  docHash: string; // blake3:… 或 sha3-256:…
  baseHash: string;
}

/** v1.1.0：kind/updated 移出协议（kind 由扩展名推断，文档级时间被 op.time 覆盖）。
 *  版本策略（SPEC §3 规则 6）：major 相同即向下兼容；读取容忍旧字段，写出只写当前版本。 */
export interface PromptMeta {
  protocol: string; // 'md2prompt/1.1.0'
  doc: string;
  kind: DocState['file']['kind'];
  docHash: string;
  baseHash: string;
  pending: number;
  withdrawn: number;
}

/** 解析失败抛出，message 含 1-based 行号。 */
export class PromptParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`Prompt.md 第 ${line} 行：${message}`);
    this.name = 'PromptParseError';
  }
}

const PROTOCOL = 'md2prompt/1.2.0';
/** 兼容承诺：major=1 全部可读（含旧版裸 'md2prompt/1'）；major 不符拒绝。 */
const PROTOCOL_OK = /^md2prompt\/1(?:\.\d+\.\d+)?$/;
const KINDS = new Set(['md', 'jsonl', 'xml']);
const kindOf = (doc: string): PromptMeta['kind'] =>
  /\.(jsonl|ndjson)$/i.test(doc) ? 'jsonl' : /\.xml$/i.test(doc) ? 'xml' : 'md';

// 行内内容做 XML 转义；围栏内保持原文（围栏长度自适应，内容不可能撞闭合）。
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s: string): string => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

/** 自适应围栏：反引号数 > 内容中最长反引号串，至少 3。 */
function fenceFor(text: string): string {
  let max = 0;
  for (const m of text.matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return '`'.repeat(Math.max(3, max + 1));
}

/** time 归一化为本地 HH:MM：HH:MM 原样；ISO 等 Date 可解析者转本地；其余原样（SPEC §3 规则 3 防御）。 */
function hm(t: string): string {
  if (/^\d{1,2}:\d{2}$/.test(t)) return t;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 写 <tag> 内容元素：单行内联；多行进围栏；JSONL 记录的 before/after 一律 ```json 围栏。 */
function pushContent(out: string[], tag: string, text: string, json: boolean): void {
  if (!json && !text.includes('\n')) {
    out.push(`<${tag}>${esc(text)}</${tag}>`);
    return;
  }
  const fence = fenceFor(text);
  out.push(`<${tag}>`, fence + (json ? 'json' : ''), text, fence, `</${tag}>`);
}

export interface RenderOpts {
  /** false = 复制给 Agent 的版本：省略 C 类墓碑区段（默认 true，日记文件保留墓碑）。 */
  includeWithdrawn?: boolean;
  /** 「首行缩进·写入文档」开启时向 Agent 声明排版要求（自然语言，v1.2）。 */
  indentHint?: boolean;
  /** 导出 id 解析器（v1.3 稳定编号：op 诞生序号 → 跨导出不变 → Agent 端缓存命中）。 */
  ids?: (op: Op) => string;
  /** patch 形 replace 的 after-hash 表（op.id → hashShort(after)）；有表且够省才换形。 */
  patchHashes?: Map<string, string>;
}

/** patch 形判定（v1.3）：块 >200 字符、全部改动为「整句换整句」配对、patch 体量 ≤ 全文 60%（省 ≥40%）。
 *  纯插入/纯删除段不入 patch（定位不可靠），JSONL 记录永远全文形（原子单位）。
 *  锚点唯一性守卫：任一 hunk 的 del 在 before 或 ins 在 after 出现 >1 次即退全文
 *  （重复句会锚错——恢复静默重建错误 base，评审 B1）。 */
export function planPatch(op: Extract<Op, { type: 'replace' }>): { del: string; ins: string }[] | null {
  if (op.before.length <= 200) return null;
  const segs = sentDiff(op.before, op.after);
  const hunks: { del: string; ins: string }[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.type === 'same') continue;
    if (s.type !== 'del') return null;
    const next = segs[i + 1];
    if (!next || next.type !== 'ins') return null;
    hunks.push({ del: s.text, ins: next.text });
    i++;
  }
  if (!hunks.length) return null;
  const patchBytes = hunks.reduce((n, h) => n + h.del.length + h.ins.length, 0);
  if (patchBytes * 5 > (op.before.length + op.after.length) * 3) return null;
  const once = (hay: string, needle: string): boolean => hay.split(needle).length === 2;
  return hunks.every((h) => once(op.before, h.del) && once(op.after, h.ins)) ? hunks : null;
}

/** patch 应用（恢复侧）：按序在 blockText 中定位每段 del 并换成 ins；任一 del 找不到即抛错。 */
export function applyPatch(blockText: string, hunks: { del: string; ins: string }[]): string {
  let out = '';
  let cursor = 0;
  for (const h of hunks) {
    const idx = blockText.indexOf(h.del, cursor);
    if (idx < 0) throw new Error(`applyPatch: 找不到定位句「${h.del.slice(0, 20)}…」`);
    out += blockText.slice(cursor, idx) + h.ins;
    cursor = idx + h.del.length;
  }
  return out + blockText.slice(cursor);
}

export function renderPrompt(state: DocState, hashes: PromptHashes, opts: RenderOpts = {}): string {
  const json = state.file.kind === 'jsonl';
  const curById = new Map(state.cur.map((b) => [b.id, b]));
  const baseIdx = new Map(state.base.map((b, i) => [b.id, i]));
  const withdrawn = (state.withdrawn ?? []).filter((o) => o.state === 'withdrawn');

  const lineAttr = (blockId: string): string => {
    const b = curById.get(blockId);
    if (!b) return ''; // 陈旧 op：降级为无锚点，内容仍保留
    return b.lineStart === b.lineEnd ? ` line="${b.lineStart}"` : ` lines="${b.lineStart}-${b.lineEnd}"`;
  };

  // 删除锚点 = 插入点行号：下一个幸存块的起始行；删在文末则为全文末行 +1（恢复时越出全文即落文末）。
  const delLine = (blockId: string): number | undefined => {
    const i = baseIdx.get(blockId);
    if (i === undefined) return undefined;
    for (let k = i + 1; k < state.base.length; k++) {
      const b = curById.get(state.base[k].id);
      if (b) return b.lineStart;
    }
    return state.cur.length ? state.cur[state.cur.length - 1].lineEnd + 1 : 1;
  };

  /** 单条 op → 元素行组。id 由调用方给（活跃 B/A 或墓碑 C）。withdrawing 按 pending 导出（预令不落盘）。 */
  const element = (op: Op, id: string): string[] => {
    const st = op.state === 'hidden' ? ' state="hidden"' : '';
    if (op.type === 'note') {
      const out = [`<request id="${id}"${lineAttr(op.blockId)} time="${hm(op.time)}"${st}>`];
      const b = curById.get(op.blockId);
      if (b) {
        const nl = b.text.indexOf('\n');
        out.push(`<first>${esc(nl < 0 ? b.text : b.text.slice(0, nl))}</first>`);
        if (nl >= 0) out.push(`<last>${esc(b.text.slice(b.text.lastIndexOf('\n') + 1))}</last>`);
      }
      if (op.quote) pushContent(out, 'quote', op.quote, false); // v1.3 行内选段原文
      pushContent(out, 'note', op.note, false);
      out.push('</request>');
      return out;
    }
    const out: string[] = [];
    if (op.type === 'move') {
      out.push(`<edit id="${id}" type="move" from="${op.from[0]}-${op.from[1]}" to="${op.to}" time="${hm(op.time)}"${st}>`);
      out.push(`<first>${esc(op.first)}</first>`);
    } else {
      let anchor = lineAttr(op.blockId);
      if (!anchor && op.line !== undefined) anchor = ` line="${op.line}"`;
      if (op.type === 'delete') {
        const l = delLine(op.blockId) ?? op.line;
        anchor = l === undefined ? '' : ` line="${l}"`;
      }
      // patch 形（v1.3）：够省且调用方给了 after-hash 才换形
      const hunks = op.type === 'replace' && !json && opts.patchHashes ? planPatch(op) : null;
      const ah = hunks ? opts.patchHashes?.get(op.id) : undefined;
      if (op.type === 'replace' && hunks && ah) {
        out.push(`<edit id="${id}" type="replace"${anchor} time="${hm(op.time)}" form="patch"${st}>`);
        for (const h of hunks) {
          pushContent(out, 'del', h.del, false);
          pushContent(out, 'ins', h.ins, false);
        }
        out.push(`<after-hash>${ah}</after-hash>`);
        if (op.note) pushContent(out, 'note', op.note, false); // patch 形同样携带批注（评审 B2）
        out.push('</edit>');
        return out;
      }
      out.push(`<edit id="${id}" type="${op.type}"${anchor} time="${hm(op.time)}"${st}>`);
      if (op.type !== 'insert') pushContent(out, 'before', op.before, json);
      if (op.type !== 'delete') pushContent(out, 'after', op.after, json);
    }
    if (op.note) pushContent(out, 'note', op.note, false);
    out.push('</edit>');
    return out;
  };

  const requests: string[] = [];
  const edits: string[] = [];
  let bn = 0;
  let an = 0;
  let cntB = 0;
  let cntA = 0;
  for (const op of state.ops) {
    const given = opts.ids?.(op);
    if (op.type === 'note') {
      cntB++;
      requests.push(...element(op, given ?? `B${++bn}`));
    } else {
      cntA++;
      edits.push(...element(op, given ?? `A${++an}`));
    }
  }
  const cLines: string[] = [];
  let cn = 0;
  for (const op of withdrawn) cLines.push(...element({ ...op, state: undefined }, `C${++cn}`));

  const head = [
    '# 修改记录 · ' + state.file.name,
    '> 由 2youg1的MD2Prompt 生成。B 类 = 请求 Agent 修改；A 类 = 人已直接修改。行号基于当前文档。',
    `> 本次：B 类请求 ${cntB} 条，A 类直接修改 ${cntA} 条${opts.includeWithdrawn !== false && withdrawn.length ? `，C 类墓碑 ${withdrawn.length} 条（无需执行）` : ''}。`,
  ];
  if (opts.indentHint) head.push('> 排版要求：正文段落首行缩进两字符（已写入文档本体）。');
  const tail: string[] = [];
  if (opts.includeWithdrawn !== false && cLines.length) {
    tail.push('---', '', '> C 类 = 已撤回的修改（墓碑记录，无需执行；复制 Prompt 时自动省略）。', '', '<withdrawn>', ...cLines, '</withdrawn>', '');
  }

  return [
    '---',
    `protocol: ${PROTOCOL}`,
    `doc: ${state.file.name}`,
    `doc-hash: ${hashes.docHash}`,
    `base-hash: ${hashes.baseHash}`,
    `pending: ${state.ops.length}`,
    // 复制版省略 C 类时该行一并省略（计数与内容不自相矛盾）
    ...(opts.includeWithdrawn !== false ? [`withdrawn: ${withdrawn.length}`] : []),
    '---',
    '',
    ...head,
    '',
    '<requests>',
    ...requests,
    '</requests>',
    '',
    '---',
    '',
    '<edits>',
    ...edits,
    '</edits>',
    '',
    ...tail,
  ].join('\n');
}

/** 只认 front matter + <requests>/<edits>/<withdrawn>；正文其余文字忽略，容忍手工加注。 */
export function parsePrompt(text: string): { meta: PromptMeta; ops: Op[] } {
  const lines = text
    .replace(/^﻿/, '')
    .split('\n')
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  let i = 0;
  const fail = (msg: string, line = i + 1): never => {
    throw new PromptParseError(msg, line);
  };

  // ---- front matter ----
  while (i < lines.length && !lines[i].trim()) i += 1;
  if (lines[i]?.trim() !== '---') fail('缺少 front matter（首行应为 ---）', i + 1);
  const kv = new Map<string, { v: string; line: number }>();
  i += 1;
  let closed = false;
  for (; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === '---') {
      closed = true;
      break;
    }
    const m = /^([\w-]+):\s*(.*)$/.exec(l);
    if (!m) continue; // 容忍注释/杂行
    // 机器字段剥离行尾注释（SPEC 示例含之）；doc 是文件名，原样保留
    const v = m[1] === 'doc' ? m[2].trim() : m[2].replace(/\s+#.*$/, '').trim();
    kv.set(m[1], { v, line: i + 1 });
  }
  if (!closed) fail('front matter 未闭合（缺第二个 ---）');

  const field = (k: string): string => {
    const e = kv.get(k);
    if (!e || !e.v) return fail(`front matter 缺少字段 ${k}`);
    return e.v;
  };
  const protocol = field('protocol');
  if (!PROTOCOL_OK.test(protocol)) fail(`未知 protocol：${protocol}`, kv.get('protocol')?.line);
  // kind：v1.1.0 起移出协议（扩展名推断）；旧文件仍携带则校验后采用
  const kindRaw = kv.get('kind')?.v;
  if (kindRaw !== undefined && !KINDS.has(kindRaw)) fail(`未知 kind：${kindRaw}`, kv.get('kind')?.line);
  const docHash = field('doc-hash');
  const baseHash = field('base-hash');
  for (const [k, h] of [
    ['doc-hash', docHash],
    ['base-hash', baseHash],
  ] as const) {
    if (!/^(blake3|sha3-256):\S+$/.test(h)) fail(`${k} 须带 blake3:/sha3-256: 前缀：${h}`, kv.get(k)?.line);
  }
  const pending = Number(field('pending'));
  if (!Number.isInteger(pending) || pending < 0) fail(`pending 应为非负整数：${kv.get('pending')?.v}`, kv.get('pending')?.line);
  const wdRaw = kv.get('withdrawn')?.v;
  const withdrawn = wdRaw === undefined ? 0 : Number(wdRaw);
  if (!Number.isInteger(withdrawn) || withdrawn < 0) fail(`withdrawn 应为非负整数：${wdRaw}`, kv.get('withdrawn')?.line);

  const doc = field('doc');
  const meta: PromptMeta = {
    protocol,
    doc,
    kind: (kindRaw as PromptMeta['kind'] | undefined) ?? kindOf(doc),
    docHash,
    baseHash,
    pending,
    withdrawn,
  };

  // ---- <requests>/<edits>/<withdrawn> ----
  const attrs = (s: string): Map<string, string> => {
    const m = new Map<string, string>();
    for (const a of s.matchAll(/([\w-]+)="([^"]*)"/g)) m.set(a[1], a[2]);
    return m;
  };

  /** 读 <tag> 内容元素（lines[i] 为其首行）：单行内联或 <tag>+自适应围栏块；推进 i 过 </tag>。 */
  const content = (tag: string): string => {
    const start = i + 1;
    const inline = new RegExp(`^<${tag}>(.*)</${tag}>\\s*$`).exec(lines[i]);
    if (inline) {
      i += 1;
      return unesc(inline[1]);
    }
    if (lines[i].trim() !== `<${tag}>`) fail(`期望 <${tag}>`, start);
    i += 1;
    const open = /^(`{3,})[a-z0-9]*\s*$/i.exec(lines[i] ?? '');
    if (!open) return fail(`<${tag}> 的多行内容须放进围栏`, start);
    i += 1;
    const body: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (/^`+\s*$/.test(l) && l.trimEnd().length >= open[1].length) break;
      body.push(l);
      i += 1;
    }
    if (i >= lines.length) fail('围栏未闭合', start);
    i += 1;
    if (lines[i]?.trim() !== `</${tag}>`) fail(`缺少 </${tag}>`);
    i += 1;
    return body.join('\n');
  };

  /** 解析一个 <request>/<edit> 元素（lines[i] 为其标签行），推进 i 过闭合标签。tomb = C 类区段。 */
  const element = (isReq: boolean, tomb: boolean): Op => {
    const start = i + 1;
    const a = attrs(lines[i]);
    const id = a.get('id');
    if (!id) return fail('元素缺少 id 属性', start);
    const time = hm(a.get('time') ?? ''); // §3 规则 3：ISO 宽容归一
    if (time && !/^\d{1,2}:\d{2}$/.test(time)) fail(`time 应为 HH:MM：${time}`, start);
    // SPEC v1.1 裁决 1：line/lines 锚点保留进 op.line，恢复落位的数据源
    const rawLine = a.get('line') ?? a.get('lines')?.split('-')[0];
    const line = rawLine === undefined ? undefined : Number(rawLine);
    if (line !== undefined && (!Number.isInteger(line) || line < 1)) return fail(`line/lines 属性非法：${rawLine}`, start);
    const ln = line === undefined ? {} : { line };
    const st = tomb ? { state: 'withdrawn' as const } : a.get('state') === 'hidden' ? { state: 'hidden' as const } : {};
    const close = isReq ? '</request>' : '</edit>';
    i += 1;
    const child: Record<string, string> = {};
    const dels: string[] = [];
    const inss: string[] = [];
    const seq: string[] = []; // del/ins 出现序：patch 要求严格交替（评审 m5）
    while (i < lines.length && lines[i].trim() !== close) {
      const m = /^<(first|last|note|before|after|quote|del|ins|after-hash)[>\s]/.exec(lines[i]);
      if (m) {
        const v = content(m[1]);
        if (m[1] === 'del') {
          dels.push(v);
          seq.push('del');
        } else if (m[1] === 'ins') {
          inss.push(v);
          seq.push('ins');
        } else child[m[1]] = v;
      } else i += 1; // 容忍元素内手工文字
    }
    if (i >= lines.length) fail(`元素未闭合（缺 ${close}）`, start);
    i += 1;
    const optNote = child.note ? { note: child.note } : {};
    if (isReq) {
      if (child.note === undefined) fail('<request> 缺少 <note>', start);
      const optQuote = child.quote !== undefined ? { quote: child.quote } : {};
      return { id, type: 'note', blockId: '', note: child.note, time, ...ln, ...st, ...optQuote };
    }
    // patch 形（v1.3）：del/ins 成对 + after-hash，before/after 由恢复侧展开
    if (a.get('form') === 'patch') {
      if (a.get('type') !== 'replace') return fail('form="patch" 仅用于 replace', start);
      if (!dels.length || dels.length !== inss.length || seq.some((t, k) => t !== (k % 2 === 0 ? 'del' : 'ins')))
        return fail('patch 需要严格交替的 <del>/<ins> 句对', start);
      const afterHash = child['after-hash'];
      if (!afterHash || !/^blake3:[0-9a-f]{16}$/.test(afterHash)) return fail('patch 缺少合法 <after-hash>', start);
      const patch = dels.map((del, k) => ({ del, ins: inss[k] }));
      return { id, type: 'replace', blockId: '', before: '', after: '', patch, afterHash, time, ...optNote, ...ln, ...st };
    }
    const need = (tag: string): string => {
      const v = child[tag];
      if (v === undefined) fail(`缺少 <${tag}>`, start);
      return v;
    };
    switch (a.get('type')) {
      case 'replace':
        return { id, type: 'replace', blockId: '', before: need('before'), after: need('after'), time, ...optNote, ...ln, ...st };
      case 'insert':
        return { id, type: 'insert', blockId: '', after: need('after'), time, ...optNote, ...ln, ...st };
      case 'delete':
        return { id, type: 'delete', blockId: '', before: need('before'), time, ...optNote, ...ln, ...st };
      case 'move': {
        const from = /^(\d+)-(\d+)$/.exec(a.get('from') ?? '');
        if (!from) return fail('move 需要 from="a-b"', start);
        const to = Number(a.get('to'));
        if (!Number.isInteger(to) || to < 1) fail('move 需要 to="n"', start);
        return { id, type: 'move', blockId: '', first: need('first'), from: [Number(from[1]), Number(from[2])], to, time, ...optNote, ...st };
      }
      default:
        return fail(`未知 edit type：${a.get('type')}`, start);
    }
  };

  const ops: Op[] = [];
  let sawRequests = false;
  let sawEdits = false;
  let sawWithdrawn = false;
  i += 1; // 跳过 front matter 结束 ---
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t !== '<requests>' && t !== '<edits>' && t !== '<withdrawn>') {
      i += 1; // 标题、引言、手工加注一律忽略
      continue;
    }
    const isReq = t === '<requests>';
    const tomb = t === '<withdrawn>';
    if (isReq) {
      if (sawRequests) fail('重复 <requests> 区段');
      sawRequests = true;
    } else if (tomb) {
      if (sawWithdrawn) fail('重复 <withdrawn> 区段');
      sawWithdrawn = true;
    } else {
      if (sawEdits) fail('重复 <edits> 区段');
      sawEdits = true;
    }
    const close = isReq ? '</requests>' : tomb ? '</withdrawn>' : '</edits>';
    i += 1;
    while (i < lines.length && lines[i].trim() !== close) {
      const req = /^<request[\s>]/.test(lines[i]);
      const edt = /^<edit[\s>]/.test(lines[i]);
      // C 类区段同时容纳 request/edit 墓碑；B 区只 request、A 区只 edit
      if (req && (isReq || tomb)) ops.push(element(true, tomb));
      else if (edt && !isReq) ops.push(element(false, tomb));
      else i += 1; // 区段内手工文字忽略
    }
    if (i >= lines.length) fail(`区段未闭合（缺 ${close}）`);
    i += 1;
  }
  if (!sawRequests) fail('缺少 <requests> 区段');
  if (!sawEdits) fail('缺少 <edits> 区段');
  const activeCount = ops.filter((op) => op.state !== 'withdrawn').length;
  const withdrawnCount = ops.length - activeCount;
  if (pending !== activeCount) fail(`pending=${pending} 与实际元素数 ${activeCount} 不符`, kv.get('pending')?.line);
  if (withdrawn !== withdrawnCount)
    fail(`withdrawn=${withdrawn} 与实际墓碑数 ${withdrawnCount} 不符`, kv.get('withdrawn')?.line ?? kv.get('pending')?.line);
  return { meta, ops };
}
