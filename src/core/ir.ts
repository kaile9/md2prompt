// SPDX-License-Identifier: MPL-2.0
/** SPEC §2 核心类型 + §7 core/ir.ts 冻结签名。
 *  Block 是唯一文档单位；变更引擎只 diff Block 数组。 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { RootContent } from 'mdast';

export type BlockKind =
  | 'heading'
  | 'para'
  | 'code'
  | 'table'
  | 'html'
  | 'list'
  | 'quote'
  | 'hr'
  | 'math'
  | 'record';

export interface Block {
  id: string; // 会话内稳定：装载时 'b'+序号；新块发新 id
  kind: BlockKind;
  text: string; // 该块的规范序列化源文（md 源或 JSONL 原始行）
  lineStart: number; // 1-based，相对当前序列化全文
  lineEnd: number;
  meta?: { level?: number; lang?: string; json?: unknown; [k: string]: unknown };
  /** 块前分隔符原文（首块为 ''）。解析时必填；新建块缺省按 '\n\n' 计。
   *  serializeBlocks = 逐块拼接 gap+text，故序列化与原文逐字节相等。 */
  gap?: string;
}

/** 生命周期（SPEC v1.2 §2）：缺省 = pending（待决，正常导出）。
 *  hidden = 已确认收起（仍导出，侧栏折叠组可见）；withdrawing = 撤回预令（导出按 pending 计）；
 *  withdrawn = 已撤回墓碑（不导出进 B/A，只进 Prompt.md 的 C 类区段，复制时省略）。 */
export type OpState = 'hidden' | 'withdrawing' | 'withdrawn';

interface OpBase {
  id: string; // diff op：'a:{blockId}:{type}' 确定性 id；人工 op：会话内 'o'+序号
  blockId: string;
  time: string; // 本地 HH:MM
  note?: string;
  line?: number; // 内存态锚点（当前文档行号），协议文件不持久化；恢复/撤回精确落位用
  state?: OpState;
  seq?: number; // 诞生序号（v1.3 导出 id 稳定化：跨导出不变 → Agent 端缓存命中）；会话内分配
}

/** note 的三型（协议 2.0）：request=修改命令（请 Agent 执行）；suggest=修改建议（Agent 定夺）；
 *  discuss=希望讨论（勿改文本）。缺省 request。 */
export type NoteKind = 'request' | 'suggest' | 'discuss';

export type Op =
  | (OpBase & { type: 'replace'; before: string; after: string; patch?: { del: string; ins: string }[]; afterHash?: string })
  | (OpBase & { type: 'insert'; after: string })
  | (OpBase & { type: 'delete'; before: string })
  // swap（协议 2.0，替代 move）：a<b 为记录时行号；blockId=现居 a 的块，otherId=现居 b 的块；
  // firstA/firstB=两块首行文本（恢复重绑校验）。自逆：施加/撤回都是再换一次。diff 不产生 swap，仅显式命令。
  | (OpBase & { type: 'swap'; a: number; b: number; firstA: string; firstB: string; otherId?: string })
  | (OpBase & { type: 'note'; note: string; quote?: string; kind?: NoteKind }); // 文本不动；quote = 行内选段原文（v1.3）

export interface DocState {
  file: { name: string; kind: 'md' | 'jsonl' | 'xml' };
  base: Block[]; // 基线（导入/新基线时）
  cur: Block[]; // 当前
  ops: Op[]; // 未决变更（pending/hidden/withdrawing；A 类 + B 类 note），按文档位置排序
  withdrawn?: Op[]; // C 类墓碑（state='withdrawn'），会话内可复活，上限 50 条
}

export type DocKind = DocState['file']['kind'];

/* ---- 提示词式标签区域（editor/htmlguard.ts 共享同一组规则，保证 IR 块 ≡ 编辑器围栏） ---- */
/** 档一：整行只有开/闭/自闭合标签（可带属性），非标准 HTML 标签名。 */
export const PROMPT_OPEN = /^\s{0,3}<([a-z][a-z0-9-]{1,24})(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?>\s*$/;
export const PROMPT_CLOSE = /^\s{0,3}<\/([a-z][a-z0-9-]{1,24})>\s*$/;
export const DANGEROUS_TAG = /^(?:script|style|iframe|object|embed)$/;
/** CommonMark type 6 块级标签（与 htmlguard 同表）。 */
export const BLOCK6_TAG = /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)$/;

/** fsio 打开结果；类型放此共享，避免 core 内循环依赖。mtime = 源文件最后修改时间（打印页眉用）。 */
export interface DocFile {
  name: string;
  kind: DocKind;
  text: string;
  mtime?: number;
}

export function parseDoc(text: string, kind: DocKind): Block[] {
  const blocks: Block[] =
    kind === 'xml'
      ? [{ id: 'b1', kind: 'code', text, gap: '', lineStart: 0, lineEnd: 0, meta: { lang: 'xml' } }]
      : kind === 'jsonl'
        ? parseJsonl(text)
        : parseMd(text);
  blockLineMap(blocks);
  return blocks;
}

export function serializeBlocks(blocks: Block[]): string {
  let out = '';
  blocks.forEach((b, i) => {
    out += (b.gap ?? (i === 0 ? '' : '\n\n')) + b.text;
  });
  return out;
}

/** 原地写 lineStart/lineEnd。缺省 gap 取值与 serializeBlocks 一致，行号基于序列化结果。 */
export function blockLineMap(blocks: Block[]): void {
  let line = 1;
  blocks.forEach((b, i) => {
    line += countNl(b.gap ?? (i === 0 ? '' : '\n\n'));
    b.lineStart = line;
    const body = b.text.replace(/\s+$/, ''); // 尾部空白（含末行换行符）不占行号
    b.lineEnd = line + countNl(body);
    line = b.lineEnd + countNl(b.text.slice(body.length));
  });
}

const mdParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/** remark 顶层节点 → BlockKind；definition/footnoteDefinition 等未列类型归 para。 */
const MD_KIND: Record<string, BlockKind> = {
  heading: 'heading',
  paragraph: 'para',
  code: 'code',
  table: 'table',
  html: 'html',
  list: 'list',
  blockquote: 'quote',
  thematicBreak: 'hr',
  math: 'math',
};

function parseMd(text: string): Block[] {
  const blocks: Block[] = [];
  let prevEnd = 0;
  for (const node of mdParser.parse(text).children) {
    if (!node.position) continue; // remark 恒带 position；防御性跳过
    const start = node.position.start.offset ?? 0;
    const end = node.position.end.offset ?? start;
    blocks.push({
      id: `b${blocks.length + 1}`,
      kind: MD_KIND[node.type] ?? 'para',
      text: text.slice(start, end),
      gap: text.slice(prevEnd, start),
      lineStart: 0,
      lineEnd: 0,
      meta: mdMeta(node),
    });
    prevEnd = end;
  }
  return mergeTagRegions(
    finish(blocks, text, prevEnd, () => ({
      id: 'b1',
      kind: 'para',
      text,
      gap: '',
      lineStart: 0,
      lineEnd: 0,
    })),
  );
}

function parseJsonl(text: string): Block[] {
  const blocks: Block[] = [];
  let prevEnd = 0;
  let offset = 0;
  for (const line of text.split('\n')) {
    const start = offset;
    offset += line.length + 1;
    if (line.trim() === '') continue; // 空行/纯空白行并入下一块的 gap
    blocks.push({
      id: `b${blocks.length + 1}`,
      kind: 'record',
      text: line,
      gap: text.slice(prevEnd, start),
      lineStart: 0,
      lineEnd: 0,
      meta: jsonMeta(line),
    });
    prevEnd = start + line.length;
  }
  return finish(blocks, text, prevEnd, () => ({
    id: 'b1',
    kind: 'record',
    text,
    gap: '',
    lineStart: 0,
    lineEnd: 0,
    meta: jsonMeta(text),
  }));
}

/** 末块收编全文尾部（末行换行/末尾空行）；零块且原文非空时全文兜底为单块。保 序列化==原文。 */
function finish(blocks: Block[], text: string, prevEnd: number, fallback: () => Block): Block[] {
  if (blocks.length > 0) blocks[blocks.length - 1].text += text.slice(prevEnd);
  else if (text !== '') blocks.push(fallback());
  return blocks;
}

/** 档一标签区域合并：开标签块（整行开标签、非标准名、非自闭合）到同名闭标签块的连续区块并为一块。
 *  保证「IR 块 ≡ 编辑器 XML 卡围栏」1:1——装饰/光标/批注/跳转的节点序映射前提（v1.6 BUG5 根治）。
 *  序列化不变量保持：合并块 text = 首块 text + Σ(gap+text)，与原文切片逐字节相等。
 *  配对规则与 editor/htmlguard.ts 档一完全一致（同组正则）。 */
function mergeTagRegions(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const open = b.kind === 'html' ? PROMPT_OPEN.exec(b.text) : null;
    if (open && open[1] !== 'img' && !BLOCK6_TAG.test(open[1]) && !DANGEROUS_TAG.test(open[1]) && !/\/>\s*$/.test(b.text)) {
      const closeRe = new RegExp(`^\\s{0,3}</${open[1]}>\\s*$`);
      let end = -1;
      for (let j = i + 1; j < blocks.length; j++) {
        if (blocks[j].kind === 'html' && closeRe.test(blocks[j].text)) {
          end = j;
          break;
        }
      }
      if (end > 0) {
        let text = b.text;
        for (let k = i + 1; k <= end; k++) text += (blocks[k].gap ?? '\n\n') + blocks[k].text;
        out.push({ ...b, text });
        i = end;
        continue;
      }
    }
    out.push(b);
  }
  return out;
}

function mdMeta(node: RootContent): Block['meta'] {
  if (node.type === 'heading') return { level: node.depth };
  if (node.type === 'code' && node.lang) return { lang: node.lang };
  return undefined;
}

function jsonMeta(raw: string): NonNullable<Block['meta']> {
  try {
    return { json: JSON.parse(raw) };
  } catch (e) {
    return { parseError: e instanceof Error ? e.message : String(e) };
  }
}

function countNl(s: string): number {
  return s.match(/\n/g)?.length ?? 0;
}

/* ---- 节文本重解析（原 main.ts，v1.6 归位 core 可测） ---- */

let idSeq = 0;
/** 会话内新块 id（重解析/新增记录共用一支计数）。 */
export const newBlockId = (): string => `n${++idSeq}`;

/** 中段 id 继承：Map（kind+text → 下标队列）配对 O(n)（原 findIndex O(n²)，C2）。 */
function inheritIds(fresh: Block[], old: Block[]): Block[] {
  const byKey = new Map<string, number[]>();
  old.forEach((o, oi) => {
    const k = `${o.kind} ${o.text}`;
    const q = byKey.get(k);
    if (q) q.push(oi);
    else byKey.set(k, [oi]);
  });
  const used = new Set<number>();
  const idOf = fresh.map((f) => {
    const q = byKey.get(`${f.kind} ${f.text}`);
    const i = q?.shift();
    if (i === undefined) return undefined;
    used.add(i);
    return old[i].id;
  });
  let oi = 0;
  return fresh.map((f, fi) => {
    if (idOf[fi]) return { ...f, id: idOf[fi] };
    while (oi < old.length && used.has(oi)) oi++;
    if (oi < old.length && old[oi].kind === f.kind) {
      const o = old[oi];
      used.add(oi);
      if (f.text !== o.text && canonText(f.text) === canonText(o.text)) {
        // 序列化器归一化噪音（hr 标记/表格对齐/列表子弹与松散/转义）：继承 id 并保留原文，幻影不入账（v2.0 根治）
        return { ...f, id: o.id, text: o.text };
      }
      return { ...f, id: o.id };
    }
    return { ...f, id: newBlockId() };
  });
}

/** 归一化等价判定（只用于「这算不算同一块」，永不写回）：序列化器方言——转义反斜杠、
 *  hr 标记（--- / *** / ___）、列表子弹（- / * / +）与松散化空行、表格列宽补齐与分隔行、行尾空格。 */
const CANON_ESCAPABLE = '_*`#+-.!()[]{}<>|';
function canonText(t: string): string {
  return t
    .replace(/\\(.)/gs, (m: string, c: string) => (CANON_ESCAPABLE.includes(c) ? c : m))
    .replace(/^ {0,3}([-*_])(?: *\1){2,} *$/gm, '---')
    .replace(/^(\s*)[-*+](?=\s)/gm, '$1-')
    .replace(/^[\s|:+-]+$/gm, (m: string) => m.replace(/ /g, '').replace(/-+/g, '---'))
    .replace(/ +\|/g, '|')
    .replace(/\| +/g, '|')
    .replace(/\n{2,}/g, '\n')
    .replace(/ +$/gm, '');
}

/** 增量重解析：新旧节文本从头/尾按块对齐（startsWith + 块边界校验），只对变更中段跑 remark。
 *  全量是 O(节)，增量是 O(变更域)：300KB 节单块编辑 flush 341ms → 2.3ms（≈148×，v1.6 性能专项实测）。
 *  头/尾块复用旧引用（id/meta 全保）；中段走 inheritIds；纯空白中段 = gap 变更，按 finish 语义吸收。 */
export function reparseSection(text: string, old: Block[]): Block[] {
  let head = 0;
  let pos = 0;
  while (head < old.length) {
    const b = old[head];
    const seg = (head === 0 ? '' : (b.gap ?? '\n\n')) + b.text; // 首块 gap 归零，与编辑器源文同口径
    if (!text.startsWith(seg, pos)) break;
    const next = pos + seg.length;
    // 块边界校验：旧块是新块的前缀时不算对齐（'# 甲' ≠ '# 甲改'）——后继必须是换行或文末
    if (next < text.length && text[next] !== '\n') break;
    pos = next;
    head++;
  }
  let tail = 0;
  let end = text.length;
  while (tail < old.length - head) {
    const b = old[old.length - 1 - tail];
    const seg = (b.gap ?? '\n\n') + b.text; // gap 自带换行边界，无需再校验前驱
    const start = end - seg.length;
    if (start < 0 || !text.startsWith(seg, start)) break;
    end = start;
    tail++;
  }
  if (head === 0 && tail === 0) return inheritIds(parseDoc(text, 'md'), old); // 全变：原路径
  const heads = old.slice(0, head);
  const tails = old.slice(old.length - tail);
  const span = text.slice(pos, end);
  if (span.trim() === '') {
    // 纯 gap 变更：并入下一块 gap；文末则收编进末块 text（finish 语义）
    if (tails.length) return [...heads, { ...tails[0], gap: span + (tails[0].gap ?? '\n\n') }, ...tails.slice(1)];
    const last = heads[heads.length - 1];
    return last ? [...heads.slice(0, -1), { ...last, text: last.text + span }] : heads;
  }
  const mid = inheritIds(parseDoc(span, 'md'), old.slice(head, old.length - tail));
  return [...heads, ...mid, ...tails];
}
