// core/state.ts — DocState 状态中枢（SPEC §2，不引库）。
// 不变量：state.ops ≡ 按文档位置排序的 diffBlocks(base,cur) + 人工 op（note/move）+ 生命周期标记。
// 生命周期（v1.2）：pending → hidden（已确认收起，仍导出）→ 可撤回；
//                  撤回两阶段：withdrawing（预令，可取消）→ withdrawn（墓碑，C 类，可复活，上限 50）。
// diff op 的 hidden/withdrawing 存 flags（op 对象每次 commit 重建）；人工 op 存对象自身。
// 按键路径只做 ops/行号重算；哈希+Prompt 渲染在 800ms 防抖通道内异步完成（SPEC §2）。
import { parseDoc, serializeBlocks, blockLineMap, type Block, type Op, type DocState, type DocKind } from './ir';
import { diffBlocks, rejectOp, rebindOps, applyOps, nowHM } from './changes';
import { renderPrompt, parsePrompt, planPatch, applyPatch } from './promptmd';
import { indentWrite } from './indent';
import { hashText, hashShort } from './hash';
import * as fs from './fsio';

export type { DocState } from './ir';
export type Listener = (state: DocState | null) => void;
export type Action =
  | { type: 'load'; file: DocState['file']; cur: Block[]; base?: Block[]; ops?: Op[] }
  | { type: 'new' }
  | { type: 'patchCur'; cur: Block[] }
  | { type: 'addNote'; blockId: string; note: string; quote?: string }
  | { type: 'editNote'; id: string; note: string; quote?: string } // 改批注文字（可一并改选段，v1.3 批注打磨）
  | { type: 'recordMove'; blockId: string; first: string; from: [number, number]; to: number }
  | { type: 'hide'; id: string } // 隐藏：卡片收起，文本与导出照旧
  | { type: 'unhide'; id: string }
  | { type: 'withdraw'; id: string } // 撤回第一击：进入预令（文档内预览删除线）
  | { type: 'withdrawCommit'; id: string } // 第二击：真正回滚，op 转墓碑
  | { type: 'cancelWithdraw'; id: string } // 预令反悔：回到 pending
  | { type: 'restore'; id: string } // 墓碑复活：重新施加该修改
  | { type: 'hideAll' } // 全部隐藏（不含预令中的 op）
  | { type: 'clearWithdrawn' } // 清空墓碑（内存管控）
  | { type: 'suppressPrompt' } // 恢复三选「忽略」：取消本次 load 的 Prompt 覆写（不毁既有记录）
  | { type: 'setSaveState'; save: fs.SaveState };
export interface Store {
  readonly state: DocState | null;
  dispatch(action: Action): void;
  subscribe(fn: Listener): () => void;
}

let doc: DocState | null = null; // null = 尚未打开文档
let manual: Op[] = []; // 人工 op（note/move）；A 类三型一律由 diffBlocks 重算
let flags = new Map<string, 'hidden' | 'withdrawing'>(); // diff op 的生命周期标记（id 确定性，跨 commit 存活）
let withdrawn: Op[] = []; // C 类墓碑（state='withdrawn'）
let seqs = new Map<string, number>(); // diff op 的诞生序号（v1.3 导出 id 稳定化）
let diffSeq = 0; // seq 计数器（diff 与人工共用一支，恢复时按文件最大编号续）
let opSeq = 0;
let save: fs.SaveState = 'saved';
let lastAction: string | null = null;
let indentWriteFlag = false; // 「首行缩进·写入文档」（ui/settings 同步进来）
let promptTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<Listener>();
const nid = () => 'o' + ++opSeq;
const notify = () => listeners.forEach((f) => f(doc));
export const getSaveState = (): fs.SaveState => save;
/** 最近一次 dispatch 的 action 类型（main 据此区分结构性刷新与轻量刷新）。 */
export const getLastAction = (): string | null => lastAction;

const WITHDRAWN_CAP = 50; // 墓碑上限（内存管控），超出丢最旧

/** base 哈希按数组引用缓存（base 仅在 load 整体替换）。 */
const baseHashCache = new WeakMap<Block[], Promise<string>>();

/** 「首行缩进·写入文档」开关（设置面板同步；仅 md 生效）。 */
export const setIndentWrite = (b: boolean): void => {
  indentWriteFlag = b;
};
/** 导出文本 = 序列化 + 可选缩进变换（内存态永不含缩进；jsonl/xml 不变换）。 */
export const exportText = (blocks: Block[], kind: DocKind): string => {
  const t = serializeBlocks(blocks);
  return indentWriteFlag && kind === 'md' ? indentWrite(t) : t;
};

function commit(): void {
  const d = doc;
  if (!d) return;
  blockLineMap(d.cur);
  manual = manual.filter((o) => o.type !== 'move' || moveAlive(o, d.cur)); // 失效 move 自动销账（SPEC §2）
  const pos = new Map(d.cur.map((b) => [b.id, b.lineStart] as const));
  const posBase = new Map(d.base.map((b) => [b.id, b.lineStart] as const));
  const lineOf = (o: Op): number => pos.get(o.blockId) ?? posBase.get(o.blockId) ?? 0;
  d.ops = [...diffBlocks(d.base, d.cur), ...manual].sort((a, b) => lineOf(a) - lineOf(b));
  const ids = new Set(d.ops.map((o) => o.id));
  flags.forEach((_, k) => {
    if (!ids.has(k)) flags.delete(k); // op 消失（改回原文等）→ 标记一并回收
  });
  for (const o of d.ops) {
    // seq 诞生即分配、终身不变（跨导出稳定 → Agent 缓存命中）
    if (o.seq === undefined) {
      if (!o.id.startsWith('a:')) o.seq = ++diffSeq; // 人工 op 兜底（正常在创建时分配）
      else {
        if (!seqs.has(o.id)) seqs.set(o.id, ++diffSeq);
        o.seq = seqs.get(o.id);
      }
    }
    const f = flags.get(o.id);
    if (f) o.state = f;
  }
  d.withdrawn = withdrawn;
  void fs.saveDoc(exportText(d.cur, d.file.kind)); // fsio 内部防抖落盘
  clearTimeout(promptTimer);
  promptTimer = setTimeout(writePromptDebounced, 800);
  notify();
}

/** 组装 Prompt.md 文本（base 哈希按数组引用缓存）。copy=true 时省略 C 类（回传 Agent 版本）。
 *  导出 id = 类字母 + 诞生序号（跨导出稳定）；replace 够省走 patch 形（after-hash 同步短哈希）。 */
export async function buildPrompt(d: DocState, copy = false): Promise<string> {
  let bh = baseHashCache.get(d.base);
  if (!bh) {
    bh = hashText(serializeBlocks(d.base));
    baseHashCache.set(d.base, bh);
  }
  const patchHashes = new Map<string, string>();
  if (d.file.kind === 'md')
    for (const o of d.ops) if (o.type === 'replace' && planPatch(o)) patchHashes.set(o.id, hashShort(o.after));
  return renderPrompt(
    d,
    { docHash: await hashText(exportText(d.cur, d.file.kind)), baseHash: await bh },
    {
      includeWithdrawn: !copy,
      indentHint: indentWriteFlag && d.file.kind === 'md',
      ids: (op) => `${op.type === 'note' ? 'B' : 'A'}${op.seq}`, // seq 由 commit 保证分配；缺失宁可显形不静默撞 A0
      patchHashes,
    },
  );
}

async function writePromptDebounced(): Promise<void> {
  const d = doc;
  if (!d) return;
  try {
    // 哈希/渲染失败只丢本次 Prompt 落盘，doc 保存不受影响；下轮 commit 重试
    void fs.writePrompt(await buildPrompt(d));
  } catch {
    /* 静默 */
  }
}

/** move 存活校验：块仍在 cur 且已不在原行（撤销回到原行 → 销账）。 */
function moveAlive(o: Extract<Op, { type: 'move' }>, cur: Block[]): boolean {
  const b = cur.find((x) => x.id === o.blockId);
  return !!b && b.lineStart !== o.from[0];
}

/** 恢复编排（SPEC §2）：parse → patch 形展开 → 活跃 op 重绑 → 逆序取反重建 base；墓碑直通。 */
export function restoreFromPrompt(
  file: DocState['file'],
  cur: Block[],
  promptText: string,
): { base: Block[]; ops: Op[] } {
  const { ops } = parsePrompt(promptText);
  const active = ops.filter((o) => o.state !== 'withdrawn');
  const tombs = ops.filter((o) => o.state === 'withdrawn');
  // patch 形展开：cur 块 = after 态（after-hash 校验），反向应用 patch 得 before（v1.3）
  // 候选逐一验：line 候选不中再试内容候选（行号漂移场景的降级，评审 m4）
  for (const [k, op] of active.entries()) {
    if (op.type !== 'replace' || !op.patch) continue;
    const candidates = [
      ...cur.filter((x) => op.line !== undefined && x.lineStart <= op.line && op.line <= x.lineEnd),
      ...cur.filter((x) => op.patch!.every((h) => x.text.includes(h.ins))),
    ];
    let done = false;
    for (const b of candidates) {
      if (hashShort(b.text) !== op.afterHash) continue;
      active[k] = {
        ...op,
        before: applyPatch(b.text, op.patch.map((h) => ({ del: h.ins, ins: h.del }))),
        after: b.text,
      };
      done = true;
      break;
    }
    if (!done) throw new Error(`patch op ${op.id} 定位/校验失败`);
  }
  const rebound = rebindOps(cur, active);
  const base = applyOps(cur, rebound, -1);
  // 重建块补发会话内唯一 id（恢复的多条 delete 的 blockId 均为 ''，不补会撞 id 改错账）
  let rid = 0;
  for (const b of base) if (!b.id) b.id = `r${++rid}`;
  if (file.kind === 'jsonl') for (const b of base) if (b.kind === 'para') b.kind = 'record'; // applyOps 重建块缺 kind
  blockLineMap(base);
  return { base, ops: [...rebound, ...tombs] };
}

/** 人工 op（note/move）置状态 = 改对象自身；diff op 置状态 = 写 flags。 */
function mark(id: string, st: 'hidden' | 'withdrawing' | undefined): void {
  const m = manual.find((o) => o.id === id);
  if (m) {
    if (st) m.state = st;
    else delete m.state;
  } else if (st) flags.set(id, st);
  else flags.delete(id);
}

/** JSONL 记录 meta 随文本回滚/重放同步重算（JSONL-02）。 */
function resyncJsonlMeta(): void {
  if (doc?.file.kind === 'jsonl')
    for (const b of doc.cur) if (b.kind === 'record') b.meta = parseDoc(b.text, 'jsonl')[0]?.meta;
}

export const store: Store = {
  get state() {
    return doc;
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  dispatch(a: Action): void {
    lastAction = a.type;
    if (a.type === 'setSaveState') {
      save = a.save;
      return notify();
    }
    if (a.type === 'new' || a.type === 'load') {
      const ops = a.type === 'load' ? (a.ops ?? []) : [];
      manual = ops.filter((o) => o.state !== 'withdrawn' && (o.type === 'note' || o.type === 'move'));
      withdrawn = ops.filter((o) => o.state === 'withdrawn').slice(-WITHDRAWN_CAP);
      flags = new Map();
      seqs = new Map();
      // seq 计数器按文件最大编号续（恢复后新 op 不撞既有导出 id）
      const maxSeq = ops.reduce((m, o) => {
        const n = /\d+/.exec(o.id);
        return n ? Math.max(m, Number(n[0])) : m;
      }, 0);
      diffSeq = maxSeq;
      opSeq = maxSeq;
      // hidden 的 diff op 跨会话播种：确定性 id 与 diffBlocks 输出一致，commit 重算后即复活（M1）
      // seq 同步播种：导出 id 跨会话不漂移（v1.3 稳定编号的恢复半边，E2E 抓到）
      for (const o of ops) {
        // delete 的 blockId 恢复时为 ''（靠 line 落位）：按 before 文本补绑，否则 hidden 播种键永不命中（M5）
        if (o.type === 'delete' && !o.blockId && a.type === 'load' && a.base) {
          const bb = a.base.find((x) => x.text === o.before);
          if (bb) o.blockId = bb.id;
        }
        const n = /\d+/.exec(o.id);
        if (o.state === 'hidden' && o.type !== 'note' && o.type !== 'move')
          flags.set(`a:${o.blockId}:${o.type}`, 'hidden');
        if (n && o.blockId && o.state !== 'withdrawn') {
          if (o.type === 'note' || o.type === 'move') o.seq = Number(n[0]);
          else seqs.set(`a:${o.blockId}:${o.type}`, Number(n[0]));
        }
      }
      doc =
        a.type === 'load'
          ? { file: a.file, cur: a.cur, base: a.base ?? a.cur, ops: [] }
          : { file: { name: '未命名.md', kind: 'md' }, base: [], cur: [], ops: [] };
      blockLineMap(doc.base);
      clearTimeout(promptTimer);
      return commit();
    }
    if (!doc) return;
    switch (a.type) {
      case 'patchCur':
        doc.cur = a.cur;
        break;
      case 'addNote': {
        const b = doc.cur.find((x) => x.id === a.blockId);
        manual.push({ id: nid(), type: 'note', blockId: a.blockId, note: a.note, time: nowHM(), line: b?.lineStart, ...(a.quote ? { quote: a.quote } : {}) });
        break;
      }
      case 'editNote': {
        const m = manual.find((o) => o.id === a.id && o.type === 'note');
        if (!m) return;
        const n = m as Extract<Op, { type: 'note' }>;
        n.note = a.note;
        if (a.quote !== undefined) n.quote = a.quote; // 新选区重进：选段一并更新（评审 m2）
        break;
      }
      case 'recordMove': {
        const b = doc.cur.find((x) => x.id === a.blockId);
        manual.push({ id: nid(), type: 'move', blockId: a.blockId, first: a.first, from: a.from, to: a.to, time: nowHM(), line: b?.lineStart });
        break;
      }
      case 'hide':
      case 'unhide': {
        const op = doc.ops.find((o) => o.id === a.id);
        if (!op || op.state === 'withdrawing') return;
        mark(a.id, a.type === 'hide' ? 'hidden' : undefined);
        break;
      }
      case 'withdraw': {
        const op = doc.ops.find((o) => o.id === a.id);
        if (!op || op.state === 'withdrawing') return;
        mark(a.id, 'withdrawing'); // hidden 直接跳入预令（可见性随预令恢复）
        break;
      }
      case 'cancelWithdraw': {
        const op = doc.ops.find((o) => o.id === a.id);
        if (!op || op.state !== 'withdrawing') return;
        mark(a.id, undefined);
        break;
      }
      case 'withdrawCommit': {
        const op = doc.ops.find((o) => o.id === a.id);
        if (!op || op.state !== 'withdrawing') return;
        try {
          if (op.type !== 'note') {
            doc.cur = rejectOp(doc.base, doc.cur, op);
            resyncJsonlMeta();
          }
        } catch {
          return; // 校验失败：保持现状不动账
        }
        manual = manual.filter((o) => o.id !== op.id);
        flags.delete(op.id);
        const tomb: Op = { ...op, state: 'withdrawn' };
        withdrawn = [...withdrawn, tomb].slice(-WITHDRAWN_CAP);
        break;
      }
      case 'restore': {
        const t = withdrawn.find((o) => o.id === a.id);
        if (!t) return;
        let op: Op = { ...t };
        delete op.state;
        try {
          if (op.type === 'note') {
            // 导入墓碑的 blockId 为 ''：按行号重绑；绑不上则放弃复活
            if (!op.blockId) {
              const b = doc.cur.find((x) => op.line !== undefined && x.lineStart <= op.line && op.line <= x.lineEnd);
              if (!b) return;
              op = { ...op, blockId: b.id };
            }
            manual.push({ ...op, id: nid() });
          } else if (op.type === 'move') {
            if (!op.blockId) {
              const b = doc.cur.find((x) => x.text.split('\n', 1)[0] === (op as Extract<Op, { type: 'move' }>).first);
              if (!b) return;
              op = { ...op, blockId: b.id };
            }
            doc.cur = applyOps(doc.cur, [op], 1); // 先移块，再补登记（moveAlive 才不销账）
            manual.push({ ...op, id: nid() });
          } else {
            // 导入 insert 墓碑（blockId ''）：复活前补发会话 id，防重建块空 id 撞账
            if (op.type === 'insert' && !op.blockId) op = { ...op, blockId: nid() };
            doc.cur = applyOps(doc.cur, [op], 1); // locate 有文本兜底，导入墓碑（blockId ''）可用
          }
        } catch {
          return; // 目标文本已不可寻：墓碑保留
        }
        resyncJsonlMeta();
        withdrawn = withdrawn.filter((o) => o.id !== t.id);
        break;
      }
      case 'hideAll':
        for (const o of doc.ops) if (!o.state) mark(o.id, 'hidden');
        break;
      case 'clearWithdrawn':
        withdrawn = [];
        break;
      case 'suppressPrompt':
        clearTimeout(promptTimer);
        return; // 不 commit 不 notify：仅取消本次 load 排程的 Prompt 覆写
    }
    commit();
  },
};

fs.onSaveState((s) => store.dispatch({ type: 'setSaveState', save: s }));
