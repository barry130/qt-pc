//! 音源统一数据模型（DESIGN §6.6 / §7.2）
//!
//! 全部 `rename_all = "camelCase"`，与前端 TS 类型一一对应，不做手工字段映射。

use serde::{Deserialize, Serialize};

/// 源 ID 固定 `wyy / qq / kw / kg`（+ local 本地）。serde 小写，与前端一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceId {
    Wyy,
    Qq,
    Kw,
    Kg,
    Local,
}

impl SourceId {
    /// 平台字符串 → 枚举（`Display` / serde `lowercase` 的逆运算）。
    ///
    /// 全库唯一的字符串解析口径：`track_from_row`、收藏变更落库、启动对账
    /// 都用它，避免各处各抄一份 match 而漏掉某个平台。
    /// **`local` 是合法值**（本地曲目）：它既要能落进 `liked_songs`，
    /// 也要能从云端收下来（手机端收藏的本地歌会带 `platform = "local"`）。
    /// 认不出来返回 `None`，由调用方决定是跳过还是报错。
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "wyy" => Some(SourceId::Wyy),
            "qq" => Some(SourceId::Qq),
            "kw" => Some(SourceId::Kw),
            "kg" => Some(SourceId::Kg),
            "local" => Some(SourceId::Local),
            _ => None,
        }
    }
}

/// 音质固定 `128 / 320 / flac`（serde 值直接对齐前端字符串）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Quality {
    #[serde(rename = "128")]
    Standard,
    #[serde(rename = "320")]
    High,
    #[serde(rename = "flac")]
    Lossless,
}

/// 统一 Track 模型。`platform` 字段名与 Astral 收藏接口 / 移动端保持一致。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub platform: SourceId,
    pub title: String,
    pub singer: String,
    pub album: String,
    pub pic_url: String,
    /// 秒（移动端同口径）
    #[serde(default)]
    pub duration: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub music_id: Option<String>,
}

/// Provider 错误分类（DESIGN §6.4 / §6.10）：serde tag=kind 供前端区分展示。
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProviderError {
    #[error("网络请求失败: {message}")]
    Network { message: String },
    #[error("请求超时")]
    Timeout { after_ms: u64 },
    #[error("响应格式异常: {message}")]
    Decode { message: String },
    #[error("音源限流或风控")]
    RateLimited,
    #[error("该能力不支持")]
    Unsupported,
    #[error("无可用播放地址")]
    NoPlayableUrl,
    #[error("无结果")]
    Empty,
}

pub type ProviderResult<T> = Result<T, ProviderError>;

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归：`local` 必须是可解析平台。
    /// 历史缺陷：收藏变更落库与启动对账把 `local` 当未知平台整条跳过，
    /// 导致手机端收藏的本地歌永远进不了 PC 的收藏表。
    #[test]
    fn parse_accepts_local() {
        assert_eq!(SourceId::parse("local"), Some(SourceId::Local));
    }

    #[test]
    fn parse_rejects_unknown() {
        assert_eq!(SourceId::parse(""), None);
        assert_eq!(SourceId::parse("netease"), None);
        assert_eq!(
            SourceId::parse("Local"),
            None,
            "大小写敏感，与 Display 一致"
        );
    }

    /// parse 与 Display 必须互为逆运算（否则落库键与回读解析会错位）。
    #[test]
    fn parse_round_trips_display() {
        for id in [
            SourceId::Wyy,
            SourceId::Qq,
            SourceId::Kw,
            SourceId::Kg,
            SourceId::Local,
        ] {
            assert_eq!(SourceId::parse(&id.to_string()), Some(id));
        }
    }
}
