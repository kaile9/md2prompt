import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const b = await chromium.launch();
const p = await b.newPage();
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
await p.goto(HTML);
await p.waitForTimeout(900);

// 档三（危险标签转义代码块）+ 内容单反引号
await p.evaluate(async () => {
  await window.__md2p.loadDocFile({ name: 't.md', kind: 'md', text: '<script>\nlet x = `a`;\n</script>', mtime: Date.now() });
});
await p.waitForTimeout(1500);
console.log('script+backtick:', await p.evaluate(() => ({
  dom: document.getElementById('doc').innerHTML.slice(0, 400),
  cur: window.__md2p.store.state.cur.map((x) => x.text),
})));

// 档一（xml 卡）+ 内容单反引号
await p.evaluate(async () => {
  await window.__md2p.loadDocFile({ name: 't.md', kind: 'md', text: '<identity>\nlet `x` = 1;\n</identity>', mtime: Date.now() });
});
await p.waitForTimeout(1500);
console.log('xml+backtick:', await p.evaluate(() => ({
  card: !!document.querySelector('#doc .xml-card'),
  body: document.querySelector('#doc .xml-card-body')?.textContent,
  cur: window.__md2p.store.state.cur.map((x) => x.text),
})));

// 档一 + 内容三个反引号（极端：内含围栏）
await p.evaluate(async () => {
  await window.__md2p.loadDocFile({ name: 't.md', kind: 'md', text: '<identity>\n```js\nlet a = 1;\n```\n</identity>', mtime: Date.now() });
});
await p.waitForTimeout(1500);
console.log('xml+fence:', await p.evaluate(() => ({
  card: !!document.querySelector('#doc .xml-card'),
  body: document.querySelector('#doc .xml-card-body')?.textContent,
  html: document.getElementById('doc').innerHTML,
  cur: window.__md2p.store.state.cur.map((x) => x.text),
})));
await b.close();
