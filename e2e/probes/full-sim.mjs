// full-sim.mjs — 真实浏览器仿真检验（v2.0.2 线）：像用户一样操作，逐步「操作 → 等待断言 → 截图留证」。
// 夹具：e2e/probes/fixture-茶馆笔记.md（自写测试文档：h1+3×h2、加粗段、引用块、列表、代码围栏、
//   <identity> 块、mermaid、行内公式、GFM 表格、snake_case、脚注、hr）。
// 从 md2prompt-v2/e2e 目录运行：node probes/full-sim.mjs
// 截图与证据：C:/Users/kaile/Documents/kimi/workspace/.review-reports/sim/
// 断言通过不等于功能正确——本脚本之外还须人眼过截图（AGENTS.md 第三道门槛）。
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';

const HTML = new URL('../../dist/2youg1-md2prompt.html', import.meta.url).href;
const SHOTS = 'C:/Users/kaile/Documents/kimi/workspace/.review-reports/sim';
fs.mkdirSync(SHOTS, { recursive: true });
const guideText = fs.readFileSync(new URL('fixture-茶馆笔记.md', import.meta.url), 'utf8');
const DOC_NAME = 'fixture-茶馆笔记.md';

const fails = [];
const consoleErrors = [];
const pageErrors = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + String(extra).slice(0, 260) : ''}`);
  if (!cond) fails.push(name);
};

const b = await chromium.launch();
// 附录走剪贴板粘贴（真实用户插入大段文本的方式）：键盘逐字输入会触发 CM 自动缩进/自动闭合标签
const ctx = await b.newContext({ viewport: { width: 1600, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const p = await ctx.newPage();
p.on('pageerror', (e) => { pageErrors.push(e.message); console.log('[pageerror]', e.message); });
p.on('console', (m) => { if (m.type() === 'error') { consoleErrors.push(m.text()); console.log('[console.error]', m.text().slice(0, 200)); } });

// 等条件取代死等：onChange 有 200ms 防抖
const waitCur = (fn, arg, ms = 6000) =>
  p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);

// 截图 + 像素 sanity：>20KB 且缩略图（48×27 均值采样）颜色数 ≥4
async function shot(name) {
  const file = path.join(SHOTS, `${name}.png`);
  await p.screenshot({ path: file });
  const size = fs.statSync(file).size;
  let why = '';
  if (size > 20 * 1024) {
    const b64 = fs.readFileSync(file).toString('base64');
    const uniq = await p.evaluate(async (data) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + data; });
      const c = document.createElement('canvas');
      c.width = 48; c.height = 27;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, 48, 27);
      const d = g.getImageData(0, 0, 48, 27).data;
      const set = new Set();
      for (let i = 0; i < d.length; i += 4) set.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
      return set.size;
    }, b64);
    if (uniq >= 4) { console.log(`SHOT | ${name}.png | ${(size / 1024).toFixed(0)}KB | thumb colors ×${uniq}`); return; }
    why = `thumbnail only ${uniq} distinct colors`;
  } else why = `size ${size}B <= 20KB`;
  ok(`11. 像素 sanity ${name}`, false, why);
}

// 量矩形 → mouse.click → 验光标 重试循环（p.click 一次性点击曾落偏，点不上就像用户一样再点）
async function clickParaVerified(startsWith, lineRe) {
  for (let t = 0; t < 3; t++) {
    const g = await p.evaluate((sw) => {
      const el = [...document.querySelectorAll('#doc .ProseMirror p, #doc .ProseMirror blockquote')]
        .find((x) => x.textContent.startsWith(sw) || x.textContent.includes(sw));
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + 100, y: r.top + 12 };
    }, startsWith);
    if (!g) break;
    await p.waitForTimeout(150);
    await p.mouse.click(g.x, g.y);
    await p.waitForTimeout(120);
    const cur = await p.evaluate(() => document.getElementById('cursor-pos')?.textContent ?? '');
    if (lineRe.test(cur)) return cur;
  }
  return p.evaluate(() => document.getElementById('cursor-pos')?.textContent ?? '');
}

// 账本三分：真实账 / 已鉴别序列化怪癖幻影（replace 且去反斜杠与强调星号后逐字相等）/ 未知幻影（=失败）
const ledger = () => p.evaluate(() => {
  const qe = (a, b) => a.replace(/\\(.)/gs, '$1').replace(/\*/g, '') === b.replace(/\\(.)/gs, '$1').replace(/\*/g, '');
  const ops = window.__md2p.store.state.ops;
  const isQuirk = (o) => o.type === 'replace' && qe(o.before, o.after);
  return {
    total: ops.length,
    quirks: ops.filter(isQuirk).length,
    real: ops.filter((o) => !isQuirk(o)).map((o) => `${o.type}:${o.id}`),
  };
});

/* ================= 1. 冷启动 ================= */
await p.goto(HTML);
ok('1a. 冷启动首启引导出现', await waitCur(() => !!document.querySelector('.coach-modal')));
await shot('s01-coach');
await p.click('.coach-modal button');
ok('1b. 引导关闭且记忆', await waitCur(() => !document.querySelector('.coach-modal') && localStorage.getItem('md2prompt.coachSeen') === '1'));

/* ================= 2. 拖放打开（v2.0.2） ================= */
const dt = await p.evaluateHandle((text) => {
  const d = new DataTransfer();
  d.items.add(new File([text], 'fixture-茶馆笔记.md', { type: 'text/markdown' }));
  return d;
}, guideText);
await p.dispatchEvent('#app', 'dragenter', { dataTransfer: dt });
ok('2a. dragenter 遮罩 #drop-veil 出现', await waitCur(() => !!document.getElementById('drop-veil')));
await shot('s02-veil');
await p.dispatchEvent('#app', 'drop', { dataTransfer: dt });
ok('2b. drop 后文档入账', await waitCur((name) => window.__md2p?.store?.state?.file?.name === name, DOC_NAME));
ok('2c. 顶栏文件名正确', await waitCur((name) => document.getElementById('file-name')?.textContent === name, DOC_NAME));
ok('2d. 遮罩 drop 后收回', await waitCur(() => !document.getElementById('drop-veil')));
ok('2e. 大纲出标题树（h1+3×h2 = 4 项）', await waitCur(() => document.querySelectorAll('#outline .ol-item').length >= 4),
  await p.evaluate(() => document.querySelectorAll('#outline .ol-item').length));
ok('2f. 引用块渲染（≥1）', await waitCur(() => document.querySelectorAll('#doc blockquote').length >= 1));
ok('2g. hr 渲染（=1）', await p.evaluate(() => document.querySelectorAll('#doc hr').length === 1),
  await p.evaluate(() => document.querySelectorAll('#doc hr').length));
ok('2h. 脚注引用上标（=1）', await p.evaluate(() => document.querySelectorAll('#doc sup.footnote-ref').length === 1),
  await p.evaluate(() => document.querySelectorAll('#doc sup.footnote-ref').length));
ok('2i. 列表与署名加粗渲染', await p.evaluate(() => !!document.querySelector('#doc ul li') && !!document.querySelector('#doc blockquote strong')));
await shot('s03-render');

/* ================= 3. Swap 入账（协议 2.0 调换，v2.0.2 序号方案） ================= */
// 3a：单段段落（L3「清晨的老茶馆」）Alt+↓ 与引用块调换
const cursorAt = await clickParaVerified('清晨的老茶馆', /^行 3 ·/);
console.log(`INFO | 点击首段后光标指示 = ${cursorAt || '(空)'}`);
ok('3a. 光标落在首段（行 3）', /^行 3 ·/.test(cursorAt), cursorAt);
await p.keyboard.press('Alt+ArrowDown');
ok('3b. Alt+↓ 后 swap op 入账', await waitCur(() => window.__md2p.store.state.ops.some((o) => o.type === 'swap')));
ok('3c. 修订面板「换」徽标卡出现', await waitCur(() => [...document.querySelectorAll('#changes .rev-badge')].some((el) => el.classList.contains('rb-swap') && el.textContent === '换')));
await shot('s04-swap-card');
const sw = await p.evaluate(() => {
  const o = window.__md2p.store.state.ops.find((x) => x.type === 'swap');
  return o ? { a: o.a, b: o.b, firstA: o.firstA.slice(0, 20), firstB: o.firstB.slice(0, 20) } : null;
});
ok('3d. swap a<b 行号合理', !!sw && sw.a < sw.b, JSON.stringify(sw));
ok('3e. 被换下的确实是首段（firstB 含「清晨的老茶馆」）', !!sw && sw.firstB.includes('清晨的老茶馆'), sw?.firstB ?? '');
const promptHasSwap = await p.evaluate(async () => {
  const t = await window.__md2p.buildPrompt(window.__md2p.store.state);
  return { has: t.includes('<swap'), line: (t.split('\n').find((l) => l.includes('<swap')) ?? '').slice(0, 120) };
});
ok('3f. buildPrompt 导出含 <swap> 记录', promptHasSwap.has, promptHasSwap.line);
{
  const l = await ledger();
  ok('3g. 真实账仅 swap 一条，怪癖幻影 ≤3，无未知', l.real.length === 1 && l.real[0].startsWith('swap:') && l.quirks <= 3, JSON.stringify(l));
}
await p.keyboard.press('Control+z');
ok('3h. Ctrl+Z 撤销后 swap 销账（真实账归零）', await waitCur(() => {
  const qe = (a, b) => a.replace(/\\(.)/gs, '$1').replace(/\*/g, '') === b.replace(/\\(.)/gs, '$1').replace(/\*/g, '');
  return window.__md2p.store.state.ops.every((o) => o.type === 'replace' && qe(o.before, o.after));
}));
// 3i：多段引用块（旧文本匹配方案的静默丢账点）——点进引用块 Alt+↓ 同样入账
const quoteCursor = await clickParaVerified('所谓市井', /^行 [5-7] ·/);
console.log(`INFO | 点击引用块后光标指示 = ${quoteCursor || '(空)'}`);
ok('3i1. 光标落在引用块（行 5-7）', /^行 [5-7] ·/.test(quoteCursor), quoteCursor);
await p.keyboard.press('Alt+ArrowDown');
ok('3i2. 多段引用块 Alt+↓ 同样记 swap（序号方案）', await waitCur(() => window.__md2p.store.state.ops.some((o) => o.type === 'swap')));
await p.keyboard.press('Control+z');
await waitCur(() => {
  const qe = (a, b) => a.replace(/\\(.)/gs, '$1').replace(/\*/g, '') === b.replace(/\\(.)/gs, '$1').replace(/\*/g, '');
  return window.__md2p.store.state.ops.every((o) => o.type === 'replace' && qe(o.before, o.after));
});

/* ================= 4. 打字留痕 + hover 展开详情 ================= */
await p.evaluate(() => {
  const el = [...document.querySelectorAll('#doc .ProseMirror p')].find((x) => x.textContent.startsWith('清晨的老茶馆'));
  el.scrollIntoView({ block: 'center' });
});
await clickParaVerified('清晨的老茶馆', /^行 3 ·/);
await p.keyboard.press('End');
await p.keyboard.type('新增的一句话。');
ok('4a. 打字落账为 replace op', await waitCur(() => window.__md2p.store.state.ops.some((o) => o.type === 'replace' && o.after.includes('新增的一句话。'))));
{
  const l = await ledger();
  ok('4b. canon 基线：真实账仅此一条 replace（怪癖幻影 ≤3，无未知）', l.real.length === 1 && l.real[0].startsWith('replace:') && l.quirks <= 3, JSON.stringify(l));
}
// hover 展开（v2.0.2 rev-detail 纯 CSS 态）
const rowBox = await p.evaluate(() => {
  const row = document.querySelector('#changes .panel-body .rev-row');
  if (!row) return null;
  const r = row.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + Math.min(10, r.height / 2) };
});
if (rowBox) await p.mouse.move(rowBox.x, rowBox.y);
await p.waitForTimeout(400); // transition 0.22s
const detail = await p.evaluate(() => {
  const d = document.querySelector('#changes .rev-row .rev-detail');
  if (!d) return null;
  const cs = getComputedStyle(d);
  const before = d.querySelector('.rd-before');
  return {
    maxH: cs.maxHeight, h: d.getBoundingClientRect().height,
    before: !!before, strike: before ? getComputedStyle(before).textDecorationLine.includes('line-through') : false,
    afterHas: (d.querySelector('.rd-after')?.textContent ?? '').includes('新增的一句话。'),
  };
});
ok('4c. hover 展开详情（rev-detail 展开 + before 删除线 + after 含新句）', !!detail && detail.h > 0 && detail.maxH !== '0px' && detail.before && detail.strike && detail.afterHas, JSON.stringify(detail));
await shot('s05-hover-detail');

/* ================= 5. 批注三型（.note-kinds，实心白字） ================= */
// 打字后光标在段尾，向左扩选同段 6 字
for (let i = 0; i < 6; i++) await p.keyboard.press('Shift+ArrowLeft');
console.log(`INFO | Alt+M 前 DOM 选区 = 「${await p.evaluate(() => window.getSelection()?.toString() ?? '')}」`);
await p.keyboard.press('Alt+m');
ok('5a. Alt+M 浮层打开（.note-kinds 出现）', await waitCur(() => !!document.querySelector('#floater .note-kinds')));
const kinds = await p.evaluate(() => [...document.querySelectorAll('#floater .note-kinds button')].map((c) => c.textContent));
ok('5b. 三枚类型钮（命令/建议/讨论）', kinds.length === 3 && kinds.join() === '命令,建议,讨论', kinds.join());
const pvText = await p.evaluate(() => document.querySelector('#floater .floater-preview')?.textContent ?? '');
ok('5c. 浮层预览带出选段引文', pvText.length > 0, pvText.slice(0, 16));
await shot('s06-kinds');
await p.click('#floater .note-kinds .kind-suggest');
const kindOn = await p.evaluate(() => {
  const on = document.querySelector('#floater .note-kinds .kind-suggest.on');
  if (!on) return { on: false };
  const probe = document.createElement('div');
  probe.style.color = 'var(--accent)';
  document.body.appendChild(probe);
  const accent = getComputedStyle(probe).color;
  probe.remove();
  const cs = getComputedStyle(on);
  return { on: true, bg: cs.backgroundColor, color: cs.color, accent };
});
ok('5d. 「建议」选中且实心白字（bg=accent、字=白）', kindOn.on && kindOn.bg === kindOn.accent && kindOn.color === 'rgb(255, 255, 255)', JSON.stringify(kindOn));
await p.fill('#floater .floater-source', '这里建议补一个例子');
await p.click('#floater .floater-actions button:first-child'); // 保存
ok('5e. 批注 op 入账且 kind=suggest', await waitCur(() => window.__md2p.store.state.ops.some((o) => o.type === 'note' && o.kind === 'suggest' && o.note.includes('补一个例子'))));
ok('5f. 批注 op 带选段 quote', await p.evaluate(() => !!window.__md2p.store.state.ops.find((x) => x.type === 'note')?.quote));
await p.click('#changes .panel-tab[data-tab="note"]');
ok('5g. 批注卡「议」徽标出现（rb-kind-suggest 三型着色）', await waitCur(() => [...document.querySelectorAll('#changes .rev-badge')].some((el) => el.classList.contains('rb-kind-suggest') && el.textContent === '议')));
await shot('s07-kind-badge');
await p.click('#changes .panel-tab[data-tab="rev"]');

/* ================= 6. 亮度/对比度/主题（v2.0.2 根修后纸+字整体响应） ================= */
await p.click('#settings-btn');
await waitCur(() => !!document.querySelector('.settings-modal') && !document.querySelector('.settings-modal').closest('.floater-backdrop').hidden);
await p.evaluate(() => {
  const r = document.querySelector('input[name="brightness"]');
  r.value = '150';
  r.dispatchEvent(new Event('input', { bubbles: true }));
});
ok('6a. 亮度 150 → #page computed filter 含 brightness(1.5)', await waitCur(() => getComputedStyle(document.getElementById('page')).filter.includes('brightness(1.5)')),
  await p.evaluate(() => getComputedStyle(document.getElementById('page')).filter));
await p.click('.settings-modal [data-x="close"]');
await shot('s08-bright150');
await p.click('#settings-btn');
await p.evaluate(() => {
  const r = document.querySelector('input[name="contrast"]');
  r.value = '60';
  r.dispatchEvent(new Event('input', { bubbles: true }));
});
ok('6b. 对比度 60 → filter 含 contrast(0.6)', await waitCur(() => getComputedStyle(document.getElementById('page')).filter.includes('contrast(0.6)')),
  await p.evaluate(() => getComputedStyle(document.getElementById('page')).filter));
await p.click('.settings-modal [data-x="close"]');
await shot('s08b-contrast60');
await p.click('#settings-btn');
await p.evaluate(() => {
  for (const [n, v] of [['brightness', '100'], ['contrast', '100']]) {
    const r = document.querySelector(`input[name="${n}"]`);
    r.value = v;
    r.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
ok('6c. 恢复默认 → 滤镜卸下', await waitCur(() => getComputedStyle(document.getElementById('page')).filter === 'none'));
await p.click('input[name="theme"][value="night"] + span'); // 纯黑
ok('6d. 切纯黑主题', await waitCur(() => document.documentElement.dataset.theme === 'night'));
await p.click('.settings-modal [data-x="close"]');
await shot('s09-night');

/* ================= 7. 修订栏智能折叠 + 待决徽标（v2.0.2） ================= */
await p.setViewportSize({ width: 1100, height: 800 });
ok('7a. 1100px → #changes 自动折为细轨', await waitCur(() => document.getElementById('changes').classList.contains('collapsed')));
const badge = await p.evaluate(() => {
  const el = document.querySelector('#changes .rail-badge');
  const n = window.__md2p.store.state.ops.filter((o) => o.state !== 'hidden').length;
  return el ? { text: el.textContent, hidden: el.hidden, n } : null;
});
ok('7b. 细轨 .rail-badge 计数正确', !!badge && !badge.hidden && Number(badge.text) === badge.n && badge.n > 0, JSON.stringify(badge));
await shot('s10-rail');
await p.click('#changes .rail');
ok('7c. 点细轨手动展开（窄窗内手动优先）', await waitCur(() => !document.getElementById('changes').classList.contains('collapsed')));
await p.setViewportSize({ width: 1600, height: 900 });
ok('7d. 穿回宽屏自动恢复展开', await waitCur(() => !document.getElementById('changes').classList.contains('collapsed')));

/* ================= 8. 转义符（现场输入，双路径） ================= */
// 8a. 渲染模式（PM 序列化管线）：点 L9 段（含 regular_customer），现场输入 snake_case
const snakeCursor = await clickParaVerified('regular_customer', /^行 9 ·/);
console.log(`INFO | snake 段点击后光标指示 = ${snakeCursor}`);
ok('8a1. 光标落在 snake 段（行 9）', /^行 9 ·/.test(snakeCursor), snakeCursor);
await p.keyboard.press('End');
await p.keyboard.type('，user_name 与 order_id 记一笔');
ok('8a2. PM 路径 snake_case 打字入账', await waitCur(() => window.__md2p.store.state.ops.some((o) => o.type === 'replace' && o.after.includes('记一笔'))));
const pmVisible = await p.evaluate(() => {
  const el = [...document.querySelectorAll('#doc .ProseMirror p')].find((x) => x.textContent.includes('记一笔'));
  return el?.textContent ?? '';
});
ok('8b1. 编辑器可见文本保真（无反斜杠）', pmVisible.includes('user_name 与 order_id 记一笔'), pmVisible.slice(-26));
const pmPath = await p.evaluate(() => {
  const o = window.__md2p.store.state.ops.find((x) => x.type === 'replace' && x.after.includes('记一笔'));
  const after = o?.after ?? '';
  const stripped = after.replace(/\\([\\`*_{}\[\]()#+\-.!>|$"])/g, '$1'); // markdown 转义剥离
  return { afterHasEsc: after.includes('\\_'), equiv: stripped.includes('user_name 与 order_id 记一笔'), tail: after.slice(-30) };
});
ok('8b2. 落盘形差异仅转义符（剥离后逐字一致）', pmPath.equiv, JSON.stringify(pmPath));
{
  const l = await ledger();
  ok('8c. canon 基线：真实账 3 条（改+注+改），怪癖幻影 ≤3，无未知', l.real.length === 3 && l.quirks <= 3, JSON.stringify(l));
}
console.log(`INFO | PM 路径序列化形含 \\_ = ${pmPath.afterHasEsc}（编辑块保守保留 PM 形，设计备案）`);

// 8d. 源码模式（CM 逐字管线）附录：剪贴板粘贴结构化块 + snake_case（练 insert 入账 + 富媒体渲染覆盖）
await p.click('#mode-btn'); // render → source
await waitCur(() => !!document.querySelector('#doc .cm-content'));
await p.click('#doc .cm-content');
await p.keyboard.press('Control+End');
const appendix = [
  '',
  '',
  '附录：appendix_note 与 raw_id 逐字演示。',
  '',
  '<identity>',
  '你是附录解释者。',
  '</identity>',
  '',
  '| 键 | 值 |',
  '| - | - |',
  '| a | 1 |',
  '',
  '公式 $E=mc^2$ 附录。',
  '',
  '```mermaid',
  'graph LR',
  '  X --> Y',
  '```',
].join('\n');
await p.evaluate((t) => navigator.clipboard.writeText(t), appendix);
await p.keyboard.press('Control+v');
await p.click('#mode-btn'); // source → split（flush 入账）
ok('8d. CM 附录 insert 入账（mermaid/identity/表格/公式块俱在）', await waitCur(() => {
  const ops = window.__md2p.store.state.ops;
  const cur = window.__md2p.store.state.cur;
  const has = (pred) => cur.some((bl) => pred(bl));
  return (
    ops.some((o) => o.type === 'insert') &&
    has((bl) => bl.kind === 'code' && bl.text === '```mermaid\ngraph LR\n  X --> Y\n```') &&
    has((bl) => bl.kind === 'html' && bl.text === '<identity>\n你是附录解释者。\n</identity>') &&
    has((bl) => bl.kind === 'table' && bl.text.includes('| 键 | 值 |')) &&
    has((bl) => bl.text.includes('$E=mc^2$'))
  );
}));
ok('8e. CM 路径逐字保真：附录 snake_case 不含 \\ 转义', await p.evaluate(() => {
  const bl = window.__md2p.store.state.cur.find((x) => x.text.includes('appendix_note'));
  return !!bl && !bl.text.includes('\\_');
}), await p.evaluate(() => window.__md2p.store.state.cur.find((x) => x.text.includes('appendix_note'))?.text ?? '(未找到)'));
await p.click('#mode-btn'); // split → render（PM 重挂载，附录按富媒体渲染）
await waitCur(() => !!document.querySelector('#doc .ProseMirror'));
await p.evaluate(() => {
  const secs = document.querySelectorAll('#doc > section');
  secs[secs.length - 1]?.scrollIntoView({ block: 'end' });
});
ok('8f. 附录 XML 卡片渲染', await waitCur(() => [...document.querySelectorAll('#doc .xml-card')].some((el) => el.textContent.includes('identity')), null, 8000));
ok('8g. 附录 GFM 表格渲染', await waitCur(() => !!document.querySelector('#doc .ProseMirror table'), null, 8000));
ok('8h. 附录行内公式 KaTeX 渲染', await waitCur(() => !!document.querySelector('#doc .katex'), null, 8000));
ok('8i. 附录 mermaid 渲染出 SVG', await waitCur(() => !!document.querySelector('#doc .mermaid-svg svg'), null, 15000));
await shot('s03b-appendix');

/* ================= 9. 编辑区 UI 全景 ================= */
await p.click('#settings-btn');
await p.click('input[name="theme"][value="marble"] + span'); // 云石
ok('9a. 切回云石主题', await waitCur(() => document.documentElement.dataset.theme === 'marble'));
await p.click('.settings-modal [data-x="close"]');
await p.setViewportSize({ width: 1600, height: 900 });
await p.evaluate(() => document.getElementById('scroller').scrollTo({ top: 0 }));
await p.waitForTimeout(300);
await shot('s11-ui-marble');
await p.setViewportSize({ width: 1280, height: 800 });
await p.waitForTimeout(300); // 布局重排（纯视觉）
await shot('s12-ui-1280');
await p.setViewportSize({ width: 1600, height: 900 });

/* ================= 10. 快捷键冲突警告 + 裸键护栏（v2.0.2） ================= */
await p.click('#settings-btn');
await p.click('.sc-key[data-sc="bold"]'); // 聚焦「加粗」录入框
await p.keyboard.press('Control+i'); // 与「斜体」现行组合冲突
const conflict = await p.evaluate(() => ({
  warn: document.querySelector('.sc-key[data-sc="bold"]')?.closest('.set-ctl')?.querySelector('.sc-warn')?.textContent ?? '',
  kept: document.querySelector('.sc-key[data-sc="bold"]')?.value ?? '',
  saved: JSON.parse(localStorage.getItem('md2prompt.prefs') ?? '{}')?.shortcuts?.bold ?? '',
}));
ok('10a. Ctrl+I 冲突提示「占用」且不予保存（加粗仍 Ctrl+B）', conflict.warn.includes('占用') && conflict.kept === 'Ctrl+B' && conflict.saved !== 'Ctrl+I', JSON.stringify(conflict));
await shot('s13-sc-conflict');
await p.click('.sc-key[data-sc="bold"]');
await p.keyboard.press('i'); // 无修饰键：拒收（绑裸键会锁死文档输入，shortcuts.ts 评审 M3）
ok('10b. 裸键录入被拒（加粗仍 Ctrl+B）', await p.evaluate(() => document.querySelector('.sc-key[data-sc="bold"]').value === 'Ctrl+B'));
await p.click('.settings-modal [data-x="close"]');

/* ================= 收尾 ================= */
console.log(`\nconsole.error ×${consoleErrors.length} | pageerror ×${pageErrors.length}`);
console.log(fails.length ? `\nFAIL ${fails.length}: ${fails.join(' ; ')}` : '\nALL PASS');
await b.close();
process.exitCode = fails.length || pageErrors.length ? 1 : 0;
