// SPDX-License-Identifier: MPL-2.0
/** §3 规则 5：默认 BLAKE3（blake3: 前缀），解析器也接受 sha3-256:；大字符串分块异步。
 *  @noble/hashes v2 仅在带 .js 的子路径导出（exports map 无裸子路径键）。 */
import { blake3 } from '@noble/hashes/blake3.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export type HashAlgo = 'blake3' | 'sha3-256';

const CHUNK = 1 * 1024 * 1024; // 1MB：超过则分块，每片后让出主线程（SPEC §3 规则 5）

const yieldMacrotask = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 返回带前缀的哈希串，如 'blake3:9f3ac2…'。 */
export async function hashText(text: string, algo: HashAlgo = 'blake3'): Promise<string> {
  const bytes = utf8ToBytes(text);
  const h = algo === 'blake3' ? blake3.create() : sha3_256.create();
  if (bytes.length <= CHUNK) h.update(bytes);
  else
    for (let i = 0; i < bytes.length; i += CHUNK) {
      h.update(bytes.subarray(i, i + CHUNK));
      await yieldMacrotask();
    }
  return `${algo}:${bytesToHex(h.digest())}`;
}

/** 同步短哈希（patch after-hash 校验用；截断 16 hex，限小块文本——patch 只对块内句子级使用）。 */
export function hashShort(text: string): string {
  return `blake3:${bytesToHex(blake3(utf8ToBytes(text))).slice(0, 16)}`;
}
