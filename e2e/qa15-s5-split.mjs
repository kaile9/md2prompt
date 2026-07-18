// qa15-s5-split.mjs — 场景5：分屏滚动比例跟随 + 左侧编辑右侧 1s 内刷新
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const results = [];
const report = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + String(detail).slice(0, 400) : ''}`); };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('pageerror', e => console.log('[pageerror]', e.message));
await p.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
await p.goto(HTML);
await p.waitForFunction(() => !!window.__md2p?.store);

const paras = [];
for (let i = 1; i <= 80; i++) paras.push(`第 ${i} 段：分屏滚动同步测试用填充文字，需要足够的文档高度才能拉开滚动距离。`);
await p.evaluate(async (t) => {
  await window.__md2p.loadDocFile({ name: 'split.md', kind: 'md', mtime: Date.now(), text: t });
}, paras.join('\n\n'));
await p.waitForTimeout(1000);

// 进入分屏：真实点击 mode-btn 直到 .split-wrap 出现
let entered = false;
for (let i = 0; i < 5; i++) {
  await p.click('#mode-btn');
  await p.waitForTimeout(600);
  if (await p.evaluate(() => !!document.querySelector('.split-wrap'))) { entered = true; break; }
}
report('5.0 进入分屏模式', entered, entered ? '' : 'mode-btn 点击 5 次仍无 .split-wrap');

// 分屏结构摸底
const layout = await p.evaluate(() => {
  const src = document.querySelector('.split-src');
  const view = document.querySelector('#split-view');
  const scOf = (root) => {
    if (!root) return null;
    const all = [root, ...root.querySelectorAll('*')];
    const el = all.find(e => e.scrollHeight > e.clientHeight + 50);
    return el ? { sel: el.id ? '#' + el.id : el.className ? '.' + String(el.className).split(' ')[0] : el.tagName, sh: el.scrollHeight, ch: el.clientHeight } : null;
  };
  return { srcSc: scOf(src), viewSc: scOf(view), srcKids: src ? [...src.children].map(c => `${c.tagName}#${c.id}.${String(c.className).slice(0, 30)}`) : null, hasTextarea: !!src?.querySelector('textarea'), hasCm: !!src?.querySelector('.cm-editor') };
});
console.log('分屏结构:', JSON.stringify(layout, null, 1));

const getScrolls = () => p.evaluate(() => {
  const src = document.querySelector('.split-src');
  const view = document.querySelector('#split-view');
  const scOf = (root) => [root, ...root.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 50);
  const l = scOf(src), r = scOf(view);
  const ratio = el => el ? el.scrollTop / (el.scrollHeight - el.clientHeight) : null;
  return { l: ratio(l), r: ratio(r), lSt: Math.round(l?.scrollTop), rSt: Math.round(r?.scrollTop) };
});
const setLeft = (ratio) => p.evaluate((rt) => {
  const src = document.querySelector('.split-src');
  const l = [src, ...src.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 50);
  l.scrollTop = rt * (l.scrollHeight - l.clientHeight);
}, ratio);

// ---- 5.1 左栏滚到底部，右栏按比例跟随 ----
await setLeft(1);
await p.waitForTimeout(600);
const s1 = await getScrolls();
report('5.1 左栏滚到底 → 右栏比例跟随（误差<25%）', s1.l === 1 && s1.r !== null && Math.abs(s1.r - 1) < 0.25, JSON.stringify(s1));

// ---- 5.1b 左栏滚到 40%，右栏跟随 ----
await setLeft(0.4);
await p.waitForTimeout(600);
const s2 = await getScrolls();
report('5.1b 左栏滚到 40% → 右栏比例跟随（误差<25%）', s2.r !== null && Math.abs(s2.r - 0.4) < 0.25, JSON.stringify(s2));

// ---- 5.2 左侧源码编辑 → 右侧预览 1s 内刷新 ----
// 滚回顶部，在源码开头插入标记文本
await setLeft(0);
await p.waitForTimeout(400);
const edited = await p.evaluate(() => {
  const src = document.querySelector('.split-src');
  const ta = src?.querySelector('textarea');
  const cm = src?.querySelector('.cm-editor');
  return { ta: !!ta, cm: !!cm, ce: src?.querySelector('[contenteditable="true"]') ? true : false };
});
console.log('左侧编辑器形态:', JSON.stringify(edited));

const MARK = '分屏刷新标记XYZ';
let typed = false;
if (edited.ta) {
  await p.click('.split-src textarea');
  await p.keyboard.press('ControlOrMeta+Home');
  await p.keyboard.type(MARK);
  typed = true;
} else if (edited.cm) {
  await p.click('.split-src .cm-content');
  await p.keyboard.press('ControlOrMeta+Home');
  await p.keyboard.type(MARK);
  typed = true;
}
report('5.2a 左侧可编辑（textarea/CodeMirror）', typed, JSON.stringify(edited));

if (typed) {
  const t0 = Date.now();
  let appeared = -1;
  for (let i = 0; i < 20; i++) {
    await p.waitForTimeout(100);
    const has = await p.evaluate((mk) => document.querySelector('#split-view')?.textContent?.includes(mk), MARK);
    if (has) { appeared = Date.now() - t0; break; }
  }
  report('5.2b 右侧预览 1 秒内刷新出左侧新文本', appeared >= 0 && appeared <= 1000, `延迟=${appeared}ms`);
}

console.log('\n==== 场景5 汇总 ====');
const fails = results.filter(r => !r.ok);
console.log(`PASS ${results.length - fails.length}/${results.length}`);
for (const f of fails) console.log('  FAIL:', f.name);
await b.close();
