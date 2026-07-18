// e2e/v13.mjs — v1.3 批次 2 验收：op 稳定编号 / patch 形 / 摘要行 / quote 与 hidden 跨会话恢复
// 运行：cd e2e && node v13.mjs  （幂等可重跑，每次全新浏览器 profile）
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
import { mkdirSync } from 'node:fs';

const DIST = HTML;
const SHOTS = new URL('../e2e-shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  | ' + String(detail).slice(0, 600)}`);
};
const step = async (name, fn) => {
  try { await fn(); } catch (e) { check(name, false, '异常: ' + (e?.message ?? e)); }
};
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const editLines = (p) => p.split('\n').filter((l) => /^<(?:edit|request) /.test(l));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
await page.goto(DIST);
await page.waitForFunction(() => !!window.__md2p?.store, null, { timeout: 10000 });

// 页内助手注入：载入文档 / 改写第 i 个 para / 取 prompt
await page.evaluate(() => {
  const m = window.__md2p;
  window.__t = {
    async load(name, text) {
      await m.loadDocFile({ name, kind: 'md', text, mtime: Date.now() });
    },
    // 把第 idx 个 para 的文本换成 newText（保留块 id，等价人工编辑后的 flush）
    patchPara(idx, newText) {
      const cur = m.store.state.cur.map((b) => ({ ...b }));
      const paras = cur.filter((b) => b.kind === 'para');
      paras[idx].text = newText;
      m.store.dispatch({ type: 'patchCur', cur });
    },
    paras() {
      return m.store.state.cur.filter((b) => b.kind === 'para').map((b) => ({ id: b.id, text: b.text }));
    },
    ops() {
      return m.store.state.ops.map((o) => ({ id: o.id, type: o.type, state: o.state ?? null, seq: o.seq ?? null, quote: o.quote ?? null }));
    },
    async prompt(copy = false) {
      return await m.buildPrompt(m.store.state, copy);
    },
  };
});

// ============ 场景 1：op 稳定编号（会话内连续导出 id 不变） ============
let s1 = null;
await step('场景1：id 稳定', async () => {
  const DOC1 = ['第一段原文，内容平淡无奇。', '', '第二段原文，同样保持稳定。', '', '第三段原文，等待最后被改。', '', '第四段原文，全程不参与修改。'].join('\n');
  s1 = await page.evaluate(async (doc) => {
    const t = window.__t;
    await t.load('t1.md', doc);
    t.patchPara(0, '第一段已被人工改写，内容与原文不同。');
    t.patchPara(1, '第二段也被人工改写，措辞完全更换。');
    const p1 = await t.prompt();
    t.patchPara(2, '第三段最后才被改写，作为新增的一笔。');
    const p2 = await t.prompt();
    const ids = (p) => [...p.matchAll(/<edit id="(A\d+)"[^>]*>/g)].map((x) => x[1]);
    return { ids1: ids(p1), ids2: ids(p2), p1, p2 };
  }, DOC1);
  check('1.1 首次导出两笔 A 类且 id 为 A1/A2', s1.ids1.length === 2 && s1.ids1[0] === 'A1' && s1.ids1[1] === 'A2', JSON.stringify(s1.ids1));
  check('1.2 新增第三笔后前两笔 id 不变', s1.ids2.length === 3 && s1.ids2[0] === s1.ids1[0] && s1.ids2[1] === s1.ids1[1], `before=${JSON.stringify(s1.ids1)} after=${JSON.stringify(s1.ids2)}`);
  check('1.3 新 op 分配新序号 A3', s1.ids2[2] === 'A3', JSON.stringify(s1.ids2));
});
// 截图：两次导出 id 对比
await step('截图 v13-01-id-stable', async () => {
  const aux = await browser.newPage({ viewport: { width: 1100, height: 500 } });
  const html = `<body style="background:#14161a;color:#dfe3ea;font:13px/1.7 ui-monospace,Consolas,monospace;padding:24px">
    <h3 style="color:#8ab4f8">v1.3 场景1 · op 稳定编号：新增一笔修改前后两次导出的元素行</h3>
    <p style="color:#9aa0a6">导出①（两笔）→ 导出②（三笔）：前两笔 id 应保持 A1/A2 不变</p>
    <div style="display:flex;gap:24px"><div style="flex:1"><b style="color:#7ee787">导出①</b><pre>${escHtml(editLines(s1?.p1 ?? '').join('\n'))}</pre></div>
    <div style="flex:1"><b style="color:#7ee787">导出②</b><pre>${escHtml(editLines(s1?.p2 ?? '').join('\n'))}</pre></div></div></body>`;
  await aux.setContent(html);
  await aux.screenshot({ path: SHOTS + 'v13-01-id-stable.png', fullPage: true });
  await aux.close();
  check('截图 v13-01-id-stable.png', true);
});

// ============ 场景 2：patch 形（长段整句换整句） ============
// 10 个互不相同的中文长句，总长 >300 字符；替换其中第 4 句为等长新句
const SENTS = [
  '协议层的设计决定了整条工具链能够走多远的上限。',
  '编辑器在架构里只是一个可以替换的薄壳组件。',
  '所有修改都以操作流的形式被完整记录并导出。',
  '稳定编号让代理端的缓存命中成为可能的事情。',
  '长段落的替换应当只传输发生变化的句级对。',
  '短块的修改仍然保留修改前后的完整对照文。',
  '摘要行帮助代理快速分配本轮任务的处理量。',
  '批注引文把人的意图精确锚定到行内选段。',
  '跨会话恢复依赖确定性的操作标识与状态。',
  '末尾一句用于撑足段落长度并保持语义完整。',
];
const LONG_PARA = SENTS.join('');
const REPLACED = '替换为一句内容截然不同的等长度的新句子了。'; // 与 SENTS[3] 等长（21 字符）
let s2 = null;
await step('场景2：patch 形导出', async () => {
  const DOC2 = LONG_PARA + '\n\n结尾短段，不参与修改。';
  s2 = await page.evaluate(async ({ doc, idx, repl, expectLen }) => {
    const t = window.__t;
    await t.load('t2.md', doc);
    const orig = t.paras()[0].text;
    const sents = orig.match(/[^。！？]+[。！？]/g);
    if (sents[idx].length !== expectLen) return { error: `句长不等：原 ${sents[idx].length} vs 新 ${expectLen}`, orig, sents };
    const after = orig.replace(sents[idx], repl);
    const cur = window.__md2p.store.state.cur.map((b) => ({ ...b }));
    cur.find((b) => b.kind === 'para').text = after;
    window.__md2p.store.dispatch({ type: 'patchCur', cur });
    const prompt = await t.prompt();
    const el = prompt.match(/<edit id="A\d+"[\s\S]*?<\/edit>/)?.[0] ?? '';
    return {
      beforeLen: orig.length,
      prompt, el,
      delLine: el.match(/<del>([^<]*)<\/del>/)?.[1] ?? null,
      insLine: el.match(/<ins>([^<]*)<\/ins>/)?.[1] ?? null,
      origSent: sents[idx],
    };
  }, { doc: DOC2, idx: 3, repl: REPLACED, expectLen: SENTS[3].length });
  if (s2.error) return check('2.0 前置：等长换句', false, s2.error);
  check('2.0 前置：段落 >200 字符', s2.beforeLen > 200, `实际 ${s2.beforeLen}`);
  check('2.1 导出元素带 form="patch"', /form="patch"/.test(s2.el), s2.el.split('\n')[0]);
  check('2.2 含 <after-hash>blake3:16hex</after-hash>', /<after-hash>blake3:[0-9a-f]{16}<\/after-hash>/.test(s2.el), s2.el.match(/<after-hash>[^<]*<\/after-hash>/)?.[0] ?? '缺失');
  check('2.3 patch 元素无 <before>/<after> 全文', !s2.el.includes('<before>') && !s2.el.includes('<after>'), s2.el);
  check('2.4 <del>/<ins> 句对内容正确', s2.delLine === s2.origSent && s2.insLine === REPLACED, `del=${s2.delLine} ins=${s2.insLine}`);
  // restoreFromPrompt 不在 __md2p 钩子上，恢复路径由单测（roundtrip/promptmd）覆盖，此处止步于输出文本断言
});
await step('截图 v13-02-patch-form', async () => {
  const aux = await browser.newPage({ viewport: { width: 1100, height: 600 } });
  await aux.setContent(`<body style="background:#14161a;color:#dfe3ea;font:13px/1.7 ui-monospace,Consolas,monospace;padding:24px">
    <h3 style="color:#8ab4f8">v1.3 场景2 · patch 形导出（>200 字段落 · 整句换整句）</h3>
    <p style="color:#9aa0a6">段落 ${s2?.beforeLen ?? '?'} 字符，仅导出 del/ins 句对 + after-hash，无 before/after 全文</p>
    <pre style="border:1px solid #333;border-radius:8px;padding:16px;white-space:pre-wrap">${escHtml(s2?.el ?? '(元素缺失)')}</pre></body>`);
  await aux.screenshot({ path: SHOTS + 'v13-02-patch-form.png', fullPage: true });
  await aux.close();
  check('截图 v13-02-patch-form.png', true);
});

// ============ 场景 3：小块回退全文形 ============
await step('场景3：小块回退', async () => {
  const r = await page.evaluate(async () => {
    const t = window.__t;
    await t.load('t3.md', '短段落，不足五十字符。');
    t.patchPara(0, '短段落已被改写，仍然很短。');
    const prompt = await t.prompt();
    const el = prompt.match(/<edit id="A\d+"[\s\S]*?<\/edit>/)?.[0] ?? '';
    return { el };
  });
  check('3.1 小块不带 form="patch"', !r.el.includes('form="patch"'), r.el.split('\n')[0]);
  check('3.2 小块保留 <before>/<after>', r.el.includes('<before>') && r.el.includes('<after>'), r.el);
});

// ============ 场景 4：摘要行 ============
await step('场景4：摘要行', async () => {
  const r = await page.evaluate(async () => {
    const t = window.__t;
    const m = window.__md2p;
    await t.load('t4.md', ['甲段原文内容。', '', '乙段原文内容。', '', '丙段原文内容，等待批注。'].join('\n'));
    t.patchPara(0, '甲段已被改写。');
    t.patchPara(1, '乙段已被改写。');
    const b3 = t.paras()[2];
    m.store.dispatch({ type: 'addNote', blockId: b3.id, note: '这里请补一个过渡论证', quote: '等待批注' });
    const prompt = await t.prompt();
    return { head: prompt.split('\n').slice(0, 14).join('\n'), ops: t.ops() };
  });
  check('4.0 前置：1 条 note + 2 条 replace', r.ops.filter((o) => o.type === 'note').length === 1 && r.ops.filter((o) => o.type === 'replace').length === 2, JSON.stringify(r.ops));
  check('4.1 头部含「本次：B 类请求 1 条，A 类直接修改 2 条」', r.head.includes('本次：B 类请求 1 条，A 类直接修改 2 条'), r.head);
});

// ============ 场景 5：hidden 跨会话恢复（手动播种，等价 restoreFromPrompt 后的 load） ============
let s5 = null;
await step('场景5：hidden 跨会话', async () => {
  const DOC5 = ['第一段保持原样。', '', '第二段将被改写并隐藏。', '', '第三段保持原样。'].join('\n');
  const NEW2 = '第二段已被人工改写。';
  s5 = await page.evaluate(async ({ doc, new2 }) => {
    const t = window.__t;
    const m = window.__md2p;
    await t.load('t5.md', doc);
    t.patchPara(1, new2);
    const op = m.store.state.ops.find((o) => o.type === 'replace');
    const before2 = m.store.state.base.find((b) => b.id === op.blockId)?.text ?? null;
    m.store.dispatch({ type: 'hide', id: op.id });
    const stateAfterHide = m.store.state.ops.find((o) => o.type === 'replace')?.state ?? null;
    const p1 = await t.prompt();
    const hiddenId1 = p1.match(/<edit id="(A\d+)"[^>]*state="hidden"/)?.[1] ?? null;

    // 模拟跨会话：重新打开同文档（无 sibling prompt 可寻），再按 Prompt.md 手动播种 ops
    await t.load('t5.md', doc);
    const base = m.parseDoc(doc, 'md');
    const target = base.find((b) => b.text === before2);
    const cur = base.map((b) => (b.id === target.id ? { ...b, text: new2 } : { ...b }));
    m.store.dispatch({
      type: 'load',
      file: { name: 't5.md', kind: 'md' },
      cur,
      base,
      ops: [{ id: hiddenId1 ?? 'A1', type: 'replace', blockId: target.id, before: before2, after: new2, time: '10:00', state: 'hidden' }],
    });
    const restored = m.store.state.ops.find((o) => o.type === 'replace');
    const p2 = await t.prompt();
    const hiddenId2 = p2.match(/<edit id="(A\d+)"[^>]*state="hidden"/)?.[1] ?? null;
    return { stateAfterHide, hiddenId1, hiddenId2, restoredState: restored?.state ?? null, restoredSeq: restored?.seq ?? null, opsAfter: t.ops() };
  }, { doc: DOC5, new2: NEW2 });
  check('5.1 hide 后 op.state==="hidden"', s5.stateAfterHide === 'hidden', s5.stateAfterHide ?? 'null');
  check('5.2 导出带 state="hidden"（会话内）', !!s5.hiddenId1, `id=${s5.hiddenId1}`);
  check('5.3 跨会话重载后 hidden 不复活成 pending', s5.restoredState === 'hidden', JSON.stringify(s5.opsAfter));
  check('5.4 跨会话后导出 id 与会话内一致（seq 保留）', !!s5.hiddenId2 && s5.hiddenId2 === s5.hiddenId1, `会话内=${s5.hiddenId1} 重载后=${s5.hiddenId2} (seq=${s5.restoredSeq})`);
});

// ============ 场景 6：quote 恢复 → 文档选段下划线 ============
await step('场景6：quote 下划线恢复', async () => {
  const r = await page.evaluate(async () => {
    const t = window.__t;
    const m = window.__md2p;
    const doc = ['协议比编辑器更重要，插件只是薄层。', '', '第二段没有任何批注。'].join('\n');
    await t.load('t6.md', doc);
    const blocks = m.parseDoc(doc, 'md');
    const target = blocks.find((b) => b.text.includes('插件只是薄层'));
    m.store.dispatch({
      type: 'load',
      file: { name: 't6.md', kind: 'md' },
      cur: blocks,
      base: blocks,
      ops: [{ id: 'B1', type: 'note', blockId: target.id, note: '恢复进来的批注', quote: '插件只是薄层', time: '10:00' }],
    });
    return { ops: t.ops() };
  });
  await page.waitForTimeout(800); // 等 editor 装饰重算
  const marks = await page.evaluate(() => ({
    span: document.querySelectorAll('#doc .rev-note-span').length,
    pin: document.querySelectorAll('#doc .rev-pin').length,
  }));
  check('6.1 note op 带 quote 入状态', r.ops.some((o) => o.type === 'note' && o.quote === '插件只是薄层'), JSON.stringify(r.ops));
  check('6.2 文档出现 .rev-note-span 下划线', marks.span >= 1, JSON.stringify(marks));
  const docEl = page.locator('#doc');
  if (await docEl.count()) await docEl.screenshot({ path: SHOTS + 'v13-06-quote-underline.png' });
  else await page.screenshot({ path: SHOTS + 'v13-06-quote-underline.png', fullPage: true });
  check('截图 v13-06-quote-underline.png', true);
});

// ============ 场景 7：复制版与全文版结构一致（patch 形同形） ============
await step('场景7：复制版 patch 形一致', async () => {
  const r = await page.evaluate(async ({ doc, idx, repl }) => {
    const t = window.__t;
    await t.load('t7.md', doc);
    const orig = t.paras()[0].text;
    const sents = orig.match(/[^。！？]+[。！？]/g);
    const cur = window.__md2p.store.state.cur.map((b) => ({ ...b }));
    cur.find((b) => b.kind === 'para').text = orig.replace(sents[idx], repl);
    window.__md2p.store.dispatch({ type: 'patchCur', cur });
    const full = await t.prompt(false);
    const copy = await t.prompt(true);
    const section = (s, tag) => s.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`))?.[0] ?? null;
    const elF = full.match(/<edit id="A\d+"[\s\S]*?<\/edit>/)?.[0] ?? '';
    const elC = copy.match(/<edit id="A\d+"[\s\S]*?<\/edit>/)?.[0] ?? '';
    return {
      copyPatch: elC.includes('form="patch"') && /<after-hash>blake3:[0-9a-f]{16}<\/after-hash>/.test(elC) && !elC.includes('<before>') && !elC.includes('<after>'),
      elSame: elF === elC,
      reqSame: section(full, 'requests') === section(copy, 'requests'),
      editsSame: section(full, 'edits') === section(copy, 'edits'),
      elC,
    };
  }, { doc: LONG_PARA + '\n\n结尾短段，不参与修改。', idx: 3, repl: REPLACED });
  check('7.1 复制版 patch 元素同形（form/after-hash，无 before/after）', r.copyPatch, r.elC);
  check('7.2 复制版 <edits> 与全文版逐字一致', r.editsSame && r.elSame, '');
  check('7.3 复制版 <requests> 与全文版一致', r.reqSame, '');
});

await browser.close();

// ============ 汇总 ============
const fails = results.filter((x) => !x.ok);
console.log('\n========== v1.3 批次 2 验收汇总 ==========');
console.log(`PASS ${results.length - fails.length} / ${results.length}`);
if (fails.length) {
  console.log('FAIL 项：');
  for (const f of fails) console.log('  - ' + f.name);
}
process.exit(fails.length ? 1 : 0);
