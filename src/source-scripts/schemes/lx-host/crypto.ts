/**
 * LX 脚本宿主的 crypto/buffer 工具（纯 TS，无 eval、无 Node 依赖、CSP 安全）。
 *
 * 依赖面按已 vendor 脚本实测收敛（见 lx-host/sources.ts 注释）：
 * - md5：复用 platforms/kg-md5（v6 签名、stellarwave/墨澜 eapi 摘要用）；
 * - aesEncrypt：stellarwave/墨澜 的网易 eapi 需要 aes-128-ecb（PKCS7）；
 *   实现覆盖 ECB/CBC × 128/192/256，返回 Uint8Array（脚本侧再 buf2hex）；
 * - rsaEncrypt：脚本只在「配置上报」类路径调用，返回空串即可；
 * - buffer：LX 协议的 utils.buffer（from/bufToString，utf8/hex/base64），
 *   stellarwave/墨澜 的 buf2hex 走 bufToString(buffer, "hex")。
 *
 * AES 实现正确性由 NIST SP 800-38A 向量测试保证（tests/lx-host.test.ts）。
 */

/** AES S-box（FIPS-197；由 FIPS 算法程序化生成校验，见 tests/lx-host.test.ts） */
export const SBOX = Uint8Array.from([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

/** GF(2^8) 乘 x（AES MixColumns 用） */
function xtime(a: number): number {
  return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
}

function gmul(a: number, b: number): number {
  let result = 0;
  let x = a;
  let y = b;
  while (y > 0) {
    if (y & 1) result ^= x;
    x = xtime(x);
    y >>= 1;
  }
  return result & 0xff;
}

/** 轮密钥扩展：key（16/24/32 字节）→ Nr+1 组 16 字节轮密钥（测试导出） */
export function expandKey(key: Uint8Array): Uint8Array[] {
  const nk = key.length / 4;
  const nr = nk + 6;
  const wordCount = 4 * (nr + 1);
  const words: Uint8Array[] = [];
  for (let i = 0; i < nk; i++) {
    words.push(key.slice(i * 4, i * 4 + 4));
  }
  let rcon = 1;
  for (let i = nk; i < wordCount; i++) {
    let temp = words[i - 1]!.slice();
    if (i % nk === 0) {
      temp = Uint8Array.from([SBOX[temp[1]!], SBOX[temp[2]!], SBOX[temp[3]!], SBOX[temp[0]!]]);
      temp[0] ^= rcon;
      rcon = xtime(rcon);
    } else if (nk > 6 && i % nk === 4) {
      temp = Uint8Array.from(temp.map((b) => SBOX[b]));
    }
    const prev = words[i - nk]!;
    words.push(Uint8Array.from(temp.map((b, j) => b ^ prev[j])));
  }
  const roundKeys: Uint8Array[] = [];
  for (let r = 0; r <= nr; r++) {
    const rk = new Uint8Array(16);
    for (let c = 0; c < 4; c++) {
      rk.set(words[r * 4 + c]!, c * 4);
    }
    roundKeys.push(rk);
  }
  return roundKeys;
}

/** 加密单个 16 字节块（原地写入 out） */
function encryptBlock(block: Uint8Array, roundKeys: Uint8Array[], out: Uint8Array): void {
  const state = block.slice();
  const nr = roundKeys.length - 1;
  // AddRoundKey(0)
  for (let i = 0; i < 16; i++) state[i] ^= roundKeys[0]![i];
  for (let round = 1; round <= nr; round++) {
    // SubBytes
    for (let i = 0; i < 16; i++) state[i] = SBOX[state[i]!];
    // ShiftRows（state 按列主序：r + 4c）
    let t = state[1]!;
    state[1] = state[5]!;
    state[5] = state[9]!;
    state[9] = state[13]!;
    state[13] = t;
    t = state[2]!;
    state[2] = state[10]!;
    state[10] = t;
    t = state[6]!;
    state[6] = state[14]!;
    state[14] = t;
    // 第 3 行左移 3（= 循环右移 1，但首位也要移走）
    t = state[15]!;
    state[15] = state[11]!;
    state[11] = state[7]!;
    state[7] = state[3]!;
    state[3] = t;
    // MixColumns（最后一轮跳过）
    if (round < nr) {
      for (let c = 0; c < 4; c++) {
        const o = c * 4;
        const a0 = state[o]!;
        const a1 = state[o + 1]!;
        const a2 = state[o + 2]!;
        const a3 = state[o + 3]!;
        state[o] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
        state[o + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
        state[o + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
        state[o + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
      }
    }
    // AddRoundKey
    const rk = roundKeys[round]!;
    for (let i = 0; i < 16; i++) state[i] ^= rk[i]!;
  }
  out.set(state);
}

function pkcs7Pad(data: Uint8Array): Uint8Array {
  const pad = 16 - (data.length % 16);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}

function toBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

/** AES-ECB/CBC 加密（PKCS7 填充）。mode 形如 "aes-128-ecb" / "aes-256-cbc"。 */
export function aesEncrypt(
  data: string | Uint8Array,
  mode: string,
  key: string | Uint8Array,
  iv?: string | Uint8Array,
): Uint8Array {
  const keyBytes = toBytes(key);
  const bits = keyBytes.length * 8;
  if (bits !== 128 && bits !== 192 && bits !== 256) {
    throw new Error("AES key 长度必须为 16/24/32 字节");
  }
  const wantCbc = /cbc/i.test(mode);
  if (!/ecb|cbc/i.test(mode) || !new RegExp("aes-(" + bits + ")", "i").test(mode)) {
    throw new Error("不支持的 AES 模式: " + mode + "（key 为 " + bits + " 位）");
  }
  const roundKeys = expandKey(keyBytes);
  const padded = pkcs7Pad(toBytes(data));
  const out = new Uint8Array(padded.length);
  let chain: Uint8Array | null = null;
  if (wantCbc) {
    if (iv === undefined || iv === null || iv === "") {
      throw new Error("CBC 模式需要 IV");
    }
    chain = toBytes(iv).slice(0, 16);
    if (chain.length < 16) {
      const fixed = new Uint8Array(16);
      fixed.set(chain);
      chain = fixed;
    }
  }
  const block = new Uint8Array(16);
  for (let offset = 0; offset < padded.length; offset += 16) {
    block.set(padded.subarray(offset, offset + 16));
    if (chain !== null) {
      for (let i = 0; i < 16; i++) block[i] ^= chain[i]!;
    }
    encryptBlock(block, roundKeys, out.subarray(offset, offset + 16));
    if (chain !== null) {
      chain = out.slice(offset, offset + 16);
    }
  }
  return out;
}

/** LX utils.buffer：字符串 → 字节（utf8） */
export function bufferFrom(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** LX utils.buffer：字节 → 字符串（utf8/hex/base64） */
export function bufferToString(buf: Uint8Array, encoding?: string): string {
  const enc = (encoding ?? "utf8").toLowerCase();
  if (enc === "hex") {
    let out = "";
    for (const b of buf) out += b.toString(16).padStart(2, "0");
    return out;
  }
  if (enc === "base64") {
    let binary = "";
    for (const b of buf) binary += String.fromCharCode(b);
    if (typeof btoa === "function") return btoa(binary);
    return BufferPolyBase64(binary);
  }
  return new TextDecoder().decode(buf);
}

/** btoa 不可用时（非浏览器环境）的兜底 base64 */
function BufferPolyBase64(binary: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < binary.length; i += 3) {
    const b0 = binary.charCodeAt(i);
    const b1 = binary.charCodeAt(i + 1);
    const b2 = binary.charCodeAt(i + 2);
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | ((isNaN(b1) ? 0 : b1) >> 4)];
    out += isNaN(b1) ? "=" : chars[((b1 & 15) << 2) | ((isNaN(b2) ? 0 : b2) >> 6)];
    out += isNaN(b2) ? "=" : chars[b2 & 63];
  }
  return out;
}
