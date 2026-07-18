// qa15-s8c-noteid.mjs — 批注 op 撤回→复活后 id/导出编号是否稳定
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('pageerror', e => console.log('[pageerror]', e.message));
await p.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
await p.goto(HTML);
await p.waitForFunction(() => !!window.__md2p?.store);
await p.evaluate(async () => {
  await window.__md2p.loadDocFile({ name: 'f.md', kind: 'md', mtime: Date.now(), text: '第一段甲。\n\n第二段乙。\n\n第三段丙。' });
});
await p.waitForTimeout(500);
const expIds = () => p.evaluate(async () => {
  const pr = await window.__md2p.buildPrompt(window.__md2p.store.state);
  return [...pr.matchAll(/<request id="([^"]+)"/g)].map(m => m[1]);
});
await p.evaluate(() => {
  const m = window.__md2p;
  const b3 = m.store.state.cur.find(x => x.text === '第三段丙。');
  m.store.dispatch({ type: 'addNote', blockId: b3.id, note: '请补充论据', quote: '第三段丙' });
});
await p.waitForTimeout(400);
const before = await p.evaluate(() => window.__md2p.store.state.ops.map(o => ({ id: o.id, seq: o.seq ?? null })));
const expBefore = await expIds();
console.log('复活前 store ops:', JSON.stringify(before), '导出 request id:', JSON.stringify(expBefore));

// 撤回 → 复活
const noteId = before.find(o => o.id.startsWith('o'))?.id ?? before[0].id;
const goTab = async (t) => { await p.click(`#changes [data-act="tab"][data-tab="${t}"]`); await p.waitForTimeout(300); };
const clickAct = async (act, id) => { await p.click(`#changes [data-act="${act}"][data-id="${id}"]`); await p.waitForTimeout(350); };
await goTab('note');
await clickAct('withdraw', noteId);
await clickAct('withdraw2', noteId);
await goTab('tomb');
await clickAct('restore', noteId);
const after = await p.evaluate(() => window.__md2p.store.state.ops.map(o => ({ id: o.id, seq: o.seq ?? null })));
const expAfter = await expIds();
console.log('复活后 store ops:', JSON.stringify(after), '导出 request id:', JSON.stringify(expAfter));
console.log(expBefore.join() === expAfter.join() ? 'PASS | 导出编号稳定' : 'FAIL | 导出编号变化');
await b.close();
