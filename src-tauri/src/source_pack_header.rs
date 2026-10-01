//! 统一音源包包头解析（v3，与 qt-uniappx `services/source-pack-header.uts` 同口径）。
//!
//! 每个音源包都是**单文件 js**，首行必须是自描述包头注释：
//!
//! ```text
//! /*__QT_PACK__{"kind":"meta","id":"meta-official","name":"官方数据包","versionCode":1,"versionName":"meta.1","updateUrl":""}*/
//! ```
//!
//! 宿主**不执行**脚本就能读出身份：kind（meta=数据包 / play=播放包）、id、
//! 版本号、可选 updateUrl（自更新探测直链）。首行不是合法包头 → 整个文件
//! 不是可安装的音源包（返回 None），安装入口据此报「不是可安装的音源包」。
//!
//! 解析规则（宽松 JSON、字段强校验）：
//! - 只看**第一行**（到第一个 `\n`；容忍无换行的整文件）；
//! - 必须以 `/*__QT_PACK__` 开头、`*/` 结尾，中间是一段 JSON 对象；
//! - `kind` 必须是 `"meta"` 或 `"play"`；`id` 必须匹配 `^[a-z0-9-]{2,32}$`；
//! - `versionCode` 必须是 ≥1 的整数；
//! - `name` / `versionName` / `updateUrl` / `notes` 可缺省（默认空串）。

/// 包头注释前缀（与 qt-sources `build-sources.mjs` 的 packHeaderOf 同步维护）
pub const PACK_HEADER_PREFIX: &str = "/*__QT_PACK__";

/// 数据包（meta-bundle.js：搜索/歌单/歌词等低风险数据源）
pub const PACK_KIND_META: &str = "meta";
/// 播放包（play-bundle.js：取链，高风险、不随应用分发）
pub const PACK_KIND_PLAY: &str = "play";

/// 播放包 IIFE 执行后必须挂出的装配工厂全局名（轻校验用，与引擎页同口径）
pub const PLAY_PACK_FACTORY_MARKER: &str = "__qtPlayPackFactory";

/// 官方数据包 / 播放包的固定 id（与 qt-sources `sources.config.json` 对齐）
pub const OFFICIAL_META_ID: &str = "meta-official";
pub const OFFICIAL_PLAY_ID: &str = "play-official";

/// 包 id 规则：`^[a-z0-9-]{2,32}$`（小写字母/数字/连字符，2~32 位）
pub fn valid_pack_id(id: &str) -> bool {
    let len = id.chars().count();
    (2..=32).contains(&len)
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// 从包头 JSON 文本解析（已剥掉 `/*__QT_PACK__` 与 `*/`）；任何字段不合法 → None
fn header_from_json(raw: &str) -> Option<PackHeader> {
    let value: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    let object = value.as_object()?;
    let kind = object.get("kind")?.as_str()?.to_string();
    if kind != PACK_KIND_META && kind != PACK_KIND_PLAY {
        return None;
    }
    let id = object.get("id")?.as_str()?.to_string();
    if !valid_pack_id(&id) {
        return None;
    }
    let version_code = object.get("versionCode")?.as_i64()?;
    if version_code < 1 {
        return None;
    }
    let str_field = |key: &str| -> String {
        object
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    Some(PackHeader {
        kind,
        name: str_field("name"),
        id,
        version_code,
        version_name: str_field("versionName"),
        update_url: str_field("updateUrl"),
        notes: str_field("notes"),
    })
}

/// 解析包文本首行的 `/*__QT_PACK__*/` 包头；不合法 → None（调用方报「不是可安装的音源包」）
pub fn parse_pack_header(text: &str) -> Option<PackHeader> {
    let first_line = text.split('\n').next().unwrap_or("").trim_end_matches('\r');
    let body = first_line
        .strip_prefix(PACK_HEADER_PREFIX)?
        .strip_suffix("*/")?;
    header_from_json(body)
}

/// 包头（宿主只读元信息，不执行脚本）
#[derive(Debug, Clone, PartialEq)]
pub struct PackHeader {
    /// `meta` 或 `play`
    pub kind: String,
    pub id: String,
    /// 展示名（可空，展示时兜底「数据包/播放包」）
    pub name: String,
    pub version_code: i64,
    pub version_name: String,
    /// 自更新探测直链（可空 = 不参与自探测通道）
    pub update_url: String,
    /// 更新说明（可空）
    pub notes: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    const META_LINE: &str = r#"/*__QT_PACK__{"kind":"meta","id":"meta-official","name":"官方数据包","versionCode":1,"versionName":"meta.1","updateUrl":""}*/"#;
    const PLAY_LINE: &str = r#"/*__QT_PACK__{"kind":"play","id":"play-official","name":"官方播放包","versionCode":2026100201,"versionName":"2026.10.02.1"}*/"#;

    #[test]
    fn parses_meta_header() {
        let h = parse_pack_header(&format!("{META_LINE}\nvar __qtPlayPackFactory = 1;\n")).unwrap();
        assert_eq!(h.kind, PACK_KIND_META);
        assert_eq!(h.id, "meta-official");
        assert_eq!(h.version_code, 1);
        assert_eq!(h.version_name, "meta.1");
        assert_eq!(h.update_url, "");
    }

    #[test]
    fn parses_play_header_without_trailing_newline() {
        let h = parse_pack_header(PLAY_LINE).unwrap();
        assert_eq!(h.kind, PACK_KIND_PLAY);
        assert_eq!(h.id, OFFICIAL_PLAY_ID);
        assert_eq!(h.version_code, 2026100201);
    }

    #[test]
    fn rejects_missing_or_bad_header() {
        // 没有包头（v2 老包）
        assert!(parse_pack_header("var x = 1;\n").is_none());
        // 包头不在首行
        assert!(
            parse_pack_header(&format!("console.log(1);\n{META_LINE}\n")).is_none()
        );
        // kind 非法
        assert!(
            parse_pack_header(r#"/*__QT_PACK__{"kind":"widget","id":"a-b","versionCode":1}*/"#)
                .is_none()
        );
        // id 非法（大写 / 太短 / 非法字符）
        assert!(
            parse_pack_header(r#"/*__QT_PACK__{"kind":"meta","id":"Meta-1","versionCode":1}*/"#)
                .is_none()
        );
        assert!(
            parse_pack_header(r#"/*__QT_PACK__{"kind":"meta","id":"m","versionCode":1}*/"#)
                .is_none()
        );
        assert!(
            parse_pack_header(r#"/*__QT_PACK__{"kind":"meta","id":"a_b","versionCode":1}*/"#)
                .is_none()
        );
        // 缺 versionCode / versionCode < 1
        assert!(
            parse_pack_header(r#"/*__QT_PACK__{"kind":"meta","id":"a-b"}*/"#).is_none()
        );
        assert!(
            parse_pack_header(r#"/*__QT_PACK__{"kind":"meta","id":"a-b","versionCode":0}*/"#)
                .is_none()
        );
        // JSON 残缺
        assert!(parse_pack_header(r#"/*__QT_PACK__{"kind":"meta"*/"#).is_none());
        // 空文本
        assert!(parse_pack_header("").is_none());
    }

    #[test]
    fn header_only_first_line_counts() {
        // 第二行出现另一个包头也不影响：首行才是身份
        let text = format!("{PLAY_LINE}\n{META_LINE}\n");
        let h = parse_pack_header(&text).unwrap();
        assert_eq!(h.kind, PACK_KIND_PLAY);
    }

    #[test]
    fn crlf_first_line_tolerated() {
        let text = format!("{META_LINE}\r\nrest\r\n");
        assert!(parse_pack_header(&text).is_some());
    }

    #[test]
    fn pack_id_rule() {
        assert!(valid_pack_id("ab"));
        assert!(valid_pack_id("play-official"));
        assert!(valid_pack_id("custom-20261001-120000"));
        assert!(!valid_pack_id("A"));
        assert!(!valid_pack_id("a"));
        assert!(!valid_pack_id(""));
        assert!(!valid_pack_id("a".repeat(33).as_str()));
        assert!(!valid_pack_id("a.b"));
    }
}
