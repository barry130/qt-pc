//! 官方音源包 ed25519 签名校验（2026-10 官方身份防仿冒，与 qt-sources
//! scripts/sign-pack.mjs、qt-uniappx services/pack-signature.uts 同一约定）。
//!
//! 背景与威胁模型：官方包同样走「https 直链 / 本地 js 文件」分发，文件身份不能只靠
//! 首行自述（否则任何第三方都能写 id=play-official 顶掉官方槽）。构建期发布机私钥对
//! 「含 __QT_PACK__ 身份头的文件全文」做 ed25519 签名，尾部追加 __QT_SIGN__ 注释块
//! （JSON：{"alg":"ed25519","sig":"base64 64B"}）。宿主只内置公钥（本模块常量，
//! 绝不放进包文件），安装/更新官方保留 id（play-official / meta-official）时硬校验：
//! 验不过（含无签名块）一律拒绝；第三方包不受影响。
//!
//! 签名对象 = 剥掉尾部签名块后的全文（UTF-8 bytes）。验签发生在 validate_pack_text
//! （预览与安装管线共用的静态门槛），对所有渠道生效——直链/本地/manifest/自管更新。

use base64::Engine;

/// 官方发布公钥（ed25519 raw 32B，base64）。
/// 与 qt-sources sources.config.json packs.signing.publicKey、
/// qt-uniappx services/pack-signature.uts OFFICIAL_SIGN_PUBKEY_B64 保持一致。
pub const OFFICIAL_SIGN_PUBKEY_B64: &str = "mOti+JoaX2Tn6VaP91E+TaYrth4oGaUqASv9Ot4NDcE=";

/// 签名块起始标记（与 qt-sources scripts/sign-pack.mjs 同值）
const SIGN_BLOCK_MARK: &str = "/*__QT_SIGN__";

/// 拆掉文件尾部的 __QT_SIGN__ 签名块。
/// 返回 (content, Some(sig_b64))：content = 签名对象（剥块后的全文，含身份头）。
/// 无尾部块 / 块不在文件尾（其后有非空白内容）/ JSON 非法 / 缺 sig 字段 → (原文, None)。
/// 只认 rfind——签名块必须整个位于文件末尾。
pub fn split_sign_block(text: &str) -> (&str, Option<String>) {
    let Some(pos) = text.rfind(SIGN_BLOCK_MARK) else {
        return (text, None);
    };
    let Some(end) = text[pos..].find("*/").map(|i| pos + i) else {
        return (text, None);
    };
    if !text[end + 2..].trim().is_empty() {
        return (text, None);
    }
    let json = &text[pos + SIGN_BLOCK_MARK.len()..end];
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return (text, None);
    };
    match v.get("sig").and_then(|s| s.as_str()) {
        Some(sig) => (&text[..pos], Some(sig.to_string())),
        None => (text, None),
    }
}

/// 校验官方包签名。签名对象 = 剥块后全文的 UTF-8 bytes；失败返回中文原因
/// （直接拼进安装/预览报错，与 uniappx 端文案口径一致）。
pub fn verify_official_signature(text: &str) -> Result<(), String> {
    let (content, sig_b64) = split_sign_block(text);
    let Some(sig_b64) = sig_b64 else {
        return Err("文件缺少官方签名（尾部 __QT_SIGN__ 块）".to_string());
    };
    verify_ed25519(content.as_bytes(), &sig_b64, OFFICIAL_SIGN_PUBKEY_B64)
}

/// ring 实现的 ed25519 验签（ring 随 rustls 已在依赖树里，见 astral.rs
/// 安装包验签的同一套写法）。`pubkey_b64` 参数便于单测注入测试密钥。
pub(crate) fn verify_ed25519(data: &[u8], sig_b64: &str, pubkey_b64: &str) -> Result<(), String> {
    let pubkey = base64::engine::general_purpose::STANDARD
        .decode(pubkey_b64)
        .map_err(|e| format!("公钥解析失败: {e}"))?;
    let sig = base64::engine::general_purpose::STANDARD
        .decode(sig_b64.trim())
        .map_err(|e| format!("签名内容解析失败: {e}"))?;
    if sig.len() != 64 {
        return Err(format!(
            "签名长度异常（ed25519 应为 64 字节，实际 {}）",
            sig.len()
        ));
    }
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &pubkey)
        .verify(data, &sig)
        .map_err(|_| "签名不匹配（文件被改动或非官方原版）".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 8032 §7.1 test vector 3（seed/pub/msg/sig 完整三元组，
    // 离线可验；生产链路的端到端互验由 qt-sources 构建自测覆盖：
    // node:crypto 签名 → ring 验签，见 build-sources.mjs ②″ 回读校验）。
    const TEST_PUBKEY_B64: &str = "/FHNjmIYoaONpH7QAjDwWAgW7RO6MwOsXeuRFUiQgCU=";
    const TEST_MSG: &[u8] = &[0xaf, 0x82];
    const TEST_SIG_HEX: &str = "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a";

    fn hex_to_bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    fn b64(bytes: &[u8]) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn split_finds_tail_block() {
        let text = "/*header*/body\n/*__QT_SIGN__{\"alg\":\"ed25519\",\"sig\":\"QUJD\"}*/\n";
        let (content, sig) = split_sign_block(text);
        assert_eq!(content, "/*header*/body\n");
        assert_eq!(sig.as_deref(), Some("QUJD"));
    }

    #[test]
    fn split_rejects_non_tail_block() {
        let text = "/*__QT_SIGN__{\"sig\":\"QUJD\"}*/\ntrailing code";
        let (content, sig) = split_sign_block(text);
        assert!(sig.is_none());
        assert_eq!(content, text);
    }

    #[test]
    fn split_rejects_missing_sig_field() {
        let text = "body\n/*__QT_SIGN__{\"alg\":\"ed25519\"}*/";
        let (_, sig) = split_sign_block(text);
        assert!(sig.is_none());
    }

    #[test]
    fn missing_block_reports_reason() {
        let err = verify_official_signature("/*__QT_PACK__*/plain").unwrap_err();
        assert!(err.contains("缺少官方签名"), "{err}");
    }

    #[test]
    fn verify_accepts_known_good_vector() {
        let sig = hex_to_bytes(TEST_SIG_HEX);
        verify_ed25519(TEST_MSG, &b64(&sig), TEST_PUBKEY_B64)
            .expect("RFC 8032 向量必须验过（ring ed25519 与标准一致）");
    }

    #[test]
    fn verify_rejects_tampered_signature() {
        let mut sig = hex_to_bytes(TEST_SIG_HEX);
        sig[10] ^= 0x01;
        let err = verify_ed25519(TEST_MSG, &b64(&sig), TEST_PUBKEY_B64).unwrap_err();
        assert!(err.contains("签名不匹配"), "{err}");
    }

    #[test]
    fn verify_rejects_wrong_message() {
        // 签名对 TEST_MSG 有效；换一条消息必须验不过
        let sig = hex_to_bytes(TEST_SIG_HEX);
        let other = b"/*__QT_PACK__*/tampered body";
        let err = verify_ed25519(other, &b64(&sig), TEST_PUBKEY_B64).unwrap_err();
        assert!(err.contains("签名不匹配"), "{err}");
    }
}
