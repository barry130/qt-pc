//! MD5 哈希（RFC 1321），仅提供「字符串 → 32 位小写十六进制」一个入口。
//!
//! 为什么手写而不引入 `md5` crate：
//! 1. 它只是酷狗移动端接口签名的一环（kg-sign.ts 的 `md5Hex`），入口单一；
//! 2. 现有依赖树里没有 MD5，加依赖要重新解析 registry（本机网络受限）；
//! 3. 移动端已因同样原因手写过一份（UTS 无内置 MD5、不能引 Node 包），
//!    这里与它同口径，并用同一批已知向量验证。
//!
//! 非安全用途（接口签名），实现为标准 MD5：填充 → 512 位分块 → 四轮 64 步。

/// 每步循环左移位数
const S: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/// K[i] = floor(abs(sin(i + 1)) * 2^32)，写死避免各平台 libm 末位差异
const K: [u32; 64] = [
    3614090360, 3905402710, 606105819, 3250441966, 4118548399, 1200080426, 2821735955, 4249261313,
    1770035416, 2336552879, 4294925233, 2304563134, 1804603682, 4254626195, 2792965006, 1236535329,
    4129170786, 3225465664, 643717713, 3921069994, 3593408605, 38016083, 3634488961, 3889429448,
    568446438, 3275163606, 4107603335, 1163531501, 2850285829, 4243563512, 1735328473, 2368359562,
    4294588738, 2272392833, 1839030562, 4259657740, 2763975236, 1272893353, 4139469664, 3200236656,
    681279174, 3936430074, 3572445317, 76029189, 3654602809, 3873151461, 530742520, 3299628645,
    4096336452, 1126891415, 2878612391, 4237533241, 1700485571, 2399980690, 4293915773, 2240044497,
    1873313359, 4264355552, 2734768916, 1309151649, 4149444226, 3174756917, 718787259, 3951481745,
];

/// 标准 MD5，返回 32 位小写十六进制字符串
pub fn md5_hex(input: &str) -> String {
    let mut bytes = input.as_bytes().to_vec();
    let bit_len = (bytes.len() as u64).wrapping_mul(8);

    // 填充：0x80 起，补 0 到长度 % 64 == 56，再附 8 字节小端比特长度
    bytes.push(0x80);
    while bytes.len() % 64 != 56 {
        bytes.push(0);
    }
    bytes.extend_from_slice(&bit_len.to_le_bytes());

    let mut a0: u32 = 0x6745_2301;
    let mut b0: u32 = 0xefcd_ab89;
    let mut c0: u32 = 0x98ba_dcfe;
    let mut d0: u32 = 0x1032_5476;

    for block in bytes.chunks_exact(64) {
        let mut m = [0u32; 16];
        for (i, word) in m.iter_mut().enumerate() {
            *word = u32::from_le_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }

        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64usize {
            let (f, g) = match i {
                0..=15 => ((b & c) | ((!b) & d), i),
                16..=31 => ((d & b) | ((!d) & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | (!d)), (7 * i) % 16),
            };
            let prev_d = d;
            d = c;
            c = b;
            let sum = a
                .wrapping_add(f)
                .wrapping_add(K[i])
                .wrapping_add(m[g]);
            b = b.wrapping_add(sum.rotate_left(S[i]));
            a = prev_d;
        }

        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }

    // 摘要按小端字节序输出（与 kg-sign.ts 的 toHexLE 同序）
    format!("{}{}{}{}", hex_le(a0), hex_le(b0), hex_le(c0), hex_le(d0))
}

/// 32 位字按小端字节序转 8 位十六进制
fn hex_le(word: u32) -> String {
    let b = word.to_le_bytes();
    format!(
        "{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3]
    )
}

#[cfg(test)]
mod tests {
    use super::md5_hex;

    #[test]
    fn matches_known_vectors() {
        // RFC 1321 的标准测试向量 + 多分块（>55 字节触发跨块）
        let cases = [
            ("", "d41d8cd98f00b204e9800998ecf8427e"),
            ("a", "0cc175b9c0f1b6a831c399e269772661"),
            ("abc", "900150983cd24fb0d6963f7d28e17f72"),
            ("message digest", "f96b697d7cb7938d525a2f31aaf161d0"),
            (
                "abcdefghijklmnopqrstuvwxyz",
                "c3fcd3d76192e4007dfb496cca67e13b",
            ),
            (
                "The quick brown fox jumps over the lazy dog",
                "9e107d9d372bb6826bd81d3542a419d6",
            ),
            (
                "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
                "57edf4a22be3c955ac49da2e2107b67a",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(md5_hex(input), expected, "md5({:?}) 不匹配", input);
        }
    }

    #[test]
    fn handles_non_ascii() {
        // 签名参数里会出现中文歌名，UTF-8 字节直接参与运算
        assert_eq!(md5_hex("中文"), "a7bac2239fcdcb3a067903d8077c4a07");
    }
}
