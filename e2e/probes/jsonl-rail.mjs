import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
await p.goto(HTML);
await p.waitForTimeout(900);
await p.evaluate(async () => {
  const text = '{"messages":[{"role":"user","content":"你好"},{"role":"assistant","content":"你好！有什么可以帮你？"}],"label":"ok"}\n{"text":"一条普通文本记录","label":"todo"}';
  await window.__md2p.loadDocFile({ name: 'd.jsonl', kind: 'jsonl', text, mtime: Date.now() });
});
await p.waitForTimeout(1200);
const railVisible = await p.evaluate(() => {
  const r = document.getElementById('tool-rail');
  return r ? getComputedStyle(r).display !== 'none' : false;
});
console.log('jsonl tool-rail visible:', railVisible);
await p.screenshot({ path: '../e2e-shots/v14-jsonl.png' });
await b.close();
