import { describe, expect, test } from 'bun:test';
import { joinPath, promptName } from '../src/core/fsio';

describe('joinPath（目录前缀 + 文件名 → 完整路径，v1.5）', () => {
  test('空前缀原样返回文件名', () => {
    expect(joinPath('', 'a.md')).toBe('a.md');
  });

  test('Windows 反斜杠拼接；前缀尾部斜杠去重；分隔符跟随前缀风格', () => {
    expect(joinPath('C:\\Users\\me\\docs', 'a.md')).toBe('C:\\Users\\me\\docs\\a.md');
    expect(joinPath('C:\\Users\\me\\docs\\', 'a.md')).toBe('C:\\Users\\me\\docs\\a.md');
    expect(joinPath('C:/Users/me/docs/', 'a.md')).toBe('C:/Users/me/docs/a.md');
    expect(joinPath('D:\\\\', 'a.md')).toBe('D:\\a.md');
  });
});

describe('promptName（日记文件名）', () => {
  test('仅剥最后一段扩展名；点文件保留全名', () => {
    expect(promptName('a.md')).toBe('a.prompt.md');
    expect(promptName('a.b.md')).toBe('a.b.prompt.md');
    expect(promptName('.hidden')).toBe('.hidden.prompt.md');
  });
});

test('save-as 等待选择器期间的输入写入所选文件，而不是调用时旧快照', async () => {
  let choose!: (handle: any) => void;
  const picker = new Promise<any>(resolve => (choose = resolve));
  let disk = '';
  const handle = {
    name: 'new.md',
    async createWritable() {
      let buffer = '';
      return {
        async write(text: string) { buffer = text; },
        async close() { disk = buffer; },
      };
    },
  };
  const original = (globalThis as any).window;
  (globalThis as any).window = {
    showOpenFilePicker: async () => [],
    showSaveFilePicker: async () => picker,
  };

  try {
    const fs = await import('../src/core/fsio.ts?save-as-latest');
    const saving = fs.saveDocAs('');
    await fs.saveDoc('typed while choosing');
    choose(handle);
    expect(await saving).toBe(true);
    expect(disk).toBe('typed while choosing');
  } finally {
    if (original === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = original;
  }
});

test('同一目标的写入串行提交，慢旧写不能在快新写之后覆盖文件', async () => {
  let disk = '';
  let created = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => (releaseFirst = resolve));
  const handle = {
    name: 'a.md',
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async getFile() { return { text: async () => '', lastModified: 1 }; },
    async createWritable() {
      const order = ++created;
      let buffer = '';
      return {
        async write(text: string) { buffer = text; },
        async close() {
          if (order === 1) await firstGate;
          disk = buffer;
        },
      };
    },
  };
  const original = (globalThis as any).window;
  (globalThis as any).window = { showOpenFilePicker: async () => [handle] };

  try {
    const fs = await import('../src/core/fsio.ts?serial-writes');
    await fs.openDoc();
    const oldWrite = fs.saveDoc('old');
    await Bun.sleep(850);
    const newWrite = fs.saveDoc('new');
    await Bun.sleep(850);
    releaseFirst();
    await Promise.all([oldWrite, newWrite]);
    expect(created).toBe(2);
    expect(disk).toBe('new');
  } finally {
    if (original === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = original;
  }
});

test('同一磁盘文件的不同句柄对象也共享提交顺序', async () => {
  let disk = '';
  let created = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => (releaseFirst = resolve));
  const makeHandle = () => ({
    name: 'same.md',
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async getFile() { return { text: async () => disk, lastModified: 1 }; },
    async createWritable() {
      const order = ++created;
      let buffer = '';
      return {
        async write(text: string) { buffer = text; },
        async close() {
          if (order === 1) await firstGate;
          disk = buffer;
        },
      };
    },
  });
  const handles = [makeHandle(), makeHandle()];
  let selected = 0;
  const original = (globalThis as any).window;
  (globalThis as any).window = { showOpenFilePicker: async () => [handles[selected++]] };

  try {
    const fs = await import('../src/core/fsio.ts?aliased-handles');
    await fs.openDoc();
    const oldWrite = fs.saveDoc('old');
    await Bun.sleep(850);
    await fs.openDoc();
    const newWrite = fs.saveDoc('new');
    await Bun.sleep(850);
    releaseFirst();
    await Promise.all([oldWrite, newWrite]);
    expect(created).toBe(2);
    expect(disk).toBe('new');
  } finally {
    if (original === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = original;
  }
});

test('文档与 Prompt 的防抖写入按调用时目标隔离，不把 A 的尾写吞进 B', async () => {
  const fileWrites: Record<string, string[]> = { A: [], B: [] };
  const promptWrites: Record<string, string[]> = { A: [], B: [] };
  const writable = (sink: string[]) => ({
    async write(text: string) { sink.push(text); },
    async close() {},
  });
  const files = ['A', 'B'].map((name) => ({
    name: `${name}.md`,
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async getFile() { return { text: async () => name, lastModified: 1 }; },
    async createWritable() { return writable(fileWrites[name]); },
  }));
  const dirs = ['A', 'B'].map((name) => ({
    async getFileHandle() {
      return { async createWritable() { return writable(promptWrites[name]); } };
    },
  }));
  let fileIndex = 0;
  let dirIndex = 0;
  const original = (globalThis as any).window;
  (globalThis as any).window = {
    showOpenFilePicker: async () => [files[fileIndex++]],
    showDirectoryPicker: async () => dirs[dirIndex++],
  };

  try {
    const fs = await import('../src/core/fsio.ts?cross-doc-targets');
    await fs.openDoc();
    const a = [fs.saveDoc('A-final'), fs.writePrompt('A-prompt')];
    await fs.openDoc();
    const b = [fs.saveDoc('B-final'), fs.writePrompt('B-prompt')];
    await Promise.all([...a, ...b]);
    expect(fileWrites).toEqual({ A: ['A-final'], B: ['B-final'] });
    expect(promptWrites).toEqual({ A: ['A-prompt'], B: ['B-prompt'] });
  } finally {
    if (original === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = original;
  }
});
