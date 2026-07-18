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

export type Op =
  | (OpBase & { type: 'replace'; before: string; after: string; patch?: { del: string; ins: string }[]; afterHash?: string })
  | (OpBase & { type: 'insert'; after: string })
  | (OpBase & { type: 'delete'; before: string })
  | (OpBase & { type: 'move'; first: string; from: [number, number]; to: number })
  | (OpBase & { type: 'note'; note: string; quote?: string }); // B 类：文本不动；quote = 行内选段原文（v1.3）

export interface DocState {
  file: { name: string; kind: 'md' | 'jsonl' | 'xml' };
  base: Block[]; // 基线（导入/新基线时）
  cur: Block[]; // 当前
  ops: Op[]; // 未决变更（pending/hidden/withdrawing；A 类 + B 类 note），按文档位置排序
  withdrawn?: Op[]; // C 类墓碑（state='withdrawn'），会话内可复活，上限 50 条
}

export type DocKind = DocState['file']['kind'];

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
  return finish(blocks, text, prevEnd, () => ({
    id: 'b1',
    kind: 'para',
    text,
    gap: '',
    lineStart: 0,
    lineEnd: 0,
  }));
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
