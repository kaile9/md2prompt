import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.addInitScript(() => {
  try {
    localStorage.setItem('md2prompt.coachSeen', '1');
    localStorage.setItem('md2prompt.prefs', JSON.stringify({ style: 'humanist', guideLines: true, progress: 'map' }));
  } catch {}
});
await p.goto(HTML);
await p.waitForTimeout(900);
await p.evaluate(async () => {
  const text = ['# 人文风格验证', '', '第一段观察行引导线的粗细与透明度是否合格。', '', '第二段继续观察，长文案工作流里的视觉分区。', '', '第三段收尾。'].join('\n');
  await window.__md2p.loadDocFile({ name: 'demo.md', kind: 'md', text, mtime: Date.now() });
});
await p.waitForTimeout(1500);
const r = await p.evaluate(() => ({
  guides: document.documentElement.dataset.guides,
  progress: document.documentElement.dataset.progress,
  mapDisplay: document.getElementById('minimap').style.display,
  mapBars: document.querySelectorAll('#minimap i').length,
  ruleCount: document.querySelectorAll('#doc p').length,
}));
console.log(JSON.stringify(r));
await p.screenshot({ path: '../e2e-shots/v14-humanist-map2.png' });
await b.close();
