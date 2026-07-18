/** ui/shortcuts.ts — 快捷键自定义（批次 4）：默认组合 + 用户覆盖（设置面板捕获录入）。
 *  匹配在 document 捕获阶段进行（先于 PM keymap），命中即 preventDefault 防双重触发。 */
import { S } from './strings';

export type ScAction = 'bold' | 'italic' | 'strike' | 'annotate' | 'moveUp' | 'moveDown' | 'sourceToggle';

export const SC_DEFAULT: Record<ScAction, string> = {
  bold: 'Ctrl+B',
  italic: 'Ctrl+I',
  strike: 'Ctrl+Shift+X',
  annotate: 'Alt+M',
  moveUp: 'Alt+ArrowUp',
  moveDown: 'Alt+ArrowDown',
  sourceToggle: 'Ctrl+/',
};

export const SC_LABEL = S.scLabel as Record<ScAction, string>;

/** 事件 → 规范化组合串（'Ctrl+Shift+X' 形；字母大写、方向键原名）。 */
export function comboOf(ev: KeyboardEvent): string {
  const parts: string[] = [];
  if (ev.ctrlKey || ev.metaKey) parts.push('Ctrl');
  if (ev.altKey) parts.push('Alt');
  if (ev.shiftKey) parts.push('Shift');
  const k = ev.key.length === 1 ? ev.key.toUpperCase() : ev.key;
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(ev.key)) parts.push(k);
  return parts.join('+');
}

/** 捕获录入：读键写进 input（Backspace/Delete 清回默认），返回组合串或 null。
 *  拒收无 Ctrl/Alt 修饰的非功能键组合（绑「A」会锁死文档输入，评审 M3）。 */
export function captureCombo(input: HTMLInputElement, ev: KeyboardEvent): string | null {
  ev.preventDefault();
  ev.stopPropagation();
  if (ev.key === 'Backspace' || ev.key === 'Delete') {
    input.value = '';
    return '';
  }
  const c = comboOf(ev);
  if (!c || ['Control', 'Alt', 'Shift', 'Meta'].includes(ev.key)) return null;
  const bare = !ev.ctrlKey && !ev.metaKey && !ev.altKey;
  if (bare && !/^F\d{1,2}$/.test(ev.key)) return null; // 无修饰键仅放行 F1–F12
  input.value = c;
  return c;
}
