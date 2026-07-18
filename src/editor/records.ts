// editor/records.ts — JSONL 数据集模式（SPEC §4.3）：记录卡片、虚拟列表、记录浮层编辑器。
import type { Block } from '../core/ir';
import { S } from '../ui/strings';
import { closeFloater, floatRoot, registerCloser, releaseCloser } from './floater';

type Dict = Record<string, unknown>;

const badge = (text: string): HTMLElement =>
  Object.assign(document.createElement('span'), { className: 'xml-badge', textContent: text });

const kvRow = (cls: string, k: string, v: string, long = false): HTMLElement => {
  const d = Object.assign(document.createElement('div'), { className: cls });
  d.append(
    Object.assign(document.createElement('span'), { textContent: k }),
    Object.assign(document.createElement(long ? 'div' : 'span'), { textContent: v }),
  );
  return d;
};

/** 单条记录 → 卡片：messages→role 对话轮；text/prompt/completion→折行长文；其余键值平铺；
 *  坏行→原文+徽标；空白行→空记录（不显示为坏数据）；标量→原文。 */
export function recordCard(b: Block, onOpen?: (b: Block) => void): HTMLElement {
  const card = document.createElement('div');
  card.className = 'record-card';
  const perr = typeof b.meta?.parseError === 'string' ? b.meta.parseError : undefined;
  const json = b.meta?.json;
  const obj = !perr && json !== null && typeof json === 'object' && !Array.isArray(json) ? (json as Dict) : null;
  if (!obj) {
    if (perr && b.text.trim() === '') {
      card.classList.add('record-empty');
      card.textContent = S.recordEmpty;
    } else {
      if (perr) {
        const bd = card.appendChild(badge(S.syntaxError));
        bd.title = perr;
      }
      card.appendChild(Object.assign(document.createElement('pre'), { textContent: b.text }));
    }
    if (onOpen) card.addEventListener('click', () => onOpen(b));
    return card;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'messages' && Array.isArray(v)) {
      for (const m of v as Dict[]) {
        if (m === null || typeof m !== 'object') continue;
        const row = document.createElement('div');
        row.className = 'msg';
        const body = document.createElement('div');
        body.textContent = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        row.append(badge(String(m.role ?? '?')), body);
        card.appendChild(row);
      }
    } else if (k === 'text' || k === 'prompt' || k === 'completion') {
      card.appendChild(kvRow('fld', k, String(v ?? ''), true));
    } else {
      card.appendChild(kvRow('kv', k, typeof v === 'string' ? v : JSON.stringify(v)));
    }
  }
  if (onOpen) card.addEventListener('click', () => onOpen(b));
  return card;
}

/** 虚拟记录流（§4.3）：IntersectionObserver 窗口化（视口±50）；卸载保留实测 minHeight 防滚动跳动。 */
export function mountVirtualList(el: HTMLElement, blocks: Block[], onOpenRecord?: (b: Block) => void): () => void {
  el.textContent = '';
  const io = new IntersectionObserver(
    (ents) => {
      const fresh: HTMLElement[] = [];
      for (const e of ents) {
        const row = e.target as HTMLElement;
        if (e.isIntersecting) {
          if (row.firstChild) continue;
          const b = blocks[Number(row.dataset.i)];
          if (!b) continue;
          row.appendChild(recordCard(b, onOpenRecord));
          fresh.push(row);
        } else if (row.firstChild) {
          row.textContent = '';
        }
      }
      // 第二阶段统一测量，避免逐行强制同步布局
      for (const row of fresh) if (row.offsetHeight > 0) row.style.minHeight = `${row.offsetHeight}px`;
    },
    { rootMargin: '3000px 0px' },
  );
  for (const [i, b] of blocks.entries()) {
    const d = document.createElement('div');
    d.dataset.i = String(i);
    d.dataset.line = String(b.lineStart);
    d.dataset.blockId = b.id;
    d.style.minHeight = '64px';
    io.observe(el.appendChild(d));
  }
  return () => {
    io.disconnect();
    el.textContent = '';
  };
}

const btn = (t: string): HTMLButtonElement =>
  Object.assign(document.createElement('button'), { type: 'button', textContent: t, className: 'btn' });

/** 字段值解析：messages 必为 JSON；text/prompt/completion 纯文本；其余先试 JSON 再按字符串。 */
const parseField = (k: string, v: string): unknown => {
  if (k === 'messages') return JSON.parse(v);
  if (k === 'text' || k === 'prompt' || k === 'completion') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

/** 记录浮层编辑器（§4.3）：表单（已知字段）/原始 JSON 两页签；保存前校验；可附 B 类批注。 */
export function openRecordEditor(b: Block, onSave: (next: string) => void, onAnnotate: (note: string) => void): void {
  let obj: Dict | null = null;
  try {
    const j: unknown = JSON.parse(b.text);
    if (j !== null && typeof j === 'object' && !Array.isArray(j)) obj = j as Dict;
  } catch {
    obj = null;
  }
  const root = floatRoot('floater');
  root.textContent = '';

  const backdrop = document.createElement('div');
  backdrop.className = 'floater-backdrop';
  const modal = document.createElement('div');
  modal.className = 'floater-modal';
  modal.addEventListener('click', (e) => e.stopPropagation());

  const head = document.createElement('div');
  head.className = 'floater-title';
  head.textContent = `${S.recordTitle} · ${S.lineLabel(b.lineStart)}`;

  const tabs = document.createElement('div');
  tabs.className = 'record-tabs';
  const formBtn = btn(S.recordForm);
  const rawBtn = btn(S.recordJson);
  tabs.append(formBtn, rawBtn);

  const fields: [string, HTMLTextAreaElement][] = [];
  const formPage = document.createElement('div');
  if (obj)
    for (const [k, v] of Object.entries(obj)) {
      const label = document.createElement('label');
      label.className = 'record-field';
      const name = document.createElement('span');
      name.textContent = k;
      const ta = document.createElement('textarea');
      ta.rows = k === 'messages' ? 8 : 3;
      ta.value = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
      label.append(name, ta);
      formPage.appendChild(label);
      fields.push([k, ta]);
    }

  const rawPage = document.createElement('textarea');
  rawPage.className = 'floater-source';
  rawPage.rows = 14;
  rawPage.spellcheck = false;
  rawPage.value = obj ? JSON.stringify(obj, null, 2) : b.text;

  const body = document.createElement('div');
  body.append(formPage, rawPage);

  const note = document.createElement('input');
  note.className = 'record-note';
  note.placeholder = S.recordNotePh;

  const err = document.createElement('div');
  err.className = 'record-error';

  const bar = document.createElement('div');
  bar.className = 'floater-actions';
  const save = btn(S.save);
  const cancel = btn(S.cancel);
  bar.append(save, cancel);

  modal.append(head, tabs, body, note, err, bar);
  backdrop.appendChild(modal);
  root.appendChild(backdrop);

  let rawMode = obj === null;
  const switchTab = (raw: boolean): void => {
    rawMode = raw;
    formPage.hidden = raw;
    rawPage.hidden = !raw;
    formBtn.classList.toggle('on', !raw);
    rawBtn.classList.toggle('on', raw);
  };
  formBtn.addEventListener('click', () => switchTab(false));
  rawBtn.addEventListener('click', () => switchTab(true));
  switchTab(rawMode);

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const close = (): void => {
    releaseCloser(close); // 注销自己，防残留 closer 抹掉下一个模态（JSONL-01）
    root.textContent = '';
    document.removeEventListener('keydown', onKey, true);
  };
  registerCloser(close);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey, true);

  save.addEventListener('click', () => {
    err.textContent = '';
    let out: unknown;
    try {
      out = rawMode ? JSON.parse(rawPage.value) : Object.fromEntries(fields.map(([k, ta]) => [k, parseField(k, ta.value)]));
    } catch (e) {
      err.textContent = `${S.syntaxError}：${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    const noteText = note.value.trim();
    close();
    onSave(JSON.stringify(out));
    if (noteText) onAnnotate(noteText);
  });
  cancel.addEventListener('click', close);
}

/** 记录编辑器同属浮层语义：外部切文档时统一关闭。 */
export { closeFloater as closeRecordEditor };
