// 分屏同步调试探针
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
p.on('console', (m) => console.log('[page]', m.text()));
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
await p.waitForTimeout(800);

// 监控左右 scrollTop 变化
await p.evaluate(() => {
  const left = document.querySelector('.split-src .cm-scroller');
  const right = document.getElementById('split-view');
  window.__dbg = { leftLog: [], rightLog: [] };
  left.addEventListener('scroll', () => window.__dbg.leftLog.push(left.scrollTop));
  right.addEventListener('scroll', () => window.__dbg.rightLog.push(right.scrollTop));
});

// 右滚到 els[15] 顶
const r1 = await p.evaluate(() => {
  const right = document.getElementById('split-view');
  const els = [...right.querySelectorAll('.blk[data-line]')];
  const el = els[15];
  const rr = right.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  right.scrollTop = er.top - rr.top + right.scrollTop;
  return { targetLine: Number(el.dataset.line), elDocPos: er.top - rr.top + right.scrollTop, scrollTopNow: right.scrollTop };
});
await p.waitForTimeout(500);
const dbg = await p.evaluate(() => {
  const left = document.querySelector('.split-src .cm-scroller');
  const right = document.getElementById('split-view');
  const top = right.getBoundingClientRect().top;
  const els = [...right.querySelectorAll('.blk[data-line]')];
  const cover = els.find((el) => el.getBoundingClientRect().bottom > top);
  return {
    rightSet: r1Copy => r1Copy, // placeholder
    leftScrollTop: left.scrollTop,
    rightScrollTop: right.scrollTop,
    rightCoverLine: cover ? Number(cover.dataset.line) : null,
    leftLog: window.__dbg.leftLog.slice(-5),
    rightLog: window.__dbg.rightLog.slice(-5),
    cmContentFirstLine: document.querySelector('.split-src .cm-line')?.textContent,
  };
});
console.log('target:', JSON.stringify(r1));
console.log('dbg:', JSON.stringify(dbg, null, 1));
await b.close();
