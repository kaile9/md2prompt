// qa15-s4d-jump.mjs — 场景4 深挖：从底部跳错误位的机理
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('pageerror', e => console.log('[pageerror]', e.message));
await p.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
await p.goto(HTML);
await p.waitForFunction(() => !!window.__md2p?.store);

const parts = [];
for (let s = 1; s <= 3; s++) {
  parts.push(`## 第 ${s} 节`);
  for (let i = 1; i <= 40; i++) parts.push(`第 ${s} 节第 ${i} 段：内容填充，跳转精度测试需要足够长的文档高度。`);
}
await p.evaluate(async (t) => {
  await window.__md2p.loadDocFile({ name: 'jump.md', kind: 'md', mtime: Date.now(), text: t });
}, parts.join('\n\n'));
await p.waitForTimeout(1000);
await p.evaluate(() => {
  const m = window.__md2p;
  const cur = m.store.state.cur.map(x => ({ ...x }));
  const blk = cur.find(x => x.text.includes('第 3 节第 25 段'));
  cur.find(x => x.id === blk.id).text = blk.text + '（已修改）';
  m.store.dispatch({ type: 'patchCur', cur });
});
await p.waitForTimeout(600);
const opId = await p.evaluate(() => window.__md2p.store.state.ops.find(o => o.type === 'replace')?.id);

const probe = (label) => p.evaluate((lab) => {
  const sc = document.querySelector('#scroller');
  const scR = sc.getBoundingClientRect();
  const leaf = [...document.querySelectorAll('#doc *')].filter(e => e.children.length === 0 && e.textContent.includes('第 3 节第 25 段'))[0];
  const r = leaf?.getBoundingClientRect();
  const flash = document.querySelector('#doc .jump-flash');
  const fr = flash?.getBoundingClientRect();
  const marks = [...document.querySelectorAll('#doc [class*="rev-"], #doc [class*="jump"]')].map(e => `${e.tagName}.${String(e.className).slice(0, 30)} h=${Math.round(e.getBoundingClientRect().height)}`);
  return JSON.stringify({
    lab, scrollTop: Math.round(sc.scrollTop), scrollH: sc.scrollHeight,
    paraRatio: r ? Math.round((((r.top + r.bottom) / 2 - scR.top) / scR.height) * 1000) / 1000 : null,
    flash: flash ? { cls: String(flash.className).slice(0, 60), h: Math.round(fr.height), topRatio: Math.round(((fr.top - scR.top) / scR.height) * 100) / 100, tag: flash.tagName } : null,
    marks: marks.slice(0, 6),
  }, null, 1);
}, label);

// 直接在底部开始
await p.evaluate(() => { const sc = document.querySelector('#scroller'); sc.scrollTop = sc.scrollHeight; });
await p.waitForTimeout(500);
console.log(await probe('跳前(底部)'));

// 点击后立即高频采样 scrollTop
await p.click(`#changes [data-act="jump"][data-id="${opId}"]`);
for (let i = 0; i < 12; i++) {
  await p.waitForTimeout(150);
  const st = await p.evaluate(() => Math.round(document.querySelector('#scroller').scrollTop));
  console.log(`t=${(i + 1) * 150}ms scrollTop=${st}`);
}
console.log(await probe('跳后 1.8s'));
await p.waitForTimeout(2000);
console.log(await probe('跳后 3.8s'));
await b.close();
