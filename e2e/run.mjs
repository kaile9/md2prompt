#!/usr/bin/env node
// e2e/run.mjs — 回归套件顺序 runner（v2.0.2 引入；CI 与本地同一入口，套件清单单源）。
//
// 必须用 node 跑（bun 不行）：bun 实测 chromium.launch 起得了进程但连不上 CDP 管道。
//
// 用法：
//   node e2e/run.mjs              # 全量顺序跑
//   node e2e/run.mjs smoke life   # 只跑子集（文件名，可省 .mjs）
//
// 失败判定（三者任一）：
//   1. 子进程退出码非 0 / 被信号杀死（主套件自带退出码）
//   2. 超时（默认 120s/个，E2E_TIMEOUT_MS 环境变量可改，单文件可用 timeout 字段覆盖）
//   3. 输出出现行首 FAIL —— qa15-s* 场景脚本只打印 PASS/FAIL 汇总、不置退出码，
//      为不改这些脚本的逻辑，runner 补一道输出扫描。
//
// 套件取舍：下表即全部回归脚本（留在 e2e/ 顶层的 .mjs）。
// 一次性 QA 探针 / 复现 / 性能 / 截图脚本已归档 e2e/probes/，不进套件、不维护。

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT = Number(process.env.E2E_TIMEOUT_MS) || 120_000;

// 顺序即执行顺序：冒烟先行快速失败，核心验收居中，qa15 场景系列殿后。
const SUITE = [
  { file: 'smoke.mjs',          note: '冒烟：页面可开、__md2p 钩子与关键控件存在' },
  { file: 'life.mjs',           note: '生命周期：隐藏/撤回两阶段/复活/清空/跳转' },
  { file: 'export.mjs',         note: '导出协议 2.0/设置项/路径行/打印' },
  { file: 'v13.mjs',            note: 'op 稳定编号/patch 形/摘要行/跨会话恢复' },
  { file: 'note.mjs',           note: '批注：选区浮钮→浮层→note op（含 quote）' },
  { file: 'look.mjs',           note: '界面：首启引导/SVG 图标/工具轨格式入账' },
  { file: 'srcmode.mjs',        note: 'XML 三档契约：成对标签融卡、卡内可编' },
  { file: 'faithful.mjs',       note: 'canonText 归一化等价：首笔编辑无幻影（v2.0.1 门禁）' },
  { file: 'measure.mjs',        note: '页宽设置真正生效（BUG2 门禁）' },
  { file: 'splitalign.mjs',     note: '分屏块锚行对齐（BUG3 门禁）' },
  { file: 'sourceanno.mjs',     note: '源码/分屏批注与行内格式（BUG4 门禁）' },
  { file: 'xmlmode.mjs',        note: 'XML 恒由 CodeMirror 承载（审查 B1 门禁）' },
  { file: 'microtypo.mjs',      note: 'OpenType 微排版设置组（门禁）' },
  { file: 'qa15-s2-tabs.mjs',   note: '场景2：页签持久化 + 非法值回退' },
  { file: 'qa15-s3-path.mjs',   note: '场景3：路径前缀去重斜杠/复制内容/清空恢复' },
  { file: 'qa15-s3b-copy.mjs',  note: '场景3 补测：⧉ 复制钮 + 混合斜杠细节' },
  { file: 'qa15-s4-jump.mjs',   note: '场景4 终版：跳转落点（顶/底/连点幂等）' },
  { file: 'qa15-s5-split.mjs',  note: '场景5：分屏滚动同步 + 右侧 1s 内刷新' },
  { file: 'qa15-s6-quote.mjs',  note: '场景6：批注引文单行截断→展开→收起' },
  { file: 'qa15-s7-minimap.mjs', note: '场景7 终版：点 minimap 空白轨道按比例滚动' },
  { file: 'qa15-s8-flow.mjs',   note: '场景8：隐藏/撤回/复活在三页签间的流转入口' },
  { file: 'qa15-s8c-noteid.mjs', note: '场景8c：note 撤回→复活后导出编号稳定' },
];

const pick = process.argv.slice(2).map((s) => s.replace(/\.mjs$/, ''));
const suite = pick.length ? SUITE.filter((t) => pick.includes(t.file.replace(/\.mjs$/, ''))) : SUITE;
if (pick.length && !suite.length) {
  console.error('没有匹配的套件文件：', pick.join(', '));
  process.exit(2);
}

const FAIL_LINE = /^[ \t]*FAIL[ |:]/m;

function runOne({ file, timeout = DEFAULT_TIMEOUT }) {
  return new Promise((resolve) => {
    const full = path.join(HERE, file);
    if (!existsSync(full)) return resolve({ file, ok: false, why: '文件不存在', ms: 0 });
    const t0 = Date.now();
    const child = spawn(process.execPath, [full], { cwd: HERE, env: process.env });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }, timeout);
    timer.unref?.();
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ file, ok: false, why: 'spawn 失败: ' + e.message, ms: Date.now() - t0 });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      let why = '';
      if (timedOut) why = `超时 ${timeout / 1000}s`;
      else if (signal) why = `信号 ${signal}`;
      else if (code !== 0) why = `退出码 ${code}`;
      else if (FAIL_LINE.test(out)) why = '输出含 FAIL';
      resolve({ file, ok: !why, why, ms });
    });
  });
}

console.log(`== e2e 回归套件：${suite.length} 个脚本，单脚本超时 ${DEFAULT_TIMEOUT / 1000}s ==\n`);
const results = [];
for (const t of suite) {
  console.log(`\n----- ${t.file} — ${t.note} -----`);
  const r = await runOne(t);
  results.push(r);
  console.log(`----- ${t.file}: ${r.ok ? 'OK' : 'FAIL (' + r.why + ')'} ${(r.ms / 1000).toFixed(1)}s -----`);
}

const fails = results.filter((r) => !r.ok);
console.log('\n==== 回归套件汇总 ====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.file}${r.why ? ' | ' + r.why : ''} | ${(r.ms / 1000).toFixed(1)}s`);
console.log(`\n通过 ${results.length - fails.length}/${results.length}`);
process.exitCode = fails.length ? 1 : 0;
