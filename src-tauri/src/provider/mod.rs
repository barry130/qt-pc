//! 音源适配层（DESIGN §6.4）
//!
//! `MusicProvider` trait 使用 `#[async_trait]` 保证对象安全（可 `Arc<dyn MusicProvider>`），
//! 所有方法返回 `Result<T, ProviderError>`，不返回裸 Vec / Option，
//! 使「没搜到（Empty）」与「音源挂了（Network/Timeout）」可区分。

pub mod kg;
pub mod kw;
pub mod md5;
pub mod qq;
pub mod registry;
pub mod types;
pub mod wyy;

pub use kg::KgProvider;
pub use kw::KwProvider;
pub use qq::QqProvider;
pub use registry::ProviderRegistry;
pub use types::{
    Album, Artist, Chart, Lyric, Playlist, PlaylistCategory, ProviderError, ProviderResult,
    Quality, SourceId, Track, Video,
};
pub use wyy::WyyProvider;

use async_trait::async_trait;
use serde::Serialize;

/// Provider 能力位（DESIGN §6.4）：前端用于灰置不支持的入口。
/// M0 只实现 wyy 的 search / play_url / lyric，其余能力位为 false。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub playlist_categories: bool,
    pub recommendations: bool,
    pub latest: bool,
    pub charts: bool,
    pub chart_detail: bool,
    pub playlist_detail: bool,
    pub search_song: bool,
    pub search_playlist: bool,
    pub search_artist: bool,
    pub search_album: bool,
    pub artist_songs: bool,
    pub mv_list: bool,
    pub mv_url: bool,
    pub lyric: bool,
    pub lyric_translation: bool,
    pub play_url: bool,
    pub cover: bool,
}

impl ProviderCapabilities {
    /// 全 false 基线（各 Provider 只打开自己支持的能力位）
    pub fn none() -> Self {
        Self {
            playlist_categories: false,
            recommendations: false,
            latest: false,
            charts: false,
            chart_detail: false,
            playlist_detail: false,
            search_song: false,
            search_playlist: false,
            search_artist: false,
            search_album: false,
            artist_songs: false,
            mv_list: false,
            mv_url: false,
            lyric: false,
            lyric_translation: false,
            play_url: false,
            cover: false,
        }
    }
}

/// Provider HTTP 响应统一状态检查（429 → RateLimited，非 2xx → Network）。
pub(crate) async fn check_status(resp: reqwest::Response) -> ProviderResult<reqwest::Response> {
    let status = resp.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(ProviderError::RateLimited);
    }
    if !status.is_success() {
        return Err(ProviderError::Network {
            message: format!("HTTP {status}"),
        });
    }
    Ok(resp)
}

/// 跨源播放兜底（移动端 `playFromSource` 移植）：按 歌名+歌手 在目标源搜 3 首，
/// 逐个取可播放地址，全部失败返回 None（不抛错）。
/// 只允许对 kw / wyy 调用（两者的 `play_url` 是无兜底的核心实现，不会递归）。
///
/// 返回命中曲目而不只是 URL：换源后歌词要跟着新源走（目标源按歌名搜到的可能
/// 是不同录音版本，歌词按原源取会对不上），由 `record_source_fallback` 记录
/// 「实际播放地址 → 命中曲目」，get_lyric 据此换源取词。
pub(crate) async fn play_via_source(
    provider: &dyn MusicProvider,
    title: &str,
    singer: &str,
    quality: Quality,
) -> Option<(String, Track)> {
    let keyword = if singer.is_empty() {
        title.to_string()
    } else {
        format!("{title} {singer}")
    };
    let Ok(tracks) = provider.search_tracks(&keyword, 1, 3).await else {
        return None;
    };
    for track in &tracks {
        if let Ok(url) = provider.play_url(track, quality).await {
            return Some((url, track.clone()));
        }
    }
    None
}

/// 换源记录：实际播放地址 → 命中的曲目（目标源）。
/// URL 作键天然区分同名曲目的不同取址结果；表满清空重来（正常播放远达不到上限）。
fn source_fallbacks() -> &'static std::sync::Mutex<std::collections::HashMap<String, Track>> {
    static MAP: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Track>>> =
        std::sync::OnceLock::new();
    MAP.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// 换源兜底命中时调用（play_via_source 的调用方负责记录）
pub(crate) fn record_source_fallback(url: &str, matched: &Track) {
    let mut map = source_fallbacks().lock().unwrap();
    if map.len() >= 128 {
        map.clear();
    }
    map.insert(url.to_string(), matched.clone());
}

/// 查「这个播放地址实际是换源到哪首歌」。None = 原生源，无需换源取词
pub(crate) fn source_fallback_for(url: &str) -> Option<Track> {
    source_fallbacks().lock().unwrap().get(url).cloned()
}

#[async_trait]
pub trait MusicProvider: Send + Sync {
    fn id(&self) -> SourceId;
    fn name(&self) -> &'static str;
    fn capabilities(&self) -> ProviderCapabilities;

    // ---------- 发现类能力（DESIGN §6.4 / §6.5，M5） ----------
    // 默认 Unsupported：各 Provider 按自身能力覆盖，未覆盖的能力位保持 false。

    /// 歌单广场分类（如 华语 / 流行 / 摇滚；wyy 带分组）
    async fn playlist_categories(&self) -> ProviderResult<Vec<PlaylistCategory>> {
        Err(ProviderError::Unsupported)
    }

    /// 按分类取推荐歌单（category = None 取全部/热门）
    async fn recommendations(
        &self,
        category: Option<&str>,
        page: u32,
    ) -> ProviderResult<Vec<Playlist>> {
        let _ = (category, page);
        Err(ProviderError::Unsupported)
    }

    /// 新歌速递
    async fn latest(&self, limit: u32, offset: u32) -> ProviderResult<Vec<Track>> {
        let _ = (limit, offset);
        Err(ProviderError::Unsupported)
    }

    /// 排行榜列表
    async fn charts(&self) -> ProviderResult<Vec<Chart>> {
        Err(ProviderError::Unsupported)
    }

    /// 榜单详情（曲目分页）
    async fn chart_detail(
        &self,
        chart: &Chart,
        page: u32,
        size: u32,
    ) -> ProviderResult<Vec<Track>> {
        let _ = (chart, page, size);
        Err(ProviderError::Unsupported)
    }

    /// 歌单详情（含曲目分页）
    async fn playlist(&self, id: &str, page: u32, size: u32) -> ProviderResult<Playlist> {
        let _ = (id, page, size);
        Err(ProviderError::Unsupported)
    }

    /// 搜索热词
    async fn hot_words(&self) -> ProviderResult<Vec<String>> {
        Err(ProviderError::Unsupported)
    }

    /// MV 列表
    async fn videos(&self, page: u32, size: u32) -> ProviderResult<Vec<Video>> {
        let _ = (page, size);
        Err(ProviderError::Unsupported)
    }

    /// 歌曲搜索（M0：wyy /api/cloudsearch/pc）
    async fn search_tracks(&self, kw: &str, page: u32, size: u32)
        -> ProviderResult<Vec<Track>>;

    /// 搜索歌单（云搜索 type=1000）
    async fn search_playlists(
        &self,
        kw: &str,
        page: u32,
        size: u32,
    ) -> ProviderResult<Vec<Playlist>> {
        let _ = (kw, page, size);
        Err(ProviderError::Unsupported)
    }

    /// 搜索歌手（云搜索 type=100）
    async fn search_artists(
        &self,
        kw: &str,
        page: u32,
        size: u32,
    ) -> ProviderResult<Vec<Artist>> {
        let _ = (kw, page, size);
        Err(ProviderError::Unsupported)
    }

    /// 搜索专辑（云搜索 type=10）
    async fn search_albums(
        &self,
        kw: &str,
        page: u32,
        size: u32,
    ) -> ProviderResult<Vec<Album>> {
        let _ = (kw, page, size);
        Err(ProviderError::Unsupported)
    }

    /// 歌手热门歌曲（按歌手名，与移动端 artistSongs 口径一致）
    async fn artist_songs(
        &self,
        name: &str,
        page: u32,
        size: u32,
    ) -> ProviderResult<Vec<Track>> {
        let _ = (name, page, size);
        Err(ProviderError::Unsupported)
    }

    /// 播放地址解析（M0：gdstudio 代理 → 官方 enhance/player/url）
    async fn play_url(&self, track: &Track, quality: Quality) -> ProviderResult<String>;

    /// 歌词 + 翻译（M0：wyy /api/song/lyric）
    async fn lyric(&self, track: &Track) -> ProviderResult<Lyric>;

    /// MV/视频播放地址（quality：auto / hd / low，与移动端 videoUrl 一致）
    async fn video_url(&self, id: &str, quality: &str) -> ProviderResult<String> {
        let _ = (id, quality);
        Err(ProviderError::Unsupported)
    }

    /// 封面补全（picUrl 为空时按歌名+歌手搜索兜底）
    async fn cover(&self, track: &Track) -> ProviderResult<String>;
}
