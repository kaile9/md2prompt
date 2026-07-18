// qa15-s3b-copy.mjs — 场景3 补测：⧉ 复制钮（data-act=pcopy）+ 混合斜杠细节
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const results = [];
const report = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + String(detail).slice(0, 400) : ''}`); };

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('[pageerror]', e.message));
await p.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
await p.goto(HTML);
await p.waitForFunction(() => !!window.__md2p?.store);
await p.evaluate(async () => {
  await window.__md2p.loadDocFile({ name: 'note.md', kind: 'md', mtime: Date.now(), text: '第一段。\n\n第二段。' });
});
await p.waitForTimeout(500);
await p.evaluate(() => {
  window.__copied = [];
  const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
  navigator.clipboard.writeText = (t) => { window.__copied.push(String(t)); return orig(t); };
});
const setPrefix = async (v) => {
  await p.click('#settings-btn'); await p.waitForTimeout(300);
  await p.fill('input[name="dirPrefix"]', v);
  await p.keyboard.press('Escape'); await p.waitForTimeout(400);
};

await setPrefix('C:\\docs\\');
// 文档路径复制
await p.click('[data-act="pcopy"][data-p="doc"]');
await p.waitForTimeout(300);
let spy = await p.evaluate(() => window.__copied.slice());
let clip = await p.evaluate(() => navigator.clipboard.readText().catch(e => 'ERR:' + e.message));
report('3.5a 文档 ⧉ 复制 = C:\\docs\\note.md', spy[0] === 'C:\\docs\\note.md' || clip === 'C:\\docs\\note.md', `spy=${JSON.stringify(spy)} clip=${JSON.stringify(clip)}`);
// 日记路径复制
await p.evaluate(() => { window.__copied = []; });
await p.click('[data-act="pcopy"][data-p="prompt"]');
await p.waitForTimeout(300);
spy = await p.evaluate(() => window.__copied.slice());
clip = await p.evaluate(() => navigator.clipboard.readText().catch(e => 'ERR:' + e.message));
report('3.5b 日记 ⧉ 复制 = C:\\docs\\note.prompt.md', spy[0] === 'C:\\docs\\note.prompt.md' || clip === 'C:\\docs\\note.prompt.md', `spy=${JSON.stringify(spy)} clip=${JSON.stringify(clip)}`);

// 无前缀时复制 = 纯文件名？
await setPrefix('');
await p.evaluate(() => { window.__copied = []; });
await p.click('[data-act="pcopy"][data-p="doc"]');
await p.waitForTimeout(300);
spy = await p.evaluate(() => window.__copied.slice());
report('3.5c 无前缀时复制 = note.md', spy[0] === 'note.md', `spy=${JSON.stringify(spy)}`);

// 混合斜杠细节：正斜杠前缀
await setPrefix('D:/资料/');
const disp = await p.evaluate(() => document.querySelector('.path')?.textContent);
console.log('混合斜杠显示:', JSON.stringify(disp));
report('3.4b 正斜杠前缀不使用反斜杠拼接', disp === 'D:/资料/note.md', `实际=${JSON.stringify(disp)}`);
await p.evaluate(() => { window.__copied = []; });
await p.click('[data-act="pcopy"][data-p="doc"]');
await p.waitForTimeout(300);
spy = await p.evaluate(() => window.__copied.slice());
console.log('混合斜杠复制:', JSON.stringify(spy));

console.log('\n==== 场景3 补测汇总 ====');
const fails = results.filter(r => !r.ok);
console.log(`PASS ${results.length - fails.length}/${results.length}`);
for (const f of fails) console.log('  FAIL:', f.name);
await b.close();
