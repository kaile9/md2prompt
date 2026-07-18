import type { Block, Op } from './ir';

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
    // 规模护栏（防粘贴替换冻结主线程）：单对长度积超限跳过；全局评估预算 40 对
    let budget = 40;
    const sim = (i: number, j: number) => {
      if (budget <= 0 || nb[i].length * nc[j].length > 250_000) return false;
      budget -= 1;
      return similarity(nb[i], nc[j]) > 0.6;
    };
    const m = ub.length;
    const n = uc.length;
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
 *  重建的块（dir=1 insert / dir=-1 delete）kind 记为 'para'：Op 冻结类型不带 kind/meta。
 *  返回块的行号未重算，调用方负责 blockLineMap。 */
export function applyOps(base: Block[], ops: Op[], dir: 1 | -1): Block[] {
  const arr = base.map((b) => ({ ...b }));
  const order = ops.map((_, i) => i);
  if (dir === -1) order.reverse();
  for (const k of order) {
    const op = ops[k];
    switch (op.type) {
      case 'note':
        break; // B 类文本不动
      case 'replace': {
        const i = locate(arr, op.id, op.blockId, dir === 1 ? op.before : op.after, op.line);
        arr[i] = { ...arr[i], text: dir === 1 ? op.after : op.before };
        break;
      }
      case 'insert':
        if (dir === 1)
          arr.splice(anchorAt(arr, ops, k, false), 0, { id: op.blockId, kind: 'para', text: op.after, lineStart: 0, lineEnd: 0 });
        else arr.splice(locate(arr, op.id, op.blockId, op.after, op.line), 1);
        break;
      case 'delete':
        if (dir === 1) arr.splice(locate(arr, op.id, op.blockId, op.before, op.line), 1);
        else arr.splice(anchorAt(arr, ops, k, true), 0, { id: op.blockId, kind: 'para', text: op.before, lineStart: 0, lineEnd: 0 });
        break;
      case 'move': {
        // from/to 行号随编辑漂移，位置按锚点近似落位；diffBlocks 不产生 move，仅供显式命令/导入
        const i = arr.findIndex((b) => b.id === op.blockId);
        if (i < 0 || !eqText(arr[i].text.split('\n', 1)[0] ?? '', op.first))
          throw new Error(`applyOps: op ${op.id} 校验失败（blockId=${op.blockId}）`);
        const [blk] = arr.splice(i, 1);
        arr.splice(Math.min(anchorAt(arr, ops, k, dir === -1), arr.length), 0, blk);
        break;
      }
    }
  }
  return arr;
}

/** reject：cur 精确回滚该 op（SPEC §2）。delete/move 按 base 序邻近幸存块落位，保留原块 gap/meta。
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
    case 'move': {
      const i = arr.findIndex((b) => b.id === op.blockId);
      if (i < 0) throw new Error(`rejectOp: op ${op.id} 校验失败（blockId=${op.blockId}）`);
      const [blk] = arr.splice(i, 1);
      arr.splice(baseOrderIndex(base, arr, op.blockId, op.from[0]), 0, blk);
      return arr;
    }
  }
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
      case 'move': {
        const i = bestMatch(blocks, op.first, op.to, true);
        if (i < 0) throw new Error(`rebindOps: op ${op.id} 找不到目标文本`);
        return { ...op, blockId: blocks[i].id };
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
function anchorAt(arr: Block[], ops: Op[], k: number, afterFirst: boolean): number {
  const line = ops[k].line;
  if (line !== undefined && line > 0 && arr.some((b) => b.lineStart > 0)) {
    const i = arr.findIndex((b) => b.lineStart >= line);
    return i >= 0 ? i : arr.length; // 行号越出全文 = 插入点在文末（delLine 文末回退为末行+1）
  }
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
  const hit = afterFirst ? firstNonNeg(back, fwd) : firstNonNeg(fwd, back);
  return hit >= 0 ? hit : arr.length;
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
