// qa15-s6-quote.mjs — 场景6：批注卡引文 默认单行截断 → 点击展开 → 再点收起
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

// 200 字 quote 的批注
await p.evaluate(async () => {
  const m = window.__md2p;
  const text = '批注引文截断测试段落。' + '这一段文字会被完整引用到批注卡里，长度必须超过卡片单行能放下的宽度才能触发截断。'.repeat(4) + '收尾句。';
  await m.loadDocFile({ name: 'q.md', kind: 'md', mtime: Date.now(), text });
  const bid = m.store.state.cur[0].id;
  const quote = m.store.state.cur[0].text.slice(0, 200);
  m.store.dispatch({ type: 'addNote', blockId: bid, note: '引文展开测试批注', quote });
});
await p.waitForTimeout(500);
console.log('quote 长度:', await p.evaluate(() => window.__md2p.store.state.ops.find(o => o.type === 'note')?.quote?.length));
await p.click('#changes [data-act="tab"][data-tab="note"]');
await p.waitForTimeout(400);

const qstate = () => p.evaluate(() => {
  const q = document.querySelector('#changes .rev-quote');
  if (!q) return { found: false };
  const cs = getComputedStyle(q);
  return {
    found: true,
    scrollW: q.scrollWidth, clientW: q.clientWidth,
    scrollH: q.scrollHeight, clientH: q.clientHeight,
    ws: cs.whiteSpace, clamp: cs.webkitLineClamp, lines: Math.round(q.clientHeight / (parseFloat(cs.lineHeight) || 20)),
    cls: q.className,
    textTail: q.textContent.slice(-10),
  };
});

const s0 = await qstate();
console.log('初始:', JSON.stringify(s0));
report('6.1 默认单行截断（scrollWidth > clientWidth）', s0.found && s0.scrollW > s0.clientW, `scrollW=${s0.scrollW} clientW=${s0.clientW} ws=${s0.ws} clamp=${s0.clamp}`);

await p.click('#changes .rev-quote');
await p.waitForTimeout(400);
const s1 = await qstate();
console.log('点击后:', JSON.stringify(s1));
// 展开：不再单行截断——多行显示，且全部 200 字可见（scrollWidth 不再超出）
const expanded = s1.found && (s1.scrollW <= s1.clientW + 2) && s1.clientH > s0.clientH + 10;
report('6.2 点击后展开为多行（全文可见）', expanded, `clientH ${s0.clientH}→${s1.clientH} scrollW=${s1.scrollW} clientW=${s1.clientW} cls=${s1.cls}`);
const fullVisible = await p.evaluate(() => {
  const q = document.querySelector('#changes .rev-quote');
  const quote = window.__md2p.store.state.ops.find(o => o.type === 'note')?.quote ?? '';
  return q && q.textContent.includes(quote.slice(-8)); // 引文尾部可见
});
report('6.3 展开后引文尾部（第 200 字附近）可见', fullVisible, '');

await p.click('#changes .rev-quote');
await p.waitForTimeout(400);
const s2 = await qstate();
console.log('再点后:', JSON.stringify(s2));
report('6.4 再点收起恢复单行截断', s2.found && s2.scrollW > s2.clientW && s2.clientH <= s0.clientH + 2, `clientH=${s2.clientH} scrollW=${s2.scrollW}`);

console.log('\n==== 场景6 汇总 ====');
const fails = results.filter(r => !r.ok);
console.log(`PASS ${results.length - fails.length}/${results.length}`);
for (const f of fails) console.log('  FAIL:', f.name);
await b.close();
