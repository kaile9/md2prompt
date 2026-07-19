// CM 滚动方式对比：直接 scrollTop vs requestMeasure vs scrollIntoView
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
  return right && right.querySelectorAll('.blk[data-line]').length === 80;
});
const probe = (label) =>
  p.evaluate((label) => {
    const sc = document.querySelector('.split-src .cm-scroller');
    return {
      label,
      scrollTop: Math.round(sc.scrollTop),
      clientH: sc.clientHeight,
      scrollH: sc.scrollHeight,
      firstLine: document.querySelector('.split-src .cm-line')?.textContent,
      cmEditorH: document.querySelector('.split-src .cm-editor').getBoundingClientRect().height,
      scrollerComputed: getComputedStyle(sc).overflowY + '/' + getComputedStyle(sc).height,
    };
  }, label);
console.log(JSON.stringify(await probe('初始')));
// A：直接 scrollTop = 889
await p.evaluate(() => {
  document.querySelector('.split-src .cm-scroller').scrollTop = 889;
});
await p.waitForTimeout(400);
console.log(JSON.stringify(await probe('A 直接scrollTop=889')));
// B：先 0 再 889（逼事件）+ 更长等待
await p.evaluate(() => {
  const sc = document.querySelector('.split-src .cm-scroller');
  sc.scrollTop = 0;
  sc.dispatchEvent(new Event('scroll'));
});
await p.waitForTimeout(200);
await p.evaluate(() => {
  document.querySelector('.split-src .cm-scroller').scrollTop = 889;
});
await p.waitForTimeout(800);
console.log(JSON.stringify(await probe('B 事件驱动 889')));
await b.close();
