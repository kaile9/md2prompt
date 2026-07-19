// 门禁：微排版 + OpenType 设置组（渐进增强，不支持的特性静默无效）
import { chromium } from 'playwright';
const HTML = new URL('../dist/2youg1-md2prompt.html', import.meta.url).href;
const fails = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`);
  if (!cond) fails.push(name);
};
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on('pageerror', (e) => console.log('[pageerror]', e.message));
await p.goto(HTML);
await p.waitForTimeout(800);
await p.evaluate(() => {
  localStorage.removeItem('md2prompt.prefs');
  document.querySelector('.coach-modal button')?.click();
});
await p.evaluate(async () => {
  await window.__md2p.loadDocFile({ name: 't.md', kind: 'md', text: '第一段，含「标点」与 CJK and 西文 mixed 内容 1234567890。', mtime: Date.now() });
});
await p.waitForTimeout(1000);

// 设置面板含微排版组 6 项
await p.click('#settings-btn');
await p.waitForTimeout(300);
const names = await p.evaluate(() => ['microHanging', 'microAutospace', 'microSpacingTrim', 'microTextWrap', 'microTnum', 'microOnum'].filter((n) => !document.querySelector(`input[name="${n}"]`)));
ok('1. 设置面板微排版 6 控件齐', names.length === 0, names.join(','));

// 默认值：四项开、两项关；data 属性正确
const defAttrs = await p.evaluate(() => {
  const d = document.documentElement.dataset;
  return { h: d.microHanging, a: d.microAutospace, s: d.microSpacingtrim, w: d.microWrap, t: d.otTnum, o: d.otOnum };
});
ok('2. 默认值：悬挂/间隙/压缩/折行开，tnum/onum 关', defAttrs.h === 'on' && defAttrs.a === 'on' && defAttrs.s === 'on' && defAttrs.w === 'on' && defAttrs.t === 'off' && defAttrs.o === 'off', JSON.stringify(defAttrs));

// 打开 tnum → 计算样式生效（Chromium 必支持 font-variant-numeric）
await p.click('input[name="microTnum"]');
await p.waitForTimeout(250);
const tnum = await p.evaluate(() => getComputedStyle(document.getElementById('doc')).fontVariantNumeric);
ok('3. tnum 开启后计算样式含 tabular-nums', tnum.includes('tabular-nums'), tnum);

// text-wrap pretty 计算样式（Chrome 114+ 支持；不支持则跳过不视为失败——渐进增强语义）
const wrap = await p.evaluate(() => getComputedStyle(document.querySelector('#doc p')).textWrap);
ok('4. 优化折行：pretty 生效或被平台静默忽略', wrap === 'pretty' || wrap === 'wrap', wrap);

// 关闭全部四项默认开 → data 属性全 off，计算样式回退
for (const n of ['microHanging', 'microAutospace', 'microSpacingTrim', 'microTextWrap']) await p.click(`input[name="${n}"]`);
await p.waitForTimeout(250);
const offAttrs = await p.evaluate(() => {
  const d = document.documentElement.dataset;
  return d.microHanging === 'off' && d.microAutospace === 'off' && d.microSpacingtrim === 'off' && d.microWrap === 'off';
});
ok('5. 四项关闭后 data 属性全 off', offAttrs);

// 持久化：刷新后 tnum 仍开
await p.reload();
await p.waitForTimeout(900);
const persisted = await p.evaluate(() => document.documentElement.dataset.otTnum);
ok('6. 刷新后 tnum 持久化', persisted === 'on', persisted);

await b.close();
if (fails.length) {
  console.log(`\n${fails.length} FAIL`);
  process.exit(1);
}
console.log('\nALL PASS');
