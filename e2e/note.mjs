import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const fails = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`);
  if (!cond) fails.push(name);
};
const b = await chromium.launch();
const p = await b.newPage();
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
await p.goto(HTML);
await p.waitForTimeout(1000);
await p.evaluate(async () => {
  const text = ['他认为协议比编辑器重要，因此插件只是薄层。', '', '第二段内容保持不变。'].join('\n');
  await window.__md2p.loadDocFile({ name: 't.md', kind: 'md', text, mtime: Date.now() });
});
await p.waitForTimeout(1600);

// 1) 选中「协议比编辑器重要」：点段落开头附近再 Shift+Right
await p.click('#doc .ProseMirror p', { position: { x: 60, y: 10 } });
await p.waitForTimeout(200);
for (let i = 0; i < 10; i++) await p.keyboard.press('Shift+ArrowRight');
await p.waitForTimeout(300);
const fabVisible = await p.evaluate(() => !document.getElementById('sel-card').hidden);
ok('1. 选区出现批注浮钮', fabVisible);

// 2) 点浮钮 → 浮层 → 输入 → 保存
await p.click('#sel-card .tb-btn:last-child');
await p.waitForTimeout(400);
const floaterOpen = await p.evaluate(() => !!document.querySelector('#floater .floater-modal'));
ok('2. 浮层打开', floaterOpen);
await p.fill('#floater textarea', '这里逻辑跳跃，请补过渡');
await p.click('#floater .floater-actions button:first-child');
await p.waitForTimeout(400);
const op = await p.evaluate(() => {
  const o = window.__md2p.store.state.ops.find((x) => x.type === 'note');
  return o ? { note: o.note, quote: o.quote ?? null, blockId: o.blockId } : null;
});
ok('3. note op 生成且带 quote', !!op && !!op.quote, JSON.stringify(op));

// 4) 文档内选段下划线 + 批注钉
const marks = await p.evaluate(() => ({
  span: document.querySelectorAll('#doc .rev-note-span').length,
  pin: document.querySelectorAll('#doc .rev-pin').length,
}));
ok('4. 选段下划线 + 批注钉', marks.span === 1 && marks.pin === 1, JSON.stringify(marks));

// 5) 侧栏 B 卡显示引文（v1.5：批注卡住「批注」页签）
await p.click('#changes [data-act="tab"][data-tab="note"]');
await p.waitForTimeout(200);
const card = await p.evaluate(() => ({
  quote: document.querySelector('.rev-row .rev-quote')?.textContent ?? null,
  edit: !!document.querySelector('.rev-row [data-act="edit-note"]'),
}));
ok('5. B 卡引文 + 改注钮', !!card.quote && card.edit, JSON.stringify(card));

// 5b) 引文全文在 DOM（CSS 截断），点击展开/收起（v1.5）
await p.click('.rev-row .rev-quote');
await p.waitForTimeout(150);
const qexp = await p.evaluate(() => {
  const q = document.querySelector('.rev-row .rev-quote');
  const on = q.classList.contains('expanded');
  q.click();
  return { on, off: !q.classList.contains('expanded'), full: q.textContent.length >= 10 };
});
ok('5b. 引文点击展开/收起且全文在 DOM', qexp.on && qexp.off && qexp.full, JSON.stringify(qexp));

// 6) 改注：预填原文，改后 op.note 更新
await p.click('.rev-row [data-act="edit-note"]');
await p.waitForTimeout(400);
const prefilled = await p.evaluate(() => document.querySelector('#floater textarea')?.value ?? '');
ok('6a. 改注浮层预填', prefilled === '这里逻辑跳跃，请补过渡', prefilled);
await p.fill('#floater textarea', '改成：请补一个过渡论证');
await p.click('#floater .floater-actions button:first-child');
await p.waitForTimeout(400);
const note2 = await p.evaluate(() => window.__md2p.store.state.ops.find((x) => x.type === 'note')?.note);
ok('6b. 批注已更新', note2 === '改成：请补一个过渡论证', note2 ?? '');

// 7) 导出含 <range>（选段原文），且为修改后的 note（2.0：note 收进属性）
const prompt = await p.evaluate(async () => await window.__md2p.buildPrompt(window.__md2p.store.state));
ok('7. Prompt 含 range 与新批注', prompt.includes('<range>') && prompt.includes('改成：请补一个过渡论证'));

// 8) 同块再次 Alt+M → 编辑模式（预填现有批注，不产生第二条）
await p.click('#doc .ProseMirror p', { position: { x: 30, y: 10 } });
await p.keyboard.press('Alt+m');
await p.waitForTimeout(600);
const prefilled2 = await p.evaluate(() => document.querySelector('#floater textarea')?.value ?? '');
ok('8. Alt+M 重进为编辑模式', prefilled2 === '改成：请补一个过渡论证', prefilled2);
await p.keyboard.press('Escape');
await p.screenshot({ path: '../e2e-shots/v13-note-flow.png' });

console.log(fails.length ? `\nFAIL ${fails.length}` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
