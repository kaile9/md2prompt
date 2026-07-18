// qa15-s1c-clean.mjs — 干净环境下逐项验证 XML 卡问题（排除会话污染）
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const b = await chromium.launch();

async function freshCase(name, text, wait = 1500) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', e => console.log(`[${name} pageerror]`, e.message));
  await p.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
  await p.goto(HTML);
  await p.waitForFunction(() => !!window.__md2p?.store);
  await p.evaluate(async (t) => {
    await window.__md2p.loadDocFile({ name: 'a.xml', kind: 'xml', mtime: Date.now(), text: t });
  }, text);
  await p.waitForTimeout(wait);
  const r = await p.evaluate(() => ({
    card: !!document.querySelector('.xml-card'),
    cardText: document.querySelector('.xml-card')?.textContent?.slice(0, 60) ?? null,
    blocks: window.__md2p.store.state.cur.map(x => ({ kind: x.kind, text: x.text.slice(0, 50) })),
  }));
  console.log(`${name}: card=${r.card} blocks=${r.blocks.length}`);
  console.log('  cardText:', JSON.stringify(r.cardText));
  console.log('  blocks:', JSON.stringify(r.blocks));
  await p.close();
}

await freshCase('普通XML', '<identity>\n  <name>助手</name>\n  <note/>\n</identity>');
await freshCase('含三反引号XML', '<script>\n```\nlet x = 1;\n```\n</script>');
await freshCase('含单反引号XML', '<script>\nlet x = `a`;\n</script>');
await b.close();
