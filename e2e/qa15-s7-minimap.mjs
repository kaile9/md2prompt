// qa15-s7-minimap.mjs — 场景7 终版：点 minimap 空白轨道（条左侧边距）→ #scroller 按比例滚动
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const results = [];
const report = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + String(detail).slice(0, 400) : ''}`); };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('pageerror', e => console.log('[pageerror]', e.message));
await p.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
await p.goto(HTML);
await p.waitForFunction(() => !!window.__md2p?.store);
const paras = [];
for (let i = 1; i <= 80; i++) paras.push(`第 ${i} 段：minimap 轨道点击测试用填充文字，段落内容保持一定长度以便形成骨架条之间的空隙。`);
await p.evaluate(async (t) => {
  await window.__md2p.loadDocFile({ name: 'mm.md', kind: 'md', mtime: Date.now(), text: t });
}, paras.join('\n\n'));
await p.waitForTimeout(1000);

const mm = await p.evaluate(() => {
  const m = document.querySelector('#minimap');
  const r = m.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, bars: m.children.length };
});
console.log('minimap 轨道:', JSON.stringify(mm));
report('7.0 minimap 存在且有骨架条', mm.bars > 10, `bars=${mm.bars}`);

// 空白轨道 = 条左侧 5px 边距（x+2），elementFromPoint 已验证命中 #minimap 本体
const clickTrack = async (frac) => {
  await p.evaluate(() => { document.querySelector('#scroller').scrollTop = 0; });
  await p.waitForTimeout(300);
  const y = mm.y + mm.h * frac;
  // 确认命中轨道而非骨架条
  const hit = await p.evaluate(({ x, y }) => {
    const e = document.elementFromPoint(x, y);
    return e ? (e.id || e.tagName) : 'null';
  }, { x: mm.x + 2, y });
  await p.mouse.click(mm.x + 2, y);
  await p.waitForTimeout(800);
  const got = await p.evaluate(() => {
    const sc = document.querySelector('#scroller');
    return { st: Math.round(sc.scrollTop), max: sc.scrollHeight - sc.clientHeight, ratio: Math.round(sc.scrollTop / (sc.scrollHeight - sc.clientHeight) * 1000) / 1000 };
  });
  return { hit, got };
};

for (const frac of [0.25, 0.5, 0.75]) {
  const { hit, got } = await clickTrack(frac);
  // 映射预期：scrollTop/max ≈ frac（容差 ±0.12）；或居中映射 frac - 0.5*ch/sh ≈ frac - 0.087（容差 ±0.12）
  const center = frac - 0.5 * (858 / (got.max + 858));
  const ok = hit === 'minimap' && (Math.abs(got.ratio - frac) < 0.12 || Math.abs(got.ratio - center) < 0.12);
  report(`7.x 点击空白轨道 frac=${frac} → 按比例滚动`, ok, `命中=${hit} 实滚=${got.ratio} (st=${got.st}/${got.max}，线性预期≈${frac.toFixed(2)}/居中预期≈${center.toFixed(2)})`);
}

console.log('\n==== 场景7 汇总 ====');
const fails = results.filter(r => !r.ok);
console.log(`PASS ${results.length - fails.length}/${results.length}`);
for (const f of fails) console.log('  FAIL:', f.name);
await b.close();
