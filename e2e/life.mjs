// v1.2 生命周期 E2E 验收：隐藏 / 撤回两阶段 / 复活 / 全部隐藏 / 清空 / 跳转
// 运行：node life.mjs   （必须用 node，bun 连不上 Chromium）
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(HERE, '../e2e-shots');
mkdirSync(SHOTS, { recursive: true });
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;

const results = [];
const consoleErrors = [];
function report(step, ok, detail = '') {
  results.push({ step, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${step}${detail ? ' | ' + detail : ''}`);
}
async function shot(p, name) {
  try { await p.screenshot({ path: path.join(SHOTS, `v12-life-${name}.png`) }); }
  catch (e) { console.log('  [截图失败]', name, e.message); }
}

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
p.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));

await p.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
await p.goto(HTML);
await p.waitForFunction(() => !!window.__md2p?.store);
// 幂等：清掉可能的会话残留再重进
await p.evaluate(() => localStorage.clear());
await p.reload();
await p.waitForFunction(() => !!window.__md2p?.store);

// ---- 注入文档：5 段 ----
await p.evaluate(async () => {
  await window.__md2p.loadDocFile({
    name: 't.md', kind: 'md', mtime: 1752800000000,
    text: '第一段甲。\n\n第二段乙。\n\n第三段丙。\n\n第四段丁。\n\n第五段戊。',
  });
});
await p.waitForTimeout(400);

const blocks = await p.evaluate(() => window.__md2p.store.state.cur.map(x => ({ id: x.id, text: x.text, lineStart: x.lineStart, lineEnd: x.lineEnd })));
const byText = t => blocks.find(x => x.text === t);
const B2 = byText('第二段乙。'), B3 = byText('第三段丙。'), B4 = byText('第四段丁。'), B5 = byText('第五段戊。');
if (!B2 || !B3 || !B4 || !B5) { console.log('FATAL: 段落块未就绪', blocks); process.exit(1); }

// ---- 制造三个 op：replace b2 / delete b4 / insert n9 after b3（逐笔 patchCur）----
await p.evaluate(id => {
  const st = window.__md2p.store;
  const cur = st.state.cur.map(x => ({ ...x }));
  cur.find(x => x.id === id).text = '第二段乙（已改）。';
  st.dispatch({ type: 'patchCur', cur });
}, B2.id);
await p.waitForTimeout(250);
await p.evaluate(id => {
  const st = window.__md2p.store;
  const cur = st.state.cur.filter(x => x.id !== id).map(x => ({ ...x }));
  st.dispatch({ type: 'patchCur', cur });
}, B4.id);
await p.waitForTimeout(250);
await p.evaluate(({ afterId, line }) => {
  const st = window.__md2p.store;
  const cur = st.state.cur.map(x => ({ ...x }));
  const i = cur.findIndex(x => x.id === afterId);
  cur.splice(i + 1, 0, { id: 'n9', kind: 'para', text: '新插入段。', lineStart: line, lineEnd: line });
  st.dispatch({ type: 'patchCur', cur });
}, { afterId: B3.id, line: B3.lineEnd + 1 });
await p.waitForTimeout(400);

const ops0 = await p.evaluate(() => window.__md2p.store.state.ops.map(o => ({ id: o.id, type: o.type, blockId: o.blockId, state: o.state ?? null })));
const R = ops0.find(o => o.type === 'replace');
const D = ops0.find(o => o.type === 'delete');
const I = ops0.find(o => o.type === 'insert');
console.log('ops:', JSON.stringify(ops0));
if (!R || !D || !I) { console.log('FATAL: 未生成三个 op'); process.exit(1); }

// ---- 页面辅助 ----
const panel = () => p.evaluate(() => {
  const rows = [...document.querySelectorAll('#changes .panel-body .rev-row')];
  return {
    labels: [...document.querySelectorAll('#changes .panel-body .grp-label')].map(e => e.textContent),
    cards: rows.map(r => {
      let g = null, el = r;
      while ((el = el.previousElementSibling)) if (el.classList.contains('grp-label')) { g = el.textContent; break; }
      return {
        id: r.dataset.id, armed: r.classList.contains('rev-armed'), group: g,
        badge: r.querySelector('.rev-badge')?.textContent ?? '',
        acts: [...r.querySelectorAll('[data-act]')].map(x => x.dataset.act),
      };
    }),
  };
});
const docMarks = bid => p.evaluate(bid => ({
  ins: document.querySelectorAll('#doc .rev-ins').length,
  del: document.querySelectorAll('#doc .rev-del').length,
  will: document.querySelectorAll('#doc .rev-will').length,
  ghost: document.querySelectorAll('#doc .rev-ghost').length,
  restore: document.querySelectorAll('#doc .rev-restore').length,
  inBlock: document.querySelectorAll(`#doc [data-block-id="${bid}"] :is(.rev-ins,.rev-del,.rev-will)`).length,
  anyRev: document.querySelectorAll('#doc [class*="rev-"]').length,
}), bid);
const opState = id => p.evaluate(id => {
  const s = window.__md2p.store.state;
  const o = s.ops.find(x => x.id === id);
  if (o) return { where: 'ops', state: o.state ?? 'pending' };
  const w = s.withdrawn.find(x => x.id === id);
  if (w) return { where: 'withdrawn', state: w.state ?? 'withdrawn' };
  return null;
}, id);
const curTexts = () => p.evaluate(() => window.__md2p.store.state.cur.map(x => `${x.id}:${x.text}`));
const withdrawnLen = () => p.evaluate(() => window.__md2p.store.state.withdrawn.length);
async function act(a, id) {
  const sel = id ? `#changes [data-act="${a}"][data-id="${id}"]` : `#changes [data-act="${a}"]`;
  await p.click(sel);
  await p.waitForTimeout(300);
}
// v1.5 页签分栏：墓碑/批注需先切页签再读卡
async function goTab(name) {
  await p.click(`#changes [data-act="tab"][data-tab="${name}"]`);
  await p.waitForTimeout(250);
}

// ================= 步骤 1：A 类组三张卡 =================
try {
  const pa = await panel();
  const aCards = pa.cards.filter(c => (c.group ?? '').includes('直接修改'));
  const badges = Object.fromEntries(pa.cards.map(c => [c.id, c.badge]));
  const ok = aCards.length === 3 && badges[R.id] === '改' && badges[I.id] === '增' && badges[D.id] === '删';
  report('1. A类组出现三张卡（改/增/删徽标）', ok, JSON.stringify(pa.cards.map(c => [c.badge, c.group])));
} catch (e) { report('1. A类组出现三张卡', false, e.message); }
await shot(p, '01-a-group');

// ================= 步骤 2：隐藏 replace =================
try {
  await act('hide', R.id);
  const pa = await panel();
  const card = pa.cards.find(c => c.id === R.id);
  const marks = await docMarks(B2.id);
  const st = await opState(R.id);
  const ok = card && (card.group ?? '').includes('已隐藏') && marks.inBlock === 0 && st?.state === 'hidden';
  report('2. 隐藏 replace → 进已隐藏组 / 文档标记消失 / state=hidden', ok,
    `group=${card?.group} inBlock=${marks.inBlock} state=${st?.state}`);
} catch (e) { report('2. 隐藏 replace', false, e.message); }
await shot(p, '02-hidden');

// ================= 步骤 3：delete 撤回第一击 =================
let curBefore3;
try {
  curBefore3 = await curTexts();
  await act('withdraw', D.id);
  const pa = await panel();
  const card = pa.cards.find(c => c.id === D.id);
  const marks = await docMarks(B4.id);
  const st = await opState(D.id);
  const curNow = await curTexts();
  const curSame = JSON.stringify(curNow) === JSON.stringify(curBefore3);
  const ghostRestore = await p.evaluate(bid => !!document.querySelector(`#doc .rev-ghost.rev-restore[data-block-id="${bid}"]`), B4.id);
  const ok = card?.armed && card.acts.includes('withdraw2') && card.acts.includes('cancel')
    && ghostRestore && st?.state === 'withdrawing' && curSame;
  report('3. 撤回(delete) → rev-armed / 确认撤回+取消 / rev-restore 幽灵 / withdrawing / cur未变', ok,
    `armed=${card?.armed} acts=${card?.acts} ghost=${ghostRestore} state=${st?.state} curSame=${curSame}`);
} catch (e) { report('3. 撤回(delete) 第一击', false, e.message); }
await shot(p, '03-armed');

// ================= 步骤 4：取消 =================
try {
  await act('cancel', D.id);
  const pa = await panel();
  const card = pa.cards.find(c => c.id === D.id);
  const marks = await docMarks(B4.id);
  const st = await opState(D.id);
  const ok = card && !card.armed && marks.restore === 0 && st?.where === 'ops' && st?.state === 'pending';
  report('4. 取消 → 回 pending / rev-armed 与 rev-restore 消失', ok,
    `armed=${card?.armed} restore=${marks.restore} state=${st?.state}`);
} catch (e) { report('4. 取消撤回', false, e.message); }

// ================= 步骤 5：确认撤回 delete =================
try {
  await act('withdraw', D.id);
  await act('withdraw2', D.id);
  const cur = await curTexts();
  const b4back = cur.some(t => t === `${B4.id}:第四段丁。`);
  const st = await opState(D.id);
  const wlen = await withdrawnLen();
  await goTab('tomb'); // v1.5：墓碑卡住进「墓碑」页签
  const pa = await panel();
  const cGrp = pa.labels.some(l => l.includes('已撤回'));
  const card = pa.cards.find(c => c.id === D.id);
  const ok = b4back && st?.where === 'withdrawn' && wlen === 1 && cGrp && card?.acts.includes('restore');
  report('5. 确认撤回 → b4 文本恢复 / op 进 C 类墓碑 / 复活钮出现', ok,
    `b4back=${b4back} where=${st?.where} withdrawn=${wlen} cGrp=${cGrp} acts=${card?.acts}`);
} catch (e) { report('5. 确认撤回 delete', false, e.message); }
await shot(p, '05-withdrawn');

// ================= 步骤 6：复活 delete =================
try {
  await act('restore', D.id); // 当前在墓碑页签
  const cur = await curTexts();
  const b4gone = !cur.some(t => t.startsWith(`${B4.id}:`));
  const st = await opState(D.id);
  const wlen = await withdrawnLen();
  await goTab('rev'); // 复活后回 A 类组（修订页签）
  const pa = await panel();
  const card = pa.cards.find(c => c.id === D.id);
  const ok = b4gone && st?.where === 'ops' && st?.state === 'pending' && wlen === 0 && (card?.group ?? '').includes('直接修改');
  report('6. 复活 → b4 再消失 / 回 A 类 pending / withdrawn 清空', ok,
    `b4gone=${b4gone} state=${st?.state} withdrawn=${wlen} group=${card?.group}`);
} catch (e) { report('6. 复活 delete', false, e.message); }
await shot(p, '06-restored');

// ================= 步骤 7：insert 撤回 + 复活 =================
try {
  await act('withdraw', I.id);
  const stArm = await opState(I.id);
  const willN9 = await p.evaluate(() => document.querySelectorAll('#doc .rev-will').length > 0);
  await act('withdraw2', I.id);
  let cur = await curTexts();
  const n9gone = !cur.some(t => t.startsWith('n9:'));
  const stWd = await opState(I.id);
  await goTab('tomb'); // 撤回后卡在墓碑页签
  await act('restore', I.id);
  await goTab('rev');
  cur = await curTexts();
  const n9back = cur.some(t => t === 'n9:新插入段。');
  const stBack = await opState(I.id);
  const ok = stArm?.state === 'withdrawing' && willN9 && n9gone && stWd?.where === 'withdrawn' && n9back && stBack?.state === 'pending';
  report('7. insert 撤回→n9消失 / 复活→n9回来', ok,
    `arm=${stArm?.state} will=${willN9} n9gone=${n9gone} wd=${stWd?.where} n9back=${n9back} back=${stBack?.state}`);
} catch (e) { report('7. insert 撤回/复活', false, e.message); }
await shot(p, '07-insert-cycle');

// ================= 步骤 8：全部隐藏 =================
try {
  await act('hide-all');
  const states = await p.evaluate(() => window.__md2p.store.state.ops.map(o => o.state ?? 'pending'));
  const marks = await docMarks(B2.id);
  const pa = await panel();
  const hiddenCards = pa.cards.filter(c => (c.group ?? '').includes('已隐藏'));
  const ok = states.length === 3 && states.every(s => s === 'hidden') && marks.anyRev === 0 && hiddenCards.length === 3;
  report('8. 全部隐藏 → 全部 hidden / 文档无 rev-* 残留', ok,
    `states=${states} anyRev=${marks.anyRev} hiddenCards=${hiddenCards.length}`);
} catch (e) { report('8. 全部隐藏', false, e.message); }
await shot(p, '08-hide-all');

// ================= 步骤 9：已隐藏组跳转 =================
try {
  await act('jump', R.id);
  await p.waitForFunction(() => !!document.querySelector('#doc .jump-flash'), { timeout: 2500 });
  const flashBid = await p.evaluate(() => document.querySelector('#doc .jump-flash')?.dataset.blockId ?? null);
  await shot(p, '09-jump-flash');
  report('9. 已隐藏组跳转 → .jump-flash 命中对应块', flashBid === B2.id, `flashBid=${flashBid} expect=${B2.id}`);
} catch (e) { report('9. 已隐藏组跳转', false, e.message); }

// ================= 步骤 10：隐藏后再 patchCur，hidden 存活 =================
try {
  await p.evaluate(id => {
    const st = window.__md2p.store;
    const cur = st.state.cur.map(x => ({ ...x }));
    cur.find(x => x.id === id).text = '第五段戊（再改）。';
    st.dispatch({ type: 'patchCur', cur });
  }, B5.id);
  await p.waitForTimeout(300);
  const sts = await p.evaluate(ids => {
    const s = window.__md2p.store.state;
    return ids.map(id => s.ops.find(o => o.id === id)?.state ?? 'pending');
  }, [R.id, D.id, I.id]);
  const newOp = await p.evaluate(bid => {
    const s = window.__md2p.store.state;
    const o = s.ops.find(o => o.blockId === bid && o.type === 'replace');
    return o ? (o.state ?? 'pending') : null;
  }, B5.id);
  const ok = sts.every(s => s === 'hidden') && newOp === 'pending';
  report('10. 隐藏后再 patchCur → 被隐藏 op 保持 hidden，新 op 正常 pending', ok,
    `hidden=${sts} newOp=${newOp}`);
} catch (e) { report('10. 隐藏后 patchCur', false, e.message); }
await shot(p, '10-hidden-survive');

// ================= 步骤 11：C 类组清空 =================
try {
  // 先造一个 withdrawn：D 当前 hidden，可直接撤回
  await act('withdraw', D.id);
  await act('withdraw2', D.id);
  const wlen1 = await withdrawnLen();
  await goTab('tomb'); // 「清空」钮在墓碑页签
  await act('clear-wd');
  await p.waitForTimeout(200);
  const wlen2 = await withdrawnLen();
  report('11. C 类组「清空」→ withdrawn 归零', wlen1 >= 1 && wlen2 === 0, `before=${wlen1} after=${wlen2}`);
} catch (e) { report('11. C 类组清空', false, e.message); }
await shot(p, '11-cleared');

// ================= 汇总 =================
console.log('\n==== 汇总 ====');
const fails = results.filter(r => !r.ok);
console.log(`共 ${results.length} 步，PASS ${results.length - fails.length}，FAIL ${fails.length}`);
for (const f of fails) console.log('  FAIL:', f.step);
console.log('console 报错:', consoleErrors.length ? JSON.stringify(consoleErrors, null, 2) : '无');
await b.close();
process.exit(fails.length ? 1 : 0);
