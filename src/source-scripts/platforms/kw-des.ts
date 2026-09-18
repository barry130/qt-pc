/**
 * 酷我 mobi.s 播放地址加密（DES + Base64）—— 蓝本文件级移植。
 *
 * 逐段对照 qt-uniappx services/kw-encode.uts（原样搬入，DES 逻辑一行不改，
 * 仅做 uts→ts 语法微调：隐式 any 参数补类型注解、new Array 补元素类型）：
 * - 查表 f4897d/f4898e/f4899f/f4900g/f4901h/f4902i/j/kk/l/m :5-55
 * - a（按位置表收集位）:57 / a1（16 轮子密钥）:67 / a2（Feistel 加密块）:83
 * - encrypt2 :117 / BASE64_CHARS + base64Encode :164-184 / stringToAscii :186
 * - getKwUrlByEncode（拼明文参数 → DES → Base64 → URL 编码）:194
 *
 * 蓝本用 #ifdef APP-ANDROID / #ifndef 条件编译区分 BigInt 实现与抛错占位；
 * 本包运行在 PC 宿主 JS 引擎（ES2022，BigInt 原生可用，qt-pc tsconfig target
 * 已确认），故取 APP-ANDROID 分支为唯一实现，舍弃占位分支。
 * 注意：不可使用 UTS Long/Int (.toInt/.toLong)，蓝本即为此改写的 BigInt 版。
 */

const f4897d = [1n, 2n, 4n, 8n, 16n, 32n, 64n, 128n, 256n, 512n, 1024n, 2048n, 4096n, 8192n, 16384n, 32768n, 65536n,
  131072n, 262144n, 524288n, 1048576n, 2097152n, 4194304n, 8388608n, 16777216n, 33554432n, 67108864n, 134217728n,
  268435456n, 536870912n, 1073741824n, 2147483648n, 4294967296n, 8589934592n, 17179869184n, 34359738368n, 68719476736n,
  137438953472n, 274877906944n, 549755813888n, 1099511627776n, 2199023255552n, 4398046511104n, 8796093022208n,
  17592186044416n, 35184372088832n, 70368744177664n, 140737488355328n, 281474976710656n, 562949953421312n,
  1125899906842624n, 2251799813685248n, 4503599627370496n, 9007199254740992n, 18014398509481984n, 36028797018963968n,
  72057594037927936n, 144115188075855872n, 288230376151711744n, 576460752303423488n, 1152921504606846976n,
  2305843009213693952n, 4611686018427387904n, -9223372036854775808n
];
const f4898e = [57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47,
  39, 31, 23, 15, 7, 56, 48, 40, 32, 24, 16, 8, 0, 58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6
];
const f4899f = [31, 0, 1, 2, 3, 4, -1, -1, 3, 4, 5, 6, 7, 8, -1, -1, 7, 8, 9, 10, 11, 12, -1, -1, 11, 12, 13, 14,
  15, 16, -1, -1, 15, 16, 17, 18, 19, 20, -1, -1, 19, 20, 21, 22, 23, 24, -1, -1, 23, 24, 25, 26, 27, 28, -1, -1,
  27, 28, 29, 30, 31, 30, -1, -1
];
const f4900g = [
  [14, 4, 3, 15, 2, 13, 5, 3, 13, 14, 6, 9, 11, 2, 0, 5, 4, 1, 10, 12, 15, 6, 9, 10, 1, 8, 12, 7, 8, 11, 7, 0,
    0, 15, 10, 5, 14, 4, 9, 10, 7, 8, 12, 3, 13, 1, 3, 6, 15, 12, 6, 11, 2, 9, 5, 0, 4, 2, 11, 14, 1, 7, 8, 13],
  [15, 0, 9, 5, 6, 10, 12, 9, 8, 7, 2, 12, 3, 13, 5, 2, 1, 14, 7, 8, 11, 4, 0, 3, 14, 11, 13, 6, 4, 1, 10, 15,
    3, 13, 12, 11, 15, 3, 6, 0, 4, 10, 1, 7, 8, 4, 11, 14, 13, 8, 0, 6, 2, 15, 9, 5, 7, 1, 10, 12, 14, 2, 5, 9],
  [10, 13, 1, 11, 6, 8, 11, 5, 9, 4, 12, 2, 15, 3, 2, 14, 0, 6, 13, 1, 3, 15, 4, 10, 14, 9, 7, 12, 5, 0, 8, 7,
    13, 1, 2, 4, 3, 6, 12, 11, 0, 13, 5, 14, 6, 8, 15, 2, 7, 10, 8, 15, 4, 9, 11, 5, 9, 0, 14, 3, 10, 7, 1, 12],
  [7, 10, 1, 15, 0, 12, 11, 5, 14, 9, 8, 3, 9, 7, 4, 8, 13, 6, 2, 1, 6, 11, 12, 2, 3, 0, 5, 14, 10, 13, 15, 4,
    13, 3, 4, 9, 6, 10, 1, 12, 11, 0, 2, 5, 0, 13, 14, 2, 8, 15, 7, 4, 15, 1, 10, 7, 5, 6, 12, 11, 3, 8, 9, 14],
  [2, 4, 8, 15, 7, 10, 13, 6, 4, 1, 3, 12, 11, 7, 14, 0, 12, 2, 5, 9, 10, 13, 0, 3, 1, 11, 15, 5, 6, 8, 9, 14,
    14, 11, 5, 6, 4, 1, 3, 10, 2, 12, 15, 0, 13, 2, 8, 5, 11, 8, 0, 15, 7, 14, 9, 4, 12, 7, 10, 9, 1, 13, 6, 3],
  [12, 9, 0, 7, 9, 2, 14, 1, 10, 15, 3, 4, 6, 12, 5, 11, 1, 14, 13, 0, 2, 8, 7, 13, 15, 5, 4, 10, 8, 3, 11, 6,
    10, 4, 6, 11, 7, 9, 0, 6, 4, 2, 13, 1, 9, 15, 3, 8, 15, 3, 1, 14, 12, 5, 11, 0, 2, 12, 14, 7, 5, 10, 8, 13],
  [4, 1, 3, 10, 15, 12, 5, 0, 2, 11, 9, 6, 8, 7, 6, 9, 11, 4, 12, 15, 0, 3, 10, 5, 14, 13, 7, 8, 13, 14, 1, 2,
    13, 6, 14, 9, 4, 1, 2, 14, 11, 13, 5, 0, 1, 10, 8, 3, 0, 11, 3, 5, 9, 4, 15, 2, 7, 8, 12, 15, 10, 7, 6, 12],
  [13, 7, 10, 0, 6, 9, 5, 15, 8, 4, 3, 10, 11, 14, 12, 5, 2, 11, 9, 6, 15, 12, 0, 3, 4, 1, 14, 13, 1, 2, 7, 8,
    1, 2, 12, 15, 10, 4, 0, 3, 13, 14, 6, 9, 7, 8, 9, 6, 15, 1, 5, 12, 3, 10, 14, 5, 8, 7, 11, 0, 4, 13, 2, 11]
];
const f4901h = [15, 6, 19, 20, 28, 11, 27, 16, 0, 14, 22, 25, 4, 17, 30, 9, 1, 7, 23, 13, 31, 26, 2, 8, 18, 12, 29, 5,
  21, 10, 3, 24
];
const f4902i = [39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44,
  12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
  32, 0, 40, 8, 48, 16, 56, 24
];
const j = [56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35,
  62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3
];
const kk = [13, 16, 10, 23, 0, 4, -1, -1, 2, 27, 14, 5, 20, 9, -1, -1, 22, 18, 11, 3, 25, 7, -1, -1, 15, 6, 26, 19, 12,
  1, -1, -1, 40, 51, 30, 36, 46, 54, -1, -1, 29, 39, 50, 44, 32, 47, -1, -1, 43, 48, 38, 55, 33, 52, -1, -1, 45,
  41, 49, 35, 28, 31, -1, -1
];
const l = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const m = [0, 1048577, 3145731];

function a(iArr: number[], i2: number, j2: bigint): bigint {
  let j3 = 0n;
  for (let i3 = 0; i3 < i2; i3++) {
    if (iArr[i3] >= 0 && (j2 & f4897d[iArr[i3]]) != 0n) {
      j3 |= f4897d[i3];
    }
  }
  return j3;
}

function a1(j2: bigint, jArr: bigint[], i2: number): void {
  let a2v = a(j, 56, j2);
  for (let i3 = 0; i3 < 16; i3++) {
    a2v = ((a2v & (BigInt(m[l[i3]]) ^ -1n)) >> BigInt(l[i3])) | ((BigInt(m[l[i3]]) & a2v) << (28n - BigInt(l[i3])));
    jArr[i3] = a(kk, 64, a2v);
  }
  if (i2 == 1) {
    for (let i4 = 0; i4 < 8; i4++) {
      const j3 = jArr[i4];
      const i5 = 15 - i4;
      jArr[i4] = jArr[i5];
      jArr[i5] = j3;
    }
  }
}

function a2(jArr: bigint[], j2: bigint): bigint {
  let p = a(f4898e, 64, j2);
  let s0 = p & 0xFFFFFFFFn;
  let s1 = (p >> 32n) & 0xFFFFFFFFn;
  const t: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let i2 = 0; i2 < 16; i2++) {
    let r = s1;
    r = a(f4899f, 64, r);
    r ^= jArr[i2];
    for (let i3 = 0; i3 < 8; i3++) {
      t[i3] = Number((r >> BigInt(i3 * 8)) & 0xFFn);
    }
    let u = 0n;
    let i4 = 7;
    while (true) {
      const w = i4;
      if (w < 0) break;
      u = u << 4n;
      u |= BigInt(f4900g[w][t[w]]);
      i4 = w - 1;
    }
    r = a(f4901h, 32, u);
    const q = s0;
    s0 = s1;
    s1 = q ^ r;
  }
  let v = s0;
  s0 = s1;
  s1 = v;
  p = (s0 & 0xFFFFFFFFn) | ((s1 << 32n) & 0xFFFFFFFF00000000n);
  p = a(f4902i, 64, p);
  return p;
}

function encrypt2(bArr: number[], i2: number, bArr2: number[], _i3: number): number[] {
  let key = 0n;
  for (let i4 = 0; i4 < 8; i4++) {
    key |= BigInt(bArr2[i4] & 255) << BigInt(i4 * 8);
  }
  const i5 = Math.floor(i2 / 8);
  const jArr: bigint[] = new Array(16).fill(0n);
  const jArr2: bigint[] = new Array(i5);
  for (let i7 = 0; i7 < i5; i7++) {
    jArr2[i7] = 0n;
    for (let i8 = 0; i8 < 8; i8++) {
      jArr2[i7] |= BigInt(bArr[i7 * 8 + i8] & 255) << BigInt(i8 * 8);
    }
  }
  const jArr3Len = Math.floor(((i5 + 1) * 8 + 1) / 8);
  const jArr3: bigint[] = new Array(jArr3Len);
  a1(key, jArr, 0);
  for (let i9 = 0; i9 < i5; i9++) {
    jArr3[i9] = a2(jArr, jArr2[i9]);
  }
  const i10 = i2 % 8;
  const i11 = i5 * 8;
  const i12 = i2 - i11;
  const bArr4: number[] = new Array(i12);
  for (let i13 = 0; i13 < i12; i13++) {
    bArr4[i13] = bArr[i11 + i13];
  }
  let j3 = 0n;
  for (let i13 = 0; i13 < i10; i13++) {
    j3 |= BigInt(bArr4[i13]) << BigInt(i13 * 8);
  }
  jArr3[i5] = a2(jArr, j3);
  const out: number[] = new Array(jArr3.length * 8);
  let i14 = 0;
  let i15 = 0;
  while (i14 < jArr3.length) {
    let i16 = i15;
    for (let i17 = 0; i17 < 8; i17++) {
      out[i16] = Number(0xFFn & (jArr3[i14] >> BigInt(i17 * 8)));
      i16++;
    }
    i14++;
    i15 = i16;
  }
  return out;
}

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Encode(data: number[]): string {
  let out = "";
  let i = 0;
  while (i < data.length) {
    const b0 = data[i] & 255;
    const b1 = i + 1 < data.length ? data[i + 1] & 255 : 0;
    const b2 = i + 2 < data.length ? data[i + 2] & 255 : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64_CHARS.charAt((n >> 18) & 63);
    out += BASE64_CHARS.charAt((n >> 12) & 63);
    out += BASE64_CHARS.charAt((n >> 6) & 63);
    out += BASE64_CHARS.charAt(n & 63);
    i += 3;
  }
  const rem = data.length % 3;
  if (rem == 1) out = out.substring(0, out.length - 2) + "==";
  else if (rem == 2) out = out.substring(0, out.length - 1) + "=";
  return out;
}

function stringToAscii(s: string): number[] {
  const arr: number[] = [];
  for (let i = 0; i < s.length; i++) {
    arr.push(s.charCodeAt(i));
  }
  return arr;
}

export function getKwUrlByEncode(id: string, br: string): string {
  let s = "";
  if (br == "1") {
    s = "user=0&android_id=0&prod=kwplayer_ar_8.5.5.0&corp=kuwo&newver=3&vipver=8.5.5.0&source=kwplayer_ar_5.1.0.0_B_jiakong_vh.apk&p2p=1&notrace=0&type=convert_url2&br=128kmp3&format=mp3&sig=0&rid=" + id;
  } else if (br == "2") {
    s = "user=0&android_id=0&prod=kwplayer_ar_8.5.5.0&corp=kuwo&newver=3&vipver=8.5.5.0&source=kwplayer_ar_5.1.0.0_B_jiakong_vh.apk&p2p=1&notrace=0&type=convert_url2&br=320kmp3&format=mp3&sig=0&rid=" + id;
  } else {
    s = "user=0&android_id=0&prod=kwplayer_ar_8.5.5.0&corp=kuwo&newver=3&vipver=8.5.5.0&source=kwplayer_ar_5.1.0.0_B_jiakong_vh.apk&p2p=1&notrace=0&type=convert_url2&format=flac|mp3|aac&sig=0&rid=" + id;
  }
  const bytes = stringToAscii(s);
  const key = stringToAscii("ylzsxkwm");
  const enc = encrypt2(bytes, bytes.length, key, 8);
  let q = base64Encode(enc);
  q = q.split("+").join("%2B");
  q = q.split("/").join("%2F");
  q = q.split("=").join("%3D");
  return "https://mobi.kuwo.cn/mobi.s?f=kuwo&q=" + q;
}
