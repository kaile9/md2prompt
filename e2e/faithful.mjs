// 门禁：flush 忠实性——首笔编辑不再带序列化器幻影（v2.0 乱跳根治回归）
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const fails = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`);
  if (!cond) fails.push(name);
};
const DOC = [
  '# 标题',
  '',
  '首段含 math_block 与 **加粗** 的文本。',
  '',
  '---',
  '',
  '| A | B |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '- 列表项一',
  '- 列表项二',
  '',
  '尾段等待真实编辑。',
].join('\n');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(HTML);
await p.waitForTimeout(800);
await p.evaluate(() => document.querySelector('.coach-modal button')?.click());
await p.evaluate(async (t) => {
  await window.__md2p.loadDocFile({ name: 't.md', kind: 'md', text: t, mtime: Date.now() });
}, DOC);
await p.waitForTimeout(2500);

// 空载必须零 op
ok('1. 载入空载零 op', (await p.evaluate(() => window.__md2p.store.state.ops.length)) === 0);

// 首段敲一个字（真实编辑），此前这类场景产生 10+ 幻影 op
await p.click('#doc .ProseMirror p', { position: { x: 120, y: 10 } });
await p.keyboard.press('End');
await p.keyboard.type('试');
await p.waitForTimeout(1500);
const ops = await p.evaluate(() => window.__md2p.store.state.ops.map((o) => ({ type: o.type, before: (o.before ?? '').slice(0, 12), after: o.after ?? '' })));
ok('2. 首笔编辑只记真实 op（无幻影）', ops.length === 1 && ops[0].type === 'replace' && ops[0].after.includes('试'), JSON.stringify(ops.map((o) => ({ ...o, after: o.after.slice(0, 24) }))));

// 再切节重绘后仍无幻影（序列化器方言不随 flush 累积）
await p.evaluate(() => window.__md2p.renderDoc());
await p.waitForTimeout(1200);
ok('3. 重绘后仍只有真实 op', (await p.evaluate(() => window.__md2p.store.state.ops.length)) === 1);

// 磁盘文本保持原式（--- 不被 *** 替换、列表子弹不变；转义只出现在被真实编辑的块）
const exported = await p.evaluate(() => {
  const st = window.__md2p.store.state;
  return window.__md2p.store.state ? st.cur.map((b) => b.text).join('\n\n') : '';
});
const escCount = (exported.match(/\\_/g) || []).length;
ok('4. cur 保留原式（hr=---、列表=-；转义仅被编块携带）', exported.includes('\n\n---\n\n') && exported.includes('- 列表项一') && escCount <= 1, `esc=${escCount}`);

await b.close();
if (fails.length) {
  console.log(`\n${fails.length} FAIL`);
  process.exit(1);
}
console.log('\nALL PASS');
