// 分屏几何与渲染完成度探针
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
await p.waitForTimeout(2000); // 等渐进渲染
const g = await p.evaluate(() => {
  const left = document.querySelector('.split-src .cm-scroller');
  const right = document.getElementById('split-view');
  const lines = [...document.querySelectorAll('.split-src .cm-line')];
  const content = document.querySelector('.split-src .cm-content');
  const blks = [...right.querySelectorAll('.blk[data-line]')];
  return {
    leftClientH: left.clientHeight,
    leftScrollH: left.scrollHeight,
    leftRectH: left.getBoundingClientRect().height,
    cmLineCount: lines.length,
    cmContentPadTop: getComputedStyle(content).paddingTop,
    cmFirstLines: lines.slice(0, 3).map((l) => l.textContent),
    rightClientH: right.clientHeight,
    rightScrollH: right.scrollHeight,
    blkCount: blks.length,
    blkFirst: blks[0]?.dataset.line,
    blkLast: blks[blks.length - 1]?.dataset.line,
    rightChildren: [...right.children].map((c) => c.className).slice(0, 5),
  };
});
console.log(JSON.stringify(g, null, 1));
await b.close();
