// SPDX-License-Identifier: MPL-2.0
import type { DocState, NoteKind, Op } from './ir';
import { sentDiff } from './diffview';

/** §3 front matter 需要的两个哈希；changes/withdrawn 由 render 内部生成。 */
export interface PromptHashes {
  docHash: string; // blake3:… 或 sha3-256:…
  baseHash: string;
}

/** 协议 2.0：单流 <changes> 按 n（修改顺序）排列；note 三型 request/suggest/discuss；
 *  revise 对应 replace/insert/delete（缺 original=新增，缺 alter=删除）；swap 自逆。
 *  版本策略：只认 md2prompt/2.x（旧 1.x 不兼容，v2.0 起无历史包袱）。 */
export interface PromptMeta {
  protocol: string;
  doc: string;
  kind: DocState['file']['kind'];
  docHash: string;
  baseHash: string;
  changes: number; // 活跃条目数（note+revise+swap，含 hidden）
  withdrawn: number; // 墓碑数（复制版省略此行与 <withdrawn> 区段）
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

const PROTOCOL = 'md2prompt/2.0.0';
const PROTOCOL_OK = /^md2prompt\/2(?:\.\d+\.\d+)?$/;
const KINDS = new Set(['md', 'jsonl', 'xml']);
const NOTE_KINDS = ['request', 'suggest', 'discuss'] as const;
const kindOf = (doc: string): PromptMeta['kind'] =>
  /\.(jsonl|ndjson)$/i.test(doc) ? 'jsonl' : /\.xml$/i.test(doc) ? 'xml' : 'md';

// 元素内容转义 &< >；属性值额外转义引号。围栏内保持原文（围栏长度自适应，内容不可能撞闭合）。
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string): string => esc(s).replace(/"/g, '&quot;');
const unesc = (s: string): string =>
  s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
const unescAttr = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

/** 自适应围栏：反引号数 > 内容中最长反引号串，至少 3。 */
function fenceFor(text: string): string {
  let max = 0;
  for (const m of text.matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return '`'.repeat(Math.max(3, max + 1));
}

/** <tag> 内容元素（单串返回）：单行内联；多行进围栏；JSONL 记录的一律 ```json 围栏。 */
function content(tag: string, text: string, json: boolean): string {
  if (!json && !text.includes('\n')) return `<${tag}>${esc(text)}</${tag}>`;
  const fence = fenceFor(text);
  return [`<${tag}>`, fence + (json ? 'json' : ''), text, fence, `</${tag}>`].join('\n');
}

/** 子元素全部单行时整元素压成一行（省行数；note 直接坐进属性也是这个目的）。 */
const elem = (open: string, children: string[], close: string): string[] =>
  children.every((c) => !c.includes('\n')) ? [`${open}${children.join('')}${close}`] : [open, ...children, close];

export interface RenderOpts {
  /** false = 复制给 Agent 的版本：省略 <withdrawn> 区段与 withdrawn 计数行（默认 true，日记文件保留墓碑）。 */
  includeWithdrawn?: boolean;
  /** 排版命令（一句一条，自然语言；没有就不发行。协议 2.0，未来可多条）。 */
  formats?: string[];
  /** patch 形 replace 的 alter-hash 表（op.id → hashShort(after)）；有表且够省才换形。 */
  patchHashes?: Map<string, string>;
}

/** patch 形判定：块 >200 字符、全部改动为「整句换整句」配对、patch 体量 ≤ 全文 60%（省 ≥40%）。
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

/** 头部注释（唯一一行「教学」，自解释结构代替文档）：语义同位。
 *  前提：原文是 Agent 写的，在其上下文/工作区中原样保留；行号基于当前文档（= 原文应用 revise 后的状态）。 */
const HEAD_COMMENT =
  '<!-- 这是人对文档的修改日记（原文在你上下文中；行号基于当前文档）：revise/swap=人已改完（理解即可）；note=人请你处理（request=照做，suggest=定夺，discuss=讨论）。 -->';

export function renderPrompt(state: DocState, hashes: PromptHashes, opts: RenderOpts = {}): string {
  const json = state.file.kind === 'jsonl';
  const curById = new Map(state.cur.map((b) => [b.id, b]));
  const baseIdx = new Map(state.base.map((b, i) => [b.id, i]));
  const withdrawn = (state.withdrawn ?? []).filter((o) => o.state === 'withdrawn');
  // 导出序 = n（修改顺序）：无 seq 的 op 按输入顺序兜底（maxSeq 之后续号，不撞既有 n；按 id 键控，墓碑展开不丢）
  const nById = new Map<string, number>();
  {
    const all = [...state.ops, ...withdrawn];
    const maxSeq = all.reduce((m, o) => Math.max(m, o.seq ?? 0), 0);
    let auto = 0;
    for (const o of all) nById.set(o.id, o.seq ?? maxSeq + ++auto);
  }
  const nOf = (op: Op): number => op.seq ?? nById.get(op.id) ?? 0;

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

  /** 单条 op → 元素行组。withdrawing 按 pending 导出（预令不落盘）。 */
  const element = (op: Op): string[] => {
    const n = nOf(op);
    const st = op.state === 'hidden' ? ' state="hidden"' : '';
    if (op.type === 'note') {
      const kind: NoteKind = op.kind ?? 'request';
      const b = curById.get(op.blockId);
      const anchor = b
        ? b.lineStart === b.lineEnd
          ? ` line="${b.lineStart}"`
          : ` lines="${b.lineStart}-${b.lineEnd}"`
        : op.line !== undefined
          ? ` line="${op.line}"`
          : '';
      const single = !op.note.includes('\n');
      const open = `<note n="${n}"${anchor}${single ? ` ${kind}="${escAttr(op.note)}"` : ''}${st}>`;
      const children: string[] = [];
      if (!single) children.push(content(kind, op.note, false));
      if (op.quote) children.push(content('range', op.quote, false)); // 行内选段原文；块级 note 靠行号锚（原文在 Agent 上下文中）
      return elem(open, children, '</note>');
    }
    if (op.type === 'swap') {
      const a = curById.get(op.blockId)?.lineStart ?? op.a;
      const b = (op.otherId ? curById.get(op.otherId)?.lineStart : undefined) ?? op.b;
      return [`<swap n="${n}" a="${a}" b="${b}"${st}><first>${esc(op.firstA)}</first><first>${esc(op.firstB)}</first></swap>`];
    }
    // revise：replace/insert/delete 的统一外名
    let anchor = lineAttr(op.blockId);
    if (!anchor && op.line !== undefined) anchor = ` line="${op.line}"`;
    if (op.type === 'delete') {
      const l = delLine(op.blockId) ?? op.line;
      anchor = l === undefined ? '' : ` line="${l}"`;
    }
    // patch 形：够省且调用方给了 alter-hash 才换形
    const hunks = op.type === 'replace' && !json && opts.patchHashes?.has(op.id) ? planPatch(op) : null; // has 即 buildPrompt 已判 patch 形；表外 op 不再重算 planPatch（v2.0.2）
    const ah = hunks ? opts.patchHashes?.get(op.id) : undefined;
    if (op.type === 'replace' && hunks && ah) {
      const open = `<revise n="${n}"${anchor} form="patch"${st}>`;
      const children: string[] = [];
      for (const h of hunks) {
        children.push(content('del', h.del, false));
        children.push(content('ins', h.ins, false));
      }
      children.push(`<alter-hash>${ah}</alter-hash>`);
      if (op.note) children.push(content('note', op.note, false));
      return elem(open, children, '</revise>');
    }
    const open = `<revise n="${n}"${anchor}${st}>`;
    const children: string[] = [];
    if (op.type !== 'insert') children.push(content('original', op.before, json));
    if (op.type !== 'delete') children.push(content('alter', op.after, json));
    if (op.note) children.push(content('note', op.note, false));
    return elem(open, children, '</revise>');
  };

  // 单流按 n（修改顺序）排列；墓碑同形殿后
  const active = [...state.ops].sort((x, y) => nOf(x) - nOf(y));
  const tombs = [...withdrawn].sort((x, y) => nOf(x) - nOf(y));
  const changesLines = active.flatMap(element);
  const tombLines = tombs.flatMap((o) => element({ ...o, state: undefined }));

  return [
    '---',
    `protocol: ${PROTOCOL}`,
    `doc: ${state.file.name}`,
    `doc-hash: ${hashes.docHash}`,
    `base-hash: ${hashes.baseHash}`,
    `changes: ${state.ops.length}`,
    // 复制版省略墓碑时该行一并省略；零墓碑也不发行（计数与内容不自相矛盾）
    ...(opts.includeWithdrawn !== false && withdrawn.length ? [`withdrawn: ${withdrawn.length}`] : []),
    '---',
    '',
    `# 修改记录 · ${state.file.name}`,
    HEAD_COMMENT,
    ...(opts.formats ?? []).map((f) => `<format>${esc(f)}</format>`),
    '',
    '<changes>',
    ...changesLines,
    '</changes>',
    '',
    ...(opts.includeWithdrawn !== false && tombLines.length
      ? ['---', '', '<!-- 墓碑：已撤回的修改，仅存档（复制 Prompt 时本区段自动省略）。 -->', '', '<withdrawn>', ...tombLines, '</withdrawn>', '']
      : []),
  ].join('\n');
}

/** 只认 front matter + <changes>/<withdrawn>；正文其余文字（标题、注释、手工加注）忽略。 */
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
    // 机器字段剥离行尾注释；doc 是文件名，原样保留
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
  // kind 不进协议（扩展名推断）；外部生产者仍携带则校验后采用
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
  const changesCount = Number(field('changes'));
  if (!Number.isInteger(changesCount) || changesCount < 0) fail(`changes 应为非负整数：${kv.get('changes')?.v}`, kv.get('changes')?.line);
  const wdRaw = kv.get('withdrawn')?.v;
  const withdrawnCount = wdRaw === undefined ? 0 : Number(wdRaw);
  if (!Number.isInteger(withdrawnCount) || withdrawnCount < 0) fail(`withdrawn 应为非负整数：${wdRaw}`, kv.get('withdrawn')?.line);

  const doc = field('doc');
  const meta: PromptMeta = {
    protocol,
    doc,
    kind: (kindRaw as PromptMeta['kind'] | undefined) ?? kindOf(doc),
    docHash,
    baseHash,
    changes: changesCount,
    withdrawn: withdrawnCount,
  };

  // ---- <changes>/<withdrawn> ----
  const attrs = (s: string): Map<string, string> => {
    const m = new Map<string, string>();
    for (const a of s.matchAll(/([\w-]+)="([^"]*)"/g)) m.set(a[1], a[2]);
    return m;
  };

  /** 读 <tag> 内容元素（lines[i] 为其首行）：单行内联（开标签可带属性）或 <tag>+自适应围栏块；推进 i 过 </tag>。 */
  const contentOf = (tag: string): string => {
    const start = i + 1;
    const inline = new RegExp(`^<${tag}(?:\\s[^>]*)?>(.*)</${tag}>\\s*$`).exec(lines[i]);
    if (inline) {
      i += 1;
      return unesc(inline[1]);
    }
    if (!new RegExp(`^<${tag}(?:\\s[^>]*)?>\\s*$`).test(lines[i].trim())) fail(`期望 <${tag}>`, start);
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

  const CHILD_TAGS = 'first|original|alter|del|ins|alter-hash|note|range|request|suggest|discuss';

  /** 解析一个 <note>/<revise>/<swap> 元素（lines[i] 为其标签行），推进 i 过闭合标签。tomb = 墓碑区段。 */
  const element = (tag: 'note' | 'revise' | 'swap', tomb: boolean): Op => {
    const start = i + 1;
    const a = attrs(lines[i]);
    const n = Number(a.get('n'));
    if (!Number.isInteger(n) || n < 0) return fail('元素缺少合法 n 属性', start);
    const rawLine = a.get('line') ?? a.get('lines')?.split('-')[0];
    const line = rawLine === undefined ? undefined : Number(rawLine);
    if (line !== undefined && (!Number.isInteger(line) || line < 1)) return fail(`line/lines 属性非法：${rawLine}`, start);
    const ln = line === undefined ? {} : { line };
    const st = tomb ? { state: 'withdrawn' as const } : a.get('state') === 'hidden' ? { state: 'hidden' as const } : {};
    const close = `</${tag}>`;
    const child: Record<string, string> = {};
    const dels: string[] = [];
    const inss: string[] = [];
    const seqs: string[] = []; // del/ins 出现序：patch 要求严格交替
    const firsts: string[] = [];
    let range: string | undefined;
    const addChild = (t: string, v: string): void => {
      if (t === 'del') {
        dels.push(v);
        seqs.push('del');
      } else if (t === 'ins') {
        inss.push(v);
        seqs.push('ins');
      } else if (t === 'first') firsts.push(v);
      else if (t === 'range') range = v;
      else child[t] = v;
    };
    const openTrim = lines[i].trim();
    if (openTrim.endsWith(close)) {
      // 单行形（render 的 elem 压行产物）：子元素全为内联，逐个取出
      i += 1;
      const inner = openTrim.slice(openTrim.indexOf('>') + 1, openTrim.length - close.length);
      const re = new RegExp(`<(${CHILD_TAGS})(?:\\s[^>]*)?>([\\s\\S]*?)<\\/\\1>`, 'g');
      for (const m of inner.matchAll(re)) addChild(m[1], unesc(m[2]));
    } else {
      i += 1;
      while (i < lines.length && lines[i].trim() !== close) {
        const m = new RegExp(`^<(${CHILD_TAGS})[>\\s]`).exec(lines[i]);
        if (m) addChild(m[1], contentOf(m[1]));
        else i += 1; // 容忍元素内手工文字/注释
      }
      if (i >= lines.length) fail(`元素未闭合（缺 ${close}）`, start);
      i += 1;
    }
    const base = { id: `n${n}`, seq: n, blockId: '', time: '', ...ln, ...st };
    const optNote = child.note ? { note: child.note } : {};
    if (tag === 'note') {
      const attrKinds = NOTE_KINDS.filter((k) => a.has(k));
      const childKinds = NOTE_KINDS.filter((k) => child[k] !== undefined);
      if (attrKinds.length + childKinds.length > 1) return fail('note 只能有一种类型（request/suggest/discuss）', start);
      const kind = (attrKinds[0] ?? childKinds[0] ?? 'request') as NoteKind;
      const text = attrKinds[0] ? unescAttr(a.get(attrKinds[0]) ?? '') : childKinds[0] ? child[childKinds[0]] : undefined;
      if (text === undefined) return fail('<note> 缺少 request/suggest/discuss', start);
      const quote = range !== undefined ? { quote: range } : {};
      return { ...base, type: 'note', note: text, kind, ...quote };
    }
    if (tag === 'swap') {
      const sa = Number(a.get('a'));
      const sb = Number(a.get('b'));
      if (!Number.isInteger(sa) || !Number.isInteger(sb) || sa < 1 || sb <= sa) return fail('swap 需要 1 ≤ a < b 的行号', start);
      if (firsts.length !== 2) return fail('swap 需要两个 <first>（两块首行）', start);
      return { ...base, type: 'swap', a: sa, b: sb, firstA: firsts[0], firstB: firsts[1] };
    }
    // revise
    if (a.get('form') === 'patch') {
      if (!dels.length || dels.length !== inss.length || seqs.some((t, k) => t !== (k % 2 === 0 ? 'del' : 'ins')))
        return fail('patch 需要严格交替的 <del>/<ins> 句对', start);
      const alterHash = child['alter-hash'];
      if (!alterHash || !/^blake3:[0-9a-f]{16}$/.test(alterHash)) return fail('patch 缺少合法 <alter-hash>', start);
      const patch = dels.map((del, k) => ({ del, ins: inss[k] }));
      return { ...base, type: 'replace', before: '', after: '', patch, afterHash: alterHash, ...optNote };
    }
    const before = child.original;
    const after = child.alter;
    if (before === undefined && after === undefined) return fail('<revise> 需要 original/alter 至少其一', start);
    if (before === undefined) return { ...base, type: 'insert', after, ...optNote };
    if (after === undefined) return { ...base, type: 'delete', before, ...optNote };
    return { ...base, type: 'replace', before, after, ...optNote };
  };

  const ops: Op[] = [];
  let sawChanges = false;
  let sawWithdrawn = false;
  i += 1; // 跳过 front matter 结束 ---
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t !== '<changes>' && t !== '<withdrawn>') {
      i += 1; // 标题、注释、format、手工加注一律忽略
      continue;
    }
    const tomb = t === '<withdrawn>';
    if (tomb) {
      if (sawWithdrawn) fail('重复 <withdrawn> 区段');
      sawWithdrawn = true;
    } else {
      if (sawChanges) fail('重复 <changes> 区段');
      sawChanges = true;
    }
    const close = tomb ? '</withdrawn>' : '</changes>';
    i += 1;
    while (i < lines.length && lines[i].trim() !== close) {
      const m = /^<(note|revise|swap)[\s>]/.exec(lines[i]);
      if (m) ops.push(element(m[1] as 'note' | 'revise' | 'swap', tomb));
      else i += 1; // 区段内手工文字忽略
    }
    if (i >= lines.length) fail(`区段未闭合（缺 ${close}）`);
    i += 1;
  }
  if (!sawChanges) fail('缺少 <changes> 区段');
  const activeCount = ops.filter((op) => op.state !== 'withdrawn').length;
  const tombCount = ops.length - activeCount;
  if (changesCount !== activeCount) fail(`changes=${changesCount} 与实际元素数 ${activeCount} 不符`, kv.get('changes')?.line);
  if (wdRaw !== undefined && withdrawnCount !== tombCount)
    fail(`withdrawn=${withdrawnCount} 与实际墓碑数 ${tombCount} 不符`, kv.get('withdrawn')?.line);
  return { meta, ops };
}
