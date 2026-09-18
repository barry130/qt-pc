/**
 * lx-host 基础设施测试：AES 实现（NIST 向量）+ LX utils.buffer 工具。
 *
 * AES 向量取自 NIST SP 800-38A（ECB/CBC × 128/192/256 各 4 块）与
 * FIPS-197 Appendix C.1/C.2/C.3，全部常量已用 node:crypto 程序化核对。
 */
import { describe, expect, it } from "vitest";
import {
  SBOX,
  aesEncrypt,
  bufferFrom,
  bufferToString,
  expandKey,
} from "../src/source-scripts/schemes/lx-host/crypto";

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const bytesToHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** SP 800-38A 公共 4 块明文与密钥 */
const PT4 =
  "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710";
const K128 = "2b7e151628aed2a6abf7158809cf4f3c";
const K192 = "8e73b0f7da0e6452c810f32b809079e562f8ead2522c6b7b";
const K256 = "603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4";
const IV128 = "000102030405060708090a0b0c0d0e0f";

describe("AES S-box", () => {
  it("与 FIPS-197 算法（乘法逆 + 仿射）程序化生成的一致", () => {
    // GF(2^8) 乘法逆：暴力求 inv 满足 a*inv ≡ 1；仿射：b_i = inv_i ^ inv_{i+4%8} ^ inv_{i+5%8} ^ inv_{i+6%8} ^ inv_{i+7%8} ^ c_i
    const generated = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      let inv = 0;
      if (i !== 0) {
        for (let j = 1; j < 256; j++) {
          let prod = 0;
          let x = i;
          let y = j;
          while (y > 0) {
            if (y & 1) prod ^= x;
            x = ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
            y >>= 1;
          }
          if (prod === 1) {
            inv = j;
            break;
          }
        }
      }
      let s = 0;
      for (let b = 0; b < 8; b++) {
        const bit =
          ((inv >> b) & 1) ^
          ((inv >> ((b + 4) % 8)) & 1) ^
          ((inv >> ((b + 5) % 8)) & 1) ^
          ((inv >> ((b + 6) % 8)) & 1) ^
          ((inv >> ((b + 7) % 8)) & 1) ^
          ((0x63 >> b) & 1);
        s |= bit << b;
      }
      generated[i] = s;
    }
    expect(Array.from(generated)).toEqual(Array.from(SBOX));
  });
});

describe("AES 密钥扩展（FIPS-197 A.1）", () => {
  it("轮密钥与标准一致", () => {
    const rks = expandKey(hexToBytes(K128));
    expect(rks).toHaveLength(11);
    expect(bytesToHex(rks[0]!)).toBe(K128);
    // rk1 / rk10 为 A.1 表中的权威值
    expect(bytesToHex(rks[1]!)).toBe("a0fafe1788542cb123a339392a6c7605");
    expect(bytesToHex(rks[10]!)).toBe("d014f9a8c9ee2589e13f0cc8b6630ca6");
  });
});

describe("AES 加密向量", () => {
  it("ECB-AES128（SP 800-38A F.1.1，4 块）+ PKCS7 整块填充", () => {
    const out = aesEncrypt(hexToBytes(PT4), "aes-128-ecb", hexToBytes(K128));
    expect(out).toHaveLength(80); // 64 数据 + 16 整块填充
    expect(bytesToHex(out.subarray(0, 64))).toBe(
      "3ad77bb40d7a3660a89ecaf32466ef97f5d3d58503b9699de785895a96fdbaaf43b1cd7f598ece23881b00e3ed0306887b0c785e27e8ad3f8223207104725dd4",
    );
    // 整块填充（0x10 × 16）的密文
    expect(bytesToHex(out.subarray(64))).toBe("a254be88e037ddd9d79fb6411c3f9df8");
  });

  it("CBC-AES128（SP 800-38A F.2.1，4 块）", () => {
    const out = aesEncrypt(hexToBytes(PT4), "aes-128-cbc", hexToBytes(K128), hexToBytes(IV128));
    expect(out).toHaveLength(80);
    expect(bytesToHex(out.subarray(0, 64))).toBe(
      "7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b273bed6b8e3c1743b7116e69e222295163ff1caa1681fac09120eca307586e1a7",
    );
  });

  it("ECB/CBC-AES192（F.1.3 / F.2.3）", () => {
    const ecb = aesEncrypt(hexToBytes(PT4), "aes-192-ecb", hexToBytes(K192));
    expect(bytesToHex(ecb.subarray(0, 64))).toBe(
      "bd334f1d6e45f25ff712a214571fa5cc974104846d0ad3ad7734ecb3ecee4eefef7afd2270e2e60adce0ba2face6444e9a4b41ba738d6c72fb16691603c18e0e",
    );
    const cbc = aesEncrypt(hexToBytes(PT4), "aes-192-cbc", hexToBytes(K192), hexToBytes(IV128));
    expect(bytesToHex(cbc.subarray(0, 64))).toBe(
      "4f021db243bc633d7178183a9fa071e8b4d9ada9ad7dedf4e5e738763f69145a571b242012fb7ae07fa9baac3df102e008b0e27988598881d920a9e64f5615cd",
    );
  });

  it("ECB/CBC-AES256（F.1.5 / F.2.5）", () => {
    const ecb = aesEncrypt(hexToBytes(PT4), "aes-256-ecb", hexToBytes(K256));
    expect(bytesToHex(ecb.subarray(0, 64))).toBe(
      "f3eed1bdb5d2a03c064b5a7e3db181f8591ccb10d410ed26dc5ba74a31362870b6ed21b99ca6f4f9f153e7b1beafed1d23304b7a39f9f3ff067d8d8f9e24ecc7",
    );
    const cbc = aesEncrypt(hexToBytes(PT4), "aes-256-cbc", hexToBytes(K256), hexToBytes(IV128));
    expect(bytesToHex(cbc.subarray(0, 64))).toBe(
      "f58c4c04d6e5f1ba779eabfb5f7bfbd69cfc4e967edb808d679f777bc6702c7d39f23369a9d9bacfa530e26304231461b2eb05e2c39be9fcda6c19078c6a9d1b",
    );
  });

  it("FIPS-197 Appendix C.1/C.2/C.3（hex 入参）", () => {
    const pt = hexToBytes("00112233445566778899aabbccddeeff");
    const c1 = aesEncrypt(pt, "aes-128-ecb", hexToBytes("000102030405060708090a0b0c0d0e0f"));
    expect(bytesToHex(c1.subarray(0, 16))).toBe("69c4e0d86a7b0430d8cdb78070b4c55a");
    const c2 = aesEncrypt(pt, "aes-192-ecb", hexToBytes("000102030405060708090a0b0c0d0e0f1011121314151617"));
    expect(bytesToHex(c2.subarray(0, 16))).toBe("dda97ca4864cdfe06eaf70a0ec0d7191");
    const c3 = aesEncrypt(pt, "aes-256-ecb", hexToBytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"));
    expect(bytesToHex(c3.subarray(0, 16))).toBe("8ea2b7ca516745bfeafc49904b496089");
  });

  it("eapi 实际调用形态：aes-128-ecb + 字符串 key 'e82ckenh8dichen8'", () => {
    // 期望值由 node:crypto（同输入、关闭填充）核对
    const out = aesEncrypt("hello eapi sample", "aes-128-ecb", "e82ckenh8dichen8");
    expect(bytesToHex(out.subarray(0, 16))).toBe("f0300dc97a08fef6aa3f955fe8e2e3d5");
  });

  it("非法模式 / 缺 IV / 非法 key 长度抛错", () => {
    expect(() => aesEncrypt("x", "aes-128-gcm", "0".repeat(32))).toThrow();
    expect(() => aesEncrypt("x", "aes-128-cbc", "0".repeat(16))).toThrow(); // CBC 无 IV
    expect(() => aesEncrypt("x", "aes-128-ecb", "0".repeat(15))).toThrow();
    expect(() => aesEncrypt("x", "aes-256-ecb", "0".repeat(16))).toThrow(); // key 与模式位数不符
  });
});

describe("utils.buffer 工具", () => {
  it("bufferFrom 按 utf8 编码", () => {
    expect(bytesToHex(bufferFrom("晴天"))).toBe("e699b4e5a4a9");
  });

  it("bufferToString 支持 utf8/hex/base64，缺省 utf8", () => {
    const buf = hexToBytes("e699b4e5a4a900");
    expect(bufferToString(buf)).toBe("晴天\0");
    expect(bufferToString(buf, "hex")).toBe("e699b4e5a4a900");
    expect(bufferToString(buf, "HEX")).toBe("e699b4e5a4a900");
    expect(bufferToString(buf, "base64")).toBe("5pm05aSpAA==");
    expect(bufferToString(bufferFrom("abc"), "utf8")).toBe("abc");
  });
});
