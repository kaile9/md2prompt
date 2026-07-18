// test/hash.test.ts — §3 规则 5：前缀、确定性、与 @noble/hashes 直算一致、>8MB 分块等价。
import { test, expect } from 'bun:test';
import { blake3 } from '@noble/hashes/blake3.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { hashText } from '../src/core/hash';

test('默认 BLAKE3：带前缀，与库直算一致', async () => {
  const s = '协议即产品 §3 — md2prompt/1\n'.repeat(500);
  const h = await hashText(s);
  expect(h).toStartWith('blake3:');
  expect(h).toBe(`blake3:${bytesToHex(blake3(utf8ToBytes(s)))}`);
});

test('sha3-256 备选：带前缀，与库直算一致', async () => {
  const s = 'hello 世界';
  const h = await hashText(s, 'sha3-256');
  expect(h).toStartWith('sha3-256:');
  expect(h).toBe(`sha3-256:${bytesToHex(sha3_256(utf8ToBytes(s)))}`);
});

test('同文同 hash；异文异 hash；空串可算', async () => {
  expect(await hashText('同一份文本')).toBe(await hashText('同一份文本'));
  expect(await hashText('甲')).not.toBe(await hashText('乙'));
  expect(await hashText('')).toBe(`blake3:${bytesToHex(blake3(utf8ToBytes('')))}`);
});

test('>8MB 分块异步：结果与一次性计算逐字节一致', async () => {
  // 多字节字符混合，验证按字节切片不截断 UTF-8 序列（先整体编码再切）
  const big = '汉字x🙂'.repeat(800 * 1024); // 约 8.8MB UTF-8，恰好越过分块阈值
  const expectHex = bytesToHex(blake3(utf8ToBytes(big)));
  expect(await hashText(big)).toBe(`blake3:${expectHex}`);
  expect(await hashText(big, 'sha3-256')).toBe(`sha3-256:${bytesToHex(sha3_256(utf8ToBytes(big)))}`);
});
