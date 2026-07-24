// qa15-s4c-jump.mjs — 场景4 深挖：b108 元素真身 + 精确段落定位方式
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

// 渲染层里有什么 data-block-id / data-line
console.log('渲染层块级元素统计:', await p.evaluate(() => {
  const els = [...document.querySelectorAll('#doc [data-block-id]')];
  const secs = [...document.querySelectorAll('#doc section[data-line]')];
  const paras = [...document.querySelectorAll('#doc p, #doc h2')];
  return JSON.stringify({
    dataBlockIdCount: els.length,
    sampleIds: els.slice(0, 5).map(e => `${e.tagName}.${String(e.className).slice(0, 20)}#${e.dataset.blockId}`),
    sections: secs.length,
    parasH2: paras.length,
    docChildren: [...document.querySelector('#doc').children].map(c => `${c.tagName}.${String(c.className).slice(0, 30)}`).join(' | '),
  }, null, 1);
}));

await p.evaluate(() => {
  const m = window.__md2p;
  const cur = m.store.state.cur.map(x => ({ ...x }));
  const blk = cur.find(x => x.text.includes('第 3 节第 25 段'));
  cur.find(x => x.id === blk.id).text = blk.text + '（已修改）';
  m.store.dispatch({ type: 'patchCur', cur });
});
await p.waitForTimeout(600);

console.log('\npatchCur 后 data-block-id 元素:', await p.evaluate(() => {
  const els = [...document.querySelectorAll('#doc [data-block-id]')];
  return JSON.stringify(els.slice(0, 8).map(e => ({
    tag: e.tagName, cls: String(e.className).slice(0, 30), bid: e.dataset.blockId,
    h: Math.round(e.getBoundingClientRect().height), text: e.textContent.slice(0, 20),
  })), null, 1);
}));

// 找含「第 3 节第 25 段（已修改）」文本的叶子元素
console.log('\n目标文本所在叶子元素:', await p.evaluate(() => {
  const all = [...document.querySelectorAll('#doc *')].filter(e => e.children.length === 0 && e.textContent.includes('第 3 节第 25 段'));
  return JSON.stringify(all.map(e => ({
    tag: e.tagName, cls: String(e.className).slice(0, 40), bid: e.dataset.blockId ?? null,
    closestBid: e.closest('[data-block-id]')?.dataset.blockId ?? null,
    h: Math.round(e.getBoundingClientRect().height),
  })), null, 1);
}));

// 跳转后 .jump-flash 在哪个元素
const opId = await p.evaluate(() => window.__md2p.store.state.ops.find(o => o.type === 'replace')?.id);
await p.evaluate(() => { document.querySelector('#scroller').scrollTop = 0; });
await p.click(`#changes [data-act="jump"][data-id="${opId}"]`);
await p.waitForTimeout(1800);
console.log('\n跳转后:', await p.evaluate(() => {
  const flash = document.querySelector('#doc .jump-flash');
  const sc = document.querySelector('#scroller');
  const scR = sc.getBoundingClientRect();
  const leaf = [...document.querySelectorAll('#doc *')].filter(e => e.children.length === 0 && e.textContent.includes('第 3 节第 25 段'))[0];
  const leafR = leaf?.getBoundingClientRect();
  return JSON.stringify({
    flash: flash ? { tag: flash.tagName, cls: String(flash.className).slice(0, 50), bid: flash.dataset.blockId ?? null, h: Math.round(flash.getBoundingClientRect().height) } : null,
    leafRatio: leafR ? Math.round((((leafR.top + leafR.bottom) / 2 - scR.top) / scR.height) * 1000) / 1000 : null,
    leafText: leaf?.textContent?.slice(0, 30),
    scrollTop: Math.round(sc.scrollTop),
  }, null, 1);
}));
await b.close();
