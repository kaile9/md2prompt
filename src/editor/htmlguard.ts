// editor/htmlguard.ts — 会话标记围栏保护（SPEC §4.1 flush 忠实，纯函数无编辑器依赖）。
// 节源文 ↔ 编辑器源文：XML 标签块/危险 html/孤立 <img> 块 → md2prompt-{tok}-{xml|raw|img} 围栏，
// 内容逐字保留；只拆本会话标记的围栏（外来同名围栏原样保留）。
// 档一标签规则与 core/ir.ts 共享（IR 块 ≡ 本模块围栏，v1.6 起 1:1）。

import { BLOCK6_TAG, DANGEROUS_TAG, PROMPT_CLOSE, PROMPT_OPEN } from '../core/ir';

const DANGEROUS = DANGEROUS_TAG;
const OPEN_TAG = /^\s{0,3}<([a-z][a-z0-9-]{0,24})(?=[\s/>])/;
// 提示词式标签（v1.3 三档契约）：整行只有开/闭/自闭合标签（可带属性），非标准 HTML 标签名。
// 开标签跨空行配对到同名闭标签（SKILL 类提示词文档结构）；闭/自闭合单行成卡。
const BLOCK6 = BLOCK6_TAG;
// CommonMark html 块 type 1-5：起判与结束条件（任意位置可起，含段中）
const T15: [RegExp, RegExp][] = [
  [/^\s{0,3}<(?:script|pre|style|textarea)(?=[\s>])/i, /<\/(?:script|pre|style|textarea)>\s*$/i],
  [/^\s{0,3}<!--/, /-->\s*$/],
  [/^\s{0,3}<\?/, /\?>\s*$/],
  [/^\s{0,3}<![A-Z]/, />\s*$/],
  [/^\s{0,3}<!\[CDATA\[/, /\]\]>\s*$/],
];
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** 围栏语言后缀 → 类型（views.ts 分派用）。 */
export const MD2P_LANG = /^md2prompt-[a-z0-9]+-(xml|raw|img)$/;

/** CommonMark 围栏扫描：开栏可有 info；闭栏同字符、长度 ≥ 开栏、无 info、缩进 ≤3。 */
export function fenceScan(lines: string[]): boolean[] {
  const inside = new Array<boolean>(lines.length).fill(false);
  let ch = '';
  let len = 0;
  lines.forEach((line, i) => {
    const m = FENCE.exec(line);
    if (ch === '') {
      if (m) {
        ch = m[1][0];
        len = m[1].length;
        inside[i] = true;
      }
    } else {
      inside[i] = true;
      if (m && m[1][0] === ch && m[1].length >= len && (m[2] ?? '').trim() === '') ch = '';
    }
  });
  return inside;
}

/** 节源文 → 编辑器源文：命中块改写为会话标记围栏，内容逐字保留。 */
export function protectHtmlBlocks(src: string, tok: string): string {
  const lines = src.split('\n');
  const fenced = fenceScan(lines);
  const out: string[] = [];
  const fenceAs = (raw: string, kind: 'xml' | 'raw' | 'img'): void => {
    const ticks = '`'.repeat(Math.max(3, ...[...raw.matchAll(/`+/g)].map((x) => x[0].length + 1)));
    out.push(`${ticks}md2prompt-${tok}-${kind}`, raw, ticks);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (fenced[i]) {
      out.push(line);
      continue;
    }
    // 档一：提示词式标签（开/闭/自闭合整行，非标准名）→ xml 卡片；开标签跨空行配对（v1.3）
    // img 除外：它有专属渲染档（档三）
    const pm = PROMPT_CLOSE.exec(line) ?? PROMPT_OPEN.exec(line);
    if (pm && pm[1] !== 'img' && !BLOCK6.test(pm[1]) && !DANGEROUS.test(pm[1])) {
      let end = i;
      if (PROMPT_OPEN.test(line) && !/\/>\s*$/.test(line)) {
        // 配对不看围栏标记（v1.5.1）：XML 内容里出现的 ``` 是内容而非文档围栏
        // （fenceScan 先跑会把它们误判为真围栏，把块劈碎，QA F3）。
        // 代价：真围栏里 stray 的同名闭标签可能被误并——罕见，且 fenceAs 的自适应
        // 反引号数保证内容逐字保真，两个风险不对称，取前者。
        const closeRe = new RegExp(`^\\s{0,3}</${pm[1]}>\\s*$`);
        for (let j = i + 1; j < lines.length; j++) {
          if (closeRe.test(lines[j] ?? '')) {
            end = j;
            break;
          }
        }
      }
      fenceAs(lines.slice(i, end + 1).join('\n'), 'xml');
      i = end;
      continue;
    }
    // 档二/三：标准 HTML 块（渲染）与危险块（转义），CommonMark 规则
    const tag = OPEN_TAG.exec(line)?.[1] ?? null;
    const prevBlank = i === 0 || (lines[i - 1] ?? '').trim() === '';
    const t15 = T15.find(([start]) => start.test(line));
    const isStart = !!t15 || (tag !== null && (BLOCK6.test(tag) || prevBlank));
    if (!isStart) {
      out.push(line);
      continue;
    }
    const endRe = t15 ? t15[1] : tag ? new RegExp(`</${tag}>\\s*$`) : />\s*$/;
    let end = i;
    // type 1-5（script/注释等）以结束条件收尾、可跨空行与围栏（CommonMark：HTML 块优先于围栏，
    // 内容里的 ``` 不是文档围栏，fenceScan 曾把 script+``` 劈碎，QA F3）；type 6/7 遇空行/围栏即止
    while (end + 1 < lines.length && (t15 || (!fenced[end + 1] && (lines[end + 1] ?? '').trim() !== ''))) {
      end++;
      if (endRe.test(lines[end] ?? '')) break;
    }
    const raw = lines.slice(i, end + 1).join('\n');
    const dangerous = tag !== null && DANGEROUS.test(tag);
    fenceAs(raw, dangerous || tag === null ? 'raw' : tag === 'img' ? 'img' : 'xml'); // 注释/声明类无标签名 → 转义
    i = end;
  }
  return out.join('\n');
}

/** 编辑器序列化 → 节源文：仅拆本会话标记的围栏；未闭合/外来围栏原样保留，不吞。 */
export function restoreHtmlBlocks(md: string, tok: string): string {
  if (!md.includes(`md2prompt-${tok}-`)) return md;
  const openRe = new RegExp(`^(\`{3,}|~{3,})md2prompt-${tok}-(?:xml|raw|img)\\s*$`);
  const lines = md.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = openRe.exec(lines[i] ?? '');
    if (!m) {
      out.push(lines[i] ?? '');
      continue;
    }
    const ch = m[1][0] === '`' ? '`' : '~';
    const closeRe = new RegExp(`^\\${ch}{${m[1].length},}\\s*$`);
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j] ?? '')) body.push(lines[j++] ?? '');
    if (j >= lines.length) {
      out.push(lines[i] ?? '');
      continue;
    }
    out.push(...body);
    i = j;
  }
  return out.join('\n');
}
