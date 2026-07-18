// qa15-s4-jump.mjs — 场景4 终版：跳转落点（按含目标文本的叶子段落量测）
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
await p.evaluate(() => {
  const m = window.__md2p;
  const cur = m.store.state.cur.map(x => ({ ...x }));
  const blk = cur.find(x => x.text.includes('第 3 节第 25 段'));
  cur.find(x => x.id === blk.id).text = blk.text + '（已修改）';
  m.store.dispatch({ type: 'patchCur', cur });
});
await p.waitForTimeout(600);
const opId = await p.evaluate(() => window.__md2p.store.state.ops.find(o => o.type === 'replace')?.id);

const measureLeaf = () => p.evaluate(() => {
  const sc = document.querySelector('#scroller');
  const scR = sc.getBoundingClientRect();
  const leaf = [...document.querySelectorAll('#doc *')].filter(e => e.children.length === 0 && e.textContent.includes('第 3 节第 25 段'))[0];
  if (!leaf) return { found: false };
  const r = leaf.getBoundingClientRect();
  return { found: true, centerRatio: Math.round((((r.top + r.bottom) / 2 - scR.top) / scR.height) * 1000) / 1000, leafH: Math.round(r.height), scrollTop: Math.round(sc.scrollTop) };
});
const settle = async () => {
  await p.waitForFunction(() => new Promise(res => {
    const sc = document.querySelector('#scroller'); let last = -1, n = 0;
    const t = setInterval(() => { if (sc.scrollTop === last && ++n >= 3) { clearInterval(t); res(true); } last = sc.scrollTop; }, 100);
  }), null, { timeout: 8000 }).catch(() => {});
};

// 从顶部跳
await p.evaluate(() => { document.querySelector('#scroller').scrollTop = 0; });
await p.waitForTimeout(300);
await p.click(`#changes [data-act="jump"][data-id="${opId}"]`);
await settle();
const m1 = await measureLeaf();
report('4.1 从顶部跳转：目标段中心在视口 50%±20%', m1.found && m1.centerRatio >= 0.30 && m1.centerRatio <= 0.70, JSON.stringify(m1));

// 从底部跳
await p.evaluate(() => { const sc = document.querySelector('#scroller'); sc.scrollTop = sc.scrollHeight; });
await p.waitForTimeout(300);
await p.click(`#changes [data-act="jump"][data-id="${opId}"]`);
await settle();
const m2 = await measureLeaf();
report('4.2 从底部跳转：目标段中心在视口 50%±20%', m2.found && m2.centerRatio >= 0.30 && m2.centerRatio <= 0.70, JSON.stringify(m2));

// 连点两次跳转（幂等）
await p.click(`#changes [data-act="jump"][data-id="${opId}"]`);
await settle();
const m3 = await measureLeaf();
report('4.3 重复点击跳转落点稳定', m3.found && m3.centerRatio >= 0.30 && m3.centerRatio <= 0.70, JSON.stringify(m3));

console.log('\n==== 场景4 汇总 ====');
const fails = results.filter(r => !r.ok);
console.log(`PASS ${results.length - fails.length}/${results.length}`);
for (const f of fails) console.log('  FAIL:', f.name);
await b.close();
