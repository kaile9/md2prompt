// qa15-s3-path.mjs — 场景3：路径前缀去重斜杠 / 复制内容 / 清空恢复
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

// 剪贴板间谍
await p.evaluate(() => {
  window.__copied = [];
  try {
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (t) => { window.__copied.push(String(t)); return orig(t); };
  } catch (e) { window.__copied.push('spyfail:' + e.message); }
});

const setPrefix = async (v) => {
  await p.click('#settings-btn');
  await p.waitForTimeout(300);
  await p.fill('input[name="dirPrefix"]', v);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
};
const paths = () => p.evaluate(() => [...document.querySelectorAll('.path')].map(x => x.textContent));

// ---- 3.1 无前缀基线 ----
const base = await paths();
report('3.1 无前缀时显示纯文件名', base[0] === 'note.md' && base[1] === 'note.prompt.md', JSON.stringify(base));

// ---- 3.2 带尾斜杠前缀 ----
await setPrefix('C:\\docs\\');
const p1 = await paths();
report('3.2 前缀 C:\\docs\\（带尾斜杠）→ 显示去重单斜杠', p1[0] === 'C:\\docs\\note.md' && p1[1] === 'C:\\docs\\note.prompt.md', JSON.stringify(p1));

// ---- 3.3 不带尾斜杠前缀 ----
await setPrefix('C:\\docs');
const p2 = await paths();
report('3.3 前缀 C:\\docs（无尾斜杠）→ 自动补分隔符', p2[0] === 'C:\\docs\\note.md', JSON.stringify(p2));

// ---- 3.4 正斜杠前缀 ----
await setPrefix('D:/资料/');
const p3 = await paths();
report('3.4 前缀 D:/资料/ → 拼接正确', p3[0] === 'D:/资料/note.md', JSON.stringify(p3));

// ---- 3.5 复制内容 ----
await setPrefix('C:\\docs\\');
await p.evaluate(() => { window.__copied = []; });
// 点击文档路径的 ⧉ 复制钮（v2 交互：点路径文本=展开/收起，复制只走 ⧉ 钮，同 s3b 补测）
const copyHtml = await p.evaluate(() => document.querySelector('.path-slot')?.outerHTML?.slice(0, 300));
await p.click('.path-slot [data-act="pcopy"]');
await p.waitForTimeout(400);
let copied = await p.evaluate(() => window.__copied.slice());
let clip = null;
try { clip = await p.evaluate(() => navigator.clipboard.readText()); } catch (e) { clip = 'readErr:' + e.message; }
report('3.5 复制内容为拼接后完整路径', copied[0] === 'C:\\docs\\note.md' || clip === 'C:\\docs\\note.md',
  `spy=${JSON.stringify(copied)} clip=${JSON.stringify(clip)} slotHtml=${copyHtml}`);

// ---- 3.6 清空前缀恢复纯文件名 ----
await setPrefix('');
const p4 = await paths();
report('3.6 清空前缀 → 恢复纯文件名', p4[0] === 'note.md' && p4[1] === 'note.prompt.md', JSON.stringify(p4));

// ---- 3.7 仅空白前缀视为空 ----
await setPrefix('   ');
const p5 = await paths();
report('3.7 纯空白前缀按空前缀处理', p5[0] === 'note.md', JSON.stringify(p5));

console.log('\n==== 场景3 汇总 ====');
const fails = results.filter(r => !r.ok);
console.log(`PASS ${results.length - fails.length}/${results.length}`);
for (const f of fails) console.log('  FAIL:', f.name);
await b.close();
