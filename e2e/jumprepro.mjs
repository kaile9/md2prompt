import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const b = await chromium.launch();
const p = await b.newPage();
await p.goto(HTML);
await p.waitForTimeout(800);
const r = await p.evaluate(() =>
  ['open-btn', 'new-btn', 'settings-btn', 'mode-btn']
    .map((id) => `${id}:${document.getElementById(id)?.querySelector('svg') ? 'svg' : (document.getElementById(id)?.innerHTML ?? '').slice(0, 30)}`)
    .join(' | '),
);
console.log(r);
await b.close();
