import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
// 生成 ~1MB 文档：标题×80，每节 12 段 + 每 10 节一个 mermaid
const parts = [];
for (let s = 0; s < 200; s++) {
  parts.push(`## 第 ${s + 1} 节标题`, '');
  for (let i = 0; i < 30; i++) parts.push(`第 ${s + 1} 节第 ${i + 1} 段。这是一段用于填充体积的中文正文，模拟真实文案工作负载，包含**加粗**与[链接](https://example.com)。`, '');
  if (s % 10 === 0) parts.push('```mermaid', 'graph TD; A-->B; B-->C;', '```', '');
}
const text = parts.join('\n');
console.log('doc bytes:', Buffer.byteLength(text));

const b = await chromium.launch();
const p = await b.newPage();
await p.goto(HTML);
await p.waitForTimeout(800);
const r = await p.evaluate(async (text) => {
  const t0 = performance.now();
  await window.__md2p.loadDocFile({ name: 'big.md', kind: 'md', text, mtime: Date.now() });
  const t1 = performance.now(); // loadDocFile resolve（parse+dispatch）
  await new Promise((res) => {
    const tick = () => (document.querySelector('#doc .ProseMirror') ? res(0) : setTimeout(tick, 50));
    tick();
  });
  const t2 = performance.now(); // 编辑器就绪
  return { load: Math.round(t1 - t0), editor: Math.round(t2 - t0), sections: document.querySelectorAll('#doc section').length };
}, text);
console.log(JSON.stringify(r));
await b.close();
