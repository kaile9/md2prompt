// qa15-probe.mjs — 摸清 v1.5 DOM 结构：工具栏/页签/设置/分屏/minimap/XML卡
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('pageerror', e => console.log('[pageerror]', e.message));
await p.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
await p.goto(HTML);
await p.waitForFunction(() => !!window.__md2p?.store);

// __md2p 钩子
console.log('__md2p keys:', await p.evaluate(() => Object.keys(window.__md2p).join(',')));

// 顶栏按钮
console.log('\n== 顶栏按钮 ==');
console.log(await p.evaluate(() => [...document.querySelectorAll('#topbar button, header button, .topbar button, [class*="topbar"] button')]
  .map(x => `${x.id || x.dataset.act || x.title || x.textContent.trim().slice(0, 12)}`).join(' | ')));

// 所有带 data-act 的控件
console.log('\n== data-act 控件 ==');
console.log(await p.evaluate(() => [...new Set([...document.querySelectorAll('[data-act]')].map(x => `${x.dataset.act}${x.dataset.tab ? ':' + x.dataset.tab : ''}`))].join(' | ')));

// 页签
console.log('\n== 页签按钮 ==');
console.log(await p.evaluate(() => [...document.querySelectorAll('#changes [data-act="tab"]')].map(x => `${x.dataset.tab}:${x.textContent.trim()}`).join(' | ')));

// 设置对话框
const settingsBtn = await p.evaluate(() => {
  const cands = [...document.querySelectorAll('button')].filter(x => /设置|settings/i.test(x.title + x.textContent + (x.id || '')));
  return cands.map(x => x.id || x.title || x.textContent.trim());
});
console.log('\n== 设置按钮候选 ==', JSON.stringify(settingsBtn));

// 打开设置
try {
  await p.click('#settings-btn, [data-act="settings"]', { timeout: 2000 });
  await p.waitForTimeout(400);
  console.log('\n== 设置面板 inputs ==');
  console.log(await p.evaluate(() => [...document.querySelectorAll('dialog input, .modal input, [class*="modal"] input, [role="dialog"] input, .settings input, #settings input')]
    .map(x => `#${x.id} name=${x.name} ph=${x.placeholder} val=${x.value}`).join('\n')));
  console.log('== 可见 dialog 文本片段 ==');
  console.log(await p.evaluate(() => {
    const d = [...document.querySelectorAll('dialog, [role="dialog"], .modal, [class*="modal"]')].find(x => x.offsetParent);
    return d ? d.textContent.replace(/\s+/g, ' ').slice(0, 500) : '(none visible)';
  }));
} catch (e) { console.log('设置打开失败:', e.message); }

// 关掉设置（Esc）
await p.keyboard.press('Escape');
await p.waitForTimeout(200);

// 滚动容器 & minimap
console.log('\n== scroller / minimap ==');
console.log(await p.evaluate(() => ({
  scroller: !!document.querySelector('#scroller'),
  scrollerClass: document.querySelector('#scroller')?.className,
  minimap: [...document.querySelectorAll('[class*="minimap"], [id*="minimap"]')].map(x => `${x.tagName}#${x.id}.${x.className}`),
})));

// 加载 XML 文档看看渲染成什么样
await p.evaluate(async () => {
  await window.__md2p.loadDocFile({
    name: 'agent.xml', kind: 'xml', mtime: Date.now(),
    text: '<identity>\n  <name>测试助手</name>\n  <note/>\n</identity>',
  });
});
await p.waitForTimeout(600);
console.log('\n== XML 加载后 state ==');
console.log(await p.evaluate(() => {
  const s = window.__md2p.store.state;
  return JSON.stringify({ file: s.file, cur: s.cur.map(x => ({ id: x.id, kind: x.kind, text: (x.text || '').slice(0, 60) })), ops: s.ops.length });
}));
console.log('\n== #doc 结构（XML 卡）==');
console.log(await p.evaluate(() => {
  const d = document.querySelector('#doc');
  const walk = (el, depth) => depth > 4 ? '' : '  '.repeat(depth) + el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).replace(/\s+/g, '.') : '') + (el.isContentEditable ? '[CE]' : '') + '\n' + [...el.children].map(c => walk(c, depth + 1)).join('');
  return walk(d, 0).slice(0, 1500);
}));

// 分屏按钮
console.log('\n== 模式/分屏按钮 ==');
console.log(await p.evaluate(() => ['mode-btn', 'split-btn'].map(id => {
  const el = document.getElementById(id);
  return el ? `${id} 存在 text=${el.textContent.trim().slice(0, 20)} title=${el.title}` : `${id} 不存在`;
}).join(' | ')));

await b.close();
