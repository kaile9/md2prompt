/** §4.1 句级行内 diff（显示用）：旧片段 del、新片段 ins、相同 same。
 *  v1.2：粒度从词级改为句级——修改以整句呈现（旧句删除线 + 新句高亮），
 *  不再出现逐字/逐词碎片（用户反馈 v1 bug 1）。协议层不受影响（Prompt.md 本就是整块 before/after）。 */
export interface DiffSeg {
  type: 'same' | 'del' | 'ins';
  text: string;
}

/** 句边界：换行硬切；CJK 。！？；… 直切；ASCII .!?;: 仅在「后随空白 + 再下一个非空白字符
 *  像句首」（大写/数字/开引号括号）时切——防 `SKILL.md`、v1.5.2、e.g.、U.S. 把一句话腰斩（BUG 1b）。
 *  终止符后的闭引号/括号并入本句。 */
function splitSentences(t: string): string[] {
  const out: string[] = [];
  const closer = (c: string): boolean => '"\'”’）)】」』'.includes(c);
  const starter = (c: string): boolean => /[A-Z0-9"'“‘「『（(\[]/.test(c);
  const softCut = (i: number): boolean => {
    let j = i + 1;
    if (j >= t.length) return true;
    if (!/\s/.test(t[j])) return false;
    while (j < t.length && /\s/.test(t[j])) j++;
    return j >= t.length || starter(t[j]);
  };
  let s = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    const hard = c === '\n' || '。！？；…'.includes(c);
    const soft = '.!?;:'.includes(c) && softCut(i);
    if (hard || soft) {
      let e = i + 1;
      while (e < t.length && closer(t[e])) e++;
      out.push(t.slice(s, e));
      s = e;
      i = e - 1;
    }
  }
  if (s < t.length) out.push(t.slice(s));
  return out;
}

const seg = (type: DiffSeg['type'], text: string): DiffSeg => ({ type, text });

/** 源文 → 纯文本坐标投影：PM 节点是纯文本+atom 占位符，源文含行内标记。
 *  atom 运行（图片/脚注引用/行内公式）折叠为单个占位符，链接 [t](u) → t，标记符号 * _ ` ~ 丢弃。
 *  返回 plain（投影文本）与 map（plain 下标 → 源文下标），del 段经 map 回切源文展示。 */
export function project(s: string): { plain: string; map: number[] } {
  const ATOM = /^(!\[[^\]]*\]\([^)]*\)|\[\^[^\]]+\]|\$[^$]+\$)/;
  const LINK = /^\[([^\]]*)\]\([^)]*\)/;
  const plain: string[] = [];
  const map: number[] = [];
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    const a = ATOM.exec(rest);
    if (a) {
      plain.push('\ufffc');
      map.push(i);
      i += a[0].length;
      continue;
    }
    const l = LINK.exec(rest);
    if (l) {
      for (let k = 0; k < l[1].length; k++) {
        plain.push(l[1][k]);
        map.push(i + 1 + k);
      }
      i += l[0].length;
      continue;
    }
    const c = s[i];
    if (c === '*' || c === '_' || c === '`' || c === '~') {
      i++;
      continue;
    }
    plain.push(c);
    map.push(i);
    i++;
  }
  return { plain: plain.join(''), map };
}

/** 句级 LCS：相同句 same、被换句整句 del/ins。超长对（m·n > 200k）降级整段替换。 */
export function sentDiff(before: string, after: string): DiffSeg[] {
  if (before === after) return before ? [seg('same', before)] : [];
  const a = splitSentences(before);
  const b = splitSentences(after);
  const m = a.length;
  const n = b.length;
  if (m * n > 200_000) return [seg('del', before), seg('ins', after)].filter((s) => s.text);
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const segs: DiffSeg[] = [];
  const push = (type: DiffSeg['type'], text: string) => {
    const last = segs[segs.length - 1];
    if (last && last.type === type) last.text += text;
    else segs.push({ type, text });
  };
  for (let i = 0, j = 0; i < m || j < n; )
    if (i < m && j < n && a[i] === b[j]) {
      push('same', a[i]);
      i++;
      j++;
    } else if (j < n && (i === m || dp[i][j + 1] > dp[i + 1][j])) {
      push('ins', b[j]);
      j++;
    } else {
      push('del', a[i]);
      i++;
    }
  return segs;
}
