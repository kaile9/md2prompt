// 门禁：页宽（measure）任意值下 #doc 宽度正确（BUG 2 回归）
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const fails = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`);
  if (!cond) fails.push(name);
};
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(HTML);
await p.waitForTimeout(800);
await p.evaluate(() => {
  localStorage.removeItem('md2prompt.prefs');
  document.querySelector('.coach-modal button')?.click();
});
await p.evaluate(async () => {
  const text = Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 段正文，用来观察页宽变化下的排版表现，补充足够长度。`).join('\n\n');
  await window.__md2p.loadDocFile({ name: 't.md', kind: 'md', text, mtime: Date.now() });
});
await p.waitForTimeout(1200);

const setMeasure = (v) =>
  p.evaluate((v) => {
    const p0 = JSON.parse(localStorage.getItem('md2prompt.prefs') ?? '{}');
    localStorage.setItem('md2prompt.prefs', JSON.stringify({ ...p0, measure: v }));
    // 直接经设置面板读写路径应用（与真实操作同管线）
    const r = document.querySelector('input[name="measure"]');
    r.value = String(Math.min(60, v));
    r.dispatchEvent(new Event('input', { bubbles: true }));
    if (v > 60) {
      const n = document.querySelector('input[name="measureNum"]');
      n.value = String(v);
      n.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, v);
const metrics = () =>
  p.evaluate(() => {
    const doc = document.getElementById('doc');
    const sc = document.getElementById('scroller');
    return {
      w: doc.getBoundingClientRect().width,
      maxW: getComputedStyle(doc).maxWidth,
      colW: sc.getBoundingClientRect().width,
      hScroll: sc.scrollWidth > sc.clientWidth + 1,
    };
  });

await p.click('#settings-btn');
await p.waitForTimeout(250);

// 42rem：max-width 768px，应精确达到并居中（修复前 shrink-wrap 546px）
await setMeasure(42);
await p.waitForTimeout(250);
let m = await metrics();
ok('1. measure=42 时 #doc = 48rem(768px) 而非内容塌缩', Math.abs(m.w - 768) < 2, `w=${m.w}`);

// 61rem（>60）：cap 1076px > 列宽 864 → 满列不溢出
await setMeasure(61);
await p.waitForTimeout(250);
m = await metrics();
ok('2. measure=61 时 #doc 满列且不横向溢出', Math.abs(m.w - m.colW) < 2 && !m.hScroll, `w=${m.w} col=${m.colW}`);

// 200rem：cap 3296px > 列宽 → 满列不溢出（修复前同样塌缩 546px）
await setMeasure(200);
await p.waitForTimeout(250);
m = await metrics();
ok('3. measure=200 时 #doc 满列且不横向溢出', Math.abs(m.w - m.colW) < 2 && !m.hScroll, `w=${m.w} col=${m.colW}`);

// 宽视口（2200px）下 measure=80：cap 1376px，应精确达到
await p.setViewportSize({ width: 2200, height: 900 });
await p.waitForTimeout(300);
await setMeasure(80);
await p.waitForTimeout(250);
m = await metrics();
ok('4. 宽视口 measure=80 时 #doc = 86rem(1376px)', Math.abs(m.w - 1376) < 2, `w=${m.w}`);

// 缩回 30rem：小页宽同样精确
await setMeasure(30);
await p.waitForTimeout(250);
m = await metrics();
ok('5. measure=30 时 #doc = 36rem(576px)', Math.abs(m.w - 576) < 2, `w=${m.w}`);

await b.close();
if (fails.length) {
  console.log(`\n${fails.length} FAIL`);
  process.exit(1);
}
console.log('\nALL PASS');
