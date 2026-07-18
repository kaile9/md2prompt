// qa15-s4b-jump.mjs — 场景4 复测：区分 wrapper 与真实段落元素
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

const parts = [];
for (let s = 1; s <= 3; s++) {
  parts.push(`## 第 ${s} 节`);
  for (let i = 1; i <= 40; i++) parts.push(`第 ${s} 节第 ${i} 段：内容填充，跳转精度测试需要足够长的文档高度。`);
}
await p.evaluate(async (t) => {
  await window.__md2p.loadDocFile({ name: 'jump.md', kind: 'md', mtime: Date.now(), text: t });
}, parts.join('\n\n'));
await p.waitForTimeout(1000);
const targetInfo = await p.evaluate(() => {
  const m = window.__md2p;
  const cur = m.store.state.cur.map(x => ({ ...x }));
  const blk = cur.find(x => x.text.includes('第 3 节第 25 段'));
  cur.find(x => x.id === blk.id).text = blk.text + '（已修改）';
  m.store.dispatch({ type: 'patchCur', cur });
  return { blockId: blk.id };
});
await p.waitForTimeout(600);

// 看 b108 匹配到哪些元素
console.log('b108 匹配元素:', await p.evaluate((bid) => {
  return JSON.stringify([...document.querySelectorAll(`#doc [data-block-id="${bid}"]`)].map(e => ({
    tag: e.tagName, cls: String(e.className).slice(0, 40), h: Math.round(e.getBoundingClientRect().height), text: e.textContent.slice(0, 25),
  })), null, 1);
}, targetInfo.blockId));

const measure = () => p.evaluate((bid) => {
  const sc = document.querySelector('#scroller');
  const scR = sc.getBoundingClientRect();
  const els = [...document.querySelectorAll(`#doc [data-block-id="${bid}"]`)];
  const leaf = els.reduce((a, e) => {
    const h = e.getBoundingClientRect().height;
    return !a || h < a.h ? { e, h } : a;
  }, null);
  const bR = leaf.e.getBoundingClientRect();
  const centerRatio = ((bR.top + bR.bottom) / 2 - scR.top) / scR.height;
  const topRatio = (bR.top - scR.top) / scR.height;
  return { centerRatio: Math.round(centerRatio * 1000) / 1000, topRatio: Math.round(topRatio * 1000) / 1000, leafH: Math.round(leaf.h), matched: els.length, scrollTop: Math.round(sc.scrollTop) };
}, targetInfo.blockId);

const opId = await p.evaluate(() => window.__md2p.store.state.ops.find(o => o.type === 'replace')?.id);

// 从顶部跳
await p.evaluate(() => { document.querySelector('#scroller').scrollTop = 0; });
await p.waitForTimeout(300);
await p.click(`#changes [data-act="jump"][data-id="${opId}"]`);
await p.waitForFunction(() => new Promise(res => {
  const sc = document.querySelector('#scroller'); let last = sc.scrollTop, n = 0;
  const t = setInterval(() => { if (sc.scrollTop === last && ++n >= 3) { clearInterval(t); res(true); } last = sc.scrollTop; }, 100);
}), null, { timeout: 8000 }).catch(() => {});
const m1 = await measure();
console.log('从顶部跳:', JSON.stringify(m1));
report('4.1 从顶部跳转：真实段落中心在视口 50%±20%', m1.centerRatio >= 0.30 && m1.centerRatio <= 0.70, `centerRatio=${m1.centerRatio} topRatio=${m1.topRatio} leafH=${m1.leafH} st=${m1.scrollTop}`);

// 从底部跳
await p.evaluate(() => { const sc = document.querySelector('#scroller'); sc.scrollTop = sc.scrollHeight; });
await p.waitForTimeout(300);
await p.click(`#changes [data-act="jump"][data-id="${opId}"]`);
await p.waitForTimeout(1500);
const m2 = await measure();
console.log('从底部跳:', JSON.stringify(m2));
report('4.2 从底部跳转：真实段落中心在视口 50%±20%', m2.centerRatio >= 0.30 && m2.centerRatio <= 0.70, `centerRatio=${m2.centerRatio}`);

console.log('\n==== 场景4 复测汇总 ====');
const fails = results.filter(r => !r.ok);
console.log(`PASS ${results.length - fails.length}/${results.length}`);
for (const f of fails) console.log('  FAIL:', f.name);
await b.close();
