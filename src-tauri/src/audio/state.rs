//! PlaybackState 全量快照（DESIGN §7.2）：语义变化才推送，高频进度走 position-changed。

use serde::{Deserialize, Serialize};

use crate::provider::types::SourceId;
use crate::provider::types::Track;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackStatus {
    Stopped,
    Loading,
    Buffering,
    Playing,
    Paused,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlayMode {
    Sequence,
    ListLoop,
    OneLoop,
    Random,
}

/// serde 值对齐前端/移动端 "128" / "320" / "flac"（DESIGN §7.2 注）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Quality {
    #[serde(rename = "128")]
    Standard,
    #[serde(rename = "320")]
    High,
    #[serde(rename = "flac")]
    Lossless,
}

impl From<crate::provider::types::Quality> for Quality {
    fn from(q: crate::provider::types::Quality) -> Self {
        match q {
            crate::provider::types::Quality::Standard => Quality::Standard,
            crate::provider::types::Quality::High => Quality::High,
            crate::provider::types::Quality::Lossless => Quality::Lossless,
        }
    }
}

impl Quality {
    pub fn into_provider(self) -> crate::provider::types::Quality {
        match self {
            Quality::Standard => crate::provider::types::Quality::Standard,
            Quality::High => crate::provider::types::Quality::High,
            Quality::Lossless => crate::provider::types::Quality::Lossless,
        }
    }
}

/// 全量快照，字段与 DESIGN §7.2 一一对应。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStateSnapshot {
    pub track_id: Option<String>,
    pub source_id: Option<SourceId>,
    pub status: PlaybackStatus,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub buffered_ms: u64,
    pub volume: f32,
    pub muted: bool,
    pub play_mode: PlayMode,
    pub quality: Quality,
    pub queue_index: Option<usize>,
    pub queue_len: usize,
    pub is_local: bool,
    pub url_fetched_at: Option<u64>,
    /// 当前实际播放地址（在线曲目才有；前端播放条调试面板展示用）
    pub play_url: Option<String>,
    pub error: Option<String>,
    pub sleep_timer_ms: Option<u64>,
    /// 当前曲目（渲染播放条直接用，避免前端二次查询）
    pub track: Option<Track>,
    /// 当前音频输出设备名（设置页显示用）
    pub output_device: String,
}

impl Default for PlaybackStateSnapshot {
    fn default() -> Self {
        Self {
            track_id: None,
            source_id: None,
            status: PlaybackStatus::Stopped,
            position_ms: 0,
            duration_ms: 0,
            buffered_ms: 0,
            volume: 0.8,
            muted: false,
            play_mode: PlayMode::ListLoop,
            quality: Quality::High,
            queue_index: None,
            queue_len: 0,
            is_local: false,
            url_fetched_at: None,
            play_url: None,
            error: None,
            sleep_timer_ms: None,
            track: None,
            output_device: String::new(),
        }
    }
}
