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
