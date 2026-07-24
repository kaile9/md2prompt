// qa15-s7b-mmprobe.mjs — minimap 几何：条的宽高/覆盖范围/空白区在哪
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
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
console.log(await p.evaluate(() => {
  const m = document.querySelector('#minimap');
  const r = m.getBoundingClientRect();
  const kids = [...m.children].map(c => {
    const b = c.getBoundingClientRect();
    return { x: Math.round(b.x * 10) / 10, w: Math.round(b.width * 10) / 10, top: Math.round((b.top - r.top) * 10) / 10, h: Math.round(b.height * 10) / 10 };
  });
  const last = kids[kids.length - 1];
  return JSON.stringify({
    track: { x: r.x, w: r.width, h: Math.round(r.height) },
    kids: kids.length,
    first3: kids.slice(0, 3),
    last,
    coverageEnd: last ? Math.round((last.top + last.h) * 10) / 10 : 0,
    trackH: Math.round(r.height),
    // 横向：条是否铺满轨道宽
    barX0: kids[0]?.x - r.x, barW: kids[0]?.w,
  }, null, 1);
}));
// elementFromPoint 测试：轨道中心 vs 条间隙 vs 条上
console.log(await p.evaluate(() => {
  const m = document.querySelector('#minimap');
  const r = m.getBoundingClientRect();
  const at = (x, y, lab) => {
    const e = document.elementFromPoint(x, y);
    return `${lab}: ${e ? e.tagName + (e.id ? '#' + e.id : '') + '.' + String(e.className).slice(0, 20) : 'null'}`;
  };
  return [
    at(r.x + 1, r.y + r.height / 2, '轨道左缘'),
    at(r.x + r.width - 1, r.y + r.height / 2, '轨道右缘'),
    at(r.x + r.width / 2, r.y + r.height - 2, '轨道底部'),
    at(r.x + r.width / 2, r.y + 5, '轨道顶部'),
  ].join('\n');
}));
await b.close();
