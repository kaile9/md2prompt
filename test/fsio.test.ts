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

test('save-as 写入失败时返回 false，不把未写成的句柄采纳为自动保存目标', async () => {
  let attempts = 0;
  const states: string[] = [];
  const broken = {
    name: 'broken.md',
    async createWritable() {
      attempts++;
      throw new Error('disk denied');
    },
  };
  const original = (globalThis as any).window;
  (globalThis as any).window = {
    showOpenFilePicker: async () => [],
    showSaveFilePicker: async () => broken,
  };

  try {
    const fs = await import('../src/core/fsio.ts?save-as-failure');
    fs.onSaveState((state) => states.push(state));
    expect(await fs.saveDocAs('must persist')).toBe(false);
    await fs.saveDoc('must not target broken handle');
    expect(attempts).toBe(1);
    expect(states).toEqual(['saving', 'failed']);
  } finally {
    if (original === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = original;
  }
});

test('较早的打开流程迟到时不能夺回较新文档的文件目标', async () => {
  const writes: Record<string, string[]> = { A: [], B: [] };
  let releaseA!: () => void;
  const permissionA = new Promise<PermissionState>(resolve => (releaseA = () => resolve('granted')));
  const makeHandle = (name: 'A' | 'B') => ({
    name: `${name}.md`,
    async queryPermission() { return name === 'A' ? permissionA : 'granted' as PermissionState; },
    async requestPermission() { return 'granted' as PermissionState; },
    async getFile() { return { text: async () => name, lastModified: 1 }; },
    async createWritable() {
      return { async write(text: string) { writes[name].push(text); }, async close() {} };
    },
  });
  const handles = [makeHandle('A'), makeHandle('B')];
  let selected = 0;
  const original = (globalThis as any).window;
  (globalThis as any).window = { showOpenFilePicker: async () => [handles[selected++] as any] };

  try {
    const fs = await import('../src/core/fsio.ts?stale-open-target');
    const stale = fs.openDoc();
    await Bun.sleep(0);
    const latest = await fs.openDoc();
    expect(latest?.name).toBe('B.md');
    releaseA();
    expect(await stale).toBeNull();
    await fs.saveDoc('belongs-to-B');
    expect(writes).toEqual({ A: [], B: ['belongs-to-B'] });
  } finally {
    if (original === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = original;
  }
});

test('旧文档慢写与 save-as 选择同一路径时，新文档最终提交不被覆盖', async () => {
  let disk = '';
  let releaseOld!: () => void;
  const oldGate = new Promise<void>(resolve => (releaseOld = resolve));
  let created = 0;
  const handle = {
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
          if (order === 1) await oldGate;
          disk = buffer;
        },
      };
    },
  };
  const original = (globalThis as any).window;
  (globalThis as any).window = {
    showOpenFilePicker: async () => [handle],
    showSaveFilePicker: async () => handle,
  };

  try {
    const fs = await import('../src/core/fsio.ts?save-as-after-old-write');
    await fs.openDoc();
    const oldWrite = fs.saveDoc('old-final');
    await Bun.sleep(850);
    fs.resetDoc();
    const newWrite = fs.saveDocAs('new-final');
    await Bun.sleep(50);
    releaseOld();
    await Promise.all([oldWrite, newWrite]);
    expect(disk).toBe('new-final');
  } finally {
    if (original === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = original;
  }
});

test('文档与 Prompt 别名到同一物理文件时也按调用顺序提交', async () => {
  let disk = '';
  let releaseDoc!: () => void;
  const docGate = new Promise<void>(resolve => (releaseDoc = resolve));
  let created = 0;
  const handle = {
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
          if (order === 1) await docGate;
          disk = buffer;
        },
      };
    },
  };
  const dir = { async getFileHandle() { return handle; } };
  const original = (globalThis as any).window;
  (globalThis as any).window = {
    showOpenFilePicker: async () => [handle],
    showDirectoryPicker: async () => dir,
  };

  try {
    const fs = await import('../src/core/fsio.ts?cross-channel-alias');
    await fs.openDoc();
    const docWrite = fs.saveDoc('doc-old');
    await Bun.sleep(850);
    const promptWrite = fs.writePrompt('prompt-new');
    await Bun.sleep(850);
    releaseDoc();
    await Promise.all([docWrite, promptWrite]);
    expect(disk).toBe('prompt-new');
  } finally {
    if (original === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = original;
  }
});

test('Prompt 写入已排队但尚未执行时可以按目标取消', async () => {
  const promptWrites: string[] = [];
  let releaseDoc!: () => void;
  const docGate = new Promise<void>(resolve => (releaseDoc = resolve));
  const doc = {
    name: 'a.md',
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async getFile() { return { text: async () => '', lastModified: 1 }; },
    async createWritable() {
      let buffer = '';
      return {
        async write(text: string) { buffer = text; },
        async close() { await docGate; void buffer; },
      };
    },
  };
  const prompt = {
    async createWritable() {
      return { async write(text: string) { promptWrites.push(text); }, async close() {} };
    },
  };
  const dir = { async getFileHandle() { return prompt; } };
  const original = (globalThis as any).window;
  (globalThis as any).window = {
    showOpenFilePicker: async () => [doc],
    showDirectoryPicker: async () => dir,
  };

  try {
    const fs = await import('../src/core/fsio.ts?cancel-queued-prompt');
    await fs.openDoc();
    const docWrite = fs.saveDoc('block');
    await Bun.sleep(850);
    const target = fs.capturePromptTarget();
    expect(target).not.toBeNull();
    const promptWrite = fs.writePrompt('must-not-land', target);
    await Bun.sleep(850);
    fs.cancelPrompt(target!);
    releaseDoc();
    await Promise.all([docWrite, promptWrite]);
    expect(promptWrites).toEqual([]);
  } finally {
    if (original === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = original;
  }
});

test('同名 Prompt 不存在与读取失败必须分流，读取失败不能伪装成可新建', async () => {
  let mode: 'missing' | 'failed' = 'missing';
  const file = {
    name: 'a.md',
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async getFile() { return { text: async () => '', lastModified: 1 }; },
    async createWritable() { return { async write() {}, async close() {} }; },
  };
  const dir = {
    async getFileHandle() {
      if (mode === 'missing') throw Object.assign(new Error('absent'), { name: 'NotFoundError' });
      throw new Error('prompt read failed');
    },
  };
  const original = (globalThis as any).window;
  (globalThis as any).window = {
    showOpenFilePicker: async () => [file],
    showDirectoryPicker: async () => dir,
  };

  try {
    const fs = await import('../src/core/fsio.ts?sibling-read-errors');
    await fs.openDoc();
    expect(await fs.findSiblingPrompt('a.md')).toBeNull();
    mode = 'failed';
    await expect(fs.findSiblingPrompt('a.md')).rejects.toThrow('prompt read failed');
  } finally {
    if (original === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = original;
  }
});

test('save-as 触发跨通道 flush 时仍按请求先后提交，取消选择器不暴露倒序结果', async () => {
  let disk = '';
  const handle = {
    name: 'same.md',
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async getFile() { return { text: async () => disk, lastModified: 1 }; },
    async createWritable() {
      let buffer = '';
      return {
        async write(text: string) { buffer = text; },
        async close() { disk = buffer; },
      };
    },
  };
  const dir = { async getFileHandle() { return handle; } };
  const original = (globalThis as any).window;
  (globalThis as any).window = {
    showOpenFilePicker: async () => [handle],
    showDirectoryPicker: async () => dir,
    showSaveFilePicker: async () => { throw new Error('cancelled'); },
  };

  try {
    const fs = await import('../src/core/fsio.ts?flush-request-order');
    await fs.openDoc();
    const older = fs.writePrompt('prompt-old');
    const newer = fs.saveDoc('doc-new');
    expect(await fs.saveDocAs('unused')).toBe(false);
    await Promise.all([older, newer]);
    expect(disk).toBe('doc-new');
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
