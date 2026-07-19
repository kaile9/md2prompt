/** test/mddom.test.ts — safeUrl 表驱动安全测试（C-4：XSS 回归集）。
 *  白名单：http(s)/mailto/相对路径/blob；img 额外放行 data:image/。控制符先剥再判（防 java\tscript:）。 */
import { describe, expect, test } from 'bun:test';
import { safeUrl } from '../src/editor/mddom';

const cases: [string, string | null, boolean][] = [
  // [输入, 期望（null=拒绝）, 是否 img]
  ['https://example.com/a?b=c', 'https://example.com/a?b=c', false],
  ['http://example.com', 'http://example.com', false],
  ['mailto:a@b.c', 'mailto:a@b.c', false],
  ['blob:https://app/123', 'blob:https://app/123', false],
  ['images/pic.png', 'images/pic.png', false],
  ['./rel/../path.png', './rel/../path.png', false],
  ['/abs/path.png', '/abs/path.png', false],
  ['data:image/png;base64,iVBOR', 'data:image/png;base64,iVBOR', true], // img 放行 data:image/
  ['data:image/svg+xml;base64,PHN2Zw==', 'data:image/svg+xml;base64,PHN2Zw==', true],
  ['data:image/png;base64,iVBOR', null, false], // 非 img 不放行 data:
  ['data:text/html,<script>alert(1)</script>', null, true], // data:text/html 永不放行
  ['javascript:alert(1)', null, false],
  ['java\tscript:alert(1)', null, false], // 制表符混淆（WHATWG 规则先剥控制符）
  ['java\nscript:alert(1)', null, false],
  [' jAvAsCrIpT:alert(1)', null, false], // 大小写 + 前导空白
  ['vbscript:msgbox(1)', null, false],
  ['file:///etc/passwd', null, false],
  ['ftp://example.com/x', null, false],
  ['//evil.com/x', null, false], // 协议相对
  ['\thttps://ok.com/x', 'https://ok.com/x', false], // 首尾空白/控制符 trim 后放行
  ['', null, false],
  ['  ', null, false],
];

describe('safeUrl（URL 白名单，XSS 回归集）', () => {
  for (const [input, want, img] of cases) {
    test(`${img ? 'img' : 'link'}: ${JSON.stringify(input)} → ${want === null ? '拒绝' : '放行'}`, () => {
      expect(safeUrl(input, img)).toBe(want);
    });
  }
});
