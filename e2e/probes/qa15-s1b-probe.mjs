// qa15-s1b-probe.mjs — 深挖场景1 三个异常点的证据
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
import { mkdirSync } from 'node:fs';
mkdirSync(new URL('../e2e-shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), { recursive: true });
const SHOT = (n) => new URL(`../e2e-shots/qa15-${n}.png`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('pageerror', e => console.log('[pageerror]', e.message));
await p.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
await p.goto(HTML);
await p.waitForFunction(() => !!window.__md2p?.store);
const loadXml = (text) => p.evaluate(async (t) => {
  await window.__md2p.loadDocFile({ name: 'a.xml', kind: 'xml', mtime: Date.now(), text: t });
}, text);
const docDump = () => p.evaluate(() => {
  const d = document.querySelector('#doc');
  const cards = [...document.querySelectorAll('.xml-card')].map(c => ({ text: c.textContent.slice(0, 80), kids: c.children.length, ce: c.isContentEditable }));
  return { docHtml: d ? d.innerHTML.slice(0, 600) : '(no #doc)', cards };
});

// ---- A. 打字编辑后卡片到底渲染成什么 ----
await loadXml('<identity>\n  <name>测试助手</name>\n  <note/>\n</identity>');
await p.waitForTimeout(700);
await p.click('.xml-card');
await p.keyboard.press('ControlOrMeta+a');
await p.keyboard.type('<identity><name>全新助手</name><note/></identity>');
await p.waitForTimeout(900);
console.log('== A. 编辑后 ==');
console.log(JSON.stringify(await docDump(), null, 1).slice(0, 1200));
await p.screenshot({ path: SHOT('s1a-after-edit') });

// ---- B. 破坏配对后 cur/ops 全貌 ----
await loadXml('<identity>\n  <name>测试助手</name>\n  <note/>\n</identity>');
await p.waitForTimeout(700);
await p.click('.xml-card');
await p.keyboard.press('ControlOrMeta+a');
await p.keyboard.type('<identity>\n  <name>破损</name>\n  <note/>\n</ident', { delay: 30 });
await p.waitForTimeout(1000);
console.log('\n== B. 破坏配对后 ==');
console.log(await p.evaluate(() => {
  const s = window.__md2p.store.state;
  return JSON.stringify({
    curLen: s.cur.length,
    cur: s.cur.map(x => ({ id: x.id, kind: x.kind, text: x.text.slice(0, 40) })),
    ops: s.ops.map(o => ({ id: o.id, type: o.type, blockId: o.blockId, before: (o.before || '').slice(0, 25), after: (o.after || '').slice(0, 25) })),
  }, null, 1);
}));
await p.screenshot({ path: SHOT('s1b-broken') });

// ---- C. 载入含 ``` 的 XML 后卡片为何不渲染 ----
await loadXml('<script>\n```\nlet x = 1;\n```\n</script>');
await p.waitForTimeout(900);
console.log('\n== C. 含 ``` 载入后 ==');
console.log(JSON.stringify(await docDump(), null, 1).slice(0, 1500));
await p.screenshot({ path: SHOT('s1c-backticks') });

// 对照：不含 ``` 的 XML 正常渲染
await loadXml('<script>\nlet x = 1;\n</script>');
await p.waitForTimeout(900);
console.log('\n== C2. 不含 ``` 对照 ==');
console.log(JSON.stringify((await docDump()).cards));
await b.close();
