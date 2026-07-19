// scrollSourceToFrac 隔离探针：直接驱动右滚，分解右处理器每一步
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
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
await p.waitForFunction(() => {
  const right = document.getElementById('split-view');
  const left = document.querySelector('.split-src .cm-scroller');
  return right && right.querySelectorAll('.blk[data-line]').length === 80 && left && left.scrollHeight > 4000;
});
// 监听左滚动
await p.evaluate(() => {
  const left = document.querySelector('.split-src .cm-scroller');
  window.__leftLog = [];
  left.addEventListener('scroll', () => window.__leftLog.push(Math.round(left.scrollTop)));
});
// 右滚到 els[15] 顶
await p.evaluate(() => {
  const right = document.getElementById('split-view');
  const els = [...right.querySelectorAll('.blk[data-line]')];
  const el = els[15];
  const rr = right.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  right.scrollTop = er.top - rr.top + right.scrollTop;
});
await p.waitForTimeout(600);
const r = await p.evaluate(() => {
  const left = document.querySelector('.split-src .cm-scroller');
  return {
    leftLog: window.__leftLog.slice(-6),
    leftScrollTop: left.scrollTop,
    firstLine: document.querySelector('.split-src .cm-line')?.textContent,
  };
});
console.log('after right scroll:', JSON.stringify(r));
await b.close();
