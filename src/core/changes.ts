import { blockLineMap, type Block, type Op } from './ir';

/** 协议 time 一律本地 HH:MM（SPEC §3 规则 3）；state.ts 人工 op 同用。 */
export const nowHM = (): string => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 文本等价：CRLF/LF 归一化（Windows 文档恢复比对用，SPEC §2）。 */
const eqText = (a: string, b: string): boolean =>
  a === b || a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

/** §7 冻结签名。先按 id 对齐，未匹配块走 LCS（归一化相似度 > 0.6 判 replace）。
 *  op id 与内容确定；仅 time 随调用时刻（HH:MM）。 */
export function diffBlocks(base: Block[], cur: Block[]): Op[] {
  const curById = new Map(cur.map((b, i) => [b.id, i]));
  const pairs: [number, number][] = []; // [baseIdx, curIdx]
  const pairedB = new Set<number>();
  const pairedC = new Set<number>();
  base.forEach((b, i) => {
    const j = curById.get(b.id);
    if (j !== undefined) {
      pairs.push([i, j]);
      pairedB.add(i);
      pairedC.add(j);
    }
  });
  // 未匹配块两两算相似度，LCS 求保序最大配对
  const ub = base.map((_, i) => i).filter((i) => !pairedB.has(i));
  const uc = cur.map((_, i) => i).filter((i) => !pairedC.has(i));
  if (ub.length > 0 && uc.length > 0) {
    const nb = ub.map((i) => norm(base[i].text));
    const nc = uc.map((j) => norm(cur[j].text));
    // 字符相似度护栏：单对长度积超限跳过；全局评估预算 40 对（DP 矩阵规模另行受审）。
    const m = ub.length;
    const n = uc.length;
    let budget = 40;
    const sims = new Map<number, boolean>();
    const sim = (i: number, j: number): boolean => {
      const key = i * n + j;
      const cached = sims.get(key);
      if (cached !== undefined) return cached;
      if (budget <= 0 || nb[i].length * nc[j].length > 250_000) return false;
      budget -= 1;
      const matched = similarity(nb[i], nc[j]) > 0.6;
      sims.set(key, matched);
      return matched;
    };
    // 先覆盖同序候选，避免矩阵遍历方向把固定预算耗在远距离交叉配对上。
    for (let i = 0; i < m && budget > 0; i++) sim(i, Math.round((i * (n - 1)) / Math.max(1, m - 1)));
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--)
      for (let j = n - 1; j >= 0; j--)
        dp[i][j] = sim(i, j) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    for (let i = 0, j = 0; i < m && j < n; )
      if (sim(i, j) && dp[i][j] === dp[i + 1][j + 1] + 1) {
        pairs.push([ub[i], uc[j]]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
  }
  pairs.sort((x, y) => x[0] - y[0]);
  // 锚点在两侧必须同调递增；冲突对（如纯换序）降级为 delete+insert，移动本就由显式命令记录（§2）
  const anchors: [number, number][] = [];
  let lastJ = -1;
  for (const p of pairs)
    if (p[1] > lastJ) {
      anchors.push(p);
      lastJ = p[1];
    }
  const time = nowHM();
  const ops: Op[] = [];
  let bi = 0;
  let bj = 0;
  const flushGaps = (ai: number, aj: number) => {
    for (; bi < ai; bi++)
      ops.push({ id: `a:${base[bi].id}:delete`, type: 'delete', blockId: base[bi].id, before: base[bi].text, time, line: base[bi].lineStart });
    for (; bj < aj; bj++)
      ops.push({ id: `a:${cur[bj].id}:insert`, type: 'insert', blockId: cur[bj].id, after: cur[bj].text, time, line: cur[bj].lineStart });
  };
  for (const [ai, aj] of anchors) {
    flushGaps(ai, aj);
    if (base[ai].text !== cur[aj].text)
      if (base[ai].text.trimEnd() !== cur[aj].text.trimEnd())
        ops.push({
          id: `a:${base[ai].id}:replace`,
          type: 'replace',
          blockId: base[ai].id, // LCS 配对两侧 id 可能不同，统一取 base 侧，apply/reject 有文本兜底
          before: base[ai].text,
          after: cur[aj].text,
          time,
          line: cur[aj].lineStart,
        });
    // 尾白仅差（序列化器追加/回收尾换行）不入账：内容等价，接受 cur 形态
    bi = ai + 1;
    bj = aj + 1;
  }
  flushGaps(base.length, cur.length);
  // 幻影对抑制：同 blockId 的 delete+insert 且文本全同（纯换序降级产物；移动由显式命令记录，§2）
  const byId = new Map<string, { d?: number; i?: number }>();
  ops.forEach((o, idx) => {
    if (o.type !== 'delete' && o.type !== 'insert') return;
    const e = byId.get(o.blockId) ?? {};
    if (o.type === 'delete') e.d = idx;
    else e.i = idx;
    byId.set(o.blockId, e);
  });
  const drop = new Set<number>();
  for (const { d, i } of byId.values())
    if (d !== undefined && i !== undefined) {
      const del = ops[d] as Extract<Op, { type: 'delete' }>;
      const ins = ops[i] as Extract<Op, { type: 'insert' }>;
      if (del.before === ins.after) {
        drop.add(d);
        drop.add(i);
      }
    }
  return ops.filter((_, idx) => !drop.has(idx));
}

/** dir=1 正向施加；dir=-1 逆序取反（恢复/导入重建 base 用；自底向上，高位 op 的行号在低位落位时仍有效）。
 *  每步校验目标文本（CRLF 归一化），失败抛带 op id 的错。
 *  重建块沿用记录文档的 record kind，其余记为 para：Op 冻结类型不带更细 kind/meta。
 *  结构变化后即时重算行号，保证后续 op.line 仍指向当前序列。 */
export function applyOps(base: Block[], ops: Op[], dir: 1 | -1): Block[] {
  const arr = base.map((b) => ({ ...b }));
  const rebuiltKind: Block['kind'] = base.some((b) => b.kind === 'record') ? 'record' : 'para';
  blockLineMap(arr);
  const restoredAt = new Map<number, Block>();
  const lineShifts: { line: number; delta: number }[] = [];
  const shiftedLine = (line?: number): number | undefined =>
    line === undefined || line <= 0 ? line : lineShifts.reduce((n, change) => n + (change.line < line ? change.delta : 0), line);
  const order = ops.map((_, i) => i);
  if (dir === -1) order.reverse();
  for (const k of order) {
    const op = ops[k];
    switch (op.type) {
      case 'note':
        break; // B 类文本不动
      case 'replace': {
        const i = locate(arr, op.id, op.blockId, dir === 1 ? op.before : op.after, shiftedLine(op.line));
        const oldSpan = lineSpanAt(arr, i);
        arr[i] = { ...arr[i], text: dir === 1 ? op.after : op.before };
        blockLineMap(arr);
        if (dir === -1 && op.line !== undefined) lineShifts.push({ line: op.line, delta: lineSpanAt(arr, i) - oldSpan });
        break;
      }
      case 'insert':
        if (dir === 1) {
          insertAt(arr, anchorAt(arr, ops, k, false), { id: op.blockId, kind: rebuiltKind, text: op.after, lineStart: 0, lineEnd: 0 });
          blockLineMap(arr);
        } else {
          const i = locate(arr, op.id, op.blockId, op.after, shiftedLine(op.line));
          const span = lineSpanAt(arr, i);
          removeAt(arr, i);
          if (op.line !== undefined) lineShifts.push({ line: op.line, delta: -span });
          blockLineMap(arr);
        }
        break;
      case 'delete':
        if (dir === 1) {
          removeAt(arr, locate(arr, op.id, op.blockId, op.before, op.line));
          blockLineMap(arr);
        } else {
          const prior = op.line === undefined ? undefined : restoredAt.get(op.line);
          const priorAt = prior ? arr.indexOf(prior) : -1;
          const at = priorAt >= 0 ? priorAt : anchorAt(arr, ops, k, true, shiftedLine(op.line));
          const restored: Block = { id: op.blockId, kind: rebuiltKind, text: op.before, lineStart: 0, lineEnd: 0 };
          insertAt(arr, at, restored);
          if (op.line !== undefined) restoredAt.set(op.line, restored);
          blockLineMap(arr);
        }
        break;
      case 'swap': {
        // 自逆：定位两块交换位置（施加/恢复同形）；id 优先，首行文本+行号邻近兜底
        const i = locateSwapBlock(arr, op.id, op.blockId, op.firstA, op.a);
        const j = locateSwapBlock(arr, op.id, op.otherId ?? '', op.firstB, op.b);
        if (i === j) throw new Error(`applyOps: op ${op.id} 校验失败（同块自换）`);
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
        blockLineMap(arr);
        break;
      }
    }
  }
  return arr;
}

/** 结构编辑的 gap 纪律：首块携带文档前缀，其余重建块使用文档形态的标准分隔符。 */
function insertAt(arr: Block[], index: number, block: Block): void {
  const at = Math.min(Math.max(0, index), arr.length);
  const separator = block.kind === 'record' || arr.some((b) => b.kind === 'record') ? '\n' : '\n\n';
  if (at === 0) {
    block.gap = arr[0]?.gap ?? '';
    if (arr[0]) arr[0].gap = separator;
  } else block.gap = separator;
  arr.splice(at, 0, block);
}

function removeAt(arr: Block[], index: number): Block {
  const [block] = arr.splice(index, 1);
  if (index === 0 && arr[0]) arr[0].gap = block.gap ?? '';
  return block;
}

const lineSpanAt = (arr: Block[], index: number): number =>
  arr[index + 1] ? Math.max(1, arr[index + 1].lineStart - arr[index].lineStart) : Math.max(1, arr[index].lineEnd - arr[index].lineStart + 1);

/** reject：cur 精确回滚该 op（SPEC §2）。delete 按 base 序邻近幸存块落位，保留原块 gap/meta；swap 自逆再换。
 *  v1.2：撤回（withdraw）两阶段的第二击走这里；旧的 accept 语义已随「隐藏/撤回」生命周期移除。 */
export function rejectOp(base: Block[], cur: Block[], op: Op): Block[] {
  const arr = cur.map((b) => ({ ...b }));
  switch (op.type) {
    case 'note':
      return arr; // 销账即可，文本不动
    case 'replace': {
      const i = locate(arr, op.id, op.blockId, op.after, op.line);
      arr[i] = { ...arr[i], text: op.before };
      return arr;
    }
    case 'insert':
      arr.splice(locate(arr, op.id, op.blockId, op.after, op.line), 1);
      return arr;
    case 'delete': {
      const src = base.find((b) => b.id === op.blockId && eqText(b.text, op.before));
      const blk: Block = src
        ? { ...src }
        : { id: op.blockId, kind: 'para', text: op.before, lineStart: 0, lineEnd: 0 };
      const at = baseOrderIndex(base, arr, op.blockId, op.line);
      arr.splice(at, 0, blk);
      // 后继块若在 base 有对应，gap 一并还原（删除时它并吞了被删块的分隔符，双重 gap 会多出空行）
      const next = arr[at + 1];
      if (src && next) {
        const nb = base.find((b) => b.id === next.id);
        if (nb) next.gap = nb.gap;
      }
      return arr;
    }
    case 'swap': {
      // 撤回 = 再换一次（自逆）
      const i = locateSwapBlock(arr, op.id, op.blockId, op.firstA, op.a);
      const j = locateSwapBlock(arr, op.id, op.otherId ?? '', op.firstB, op.b);
      if (i === j) throw new Error(`rejectOp: op ${op.id} 校验失败（同块自换）`);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
      return arr;
    }
  }
}

/** swap 定位：id+首行文本精确命中优先；否则行号邻近的首行匹配。 */
function locateSwapBlock(arr: Block[], opId: string, id: string, first: string, line?: number): number {
  if (id) {
    const byId = arr.findIndex((b) => b.id === id);
    if (byId >= 0 && eqText(arr[byId].text.split('\n', 1)[0] ?? '', first)) return byId;
  }
  const best = bestMatch(arr, first, line, true);
  if (best >= 0) return best;
  throw new Error(`locateSwapBlock: op ${opId} 校验失败：目标块不存在`);
}

/** 恢复/导入：parsed ops（blockId ''）按「行号邻近+文本匹配」重绑到当前块（SPEC §2）。
 *  找不到目标即抛错，由调用方转「以当前文件为新基线」。 */
export function rebindOps(blocks: Block[], ops: Op[]): Op[] {
  return ops.map((op) => {
    switch (op.type) {
      case 'replace':
      case 'insert': {
        const i = bestMatch(blocks, op.after, op.line);
        if (i < 0) throw new Error(`rebindOps: op ${op.id} 找不到目标文本`);
        return { ...op, blockId: blocks[i].id };
      }
      case 'swap': {
        const i = bestMatch(blocks, op.firstA, op.a, true);
        const j = bestMatch(blocks, op.firstB, op.b, true);
        if (i < 0 || j < 0) throw new Error(`rebindOps: op ${op.id} 找不到目标文本`);
        return { ...op, blockId: blocks[i].id, otherId: blocks[j].id };
      }
      case 'note': {
        const line = op.line;
        if (line === undefined) return op;
        const i = blocks.findIndex((b) => b.lineStart <= line && line <= b.lineEnd);
        return i < 0 ? op : { ...op, blockId: blocks[i].id };
      }
      case 'delete':
        return op; // before 不在 cur，靠 line 落位（anchorAt）
    }
  });
}

/** 目标块在 base 中的原位：后继幸存块之前；无后继则前驱幸存块之后；再退化行号/文末。 */
function baseOrderIndex(base: Block[], cur: Block[], blockId: string, hint?: number): number {
  const bi = base.findIndex((b) => b.id === blockId);
  if (bi >= 0) {
    for (let j = bi + 1; j < base.length; j += 1) {
      const k = cur.findIndex((b) => b.id === base[j].id);
      if (k >= 0) return k;
    }
    for (let j = bi - 1; j >= 0; j -= 1) {
      const k = cur.findIndex((b) => b.id === base[j].id);
      if (k >= 0) return k + 1;
    }
  }
  if (hint !== undefined) {
    const k = cur.findIndex((b) => b.lineStart >= hint);
    if (k >= 0) return k;
  }
  return cur.length;
}

/** 文本匹配候选中挑行号最近者（重复文本块消歧：JSONL 同构记录常见）。 */
function bestMatch(arr: Block[], text: string, line?: number, firstLine = false): number {
  let best = -1;
  let dist = Infinity;
  arr.forEach((b, i) => {
    const t = firstLine ? (b.text.split('\n', 1)[0] ?? b.text) : b.text;
    if (!eqText(t, text)) return;
    const d = line === undefined || line <= 0 ? 0 : Math.abs(b.lineStart - line);
    if (d < dist) {
      best = i;
      dist = d;
    }
  });
  return best;
}

/** 定位目标块：id+文本精确命中优先；否则行号邻近的文本匹配。 */
function locate(arr: Block[], opId: string, blockId: string, text: string, line?: number): number {
  const byId = arr.findIndex((b) => b.id === blockId);
  if (byId >= 0 && eqText(arr[byId].text, text)) return byId;
  const best = bestMatch(arr, text, line);
  if (best >= 0) return best;
  throw new Error(`locate: op ${opId} 校验失败：目标块不存在（blockId=${blockId}）`);
}

/** 落位：op.line（当前文档 1-based 行号）优先；0/缺失或 arr 未建行号时退回邻近 op 锚块启发式。 */
function anchorAt(arr: Block[], ops: Op[], k: number, afterFirst: boolean, line = ops[k].line): number {
  if (line !== undefined && line > 0 && arr.some((b) => b.lineStart > 0)) {
    const i = arr.findIndex((b) => b.lineStart >= line);
    return i >= 0 ? i : arr.length; // 行号越出全文 = 插入点在文末（delLine 文末回退为末行+1）
  }
  const hit = neighborAt(arr, ops, k, afterFirst);
  return hit >= 0 ? hit : arr.length;
}

function neighborAt(arr: Block[], ops: Op[], k: number, afterFirst: boolean): number {
  const back = () => {
    for (let i = k - 1; i >= 0; i--) {
      const j = arr.findIndex((b) => b.id === ops[i].blockId);
      if (j >= 0) return j + 1;
    }
    return -1;
  };
  const fwd = () => {
    for (let i = k + 1; i < ops.length; i++) {
      const j = arr.findIndex((b) => b.id === ops[i].blockId);
      if (j >= 0) return j;
    }
    return -1;
  };
  return afterFirst ? firstNonNeg(back, fwd) : firstNonNeg(fwd, back);
}

const firstNonNeg = (f: () => number, g: () => number) => {
  const v = f();
  return v >= 0 ? v : g();
};

/** cur + delete 墓碑（按 base 序落位）合并为展示块序：setRevisions 的输入（§4.1 幽灵块协议）。
 *  v1.2：hidden 的删除不再立碑（用户已确认）；withdrawing 的删除仍立碑（预览「将恢复」）。
 *  插入块不回推 prevBase 到 bi-1 之外的语义：插入块占的是「位置」不是「基块」，
 *  prevBase 记为 bi-1，否则紧邻插入块之后的墓碑会被跳过（E2E 抓到：insert+delete 组合丢幽灵）。 */
export function withTombstones(base: Block[], cur: Block[], ops: Op[]): Block[] {
  const delIds = new Set(
    ops.filter((o) => o.type === 'delete' && o.state !== 'hidden').map((o) => o.blockId),
  );
  if (!delIds.size) return cur;
  const baseIdx = new Map(base.map((b, i) => [b.id, i] as const));
  const tombs = (from: number, to: number): Block[] => base.slice(from, to).filter((b) => delIds.has(b.id));
  const out: Block[] = [];
  let prevBase = -1;
  for (const cb of cur) {
    const baseBi = baseIdx.get(cb.id);
    const bi = baseBi ?? prevBase + 1; // 新块视作前驱之后
    out.push(...tombs(prevBase + 1, bi));
    out.push(cb);
    prevBase = baseBi === undefined ? bi - 1 : bi; // 插入块只占位置不占基块：其位上的墓碑留给后继窗口
  }
  out.push(...tombs(prevBase + 1, base.length));
  return out;
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim();

/** 归一化文本相似度：字符级公共子序列长度 / 最大长度。 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (l.length === 0) return 1;
  const upper = s.length / l.length;
  if (upper <= 0.6) return upper; // LCS 长度不超短串，上界不达阈值即免算
  let prev = new Uint32Array(s.length + 1);
  let curr = new Uint32Array(s.length + 1);
  for (let i = 1; i <= l.length; i++) {
    for (let j = 1; j <= s.length; j++)
      curr[j] =
        l.charCodeAt(i - 1) === s.charCodeAt(j - 1) ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    [prev, curr] = [curr, prev.fill(0)];
  }
  return prev[s.length] / l.length;
}
