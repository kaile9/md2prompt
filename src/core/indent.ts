// SPDX-License-Identifier: MPL-2.0
/** §3 v1.2 首行缩进「写入文档」变换：导出/落盘时对 md 正文段落行前置两个全角空格。
 *  仅变换导出文本；内存态 cur 永不含缩进（不产生 diff 噪音）。
 *  跳过：代码围栏内外全部代码行、标题/列表/引用/表格/定义行、HTML 行、已缩进行、空白行。 */

// CommonMark：围栏至多 3 个前导空格；4 空格缩进代码块内的反引号行不翻转围栏状态机（v2.0.2 移植评审修复）
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// 结构行免缩进：标题/列表/引用/表格（含无前导竖线行，由邻行管道判定）/HTML/缩进代码/已缩进/
// hr（--- *** ___）/setext 下划线（=== ---）/脚注与链接定义（[^x]: / [a]:）——假阴性会破坏导出文档语义（M3/M4）
const SKIP = /^(\s{0,3}(#{1,6}\s|>|[-+*]\s|\d+[.)]\s|\||<|\[[^\]]*\]:)|\s{4}|\t|\u3000)/;
const HR = /^\s{0,3}(([-*_])\s*){3,}$/;
const SETEXT = /^\s{0,3}(={2,}|-{2,})\s*$/;

export function indentWrite(text: string): string {
  const lines = text.split('\n');
  let fence: string | null = null;
  const pipe = lines.map((l) => l.includes('|'));
  return lines
    .map((l, idx) => {
      const m = FENCE.exec(l);
      if (m) {
        const mark = m[1][0];
        fence = fence === null ? mark : fence === mark ? null : fence;
        return l;
      }
      if (fence !== null || l.trim() === '' || SKIP.test(l) || HR.test(l) || SETEXT.test(l)) return l;
      // 表格上下文：含 | 且相邻非空行也含 |（普通行文里的孤立竖线不受影响）
      if (pipe[idx]) {
        const prev = lines[idx - 1] ?? '';
        const next = lines[idx + 1] ?? '';
        if ((pipe[idx - 1] && prev.trim() !== '') || (pipe[idx + 1] && next.trim() !== '')) return l;
      }
      return `\u3000\u3000${l}`;
    })
    .join('\n');
}

/** 逆变换（载入侧）：写入档开启时，含缩进的历史文件先剥掉行首两个全角空格再解析——
 *  否则 op 的 before/after（内存态，无缩进）与块文本永不匹配，跨会话恢复必失败。
 *  与 indentWrite 幂等互补：只剥精确前缀，不伤正文内的全角空格。 */
export function indentStrip(text: string): string {
  const lines = text.split('\n');
  let fence: string | null = null;
  return lines
    .map((l) => {
      const m = FENCE.exec(l);
      if (m) {
        const mark = m[1][0];
        fence = fence === null ? mark : fence === mark ? null : fence;
        return l;
      }
      if (fence === null && l.startsWith('\u3000\u3000')) return l.slice(2);
      return l;
    })
    .join('\n');
}
