// qa15-s1-xml.mjs — 场景1 终版：XML 卡直编边界
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const results = [];
const report = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + String(detail).slice(0, 500) : ''}`); };

const b = await chromium.launch();
async function fresh() {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.errors = [];
  p.on('pageerror', e => p.errors.push(e.message));
  await p.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
  await p.goto(HTML);
  await p.waitForFunction(() => !!window.__md2p?.store);
  return p;
}
const loadXml = (p, text) => p.evaluate(async (t) => {
  await window.__md2p.loadDocFile({ name: 'a.xml', kind: 'xml', mtime: Date.now(), text: t });
}, text);
const state = (p) => p.evaluate(() => {
  const s = window.__md2p.store.state;
  return { cur: s.cur.map(x => ({ id: x.id, kind: x.kind, text: x.text })), ops: s.ops.map(o => ({ id: o.id, type: o.type, before: o.before, after: o.after })) };
});
const promptOf = (p) => p.evaluate(async () => await window.__md2p.buildPrompt(window.__md2p.store.state));

// ================= 1a：清空卡内全部文本再打字 =================
{
  const p = await fresh();
  const XML0 = '<identity>\n  <name>测试助手</name>\n  <note/>\n</identity>';
  const XML1 = '<identity><name>全新助手</name><note/></identity>';
  await loadXml(p, XML0);
  await p.waitForTimeout(1200);
  await p.click('.xml-card');
  await p.keyboard.press('ControlOrMeta+a');
  await p.keyboard.type(XML1);
  await p.waitForTimeout(900);
  const st = await state(p);
  const pr = await promptOf(p);
  const op = st.ops.find(o => o.type === 'replace');
  report('1a.1 清空打字后产生 replace op', !!op, `ops=${JSON.stringify(st.ops.map(o => o.type))}`);
  report('1a.2 cur 逐字保真', st.cur[0]?.text === XML1 || st.cur[0]?.text === XML1 + '\n', `cur=${JSON.stringify(st.cur[0]?.text)}`);
  const editEl = pr.match(/<edit id="A\d+"[\s\S]*?<\/edit>/)?.[0] ?? '';
  report('1a.3 导出含完整 <edit> 元素', !!editEl, editEl.split('\n')[0] ?? '(无)');
  report('1a.4 导出 after 无转义污染', editEl.includes('<name>全新助手</name>') && !editEl.includes('\\<'), editEl.slice(0, 260));
  const stillCard = await p.evaluate(() => !!document.querySelector('.xml-card'));
  const para = await p.evaluate(() => document.querySelector('#doc .ProseMirror p')?.textContent?.slice(0, 60) ?? null);
  report('1a.5 flush 后 XML 卡仍在（可继续直编）', stillCard, `card=${stillCard} 降级渲染=${JSON.stringify(para)}`);
  await p.close();
}

// ================= 1b：闭标签删半边（破坏配对） =================
{
  const p = await fresh();
  const XML0 = '<identity>\n  <name>测试助手</name>\n  <note/>\n</identity>';
  await loadXml(p, XML0);
  await p.waitForTimeout(1200);
  await p.click('.xml-card');
  await p.keyboard.press('ControlOrMeta+a');
  const BROKEN = '<identity>\n  <name>破损</name>\n  <note/>\n</ident';
  await p.keyboard.type(BROKEN, { delay: 20 });
  await p.waitForTimeout(1000);
  const st = await state(p);
  let pr = null, perr = null;
  try { pr = await promptOf(p); } catch (e) { perr = e.message; }
  const alive = await p.evaluate(() => !!window.__md2p?.store && !!document.querySelector('#doc'));
  report('1b.1 页面不崩、无 pageerror', alive && p.errors.length === 0, `errors=${JSON.stringify(p.errors)}`);
  report('1b.2 XML 单块不变式保持（cur 仍 1 块、op 仍 1 笔）', st.cur.length === 1 && st.ops.length === 1,
    `cur=${st.cur.length} 块 ops=${st.ops.length} 笔 (${st.ops.map(o => o.type).join(',')})`);
  report('1b.3 导出正常返回且 <edit> 结构完整', !!pr && /<edit id="A\d+"[\s\S]*<\/edit>/.test(pr), perr ?? 'edit 元素匹配=' + (pr ? /<edit id="A\d+"[\s\S]*<\/edit>/.test(pr) : 'null'));
  report('1b.4 破损文本在导出中原样保留', !!pr && pr.includes('破损') && pr.includes('ident'), (pr ?? '').match(/<after>[\s\S]*?<\/after>/)?.[0]?.slice(0, 200));
  await p.close();
}

// ================= 1c：卡内文本含 ``` =================
// 契约修正（v1.5.1）：<script> 属档三=转义代码块（pre[data-language*="-raw"]，可直接编辑），
// 本就不渲染 .xml-card（卡是档一提示词式标签的待遇）。探测对象改为「单个完整转义块」。
{
  const p = await fresh();
  const XML_BT = '<script>\n```\nlet x = 1;\n```\n</script>';
  await loadXml(p, XML_BT);
  await p.waitForTimeout(1200);
  const st = await state(p);
  report('1c.1 载入含 ``` 的 XML：store 单块且逐字保真', st.cur.length === 1 && st.cur[0].text === XML_BT, `blocks=${st.cur.length}`);
  const blk = await p.evaluate(() => {
    const pres = [...document.querySelectorAll('#doc pre[data-language*="-raw"]')];
    return { n: pres.length, text: pres[0]?.textContent ?? '' };
  });
  report('1c.2 含 ``` 的 script 是单个完整转义块（非拼凑结构）', blk.n === 1 && blk.text.includes('let x = 1;') && blk.text.includes('</script>'), JSON.stringify(blk).slice(0, 120));
  // 单反引号对照
  await loadXml(p, '<script>\nlet x = `a`;\n</script>');
  await p.waitForTimeout(1200);
  const blk2 = await p.evaluate(() => {
    const pres = [...document.querySelectorAll('#doc pre[data-language*="-raw"]')];
    return { n: pres.length, text: pres[0]?.textContent ?? '' };
  });
  report('1c.3 含单反引号 ` 的 script 是单个完整转义块', blk2.n === 1 && blk2.text.includes('`a`') && blk2.text.includes('</script>'), JSON.stringify(blk2).slice(0, 120));
  // 档一（xml 卡）内含 ``` 对照：应渲染 .xml-card 且内容完整
  await loadXml(p, '<identity>\n```js\nlet a = 1;\n```\n</identity>');
  await p.waitForTimeout(1200);
  const blk3 = await p.evaluate(() => ({
    card: !!document.querySelector('.xml-card'),
    body: document.querySelector('.xml-card-body')?.textContent ?? '',
  }));
  report('1c.4 含 ``` 的提示词式 XML 仍渲染直编卡且内容完整', blk3.card && blk3.body.includes('let a = 1;') && blk3.body.includes('</identity>'), JSON.stringify(blk3).slice(0, 140));
  await p.close();
}

console.log('\n==== 场景1 汇总 ====');
const fails = results.filter(r => !r.ok);
console.log(`PASS ${results.length - fails.length}/${results.length}`);
for (const f of fails) console.log('  FAIL:', f.name);
await b.close();
process.exit(0);
