// qa15-s8b-flow.mjs — 场景8 补测：复活后 op 的真实去向（修正 pending 判定）
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
const ids = await p.evaluate(() => {
  const m = window.__md2p;
  const cur = m.store.state.cur.map(x => ({ ...x }));
  const b2 = cur.find(x => x.text === '第二段乙。');
  const b3 = cur.find(x => x.text === '第三段丙。');
  cur.find(x => x.id === b2.id).text = '第二段乙（已改）。';
  m.store.dispatch({ type: 'patchCur', cur });
  m.store.dispatch({ type: 'addNote', blockId: b3.id, note: '请补充论据', quote: '第三段丙' });
  const s = m.store.state;
  return { rep: s.ops.find(o => o.type === 'replace')?.id, note: s.ops.find(o => o.type === 'note')?.id };
});
const goTab = async (t) => { await p.click(`#changes [data-act="tab"][data-tab="${t}"]`); await p.waitForTimeout(300); };
const clickAct = async (act, id) => { await p.click(`#changes [data-act="${act}"][data-id="${id}"]`); await p.waitForTimeout(350); };
const dumpAll = (lab) => p.evaluate(async (lab) => {
  const s = window.__md2p.store.state;
  return JSON.stringify({
    lab,
    ops: s.ops.map(o => ({ id: o.id, type: o.type, state: o.state ?? 'pending' })),
    withdrawn: s.withdrawn.map(o => o.id),
  });
}, lab);

// A: 撤回 → 复活
await goTab('rev');
await clickAct('hide', ids.rep);
await clickAct('withdraw', ids.rep);
await clickAct('withdraw2', ids.rep);
await goTab('tomb');
await clickAct('restore', ids.rep);
console.log(await dumpAll('A 复活后'));
for (const t of ['rev', 'note', 'tomb']) {
  await goTab(t);
  const has = await p.evaluate(id => [...document.querySelectorAll('#changes .rev-row')].map(r => r.dataset.id), ids.rep);
  console.log(`  ${t} 页签卡:`, JSON.stringify(has));
}
// B: 撤回 → 复活
await goTab('note');
await clickAct('withdraw', ids.note);
await clickAct('withdraw2', ids.note);
await goTab('tomb');
await clickAct('restore', ids.note);
console.log(await dumpAll('B 复活后'));
for (const t of ['rev', 'note', 'tomb']) {
  await goTab(t);
  const has = await p.evaluate(() => [...document.querySelectorAll('#changes .rev-row')].map(r => `${r.dataset.id}(${[...r.querySelectorAll('[data-act]')].map(x => x.dataset.act).join('/')})`));
  console.log(`  ${t} 页签卡:`, JSON.stringify(has));
}
await b.close();
