// qa15-s4e-jump.mjs — 场景4 最简复现：第一次跳转后 DOM 出现什么残留
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
const bid = await p.evaluate(() => window.__md2p.store.state.ops.find(o => o.type === 'replace')?.blockId);

const paraRatio = () => p.evaluate(() => {
  const sc = document.querySelector('#scroller');
  const scR = sc.getBoundingClientRect();
  const leaf = [...document.querySelectorAll('#doc *')].filter(e => e.children.length === 0 && e.textContent.includes('第 3 节第 25 段'))[0];
  const r = leaf.getBoundingClientRect();
  return { ratio: Math.round((((r.top + r.bottom) / 2 - scR.top) / scR.height) * 1000) / 1000, st: Math.round(sc.scrollTop) };
});
const bidDump = (lab) => p.evaluate(({ lab, bid }) => {
  const els = [...document.querySelectorAll(`#doc [data-block-id="${bid}"]`)];
  return JSON.stringify({ lab, n: els.length, els: els.map(e => ({ tag: e.tagName, cls: String(e.className).slice(0, 60), h: Math.round(e.getBoundingClientRect().height), kids: e.children.length })) });
}, { lab, bid });

console.log(await bidDump('跳转前'));
console.log('跳转前:', JSON.stringify(await paraRatio()));

// 第 1 次跳（从顶部）
await p.evaluate(() => { document.querySelector('#scroller').scrollTop = 0; });
await p.click(`#changes [data-act="jump"][data-id="${opId}"]`);
await p.waitForTimeout(400);
console.log(await bidDump('第1次跳后0.4s'));
console.log('第1次跳后0.4s:', JSON.stringify(await paraRatio()));
await p.waitForTimeout(1600);
console.log(await bidDump('第1次跳后2s'));
console.log('第1次跳后2s:', JSON.stringify(await paraRatio()));

// 第 2 次跳（原地）
await p.click(`#changes [data-act="jump"][data-id="${opId}"]`);
await p.waitForTimeout(1500);
console.log('第2次跳(原地):', JSON.stringify(await paraRatio()));

// 滚到底，第 3 次跳
await p.evaluate(() => { const sc = document.querySelector('#scroller'); sc.scrollTop = sc.scrollHeight; });
await p.waitForTimeout(400);
await p.click(`#changes [data-act="jump"][data-id="${opId}"]`);
await p.waitForTimeout(1500);
console.log('第3次跳(从底):', JSON.stringify(await paraRatio()));
console.log(await bidDump('第3次跳后'));
await b.close();
