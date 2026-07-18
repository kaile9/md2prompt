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
