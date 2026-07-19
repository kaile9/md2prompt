// CM DOM 结构直视
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto(HTML);
await p.waitForTimeout(800);
await p.evaluate(() => document.querySelector('.coach-modal button')?.click());
await p.evaluate(async () => {
  const parts = [];
  for (let i = 1; i <= 40; i++) parts.push(`## H${i} 标记`, '', `第 ${i} 段正文内容，用来填充行高并制造滚动空间。`, '');
  await window.__md2p.loadDocFile({ name: 't.md', kind: 'md', text: parts.join('\n'), mtime: Date.now() });
});
await p.waitForTimeout(1200);
await p.click('#mode-btn');
await p.waitForTimeout(400);
await p.click('#mode-btn');
await p.waitForFunction(() => document.getElementById('split-view')?.querySelectorAll('.blk[data-line]').length === 80);
await p.evaluate(() => {
  document.querySelector('.split-src .cm-scroller').scrollTop = 889;
});
await p.waitForTimeout(600);
const r = await p.evaluate(() => {
  const content = document.querySelector('.split-src .cm-content');
  const kids = [...content.children].slice(0, 8).map((c) => ({
    tag: c.tagName,
    cls: c.className,
    h: Math.round(c.getBoundingClientRect().height),
    text: c.textContent.slice(0, 14),
    y: Math.round(c.getBoundingClientRect().top),
  }));
  return {
    scrollerTop: Math.round(document.querySelector('.split-src .cm-scroller').getBoundingClientRect().top),
    scrollTop: Math.round(document.querySelector('.split-src .cm-scroller').scrollTop),
    kids,
  };
});
console.log(JSON.stringify(r, null, 1));
await b.close();
