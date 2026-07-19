// SPDX-License-Identifier: MPL-2.0
import { S } from './strings';
import { SC_DEFAULT, SC_LABEL, captureCombo, type ScAction } from './shortcuts';

/** §5 EPUB 式排版设置 + 主题 3 × 风格 2。持久化 localStorage（键 md2prompt.prefs），
 *  applyPrefs 写 documentElement 的 data-theme/data-style 与 CSS 变量；
 *  字体栈选「跟随风格」时移除内联变量，落回 [data-style] 规则。 */

interface Prefs {
  theme: 'night' | 'marble' | 'paper';
  style: 'geek' | 'humanist';
  fontSize: number; // px
  lineHeight: number; // 倍数
  measure: number; // rem
  justify: boolean;
  fontWeight: number; // 100–900，滑杆 300–700 拖满后可输任意值（v1.4）
  brightness: number; // %，50–150（v1.4）
  contrast: number; // %
  guideLines: boolean; // 行引导线（人文风格默认开，v1.4）
  progress: 'bar' | 'map' | 'off'; // 进度条：传统细条 / minimap / 关（v1.4）
  indent: 'off' | 'render' | 'write'; // 首行缩进：关闭 / 仅渲染 / 写入文档（v1.2）
  gutter: boolean; // 行号栏（块首行徽标）
  cjk: string; // '' = 跟随风格；'custom' = 用 cjkCustom
  latin: string;
  cjkCustom: string;
  latinCustom: string;
  dirPrefix: string; // 文档目录前缀：复制路径时拼出完整路径（浏览器不暴露绝对路径，唯一通道）
  shortcuts: Record<string, string>; // 动作 → 组合键覆盖（v1.4；空 = 全默认）
  /** 微排版 + OpenType（v2.0，@supports 门控渐进增强，不支持的平台静默无效）。 */
  micro: { hanging: boolean; autospace: boolean; spacingTrim: boolean; textWrap: boolean; tnum: boolean; onum: boolean };
}

const KEY = 'md2prompt.prefs';

const DEFAULTS: Prefs = {
  theme: 'marble',
  style: 'geek',
  fontSize: 16,
  lineHeight: 1.75,
  measure: 42,
  justify: false,
  fontWeight: 400,
  brightness: 100,
  contrast: 100,
  guideLines: true,
  progress: 'map', // v1.5 默认 minimap：单进度件，原生滚动条已瘦身退居次视觉
  indent: 'off',
  gutter: true,
  cjk: '',
  latin: '',
  cjkCustom: '',
  latinCustom: '',
  dirPrefix: '',
  shortcuts: {},
  micro: { hanging: true, autospace: true, spacingTrim: true, textWrap: true, tnum: false, onum: false },
};

const CJK_STACKS: Record<string, string> = {
  hei: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif',
  song: '"Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", "Source Han Serif SC", serif',
  kai: '"Kaiti SC", "STKaiti", "KaiTi", "Noto Serif CJK SC", serif',
};

const LATIN_STACKS: Record<string, string> = {
  sans: '"Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif',
  serif: 'Georgia, "Nimbus Roman", "Times New Roman", serif',
  mono: '"Cascadia Mono", "JetBrains Mono", Consolas, "Courier New", monospace',
};

const THEME_SET = new Set<string>(['night', 'marble', 'paper']);
const STYLE_SET = new Set<string>(['geek', 'humanist']);

function loadPrefs(): Prefs {
  try {
    const p = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) };
    // 坏 storage（手改/旧版本枚举）回退默认，防 syncForm 找不到控件死锁
    if (!THEME_SET.has(p.theme)) p.theme = DEFAULTS.theme;
    if (!STYLE_SET.has(p.style)) p.style = DEFAULTS.style;
    if (p.cjk !== '' && p.cjk !== 'custom' && !(p.cjk in CJK_STACKS)) p.cjk = '';
    if (p.latin !== '' && p.latin !== 'custom' && !(p.latin in LATIN_STACKS)) p.latin = '';
    if (p.indent !== 'render' && p.indent !== 'write') p.indent = 'off';
    if (typeof p.gutter !== 'boolean') p.gutter = DEFAULTS.gutter;
    if (typeof p.dirPrefix !== 'string') p.dirPrefix = DEFAULTS.dirPrefix;
    if (typeof p.guideLines !== 'boolean') p.guideLines = DEFAULTS.guideLines;
    if (p.progress !== 'bar' && p.progress !== 'map' && p.progress !== 'off') p.progress = DEFAULTS.progress;
    if (typeof p.shortcuts !== 'object' || p.shortcuts === null) p.shortcuts = {};
    if (typeof p.micro !== 'object' || p.micro === null) p.micro = { ...DEFAULTS.micro };
    else p.micro = { ...DEFAULTS.micro, ...p.micro };
    p.fontWeight = Math.min(900, Math.max(100, p.fontWeight || DEFAULTS.fontWeight));
    p.brightness = Math.min(150, Math.max(50, p.brightness || DEFAULTS.brightness));
    p.contrast = Math.min(150, Math.max(50, p.contrast || DEFAULTS.contrast));
    p.measure = Math.min(200, Math.max(30, p.measure || DEFAULTS.measure)); // 与 measureNum 控件上限一致（评审 M5）
    p.fontSize = Math.min(20, Math.max(14, p.fontSize || DEFAULTS.fontSize));
    p.lineHeight = Math.min(2.2, Math.max(1.4, p.lineHeight || DEFAULTS.lineHeight));
    return p;
  } catch {
    return { ...DEFAULTS };
  }
}

function savePrefs(p: Prefs): void {
  cache = p; // 缓存同步（捕获层高频读取）
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* 隐私模式等写不进时静默，界面仍按当次选择生效 */
  }
}

/** '' / 未知键 / 空自定义 → null（移除内联变量，跟随风格）。 */
const resolveStack = (key: string, custom: string, stacks: Record<string, string>): string | null =>
  key === 'custom' ? custom.trim() || null : (stacks[key] ?? null);

export function applyPrefs(p: Prefs = loadPrefs()): void {
  const root = document.documentElement;
  root.dataset.theme = p.theme;
  root.dataset.style = p.style;
  root.dataset.indent = p.indent; // CSS 只认 render；write 的文本变换由 state 层处理
  root.dataset.gutter = p.gutter ? 'on' : 'off';
  root.dataset.guides = p.guideLines && p.style === 'humanist' ? 'on' : 'off';
  root.dataset.progress = p.progress;
  root.dataset.lighting = p.brightness === 100 && p.contrast === 100 ? 'off' : 'on'; // 中性值不挂滤镜（评审 m1）
  root.dataset.microHanging = p.micro.hanging ? 'on' : 'off';
  root.dataset.microAutospace = p.micro.autospace ? 'on' : 'off';
  root.dataset.microSpacingtrim = p.micro.spacingTrim ? 'on' : 'off';
  root.dataset.microWrap = p.micro.textWrap ? 'on' : 'off';
  root.dataset.otTnum = p.micro.tnum ? 'on' : 'off';
  root.dataset.otOnum = p.micro.onum ? 'on' : 'off';
  const st = root.style;
  st.setProperty('--font-size', `${p.fontSize}px`);
  st.setProperty('--line-height', String(p.lineHeight));
  st.setProperty('--measure', `${p.measure}rem`);
  st.setProperty('--align', p.justify ? 'justify' : 'start');
  st.setProperty('--font-weight', String(p.fontWeight));
  st.setProperty('--bright', String(p.brightness / 100));
  st.setProperty('--contrast', String(p.contrast / 100));
  const cjk = resolveStack(p.cjk, p.cjkCustom, CJK_STACKS);
  const latin = resolveStack(p.latin, p.latinCustom, LATIN_STACKS);
  if (cjk) st.setProperty('--font-cjk', cjk);
  else st.removeProperty('--font-cjk');
  if (latin) st.setProperty('--font-latin', latin);
  else st.removeProperty('--font-latin');
}

/** 偏好变更订阅（main 据此同步 state 层的缩进写入开关）。 */
const prefListeners = new Set<(p: Prefs) => void>();
export function onPrefsChange(cb: (p: Prefs) => void): void {
  prefListeners.add(cb);
}
const emitPrefs = (p: Prefs): void => prefListeners.forEach((f) => f(p));
// currentPrefs 走模块级缓存（捕获层每击键都读，评审 m2）；写入点同步失效
let cache: Prefs | null = null;
export const currentPrefs = (): Prefs => (cache ??= loadPrefs());

let mounted = false;

export function mountSettings(): void {
  if (mounted) return; // 幂等：集成代理与顶栏按钮可能重复触发
  mounted = true;
  const host = document.getElementById('popover');
  if (!host) return;

  const seg = (name: string, opts: readonly (readonly [string, string])[]): string =>
    `<span class="seg">${opts
      .map(([v, label]) => `<label><input type="radio" name="${name}" value="${v}"><span>${label}</span></label>`)
      .join('')}</span>`;

  const backdrop = document.createElement('div');
  backdrop.className = 'floater-backdrop';
  backdrop.hidden = true;
  backdrop.innerHTML = `
  <div class="floater-modal settings-modal" role="dialog" aria-label="${S.settingsTitle}">
    <div class="floater-title">${S.settingsTitle}<button class="icon-btn" data-x="close" title="${S.close}">✕</button></div>
    <div class="set-row"><span class="set-label">${S.setTheme}</span><span class="set-ctl">${seg('theme', [['night', S.themeNight], ['marble', S.themeMarble], ['paper', S.themePaper]])}</span></div>
    <div class="set-row"><span class="set-label">${S.setStyle}</span><span class="set-ctl">${seg('style', [['geek', S.styleGeek], ['humanist', S.styleHumanist]])}</span></div>
    <div class="set-row"><span class="set-label">${S.setFontSize}</span><span class="set-ctl"><input type="range" name="fontSize" min="14" max="20" step="1"><output data-for="fontSize"></output></span></div>
    <div class="set-row"><span class="set-label">${S.setFontWeight}</span><span class="set-ctl"><input type="range" name="fontWeight" min="300" max="700" step="20"><output data-for="fontWeight"></output><input type="number" name="fontWeightNum" class="txt num" min="100" max="900" step="10" hidden><span class="set-hint" data-for="fontWeightNum" hidden>${S.freeNumHint}</span></span></div>
    <div class="set-row"><span class="set-label">${S.setLineHeight}</span><span class="set-ctl"><input type="range" name="lineHeight" min="1.4" max="2.2" step="0.05"><output data-for="lineHeight"></output></span></div>
    <div class="set-row"><span class="set-label">${S.setMeasure}</span><span class="set-ctl"><input type="range" name="measure" min="30" max="60" step="1"><output data-for="measure"></output><input type="number" name="measureNum" class="txt num" min="30" max="200" step="2" hidden><span class="set-hint" data-for="measureNum" hidden>${S.freeNumHint}</span></span></div>
    <div class="set-row"><span class="set-label">${S.setBrightness}</span><span class="set-ctl"><input type="range" name="brightness" min="50" max="150" step="5"><output data-for="brightness"></output></span></div>
    <div class="set-row"><span class="set-label">${S.setContrast}</span><span class="set-ctl"><input type="range" name="contrast" min="50" max="150" step="5"><output data-for="contrast"></output></span></div>
    <div class="set-row"><span class="set-label">${S.setJustify}</span><span class="set-ctl"><input type="checkbox" name="justify"></span></div>
    <div class="set-row"><span class="set-label">${S.setGuideLines}</span><span class="set-ctl"><input type="checkbox" name="guideLines"></span></div>
    <div class="set-row"><span class="set-label">${S.setProgress}</span><span class="set-ctl">${seg('progress', [['bar', S.progressBar], ['map', S.progressMap], ['off', S.progressOff]])}</span></div>
    <div class="set-row"><span class="set-label">${S.setIndent}</span><span class="set-ctl">${seg('indent', [['off', S.indentOff], ['render', S.indentRender], ['write', S.indentWrite]])}</span></div>
    <div class="set-row"><span class="set-label">${S.setGutter}</span><span class="set-ctl"><input type="checkbox" name="gutter"></span></div>
    <div class="set-row sc-head"><span class="set-label">${S.setMicro}</span><span class="set-hint">${S.microHint}</span></div>
    <div class="set-row"><span class="set-label">${S.microHanging}</span><span class="set-ctl"><input type="checkbox" name="microHanging"></span></div>
    <div class="set-row"><span class="set-label">${S.microAutospace}</span><span class="set-ctl"><input type="checkbox" name="microAutospace"></span></div>
    <div class="set-row"><span class="set-label">${S.microSpacingTrim}</span><span class="set-ctl"><input type="checkbox" name="microSpacingTrim"></span></div>
    <div class="set-row"><span class="set-label">${S.microTextWrap}</span><span class="set-ctl"><input type="checkbox" name="microTextWrap"></span></div>
    <div class="set-row"><span class="set-label">${S.microTnum}</span><span class="set-ctl"><input type="checkbox" name="microTnum"></span></div>
    <div class="set-row"><span class="set-label">${S.microOnum}</span><span class="set-ctl"><input type="checkbox" name="microOnum"></span></div>
    <div class="set-row sc-head"><span class="set-label">${S.setShortcuts}</span><span class="set-hint">${S.scHint}</span></div>
    ${(Object.keys(SC_LABEL) as ScAction[])
      .map(
        (a) =>
          `<div class="set-row sc-row"><span class="set-label">${SC_LABEL[a]}</span><span class="set-ctl"><input class="txt sc-key" data-sc="${a}" readonly placeholder="${SC_DEFAULT[a]}"></span></div>`,
      )
      .join('')}
    <div class="set-row"><span class="set-label">${S.setFontCjk}</span><span class="set-ctl">
      <select name="cjk" class="txt">
        <option value="">${S.fontFollow}</option>
        <option value="hei">${S.fontCjkHei}</option>
        <option value="song">${S.fontCjkSong}</option>
        <option value="kai">${S.fontCjkKai}</option>
        <option value="custom">${S.fontCustom}</option>
      </select><input type="text" name="cjkCustom" class="txt" placeholder="${S.fontCustomPh}"></span></div>
    <div class="set-row"><span class="set-label">${S.setFontLatin}</span><span class="set-ctl">
      <select name="latin" class="txt">
        <option value="">${S.fontFollow}</option>
        <option value="sans">${S.fontLatinSans}</option>
        <option value="serif">${S.fontLatinSerif}</option>
        <option value="mono">${S.fontLatinMono}</option>
        <option value="custom">${S.fontCustom}</option>
      </select><input type="text" name="latinCustom" class="txt" placeholder="${S.fontCustomPh}"></span></div>
    <div class="set-row"><span class="set-label">${S.setDirPrefix}</span><span class="set-ctl"><input type="text" name="dirPrefix" class="txt" placeholder="${S.dirPrefixPh}"></span></div>
    <div class="set-foot">
      <button class="btn" data-x="reset">${S.resetPrefs}</button>
      <a href="${S.feedback}" target="_blank" rel="noreferrer">${S.feedbackLabel} · kaile9</a>
    </div>
  </div>`;
  host.append(backdrop);

  const q = <T extends HTMLElement>(sel: string): T => {
    const el = backdrop.querySelector<T>(sel);
    if (!el) throw new Error(`settings 缺少控件: ${sel}`);
    return el;
  };

  const readForm = (): Prefs => ({
    theme: q<HTMLInputElement>('input[name="theme"]:checked').value as Prefs['theme'],
    style: q<HTMLInputElement>('input[name="style"]:checked').value as Prefs['style'],
    fontSize: Number(q<HTMLInputElement>('input[name="fontSize"]').value),
    lineHeight: Number(q<HTMLInputElement>('input[name="lineHeight"]').value),
    measure: numOr('measureNum', q<HTMLInputElement>('input[name="measure"]')),
    justify: q<HTMLInputElement>('input[name="justify"]').checked,
    fontWeight: numOr('fontWeightNum', q<HTMLInputElement>('input[name="fontWeight"]')),
    brightness: Number(q<HTMLInputElement>('input[name="brightness"]').value),
    contrast: Number(q<HTMLInputElement>('input[name="contrast"]').value),
    guideLines: q<HTMLInputElement>('input[name="guideLines"]').checked,
    progress: (q<HTMLInputElement>('input[name="progress"]:checked')?.value ?? 'bar') as Prefs['progress'],
    indent: (q<HTMLInputElement>('input[name="indent"]:checked')?.value ?? 'off') as Prefs['indent'],
    gutter: q<HTMLInputElement>('input[name="gutter"]').checked,
    cjk: q<HTMLSelectElement>('select[name="cjk"]').value,
    latin: q<HTMLSelectElement>('select[name="latin"]').value,
    cjkCustom: q<HTMLInputElement>('input[name="cjkCustom"]').value,
    latinCustom: q<HTMLInputElement>('input[name="latinCustom"]').value,
    dirPrefix: q<HTMLInputElement>('input[name="dirPrefix"]').value.trim(),
    shortcuts: readShortcuts(),
    micro: {
      hanging: q<HTMLInputElement>('input[name="microHanging"]').checked,
      autospace: q<HTMLInputElement>('input[name="microAutospace"]').checked,
      spacingTrim: q<HTMLInputElement>('input[name="microSpacingTrim"]').checked,
      textWrap: q<HTMLInputElement>('input[name="microTextWrap"]').checked,
      tnum: q<HTMLInputElement>('input[name="microTnum"]').checked,
      onum: q<HTMLInputElement>('input[name="microOnum"]').checked,
    },
  });

  /** 快捷键覆盖表：只收与默认不同的值。 */
  const readShortcuts = (): Record<string, string> => {
    const out: Record<string, string> = {};
    backdrop.querySelectorAll<HTMLInputElement>('input.sc-key').forEach((el) => {
      const a = el.dataset.sc as ScAction;
      if (a && el.value && el.value !== SC_DEFAULT[a]) out[a] = el.value;
    });
    return out;
  };

  /** 滑杆拖满后出现数字输入（可输任意值）；输入有值时以输入为准。 */
  const numOr = (num: string, range: HTMLInputElement): number => {
    const n = q<HTMLInputElement>(`input[name="${num}"]`);
    return !n.hidden && n.value !== '' ? Number(n.value) : Number(range.value);
  };

  const syncAux = (p: Prefs): void => {
    q<HTMLOutputElement>('output[data-for="fontSize"]').value = `${p.fontSize} px`;
    q<HTMLOutputElement>('output[data-for="lineHeight"]').value = p.lineHeight.toFixed(2);
    q<HTMLOutputElement>('output[data-for="measure"]').value = `${p.measure} rem`;
    q<HTMLOutputElement>('output[data-for="fontWeight"]').value = String(p.fontWeight);
    q<HTMLOutputElement>('output[data-for="brightness"]').value = `${p.brightness}%`;
    q<HTMLOutputElement>('output[data-for="contrast"]').value = `${p.contrast}%`;
    // 滑杆满档或当前值超档 → 展开数字输入
    const wNum = q<HTMLInputElement>('input[name="fontWeightNum"]');
    const wShow = Number(q<HTMLInputElement>('input[name="fontWeight"]').value) >= 700 || p.fontWeight > 700;
    wNum.hidden = !wShow;
    q<HTMLElement>('[data-for="fontWeightNum"]').hidden = !wShow;
    if (wShow && document.activeElement !== wNum) wNum.value = String(p.fontWeight);
    const mNum = q<HTMLInputElement>('input[name="measureNum"]');
    const mShow = Number(q<HTMLInputElement>('input[name="measure"]').value) >= 60 || p.measure > 60;
    mNum.hidden = !mShow;
    q<HTMLElement>('[data-for="measureNum"]').hidden = !mShow;
    if (mShow && document.activeElement !== mNum) mNum.value = String(p.measure);
    q<HTMLInputElement>('input[name="cjkCustom"]').hidden = p.cjk !== 'custom';
    q<HTMLInputElement>('input[name="latinCustom"]').hidden = p.latin !== 'custom';
  };

  const syncForm = (p: Prefs): void => {
    q<HTMLInputElement>(`input[name="theme"][value="${p.theme}"]`).checked = true;
    q<HTMLInputElement>(`input[name="style"][value="${p.style}"]`).checked = true;
    q<HTMLInputElement>('input[name="fontSize"]').value = String(p.fontSize);
    q<HTMLInputElement>('input[name="lineHeight"]').value = String(p.lineHeight);
    q<HTMLInputElement>('input[name="measure"]').value = String(Math.min(60, p.measure));
    q<HTMLInputElement>('input[name="justify"]').checked = p.justify;
    q<HTMLInputElement>('input[name="fontWeight"]').value = String(Math.min(700, p.fontWeight));
    q<HTMLInputElement>('input[name="brightness"]').value = String(p.brightness);
    q<HTMLInputElement>('input[name="contrast"]').value = String(p.contrast);
    q<HTMLInputElement>('input[name="guideLines"]').checked = p.guideLines;
    const prog = q<HTMLInputElement>(`input[name="progress"][value="${p.progress}"]`);
    if (prog) prog.checked = true;
    const ind = q<HTMLInputElement>(`input[name="indent"][value="${p.indent}"]`);
    if (ind) ind.checked = true;
    q<HTMLInputElement>('input[name="gutter"]').checked = p.gutter;
    q<HTMLSelectElement>('select[name="cjk"]').value = p.cjk;
    q<HTMLSelectElement>('select[name="latin"]').value = p.latin;
    q<HTMLInputElement>('input[name="cjkCustom"]').value = p.cjkCustom;
    q<HTMLInputElement>('input[name="latinCustom"]').value = p.latinCustom;
    q<HTMLInputElement>('input[name="dirPrefix"]').value = p.dirPrefix;
    q<HTMLInputElement>('input[name="microHanging"]').checked = p.micro.hanging;
    q<HTMLInputElement>('input[name="microAutospace"]').checked = p.micro.autospace;
    q<HTMLInputElement>('input[name="microSpacingTrim"]').checked = p.micro.spacingTrim;
    q<HTMLInputElement>('input[name="microTextWrap"]').checked = p.micro.textWrap;
    q<HTMLInputElement>('input[name="microTnum"]').checked = p.micro.tnum;
    q<HTMLInputElement>('input[name="microOnum"]').checked = p.micro.onum;
    backdrop.querySelectorAll<HTMLInputElement>('input.sc-key').forEach((el) => {
      const a = el.dataset.sc as ScAction;
      el.value = p.shortcuts[a] ?? SC_DEFAULT[a];
    });
    syncAux(p);
  };

  const close = (): void => {
    backdrop.hidden = true;
  };
  const open = (): void => {
    syncForm(loadPrefs());
    backdrop.hidden = false;
  };

  const onInput = (ev?: Event): void => {
    // 滑杆是事件源时清空对应数字框（否则数字框恒优先，滑杆永久失控，评审 M1）
    const t = ev?.target as HTMLInputElement | null;
    if (t?.type === 'range') {
      if (t.name === 'fontWeight') q<HTMLInputElement>('input[name="fontWeightNum"]').value = '';
      if (t.name === 'measure') q<HTMLInputElement>('input[name="measureNum"]').value = '';
    }
    const p = readForm();
    savePrefs(p);
    applyPrefs(p); // 直传当次选择：写不进 storage（隐私模式）时界面仍生效
    syncAux(p);
    emitPrefs(p);
  };
  backdrop.addEventListener('input', (ev) => onInput(ev));
  backdrop.addEventListener('change', (ev) => onInput(ev)); // select/旧浏览器兜底
  backdrop.querySelectorAll<HTMLInputElement>('input.sc-key').forEach((el) => {
    el.addEventListener('keydown', (ev) => {
      if (captureCombo(el, ev) !== null) onInput(); // 捕获到完整组合即保存
    });
  });

  backdrop.addEventListener('click', ev => {
    if (ev.target === backdrop) {
      close();
      return;
    }
    const t = (ev.target as HTMLElement).closest('[data-x]') as HTMLElement | null;
    if (!t) return;
    if (t.dataset.x === 'close') close();
    if (t.dataset.x === 'reset') {
      try {
        localStorage.removeItem(KEY);
      } catch {
        /* 同上，静默 */
      }
      cache = null; // 缓存失效
      const p = loadPrefs();
      syncForm(p);
      applyPrefs();
      emitPrefs(p);
    }
  });

  document.getElementById('settings-btn')?.addEventListener('click', open);
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && !backdrop.hidden) close();
  });

  syncForm(loadPrefs());
  applyPrefs();
}
