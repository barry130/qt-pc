//! Provider 统一数据模型（DESIGN §6.6 / §7.2）
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

impl Quality {
    /// 网易云官方接口 br 值（对应移动端 wyyBrValue）
    pub fn wyy_br_value(self) -> u32 {
        match self {
            Quality::Standard => 128_000,
            Quality::High => 320_000,
            Quality::Lossless => 999_000,
        }
    }

    /// gdstudio 代理 br 参数（对应移动端 wyyBrParam：128 / 320 / 999）
    pub fn wyy_br_param(self) -> &'static str {
        match self {
            Quality::Standard => "128",
            Quality::High => "320",
            Quality::Lossless => "999",
        }
    }
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

/// 歌词 + 翻译（当前仅 wyy 提供翻译）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lyric {
    pub lrc: String,
    pub translation: String,
}

/// 播放地址（DESIGN §6.7）：fetchedAt / expiresAt 均为 epoch ms。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayUrl {
    pub url: String,
    pub quality: Quality,
    pub fetched_at: u64,
    pub expires_at: u64,
}

// ---------- 发现类统一模型（DESIGN §6.6） ----------

/// 歌单广场分类。`group` 为音源侧分组名（如 wyy 的「语种 / 风格 / 场景」），
/// 音源不分组时为 None（前端按 group 归并渲染）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistCategory {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

/// 歌单（广场卡片 / 详情）。`playCount` 沿用移动端「已格式化」字符串口径
/// （如 "1.2万"），不做数值化，避免各音源单位不一致导致误显示。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub platform: SourceId,
    pub name: String,
    pub pic_url: String,
    pub play_count: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 仅详情接口填充；列表接口保持 None（列表页不该拉全量歌曲）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracks: Option<Vec<Track>>,
}

/// 歌手（搜索歌手结果）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artist {
    pub id: String,
    pub platform: SourceId,
    pub name: String,
    pub pic_url: String,
}

/// 专辑（搜索专辑结果）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: String,
    pub platform: SourceId,
    pub name: String,
    pub artist: String,
    pub pic_url: String,
}

/// 榜单（排行榜列表项）。`description` 通常是更新频率 / 简介。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chart {
    pub id: String,
    pub platform: SourceId,
    pub name: String,
    pub pic_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// MV / 视频。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Video {
    pub id: String,
    pub platform: SourceId,
    pub name: String,
    pub pic_url: String,
    pub singer: String,
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

impl ProviderError {
    /// reqwest 错误归类：超时 / 网络
    pub fn from_reqwest(err: &reqwest::Error) -> Self {
        if err.is_timeout() {
            ProviderError::Timeout { after_ms: 10_000 }
        } else {
            ProviderError::Network {
                message: err.to_string(),
            }
        }
    }
}
