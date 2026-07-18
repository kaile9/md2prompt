import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const fails = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`);
  if (!cond) fails.push(name);
};
const b = await chromium.launch();
const p = await b.newPage();
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
await p.goto(HTML);
await p.waitForTimeout(1000);
// 含提示词式标签（带属性）+ 成对闭合 + mermaid 的样本文档（XML 三档契约回归）
const doc = [
  '# 标题', '',
  '<identity intent="干活">', '',
  '正文**一段**。', '',
  '</identity>', '',
  '普通段落二。', '',
  '```mermaid', 'graph TD; A-->B', '```',
].join('\n');
await p.evaluate(async (text) => {
  await window.__md2p.loadDocFile({ name: 't.md', kind: 'md', text, mtime: Date.now() });
}, doc);
await p.waitForTimeout(1800);

// 1) XML 三档：成对标签融合为一张卡（徽标 <identity>，属性折叠），v1.5 起卡内源文直接可编
const xml = await p.evaluate(() => ({
  cards: document.querySelectorAll('#doc .xml-card').length,
  badges: [...document.querySelectorAll('#doc .xml-badge')].map((e) => e.textContent),
  cardBody: document.querySelector('#doc .xml-card-body')?.textContent ?? '',
}));
ok('1. 提示词式标签融合成卡 + 源文卡内可见可编', xml.cards === 1 && xml.badges.includes('<identity>') && xml.cardBody.includes('正文') && xml.cardBody.includes('</identity>'), JSON.stringify(xml));

// 1b) 卡内直接编辑（Word 直觉）：点击定位到正文行 → 行尾打字 → flush → replace op 入账
await p.click('#doc .xml-card-body code', { position: { x: 40, y: 60 } });
await p.keyboard.press('End');
await p.keyboard.type('改');
await p.waitForTimeout(800);
const xmlOp = await p.evaluate(() => {
  const ops = window.__md2p.store.state.ops.filter((o) => o.type === 'replace');
  return ops.map((o) => ({ hit: o.after.includes('改'), tail: o.after.slice(-30) }));
});
ok('1b. XML 卡内直接入账（不弹浮层不整块替换）', xmlOp.some((o) => o.hit), JSON.stringify(xmlOp));

// 2) 切源码模式：CM 出现，文本含原文标签
await p.click('#mode-btn');
await p.waitForTimeout(800);
const src = await p.evaluate(() => ({
  cm: !!document.querySelector('#doc .cm-editor'),
  text: document.querySelector('#doc .cm-content')?.textContent ?? '',
}));
ok('2. 源码模式挂载，原文标签可见', src.cm && src.text.includes('<identity intent="干活">') && src.text.includes('</identity>'));

// 3) 源码里改一句 → flush → op 生成
await p.click('#doc .cm-content', { position: { x: 200, y: 60 } });
await p.keyboard.press('End');
await p.keyboard.type('改');
await p.waitForTimeout(700);
const ops1 = await p.evaluate(() => window.__md2p.store.state.ops.map((o) => o.type));
ok('3. 源码编辑入账', ops1.length >= 1, JSON.stringify(ops1));

// 4) 行号 gutter 存在；状态栏行列显示
const misc = await p.evaluate(() => ({
  gutters: document.querySelectorAll('#doc .cm-lineNumbers .cm-gutterElement').length,
  cursor: document.getElementById('cursor-pos').textContent,
}));
ok('4. CM 行号栏 + 状态栏行列', misc.gutters > 0 && /行 \d+ · 列 \d+/.test(misc.cursor), JSON.stringify(misc));

// 5) 循环切回渲染（源码 → 分屏 → 渲染）：Milkdown 回来，文本保真（序列化==原文+改动）
await p.click('#mode-btn'); // → 分屏
await p.waitForTimeout(800);
const split = await p.evaluate(() => ({
  splitView: !!document.getElementById('split-view'),
  srcVisible: !!document.querySelector('#doc .split-src .cm-editor'),
}));
ok('5a. 分屏对比：左源码右预览', split.splitView && split.srcVisible, JSON.stringify(split));
// 5b) 分屏结构（v1.5）：双侧等高独立滚动容器 + 页宽放开
const split2 = await p.evaluate(() => {
  const wrap = document.querySelector('.split-wrap');
  const l = document.querySelector('#doc .split-src .cm-scroller');
  const r = document.getElementById('split-view');
  return {
    wrapH: wrap ? Math.round(wrap.getBoundingClientRect().height) : 0,
    wide: document.getElementById('page').dataset.mode === 'split',
    lBox: l ? Math.round(l.getBoundingClientRect().height) : 0,
    rBox: r ? Math.round(r.getBoundingClientRect().height) : 0,
  };
});
ok('5b. 分屏等高双栏 + 页宽放开', split2.wrapH > 300 && split2.wide && Math.abs(split2.lBox - split2.rBox) < 40, JSON.stringify(split2));
await p.click('#mode-btn'); // → 渲染
await p.waitForTimeout(1200);
const back = await p.evaluate(() => ({
  pm: !!document.querySelector('#doc .ProseMirror'),
  text: window.__md2p.store.state.cur.map((x) => x.text).join('\n\n'),
}));
ok('5. 切回渲染且文本保真', back.pm && back.text.includes('改') && back.text.includes('<identity intent="干活">'), '');

// 6) mermaid 渲染存在（性能懒渲染不破坏既有能力）
const mer = await p.evaluate(() => !!document.querySelector('#doc .mermaid-svg svg, #doc .mermaid-block'));
ok('6. mermaid 块在档', mer);

await p.screenshot({ path: '../e2e-shots/v13-srcmode.png' });
console.log(fails.length ? `\nFAIL ${fails.length}` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
