import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.addInitScript(() => { try { localStorage.setItem('md2prompt.coachSeen', '1'); } catch {} });
await p.goto(HTML);
await p.waitForTimeout(900);
await p.evaluate(async () => {
  const doc = [
    '# Claude 宪法（节选）', '',
    '> 原文：Anthropic。本文用于界面目检。', '',
    '<identity intent="演示">', '',
    '本宪法旨在**指导** Claude 的行为与价值观。', '',
    '</identity>', '',
    '## 序言', '',
    'Claude 宪法是对 Anthropic 就 Claude 的价值观与行为所抱意图的一份详尽描述。',
    '它在我们训练模型的过程中扮演关键角色。', '',
    '## 概述', '',
    '本文件以 Claude 为主要读者撰写。', '',
  ].join('\n');
  await window.__md2p.loadDocFile({ name: 'demo.md', kind: 'md', text: doc, mtime: Date.now() });
});
await p.waitForTimeout(1800);
// 制造一修订 + 一批注（直接动 store，等价人工动作的结果态）
await p.evaluate(() => {
  const st = window.__md2p.store;
  const cur = st.state.cur.map((x) => ({ ...x }));
  const t = cur.find((x) => x.text.startsWith('Claude 宪法是对'));
  t.text += '（修订示例）';
  st.dispatch({ type: 'patchCur', cur });
});
await p.waitForTimeout(400);
await p.evaluate(() => {
  const st = window.__md2p.store;
  const b = st.state.cur.find((x) => x.text.startsWith('本文件以'));
  st.dispatch({ type: 'addNote', blockId: b.id, note: '这句太长，请 AI 拆成两句并补一个例子。' });
});
await p.waitForTimeout(600);
await p.screenshot({ path: '../e2e-shots/v15-render.png' });
// 分屏
await p.click('#mode-btn'); // → 源码
await p.waitForTimeout(700);
await p.click('#mode-btn'); // → 分屏
await p.waitForTimeout(900);
await p.screenshot({ path: '../e2e-shots/v15-split.png' });
await p.click('#mode-btn'); // → 渲染
await p.waitForTimeout(700);
// 纯黑主题
await p.click('#settings-btn');
await p.waitForTimeout(300);
await p.click('input[name="theme"][value="night"] + span');
await p.keyboard.press('Escape');
await p.waitForTimeout(400);
await p.screenshot({ path: '../e2e-shots/v15-night.png' });
await b.close();
console.log('shots done');
