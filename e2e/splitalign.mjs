// 门禁：分屏块锚行对齐（BUG 3）——左源码行与右预览块互相对齐
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const fails = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`);
  if (!cond) fails.push(name);
};
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
ok('0. 分屏模式就绪', true);

/** 左窗顶可见行文本（跳过滚出视口的 activeLine） */
const leftTopVisible = () =>
  p.evaluate(() => {
    const top = document.querySelector('.split-src .cm-scroller').getBoundingClientRect().top;
    for (const el of document.querySelectorAll('.split-src .cm-line')) {
      const r = el.getBoundingClientRect();
      if (r.bottom > top + 4) return el.textContent;
    }
    return '';
  });

// 1. 右 → 左：右滚到 els[15]（para P8, line 31）顶 → 左顶可见行应落在 H8/P8 一带（±1 块容差）
await p.evaluate(() => {
  const right = document.getElementById('split-view');
  const els = [...right.querySelectorAll('.blk[data-line]')];
  const el = els[15];
  right.scrollTop = el.getBoundingClientRect().top - right.getBoundingClientRect().top + right.scrollTop;
});
await p.waitForTimeout(500);
const t1 = await leftTopVisible();
ok('1. 右滚到块顶 → 左顶行落同块（±1 块）', /H8 标记|第 8 段正文|H7 标记|H9 标记|第 7 段正文|第 9 段正文/.test(t1), `左顶行「${t1}」`);

// 2. 左 → 右：左滚到任意中部位置，读左顶实际行 → 右顶块应覆盖同一行（±1 块容差）
await p.evaluate(() => {
  document.querySelector('.split-src .cm-scroller').scrollTop = 1500;
});
await p.waitForTimeout(500);
const leftLine = await (async () => {
  const t = await leftTopVisible();
  const mh = /H(\d+) 标记/.exec(t);
  if (mh) return { line: Number(mh[1]) * 4 - 3, text: t };
  const mp = /第 (\d+) 段/.exec(t);
  if (mp) return { line: Number(mp[1]) * 4 - 1, text: t };
  return { line: 1, text: t };
})();
const cover = await p.evaluate(() => {
  const right = document.getElementById('split-view');
  const top = right.getBoundingClientRect().top;
  const els = [...right.querySelectorAll('.blk[data-line]')];
  for (let k = 0; k < els.length; k++) {
    const r = els[k].getBoundingClientRect();
    if (r.bottom > top) return { cur: Number(els[k].dataset.line), next: els[k + 1] ? Number(els[k + 1].dataset.line) : 999 };
  }
  return null;
});
const aligned = !!cover && cover.cur <= leftLine.line + 2 && cover.next >= leftLine.line - 2;
ok('2. 左滚 → 右顶块覆盖左顶行（±1 块）', aligned, `左顶「${leftLine.text}」(line ${leftLine.line}) ↔ 右顶块 ${JSON.stringify(cover)}`);

// 3. 回滚顶：双向仍对齐
await p.evaluate(() => {
  document.querySelector('.split-src .cm-scroller').scrollTop = 0;
});
await p.waitForTimeout(500);
const back = await p.evaluate(() => {
  const right = document.getElementById('split-view');
  const first = right.querySelector('.blk[data-line]');
  return Math.abs(first.getBoundingClientRect().top - right.getBoundingClientRect().top) < 40;
});
ok('3. 左回顶 → 右回到首块顶', back);

await b.close();
if (fails.length) {
  console.log(`\n${fails.length} FAIL`);
  process.exit(1);
}
console.log('\nALL PASS');
