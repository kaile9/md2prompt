// qa15-probe2.mjs — 交互探针：页签持久化键 / mode-btn 行为 / 路径行 / minimap 结构 / 批注卡 quote / XML 卡编辑
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('pageerror', e => console.log('[pageerror]', e.message));
await p.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
await p.goto(HTML);
await p.waitForFunction(() => !!window.__md2p?.store);
const ls = () => p.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage))));

// 1) 加载 md，切 tomb 页签，看 localStorage
await p.evaluate(async () => {
  await window.__md2p.loadDocFile({ name: 't.md', kind: 'md', mtime: Date.now(), text: '第一段。\n\n第二段。' });
});
await p.waitForTimeout(400);
await p.click('#changes [data-act="tab"][data-tab="tomb"]');
await p.waitForTimeout(300);
console.log('LS after tab=tomb:', await ls());

// 2) mode-btn 点击遍历
const dumpLayout = () => p.evaluate(() => ({
  modeBtnText: document.getElementById('mode-btn')?.textContent.trim(),
  splits: [...document.querySelectorAll('[class*="split"], #src, #source, textarea')].map(x => `${x.tagName}#${x.id}.${String(x.className).slice(0, 40)}`),
  docVisible: !!document.querySelector('#doc')?.offsetParent,
}));
console.log('\nlayout 初始:', JSON.stringify(await dumpLayout()));
for (let i = 0; i < 3; i++) {
  await p.click('#mode-btn');
  await p.waitForTimeout(500);
  console.log(`layout mode-btn x${i + 1}:`, JSON.stringify(await dumpLayout()));
}
// 回到渲染态：多点几次直到回到初始
for (let i = 0; i < 4; i++) {
  const t = await p.evaluate(() => document.getElementById('mode-btn')?.textContent.trim());
  if (t.includes('源码')) break;
  await p.click('#mode-btn'); await p.waitForTimeout(400);
}

// 3) 路径行：顶栏文件名区域
console.log('\n== 路径行候选 ==');
console.log(await p.evaluate(() => [...document.querySelectorAll('[class*="path"], [class*="file"], [id*="path"], [id*="file"]')]
  .filter(x => x.id || x.className).map(x => `${x.tagName}#${x.id}.${String(x.className).slice(0, 50)} text=${x.textContent.trim().slice(0, 50)}`).join('\n')));

// 4) minimap 结构
console.log('\n== minimap 结构 ==');
console.log(await p.evaluate(() => {
  const m = document.querySelector('#minimap');
  if (!m) return '无 #minimap';
  const walk = (el, d) => d > 3 ? '' : '  '.repeat(d) + el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).replace(/\s+/g, '.').slice(0, 40) : '') + ` kids=${el.children.length}\n` + [...el.children].slice(0, 8).map(c => walk(c, d + 1)).join('');
  return walk(m, 0);
}));

// 5) 批注卡：造 200 字 quote 的 note，看批注页签卡结构
await p.evaluate(async () => {
  const m = window.__md2p;
  const longDoc = '这是一段足够长的文字，用来承载一条两百字左右的批注引文，' + '引文需要能够在批注卡上默认单行截断显示并在点击后展开为多行，'.repeat(4) + '收尾。';
  await m.loadDocFile({ name: 'n.md', kind: 'md', mtime: Date.now(), text: longDoc });
  const bid = m.store.state.cur[0].id;
  const quote = m.store.state.cur[0].text.slice(0, 200);
  m.store.dispatch({ type: 'addNote', blockId: bid, note: '测试批注内容', quote });
});
await p.waitForTimeout(400);
await p.click('#changes [data-act="tab"][data-tab="note"]');
await p.waitForTimeout(300);
console.log('\n== 批注卡结构 ==');
console.log(await p.evaluate(() => {
  const card = document.querySelector('#changes .rev-row');
  if (!card) return '无卡';
  const walk = (el, d) => d > 4 ? '' : '  '.repeat(d) + el.tagName + (el.className ? '.' + String(el.className).replace(/\s+/g, '.').slice(0, 50) : '') + (el.dataset.act ? `[act=${el.dataset.act}]` : '') + ' text=' + el.textContent.trim().slice(0, 30) + '\n' + [...el.children].map(c => walk(c, d + 1)).join('');
  return walk(card, 0).slice(0, 2000);
}));
console.log('批注卡 data-act:', await p.evaluate(() => [...document.querySelectorAll('#changes .rev-row [data-act], #changes .rev-row')].map(x => `${x.tagName}.${String(x.className).slice(0, 30)} act=${x.dataset.act}`).join(' | ')));

// 6) XML 卡：怎么编辑 flush？
await p.evaluate(async () => {
  await window.__md2p.loadDocFile({ name: 'a.xml', kind: 'xml', mtime: Date.now(), text: '<identity>\n  <name>助手</name>\n  <note/>\n</identity>' });
});
await p.waitForTimeout(600);
console.log('\n== XML 卡 DOM ==');
console.log(await p.evaluate(() => {
  const c = document.querySelector('.xml-card');
  if (!c) return '无 .xml-card';
  const walk = (el, d) => d > 3 ? '' : '  '.repeat(d) + el.tagName + '.' + String(el.className).replace(/\s+/g, '.').slice(0, 40) + (el.isContentEditable ? '[CE]' : '') + '\n' + [...el.children].map(c => walk(c, d + 1)).join('');
  return walk(c, 0);
}));
// 尝试：点击 xml 卡，全选，输入
await p.click('.xml-card');
await p.keyboard.press('ControlOrMeta+a');
await p.keyboard.type('<identity><name>新名</name><note/></identity>');
await p.waitForTimeout(300);
// blur 触发 flush?
await p.click('#topbar, header, body', { position: { x: 10, y: 10 } }).catch(() => p.evaluate(() => document.activeElement?.blur()));
await p.waitForTimeout(600);
console.log('XML 编辑后 ops:', await p.evaluate(() => JSON.stringify(window.__md2p.store.state.ops.map(o => ({ id: o.id, type: o.type, before: (o.before || '').slice(0, 40), after: (o.after || '').slice(0, 40) })))));
console.log('XML 编辑后 cur:', await p.evaluate(() => JSON.stringify(window.__md2p.store.state.cur.map(x => ({ id: x.id, kind: x.kind, text: x.text.slice(0, 60) })))));
console.log('\nLS 最终:', await ls());
await b.close();
