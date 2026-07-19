// 门禁：XML 源码承载 + 单块 diff（审查 B1 回归）
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
  const text = '<root>\n  <item id="1">甲</item>\n  <item id="2">乙</item>\n</root>\n';
  await window.__md2p.loadDocFile({ name: 't.xml', kind: 'xml', text, mtime: Date.now() });
});
await p.waitForTimeout(1200);

ok('1. XML 由 CM 源码承载（无 PM）', await p.evaluate(() => !!document.querySelector('#doc .cm-editor') && !document.querySelector('#doc .ProseMirror')));
ok('2. 载入即单 code 块', await p.evaluate(() => {
  const cur = window.__md2p.store.state.cur;
  return cur.length === 1 && cur[0].kind === 'code' && cur[0].meta?.lang === 'xml';
}));

// 编辑：CM 内末尾追加一行
await p.click('#doc .cm-content', { position: { x: 60, y: 14 } });
await p.keyboard.press('Control+ArrowDown');
await p.keyboard.press('End');
await p.keyboard.type('\n  <item id="3">丙</item>');
await p.waitForTimeout(800);
const st = await p.evaluate(() => {
  const s = window.__md2p.store.state;
  return { blocks: s.cur.length, kinds: s.cur.map((x) => x.kind).join(','), ops: s.ops.map((o) => o.type) };
});
ok('3. 编辑后仍单块（不碎成 md 块）', st.blocks === 1 && st.kinds === 'code', JSON.stringify(st));
ok('4. diff 为单条 replace（非全文 delete+insert 噪音）', st.ops.length === 1 && st.ops[0] === 'replace', JSON.stringify(st.ops));

// Prompt 导出：revise 成对 original/alter，patch 或全文皆可但必须单条
const prompt = await p.evaluate(async () => await window.__md2p.buildPrompt(window.__md2p.store.state));
const reviseCount = (prompt.match(/<revise /g) || []).length;
ok('5. Prompt 单条 revise 且含 alter-hash 或全文 original', reviseCount === 1 && (prompt.includes('form="patch"') || prompt.includes('<original>')), `revise=${reviseCount} patch=${prompt.includes('form="patch"')}`);

// 模式钮对 XML 禁用（只有一个诚实视图）
await p.click('#mode-btn');
await p.waitForTimeout(400);
ok('6. 模式钮不破坏 XML 视图', await p.evaluate(() => !!document.querySelector('#doc .cm-editor') && !document.querySelector('#doc .ProseMirror')));

await b.close();
if (fails.length) {
  console.log(`\n${fails.length} FAIL`);
  process.exit(1);
}
console.log('\nALL PASS');
