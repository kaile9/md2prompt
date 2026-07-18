// qa15-s8-flow.mjs — 场景8：隐藏/撤回/复活在三个页签间的流转入口
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

await p.evaluate(async () => {
  await window.__md2p.loadDocFile({ name: 'f.md', kind: 'md', mtime: Date.now(), text: '第一段甲。\n\n第二段乙。\n\n第三段丙。' });
});
await p.waitForTimeout(500);
// 造一个 A replace（改第二段）+ 一个 B note（锚第三段）
const ids = await p.evaluate(() => {
  const m = window.__md2p;
  const cur = m.store.state.cur.map(x => ({ ...x }));
  const b2 = cur.find(x => x.text === '第二段乙。');
  const b3 = cur.find(x => x.text === '第三段丙。');
  cur.find(x => x.id === b2.id).text = '第二段乙（已改）。';
  m.store.dispatch({ type: 'patchCur', cur });
  m.store.dispatch({ type: 'addNote', blockId: b3.id, note: '请补充论据', quote: '第三段丙' });
  const s = m.store.state;
  return { rep: s.ops.find(o => o.type === 'replace')?.id, note: s.ops.find(o => o.type === 'note')?.id, b2: b2.id, b3: b3.id };
});
console.log('ops:', JSON.stringify(ids));
await p.waitForTimeout(400);

const goTab = async (t) => { await p.click(`#changes [data-act="tab"][data-tab="${t}"]`); await p.waitForTimeout(300); };
const panel = () => p.evaluate(() => {
  const rows = [...document.querySelectorAll('#changes .panel-body .rev-row')];
  return {
    labels: [...document.querySelectorAll('#changes .panel-body .grp-label')].map(e => e.textContent),
    cards: rows.map(r => {
      let g = null, el = r;
      while ((el = el.previousElementSibling)) if (el.classList.contains('grp-label')) { g = el.textContent; break; }
      return { id: r.dataset.id, group: g, acts: [...r.querySelectorAll('[data-act]')].map(x => x.dataset.act) };
    }),
    empty: document.querySelector('#changes .panel-body .empty, #changes .panel-body .panel-empty')?.textContent ?? null,
  };
});
const opState = (id) => p.evaluate((id) => {
  const s = window.__md2p.store.state;
  const o = s.ops.find(x => x.id === id);
  if (o) return { where: 'ops', state: o.state ?? 'pending' };
  const w = s.withdrawn.find(x => x.id === id);
  return w ? { where: 'withdrawn' } : null;
}, ids => ids, );
const clickAct = async (act, id) => { await p.click(`#changes [data-act="${act}"][data-id="${id}"]`); await p.waitForTimeout(350); };

// ========== A op（replace）流转 ==========
// rev 页签：直接修改组，卡上有 隐藏/撤回/跳转
await goTab('rev');
let pa = await panel();
let card = pa.cards.find(c => c.id === ids.rep);
report('8.1 [A/rev] 修订页签直接修改组有卡，含 隐藏+撤回+跳转 入口',
  !!card && (card.group ?? '').includes('直接修改') && ['hide', 'withdraw', 'jump'].every(a => card.acts.includes(a)),
  JSON.stringify(card));

// 隐藏 → rev 页签「已隐藏」组，有撤回入口
await clickAct('hide', ids.rep);
pa = await panel();
card = pa.cards.find(c => c.id === ids.rep);
let st = await p.evaluate(id => window.__md2p.store.state.ops.find(o => o.id === id)?.state, ids.rep);
report('8.2 [A/rev] 隐藏后进「已隐藏」组且 state=hidden，仍有撤回入口',
  !!card && (card.group ?? '').includes('已隐藏') && st === 'hidden' && card.acts.includes('withdraw'),
  `group=${card?.group} acts=${card?.acts} state=${st}`);

// 撤回（两段：withdraw → withdraw2）
await clickAct('withdraw', ids.rep);
pa = await panel();
card = pa.cards.find(c => c.id === ids.rep);
const armed = card?.acts.includes('withdraw2');
report('8.3 [A/rev] 已隐藏卡撤回第一击进入确认态', !!armed, `acts=${card?.acts}`);
if (armed) await clickAct('withdraw2', ids.rep);
st = await p.evaluate(id => {
  const s = window.__md2p.store.state;
  return s.withdrawn.some(o => o.id === id) ? 'withdrawn' : 'still-ops';
}, ids.rep);
// 墓碑页签可见且有复活入口
await goTab('tomb');
pa = await panel();
card = pa.cards.find(c => c.id === ids.rep);
report('8.4 [A/tomb] 撤回后墓碑页签有卡且含复活入口', st === 'withdrawn' && !!card && card.acts.includes('restore'),
  `state=${st} card=${JSON.stringify(card)}`);

// 复活 → 回 rev pending
await clickAct('restore', ids.rep);
st = await p.evaluate(id => window.__md2p.store.state.ops.find(o => o.id === id)?.state ?? 'pending', ids.rep);
await goTab('rev');
pa = await panel();
card = pa.cards.find(c => c.id === ids.rep);
report('8.5 [A/rev] 复活后回修订页签 pending 组', st === 'pending' && !!card && (card.group ?? '').includes('直接修改'),
  `state=${st} group=${card?.group}`);

// ========== B note 流转 ==========
await goTab('note');
pa = await panel();
card = pa.cards.find(c => c.id === ids.note);
report('8.6 [B/note] 批注页签有卡，含 隐藏+撤回 入口', !!card && card.acts.includes('hide') && card.acts.includes('withdraw'),
  JSON.stringify(card));

// 隐藏 B → 卡去哪？
await clickAct('hide', ids.note);
st = await p.evaluate(id => window.__md2p.store.state.ops.find(o => o.id === id)?.state, ids.note);
pa = await panel();
const inNote = pa.cards.find(c => c.id === ids.note);
await goTab('rev');
const pa2 = await panel();
const inRev = pa2.cards.find(c => c.id === ids.note);
report('8.7 [B] 隐藏批注后 state=hidden，且在某页签仍可找到并撤回',
  st === 'hidden' && !!(inNote ?? inRev) && (inNote ?? inRev).acts.includes('withdraw'),
  `state=${st} note页签=${JSON.stringify(inNote)} rev页签=${JSON.stringify(inRev)}`);

// 从所在页签撤回
const where = inNote ? 'note' : 'rev';
await goTab(where);
await clickAct('withdraw', ids.note);
pa = await panel();
card = pa.cards.find(c => c.id === ids.note);
if (card?.acts.includes('withdraw2')) await clickAct('withdraw2', ids.note);
st = await p.evaluate(id => {
  const s = window.__md2p.store.state;
  return s.withdrawn.some(o => o.id === id) ? 'withdrawn' : 'still-ops';
}, ids.note);
await goTab('tomb');
pa = await panel();
card = pa.cards.find(c => c.id === ids.note);
report('8.8 [B/tomb] 批注撤回后墓碑页签有卡且可复活', st === 'withdrawn' && !!card && card.acts.includes('restore'),
  `state=${st} card=${JSON.stringify(card)}`);

// 复活 B → 回 note 页签 pending（注意：复活后 note 分配新 store id，但 seq/导出编号不变）
await clickAct('restore', ids.note);
st = await p.evaluate(() => {
  const s = window.__md2p.store.state;
  const n = s.ops.find(o => o.type === 'note');
  return n ? (n.state ?? 'pending') : 'gone';
});
await goTab('note');
pa = await panel();
card = pa.cards.find(c => c.acts.includes('edit-note'));
report('8.9 [B/note] 复活后批注回批注页签 pending', st === 'pending' && !!card, `state=${st} card=${card?.id ?? 'undefined'}`);

console.log('\n==== 场景8 汇总 ====');
const fails = results.filter(r => !r.ok);
console.log(`PASS ${results.length - fails.length}/${results.length}`);
for (const f of fails) console.log('  FAIL:', f.name);
await b.close();
