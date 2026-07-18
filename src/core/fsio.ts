// core/fsio.ts — 文件 IO 双后端（SPEC §6）。模块级单例持有当前文件/父目录句柄。
// 不变量：saveDoc/writePrompt 防抖 800ms；无写目标（无句柄/用户拒授权/降级后端）时仅内存保留，不报 failed。

import type { DocFile } from './ir';

export type SaveState = 'saved' | 'saving' | 'failed';

type Perm = { mode?: 'read' | 'readwrite' };
interface PickerType { description?: string; accept: Record<string, string[]> }
declare global { // lib.dom 未收录的 FS Access 成员
  interface Window {
    showOpenFilePicker?(o?: { types?: PickerType[]; multiple?: boolean }): Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?(o?: { suggestedName?: string; types?: PickerType[] }): Promise<FileSystemFileHandle>;
    showDirectoryPicker?(o?: { id?: string }): Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemHandle {
    queryPermission?(d?: Perm): Promise<PermissionState>;
    requestPermission?(d?: Perm): Promise<PermissionState>;
  }
}

const hasFS = typeof window !== 'undefined' && !!window.showOpenFilePicker;
const ACCEPT: PickerType[] = [{ description: 'Markdown / JSONL / XML', accept: { 'text/*': ['.md', '.markdown', '.jsonl', '.ndjson', '.xml'] } }];
/** Prompt.md 文件名：仅剥最后一段扩展名；点文件（.hidden）保留全名（与 panels 共用此实现）。 */
export const promptName = (doc: string): string => {
  const i = doc.lastIndexOf('.');
  return `${i > 0 ? doc.slice(0, i) : doc}.prompt.md`;
};
/** 目录前缀 + 文件名 → 展示/复制用完整路径（浏览器不暴露绝对路径，前缀由用户在设置里给）。
 *  分隔符跟随前缀风格（D:/docs → /，C:\docs → \），尾部斜杠去重。 */
export const joinPath = (dir: string, name: string): string => {
  if (!dir) return name;
  const d = dir.replace(/[\\/]+$/, '');
  return `${d}${d.includes('/') && !d.includes('\\') ? '/' : '\\'}${name}`;
};
const kindOf = (name: string): DocFile['kind'] =>
  /\.(jsonl|ndjson)$/i.test(name) ? 'jsonl' : /\.xml$/i.test(name) ? 'xml' : 'md';

let fileHandle: FileSystemFileHandle | null = null;
let dirHandle: FileSystemDirectoryHandle | null = null;
let docName = '未命名.md';
let pending = 0;
const listeners = new Set<(s: SaveState) => void>();
const imgCache = new Map<string, string>();

const emit = (s: SaveState) => listeners.forEach(f => f(s));
export function onSaveState(cb: (s: SaveState) => void): void { listeners.add(cb); }
async function tracked(p: Promise<unknown>): Promise<void> { // 保存状态：写入中→已存/失败
  pending++; emit('saving');
  try { await p; if (--pending === 0) emit('saved'); } catch { pending--; emit('failed'); }
}

function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    const open = indexedDB.open('md2prompt', 1);
    open.onupgradeneeded = () => { open.result.createObjectStore('handles'); };
    open.onerror = () => rej(open.error);
    open.onsuccess = () => {
      const req = run(open.result.transaction('handles', mode).objectStore('handles'));
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    };
  });
}
const idbPut = (k: string, h: FileSystemHandle) => idb('readwrite', s => s.put(h, k)).catch(() => {});
const idbGet = <T>(k: string) => idb<T | undefined>('readonly', s => s.get(k)).catch(() => undefined);

async function permit(h: FileSystemHandle): Promise<boolean> { // 旧内核无权限 API 时视为已授权
  if (!h.queryPermission || !h.requestPermission) return true;
  const d: Perm = { mode: 'readwrite' };
  return (await h.queryPermission(d)) === 'granted' || (await h.requestPermission(d)) === 'granted';
}
async function writeTo(h: FileSystemFileHandle, text: string): Promise<void> {
  const w = await h.createWritable();
  await w.write(text);
  await w.close();
}
function setDoc(h: FileSystemFileHandle | null, name: string): void {
  fileHandle = h; docName = name;
  imgCache.forEach(u => URL.revokeObjectURL(u));
  imgCache.clear();
}
async function askDir(): Promise<void> { // 父目录句柄：图片解析 + Prompt.md 落盘用；可拒绝（SPEC §6）
  if (!hasFS || !window.showDirectoryPicker) return;
  try {
    const d = await window.showDirectoryPicker({ id: 'md2prompt-dir' });
    dirHandle = (await permit(d)) ? d : null;
    if (dirHandle) void idbPut('dir', dirHandle);
  } catch { dirHandle = null; }
}

export async function openDoc(): Promise<DocFile | null> {
  if (!hasFS) return openFallback();
  let h: FileSystemFileHandle;
  try { [h] = await window.showOpenFilePicker!({ types: ACCEPT }); } catch { return null; }
  if (!(await permit(h))) return null;
  setDoc(h, h.name);
  void idbPut('file', h);
  await askDir();
  const f = await h.getFile();
  return { name: h.name, kind: kindOf(h.name), text: await f.text(), mtime: f.lastModified };
}
function openFallback(): Promise<DocFile | null> {
  return new Promise(res => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,.jsonl,.ndjson,.xml,text/*';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return res(null);
      setDoc(null, f.name);
      res({ name: f.name, kind: kindOf(f.name), text: await f.text(), mtime: f.lastModified });
    };
    input.oncancel = () => res(null);
    input.click();
  });
}
export async function restoreDoc(): Promise<DocFile | null> { // 重启后一键恢复（须由点击触发，供 requestPermission）
  if (!hasFS) return null;
  const h = await idbGet<FileSystemFileHandle>('file');
  if (!h || !(await permit(h))) return null;
  setDoc(h, h.name);
  const d = await idbGet<FileSystemDirectoryHandle>('dir');
  dirHandle = d && (await permit(d)) ? d : null;
  const f = await h.getFile();
  return { name: h.name, kind: kindOf(h.name), text: await f.text(), mtime: f.lastModified };
}
export function resetDoc(name = '未命名.md'): void { // 新建：清空句柄，首次保存走 save-as
  setDoc(null, name);
  dirHandle = null;
  void idb('readwrite', s => s.clear()).catch(() => {});
}

/** 防抖通道：同一目标的调用合并，目标之间隔离；所有提交串行，句柄别名也不能让旧写晚于新写落盘。 */
function channel<K, V>(flush: (key: K, value: V) => Promise<void>): (key: K, value: V) => Promise<void> {
  interface Slot {
    timer?: ReturnType<typeof setTimeout>;
    latest: V;
    waiters: (() => void)[];
    chain: Promise<void>;
  }
  const slots = new Map<K, Slot>();
  let commits = Promise.resolve();
  return (key, value) =>
    new Promise<void>(res => {
      let slot = slots.get(key);
      if (!slot) {
        slot = { latest: value, waiters: [], chain: Promise.resolve() };
        slots.set(key, slot);
      }
      slot.latest = value;
      slot.waiters.push(res);
      clearTimeout(slot.timer);
      slot.timer = setTimeout(() => {
        slot!.timer = undefined;
        const latest = slot!.latest;
        const waiters = slot!.waiters;
        slot!.waiters = [];
        const run = (slot!.chain = commits = commits.then(() => flush(key, latest)).catch(() => {}));
        void run.then(() => {
          waiters.forEach(w => w());
          if (slot!.chain === run && !slot!.timer && !slot!.waiters.length && slots.get(key) === slot) slots.delete(key);
        });
      }, 800);
    });
}
let latestDoc = '';
const docFlush = channel<FileSystemFileHandle, string>((handle, text) => tracked(writeTo(handle, text)));
export function saveDoc(t: string): Promise<void> {
  latestDoc = t;
  const target = fileHandle;
  return target ? docFlush(target, t) : Promise.resolve();
}

export interface PromptTarget { dir: FileSystemDirectoryHandle; name: string }
const promptTargets = new WeakMap<FileSystemDirectoryHandle, Map<string, PromptTarget>>();
export function capturePromptTarget(): PromptTarget | null {
  if (!dirHandle) return null;
  const name = promptName(docName);
  let byName = promptTargets.get(dirHandle);
  if (!byName) {
    byName = new Map();
    promptTargets.set(dirHandle, byName);
  }
  let target = byName.get(name);
  if (!target) {
    target = { dir: dirHandle, name };
    byName.set(name, target);
  }
  return target;
}
const promptFlush = channel<PromptTarget, string>((target, text) =>
  tracked(target.dir.getFileHandle(target.name, { create: true }).then(h => writeTo(h, text))),
);
export function writePrompt(t: string, target = capturePromptTarget()): Promise<void> {
  return target ? promptFlush(target, t) : Promise.resolve();
}

export async function saveDocAs(t: string): Promise<boolean> { // 显式保存（新文档首次保存 / fallback 下载）
  latestDoc = t;
  if (!hasFS || !window.showSaveFilePicker) { downloadFile(docName, t); return true; }
  try {
    const h = await window.showSaveFilePicker({ suggestedName: docName, types: ACCEPT });
    const selected = latestDoc; // 选择器打开期间可能已有新输入，不能写调用时的旧快照
    await tracked(writeTo(h, selected));
    setDoc(h, h.name);
    void idbPut('file', h);
    await askDir(); // save-as 后补请目录授权，否则 Prompt.md 无法落盘
    if (latestDoc !== selected) await saveDoc(latestDoc);
    return true;
  } catch { return false; }
}
export async function findSiblingPrompt(name: string): Promise<string | null> {
  if (!dirHandle) return null;
  try { return await (await (await dirHandle.getFileHandle(promptName(name))).getFile()).text(); }
  catch { return null; }
}
export async function resolveImage(relPath: string): Promise<string | null> {
  if (!dirHandle) return null;
  const hit = imgCache.get(relPath);
  if (hit) return hit;
  try {
    const segs = relPath.split('/').filter(s => s && s !== '.');
    if (!segs.length || segs.includes('..')) return null; // 句柄不可越出根目录
    let dir = dirHandle;
    for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s);
    const url = URL.createObjectURL(await (await dir.getFileHandle(segs[segs.length - 1])).getFile());
    imgCache.set(relPath, url);
    return url;
  } catch { return null; }
}
export function downloadFile(name: string, text: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
export const backend = (): 'fs' | 'fallback' => (hasFS ? 'fs' : 'fallback');
