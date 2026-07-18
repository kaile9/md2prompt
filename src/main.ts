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
import { parseDoc, serializeBlocks, type Block, type DocFile, type DocState } from './core/ir';
import { withTombstones } from './core/changes';
import { indentStrip } from './core/indent';
import { buildPrompt, getLastAction, getSaveState, restoreFromPrompt, setIndentWrite, store } from './core/state';
import * as fs from './core/fsio';
import { hashText } from './core/hash';
import { parsePrompt } from './core/promptmd';
import { destroyEditor, mountEditor, moveBlock, peekText, runInline, scrollEditorBlock, setRevisions, currentBlockIndex, type EditorHooks } from './editor/editor';
import { destroySource, mountSource, scrollSourceTo } from './editor/sourcemode';
import { renderStatic, type ResolveImage } from './editor/static';
import { mountVirtualList, openRecordEditor } from './editor/records';
import { closeFloater, floatRoot, openFloater, registerCloser } from './editor/floater';

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

/* ---------- 节文本重解析：id 继承（同文配对 → 原位同 kind 继承 → 新发），保 diff 账 ---------- */

let idSeq = 0;

function reparseSection(text: string, old: Block[]): Block[] {
  const fresh = parseDoc(text, 'md');
  const used = new Set<number>();
  const idOf = fresh.map((f) => {
    const i = old.findIndex((o, oi) => !used.has(oi) && o.kind === f.kind && o.text === f.text);
    if (i < 0) return undefined;
    used.add(i);
    return old[i].id;
  });
  let oi = 0;
  fresh.forEach((f, fi) => {
    if (idOf[fi]) return;
    while (oi < old.length && used.has(oi)) oi++;
    if (oi < old.length && old[oi].kind === f.kind) {
      idOf[fi] = old[oi].id;
      used.add(oi);
    }
  });
  return fresh.map((f, fi) => ({ ...f, id: idOf[fi] ?? `n${++idSeq}` }));
}

/* ---------- 图片解析（缓存 + 异步回填，§4.1） ---------- */

const imgCache = new Map<string, string>();
const imageResolver: ResolveImage = (src, img) => {
  if (/^(?:https?:|data:|blob:)/i.test(src)) {
    img.src = src;
    return;
  }
  const hit = imgCache.get(src);
  if (hit) {
    img.src = hit;
    return;
  }
  void fs.resolveImage(src).then((url) => {
    if (url) {
      imgCache.set(src, url);
      img.src = url;
    }
  });
};

/* ---------- 节渲染与活动节管理 ---------- */

let sections: Section[] = [];
let activeIdx = -1;
let editingFile: DocState['file'] | null = null; // 编辑器当前承载的文档身份（flush 门禁）
let unmountVirtual: (() => void) | null = null;
let pendingMoves: { first: string; from: [number, number] }[] = []; // Alt+↑/↓ 队列，flush 时统一入账
/** 视图模式：渲染（默认主战场）/ 源码 / 分屏对比（左源码右实时渲染预览）。 */
let viewMode: 'render' | 'source' | 'split' = 'render';

/** 统一销毁活动节编辑器（渲染=PM，源码/分屏=CM），返回最终文本。 */
function destroyActive(): string | undefined {
  return viewMode === 'render' ? destroyEditor() : destroySource();
}

const docEl = (): HTMLElement => {
  const el = document.getElementById('doc');
  if (!el) throw new Error('#doc 缺失');
  return el;
};

/** flush 文本入账：以「捕获时的旧边界」切换（编辑期内块数可变，边界以 PM 现场为准）。 */
function applySectionText(idx: number, text: string): void {
  const st = store.state;
  const prev = sections[idx];
  if (!st || !prev) return;
  const old = st.cur.slice(prev.start, prev.end);
  const next = reparseSection(text, old);
  if (next.length && old.length) next[0] = { ...next[0], gap: old[0].gap }; // 首块 gap 归还原位
  store.dispatch({ type: 'patchCur', cur: [...st.cur.slice(0, prev.start), ...next, ...st.cur.slice(prev.end)] });
  if (pendingMoves.length) {
    // 防抖窗内连发移动按块合并：同 first 只记一笔（取首条 from；to 以 flush 后现行位置为准，M2）
    const merged = new Map<string, { first: string; from: [number, number] }>();
    for (const mv of pendingMoves) if (!merged.has(mv.first)) merged.set(mv.first, mv);
    pendingMoves = [];
    const st2 = store.state;
    for (const mv of merged.values()) {
      // 就近消歧：同首行文本者取离 from 最近（移回原位的由 moveAlive 自然销账）
      let best: Block | undefined;
      let dist = Infinity;
      for (const b of st2?.cur ?? []) {
        if (b.text.split('\n', 1)[0] !== mv.first) continue;
        const d = Math.abs(b.lineStart - mv.from[0]);
        if (d < dist) {
          best = b;
          dist = d;
        }
      }
      if (st2 && best) store.dispatch({ type: 'recordMove', blockId: best.id, first: mv.first, from: mv.from, to: best.lineStart });
    }
  }
}

/** 预 flush：load/new/恢复前调用——旧文档的尾部输入先入账，再允许切换。 */
function flushEditor(): void {
  const t = destroyActive();
  if (t !== undefined && activeIdx >= 0 && store.state?.file.kind === 'md') applySectionText(activeIdx, t);
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
  if (t !== undefined && activeIdx >= 0) applySectionText(activeIdx, t);
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
    renderPreview: (el) => {
      el.textContent = quote ?? (existing?.type === 'note' ? existing.quote : undefined) ?? '';
    },
    onSave: (text) => {
      const note = text.trim();
      if (!note) return;
      if (existing) store.dispatch({ type: 'editNote', id: existing.id, note, ...(quote !== undefined ? { quote } : {}) });
      else store.dispatch({ type: 'addNote', blockId: b.id, note, ...(quote ? { quote } : {}) });
    },
  });
}

/** destroy 后按原位重绘（annotateFlow 的 flush 收尾）。 */
function restructurePaint(): void {
  const startId = sections[activeIdx]?.startId;
  sections = splitSections(store.state?.cur ?? []);
  const idx = Math.max(0, sections.findIndex((s) => s.startId === startId));
  paintSections(idx);
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
    renderPreview: (el) => {
      el.textContent = op.quote ?? '';
    },
    onSave: (text) => {
      const note = text.trim();
      if (note) store.dispatch({ type: 'editNote', id: op.id, note });
    },
  });
});

const editorHooks: EditorHooks = {
  onChange: (text) => applySectionText(activeIdx, text),
  onMoveBlock: (_dir, _idx, first) => {
    const st = store.state;
    if (!st || !first) return;
    const b = st.cur.find((x) => x.text.split('\n', 1)[0] === first);
    if (!b) return; // 找不到块不入账（防 from="0-0" 幻影 move）
    pendingMoves.push({ first, from: [b.lineStart, b.lineEnd] });
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
  const srcHooks = {
    onChange: (text: string) => applySectionText(activeIdx, text),
    onCursor: (line: number, col: number) => {
      cursorEl.textContent = S.cursorPos((st.cur[s.start]?.lineStart ?? 1) + line - 1, col);
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
  } else if (viewMode === 'source') {
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
  if (finalText !== undefined && st?.file.kind === 'md' && st.file === editingFile && activeIdx >= 0)
    applySectionText(activeIdx, finalText);
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
  if (finalText !== undefined && activeIdx >= 0) applySectionText(activeIdx, finalText);
  sections = splitSections(store.state?.cur ?? []);
  const idx = Math.max(0, sections.findIndex((s) => s.startId === startId));
  paintSections(idx);
}

/** 撤回/复活后重载：cur 已为准（丢弃编辑器旧文本，防未落盘输入盖过回滚结果，§2）。 */
function restructure(flush: boolean): void {
  const startId = sections[activeIdx]?.startId;
  const finalText = destroyActive();
  if (flush && finalText !== undefined && activeIdx >= 0) applySectionText(activeIdx, finalText);
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
      const rec: Block = { id: `n${++idSeq}`, kind: 'record', text: next, lineStart: 0, lineEnd: 0, meta, gap: '\n' };
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

/** 分屏双侧滚动比例同步：scrollTop/可滚区间 映射，rAF 解回声（A→B 触发的 B scroll 不回写 A）。 */
function syncSplit(a: HTMLElement, b: HTMLElement): void {
  let lock = false;
  const link = (src: HTMLElement, dst: HTMLElement): void => {
    src.addEventListener(
      'scroll',
      () => {
        if (lock) return;
        lock = true;
        const max = src.scrollHeight - src.clientHeight;
        dst.scrollTop = max > 0 ? (src.scrollTop / max) * (dst.scrollHeight - dst.clientHeight) : 0;
        requestAnimationFrame(() => {
          lock = false;
        });
      },
      { passive: true },
    );
  };
  link(a, b);
  link(b, a);
}

document.addEventListener('md2p-jump', (ev) => {
  const d = (ev as CustomEvent<{ blockId: string; line: number | null }>).detail;
  jumpToBlock(d.blockId, d.line);
});

/* ---------- 光标行列（顶栏）与打印（页眉源文件时间 · 页脚导出时间） ---------- */

const cursorEl = document.getElementById('cursor-pos') as HTMLElement;
let docMtime: number | undefined;

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

async function loadDocFile(f: DocFile): Promise<void> {
  flushEditor(); // flush 纪律：切换前旧文档尾部先入账
  imgCache.clear();
  docMtime = f.mtime; // 打印页眉「源文件完成时间」
  // 写入档开启时先剥缩进：内存态与 op 载荷永不含全角空格缩进（协议配对在原文哈希上做，不受影响）
  const raw = currentPrefs().indent === 'write' && f.kind === 'md' ? indentStrip(f.text) : f.text;
  const blocks = parseDoc(raw, f.kind);
  store.dispatch({ type: 'load', file: { name: f.name, kind: f.kind }, cur: blocks });
  const prompt = await fs.findSiblingPrompt(f.name);
  if (!prompt) return;
  try {
    const { meta } = parsePrompt(prompt);
    if (meta.docHash !== (await hashText(f.text))) {
      const pick = await choice(S.hashMismatch, [S.restoreNewBase, S.restoreTry, S.restoreIgnore]);
      if (pick === 2) {
        store.dispatch({ type: 'suppressPrompt' }); // 忽略：不覆写既有 Prompt.md
        return;
      }
      if (pick !== 1) return; // 新基线（默认载入即基线）
    }
  } catch {
    store.dispatch({ type: 'suppressPrompt' }); // 解析失败的既有 Prompt.md 不被覆写（可能手改出错）
    return;
  }
  try {
    const { base, ops } = restoreFromPrompt({ name: f.name, kind: f.kind }, blocks, prompt);
    store.dispatch({ type: 'load', file: { name: f.name, kind: f.kind }, cur: blocks, base, ops });
    toast(S.restored);
  } catch {
    toast(S.restoreFailed); // 哈希匹配但恢复失败也必须告知（§2）
  }
}

async function openFlow(): Promise<void> {
  const f = await fs.openDoc();
  if (f) await loadDocFile(f);
}

function newFlow(): void {
  flushEditor(); // flush 纪律
  fs.resetDoc();
  imgCache.clear();
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
    registerCloser(() => done(options.length - 1));
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
mountToolbar({ annotate: () => annotateFlow(currentBlockIndex(), fabQuote ?? undefined) });
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
  bold: () => runInline('bold'),
  italic: () => runInline('italic'),
  strike: () => runInline('strike'),
  annotate: () => annotateFlow(currentBlockIndex(), fabQuote ?? undefined), // 带选区（评审 M2）
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
      if (a !== 'sourceToggle' && viewMode !== 'render') continue; // 源码/分屏：除切模式键外放行给 CM（v1.5.1 修复 return 截断）
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
  if (t !== undefined && activeIdx >= 0) applySectionText(activeIdx, t); // 换态前尾部入账
  const startId = sections[activeIdx]?.startId;
  sections = splitSections(store.state?.cur ?? []);
  paintSections(Math.max(0, sections.findIndex((s) => s.startId === startId)));
});
fileNameEl.textContent = S.noFile;
document.getElementById('open-btn')?.addEventListener('click', () => void openFlow());
document.getElementById('new-btn')?.addEventListener('click', newFlow);
store.subscribe(onState);
// 重启恢复须用户手势（requestPermission 链）；已有文档时不覆盖用户意图
window.addEventListener(
  'pointerdown',
  () =>
    void (async () => {
      if (store.state) return;
      const f = await fs.restoreDoc();
      if (f) await loadDocFile(f);
    })(),
  { once: true },
);

const empty = document.createElement('p');
empty.className = 'placeholder';
empty.textContent = `${S.emptyPlaceholder} · ${S.emptyHint}`;
docEl().appendChild(empty);

/** 自动化/调试钩子：e2e 与 K3 级 debug 的直接入口（生产无副作用）。 */
(window as unknown as { __md2p: object }).__md2p = { store, loadDocFile, parseDoc, renderDoc, buildPrompt };
