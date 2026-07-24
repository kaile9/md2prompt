// readme-shots.mjs — 重拍 README 引用的三张展示图（docs/assets/render|night|split.png，1600×900）。
// 夹具：probes/fixture-茶馆笔记.md；留痕（replace + suggest 批注）经 store.dispatch 确定性制造。非测试，无断言。
import { chromium } from 'playwright';
import * as fs from 'node:fs';

const HTML = new URL('../../dist/2youg1-md2prompt.html', import.meta.url).href;
const OUT = (n) => new URL(`../../docs/assets/${n}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const guide = fs.readFileSync(new URL('fixture-茶馆笔记.md', import.meta.url), 'utf8');

const b = await chromium.launch();
async function prep(prefs) {
  const ctx = await b.newContext({ viewport: { width: 1600, height: 900 } });
  const p = await ctx.newPage();
  await p.addInitScript((pr) => {
    try {
      localStorage.setItem('md2prompt.coachSeen', '1');
      if (pr) localStorage.setItem('md2prompt.prefs', JSON.stringify(pr));
    } catch {}
  }, prefs ?? null);
  await p.goto(HTML);
  await p.waitForFunction(() => !!window.__md2p?.store);
  await p.evaluate(async (t) => {
    await window.__md2p.loadDocFile({ name: '茶馆笔记.md', kind: 'md', mtime: Date.now(), text: t });
  }, guide);
  await p.waitForTimeout(1500);
  await p.evaluate(() => {
    const m = window.__md2p;
    const cur = m.store.state.cur.map((x) => ({ ...x }));
    const t5 = cur.find((x) => x.text.startsWith('跑堂的说'));
    t5.text = t5.text.replace('连续来了十一年', '已连续来了十一年');
    m.store.dispatch({ type: 'patchCur', cur });
    const bq = m.store.state.cur.find((x) => x.kind === 'quote');
    m.store.dispatch({ type: 'addNote', blockId: bq.id, note: '这段引文建议压在两句以内。', kind: 'suggest', quote: '所谓市井' });
  });
  await p.waitForTimeout(1200);
  return p;
}

// 1. render.png — 云石默认主题，渲染模式 + 修订留痕
let p = await prep(null);
await p.screenshot({ path: OUT('render.png') });
console.log('render.png');
await p.context().close();

// 2. night.png — 纯黑主题
p = await prep({ theme: 'night' });
await p.screenshot({ path: OUT('night.png') });
console.log('night.png');
await p.context().close();

// 3. split.png — 分屏对比（左源码右渲染）
p = await prep(null);
await p.click('#mode-btn'); // render → source
await p.click('#mode-btn'); // source → split
await p.waitForSelector('.split-wrap');
await p.waitForTimeout(1200);
await p.screenshot({ path: OUT('split.png') });
console.log('split.png');
await p.context().close();

await b.close();
