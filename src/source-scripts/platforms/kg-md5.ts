/**
 * 酷狗移动端接口签名 MD5 —— 蓝本文件级移植。
 *
 * 逐段对照 qt-uniappx services/kg-sign.ts（原样搬入，MD5/签名逻辑一行不改，
 * 仅做 uts→ts 语法微调）：
 * - POW16/POW32/POW 查表 :13-22
 * - u32and/u32or/u32xor/u32not/u32add :24-54（16 位高低两半拆开的位运算）
 * - u32rotl :57-62 / S 左移位数表 :65-70 / K 常量表 :73-85
 * - utf8Bytes :88-105 / toHexLE :107-119
 * - md5Hex :122-186 / kgSignature :192-199
 *
 * 蓝本说明（保留原文）：为兼容 UTS/Vapor 字节码运行时，实现刻意避免 32 位
 * 有符号位运算与 `>>>`/BigInt：所有 32 位字都用 [0, 2^32) 的普通 number 表示，
 * 位运算按 16 位高低两半拆开做。本包运行在 PC 宿主 JS 引擎（ES2022），
 * 按契约（contract.ts「加密模块以原样文件搬入本包」）保留该写法，不做改写。
 */

const POW16 = 65536;
const POW32 = 4294967296;

// 2 的幂查表，替代 Math.pow，避免浮点误差
const POW: number[] = [
  1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768,
  65536, 131072, 262144, 524288, 1048576, 2097152, 4194304, 8388608, 16777216,
  33554432, 67108864, 134217728, 268435456, 536870912, 1073741824, 2147483648,
  4294967296,
];

function u32and(a: number, b: number): number {
  const ah = Math.floor(a / POW16);
  const al = a % POW16;
  const bh = Math.floor(b / POW16);
  const bl = b % POW16;
  return (ah & bh) * POW16 + (al & bl);
}

function u32or(a: number, b: number): number {
  const ah = Math.floor(a / POW16);
  const al = a % POW16;
  const bh = Math.floor(b / POW16);
  const bl = b % POW16;
  return (ah | bh) * POW16 + (al | bl);
}

function u32xor(a: number, b: number): number {
  const ah = Math.floor(a / POW16);
  const al = a % POW16;
  const bh = Math.floor(b / POW16);
  const bl = b % POW16;
  return (ah ^ bh) * POW16 + (al ^ bl);
}

function u32not(a: number): number {
  return 4294967295 - a;
}

function u32add(a: number, b: number): number {
  return (a + b) % POW32;
}

/** 32 位循环左移，n 取 1..31 */
function u32rotl(x: number, n: number): number {
  const p = POW[32 - n];
  const low = x % p;
  const high = Math.floor(x / p);
  return low * POW[n] + high;
}

// MD5 每轮左移位数
const S: number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// MD5 常量表 K[i] = floor(abs(sin(i+1)) * 2^32)，写死避免各平台 Math.sin 末位差异
const K: number[] = [
  3614090360, 3905402710, 606105819, 3250441966, 4118548399, 1200080426,
  2821735955, 4249261313, 1770035416, 2336552879, 4294925233, 2304563134,
  1804603682, 4254626195, 2792965006, 1236535329, 4129170786, 3225465664,
  643717713, 3921069994, 3593408605, 38016083, 3634488961, 3889429448,
  568446438, 3275163606, 4107603335, 1163531501, 2850285829, 4243563512,
  1735328473, 2368359562, 4294588738, 2272392833, 1839030562, 4259657740,
  2763975236, 1272893353, 4139469664, 3200236656, 681279174, 3936430074,
  3572445317, 76029189, 3654602809, 3873151461, 530742520, 3299628645,
  4096336452, 1126891415, 2878612391, 4237533241, 1700485571, 2399980690,
  4293915773, 2240044497, 1873313359, 4264355552, 2734768916, 1309151649,
  4149444226, 3174756917, 718787259, 3951481745,
];

/** 将字符串按 UTF-8 编码为字节数组 */
function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c: number = text.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | Math.floor(c / 64));
      bytes.push(0x80 | (c % 64));
    } else {
      // 代理对（emoji 等）按两个 3 字节序列输出，签名参数里不会出现，够用
      bytes.push(0xe0 | Math.floor(c / 4096));
      bytes.push(0x80 | (Math.floor(c / 64) % 64));
      bytes.push(0x80 | (c % 64));
    }
  }
  return bytes;
}

function toHexLE(word: number): string {
  const digits = "0123456789abcdef";
  let out = "";
  let w = word;
  // 小端输出 4 个字节
  for (let i = 0; i < 4; i++) {
    const b = w % 256;
    w = Math.floor(w / 256);
    out += digits.charAt(Math.floor(b / 16));
    out += digits.charAt(b % 16);
  }
  return out;
}

/** 标准 MD5，返回 32 位小写十六进制字符串 */
export function md5Hex(text: string): string {
  const bytes = utf8Bytes(text);
  const bitLen = bytes.length * 8;
  // 填充：0x80，然后补 0 直到长度 % 64 == 56，最后 8 字节小端长度（比特数）
  bytes.push(0x80);
  while (bytes.length % 64 != 56) bytes.push(0);
  let len = bitLen;
  for (let i = 0; i < 8; i++) {
    bytes.push(len % 256);
    len = Math.floor(len / 256);
  }

  let a0 = 1732584193;
  let b0 = 4023233417;
  let c0 = 2562383102;
  let d0 = 271733878;

  const blocks = bytes.length / 64;
  for (let block = 0; block < blocks; block++) {
    const base = block * 64;
    const m: number[] = [];
    for (let i = 0; i < 16; i++) {
      const o = base + i * 4;
      m.push(
        bytes[o] +
          bytes[o + 1] * 256 +
          bytes[o + 2] * 65536 +
          bytes[o + 3] * 16777216
      );
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f = 0;
      let g = 0;
      if (i < 16) {
        f = u32or(u32and(b, c), u32and(u32not(b), d));
        g = i;
      } else if (i < 32) {
        f = u32or(u32and(d, b), u32and(u32not(d), c));
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = u32xor(u32xor(b, c), d);
        g = (3 * i + 5) % 16;
      } else {
        f = u32xor(c, u32or(b, u32not(d)));
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const sum = u32add(u32add(u32add(a, f), K[i]), m[g]);
      b = u32add(b, u32rotl(sum, S[i]));
      a = tmp;
    }
    a0 = u32add(a0, a);
    b0 = u32add(b0, b);
    c0 = u32add(c0, c);
    d0 = u32add(d0, d);
  }

  return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
}

/**
 * 酷狗签名：把 query 串按 & 拆开、字典序排序、首尾各拼一次密钥后取 MD5。
 * apiver=5 对应 mobiles.kugou.com 的 v5 接口密钥。
 */
export function kgSignature(params: string, apiver: number): string {
  let key = "OIlwieks28dk2k092lksi2UIkp";
  if (apiver == 5) key = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
  const list = params.split("&");
  // 显式比较器，避免依赖各运行时 sort 的默认行为
  list.sort((x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0));
  return md5Hex(key + list.join("") + key);
}
