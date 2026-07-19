// 门禁：源码/分屏批注与行内格式（BUG 4 Tier-1）
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const fails = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`);
  if (!cond) fails.push(name);
};
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(HTML);
await p.waitForTimeout(800);
await p.evaluate(() => document.querySelector('.coach-modal button')?.click());
await p.evaluate(async () => {
  const text = ['第一段正文用于源码模式批注测试。', '', '第二段保持不动等待加粗。', '', '第三段备用。'].join('\n');
  await window.__md2p.loadDocFile({ name: 't.md', kind: 'md', text, mtime: Date.now() });
});
await p.waitForTimeout(1200);

// 切到源码模式
await p.click('#mode-btn');
await p.waitForTimeout(600);
ok('0. 源码模式就绪', await p.evaluate(() => !!document.querySelector('#doc .cm-editor')));

// 选中「源码模式批注」几个字 → 浮卡出现
await p.click('#doc .cm-content', { position: { x: 80, y: 14 } });
for (let i = 0; i < 6; i++) await p.keyboard.press('Shift+ArrowRight');
await p.waitForTimeout(400);
ok('1. 源码模式选区浮卡出现', await p.evaluate(() => !document.getElementById('sel-card').hidden));

// 浮卡 B 加粗
await p.click('#sel-card .tb-btn:nth-child(1)');
await p.waitForTimeout(500);
ok('2. 源码模式浮卡加粗入账', await p.evaluate(() => window.__md2p.store.state.cur.some((x) => x.text.includes('**'))));

// Alt+M 批注（带选区 quote）
await p.click('#doc .cm-content', { position: { x: 60, y: 14 } });
for (let i = 0; i < 4; i++) await p.keyboard.press('Shift+ArrowRight');
await p.waitForTimeout(300);
await p.keyboard.press('Alt+m');
await p.waitForTimeout(500);
const floaterOpen = await p.evaluate(() => !!document.querySelector('.floater-modal textarea'));
ok('3. 源码模式 Alt+M 批注浮层打开', floaterOpen);
await p.keyboard.type('这是源码模式的批注');
await p.click('.floater-actions button:first-child');
await p.waitForTimeout(500);
const note = await p.evaluate(() => {
  const ops = window.__md2p.store.state.ops.filter((o) => o.type === 'note');
  return ops.length ? { note: ops[0].note, quote: ops[0].quote ?? '', kind: ops[0].kind ?? '' } : null;
});
ok('4. 批注入账（含 quote 与默认 request 型）', !!note && note.note === '这是源码模式的批注' && note.quote.length >= 4 && note.kind === 'request', JSON.stringify(note));

// 批注三型切换：改注为 discuss
await p.evaluate(() => document.dispatchEvent(new CustomEvent('md2p-edit-note', { detail: { id: window.__md2p.store.state.ops.find((o) => o.type === 'note').id } })));
await p.waitForTimeout(400);
await p.click('.note-kinds button:nth-child(3)');
await p.click('.floater-actions button:first-child');
await p.waitForTimeout(400);
ok('5. 批注类型可切 discuss', await p.evaluate(() => window.__md2p.store.state.ops.find((o) => o.type === 'note')?.kind === 'discuss'));

// 分屏模式：Alt+M 同样可用（点到第二段，避开已有批注的第一段）
await p.click('#mode-btn');
await p.waitForTimeout(600);
await p.click('.split-src .cm-content', { position: { x: 60, y: 70 } });
await p.keyboard.press('Alt+m');
await p.waitForTimeout(500);
const floater2 = await p.evaluate(() => !!document.querySelector('.floater-modal textarea'));
ok('6. 分屏模式 Alt+M 批注浮层打开', floater2);
if (floater2) {
  await p.keyboard.type('分屏里的第二条批注');
  await p.click('.floater-actions button:first-child');
  await p.waitForTimeout(400);
  ok('7. 分屏批注入账', (await p.evaluate(() => window.__md2p.store.state.ops.filter((o) => o.type === 'note').length)) >= 2);
}

await b.close();
if (fails.length) {
  console.log(`\n${fails.length} FAIL`);
  process.exit(1);
}
console.log('\nALL PASS');
