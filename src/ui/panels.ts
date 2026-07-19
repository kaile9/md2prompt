// SPDX-License-Identifier: MPL-2.0
import type { DocState, Op } from '../core/ir';
import { buildPrompt, exportText, type Store } from '../core/state';
import { downloadFile, joinPath, promptName } from '../core/fsio';
import { currentPrefs, onPrefsChange } from './settings';
import { S } from './strings';

/** §5 左栏大纲（md 标题树 / JSONL 记录号 / xml 单块）+ 右栏修订面板。
 *  v1.5 改版：页签分栏（修订 / 批注 / 墓碑）；路径行从状态栏迁入（⧉ 复制完整路径，前缀见设置）。
 *  v1.2：接受/拒绝 → 隐藏/撤回（两阶段）；跳转锚 = blockId（行号只做展示与兜底），
 *  经 CustomEvent('md2p-jump') 交 main 落位（编辑器内块无 DOM id，需映射 PM 节点）。
 *  与 state 约定的 Action 词汇：hide/unhide/withdraw/withdrawCommit/cancelWithdraw/restore/hideAll/clearWithdrawn。 */

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

const cut = (s: string, n: number): string => {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const firstLine = (s: string): string => s.split('\n').find(l => l.trim()) ?? '';

/** op.time 已是本地 HH:MM（§3 规则 3）；兼容旧 ISO 串截取。 */
const fmtTime = (t: string): string =>
  /^(\d{1,2}:\d{2})/.exec(t)?.[1] ?? /T(\d{2}:\d{2})/.exec(t)?.[1] ?? '';

function opAnchor(op: Op): string {
  switch (op.type) {
    case 'replace':
      return firstLine(op.after) || firstLine(op.before);
    case 'insert':
      return firstLine(op.after);
    case 'delete':
      return firstLine(op.before);
    case 'swap':
      return `${firstLine(op.firstA)} ⇄ ${firstLine(op.firstB)}`;
    case 'note':
      return op.note;
  }
}

const OP_ICON: Record<Op['type'], string> = {
  replace: S.opReplace,
  insert: S.opInsert,
  delete: S.opDelete,
  swap: S.opSwap,
  note: S.opNote,
};

/** 行锚一律取活值：cur 优先、base 兜底。 */
function opLine(state: DocState, op: Op): number | null {
  const b = state.cur.find(x => x.id === op.blockId) ?? state.base.find(x => x.id === op.blockId);
  return b?.lineStart ?? null;
}

/** 跳转：blockId 为主锚，行号兜底（main 监听此事件落位）。 */
function jumpTo(blockId: string, line: number | null): void {
  document.dispatchEvent(new CustomEvent('md2p-jump', { detail: { blockId, line } }));
}

const olRow = (b: { id: string; lineStart: number }, depth: number, inner: string): string =>
  `<div class="ol-item" data-bid="${esc(b.id)}" data-line="${b.lineStart}" style="--d:${depth}">${inner}<span class="ol-line">${b.lineStart}</span></div>`;

function outlineHtml(state: DocState | null): string {
  if (!state) return `<p class="panel-empty">${S.outlineEmpty}</p>`;
  const { kind } = state.file;
  if (kind === 'xml') return olRow({ id: '', lineStart: 1 }, 0, `<span class="ol-text">${S.outlineXml}</span>`);
  if (kind === 'jsonl') {
    return (
      state.cur
        .map(b =>
          olRow(
            b,
            0,
            `<span class="ol-rec">#${b.lineStart}</span><span class="ol-dim">${esc(cut(firstLine(b.text), 22))}</span>`,
          ),
        )
        .join('') || `<p class="panel-empty">${S.outlineEmpty}</p>`
    );
  }
  const heads = state.cur.filter(b => b.kind === 'heading');
  if (!heads.length) return `<p class="panel-empty">${S.outlineNoHeadings}</p>`;
  return heads
    .map(b => {
      const level = b.meta?.level ?? /^#+/.exec(b.text)?.[0].length ?? 1;
      return olRow(b, level, `<span class="ol-text">${esc(cut(b.text.replace(/^#{1,6}\s*/, ''), 28))}</span>`);
    })
    .join('');
}

/** 卡片按钮按生命周期出招：pending=隐藏/撤回；预令=确认/取消；hidden=显示/撤回；墓碑=复活。 */
function cardActs(op: Op): string {
  const id = esc(op.id);
  if (op.state === 'withdrawn')
    return `<button class="mini-btn" data-act="restore" data-id="${id}">${S.restore}</button>`;
  if (op.state === 'withdrawing')
    return `<button class="mini-btn warn" data-act="withdraw2" data-id="${id}">${S.withdraw2}</button><button class="mini-btn" data-act="cancel" data-id="${id}">${S.cancelWd}</button>`;
  if (op.state === 'hidden')
    return `<button class="mini-btn" data-act="unhide" data-id="${id}">${S.unhide}</button><button class="mini-btn" data-act="withdraw" data-id="${id}">${S.withdraw}</button>`;
  return `<button class="mini-btn" data-act="hide" data-id="${id}">${S.hide}</button><button class="mini-btn" data-act="withdraw" data-id="${id}">${S.withdraw}</button>`;
}

function revRowHtml(state: DocState, op: Op): string {
  const line = opLine(state, op);
  const armed = op.state === 'withdrawing' ? ' rev-armed' : '';
  const meta = [line != null ? S.lineLabel(line) : '', fmtTime(op.time)].filter(Boolean).join(' · ');
  // 引文/批注全文一律完整进 DOM，截断纯 CSS；点击展开/收起（v1.5 追加：对着想象实际 Prompt 内容）
  const quoteLine =
    op.type === 'note' && op.quote
      ? `<div class="rev-quote" data-act="qexpand" title="${esc(S.expandTip)}">${esc(op.quote)}</div>`
      : '';
  const noteLine =
    op.type !== 'note' && op.note
      ? `<div class="rev-note-line" data-act="qexpand" title="${esc(S.expandTip)}">${esc(op.note)}</div>`
      : '';
  const editBtn =
    op.type === 'note' && !op.state
      ? `<button class="mini-btn" data-act="edit-note" data-id="${esc(op.id)}">${S.editNote}</button>`
      : '';
  return `<div class="rev-row${armed}" data-id="${esc(op.id)}">
    <div class="rev-top"><span class="rev-badge rb-${op.type}">${OP_ICON[op.type]}</span><span class="rev-anchor" data-bid="${esc(op.blockId)}"${line != null ? ` data-line="${line}"` : ''}>${esc(cut(opAnchor(op), 30))}</span></div>
    ${quoteLine}
    ${noteLine}
    <div class="rev-bottom"><span class="rev-meta">${esc(meta)}</span><span class="rev-actions">${cardActs(op)}${editBtn}<button class="mini-btn" data-act="jump" data-id="${esc(op.id)}">${S.jump}</button></span></div>
  </div>`;
}

/** 页签：修订(A 类直接修改) / 批注(B 类) / 墓碑(C 类已撤回)；选择持久化。 */
type Tab = 'rev' | 'note' | 'tomb';
const TAB_KEY = 'md2prompt.tab';
let tab: Tab = ((): Tab => {
  try {
    const t = localStorage.getItem(TAB_KEY);
    return t === 'note' || t === 'tomb' ? t : 'rev';
  } catch {
    return 'rev';
  }
})();

/** 路径行：文档 + 日记，缩略可展开，⧉ 复制完整路径（设置里的目录前缀 + 文件名）。 */
function pathRowHtml(state: DocState): string {
  const dir = currentPrefs().dirPrefix;
  const slot = (label: string, name: string, which: string): string =>
    `<span class="path-slot"><span class="path-label">${label}</span><span class="path" data-act="pexpand" title="${esc(S.pathNote)}">${esc(joinPath(dir, name))}</span><button class="icon-btn" data-act="pcopy" data-p="${which}" title="${esc(S.pathCopy)}">⧉</button></span>`;
  return `<div class="path-row">${slot(S.pathDoc, state.file.name, 'doc')}${slot(S.pathPrompt, promptName(state.file.name), 'prompt')}</div>`;
}

function changesHtml(state: DocState | null): string {
  const ops = state?.ops ?? [];
  const wd = state?.withdrawn ?? [];
  const shown = (o: Op): boolean => o.state !== 'hidden'; // pending + 预令
  const aOps = ops.filter(o => o.type !== 'note' && shown(o));
  const bOps = ops.filter(o => o.type === 'note' && shown(o));
  const aHidden = ops.filter(o => o.type !== 'note' && !shown(o));
  const bHidden = ops.filter(o => o.type === 'note' && !shown(o));
  const noDoc = state ? '' : ' disabled';
  const tabBtn = (t: Tab, label: string, n: number): string =>
    `<button class="panel-tab${tab === t ? ' on' : ''}" data-act="tab" data-tab="${t}">${label} <span class="n">${n}</span></button>`;
  const head = `<div class="panel-head"><span class="panel-title">${S.changesTitle}</span><span class="panel-count">${state ? S.pending(ops.length, bOps.length, aOps.length, aHidden.length + bHidden.length, wd.length) : ''}</span><button class="btn btn-primary" data-act="hide-all"${ops.length ? '' : ' disabled'}>${S.hideAll}</button><button class="icon-btn collapse" data-act="collapse" title="${S.collapse}">▸</button></div>
  <div class="panel-tabs">${tabBtn('rev', S.tabRev, aOps.length)}${tabBtn('note', S.tabNote, bOps.length)}${tabBtn('tomb', S.tabTomb, wd.length)}</div>
  <div class="export-row"><button class="btn" data-act="copy-prompt"${noDoc}>${S.copyPrompt}</button><button class="btn" data-act="dl-prompt"${noDoc}>${S.dlPrompt}</button><button class="btn" data-act="dl-clean"${noDoc}>${S.dlClean}</button><button class="btn" data-act="dl-pdf"${noDoc}>${S.dlPdf}</button></div>${state ? pathRowHtml(state) : ''}`;
  let body: string;
  if (!state) body = `<p class="panel-empty">${S.changesNone}</p>`;
  else {
    const grp = (label: string, list: Op[]): string =>
      list.length
        ? `<div class="grp-label">${label}</div>${list.map(o => revRowHtml(state, o)).join('')}`
        : '';
    const empty = `<p class="panel-empty">${S.changesEmpty}</p>`;
    if (tab === 'rev') body = grp(S.grpA, aOps) + grp(S.grpHidden, aHidden) || empty;
    else if (tab === 'note') body = grp(S.grpB, bOps) + grp(S.grpHidden, bHidden) || empty;
    else {
      const wdHead = wd.length
        ? `<div class="grp-label">${S.grpC}（${wd.length}）<button class="mini-btn grp-clear" data-act="clear-wd">${S.clearWd}</button></div>`
        : '';
      body = wdHead + wd.map(o => revRowHtml(state, o)).join('') || empty;
    }
  }
  return `${head}<div class="panel-body">${body}</div><button class="rail" data-act="expand" title="${S.expand}">${S.changesTitle}</button>`;
}

function outlineShell(inner: string): string {
  return `<div class="panel-head"><span class="panel-title">${S.outlineTitle}</span><button class="icon-btn collapse" data-act="collapse" title="${S.collapse}">◂</button></div><div class="panel-body">${inner}</div><button class="rail" data-act="expand" title="${S.expand}">${S.outlineTitle}</button>`;
}

export async function copyText(t: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    // file:// 等无权限场景降级 execCommand
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function flashBtn(btn: HTMLElement, text: string): void {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = old;
  }, 1200);
}

async function doExport(
  btn: HTMLElement,
  state: DocState | null,
  kind: 'copy' | 'prompt' | 'clean',
): Promise<void> {
  if (!state) return;
  try {
    if (kind === 'copy') {
      await copyText(await buildPrompt(state, true)); // 回传 Agent：省略 C 类墓碑
      flashBtn(btn, S.copied);
    } else if (kind === 'prompt') {
      downloadFile(promptName(state.file.name), await buildPrompt(state)); // 日记全量（含 C 类）
    } else {
      downloadFile(state.file.name, exportText(state.cur, state.file.kind));
    }
  } catch (e) {
    console.error('[md2prompt] 导出失败', e);
    flashBtn(btn, S.failed);
  }
}

export function mountPanels(store: Store): void {
  const outline = document.getElementById('outline');
  const changes = document.getElementById('changes');
  if (!outline || !changes) return;

  // 渲染缓存：签名未变直接跳过（state.cur/ops/withDrawn 任一变化必换数组引用，commit 保证）——
  // 万行 JSONL 大纲每击键重建字符串的 O(n) 模板拼接就此消除（性能专项）；HTML 未变再保 DOM（滚动位置）。
  let lastOutline = '';
  let lastChanges = '';
  let lastSig: readonly unknown[] | null = null;
  const render = (state: DocState | null): void => {
    const sig: readonly unknown[] = state
      ? [state.file.name, state.cur, state.ops, state.withdrawn, tab, currentPrefs().dirPrefix]
      : [null];
    if (lastSig && sig.length === lastSig.length && sig.every((v, k) => v === lastSig![k])) return;
    lastSig = sig;
    const og = outline.querySelector('.resize-grip');
    const cg = changes.querySelector('.resize-grip');
    const o = outlineShell(outlineHtml(state));
    if (o !== lastOutline) {
      outline.innerHTML = o;
      if (og) outline.appendChild(og); // 拖拽调宽手柄不被 innerHTML 抹掉
      lastOutline = o;
    }
    const c = changesHtml(state);
    if (c !== lastChanges) {
      changes.innerHTML = c;
      if (cg) changes.appendChild(cg);
      lastChanges = c;
    }
  };

  const onJump = (el: HTMLElement): void => {
    jumpTo(el.dataset.bid ?? '', el.dataset.line ? Number(el.dataset.line) : null);
  };

  outline.addEventListener('click', ev => {
    const el = (ev.target as HTMLElement).closest('[data-act],[data-bid]') as HTMLElement | null;
    if (!el) return;
    if (el.dataset.bid !== undefined) {
      onJump(el);
      return;
    }
    if (el.dataset.act === 'collapse') outline.classList.add('collapsed');
    else if (el.dataset.act === 'expand') outline.classList.remove('collapsed');
  });

  changes.addEventListener('click', ev => {
    const el = (ev.target as HTMLElement).closest('[data-act],[data-bid]') as HTMLElement | null;
    if (!el) return;
    if (el.dataset.bid !== undefined && !el.dataset.act) {
      onJump(el);
      return;
    }
    const id = el.dataset.id;
    switch (el.dataset.act) {
      case 'tab':
        tab = (el.dataset.tab as Tab) || 'rev';
        try {
          localStorage.setItem(TAB_KEY, tab);
        } catch {
          /* 隐私模式静默 */
        }
        render(store.state);
        break;
      case 'pexpand':
        el.classList.toggle('expanded');
        break;
      case 'qexpand':
        el.classList.toggle('expanded');
        break;
      case 'pcopy': {
        const st = store.state;
        if (st)
          void copyText(joinPath(currentPrefs().dirPrefix, el.dataset.p === 'prompt' ? promptName(st.file.name) : st.file.name));
        break;
      }
      case 'hide':
        if (id) store.dispatch({ type: 'hide', id });
        break;
      case 'unhide':
        if (id) store.dispatch({ type: 'unhide', id });
        break;
      case 'withdraw':
        if (id) store.dispatch({ type: 'withdraw', id });
        break;
      case 'withdraw2':
        if (id) store.dispatch({ type: 'withdrawCommit', id });
        break;
      case 'cancel':
        if (id) store.dispatch({ type: 'cancelWithdraw', id });
        break;
      case 'restore':
        if (id) store.dispatch({ type: 'restore', id });
        break;
      case 'hide-all':
        store.dispatch({ type: 'hideAll' });
        break;
      case 'clear-wd':
        store.dispatch({ type: 'clearWithdrawn' });
        break;
      case 'edit-note':
        if (id) document.dispatchEvent(new CustomEvent('md2p-edit-note', { detail: { id } }));
        break;
      case 'jump': {
        const st = store.state;
        const op = st?.ops.find(o => o.id === id) ?? st?.withdrawn?.find(o => o.id === id);
        if (st && op) jumpTo(op.blockId, opLine(st, op));
        break;
      }
      case 'collapse':
        changes.classList.add('collapsed');
        break;
      case 'expand':
        changes.classList.remove('collapsed');
        break;
      case 'copy-prompt':
        void doExport(el, store.state, 'copy');
        break;
      case 'dl-prompt':
        void doExport(el, store.state, 'prompt');
        break;
      case 'dl-clean':
        void doExport(el, store.state, 'clean');
        break;
      case 'dl-pdf':
        document.dispatchEvent(new CustomEvent('md2p-print'));
        break;
    }
  });

  render(store.state);
  store.subscribe(render);
  onPrefsChange(() => render(store.state)); // 目录前缀变更 → 路径行即时重渲
}
