// SPDX-License-Identifier: MPL-2.0
/** main.ts — 装配（SPEC §7）：打开/新建/恢复、节模式、JSONL 模式、store 接线。
 *  数据流：fsio ⇄ store ⇄ {活动节 editor | 静态节 static | 虚拟列表 records} + panels。
 *  flush 纪律：编辑器文本只在「文档未切换」时入账——load/new 前由调用方预 flush（跨文档污染防线）。 */
import './styles.css';
import { S } from './ui/strings';
import { applyPrefs, currentPrefs, mountSettings, onPrefsChange } from './ui/settings';
import { mountPanels } from './ui/panels';
import { centerOn, flashEl, mountProgress, refreshProgress, setProgressMode } from './ui/progress';
import { mountToolbar, showSelection } from './ui/toolbar';
import { SC_DEFAULT, comboOf, type ScAction } from './ui/shortcuts';
import { parseDoc, serializeBlocks, reparseSection, newBlockId, type Block, type DocFile, type DocState } from './core/ir';
import { withTombstones } from './core/changes';
import { project } from './core/diffview';
import { indentStrip } from './core/indent';
import { buildPrompt, getLastAction, getSaveState, onPromptError, restoreFromPrompt, setIndentWrite, store } from './core/state';
import * as fs from './core/fsio';
import { hashText } from './core/hash';
import { parsePrompt } from './core/promptmd';
import { destroyEditor, mountEditor, moveBlock, peekText, runInline, runLink, scrollEditorBlock, setRevisions, currentBlockIndex, type EditorHooks } from './editor/editor';
import { destroySource, mountSource, peekSource, scrollSourceTo, sourceTopLine, scrollSourceToFrac, runInlineSrc, runLinkSrc, type SourceHooks } from './editor/sourcemode';
import { renderStatic, type ResolveImage } from './editor/static';
import { mountVirtualList, openRecordEditor } from './editor/records';
import { closeFloater, floatRoot, openFloater, openPopover, registerCloser, releaseCloser } from './editor/floater';

/* ---------- 节切分（§4.1 阈值：300KB / 2000 行，h2 优先 h1 兜底） ---------- */

interface Section {
  start: number;
  end: number; // cur 块下标 [start, end)
  startId: string; // 节首块 id：边界漂移后按 id 重定位（编辑可增删标题）
}

const SECTION_BYTES = 300_000;
const SECTION_LINES = 2000;

function splitSections(blocks: Block[]): Section[] {
  const mk = (start: number, end: number): Section => ({ start, end, startId: blocks[start]?.id ?? '' });
  const bytes = blocks.reduce((n, b) => n + b.text.length, 0);
  if (bytes < SECTION_BYTES && (blocks.at(-1)?.lineEnd ?? 0) < SECTION_LINES) return [mk(0, blocks.length)];
  for (const level of [2, 1]) {
    const starts = blocks.flatMap((b, i) => (b.kind === 'heading' && b.meta?.level === level ? [i] : []));
    if (starts.length) {
      const bounds = [0, ...starts.filter((i) => i > 0), blocks.length];
      return bounds.slice(0, -1).map((s, k) => mk(s, bounds[k + 1] ?? blocks.length));
    }
  }
  return [mk(0, blocks.length)];
}

/** 节源文：首块 gap 归零（编辑器/静态渲染不吃前导分隔符）。 */
const sliceText = (blocks: Block[]): string => serializeBlocks(blocks.map((b, i) => (i === 0 ? { ...b, gap: '' } : b)));

/* ---------- 图片解析（fsio 唯一缓存 + 异步回填，§4.1；A-5：main 侧重复缓存已撤） ---------- */

const imageResolver: ResolveImage = (src, img) => {
  if (/^(?:https?:|data:|blob:)/i.test(src)) {
    img.src = src;
    return;
  }
  void fs.resolveImage(src).then((url) => {
    if (url) img.src = url; // fsio.imgCache 命中即时，未命中走句柄读盘并缓存；revoke 职责同在 fsio
  });
};

/* ---------- 节渲染与活动节管理 ---------- */

let sections: Section[] = [];
let activeIdx = -1;
let editingFile: DocState['file'] | null = null; // 编辑器当前承载的文档身份（flush 门禁）
let unmountVirtual: (() => void) | null = null;
let pendingSwaps: { first: string; otherFirst: string }[] = []; // Alt+↑/↓ 调换队列（PM 现场首行纯文本对），flush 时逐步模拟入账为 swap
let editorChangesPaused = false; // 文件/目录选择期间屏蔽旧编辑器的 200ms 尾回调
let editorPauseGeneration = 0; // 重叠 open 只允许最后一次流程解除门禁
let srcCursor = { line: 1, col: 1 }; // 源码/分屏的 CM 光标（行列显示与调换锚点共用）
/** 视图模式：渲染（默认主战场）/ 源码 / 分屏对比（左源码右实时渲染预览）。 */
let viewMode: 'render' | 'source' | 'split' = 'render';

/** 统一销毁活动节编辑器（渲染=PM，源码/分屏=CM；XML 恒为 CM），返回最终文本。 */
function destroyActive(): string | undefined {
  if (store.state?.file.kind === 'xml') return destroySource();
  return viewMode === 'render' ? destroyEditor() : destroySource();
}

const docEl = (): HTMLElement => {
  const el = document.getElementById('doc');
  if (!el) throw new Error('#doc 缺失');
  return el;
};

/** PM 现场首行纯文本 → 匹配块：块首行（代码块跳过围栏行）经 project 投影后比对。 */
const plainFirstOf = (b: Block): string => {
  const lines = b.text.split('\n');
  const fl = lines[0] ?? '';
  const src = /^(`{3,}|~{3,})/.test(fl) ? (lines[1] ?? fl) : fl;
  return project(src).plain;
};

/** Alt+↑/↓ 队列 → swap 对：在 flush 前旧序上逐步模拟（连发移动每步邻居不同，合并会记错账）。
 *  消歧靠相邻约束：被移块与对调块在模拟序中必须相邻；对不上宁可不记（幻影 swap 会毁恢复账）。
 *  已知边界：XML 卡（多块并一节点的区域）被 Alt 移动时只记到区域首块，恢复近似（SPEC §9 备案）。 */
function resolvePendingSwaps(preCur: Block[]): { uid: string; lid: string }[] {
  const sim = [...preCur];
  const pairs: { uid: string; lid: string }[] = [];
  for (const { first, otherFirst } of pendingSwaps) {
    let found: { i: number; j: number } | undefined;
    for (let i = 0; i < sim.length && !found; i++) {
      if (plainFirstOf(sim[i]) !== first) continue;
      for (const j of [i - 1, i + 1])
        if (j >= 0 && j < sim.length && plainFirstOf(sim[j]) === otherFirst) {
          found = { i, j };
          break;
        }
    }
    if (!found) continue;
    const { i, j } = found;
    [sim[i], sim[j]] = [sim[j], sim[i]];
    pairs.push({ uid: sim[Math.min(i, j)].id, lid: sim[Math.max(i, j)].id }); // 记录时居 a 侧者在前
  }
  pendingSwaps = [];
  return pairs;
}

/** flush 文本入账：以「捕获时的旧边界」切换（编辑期内块数可变，边界以 PM 现场为准）。 */
function applySectionText(idx: number, text: string): void {
  const st = store.state;
  const prev = sections[idx];
  if (!st || !prev) return;
  const preCur = st.cur; // flush 前旧序（swap 模拟起点）
  const old = st.cur.slice(prev.start, prev.end);
  const next = reparseSection(text, old);
  if (next.length && old.length) next[0] = { ...next[0], gap: old[0].gap }; // 首块 gap 归还原位
  store.dispatch({ type: 'patchCur', cur: [...st.cur.slice(0, prev.start), ...next, ...st.cur.slice(prev.end)] });
  if (pendingSwaps.length) {
    const pairs = resolvePendingSwaps(preCur);
    const st2 = store.state;
    for (const { uid, lid } of pairs) {
      const U = st2?.cur.find((b) => b.id === uid);
      const L = st2?.cur.find((b) => b.id === lid);
      if (!U || !L) continue;
      store.dispatch({
        type: 'recordSwap',
        blockId: U.id,
        otherId: L.id,
        a: U.lineStart,
        b: L.lineStart,
        firstA: U.text.split('\n', 1)[0] ?? '',
        firstB: L.text.split('\n', 1)[0] ?? '',
      });
    }
  }
}

/** XML 全文入账（单 code 块承载，id 继承 → diff 为整块 replace；审查 B1：XML 不再经 md 重解析碎块）。 */
function applyXmlText(text: string): void {
  const st = store.state;
  if (!st || st.file.kind !== 'xml') return;
  const prev = st.cur[0];
  if (prev && prev.text === text) return; // 无变化不入账（防抖尾与切换前 flush 幂等）
  const block: Block = { id: prev?.id ?? newBlockId(), kind: 'code', text, gap: '', lineStart: 0, lineEnd: 0, meta: { lang: 'xml' } };
  store.dispatch({ type: 'patchCur', cur: [block] });
}

/** 统一 flush 入口：md 走节重解析，xml 走单块。 */
function applyEditedText(idx: number, text: string): void {
  if (store.state?.file.kind === 'xml') applyXmlText(text);
  else applySectionText(idx, text);
}

/** 预 flush：load/new/恢复前调用——旧文档的尾部输入先入账，再允许切换。 */
function flushEditor(destroy = true): void {
  const t = destroy ? destroyActive() : viewMode === 'render' ? peekText() : peekSource();
  const k = store.state?.file.kind;
  if (t !== undefined && activeIdx >= 0 && (k === 'md' || k === 'xml')) applyEditedText(activeIdx, t);
}

function annotateFlow(blockIndex: number, quote?: string): void {
  // 防抖窗内 PM 节点序与 cur 可能未同步：先 flush 再取块。优先非破坏性 peek
  // （批注是高频操作，destroy+remount 会清空撤销历史，评审 M3）；未就绪才走销毁兜底
  let t: string | undefined;
  let remount = false;
  if (viewMode !== 'render') {
    t = destroySource();
    remount = true;
  } else {
    t = peekText();
    if (t === undefined) {
      t = destroyEditor();
      remount = true;
    }
  }
  if (t !== undefined && activeIdx >= 0) applyEditedText(activeIdx, t);
  if (remount) restructurePaint();
  const st = store.state;
  const s = sections[activeIdx];
  const b = st && s ? st.cur[s.start + blockIndex] : undefined;
  if (!b) return;
  // 同块已有 pending 批注 → 编辑模式（批注不设回复/状态，单条覆盖；hidden/预令不算，评审 m3）
  const existing = st?.ops.find((o) => o.type === 'note' && o.blockId === b.id && !o.state);
  openFloater({
    title: `${S.annotate} · ${S.lineLabel(b.lineStart)}`,
    source: existing?.note ?? '',
    kinds: { current: existing?.type === 'note' ? (existing.kind ?? 'request') : 'request' },
    renderPreview: (el) => {
      el.textContent = quote ?? (existing?.type === 'note' ? existing.quote : undefined) ?? '';
    },
    onSave: (text, kind) => {
      const note = text.trim();
      if (!note) return;
      if (existing) store.dispatch({ type: 'editNote', id: existing.id, note, kind, ...(quote !== undefined ? { quote } : {}) });
      else store.dispatch({ type: 'addNote', blockId: b.id, note, kind, ...(quote ? { quote } : {}) });
    },
  });
}

/** 批注入口（BUG 4：三模式可用）：渲染=PM 顶层块序；源码/分屏=CM 选区起点行锚块（quote 来自各自选区上报）。 */
function annotateAction(): void {
  if (viewMode === 'render') return annotateFlow(currentBlockIndex(), fabQuote ?? undefined);
  const st = store.state;
  const s = sections[activeIdx];
  if (!st || !s) return;
  const abs = (st.cur[s.start]?.lineStart ?? 1) + srcCursor.line - 1;
  const i = st.cur.findIndex((b, bi) => bi >= s.start && bi < s.end && b.lineStart <= abs && abs <= b.lineEnd);
  if (i >= 0) annotateFlow(i - s.start, fabQuote ?? undefined);
}

/** destroy 后按原位重绘（annotateFlow 的 flush 收尾）。 */
function restructurePaint(): void {
  const startId = sections[activeIdx]?.startId;
  sections = splitSections(store.state?.cur ?? []);
  const idx = Math.max(0, sections.findIndex((s) => s.startId === startId));
  paintSections(idx);
}

/* ---------- 调换（协议 2.0 swap 显式命令：state 层重排，渲染/源码通吃） ---------- */

/** 当前块（调换起点）：渲染模式取 PM 光标顶层块；源码/分屏取 CM 光标行所在块。 */
function currentBlockRef(): Block | undefined {
  const st = store.state;
  const s = sections[activeIdx];
  if (!st || !s) return undefined;
  if (viewMode === 'render') return st.cur[s.start + currentBlockIndex()];
  const ln = (st.cur[s.start]?.lineStart ?? 1) + srcCursor.line - 1;
  return st.cur.slice(s.start, s.end).find((b) => b.lineStart <= ln && ln <= b.lineEnd);
}

function swapFlow(anchor: HTMLElement): void {
  const st = store.state;
  if (!st || st.file.kind !== 'md') return;
  flushEditor(false); // 非破坏预 flush：行号与块序以最新 cur 为准
  const curBlock = currentBlockRef();
  if (!curBlock) return;
  openPopover(anchor, (body) => {
    const input = document.createElement('input');
    input.className = 'txt';
    input.placeholder = S.swapLinePh;
    input.style.width = '13rem';
    body.appendChild(input);
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      const ln = Number(input.value.trim());
      if (Number.isInteger(ln)) doSwap(curBlock.id, ln);
      body.parentElement?.replaceChildren();
      document.dispatchEvent(new MouseEvent('mousedown'));
    });
    input.focus();
  });
}

/** 执行调换并记录 swap：cur 重排（gap 随块走，自逆一致）→ recordSwap → 编辑器以 cur 为准重载。 */
function doSwap(currentId: string, targetLine: number): void {
  const st = store.state;
  if (!st) return;
  const ia = st.cur.findIndex((b) => b.id === currentId);
  const ib = st.cur.findIndex((b) => b.lineStart <= targetLine && targetLine <= b.lineEnd);
  if (ia < 0 || ib < 0 || ia === ib) return;
  const lo = Math.min(ia, ib);
  const hi = Math.max(ia, ib);
  const next = [...st.cur];
  [next[lo], next[hi]] = [next[hi], next[lo]];
  store.dispatch({ type: 'patchCur', cur: next });
  const st2 = store.state;
  const U = st2?.cur[lo];
  const L = st2?.cur[hi];
  if (!U || !L) return;
  store.dispatch({
    type: 'recordSwap',
    blockId: U.id,
    otherId: L.id,
    a: U.lineStart,
    b: L.lineStart,
    firstA: U.text.split('\n', 1)[0] ?? '',
    firstB: L.text.split('\n', 1)[0] ?? '',
  });
  restructure(false); // cur 已为准（同撤回/复活语义）
}

/* ---------- 选区浮卡与工具轨（批次 4；annotateFlow 承接批注） ---------- */

let fabQuote: string | null = null;

document.addEventListener('md2p-edit-note', (ev) => {
  const id = (ev as CustomEvent<{ id: string }>).detail.id;
  const op = store.state?.ops.find((o) => o.id === id);
  if (!op || op.type !== 'note') return;
  openFloater({
    title: `${S.annotate} · ${op.line ? S.lineLabel(op.line) : ''}`,
    source: op.note,
    kinds: { current: op.kind ?? 'request' },
    renderPreview: (el) => {
      el.textContent = op.quote ?? '';
    },
    onSave: (text, kind) => {
      const note = text.trim();
      if (note) store.dispatch({ type: 'editNote', id: op.id, note, kind });
    },
  });
});

const editorHooks: EditorHooks = {
  onChange: (text) => {
    if (!editorChangesPaused) applyEditedText(activeIdx, text);
  },
  onMoveBlock: (_dir, _idx, first, otherFirst) => {
    if (!first || !otherFirst) return; // 首行缺失（atom 等）：宁可不记（幻影 swap 毁恢复账）
    pendingSwaps.push({ first, otherFirst });
  },
  onAnnotate: (blockIndex, quote) => annotateFlow(blockIndex, quote),
  onSelectText: (text, at) => {
    fabQuote = text;
    showSelection(text && at ? at : null);
  },
  onCursor: (blockIndex, lineOff, col) => {
    const st = store.state;
    const s = sections[activeIdx];
    const b = st && s ? st.cur[s.start + blockIndex] : undefined; // 幽灵块不占节点，序号直读 cur 切片
    cursorEl.textContent = b ? S.cursorPos(b.lineStart + lineOff, col + 1) : '';
  },
  resolveImage: imageResolver,
};

/** 活动节的展示块序：cur 切片 + delete 墓碑（setRevisions 协议，§4.1）。
 *  节尾连续墓碑并入本节（夹在节首之前的归上节）；否则文末删除的幽灵块会被切片切掉。 */
function revisionBlocks(st: DocState, s: Section): Block[] {
  const slice = st.cur.slice(s.start, s.end);
  const display = withTombstones(st.base, st.cur, st.ops);
  const curIds = new Set(st.cur.map((b) => b.id));
  const i1 = display.findIndex((b) => b.id === slice[0]?.id);
  let i2 = display.findIndex((b) => b.id === slice[slice.length - 1]?.id);
  if (i1 < 0 || i2 < i1) return slice;
  while (i2 + 1 < display.length && !curIds.has(display[i2 + 1].id)) i2 += 1;
  return display.slice(i1, i2 + 1);
}

function refreshRevisions(): void {
  const st = store.state;
  if (!st || st.file.kind !== 'md' || activeIdx < 0) return;
  const startId = sections[activeIdx]?.startId;
  sections = splitSections(st.cur); // 块数随编辑变化，边界每次重算并按 id 重定位
  const idx = Math.max(0, sections.findIndex((s) => s.startId === startId));
  const s = sections[idx];
  if (!s) return;
  activeIdx = idx;
  // 分屏预览窗随文本重渲染（修订痕迹属渲染模式主视图，预览窗只保排版）
  // v1.5.1：文本未变不重渲（hide/撤回等轻动作不打断阅读）；重渲按比例恢复滚动位置
  const pv = document.getElementById('split-view');
  if (pv) {
    const slice = st.cur.slice(s.start, s.end);
    const text = sliceText(slice);
    if (pv.dataset.text !== text) {
      pv.dataset.text = text;
      const max = pv.scrollHeight - pv.clientHeight;
      const ratio = max > 0 ? pv.scrollTop / max : 0;
      renderStatic(slice, pv, imageResolver, () => {
        pv.scrollTop = ratio * (pv.scrollHeight - pv.clientHeight);
      });
    }
  }
  if (viewMode !== 'render') return; // 修订痕迹属渲染模式（源码/分屏只保文本与行号）
  const blocks = revisionBlocks(st, s);
  const inSlice = new Set(blocks.map((b) => b.id));
  setRevisions(st.ops.filter((o) => inSlice.has(o.blockId)), blocks);
}

const sectionRevisionCount = (st: DocState, s: Section): number => {
  const ids = new Set(st.cur.slice(s.start, s.end).map((b) => b.id));
  return st.ops.filter((o) => o.state !== 'hidden' && ids.has(o.blockId)).length;
};

function activateInto(sec: HTMLElement, idx: number): void {
  const st = store.state;
  const s = sections[idx];
  if (!st || !s) return;
  activeIdx = idx;
  editingFile = st.file;
  sec.dataset.line = String(st.cur[s.start]?.lineStart ?? 1);
  const srcHooks: SourceHooks = {
    onChange: (text: string) => {
      if (!editorChangesPaused) applyEditedText(activeIdx, text);
    },
    onCursor: (line: number, col: number) => {
      srcCursor = { line, col };
      cursorEl.textContent = S.cursorPos((st.cur[s.start]?.lineStart ?? 1) + line - 1, col);
    },
    onSelectText: (text, at) => {
      fabQuote = text;
      showSelection(text && at ? at : null);
    },
  };
  if (viewMode === 'split') {
    // 分屏对比：左 CM 源码（可编辑），右静态渲染实时预览（随 flush 重渲）；
    // 双侧等高独立滚动 + 比例同步（渲染行高≠源码行高，严格对行不可达，比例同步是最诚实方案）
    const wrap = document.createElement('div');
    wrap.className = 'split-wrap';
    const left = document.createElement('div');
    left.className = 'split-src';
    const right = document.createElement('div');
    right.className = 'split-view';
    right.id = 'split-view';
    wrap.append(left, right);
    sec.appendChild(wrap);
    const slice = st.cur.slice(s.start, s.end);
    mountSource(left, sliceText(slice), srcHooks);
    right.dataset.text = sliceText(slice); // 与 refreshRevisions 的重渲去重口径一致
    renderStatic(slice, right, imageResolver);
    const cm = left.querySelector<HTMLElement>('.cm-scroller');
    if (cm) syncSplit(cm, right);
  } else if (viewMode === 'source' || st.file.kind === 'xml') {
    // 源码模式；XML 恒由源码承载（单 code 块，渲染无意义——审查 B1）
    mountSource(sec, sliceText(st.cur.slice(s.start, s.end)), srcHooks);
  } else {
    mountEditor(sec, sliceText(st.cur.slice(s.start, s.end)), editorHooks);
  }
  refreshRevisions();
}

let paintToken = 0; // 渐进渲染代际：重绘作废旧队列

function paintSections(active: number): void {
  const st = store.state;
  const host = docEl();
  host.textContent = '';
  if (!st) return;
  const token = ++paintToken;
  const secEls = sections.map((s) => {
    const sec = document.createElement('section');
    const n = sectionRevisionCount(st, s);
    if (n > 0) sec.dataset.rev = String(n);
    host.appendChild(sec);
    return sec;
  });
  const renderOne = (i: number): void => {
    const s = sections[i];
    if (i === active) {
      activateInto(secEls[i], i);
      return;
    }
    renderStatic(st.cur.slice(s.start, s.end), secEls[i], imageResolver);
    secEls[i].addEventListener('click', () => activateSection(s.startId));
  };
  // 首屏只同步渲染活动节 ±1（秒开）；其余空闲渐进（12ms 预算/帧），代际作废旧队列
  const done = new Set<number>([active, active - 1, active + 1].filter((i) => i >= 0 && i < sections.length));
  done.forEach(renderOne);
  const idle = window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 16));
  let next = 0;
  const pump = (): void => {
    if (token !== paintToken) return;
    const t0 = performance.now();
    while (next < sections.length && performance.now() - t0 < 12) {
      if (!done.has(next)) renderOne(next);
      next++;
    }
    if (next < sections.length) idle(pump);
  };
  if (sections.length > done.size) idle(pump);
}

/** 结构级重渲染（load/new）。 */
function renderDoc(): void {
  const st = store.state;
  closeFloater();
  unmountVirtual?.();
  unmountVirtual = null;
  const finalText = destroyActive();
  // 尾部 flush（200ms 防抖窗）仅在文档未切换时入账（load/new 已由调用方预 flush，§flush 纪律）
  if (finalText !== undefined && st && st.file.kind !== 'jsonl' && st.file === editingFile && activeIdx >= 0)
    applyEditedText(activeIdx, finalText);
  activeIdx = -1;
  const host = docEl();
  host.textContent = '';
  if (!st) return;
  if (st.file.kind === 'jsonl') {
    const page = document.getElementById('scroller');
    const top = page?.scrollTop ?? 0;
    unmountVirtual = mountVirtualList(host, store.state?.cur ?? [], openRecord);
    const add = document.createElement('button');
    add.className = 'btn';
    add.textContent = S.recordAdd;
    add.addEventListener('click', appendRecord);
    host.appendChild(add);
    if (page) page.scrollTop = top;
    return;
  }
  sections = splitSections(store.state?.cur ?? []);
  paintSections(0);
}

/** 切节（按节首块 id，边界漂移后重定位）：flush 当前节 → 全部重绘（§4.1）。 */
function activateSection(startId: string): void {
  const finalText = destroyActive();
  if (finalText !== undefined && activeIdx >= 0) applyEditedText(activeIdx, finalText);
  sections = splitSections(store.state?.cur ?? []);
  const idx = Math.max(0, sections.findIndex((s) => s.startId === startId));
  paintSections(idx);
}

/** 撤回/复活后重载：cur 已为准（丢弃编辑器旧文本，防未落盘输入盖过回滚结果，§2）。 */
function restructure(flush: boolean): void {
  const startId = sections[activeIdx]?.startId;
  const finalText = destroyActive();
  if (flush && finalText !== undefined && activeIdx >= 0) applyEditedText(activeIdx, finalText);
  sections = splitSections(store.state?.cur ?? []);
  const idx = Math.max(0, sections.findIndex((s) => s.startId === startId));
  paintSections(idx);
}

/* ---------- JSONL 记录 ---------- */

function openRecord(b: Block): void {
  openRecordEditor(
    b,
    (next) => {
      const st = store.state;
      if (!st) return;
      const meta = parseDoc(next, 'jsonl')[0]?.meta;
      store.dispatch({ type: 'patchCur', cur: st.cur.map((x) => (x.id === b.id ? { ...x, text: next, meta } : x)) });
    },
    (note) => store.dispatch({ type: 'addNote', blockId: b.id, note }),
  );
}

function appendRecord(): void {
  openRecordEditor(
    { id: '', kind: 'record', text: '{}', lineStart: 0, lineEnd: 0 },
    (next) => {
      const st = store.state;
      if (!st) return;
      const meta = parseDoc(next, 'jsonl')[0]?.meta;
      const rec: Block = { id: newBlockId(), kind: 'record', text: next, lineStart: 0, lineEnd: 0, meta, gap: '\n' };
      store.dispatch({ type: 'patchCur', cur: [...st.cur, rec] });
    },
    () => undefined,
  );
}

/* ---------- 订阅分发：结构性动作重渲染，轻量动作只刷修订 ---------- */

function onState(): void {
  saveEl.textContent = SAVE_TEXT[getSaveState()];
  const st = store.state;
  fileNameEl.textContent = st?.file.name ?? S.noFile;
  const a = getLastAction();
  if (!st || a === 'load' || a === 'new') cursorEl.textContent = ''; // 换文档即清旧行列（v1.5.1）
  refreshProgress(st);
  syncRail(st);
  if (!st) return;
  if (st.file.kind === 'jsonl') {
    if (a !== 'setSaveState') renderDoc(); // 记录编辑是离散动作，重建虚拟列表
    return;
  }
  if (a === 'load' || a === 'new') renderDoc();
  else if (a === 'withdrawCommit' || a === 'restore') restructure(false); // cur 已变：以 cur 为准重建（§2）
  else refreshRevisions(); // hide/withdraw(预令)/cancel/hideAll/patchCur 等：只刷修订层
}

/* ---------- 跳转（v1.2：blockId 主锚；panels 经 md2p-jump 事件发起；v1.5 统一 centerOn 精确居中） ---------- */

function flashScroll(el: HTMLElement): void {
  centerOn(el);
  flashEl(el);
}

function jumpFallbackLine(line: number): void {
  const host = docEl();
  // 优先精确命中文档块（.blk 带行号徽标）；节容器自身也有 data-line，直接命中会滚动整节
  const blks = [...host.querySelectorAll<HTMLElement>('.blk[data-line]')];
  let target: HTMLElement | undefined =
    blks.find((el) => Number(el.dataset.line) === line) ??
    blks.find((el) => Number(el.dataset.line) > line) ??
    blks.reverse().find((el) => Number(el.dataset.line) < line); // 目标行已删：落前一块，不飞下节（v1.5.1）
  if (!target) {
    target = host.querySelector<HTMLElement>(`[data-line="${line}"]`) ?? undefined;
    if (!target) {
      for (const el of host.querySelectorAll<HTMLElement>('[data-line]')) {
        target = el;
        if (Number(el.dataset.line) >= line) break;
      }
    }
  }
  if (target) flashScroll(target);
}

function jumpToBlock(blockId: string, line: number | null): void {
  const st = store.state;
  // 1) DOM 直查：静态节块、虚拟列表行、编辑器内幽灵块 widget 均带 data-block-id
  //    排除 section：scrollEditorBlock 曾把上次跳转目标的 id 标记在节容器上（hit 证据），
  //    不排除的话二次跳转会命中整节巨块并居中全节（QA F4）
  if (blockId) {
    const direct = docEl().querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"]:not(section)`);
    if (direct) {
      flashScroll(direct);
      return;
    }
  }
  if (!st) return;
  const i = blockId ? st.cur.findIndex((b) => b.id === blockId) : -1;
  if (st.file.kind !== 'md') return; // jsonl 直查必命中（虚拟列表逐行带 id）
  if (viewMode !== 'render') {
    // 源码/分屏：无 PM，按行在 CM 侧落位（分屏右栏命中时上方直查已 return）
    const ln = i >= 0 ? st.cur[i].lineStart : line;
    if (ln == null) return;
    let sIdx = i >= 0 ? sections.findIndex((s) => i >= s.start && i < s.end) : -1;
    if (sIdx < 0)
      sIdx = Math.max(
        0,
        sections.findIndex((s, k) => {
          const a = st.cur[s.start]?.lineStart ?? 1;
          const b = st.cur[(sections[k + 1]?.start ?? st.cur.length) - 1]?.lineEnd ?? a;
          return ln >= a && ln <= b;
        }),
      );
    if (sIdx !== activeIdx) activateSection(sections[sIdx].startId);
    scrollSourceTo(Math.max(1, ln - (st.cur[sections[sIdx].start]?.lineStart ?? 1) + 1));
    return;
  }
  if (i < 0) {
    if (line != null) jumpFallbackLine(line);
    return;
  }
  const sIdx = sections.findIndex((s) => i >= s.start && i < s.end);
  if (sIdx < 0) return;
  if (sIdx !== activeIdx) activateSection(sections[sIdx].startId); // 跨节：先切节（编辑器创建后挂起滚动）
  scrollEditorBlock(i - sections[sIdx].start, blockId); // 活动节内非幽灵序 → PM 顶层子节点
}

/** 工具轨只在「md + 渲染模式」可见（JSONL 走记录编辑器；源码/分屏无 PM 命令目标）。 */
function syncRail(st: DocState | null): void {
  const rail = document.getElementById('tool-rail');
  if (rail) rail.hidden = !st || st.file.kind !== 'md' || viewMode !== 'render';
}

/** 分屏双侧滚动块锚同步（BUG 3）：左 CM 行 ↔ 右 .blk[data-line]，对应块顶对齐 + 块内比例插值。
 *  比例同步是「各行等高」的谎（渲染行高≠源码行高）；块锚是诚实方案：文本块在哪里就对到哪里。
 *  块行跨 = 下一块起始行差（末块取 1）；rAF 解回声。 */
function syncSplit(left: HTMLElement, right: HTMLElement): void {
  const secStartLine = (): number => {
    const s = sections[activeIdx];
    return (s && store.state?.cur[s.start]?.lineStart) || 1;
  };
  const blks = (): HTMLElement[] => [...right.querySelectorAll<HTMLElement>('.blk[data-line]')];
  const spanOf = (el: HTMLElement, next?: HTMLElement): number =>
    next ? Math.max(1, Number(next.dataset.line) - Number(el.dataset.line)) : 1;
  let lock = false;
  const guard = (fn: () => void): void => {
    if (lock) return;
    lock = true;
    fn();
    requestAnimationFrame(() => {
      lock = false;
    });
  };
  left.addEventListener(
    'scroll',
    () =>
      guard(() => {
        const t = sourceTopLine();
        if (!t) return;
        const abs = secStartLine() + t.line - 1;
        const els = blks();
        let target: HTMLElement | undefined;
        for (const el of els) {
          if (Number(el.dataset.line) <= abs) target = el;
          else break;
        }
        target ??= els[0];
        if (!target) return;
        const i = els.indexOf(target);
        const span = spanOf(target, els[i + 1]);
        const frac = Math.min(1, Math.max(0, (abs - Number(target.dataset.line)) / span));
        const rr = right.getBoundingClientRect();
        const er = target.getBoundingClientRect();
        right.scrollTop = er.top - rr.top + right.scrollTop + frac * er.height;
      }),
    { passive: true },
  );
  right.addEventListener(
    'scroll',
    () =>
      guard(() => {
        const els = blks();
        const top = right.getBoundingClientRect().top;
        for (let k = 0; k < els.length; k++) {
          const r = els[k].getBoundingClientRect();
          if (r.bottom <= top) continue;
          const frac = r.height > 0 ? Math.min(1, Math.max(0, (top - r.top) / r.height)) : 0;
          const abs = Number(els[k].dataset.line) + frac * spanOf(els[k], els[k + 1]);
          scrollSourceToFrac(abs - secStartLine() + 1, frac);
          break;
        }
      }),
    { passive: true },
  );
}

document.addEventListener('md2p-jump', (ev) => {
  const d = (ev as CustomEvent<{ blockId: string; line: number | null }>).detail;
  jumpToBlock(d.blockId, d.line);
});

/* ---------- 光标行列（顶栏）与打印（页眉源文件时间 · 页脚导出时间） ---------- */

const cursorEl = document.getElementById('cursor-pos') as HTMLElement;
let docMtime: number | undefined;
let loadGeneration = 0;

const fmtDT = (t: number): string => {
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

document.addEventListener('md2p-print', () => {
  if (!store.state) return;
  (document.getElementById('print-head') as HTMLElement).textContent = S.printHeadFmt(fmtDT(docMtime ?? Date.now()));
  (document.getElementById('print-foot') as HTMLElement).textContent = S.printFootFmt(fmtDT(Date.now()));
  window.print();
});

/* ---------- 打开 / 新建 / 恢复（§6） ---------- */

async function loadDocFile(f: DocFile, currentFlushed = false, generation = ++loadGeneration): Promise<void> {
  if (generation !== loadGeneration) return;
  if (currentFlushed) destroyActive();
  else flushEditor(); // 恢复/程序载入路径仍负责提交当前编辑器
  docMtime = f.mtime; // 打印页眉「源文件完成时间」
  // 写入档开启时先剥缩进：内存态与 op 载荷永不含全角空格缩进（协议配对在原文哈希上做，不受影响）
  const raw = currentPrefs().indent === 'write' && f.kind === 'md' ? indentStrip(f.text) : f.text;
  const blocks = parseDoc(raw, f.kind);
  // 配对结论出来前不写 Prompt：慢速读取既有记录时，初始 load 不能抢先覆写它。
  store.dispatch({ type: 'load', file: { name: f.name, kind: f.kind }, cur: blocks, deferPrompt: true });
  let prompt: string | null;
  try {
    prompt = await fs.findSiblingPrompt(f.name);
  } catch {
    if (generation !== loadGeneration) return;
    store.dispatch({ type: 'suppressPrompt' });
    toast(S.restoreFailed);
    return;
  }
  if (generation !== loadGeneration) return;
  if (prompt === null) {
    store.dispatch({ type: 'persistPrompt' });
    return;
  }
  try {
    const { meta } = parsePrompt(prompt);
    const currentHash = await hashText(f.text);
    if (generation !== loadGeneration) return;
    if (meta.docHash !== currentHash) {
      const pick = await choice(S.hashMismatch, [S.restoreNewBase, S.restoreTry, S.restoreIgnore]);
      if (generation !== loadGeneration) return;
      if (pick === 2) {
        store.dispatch({ type: 'suppressPrompt' }); // 忽略：不覆写既有 Prompt.md
        return;
      }
      if (pick !== 1) {
        store.dispatch({ type: 'persistPrompt' }); // 新基线：配对决策完成后才替换旧记录
        return;
      }
    }
  } catch {
    if (generation !== loadGeneration) return;
    store.dispatch({ type: 'suppressPrompt' }); // 解析失败的既有 Prompt.md 不被覆写（可能手改出错）
    return;
  }
  try {
    const { base, ops } = restoreFromPrompt({ name: f.name, kind: f.kind }, blocks, prompt);
    if (generation !== loadGeneration) return;
    store.dispatch({ type: 'load', file: { name: f.name, kind: f.kind }, cur: blocks, base, ops });
    toast(S.restored);
  } catch {
    store.dispatch({ type: 'suppressPrompt' });
    toast(S.restoreFailed); // 哈希匹配但恢复失败也必须告知（§2）
  }
}

async function openFlow(): Promise<void> {
  flushEditor(false); // 文件选择器切换 fsio 目标前先提交 A；取消选择时不销毁当前编辑器
  const generation = ++loadGeneration;
  const pauseGeneration = ++editorPauseGeneration;
  editorChangesPaused = true;
  try {
    const f = await fs.openDoc();
    if (f && generation === loadGeneration) await loadDocFile(f, true, generation);
  } finally {
    if (pauseGeneration === editorPauseGeneration) editorChangesPaused = false;
  }
}

function newFlow(): void {
  loadGeneration++;
  editorPauseGeneration++;
  editorChangesPaused = false;
  flushEditor(); // flush 纪律
  fs.resetDoc();
  docMtime = undefined;
  store.dispatch({ type: 'new' });
  void fs.saveDocAs(''); // 首次保存即定位（§6 新建走 save-as）
}

/** 轻提示：复用 #save-state 短暂显示。 */
let toastTimer = 0;
function toast(msg: string): void {
  saveEl.textContent = msg;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    saveEl.textContent = SAVE_TEXT[getSaveState()];
  }, 2400);
}

function choice(message: string, options: string[]): Promise<number> {
  return new Promise((resolve) => {
    const root = floatRoot('floater');
    root.textContent = '';
    const backdrop = document.createElement('div');
    backdrop.className = 'floater-backdrop';
    const modal = document.createElement('div');
    modal.className = 'floater-modal';
    const p = document.createElement('div');
    p.textContent = message;
    const bar = document.createElement('div');
    bar.className = 'floater-actions';
    const done = (i: number): void => {
      releaseCloser(closer);
      root.textContent = '';
      document.removeEventListener('keydown', onKey, true);
      resolve(i);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(options.length - 1); // Esc = 末项（忽略）
      }
    };
    const closer = (): void => done(options.length - 1);
    registerCloser(closer);
    options.forEach((label, i) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => done(i));
      bar.appendChild(b);
    });
    modal.append(p, bar);
    backdrop.appendChild(modal);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) done(options.length - 1);
    });
    root.appendChild(backdrop);
    document.addEventListener('keydown', onKey, true);
  });
}

/* ---------- 启动 ---------- */

const SAVE_TEXT: Record<fs.SaveState, string> = { saved: S.savedOk, saving: S.saving, failed: S.saveFailed };
const saveEl = document.getElementById('save-state') as HTMLElement;
const fileNameEl = document.getElementById('file-name') as HTMLElement;

applyPrefs();
mountSettings();
mountPanels(store);
mountProgress();
mountToolbar({
  annotate: () => annotateAction(),
  swap: (anchor) => swapFlow(anchor),
  inline: (a) => (viewMode === 'render' ? runInline(a) : runInlineSrc(a)),
  link: (href) => (viewMode === 'render' ? runLink(href) : runLinkSrc(href)),
});
syncRail(store.state); // 初始无文档即隐藏工具轨
setProgressMode(currentPrefs().progress);
setIndentWrite(currentPrefs().indent === 'write'); // 首行缩进·写入文档：启动同步 + 设置变更同步
onPrefsChange((p) => {
  setIndentWrite(p.indent === 'write');
  setProgressMode(p.progress);
});

/** 侧栏拖拽调宽（持久化 localStorage；双击折叠由面板既有按钮承担）。 */
function resizable(id: string, key: string, min: number, max: number, leftEdge: boolean): void {
  const el = document.getElementById(id);
  if (!el) return;
  const saved = Number(localStorage.getItem(key));
  if (saved >= min && saved <= max) el.style.width = `${saved}px`;
  const grip = document.createElement('div');
  grip.className = 'resize-grip';
  grip.style[leftEdge ? 'left' : 'right'] = '0';
  el.appendChild(grip);
  grip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = el.getBoundingClientRect().width;
    const move = (ev: MouseEvent): void => {
      const d = leftEdge ? startX - ev.clientX : ev.clientX - startX;
      el.style.width = `${Math.min(max, Math.max(min, startW + d))}px`;
    };
    const up = (): void => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try {
        localStorage.setItem(key, String(Math.round(el.getBoundingClientRect().width)));
      } catch {
        /* 隐私模式静默 */
      }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}
resizable('changes', 'md2prompt.w.changes', 280, 560, true);
resizable('outline', 'md2prompt.w.outline', 160, 360, false);

/* ---------- 快捷键分发（document 捕获阶段先于 PM keymap；设置面板可覆盖组合） ---------- */

const scActions: Record<ScAction, () => void> = {
  bold: () => (viewMode === 'render' ? runInline('bold') : runInlineSrc('bold')),
  italic: () => (viewMode === 'render' ? runInline('italic') : runInlineSrc('italic')),
  strike: () => (viewMode === 'render' ? runInline('strike') : runInlineSrc('strike')),
  annotate: () => annotateAction(), // 带选区（评审 M2；BUG 4 起三模式可用）
  moveUp: () => moveBlock(-1),
  moveDown: () => moveBlock(1),
  sourceToggle: () => document.getElementById('mode-btn')?.click(),
};
document.addEventListener(
  'keydown',
  (ev) => {
    if (!(ev.target as HTMLElement | null)?.closest?.('#doc')) return;
    const p = currentPrefs();
    for (const a of Object.keys(SC_DEFAULT) as ScAction[]) {
      // 源码/分屏：行内格式/批注/切模式可用（BUG 4）；块移动仅渲染模式（PM 命令）
      if (viewMode !== 'render' && a !== 'sourceToggle' && a !== 'annotate' && a !== 'bold' && a !== 'italic' && a !== 'strike') continue;
      if (comboOf(ev) === (p.shortcuts[a] ?? SC_DEFAULT[a])) {
        ev.preventDefault();
        ev.stopPropagation();
        scActions[a]();
        return;
      }
    }
  },
  true,
);

/* ---------- 顶栏图标（不识字的用户也能凭图形认路） ---------- */

const icon = (paths: string): string =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  open: icon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>'),
  new: icon('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z"/><path d="M14 3v6h6"/><path d="M12 12v6M9 15h6"/>'),
  settings: icon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1z"/>'),
};
document.getElementById('open-btn')!.innerHTML = `${ICONS.open}<span>${S.openFile}</span>`;
document.getElementById('new-btn')!.innerHTML = `${ICONS.new}<span>${S.newFile}</span>`;
document.getElementById('settings-btn')!.innerHTML = `${ICONS.settings}<span>${S.settings}</span>`;

/* ---------- 首启引导（一次性 coach marks） ---------- */

function coachIfFirstRun(): void {
  try {
    if (localStorage.getItem('md2prompt.coachSeen')) return;
  } catch {
    return;
  }
  const root = floatRoot('floater');
  const backdrop = document.createElement('div');
  backdrop.className = 'floater-backdrop';
  const modal = document.createElement('div');
  modal.className = 'floater-modal coach-modal';
  modal.innerHTML = `<div class="floater-title">${S.coachTitle}</div>${S.coachSteps
    .map((s, i) => `<div class="coach-step"><span class="coach-no">${i + 1}</span><span>${s}</span></div>`)
    .join('')}<div class="floater-actions"><button class="btn btn-primary" type="button">${S.coachGo}</button></div>`;
  backdrop.appendChild(modal);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) done();
  });
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') {
      document.removeEventListener('keydown', onKey, true);
      done();
    }
  }, true);
  modal.querySelector('button')!.addEventListener('click', done);
  function done(): void {
    root.textContent = '';
    try {
      localStorage.setItem('md2prompt.coachSeen', '1');
    } catch {
      /* 静默 */
    }
  }
  root.appendChild(backdrop);
}
coachIfFirstRun();
// index.html 静态文案集中回填（§1 红线：文案只住 strings.ts；顶栏三钮由上方图标块 innerHTML 接管）
document.getElementById('mode-btn')!.textContent = S.modeSource;
const MODE_CYCLE = [
  ['render', S.modeRender],
  ['source', S.modeSource],
  ['split', S.modeSplit],
] as const;
document.getElementById('mode-btn')!.addEventListener('click', () => {
  if (store.state?.file.kind !== 'md') return; // 模式切换仅 md（JSONL/XML 有专属视图）
  const t = destroyActive();
  const next = MODE_CYCLE[(MODE_CYCLE.findIndex(([m]) => m === viewMode) + 1) % MODE_CYCLE.length][0];
  viewMode = next;
  document.getElementById('mode-btn')!.textContent = MODE_CYCLE.find(([m]) => m === viewMode)![1];
  document.getElementById('mode-btn')!.classList.toggle('on', viewMode !== 'render');
  document.getElementById('page')!.dataset.mode = viewMode; // 分屏放开页宽（CSS 契约）
  syncRail(store.state);
  if (t !== undefined && activeIdx >= 0) applyEditedText(activeIdx, t); // 换态前尾部入账
  const startId = sections[activeIdx]?.startId;
  sections = splitSections(store.state?.cur ?? []);
  paintSections(Math.max(0, sections.findIndex((s) => s.startId === startId)));
});
fileNameEl.textContent = S.noFile;
document.getElementById('open-btn')?.addEventListener('click', () => void openFlow());
document.getElementById('new-btn')?.addEventListener('click', newFlow);
store.subscribe(onState);
// 日记构建/落盘失败可见化（A-3）：与文档保存状态分通道提示，下轮 commit 自动重试
onPromptError(() => toast(S.promptFailed));
// 重启恢复须用户手势（requestPermission 链）；已有文档时不覆盖用户意图
window.addEventListener(
  'pointerdown',
  (event) =>
    void (async () => {
      const target = event.target;
      if (target instanceof Element && target.closest('#open-btn, #new-btn')) return;
      if (store.state) return;
      const generation = ++loadGeneration;
      const f = await fs.restoreDoc();
      if (f && generation === loadGeneration) await loadDocFile(f, false, generation);
    })(),
  { once: true },
);

const empty = document.createElement('p');
empty.className = 'placeholder';
empty.textContent = `${S.emptyPlaceholder} · ${S.emptyHint}`;
docEl().appendChild(empty);

/** 自动化/调试钩子：e2e 与 K3 级 debug 的直接入口（生产无副作用）。 */
(window as unknown as { __md2p: object }).__md2p = { store, loadDocFile, parseDoc, renderDoc, buildPrompt };
