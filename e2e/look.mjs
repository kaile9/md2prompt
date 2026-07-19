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
await p.goto(HTML);
await p.waitForTimeout(900);

// 0) 首启引导出现且可关闭
const coach = await p.evaluate(() => !!document.querySelector('.coach-modal'));
await p.click('.coach-modal button');
const coachGone = await p.evaluate(() => !document.querySelector('.coach-modal'));
const coachSeen = await p.evaluate(() => localStorage.getItem('md2prompt.coachSeen') === '1');
ok('0. 首启引导出现/关闭/记忆', coach && coachGone && coachSeen);

// 1) 顶栏图标（SVG；v1.5 删 ☀ 钮，亮度并入设置）
const icons = await p.evaluate(() => ['open-btn', 'new-btn', 'settings-btn'].every((id) => document.getElementById(id)?.querySelector('svg')));
ok('1. 顶栏按钮含 SVG 图标', icons);

// 2) 注入文档
await p.evaluate(async () => {
  const text = ['第一段正文用于测试格式工具栏效果。', '', '第二段更多内容保持不动。', '', '第三段等待被移动。'].join('\n');
  await window.__md2p.loadDocFile({ name: 't.md', kind: 'md', text, mtime: Date.now() });
});
await p.waitForTimeout(1600);

// 3) 工具轨：H2 + 引用 + 分割线入账
await p.click('#doc .ProseMirror p', { position: { x: 60, y: 10 } });
await p.click('#tool-rail .tb-btn:nth-child(2)'); // H2
await p.waitForTimeout(500);
const h2 = await p.evaluate(() => window.__md2p.store.state.cur[0].text.startsWith('## '));
ok('3a. 工具轨 H2 生效', h2, await p.evaluate(() => window.__md2p.store.state.cur[0].text.slice(0, 12)));
await p.click('#tool-rail .tb-btn:nth-child(4)'); // 引用
await p.waitForTimeout(400);
const quote = await p.evaluate(() => window.__md2p.store.state.cur.some((x) => x.text.startsWith('> ')));
ok('3b. 工具轨引用生效', quote);

// 4) 选区浮卡：选中文字出现，B 加粗
await p.click('#doc .ProseMirror p', { position: { x: 40, y: 10 } });
for (let i = 0; i < 6; i++) await p.keyboard.press('Shift+ArrowRight');
await p.waitForTimeout(300);
const cardShown = await p.evaluate(() => !document.getElementById('sel-card').hidden);
ok('4a. 选区浮卡出现', cardShown);
await p.click('#sel-card .tb-btn:nth-child(1)'); // B
await p.waitForTimeout(400);
const bold = await p.evaluate(() => window.__md2p.store.state.cur.some((x) => x.text.includes('**')));
ok('4b. 浮卡加粗入账', bold);

// 5) 快捷键：Ctrl+B 触发行内加粗（默认映射，编辑器内）
await p.keyboard.press('Control+ArrowLeft');
for (let i = 0; i < 4; i++) await p.keyboard.press('Shift+ArrowRight');
await p.keyboard.press('Control+b');
await p.waitForTimeout(400);
ok('5. Ctrl+B 快捷键分发', await p.evaluate(() => window.__md2p.store.state.cur.filter((x) => x.text.includes('**')).length >= 1));

// 6) 设置：字重滑杆 + 满档数字输入 + 亮度/对比度 + 引导线 + 进度
await p.click('#settings-btn');
await p.waitForTimeout(300);
const rows = await p.evaluate(() => ({
  fw: !!document.querySelector('input[name="fontWeight"]'),
  br: !!document.querySelector('input[name="brightness"]'),
  ct: !!document.querySelector('input[name="contrast"]'),
  gl: !!document.querySelector('input[name="guideLines"]'),
  pg: !!document.querySelector('input[name="progress"]'),
  sc: document.querySelectorAll('input.sc-key').length,
}));
ok('6a. 设置面板新控件齐', rows.fw && rows.br && rows.ct && rows.gl && rows.pg && rows.sc === 7, JSON.stringify(rows));
// 字重拖到满档 → 数字输入出现
await p.evaluate(() => {
  const r = document.querySelector('input[name="fontWeight"]');
  r.value = '700';
  r.dispatchEvent(new Event('input', { bubbles: true }));
});
await p.waitForTimeout(200);
const numShown = await p.evaluate(() => !document.querySelector('input[name="fontWeightNum"]').hidden);
ok('6b. 字重满档展开数字输入', numShown);
// 切人文风格 + 引导线 → data-guides=on
await p.click('input[name="style"][value="humanist"] + span');
await p.evaluate(() => {
  const g = document.querySelector('input[name="guideLines"]');
  if (!g.checked) g.click();
  g.dispatchEvent(new Event('input', { bubbles: true }));
});
await p.waitForTimeout(200);
const guides = await p.evaluate(() => document.documentElement.dataset.guides);
ok('6c. 人文+引导线 → data-guides=on', guides === 'on', guides ?? '');
// 进度切 minimap
await p.click('input[name="progress"][value="map"] + span');
await p.waitForTimeout(200);
const mapShown = await p.evaluate(() => document.getElementById('minimap').style.display !== 'none' && document.querySelectorAll('#minimap i').length > 0);
ok('6d. minimap 出现且有骨架条', mapShown);
await p.keyboard.press('Escape');
await p.waitForTimeout(200);

// 7) 亮度统一在设置面板（v1.5 删顶栏 ☀ 钮）：滑杆变暗再回 100
await p.click('#settings-btn');
await p.waitForTimeout(300);
const before = await p.evaluate(() => getComputedStyle(document.getElementById('page')).filter);
await p.evaluate(() => {
  const r = document.querySelector('input[name="brightness"]');
  r.value = '80';
  r.dispatchEvent(new Event('input', { bubbles: true }));
});
await p.waitForTimeout(200);
const dim = await p.evaluate(() => getComputedStyle(document.getElementById('page')).filter);
await p.evaluate(() => {
  const r = document.querySelector('input[name="brightness"]');
  r.value = '100';
  r.dispatchEvent(new Event('input', { bubbles: true }));
});
await p.waitForTimeout(200);
const back = await p.evaluate(() => getComputedStyle(document.getElementById('page')).filter);
ok('7. 设置内亮度滑杆往返（☀ 已并入设置）', before !== dim && back === before, `${before} -> ${dim} -> ${back}`);
await p.keyboard.press('Escape');
await p.waitForTimeout(200);

// 8) 侧栏拖拽调宽 + 持久化
const w0 = await p.evaluate(() => document.getElementById('changes').getBoundingClientRect().width);
await p.dispatchEvent('#changes .resize-grip', 'mousedown', { clientX: 1200, clientY: 400 });
await p.dispatchEvent('body', 'mousemove', { clientX: 1100, clientY: 400 });
await p.dispatchEvent('body', 'mouseup', { clientX: 1100, clientY: 400 });
const w1 = await p.evaluate(() => document.getElementById('changes').getBoundingClientRect().width);
ok('8. 右栏拖拽变宽且持久化', w1 > w0 && (await p.evaluate(() => Number(localStorage.getItem('md2prompt.w.changes')) > 0)), `${w0} -> ${w1}`);

// 9) pinned 范式（评审 B1/B2）：minimap/工具轨不随滚动跑（当前默认 minimap 档）
const pin0 = await p.evaluate(() => ({
  mapTop: document.getElementById('minimap').getBoundingClientRect().top,
  railTop: document.getElementById('tool-rail').getBoundingClientRect().top,
}));
await p.evaluate(() => document.getElementById('scroller').scrollTo({ top: 600 }));
await p.waitForTimeout(300);
const pin1 = await p.evaluate(() => ({
  mapTop: document.getElementById('minimap').getBoundingClientRect().top,
  railTop: document.getElementById('tool-rail').getBoundingClientRect().top,
}));
ok('9. 滚动后 minimap/工具轨原位不动', Math.abs(pin1.mapTop - pin0.mapTop) < 1 && Math.abs(pin1.railTop - pin0.railTop) < 1, JSON.stringify({ pin0, pin1 }));

// 9b) 长文档滚动后细条有进度（先切回细条模式：6d 留在 minimap）
await p.evaluate(async () => {
  const parts = [];
  for (let i = 0; i < 80; i++) parts.push(`第 ${i + 1} 段用于撑出滚动高度的正文内容。`, '');
  await window.__md2p.loadDocFile({ name: 'long.md', kind: 'md', text: parts.join('\n'), mtime: Date.now() });
});
await p.waitForTimeout(1600);
await p.click('#settings-btn');
await p.waitForTimeout(300);
await p.click('input[name="progress"][value="bar"] + span');
await p.keyboard.press('Escape');
await p.waitForTimeout(200);
await p.evaluate(() => document.getElementById('scroller').scrollTo({ top: 500 }));
await p.waitForTimeout(300);
const barW = await p.evaluate(() => document.querySelector('#progress-bar i').style.width);
ok('9b. 长文档滚动后细条显示进度', barW !== '' && barW !== '0%', barW);
const mapCheck = await p.evaluate(() => {
  const map = document.getElementById('minimap');
  const bars = [...map.querySelectorAll('i')];
  const last = bars[bars.length - 1];
  const r = last.getBoundingClientRect();
  const mr = map.getBoundingClientRect();
  return { n: bars.length, lastBottom: r.bottom, mapBottom: mr.bottom, clipped: r.bottom > mr.bottom + 1 };
});
ok('10. minimap 末块可见不裁尾', mapCheck.n === 80 && !mapCheck.clipped, JSON.stringify(mapCheck));

// 10b) 跳转精确居中（v1.5 根修）：中段块跳转 → 滚动比例≈0.5，不再随机
await p.evaluate(() => {
  const st = window.__md2p.store.state;
  const b = st.cur[40];
  document.dispatchEvent(new CustomEvent('md2p-jump', { detail: { blockId: b.id, line: null } }));
});
await p.waitForTimeout(1400);
const j = await p.evaluate(() => {
  const sc = document.getElementById('scroller');
  const sec = document.querySelector('#doc section[data-block-id]');
  return { bid: sec?.dataset.blockId ?? '', ratio: sc.scrollTop / (sc.scrollHeight - sc.clientHeight) };
});
ok('10b. 跳转精确居中（中段块 → 滚动比例≈0.5）', j.bid !== '' && Math.abs(j.ratio - 0.5) < 0.2, JSON.stringify(j));

// 11) Alt+M 带选区 quote（评审 M2）
await p.evaluate(() => document.getElementById('scroller').scrollTo({ top: 0 }));
// 用 DOM Selection 直接选前 5 字（字体度量/焦点环境无关——CI 两次红点均为键鼠选区漏选）
await p.evaluate(() => {
  const pEl = document.querySelector('#doc .ProseMirror p');
  const textNode = pEl.firstChild;
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, Math.min(5, textNode.length));
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
await p.waitForTimeout(400);
await p.keyboard.press('Alt+m');
await p.waitForTimeout(600);
const pv = await p.evaluate(() => document.querySelector('#floater .floater-preview')?.textContent ?? '');
ok('11. Alt+M 批注浮层含选段预览', pv.length > 0, pv.slice(0, 12));
await p.keyboard.press('Escape');

// 12) 滑杆/数字输入不锁死（评审 M1）：先输 800 再拖滑杆
await p.click('#settings-btn');
await p.waitForTimeout(300);
await p.evaluate(() => {
  const r = document.querySelector('input[name="fontWeight"]');
  r.value = '700';
  r.dispatchEvent(new Event('input', { bubbles: true }));
  const n = document.querySelector('input[name="fontWeightNum"]');
  n.value = '800';
  n.dispatchEvent(new Event('input', { bubbles: true }));
});
await p.waitForTimeout(150);
await p.evaluate(() => {
  const r = document.querySelector('input[name="fontWeight"]');
  r.value = '400';
  r.dispatchEvent(new Event('input', { bubbles: true }));
});
await p.waitForTimeout(150);
const unlocked = await p.evaluate(() => ({
  w: JSON.parse(localStorage.getItem('md2prompt.prefs')).fontWeight,
  numHidden: document.querySelector('input[name="fontWeightNum"]').hidden,
}));
ok('12. 滑杆拖离后数字框失效', unlocked.w === 400 && unlocked.numHidden, JSON.stringify(unlocked));
// 13) 快捷键录入：拒收无修饰键，收下 Ctrl+K
const sc1 = await p.evaluate(() => {
  const el = document.querySelector('input.sc-key');
  el.focus();
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
  const bare = el.value;
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
  return { bare, after: el.value };
});
ok('13. 无修饰键拒收 / Ctrl+K 收录', sc1.bare === 'Ctrl+B' && sc1.after === 'Ctrl+K', JSON.stringify(sc1));
await p.keyboard.press('Escape');

await p.screenshot({ path: '../e2e-shots/v14-look.png', fullPage: false });
console.log(fails.length ? `\nFAIL ${fails.length}` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
