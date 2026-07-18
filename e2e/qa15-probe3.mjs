// qa15-probe3.mjs — 分屏内部 / XML 卡 flush 时机 / 路径复制 / minimap 默认 / 模式循环
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('[pageerror]', e.message));
await p.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
await p.goto(HTML);
await p.waitForFunction(() => !!window.__md2p?.store);

// ---- 模式循环：用 JS 点击，记录每步按钮文本与布局 ----
const modeState = () => p.evaluate(() => ({
  label: document.getElementById('mode-btn')?.textContent.trim(),
  wrap: !!document.querySelector('.split-wrap'),
  src: !!document.querySelector('.split-src'),
  view: !!document.querySelector('#split-view'),
  docInMain: !!document.querySelector('article#doc'),
  cm: !!document.querySelector('.cm-editor'),
}));
console.log('初始:', JSON.stringify(await modeState()));
for (let i = 1; i <= 4; i++) {
  await p.evaluate(() => document.getElementById('mode-btn').click());
  await p.waitForTimeout(500);
  console.log(`点击${i}:`, JSON.stringify(await modeState()));
}
// 目标：进入分屏（wrap=true）
for (let i = 0; i < 4; i++) {
  const s = await modeState();
  if (s.wrap) break;
  await p.evaluate(() => document.getElementById('mode-btn').click());
  await p.waitForTimeout(400);
}

// ---- 载入长文档后看分屏两侧 ----
const paras = [];
for (let i = 1; i <= 60; i++) paras.push(`第 ${i} 段：内容填充，滚动测试需要足够高度。`);
await p.evaluate(async (text) => {
  await window.__md2p.loadDocFile({ name: 'long.md', kind: 'md', mtime: Date.now(), text });
}, paras.join('\n\n'));
await p.waitForTimeout(800);
console.log('\n== 分屏结构 ==');
console.log(await p.evaluate(() => {
  const w = document.querySelector('.split-wrap');
  if (!w) return '无 split-wrap（当前非分屏）';
  const walk = (el, d) => d > 3 ? '' : '  '.repeat(d) + el.tagName + (el.id ? '#' + el.id : '') + '.' + String(el.className).replace(/\s+/g, '.').slice(0, 40) + ` scroll=${el.scrollHeight > el.clientHeight + 10}` + '\n' + [...el.children].slice(0, 6).map(c => walk(c, d + 1)).join('');
  return walk(w, 0);
}));
console.log('分屏滚动容器:', await p.evaluate(() => {
  const src = document.querySelector('.split-src');
  const view = document.querySelector('#split-view');
  const info = el => el ? { sh: el.scrollHeight, ch: el.clientHeight, st: el.scrollTop } : null;
  // src 里真正的滚动元素
  let srcScroller = null;
  if (src) {
    const all = [src, ...src.querySelectorAll('*')];
    srcScroller = all.find(e => e.scrollHeight > e.clientHeight + 50);
  }
  return JSON.stringify({ src: info(srcScroller), srcCls: srcScroller ? srcScroller.className || srcScroller.id : null, view: info(view) });
}));

// ---- minimap 与进度设置 ----
console.log('\n== minimap ==');
console.log(await p.evaluate(() => {
  const m = document.querySelector('#minimap');
  return JSON.stringify({
    exists: !!m, display: m ? getComputedStyle(m).display : null,
    kids: m ? m.children.length : 0,
    rect: m ? m.getBoundingClientRect().toJSON() : null,
    scroller: (() => { const s = document.querySelector('#scroller'); return s ? { sh: s.scrollHeight, ch: s.clientHeight } : null; })(),
  });
}));

// ---- 路径复制 ----
console.log('\n== 路径行（未设前缀）==');
console.log(await p.evaluate(() => [...document.querySelectorAll('.path-slot')].map(s => s.textContent.trim()).join(' || ')));
// 点击第一个 ⧉
const copyRes = await p.evaluate(async () => {
  const slot = document.querySelector('.path-slot');
  if (!slot) return '无 path-slot';
  slot.click();
  await new Promise(r => setTimeout(r, 300));
  try { return 'clip=' + await navigator.clipboard.readText(); } catch (e) { return 'clipErr=' + e.message; }
});
console.log('点击 path-slot 后剪贴板:', copyRes);
// 设前缀再试
await p.evaluate(() => window.__md2p.store.dispatch({ type: 'setDirPrefix', prefix: 'C:\\docs\\' })).catch(e => console.log('setDirPrefix 不存在:', e.message));
const hasDispatch = await p.evaluate(() => {
  // 试探有哪些 action type —— 无法枚举，改为直接改 localStorage?
  return null;
});
// 通过设置面板填 dirPrefix
await p.click('#settings-btn');
await p.waitForTimeout(300);
await p.fill('input[name="dirPrefix"]', 'C:\\docs\\');
await p.keyboard.press('Escape');
await p.waitForTimeout(400);
console.log('设前缀后路径行:', await p.evaluate(() => [...document.querySelectorAll('.path-slot')].map(s => s.textContent.trim()).join(' || ')));
console.log('设前缀后 .path 文本:', await p.evaluate(() => [...document.querySelectorAll('.path')].map(s => s.textContent).join(' || ')));
const copy2 = await p.evaluate(async () => {
  document.querySelector('.path-slot')?.click();
  await new Promise(r => setTimeout(r, 300));
  try { return await navigator.clipboard.readText(); } catch (e) { return 'ERR ' + e.message; }
});
console.log('设前缀后复制:', copy2);
console.log('LS:', await p.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage)).md2prompt)));

// ---- XML 卡 flush 时机（渲染模式）----
// 先回渲染模式
for (let i = 0; i < 4; i++) {
  const label = await p.evaluate(() => document.getElementById('mode-btn')?.textContent.trim());
  if (label.includes('源码')) break;
  await p.evaluate(() => document.getElementById('mode-btn').click());
  await p.waitForTimeout(400);
}
await p.evaluate(async () => {
  await window.__md2p.loadDocFile({ name: 'a.xml', kind: 'xml', mtime: Date.now(), text: '<identity>\n  <name>助手</name>\n  <note/>\n</identity>' });
});
await p.waitForTimeout(800);
console.log('\n== XML 卡 ==');
console.log('xml-card 存在:', await p.evaluate(() => !!document.querySelector('.xml-card')));
// 编辑：全选清空再打一段合法 XML
await p.click('.xml-card');
await p.keyboard.press('ControlOrMeta+a');
await p.keyboard.type('<identity><name>新助手</name><note/></identity>');
await p.waitForTimeout(300);
console.log('打字后(未blur) ops:', await p.evaluate(() => window.__md2p.store.state.ops.length));
await p.evaluate(() => document.activeElement?.blur());
await p.waitForTimeout(800);
console.log('blur 后 ops:', await p.evaluate(() => JSON.stringify(window.__md2p.store.state.ops.map(o => ({ type: o.type, before: (o.before || '').slice(0, 30), after: (o.after || '').slice(0, 30) })))));
console.log('cur:', await p.evaluate(() => JSON.stringify(window.__md2p.store.state.cur.map(x => x.text.slice(0, 50)))));
await b.close();
