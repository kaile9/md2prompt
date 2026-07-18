// qa15-s2-tabs.mjs — 场景2：页签持久化 + 非法值回退
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

await p.evaluate(async () => {
  await window.__md2p.loadDocFile({ name: 't.md', kind: 'md', mtime: Date.now(), text: '第一段。\n\n第二段。' });
});
await p.waitForTimeout(500);

const activeTab = () => p.evaluate(() => {
  const btns = [...document.querySelectorAll('#changes [data-act="tab"]')];
  const on = btns.find(x => x.className.match(/on|active|sel|cur/i) || x.getAttribute('aria-selected') === 'true' || x.getAttribute('aria-pressed') === 'true');
  return { active: on?.dataset.tab ?? null, cls: btns.map(x => `${x.dataset.tab}:${x.className}`).join(' | ') };
});

// 切到墓碑
await p.click('#changes [data-act="tab"][data-tab="tomb"]');
await p.waitForTimeout(300);
const t0 = await activeTab();
const lsKey = await p.evaluate(() => localStorage.getItem('md2prompt.tab'));
report('2.0 切到墓碑后活动页签=tomb 且写入 localStorage', t0.active === 'tomb' && lsKey === 'tomb', `active=${t0.active} ls=${lsKey} (${t0.cls})`);

// reload
await p.reload();
await p.waitForFunction(() => !!window.__md2p?.store);
await p.waitForTimeout(600);
const t1 = await activeTab();
report('2.1 reload 后页签仍停在墓碑', t1.active === 'tomb', `active=${t1.active} (${t1.cls})`);

// 非法值回退
for (const bad of ['bogus', '', 'TOMB', 'null', '__proto__']) {
  await p.evaluate(v => localStorage.setItem('md2prompt.tab', v), bad);
  await p.reload();
  await p.waitForFunction(() => !!window.__md2p?.store);
  await p.waitForTimeout(600);
  const t = await activeTab();
  report(`2.2 非法值 ${JSON.stringify(bad)} → 回退修订`, t.active === 'rev', `active=${t.active} (${t.cls})`);
}

// 删除键（无持久化）→ 默认
await p.evaluate(() => localStorage.removeItem('md2prompt.tab'));
await p.reload();
await p.waitForFunction(() => !!window.__md2p?.store);
await p.waitForTimeout(600);
const t3 = await activeTab();
report('2.3 无持久化值时默认修订', t3.active === 'rev', `active=${t3.active}`);

console.log('\n==== 场景2 汇总 ====');
const fails = results.filter(r => !r.ok);
console.log(`PASS ${results.length - fails.length}/${results.length}`);
for (const f of fails) console.log('  FAIL:', f.name);
await b.close();
