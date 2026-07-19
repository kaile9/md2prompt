// e2e/export.mjs — v1.2 批次 1 验收：导出协议 / 设置项 / 状态栏 / 打印
// 运行：cd e2e && node export.mjs  （幂等可重跑，每次全新浏览器 profile）
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
import { mkdirSync } from 'node:fs';

const DIST = HTML;
const SHOTS = new URL('../e2e-shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  | ' + detail}`);
};
const step = async (name, fn) => {
  try { await fn(); } catch (e) { check(name, false, '异常: ' + (e?.message ?? e)); }
};
const section = (s, tag) => s.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`))?.[0] ?? null;

const browser = await chromium.launch();
const page = await browser.newPage();
// 打桩 window.print，防弹窗并记录调用次数
await page.addInitScript(() => {
  window.__printCalls = 0;
  window.print = () => { window.__printCalls += 1; };
});
await page.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
await page.goto(DIST);
await page.waitForFunction(() => !!window.__md2p?.store, null, { timeout: 10000 });

// ---- 准备：注入文档 + 制造 replace / insert / 墓碑 / 隐藏 ----
const DOC = [
  '第一段正文内容，用于验收首行缩进与修订留痕。',
  '',
  '## 二级标题',
  '',
  '第二段正文内容，包含一些需要被替换的文字。',
  '',
  '第三段正文内容，作为全文的结尾段落。',
].join('\n');

let prep = null;
await step('准备：注入文档并制造三笔修订', async () => {
  prep = await page.evaluate(async (text) => {
    const m = window.__md2p;
    await m.loadDocFile({ name: 't.md', kind: 'md', text, mtime: 1752800000000 });
    const paras0 = m.store.state.cur.filter((b) => b.kind === 'para').length;

    // 1) replace：改写第一段
    let cur = m.store.state.cur.map((b) => ({ ...b }));
    cur.find((b) => b.kind === 'para').text = '第一段已被人工改写，内容与原文完全不同。';
    m.store.dispatch({ type: 'patchCur', cur });

    // 2) insert：在标题后插入新段落
    cur = m.store.state.cur.map((b) => ({ ...b }));
    const hi = cur.findIndex((b) => b.kind === 'heading');
    cur.splice(hi + 1, 0, { id: 'b-e2e-new', kind: 'para', text: '这是后来插入的新段落。', lineStart: 0, lineEnd: 0, gap: '\n\n' });
    m.store.dispatch({ type: 'patchCur', cur });

    const ops = m.store.state.ops.map((o) => ({ id: o.id, type: o.type, state: o.state ?? null }));
    const rep = ops.find((o) => o.type === 'replace');
    const ins = ops.find((o) => o.type === 'insert');
    if (!rep || !ins) return { paras0, ops, error: 'replace/insert op 未生成' };

    // 3) insert → 撤回两阶段 → C 类墓碑
    m.store.dispatch({ type: 'withdraw', id: ins.id });
    m.store.dispatch({ type: 'withdrawCommit', id: ins.id });
    // 4) replace → 隐藏
    m.store.dispatch({ type: 'hide', id: rep.id });

    const st = m.store.state;
    return {
      paras0, ops,
      finalOps: st.ops.map((o) => ({ id: o.id, type: o.type, state: o.state ?? null })),
      withdrawn: st.withdrawn.map((o) => ({ id: o.id, type: o.type, state: o.state })),
    };
  }, DOC);
  check('准备：文档注入（3 段正文 + 1 标题）', prep?.paras0 === 3, JSON.stringify(prep));
  check('准备：replace 与 insert op 生成', !prep?.error, JSON.stringify(prep?.ops));
  check('准备：insert 已成墓碑（C 类）', prep?.withdrawn?.length === 1 && prep.withdrawn[0].state === 'withdrawn', JSON.stringify(prep?.withdrawn));
  check('准备：replace 已隐藏', prep?.finalOps?.[0]?.state === 'hidden', JSON.stringify(prep?.finalOps));
});

// ---- 场景 1：全文版 buildPrompt(state) ----
let full = '';
await step('场景1：全文版导出', async () => {
  full = await page.evaluate(() => window.__md2p.buildPrompt(window.__md2p.store.state));
  const fm = full.split(/^---$/m)[1] ?? '';
  check('1.1 front matter 六字段齐',
    ['protocol: md2prompt/2.0.0', 'doc: t.md', /^doc-hash: (blake3|sha3-256):/m, /^base-hash: (blake3|sha3-256):/m, 'changes: 1', 'withdrawn: 1']
      .every((x) => (typeof x === 'string' ? fm.includes(x) : x.test(fm))), fm.trim());
  check('1.2 front matter 无 kind/updated 行', !/^kind:/m.test(fm) && !/^updated:/m.test(fm), fm.trim());
  check('1.3 隐藏 op 带 state="hidden"', /<revise [^>]*state="hidden"/.test(full), full.match(/<revise [^>]*>/g)?.join(' '));
  check('1.4 <withdrawn> 区段存在且含墓碑 revise', full.includes('<withdrawn>') && /<revise n="\d+"/.test(section(full, 'withdrawn') ?? ''), section(full, 'withdrawn') ?? '缺区段');
});

// ---- 场景 2：复制版 buildPrompt(state, true) ----
await step('场景2：复制版导出', async () => {
  const copy = await page.evaluate(() => window.__md2p.buildPrompt(window.__md2p.store.state, true));
  check('2.1 复制版无 <withdrawn> 与 withdrawn 计数行', !copy.includes('<withdrawn>') && !/^withdrawn:/m.test(copy));
  check('2.2 <changes> 区段与全文版一致', section(copy, 'changes') === section(full, 'changes'),
    `full=${JSON.stringify(section(full, 'changes'))} copy=${JSON.stringify(section(copy, 'changes'))}`);
});

// 截图：含 C 类墓碑的修订面板
await step('截图：含 C 类的修订面板', async () => {
  const panel = page.locator('#changes');
  if (await panel.count()) await panel.screenshot({ path: SHOTS + 'v12-exp-03-changes-tombstone.png' });
  else await page.screenshot({ path: SHOTS + 'v12-exp-03-changes-tombstone.png', fullPage: true });
  check('截图 v12-exp-03-changes-tombstone.png', true);
});

// ---- 场景 3：设置面板 · 首行缩进三档 ----
await step('场景3：首行缩进三档', async () => {
  await page.click('#settings-btn');
  await page.waitForSelector('.settings-modal:not([hidden]), .floater-backdrop:not([hidden]) .settings-modal', { timeout: 5000 });
  const has3 = await page.evaluate(() =>
    ['off', 'render', 'write'].every((v) => document.querySelector(`.settings-modal input[name="indent"][value="${v}"]`)));
  check('3.1 设置面板含首行缩进三档', has3);
  check('3.2 设置面板含行号栏复选框', await page.evaluate(() => !!document.querySelector('.settings-modal input[name="gutter"]')));
  await page.screenshot({ path: SHOTS + 'v12-exp-01-settings.png' });

  // 写入文档档
  await page.locator('.settings-modal .seg label', { hasText: '写入文档' }).click();
  await page.waitForTimeout(250);
  const pWrite = await page.evaluate(() => window.__md2p.buildPrompt(window.__md2p.store.state));
  check('3.3 写入档：Prompt 含 <format> 排版命令行', pWrite.includes('<format>中文首行缩进两字符</format>'));
  check('3.4 写入档：localStorage prefs.indent==="write"',
    await page.evaluate(() => JSON.parse(localStorage.getItem('md2prompt.prefs') ?? '{}').indent === 'write'));

  // 仅渲染档
  await page.locator('.settings-modal .seg label', { hasText: '仅渲染' }).click();
  await page.waitForTimeout(250);
  check('3.5 仅渲染档：<html data-indent="render">',
    await page.evaluate(() => document.documentElement.dataset.indent === 'render'));
  const pRender = await page.evaluate(() => window.__md2p.buildPrompt(window.__md2p.store.state));
  check('3.6 仅渲染档：Prompt 无 <format> 行', !pRender.includes('<format>'));

  // 切回关闭
  await page.locator('.settings-modal .seg label', { hasText: '关闭' }).first().click();
  await page.waitForTimeout(250);
  check('3.7 关闭档：data-indent="off" 且 Prompt 无 <format> 行',
    await page.evaluate(async () => document.documentElement.dataset.indent === 'off'
      && !(await window.__md2p.buildPrompt(window.__md2p.store.state)).includes('<format>')));
});

// ---- 场景 4：行号栏开关 ----
await step('场景4：行号栏开关', async () => {
  const gutter = page.locator('.settings-modal input[name="gutter"]');
  await gutter.uncheck();
  await page.waitForTimeout(150);
  check('4.1 取消勾选：<html data-gutter="off">',
    await page.evaluate(() => document.documentElement.dataset.gutter === 'off'));
  await gutter.check();
  await page.waitForTimeout(150);
  check('4.2 重新勾选：<html data-gutter="on">',
    await page.evaluate(() => document.documentElement.dataset.gutter === 'on'));
  await page.locator('.settings-modal [data-x="close"]').click();
  await page.waitForTimeout(150);
});

// ---- 场景 5：路径行（v1.5 从状态栏迁入修订面板） ----
await step('场景5：路径行展开与目录前缀', async () => {
  const pathAt = (i) => page.locator('#changes .path-row .path-slot').nth(i).locator('.path');
  check('5.1 文档路径 = t.md', ((await pathAt(0).textContent()) ?? '').trim() === 't.md');
  check('5.2 日记路径 = t.prompt.md', ((await pathAt(1).textContent()) ?? '').trim() === 't.prompt.md');
  await pathAt(0).click();
  check('5.3 点击后获得 .expanded',
    await page.evaluate(() => document.querySelector('#changes .path-row .path').classList.contains('expanded')));
  await page.screenshot({ path: SHOTS + 'v12-exp-02-pathrow-expanded.png' });
  await pathAt(0).click();
  check('5.4 再点 .expanded 消失',
    await page.evaluate(() => !document.querySelector('#changes .path-row .path').classList.contains('expanded')));
  // 目录前缀 → 复制/展示拼出完整路径（浏览器不暴露绝对路径，此为唯一通道）
  await page.click('#settings-btn');
  await page.waitForTimeout(200);
  await page.fill('input[name="dirPrefix"]', 'C:\\docs');
  await page.waitForTimeout(250);
  await page.locator('.settings-modal [data-x="close"]').click();
  await page.waitForTimeout(200);
  check('5.5 目录前缀拼出完整路径', ((await pathAt(0).textContent()) ?? '').trim() === 'C:\\docs\\t.md');
});

// ---- 场景 6：光标行列 ----
await step('场景6：光标行列显示', async () => {
  await page.waitForSelector('.ProseMirror', { timeout: 8000 });
  let pos = '';
  const firstP = page.locator('.ProseMirror p').first();
  if (await firstP.count()) {
    await firstP.click();
    await page.waitForTimeout(200);
    pos = (await page.textContent('#cursor-pos'))?.trim() ?? '';
  }
  if (!/^行 \d+ · 列 \d+/.test(pos)) {
    await page.click('.ProseMirror');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    pos = (await page.textContent('#cursor-pos'))?.trim() ?? '';
  }
  check('6.1 #cursor-pos 显示「行 X · 列 Y」', /^行 \d+ · 列 \d+/.test(pos), `实际: "${pos}"`);
});

// ---- 场景 7：打印 ----
await step('场景7：打印头尾与 window.print', async () => {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('md2p-print')));
  await page.waitForTimeout(200);
  check('7.1 window.print 被调 1 次', (await page.evaluate(() => window.__printCalls)) === 1);
  const head = (await page.textContent('#print-head'))?.trim() ?? '';
  const foot = (await page.textContent('#print-foot'))?.trim() ?? '';
  check('7.2 #print-head 形如「源文件完成于 YYYY-MM-DD HH:mm」',
    /^源文件完成于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(head), `实际: "${head}"`);
  check('7.3 #print-foot 以「导出于 」开头', foot.startsWith('导出于 '), `实际: "${foot}"`);
});

await browser.close();

// ---- 汇总 ----
const fails = results.filter((r) => !r.ok);
console.log('\n========== v1.2 批次 1 验收汇总 ==========');
console.log(`PASS ${results.length - fails.length} / ${results.length}`);
if (fails.length) {
  console.log('FAIL 项：');
  for (const f of fails) console.log('  - ' + f.name);
}
process.exit(fails.length ? 1 : 0);
