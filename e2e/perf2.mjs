import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const parts = [];
for (let s = 0; s < 200; s++) {
  parts.push(`## 第 ${s + 1} 节标题`, '');
  for (let i = 0; i < 30; i++) parts.push(`第 ${s + 1} 节第 ${i + 1} 段。这是一段用于填充体积的中文正文，模拟真实文案工作负载，包含**加粗**与[链接](https://example.com)。`, '');
  if (s % 10 === 0) parts.push('```mermaid', 'graph TD; A-->B; B-->C;', '```', '');
}
const text = parts.join('\n');
const b = await chromium.launch();
const p = await b.newPage();
await p.goto(HTML);
await p.waitForTimeout(800);
const r = await p.evaluate(async (text) => {
  const t0 = performance.now();
  const blocks = window.__md2p.parseDoc(text, 'md');
  const t1 = performance.now(); // parse
  await window.__md2p.loadDocFile({ name: 'big.md', kind: 'md', text, mtime: Date.now() });
  const t2 = performance.now(); // 全量 load（含 renderDoc/全节静态渲染）
  return { parse: Math.round(t1 - t0), loadTotal: Math.round(t2 - t0), blocks: blocks.length };
}, text);
console.log(JSON.stringify(r));
await b.close();
