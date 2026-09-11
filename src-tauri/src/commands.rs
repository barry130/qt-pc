//! Tauri 命令函数，与 lib.rs 分离以规避宏展开冲突。

use std::sync::Arc;

use crate::astral::AuthSession;
use crate::audio::engine::AudioCmd;
use crate::audio::state::PlayMode;
use crate::provider::types::{
    Album, Artist, Chart, Playlist, PlaylistCategory, Quality, SourceId, Track, Video,
};
use crate::provider::ProviderError;
use crate::{quality_str, resolve_play_url_with};
use tauri::State;

use crate::AppState;
use crate::db::store::{DownloadTask, HistoryItem, PlaylistSummary};

// ---------- 音源 ----------

#[tauri::command(rename = "search_music")]
pub async fn cmd_search_music(
    state: State<'_, AppState>,
    keyword: String,
    source: SourceId,
    page: u32,
    size: u32,
) -> Result<Vec<Track>, ProviderError> {
    let provider = state.registry.get(source)?;
    provider
        .search_tracks(&keyword, page.max(1), size.clamp(1, 30))
        .await
}

#[tauri::command(rename = "get_play_url")]
pub async fn cmd_get_play_url(
    state: State<'_, AppState>,
    track: Track,
    quality: Quality,
) -> Result<crate::provider::types::PlayUrl, ProviderError> {
    let (url, fetched_at) =
        resolve_play_url_with(&state.registry, &state.url_cache, &track, quality).await?;
    let ttl = 10 * 60 * 1000u64;
    Ok(crate::provider::types::PlayUrl {
        url,
        quality,
        fetched_at,
        expires_at: fetched_at + ttl,
    })
}

#[tauri::command(rename = "get_lyric")]
pub async fn cmd_get_lyric(
    state: State<'_, AppState>,
    track: Track,
) -> Result<crate::provider::types::Lyric, ProviderError> {
    let provider = state.registry.get(track.platform)?;
    provider.lyric(&track).await
}

/// MV/视频播放地址（quality：auto / hd / low）。前端用 qtres://mv/<base64url> 加载（§6.13 Range 透传）。
#[tauri::command(rename = "get_video_url")]
pub async fn cmd_get_video_url(
    state: State<'_, AppState>,
    source: SourceId,
    video_id: String,
    quality: String,
) -> Result<String, ProviderError> {
    let provider = state.registry.get(source)?;
    provider.video_url(&video_id, &quality).await
}

// ---------- 发现类能力（DESIGN §6.5 IPC 名映射，M5 / M6） ----------
//
// 聚合命令（get_all_* / search_all_*）按 §6.4 要点 5：
// 单源 Err 只记日志并跳过，全部失败才向前端返回 Empty。

/// 聚合辅助：取单源 provider 并调用；失败只记日志（不向上抛）。
async fn collect<T, F>(
    source: SourceId,
    fut: F,
) -> Option<Vec<T>>
where
    F: std::future::Future<Output = Result<Vec<T>, ProviderError>>,
{
    match fut.await {
        Ok(v) if !v.is_empty() => Some(v),
        Ok(_) => None,
        Err(e) => {
            log::warn!("[discovery] {source} 聚合失败: {e}");
            None
        }
    }
}

#[tauri::command(rename = "get_playlist_categories")]
pub async fn cmd_get_playlist_categories(
    state: State<'_, AppState>,
    source: SourceId,
) -> Result<Vec<PlaylistCategory>, ProviderError> {
    let provider = state.registry.get(source)?;
    provider.playlist_categories().await
}

#[tauri::command(rename = "get_recommendations")]
pub async fn cmd_get_recommendations(
    state: State<'_, AppState>,
    source: SourceId,
    category: Option<String>,
    page: u32,
) -> Result<Vec<Playlist>, ProviderError> {
    let provider = state.registry.get(source)?;
    provider
        .recommendations(category.as_deref(), page.max(1))
        .await
}

#[tauri::command(rename = "get_latest_songs")]
pub async fn cmd_get_latest_songs(
    state: State<'_, AppState>,
    source: SourceId,
    limit: u32,
    offset: u32,
) -> Result<Vec<Track>, ProviderError> {
    let provider = state.registry.get(source)?;
    provider.latest(limit.clamp(1, 50), offset).await
}

/// 聚合：四源新歌速递
#[tauri::command(rename = "get_all_latest_songs")]
pub async fn cmd_get_all_latest_songs(
    state: State<'_, AppState>,
    limit: u32,
    offset: u32,
) -> Result<Vec<Track>, ProviderError> {
    let limit = limit.clamp(1, 50);
    let (a, b, c, d) = tokio::join!(
        collect(SourceId::Wyy, call_latest(&state, SourceId::Wyy, limit, offset)),
        collect(SourceId::Qq, call_latest(&state, SourceId::Qq, limit, offset)),
        collect(SourceId::Kw, call_latest(&state, SourceId::Kw, limit, offset)),
        collect(SourceId::Kg, call_latest(&state, SourceId::Kg, limit, offset)),
    );
    merge_all([a, b, c, d])
}

async fn call_latest(
    state: &AppState,
    source: SourceId,
    limit: u32,
    offset: u32,
) -> Result<Vec<Track>, ProviderError> {
    let provider = state.registry.get(source)?;
    provider.latest(limit, offset).await
}

#[tauri::command(rename = "get_charts")]
pub async fn cmd_get_charts(
    state: State<'_, AppState>,
    source: SourceId,
) -> Result<Vec<Chart>, ProviderError> {
    let provider = state.registry.get(source)?;
    provider.charts().await
}

/// 聚合：四源排行榜
#[tauri::command(rename = "get_all_charts")]
pub async fn cmd_get_all_charts(
    state: State<'_, AppState>,
) -> Result<Vec<Chart>, ProviderError> {
    let (a, b, c, d) = tokio::join!(
        collect(SourceId::Wyy, call_charts(&state, SourceId::Wyy)),
        collect(SourceId::Qq, call_charts(&state, SourceId::Qq)),
        collect(SourceId::Kw, call_charts(&state, SourceId::Kw)),
        collect(SourceId::Kg, call_charts(&state, SourceId::Kg)),
    );
    merge_all([a, b, c, d])
}

async fn call_charts(
    state: &AppState,
    source: SourceId,
) -> Result<Vec<Chart>, ProviderError> {
    let provider = state.registry.get(source)?;
    provider.charts().await
}

/// 榜单详情：chart 携带 platform + id，据此分发到对应音源
#[tauri::command(rename = "get_chart_detail")]
pub async fn cmd_get_chart_detail(
    state: State<'_, AppState>,
    chart: Chart,
    page: u32,
    size: u32,
) -> Result<Vec<Track>, ProviderError> {
    let provider = state.registry.get(chart.platform)?;
    provider
        .chart_detail(&chart, page.max(1), size.clamp(1, 100))
        .await
}

#[tauri::command(rename = "get_playlist_detail")]
pub async fn cmd_get_playlist_detail(
    state: State<'_, AppState>,
    source: SourceId,
    id: String,
    page: u32,
    size: u32,
) -> Result<Playlist, ProviderError> {
    let provider = state.registry.get(source)?;
    provider.playlist(&id, page.max(1), size.clamp(1, 100)).await
}

#[tauri::command(rename = "get_hot_words")]
pub async fn cmd_get_hot_words(
    state: State<'_, AppState>,
    source: SourceId,
) -> Result<Vec<String>, ProviderError> {
    let provider = state.registry.get(source)?;
    provider.hot_words().await
}

/// 聚合：四源热词（字符串列表，去重保持顺序）
#[tauri::command(rename = "get_all_hot_words")]
pub async fn cmd_get_all_hot_words(
    state: State<'_, AppState>,
) -> Result<Vec<String>, ProviderError> {
    let (a, b, c, d) = tokio::join!(
        call_hot_words(&state, SourceId::Wyy),
        call_hot_words(&state, SourceId::Qq),
        call_hot_words(&state, SourceId::Kw),
        call_hot_words(&state, SourceId::Kg),
    );
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for r in [a, b, c, d] {
        match r {
            Ok(words) => {
                for w in words {
                    if seen.insert(w.clone()) {
                        out.push(w);
                    }
                }
            }
            Err(e) => log::warn!("[discovery] 热词聚合失败: {e}"),
        }
    }
    if out.is_empty() {
        return Err(ProviderError::Empty);
    }
    Ok(out)
}

async fn call_hot_words(
    state: &AppState,
    source: SourceId,
) -> Result<Vec<String>, ProviderError> {
    let provider = state.registry.get(source)?;
    provider.hot_words().await
}

#[tauri::command(rename = "search_playlists")]
pub async fn cmd_search_playlists(
    state: State<'_, AppState>,
    source: SourceId,
    keyword: String,
    page: u32,
    size: u32,
) -> Result<Vec<Playlist>, ProviderError> {
    let provider = state.registry.get(source)?;
    provider
        .search_playlists(&keyword, page.max(1), size.clamp(1, 30))
        .await
}

#[tauri::command(rename = "search_artists")]
pub async fn cmd_search_artists(
    state: State<'_, AppState>,
    source: SourceId,
    keyword: String,
    page: u32,
    size: u32,
) -> Result<Vec<Artist>, ProviderError> {
    let provider = state.registry.get(source)?;
    provider
        .search_artists(&keyword, page.max(1), size.clamp(1, 30))
        .await
}

#[tauri::command(rename = "search_albums")]
pub async fn cmd_search_albums(
    state: State<'_, AppState>,
    source: SourceId,
    keyword: String,
    page: u32,
    size: u32,
) -> Result<Vec<Album>, ProviderError> {
    let provider = state.registry.get(source)?;
    provider
        .search_albums(&keyword, page.max(1), size.clamp(1, 30))
        .await
}

#[tauri::command(rename = "get_artist_songs")]
pub async fn cmd_get_artist_songs(
    state: State<'_, AppState>,
    source: SourceId,
    name: String,
    page: u32,
    size: u32,
) -> Result<Vec<Track>, ProviderError> {
    let provider = state.registry.get(source)?;
    provider
        .artist_songs(&name, page.max(1), size.clamp(1, 50))
        .await
}

#[tauri::command(rename = "get_videos")]
pub async fn cmd_get_videos(
    state: State<'_, AppState>,
    source: SourceId,
    page: u32,
    size: u32,
) -> Result<Vec<Video>, ProviderError> {
    let provider = state.registry.get(source)?;
    provider.videos(page.max(1), size.clamp(1, 30)).await
}

/// 聚合：四源歌曲搜索（搜索页「全部」页签）
#[tauri::command(rename = "search_all_music_sources")]
pub async fn cmd_search_all_music_sources(
    state: State<'_, AppState>,
    keyword: String,
    page: u32,
    size: u32,
) -> Result<Vec<Track>, ProviderError> {
    let page = page.max(1);
    let size = size.clamp(1, 30);
    let (a, b, c, d) = tokio::join!(
        collect(SourceId::Wyy, call_search(&state, SourceId::Wyy, &keyword, page, size)),
        collect(SourceId::Qq, call_search(&state, SourceId::Qq, &keyword, page, size)),
        collect(SourceId::Kw, call_search(&state, SourceId::Kw, &keyword, page, size)),
        collect(SourceId::Kg, call_search(&state, SourceId::Kg, &keyword, page, size)),
    );
    merge_all([a, b, c, d])
}

async fn call_search(
    state: &AppState,
    source: SourceId,
    keyword: &str,
    page: u32,
    size: u32,
) -> Result<Vec<Track>, ProviderError> {
    let provider = state.registry.get(source)?;
    provider.search_tracks(keyword, page, size).await
}

/// 封面补全（picUrl 为空时按歌名 + 歌手搜索兜底，DESIGN §6.5 get_track_cover）
#[tauri::command(rename = "get_track_cover")]
pub async fn cmd_get_track_cover(
    state: State<'_, AppState>,
    track: Track,
) -> Result<String, ProviderError> {
    let provider = state.registry.get(track.platform)?;
    provider.cover(&track).await
}

/// 把四个源的聚合结果合并；全空视为无结果（§6.4 要点 5）
fn merge_all<T>(parts: [Option<Vec<T>>; 4]) -> Result<Vec<T>, ProviderError> {
    let mut out = Vec::new();
    for mut v in parts.into_iter().flatten() {
        out.append(&mut v);
    }
    if out.is_empty() {
        Err(ProviderError::Empty)
    } else {
        Ok(out)
    }
}

#[tauri::command(rename = "invalidate_play_url")]
pub async fn cmd_invalidate_play_url(
    state: State<'_, AppState>,
    track: Track,
    quality: Quality,
) -> Result<(), String> {
    let key = crate::provider::registry::PlayUrlCache::cache_key(
        &track.platform.to_string(),
        &track.id,
        quality_str(quality),
    );
    state.url_cache.invalidate(&key);
    Ok(())
}

// ---------- 播放控制 ----------

/// 单曲播放（队列替换为 [track]）；列表播放请用 play_queue。
#[tauri::command(rename = "play_track")]
pub async fn cmd_play_track(
    state: State<'_, AppState>,
    track: Track,
    quality: Quality,
) -> Result<(), ProviderError> {
    state.engine.send(AudioCmd::SetQueue {
        tracks: vec![track.clone()],
        index: 0,
    });
    // SetQueue 已含取址链路（play_queue_track），quality 这里仅作缓存键一致性
    let _ = quality;
    Ok(())
}

/// 设置「默认播放音质」（设置页入口，DESIGN §7.3）：写进 settings 重启后保持，
/// 并对当前曲目立即生效（当前这首被单独指定过音质时除外）。
#[tauri::command(rename = "set_default_quality")]
pub async fn cmd_set_default_quality(
    state: State<'_, AppState>,
    quality: crate::audio::state::Quality,
) -> Result<(), String> {
    state.engine.send(AudioCmd::SetDefaultQuality { quality });
    Ok(())
}

/// 只改当前这首的音质（播放条入口）：不写 settings，切到别的歌自动回到默认音质。
#[tauri::command(rename = "set_track_quality")]
pub async fn cmd_set_track_quality(
    state: State<'_, AppState>,
    quality: crate::audio::state::Quality,
) -> Result<(), String> {
    state.engine.send(AudioCmd::SetTrackQuality { quality });
    Ok(())
}

/// 列表入队并播放 startIndex（DESIGN §11.2 play_queue）
#[tauri::command(rename = "play_queue")]
pub async fn cmd_play_queue(
    state: State<'_, AppState>,
    tracks: Vec<Track>,
    start_index: u32,
) -> Result<(), String> {
    if tracks.is_empty() {
        return Err("队列为空".into());
    }
    state.engine.send(AudioCmd::SetQueue {
        tracks,
        index: start_index as usize,
    });
    Ok(())
}

#[tauri::command(rename = "play_at")]
pub async fn cmd_play_at(state: State<'_, AppState>, index: u32) -> Result<(), String> {
    state.engine.send(AudioCmd::PlayAt(index as usize));
    Ok(())
}

#[tauri::command(rename = "next")]
pub async fn cmd_next(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.send(AudioCmd::Next);
    Ok(())
}

#[tauri::command(rename = "previous")]
pub async fn cmd_previous(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.send(AudioCmd::Previous);
    Ok(())
}

#[tauri::command(rename = "set_play_mode")]
pub async fn cmd_set_play_mode(
    state: State<'_, AppState>,
    mode: PlayMode,
) -> Result<(), String> {
    state.engine.send(AudioCmd::SetPlayMode(mode));
    Ok(())
}

#[tauri::command(rename = "get_queue")]
pub async fn cmd_get_queue(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let q = state.engine.queue_snapshot();
    Ok(serde_json::json!({
        "tracks": q.tracks,
        "index": q.index.map(|i| i as u32),
    }))
}

#[tauri::command(rename = "clear_queue")]
pub async fn cmd_clear_queue(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.send(AudioCmd::ClearQueue);
    Ok(())
}

// ---------- 基础控制 ----------

#[tauri::command(rename = "set_volume")]
pub async fn cmd_set_volume(state: State<'_, AppState>, volume: f32) -> Result<(), String> {
    state.engine.send(AudioCmd::SetVolume(volume));
    Ok(())
}

#[tauri::command(rename = "set_muted")]
pub async fn cmd_set_muted(state: State<'_, AppState>, muted: bool) -> Result<(), String> {
    state.engine.send(AudioCmd::SetMuted(muted));
    Ok(())
}

#[tauri::command(rename = "get_playback_state")]
pub async fn cmd_get_playback_state(
    state: State<'_, AppState>,
) -> Result<crate::audio::state::PlaybackStateSnapshot, String> {
    Ok(state.engine.snapshot())
}

/// 恢复上次播放现场（DESIGN §8.3 / §11.2）：读 play_queue + settings，/// 引擎置队列、应用播放模式/音质/音量，并暂停态加载当前曲定位到上次进度。
/// 无存档返回 null。
#[tauri::command(rename = "restore_last_session")]
pub async fn cmd_restore_last_session(
    state: State<'_, AppState>,
) -> Result<Option<crate::audio::state::PlaybackStateSnapshot>, String> {
    // 引擎已有现场（比如正在播放）→ 直接回当前快照，**绝不**再发 RestoreSession
    // 把它替换成暂停态。WebView 重挂/重载时前端会重调本命令，
    // 之前版本会因此把播放中的歌打断并回一个"未在播放"的空快照。
    let current = state.engine.snapshot();
    if current.track_id.is_some() {
        return Ok(Some(current));
    }
    let Some(db) = &state.db else {
        return Ok(None);
    };
    let Some(session) = db.with(crate::db::store::load_session)? else {
        return Ok(None);
    };
    let s = &session.state;
    let play_mode: PlayMode = serde_json::from_value(serde_json::json!(s.play_mode))
        .unwrap_or(PlayMode::ListLoop);
    let quality: Quality = serde_json::from_value(serde_json::json!(s.quality))
        .unwrap_or(Quality::High);
    // 引擎应装上的那一曲（RestoreSession 处理完 track_id 就位）
    let expected_track = session.tracks.get(s.index).map(|t| t.id.clone());
    state.engine.send(AudioCmd::RestoreSession {
        tracks: session.tracks,
        index: s.index,
        position_ms: s.position_ms,
        play_mode,
        volume: s.volume.clamp(0.0, 1.0),
        muted: s.muted,
        quality: quality.into(),
    });
    // mpsc 是异步的：这里**立刻** snapshot 会拿到 track=null 的默认快照，
    // 前端拿它 applySnapshot 会把引擎刚推的带曲目事件盖掉 ——
    // 播放条从此停在「未在播放」而音频其实在响。等引擎把当前曲装上再回。
    let engine = state.engine.clone();
    let snap = tauri::async_runtime::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        loop {
            let cur = engine.snapshot();
            let loaded = match &expected_track {
                Some(id) => cur.track_id.as_deref() == Some(id.as_str()),
                None => true,
            };
            if loaded || std::time::Instant::now() >= deadline {
                break cur;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    })
    .await
    .map_err(|e| format!("等待恢复播放现场失败: {e}"))?;
    Ok(Some(snap))
}

#[tauri::command(rename = "pause")]
pub async fn cmd_pause(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.send(AudioCmd::Pause);
    Ok(())
}

#[tauri::command(rename = "resume")]
pub async fn cmd_resume(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.send(AudioCmd::Play);
    Ok(())
}

#[tauri::command(rename = "stop")]
pub async fn cmd_stop(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.send(AudioCmd::Stop);
    Ok(())
}

#[tauri::command(rename = "seek")]
pub async fn cmd_seek(state: State<'_, AppState>, position_ms: u64) -> Result<(), String> {
    state.engine.send(AudioCmd::Seek(position_ms));
    Ok(())
}

// ---------- 音频输出设备（蓝牙耳机 / HDMI 插拔时无缝切换） ----------

/// 枚举系统输出设备（设置页下拉用）。
#[tauri::command(rename = "list_output_devices")]
pub async fn cmd_list_output_devices() -> Result<Vec<String>, String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let mut names: Vec<String> = host
        .output_devices()
        .map_err(|e| e.to_string())?
        .filter_map(|d| d.description().ok().map(|desc| desc.name().to_string()))
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}

/// 切换输出设备。`name` 不传/空 = 跟随系统默认（插拔蓝牙自动跟随）；
/// 传入具体设备名 = 固定到该设备。切换时当前曲目从原进度无缝续播。
#[tauri::command(rename = "set_output_device")]
pub async fn cmd_set_output_device(
    state: State<'_, AppState>,
    name: Option<String>,
) -> Result<(), String> {
    state.engine.send(AudioCmd::SetOutputDevice { name });
    Ok(())
}

// ---------- 全局快捷键（DESIGN §14.2：可改键 / 可禁用） ----------

/// 当前生效的快捷键表（默认值 + 用户自定义 + 启用状态）。
#[tauri::command(rename = "list_shortcuts")]
pub async fn cmd_list_shortcuts(
    state: State<'_, AppState>,
) -> Result<Vec<crate::shortcuts::ShortcutEntry>, String> {
    let db = state.db.clone();
    let entries = tauri::async_runtime::spawn_blocking(move || {
        let entries: Vec<crate::shortcuts::ShortcutEntry> =
            crate::shortcuts::load_shortcuts(db.as_deref())
                .into_iter()
                .map(|(action, accelerator, enabled)| crate::shortcuts::ShortcutEntry {
                    id: action.id().to_string(),
                    accelerator,
                    enabled,
                })
                .collect();
        entries
    })
    .await
    .map_err(|e| format!("读取快捷键失败: {e}"))?;
    Ok(entries)
}

/// 保存快捷键配置（整份快照）并热重载：先注销旧的，再按新表注册。
#[tauri::command(rename = "save_shortcuts")]
pub async fn cmd_save_shortcuts(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    config: serde_json::Value,
) -> Result<Vec<crate::shortcuts::ShortcutEntry>, String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    let db = state.db.clone();
    let keymap = tauri::async_runtime::spawn_blocking(move || {
        let Some(db) = db else {
            return Err("数据库不可用".to_string());
        };
        crate::shortcuts::save_shortcuts(&db, &config)
    })
    .await
    .map_err(|e| format!("保存快捷键失败: {e}"))??;

    // 热重载：全量注销后按新表注册（注册失败的项只记日志）
    let gs = app.global_shortcut();
    if let Err(e) = gs.unregister_all() {
        log::warn!("[shortcuts] 重载时注销旧快捷键失败: {e}");
    }
    crate::shortcuts::register_shortcuts(&app, &keymap);

    Ok(keymap
        .into_iter()
        .map(|(action, accelerator, enabled)| crate::shortcuts::ShortcutEntry {
            id: action.id().to_string(),
            accelerator,
            enabled,
        })
        .collect())
}

// ---------- 外观偏好（DESIGN §9.2 AppearancePreference，存 settings 表） ----------

/// 读外观偏好；未设置过返回默认值（跟随系统 + 默认皮肤）。
#[tauri::command(rename = "get_appearance")]
pub async fn cmd_get_appearance(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let Some(db) = &state.db else {
        return Ok(default_appearance());
    };
    let saved = db.with(|c| {
        crate::db::store::get_setting(c, "appearance")
    })?;
    match saved {
        Some(json) => serde_json::from_str(&json)
            .map_err(|e| format!("外观偏好解析失败: {e}")),
        None => Ok(default_appearance()),
    }
}

/// 写外观偏好（整体覆盖，与 §9.2 的单对象结构一致）。
#[tauri::command(rename = "set_appearance")]
pub async fn cmd_set_appearance(
    state: State<'_, AppState>,
    appearance: serde_json::Value,
) -> Result<(), String> {
    let json = serde_json::to_string(&appearance)
        .map_err(|e| format!("外观偏好序列化失败: {e}"))?;
    let Some(db) = &state.db else {
        return Ok(()); // 数据库不可用时只保持本次会话内存值
    };
    db.with(|c| crate::db::store::set_setting(c, "appearance", &json))
}

fn default_appearance() -> serde_json::Value {
    serde_json::json!({
        "mode": "system",
        "skinId": "default",
        "followCoverColor": false,
        "reduceMotion": false,
        "fontScale": 1.0,
    })
}

// ---------- Astral：更新 / 消息 / 统计 / 反馈（DESIGN §15） ----------
// 平台参数固定：type=1103、channel=pc、ut=app-windows、X-Platform: windows（§15.2）

/// 从 settings 表读更新通道（§15.5 默认 stable）
fn update_channel(db: &Option<std::sync::Arc<crate::db::Database>>) -> String {
    db.as_ref()
        .and_then(|db| db.with(|c| crate::db::store::get_setting(c, "update_channel")).ok())
        .flatten()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "stable".to_string())
}

#[tauri::command(rename = "astral_app_update")]
pub async fn cmd_astral_app_update(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let channel = update_channel(&state.db);
    state
        .astral
        .app_update(crate::astral::version_code(), &channel)
        .await
}

#[tauri::command(rename = "astral_check_official_version")]
pub async fn cmd_astral_check_official_version(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state
        .astral
        .check_official_version(crate::astral::version_code(), crate::astral::version_name())
        .await
}

#[tauri::command(rename = "astral_github_accels")]
pub async fn cmd_astral_github_accels(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.astral.github_accels().await
}

/// 组装更新下载地址：GitHub 直链时自动探测加速节点选最快的拼接。
#[tauri::command(rename = "resolve_update_url")]
pub async fn cmd_resolve_update_url(
    state: State<'_, AppState>,
    download_url: String,
) -> Result<serde_json::Value, String> {
    let update = serde_json::json!({ "downloadUrl": download_url });
    Ok(state.astral.resolve_download_url(&update).await)
}

/// 下载更新包：流式写入 + `update-download-progress` 进度事件 + MD5/大小校验。
/// 完成返回落盘路径；启动安装器走 `run_update_installer`。
#[tauri::command(rename = "download_update_file")]
pub async fn cmd_download_update_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    url: String,
    md5: Option<String>,
    file_size: Option<i64>,
) -> Result<String, String> {
    let http_client = state.astral.http();
    let path =
        crate::astral::AstralClient::download_update_file(&http_client, &url, &app).await?;
    crate::astral::AstralClient::verify_update_file(&path, md5.as_deref(), file_size)?;
    Ok(path.to_string_lossy().to_string())
}

/// 运行已下载的更新安装器（脱离本进程，应用退出后安装器继续工作）。
#[tauri::command(rename = "run_update_installer")]
pub async fn cmd_run_update_installer(path: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW：不闪控制台
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &path])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("启动安装器失败: {e}"))?;
    Ok(())
}

/// 用系统默认浏览器打开链接（更新页 browserUrl 兜底）。
#[tauri::command(rename = "run_update_browser")]
pub async fn cmd_run_update_browser(url: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("cmd")
        .args(["/C", "start", "", &url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("打开浏览器失败: {e}"))?;
    Ok(())
}

#[tauri::command(rename = "astral_active_messages")]
pub async fn cmd_astral_active_messages(
    state: State<'_, AppState>,
    version_code: Option<i64>,
) -> Result<serde_json::Value, String> {
    let code = version_code.unwrap_or_else(crate::astral::version_code);
    state.astral.active_messages(code).await
}

#[tauri::command(rename = "astral_message_center")]
pub async fn cmd_astral_message_center(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.astral.message_center().await
}

#[tauri::command(rename = "astral_unread_count")]
pub async fn cmd_astral_unread_count(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.astral.unread_count().await
}

#[tauri::command(rename = "astral_ack_messages")]
pub async fn cmd_astral_ack_messages(
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<serde_json::Value, String> {
    state.astral.ack_messages(&ids).await
}

/// 匿名批量统计上报；失败时前端/调用方负责进入本地队列重试（§15.4）
#[tauri::command(rename = "astral_report_stats")]
pub async fn cmd_astral_report_stats(
    state: State<'_, AppState>,
    events: Vec<serde_json::Value>,
) -> Result<(), String> {
    state.astral.report_stats(events).await
}

#[tauri::command(rename = "astral_submit_feedback")]
pub async fn cmd_astral_submit_feedback(
    state: State<'_, AppState>,
    kind: String,
    title: String,
    content: String,
    contact: String,
) -> Result<serde_json::Value, String> {
    state.astral.submit_feedback(&kind, &title, &content, &contact).await
}

#[tauri::command(rename = "astral_my_feedback")]
pub async fn cmd_astral_my_feedback(
    state: State<'_, AppState>,
    page_num: i64,
    page_size: i64,
) -> Result<serde_json::Value, String> {
    state.astral.my_feedback(page_num, page_size).await
}

#[tauri::command(rename = "astral_public_feedback")]
pub async fn cmd_astral_public_feedback(
    state: State<'_, AppState>,
    page_num: i64,
    page_size: i64,
) -> Result<serde_json::Value, String> {
    state.astral.public_feedback(page_num, page_size).await
}

#[tauri::command(rename = "astral_feedback_detail")]
pub async fn cmd_astral_feedback_detail(
    state: State<'_, AppState>,
    id: i64,
) -> Result<serde_json::Value, String> {
    state.astral.feedback_detail(id).await
}

#[tauri::command(rename = "astral_feedback_replies")]
pub async fn cmd_astral_feedback_replies(
    state: State<'_, AppState>,
    id: i64,
) -> Result<serde_json::Value, String> {
    state.astral.feedback_replies(id).await
}

#[tauri::command(rename = "astral_reply_feedback")]
pub async fn cmd_astral_reply_feedback(
    state: State<'_, AppState>,
    feedback_id: i64,
    content: String,
) -> Result<serde_json::Value, String> {
    state.astral.reply_feedback(feedback_id, &content).await
}

/// 当前版本（§15.7 单一真值：Cargo 包版本派生，前端不手写）
#[tauri::command(rename = "get_app_version")]
pub async fn cmd_get_app_version() -> std::collections::HashMap<String, serde_json::Value> {
    let mut map = std::collections::HashMap::new();
    map.insert(
        "versionName".to_string(),
        serde_json::json!(crate::astral::version_name()),
    );
    map.insert(
        "versionCode".to_string(),
        serde_json::json!(crate::astral::version_code()),
    );
    map
}

// ---------- 桌面歌词窗口（DESIGN §4.2 / §10 / §11.7） ----------

#[tauri::command(rename = "show_desktop_lyric")]
pub async fn cmd_show_desktop_lyric(app: tauri::AppHandle) -> Result<crate::lyric_window::LyricWindowState, String> {
    crate::lyric_window::show(&app)
}

#[tauri::command(rename = "hide_desktop_lyric")]
pub async fn cmd_hide_desktop_lyric(app: tauri::AppHandle) -> Result<crate::lyric_window::LyricWindowState, String> {
    crate::lyric_window::hide(&app)
}

#[tauri::command(rename = "get_desktop_lyric_state")]
pub async fn cmd_get_desktop_lyric_state(
    app: tauri::AppHandle,
) -> Result<crate::lyric_window::LyricWindowState, String> {
    Ok(crate::lyric_window::get_state(&app))
}

#[tauri::command(rename = "set_desktop_lyric_locked")]
pub async fn cmd_set_desktop_lyric_locked(
    app: tauri::AppHandle,
    locked: bool,
) -> Result<crate::lyric_window::LyricWindowState, String> {
    crate::lyric_window::set_locked(&app, locked)
}

#[tauri::command(rename = "set_desktop_lyric_style")]
pub async fn cmd_set_desktop_lyric_style(
    app: tauri::AppHandle,
    patch: serde_json::Value,
) -> Result<crate::lyric_window::LyricWindowState, String> {
    crate::lyric_window::set_style(&app, patch)
}

#[tauri::command(rename = "set_desktop_lyric_bounds")]
pub async fn cmd_set_desktop_lyric_bounds(
    app: tauri::AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<crate::lyric_window::LyricWindowState, String> {
    crate::lyric_window::set_bounds(&app, x, y, width, height)
}

#[tauri::command(rename = "reset_desktop_lyric")]
pub async fn cmd_reset_desktop_lyric(
    app: tauri::AppHandle,
) -> Result<crate::lyric_window::LyricWindowState, String> {
    crate::lyric_window::reset(&app)
}

// ---------- 本地音乐库（DESIGN §13） ----------
//
// 约定：本地曲目 `Track.id` = 音频文件绝对路径，`platform = SourceId::Local`。
// 数据库不可用（state.db == None）时一律返回空结果，不 panic。

/// 扫描目录 → 读元数据 → 入库，返回库内全部本地曲目（DESIGN §13.1 / §13.2）。
/// 实际的文件遍历与元数据读取放进 `spawn_blocking`，避免阻塞 UI 线程。
#[tauri::command(rename = "scan_library")]
pub async fn cmd_scan_library(
    state: State<'_, AppState>,
    dirs: Vec<String>,
) -> Result<Vec<Track>, String> {
    // §13 安全：路径来自前端输入，先校验存在性
    for dir in &dirs {
        if !std::path::Path::new(dir).exists() {
            return Err(format!("目录不存在: {dir}"));
        }
    }
    let Some(db) = state.db.clone() else {
        log::warn!("[local] 数据库不可用，跳过本次扫描");
        return Ok(Vec::new());
    };
    // 命中的目录同时登记进 scan_dirs（幂等），保证清单与曲库一致
    let result = tauri::async_runtime::spawn_blocking(move || {
        let rows = crate::local::scan_dirs(&dirs);
        let present: std::collections::HashSet<String> =
            rows.iter().map(|r| r.path.clone()).collect();
        db.with(|conn| {
            crate::db::store::touch_scan_dirs(conn, &dirs)?;
            crate::db::store::upsert_local_tracks(conn, &rows)?;
            let missing = crate::db::store::mark_missing_local_tracks(conn, &dirs, &present)?;
            if missing > 0 {
                log::info!("[local] 标记缺失曲目 {missing} 条");
            }
            crate::db::store::query_local_tracks(conn)
        })
    })
    .await
    .map_err(|e| format!("扫描任务失败: {e}"))?;
    result
}

/// 读库内已有本地曲目（不扫磁盘）。
#[tauri::command(rename = "get_local_tracks")]
pub async fn cmd_get_local_tracks(state: State<'_, AppState>) -> Result<Vec<Track>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(crate::db::store::query_local_tracks)
    })
    .await
    .map_err(|e| format!("读取本地曲目失败: {e}"))?
}

/// 扫描目录清单（scan_dirs 表）。
#[tauri::command(rename = "get_scan_dirs")]
pub async fn cmd_get_scan_dirs(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || db.with(crate::db::store::list_scan_dirs))
        .await
        .map_err(|e| format!("读取扫描目录失败: {e}"))?
}

/// 添加扫描目录（已存在则幂等刷新 last_scan_at）。
#[tauri::command(rename = "add_scan_dir")]
pub async fn cmd_add_scan_dir(
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("目录不存在: {path}"));
    }
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::add_scan_dir(conn, &path))
    })
    .await
    .map_err(|e| format!("添加扫描目录失败: {e}"))?
}

/// 移除扫描目录（只删清单条目，不动已入库曲目）。
#[tauri::command(rename = "remove_scan_dir")]
pub async fn cmd_remove_scan_dir(
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::remove_scan_dir(conn, &path))
    })
    .await
    .map_err(|e| format!("移除扫描目录失败: {e}"))?
}

// ---------- 收藏 / 播放历史（DESIGN §5.3） ----------
// 播放历史由引擎在播放开始时自动写入（见 audio/engine.rs 的 spawn_resolve_and_load），
// 这里只提供读取与清空；收藏的写入走 add_favorite。

/// 收藏一首歌（幂等，重复收藏不报错）。
///
/// `pid` 指定归属歌单（歌单的永久全局唯一标识，创建后不变），**必传**：
/// 无默认歌单（v5 起无归属不加载），没传 pid 直接报参数错误。
/// 推送云端并上送 pid，云端 (uid, sid, platform) 唯一、pid 随之更新。
#[tauri::command(rename = "add_favorite")]
pub async fn cmd_add_favorite(
    state: State<'_, AppState>,
    track: Track,
    pid: Option<String>,
) -> Result<(), String> {
    let Some(pid) = pid.filter(|p| !p.is_empty()) else {
        return Err("收藏必须指定歌单（pid）".into());
    };
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    // 闭包要 move 走一份，推送还得用原值
    let for_db = track.clone();
    let target = pid.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::add_tracks_to_playlist(conn, &target, std::slice::from_ref(&for_db)))
    })
    .await
    .map_err(|e| format!("收藏失败: {e}"))?;
    result.map_err(|e| format!("收藏失败: {e}"))?;
    push_like_song(&state, &track, "add", Some(&pid)).await;
    Ok(())
}

/// 取消收藏，语义与 `add_favorite` 对称。云端 remove 不涉及 pid。
///
/// 多归属下的云端策略：摘的是主归属且还有其他归属 → push add(新主归属)，
/// 云端跟着切；摘光/整首取消 → push remove；只摘非主归属 → 云端无感。
#[tauri::command(rename = "remove_favorite")]
pub async fn cmd_remove_favorite(
    state: State<'_, AppState>,
    track: Track,
    pid: Option<String>,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    let for_db = track.clone();
    let target = pid.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| {
            crate::db::store::remove_liked_song(conn, &for_db, target.as_deref())
        })
    })
    .await
    .map_err(|e| format!("取消收藏失败: {e}"))?
    .map_err(|e| format!("取消收藏失败: {e}"))?;
    match outcome {
        crate::db::store::LikeRemoveOutcome::RemovedAll => {
            push_like_song(&state, &track, "remove", None).await;
        }
        crate::db::store::LikeRemoveOutcome::Rebound(next) => {
            push_like_song(&state, &track, "add", Some(&next)).await;
        }
        crate::db::store::LikeRemoveOutcome::DetachedOnly => {}
    }
    Ok(())
}

/// 这首歌挂在哪些歌单下（pid 列表），收藏选择器据此打勾。
#[tauri::command(rename = "list_track_playlists")]
pub async fn cmd_list_track_playlists(
    state: State<'_, AppState>,
    track: Track,
) -> Result<Vec<String>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::list_track_playlists(conn, &track))
    })
    .await
    .map_err(|e| format!("读取收藏归属失败: {e}"))?
}

/// 本地收藏写库成功后推一份到云端。
/// 未登录或后端不可达都**静默跳过**：本地是权威，云端只负责多端同步，
/// 这次没推上去，下次拉取时会把差异补回来 —— 不能让同步失败影响收藏本身。
///
/// `pid` = 歌曲在本地归属的歌单 id，add 时上送云端落库（后端 like/song 新增可选字段）。
async fn push_like_song(
    state: &State<'_, AppState>,
    track: &Track,
    action: &str,
    pid: Option<&str>,
) {
    if !state.astral.has_token() {
        return;
    }
    let platform = track.platform.to_string();
    let result = state
        .astral
        .like_song(crate::astral::LikeSongPayload {
            action,
            sid: &track.id,
            platform: &platform,
            name: &track.title,
            singer: &track.singer,
            album: &track.album,
            hash: track.music_id.as_deref(),
            pid,
            // 收藏时带上封面 URL 快照（LIKE_SONG_PIC_SYNC_DESIGN §8.3）；
            // 为空时 like_song 不会上送，服务端保留已有图片
            pic_url: Some(track.pic_url.as_str()),
        })
        .await;
    if let Err(e) = result {
        log::warn!("[like] 推送收藏({action})失败，仅本地生效: {e}");
    }
}

/// 收藏在线歌单（幂等）。只存元信息，曲目点开时再向音源取。
#[tauri::command(rename = "favorite_playlist")]
pub async fn cmd_favorite_playlist(
    state: State<'_, AppState>,
    platform: String,
    id: String,
    name: String,
    pic_url: Option<String>,
    play_count: Option<String>,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    let pic = pic_url.clone().unwrap_or_default();
    let count = play_count.unwrap_or_default();
    let (p, pid, title) = (platform.clone(), id.clone(), name.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| {
            crate::db::store::add_liked_playlist(conn, &p, &pid, &title, &pic, &count)
        })
    })
    .await
    .map_err(|e| format!("收藏歌单失败: {e}"))?;
    result.map_err(|e| format!("收藏歌单失败: {e}"))?;
    push_like_playlist(&state, &platform, &id, &name, pic_url.as_deref(), "add").await;
    Ok(())
}

/// 取消收藏歌单。
#[tauri::command(rename = "unfavorite_playlist")]
pub async fn cmd_unfavorite_playlist(
    state: State<'_, AppState>,
    platform: String,
    id: String,
    name: String,
    pic_url: Option<String>,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    let (p, pid) = (platform.clone(), id.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::remove_liked_playlist(conn, &p, &pid))
    })
    .await
    .map_err(|e| format!("取消收藏歌单失败: {e}"))?;
    result.map_err(|e| format!("取消收藏歌单失败: {e}"))?;
    push_like_playlist(&state, &platform, &id, &name, pic_url.as_deref(), "remove").await;
    Ok(())
}

/// 收藏的在线歌单（按收藏时间倒序）
#[tauri::command(rename = "list_favorite_playlists")]
pub async fn cmd_list_favorite_playlists(
    state: State<'_, AppState>,
) -> Result<Vec<crate::db::store::LikedPlaylist>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(crate::db::store::list_liked_playlists)
    })
    .await
    .map_err(|e| format!("读取收藏歌单失败: {e}"))?
}

#[tauri::command(rename = "is_playlist_favorited")]
pub async fn cmd_is_playlist_favorited(
    state: State<'_, AppState>,
    platform: String,
    id: String,
) -> Result<bool, String> {
    let Some(db) = state.db.clone() else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::is_liked_playlist(conn, &platform, &id))
    })
    .await
    .map_err(|e| format!("读取收藏状态失败: {e}"))?
}

/// 与 push_like_song 同款：未登录或推送失败都静默，本地收藏不受影响。
async fn push_like_playlist(
    state: &State<'_, AppState>,
    platform: &str,
    pid: &str,
    name: &str,
    pic: Option<&str>,
    action: &str,
) {
    if !state.astral.has_token() {
        return;
    }
    if let Err(e) = state
        .astral
        .like_playlist(action, pid, platform, name, pic)
        .await
    {
        log::warn!("[like] 推送歌单收藏({action})失败，仅本地生效: {e}");
    }
}

/// 收藏列表（按收藏时间倒序）。`pid` 为 Some 时只取该歌单的曲目。
#[tauri::command(rename = "list_favorites")]
pub async fn cmd_list_favorites(
    state: State<'_, AppState>,
    pid: Option<String>,
) -> Result<Vec<Track>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::list_liked_songs(conn, pid.as_deref()))
    })
    .await
    .map_err(|e| format!("读取收藏失败: {e}"))?
}

/// 单曲是否已收藏（播放页收藏按钮态）。
#[tauri::command(rename = "is_favorite")]
pub async fn cmd_is_favorite(
    state: State<'_, AppState>,
    track: Track,
) -> Result<bool, String> {
    let Some(db) = state.db.clone() else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::is_liked_song(conn, &track))
    })
    .await
    .map_err(|e| format!("读取收藏状态失败: {e}"))?
}

/// 最近播放（去重、按时间倒序）。`limit = 0` 时取默认 100 条。
#[tauri::command(rename = "list_history")]
pub async fn cmd_list_history(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<HistoryItem>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::list_play_history(conn, limit))
    })
    .await
    .map_err(|e| format!("读取播放历史失败: {e}"))?
}

/// 清空播放历史。
#[tauri::command(rename = "clear_history")]
pub async fn cmd_clear_history(state: State<'_, AppState>) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(crate::db::store::clear_play_history)
    })
    .await
    .map_err(|e| format!("清空播放历史失败: {e}"))?
}

// ---------- 我的歌单（DESIGN §5.3） ----------
// 本地自建歌单（区别于音源侧的在线歌单），曲目通过 add_tracks_to_playlist 加入。
// 歌单对外一律用 pid（UUID，创建后永不变）：新建时生成并上送云端登记，
// 收藏歌曲 / 查询歌单 / 删除歌单都按 pid 走。

/// 新建歌单，返回歌单 pid（本地已落库；已登录时顺带登记到云端，失败静默）。
#[tauri::command(rename = "create_playlist")]
pub async fn cmd_create_playlist(
    state: State<'_, AppState>,
    name: String,
) -> Result<String, String> {
    let Some(db) = state.db.clone() else {
        return Err("数据库不可用".to_string());
    };
    let reg_name = name.clone();
    let pid = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::create_playlist(conn, &reg_name))
    })
    .await
    .map_err(|e| format!("新建歌单失败: {e}"))??;
    // 登记：歌单元数据（名字）只有这里能上送，云端 qt_like_playlist 有
    // (uid, platform, pid) 唯一键，upsert 幂等；失败不阻塞本地建单
    push_like_playlist(&state, "local", &pid, &name, None, "add").await;
    Ok(pid)
}

#[tauri::command(rename = "rename_playlist")]
pub async fn cmd_rename_playlist(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::rename_playlist(conn, &id, &name))
    })
    .await
    .map_err(|e| format!("重命名歌单失败: {e}"))?
}

/// 删除本地歌单（id 参数传歌单 pid）。已登录时上送云端 remove（失败静默）。
#[tauri::command(rename = "delete_playlist")]
pub async fn cmd_delete_playlist(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    let push_id = id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::delete_playlist(conn, &id))
    })
    .await
    .map_err(|e| format!("删除歌单失败: {e}"))?
    .map_err(|e| format!("删除歌单失败: {e}"))?;
    push_like_playlist(&state, "local", &push_id, "", None, "remove").await;
    Ok(())
}

#[tauri::command(rename = "list_my_playlists")]
pub async fn cmd_list_my_playlists(
    state: State<'_, AppState>,
) -> Result<Vec<PlaylistSummary>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    // 合并视图：本地歌单（platform=local）+ 收藏的在线歌单
    let result = tauri::async_runtime::spawn_blocking(move || {
        db.with(crate::db::store::list_my_playlists)
    })
    .await
    .map_err(|e| format!("读取我的歌单失败: {e}"))?;
    match &result {
        Ok(v) => log::info!(
            "[db] 我的歌单 {} 条（本地 {} / 在线 {}）",
            v.len(),
            v.iter().filter(|p| p.platform == "local").count(),
            v.iter().filter(|p| p.platform != "local").count()
        ),
        Err(e) => log::warn!("[db] 读取我的歌单失败: {e}"),
    }
    result.map_err(|e| format!("读取我的歌单失败: {e}"))
}

#[tauri::command(rename = "get_playlist_tracks")]
pub async fn cmd_get_playlist_tracks(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<Track>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::get_playlist_tracks(conn, &id))
    })
    .await
    .map_err(|e| format!("读取歌单曲目失败: {e}"))?
}

#[tauri::command(rename = "add_tracks_to_playlist")]
pub async fn cmd_add_tracks_to_playlist(
    state: State<'_, AppState>,
    id: String,
    tracks: Vec<Track>,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    // id 参数 = 歌单 pid（收藏进哪个歌单，云端就记哪个 pid）
    let for_db = tracks.clone();
    let push_id = id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::add_tracks_to_playlist(conn, &id, &for_db))
    })
    .await
    .map_err(|e| format!("添加歌曲到歌单失败: {e}"))?
    .map_err(|e| format!("添加歌曲到歌单失败: {e}"))?;
    for t in &tracks {
        push_like_song(&state, t, "add", Some(&push_id)).await;
    }
    Ok(())
}

#[tauri::command(rename = "remove_track_from_playlist")]
pub async fn cmd_remove_track_from_playlist(
    state: State<'_, AppState>,
    id: String,
    track: Track,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    let for_db = track.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| {
            crate::db::store::remove_track_from_playlist(conn, &id, &for_db)
        })
    })
    .await
    .map_err(|e| format!("从歌单移除歌曲失败: {e}"))?
    .map_err(|e| format!("从歌单移除歌曲失败: {e}"))?;
    // 多归属下的云端策略与 remove_favorite 一致
    match outcome {
        crate::db::store::LikeRemoveOutcome::RemovedAll => {
            push_like_song(&state, &track, "remove", None).await;
        }
        crate::db::store::LikeRemoveOutcome::Rebound(next) => {
            push_like_song(&state, &track, "add", Some(&next)).await;
        }
        crate::db::store::LikeRemoveOutcome::DetachedOnly => {}
    }
    Ok(())
}

// ---------- 下载管理（DESIGN §5.3） ----------
// 取址复用播放链路（含 10 分钟内存缓存），落盘走流式写入，进度写回 download_tasks。
//
// 下载目录：settings `download.dir` 优先；未设置时默认 `<安装目录>/Download`
// （exe 所在目录，currentUser 安装无需管理员即可写）。

/// 下载目录的 settings 键
const SETTING_DOWNLOAD_DIR: &str = "download.dir";

/// 默认下载目录：安装目录（exe 所在目录）/ Download
fn default_download_dir() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("定位安装目录失败: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "定位安装目录失败".to_string())?
        .join("Download");
    Ok(dir)
}

/// 当前生效的下载目录：用户自选 > 安装目录/Download
fn download_dir(state: &AppState) -> Result<std::path::PathBuf, String> {
    if let Some(db) = &state.db {
        if let Ok(Some(saved)) =
            db.with(|conn| crate::db::store::get_setting(conn, SETTING_DOWNLOAD_DIR))
        {
            if !saved.trim().is_empty() {
                return Ok(std::path::PathBuf::from(saved));
            }
        }
    }
    default_download_dir()
}

/// 文件名安全化：去掉 Windows 非法字符与控制符，保留中文，截断 80 字符。
fn sanitize_file_name(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .filter(|c| {
            !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
                && !c.is_control()
        })
        .collect();
    let trimmed = cleaned.trim().to_string();
    if trimmed.is_empty() {
        String::new()
    } else {
        trimmed.chars().take(80).collect()
    }
}

/// 从取址 URL 推断音频扩展名；URL 没有可用后缀时按音质兜底。
///
/// 无损地址各源都会带明确的 `.flac`，但 kw 的 `format=flac|mp3|aac` 在无无损源时
/// 会真的回退成 mp3，所以优先信 URL，信不过再退回音质映射。
fn audio_ext_from_url(url: &str, quality: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let segment = path.rsplit('/').next().unwrap_or("");
    if let Some((_, ext)) = segment.rsplit_once('.') {
        let ext = ext.to_ascii_lowercase();
        if matches!(
            ext.as_str(),
            "flac" | "mp3" | "m4a" | "aac" | "wav" | "ogg" | "opus" | "wma" | "ape" | "mp4"
        ) {
            return ext;
        }
    }
    if quality == "flac" {
        "flac".to_string()
    } else {
        "mp3".to_string()
    }
}

/// 生成不与现有文件冲突的下载路径：`歌手 - 歌名.<ext>`，重名加 (2) (3)…
/// 扩展名由取址 URL 决定，避免无损内容被写成 `.mp3`。
fn unique_download_path(
    dir: &std::path::Path,
    track: &Track,
    quality: &str,
    url: &str,
) -> std::path::PathBuf {
    let ext = audio_ext_from_url(url, quality);
    let base = {
        let named = format!(
            "{} - {}",
            sanitize_file_name(&track.singer),
            sanitize_file_name(&track.title)
        );
        let name = if named.trim_matches([' ', '-']).is_empty() {
            // 歌名/歌手全被过滤掉时退回老格式（platform_id_quality）
            format!(
                "{}_{}_{}",
                track.platform,
                sanitize_file_name(&track.id),
                quality
            )
        } else {
            named
        };
        dir.join(format!("{name}.{ext}"))
    };
    if !base.exists() {
        return base;
    }
    for n in 2..=99 {
        let stem = base.file_stem().and_then(|s| s.to_str()).unwrap_or("track");
        let candidate = dir.join(format!("{stem} ({n}).{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    base
}

#[tauri::command(rename = "get_download_dir")]
pub async fn cmd_get_download_dir(state: State<'_, AppState>) -> Result<String, String> {
    download_dir(&state).map(|p| p.to_string_lossy().to_string())
}

/// 弹出系统文件夹选择框，选中后保存为下载目录并返回新路径（取消返回 None）。
#[tauri::command(rename = "choose_download_dir")]
pub async fn cmd_choose_download_dir(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择下载保存位置")
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("打开文件夹选择框失败: {e}"))?;

    let Some(picked) = picked else {
        return Ok(None); // 用户取消
    };
    let path = match picked.into_path() {
        Ok(p) => p,
        Err(e) => return Err(format!("无效的文件夹路径: {e:?}")),
    };
    let path_str = path.to_string_lossy().to_string();
    if let Some(db) = &state.db {
        db.with(|conn| crate::db::store::set_setting(conn, SETTING_DOWNLOAD_DIR, &path_str))
            .map_err(|e| e.to_string())?;
    }
    Ok(Some(path_str))
}

/// 重置下载目录为默认（安装目录/Download），返回重置后的路径。
#[tauri::command(rename = "reset_download_dir")]
pub async fn cmd_reset_download_dir(state: State<'_, AppState>) -> Result<String, String> {
    if let Some(db) = &state.db {
        db.with(|conn| crate::db::store::set_setting(conn, SETTING_DOWNLOAD_DIR, ""))
            .map_err(|e| e.to_string())?;
    }
    let dir = download_dir(&state)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command(rename = "list_downloads")]
pub async fn cmd_list_downloads(
    state: State<'_, AppState>,
) -> Result<Vec<DownloadTask>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || db.with(crate::db::store::list_download_tasks))
        .await
        .map_err(|e| format!("读取下载列表失败: {e}"))?
}

/// 删除下载任务。`delete_file = true` 时连同已下载文件一起删。
#[tauri::command(rename = "delete_download")]
pub async fn cmd_delete_download(
    state: State<'_, AppState>,
    id: String,
    delete_file: bool,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    let path = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::delete_download_task(conn, &id))
    })
    .await
    .map_err(|e| format!("删除下载任务失败: {e}"))??;
    if delete_file {
        if let Some(p) = path {
            let _ = std::fs::remove_file(&p);
        }
    }
    Ok(())
}

/// 开始下载一首歌，返回任务 id（任务在后台执行，进度写回库，前端轮询 list_downloads）。
#[tauri::command(rename = "start_download")]
pub async fn cmd_start_download(
    state: State<'_, AppState>,
    track: Track,
    quality: Quality,
) -> Result<String, String> {
    if track.platform == SourceId::Local {
        return Err("本地歌曲无需下载".to_string());
    }
    let Some(db) = state.db.clone() else {
        return Err("数据库不可用".to_string());
    };

    // 命令参数本身就是 provider 侧的 Quality（与 resolve_play_url_with / quality_str 同口径）
    let q_str = quality_str(quality).to_string();

    let db_for_task = Arc::clone(&db);
    let t = track.clone();
    let task_id = tauri::async_runtime::spawn_blocking(move || {
        db_for_task.with(|conn| crate::db::store::create_download_task(conn, &t, &q_str))
    })
    .await
    .map_err(|e| format!("创建下载任务失败: {e}"))??;

    // 取播放地址（复用播放链路的内存缓存）
    let (url, _fetched) =
        resolve_play_url_with(&state.registry, &state.url_cache, &track, quality)
            .await
            .map_err(|e| format!("取播放地址失败: {e}"))?;

    let dir = download_dir(&state)?;
    let path = unique_download_path(&dir, &track, quality_str(quality), &url);

    let task = task_id.clone();
    let db2 = Arc::clone(&db);
    tauri::async_runtime::spawn(async move {
        match download_to_file(&url, &path, &db2, &task).await {
            Ok(size) => {
                let db3 = Arc::clone(&db2);
                let id = task.clone();
                let p = path.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    db3.with(|conn| {
                        crate::db::store::finish_download_task(
                            conn,
                            &id,
                            &p.to_string_lossy(),
                            size,
                        )
                    })
                })
                .await;
            }
            Err(e) => {
                let db3 = Arc::clone(&db2);
                let id = task.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    db3.with(|conn| crate::db::store::fail_download_task(conn, &id, &e))
                })
                .await;
            }
        }
    });

    Ok(task_id)
}

/// 流式下载到文件，每约 5% 更新一次进度；返回实际写入字节数。
async fn download_to_file(
    url: &str,
    path: &std::path::Path,
    db: &Arc<crate::db::Database>,
    task_id: &str,
) -> Result<i64, String> {
    use std::io::Write;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建下载目录失败: {e}"))?;
    }
    let mut resp = reqwest::get(url)
        .await
        .map_err(|e| format!("下载请求失败: {e}"))?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(path).map_err(|e| format!("创建文件失败: {e}"))?;

    let mut written: i64 = 0;
    let mut last_report = 0f64;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("下载中断: {e}"))?
    {
        file.write_all(&chunk)
            .map_err(|e| format!("写入文件失败: {e}"))?;
        written += chunk.len() as i64;
        let progress = if total > 0 {
            (written as f64 / total as f64).clamp(0.0, 1.0)
        } else {
            0.0
        };
        if progress - last_report >= 0.05 {
            last_report = progress;
            let db = Arc::clone(db);
            let id = task_id.to_string();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                db.with(|conn| crate::db::store::update_download_progress(conn, &id, progress))
            })
            .await;
        }
    }
    file.flush().map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(written)
}

// ---------- Astral 账号（DESIGN §2.3.4；接口契约同 qt-uniappx AccountApi） ----------
//
// 会话存在本地 settings 表（key = astral.session），启动时由 lib.rs 回填 satoken，
// 免得每次开应用都要重新登录。

const SETTING_ASTRAL_SESSION: &str = "astral.session";

async fn persist_session(db: &Option<Arc<crate::db::Database>>, session: &AuthSession) {
    let Some(db) = db.clone() else {
        return;
    };
    let value = match serde_json::to_string(session) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("[astral] 会话序列化失败: {e}");
            return;
        }
    };
    let _ = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| {
            crate::db::store::set_setting(conn, SETTING_ASTRAL_SESSION, &value)
        })
    })
    .await;
}

async fn clear_session(db: &Option<Arc<crate::db::Database>>) {
    let Some(db) = db.clone() else {
        return;
    };
    let _ = tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::set_setting(conn, SETTING_ASTRAL_SESSION, ""))
    })
    .await;
}

#[tauri::command(rename = "astral_login")]
pub async fn cmd_astral_login(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<AuthSession, String> {
    let session = state.astral.login(&username, &password).await?;
    persist_session(&state.db, &session).await;
    Ok(session)
}

#[tauri::command(rename = "astral_register")]
pub async fn cmd_astral_register(
    state: State<'_, AppState>,
    username: String,
    password: String,
    email: Option<String>,
    code: Option<String>,
) -> Result<AuthSession, String> {
    let session = state
        .astral
        .register(&username, &password, email.as_deref(), code.as_deref())
        .await?;
    persist_session(&state.db, &session).await;
    Ok(session)
}

#[tauri::command(rename = "astral_logout")]
pub async fn cmd_astral_logout(state: State<'_, AppState>) -> Result<(), String> {
    // 后端失败也要清本地：否则用户永远退不出去
    let result = state.astral.logout().await;
    clear_session(&state.db).await;
    result
}

#[tauri::command(rename = "astral_me")]
pub async fn cmd_astral_me(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    state.astral.me().await
}

/// 用旧 token 换新会话（satoken 过期时前端调这个，不用重新输密码）
#[tauri::command(rename = "astral_refresh")]
pub async fn cmd_astral_refresh(
    state: State<'_, AppState>,
) -> Result<AuthSession, String> {
    let session = state.astral.refresh().await?;
    persist_session(&state.db, &session).await;
    Ok(session)
}

/// 本地保存的会话（可能已过期，是否过期看 `is_valid`）
#[tauri::command(rename = "astral_session")]
pub async fn cmd_astral_session(
    state: State<'_, AppState>,
) -> Result<Option<AuthSession>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| {
            crate::db::store::get_setting(conn, SETTING_ASTRAL_SESSION)
        })
    })
    .await
    .map_err(|e| format!("读取本地会话失败: {e}"))?
    .map(|v| v.and_then(|s| serde_json::from_str::<AuthSession>(&s).ok()))
}

/// 发邮箱验证码（注册 / 找回密码共用）
#[tauri::command(rename = "astral_send_email_code")]
pub async fn cmd_astral_send_email_code(
    state: State<'_, AppState>,
    email: String,
) -> Result<serde_json::Value, String> {
    state
        .astral
        .send_email_code(&email, "【轻听】您正在进行账号操作，请使用邮件中的验证码。")
        .await
}

#[tauri::command(rename = "astral_change_password")]
pub async fn cmd_astral_change_password(
    state: State<'_, AppState>,
    email: String,
    password: String,
    code: String,
) -> Result<serde_json::Value, String> {
    state
        .astral
        .change_password(&email, &password, &code)
        .await
}

#[tauri::command(rename = "astral_update_profile")]
pub async fn cmd_astral_update_profile(
    state: State<'_, AppState>,
    patch: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state.astral.update_profile(patch).await
}

// ---------- 收藏同步（DESIGN §5.3；契约同 qt-uniappx services/like.ts） ----------
//
// 收藏两边都存：本地是权威（离线可用），云端做多端同步。
// 这里只提供原语（推送 / 拉增量 / 拉全量 / 落本地），编排交给前端，
// 免得同步策略写死在 Rust 里不好调。

#[tauri::command(rename = "like_push_song")]
pub async fn cmd_like_push_song(
    state: State<'_, AppState>,
    track: Track,
    action: String,
    pid: Option<String>,
) -> Result<i64, String> {
    let platform = track.platform.to_string();
    state
        .astral
        .like_song(crate::astral::LikeSongPayload {
            action: &action,
            sid: &track.id,
            platform: &platform,
            name: &track.title,
            singer: &track.singer,
            album: &track.album,
            hash: track.music_id.as_deref(),
            pid: pid.as_deref(),
            pic_url: Some(track.pic_url.as_str()),
        })
        .await
}

#[tauri::command(rename = "like_push_playlist")]
pub async fn cmd_like_push_playlist(
    state: State<'_, AppState>,
    id: String,
    platform: String,
    name: String,
    pic_url: Option<String>,
    action: String,
) -> Result<i64, String> {
    state
        .astral
        .like_playlist(&action, &id, &platform, &name, pic_url.as_deref())
        .await
}

/// 增量拉取收藏变更（since 为 0 时视作从头开始）
#[tauri::command(rename = "like_pull")]
pub async fn cmd_like_pull(
    state: State<'_, AppState>,
    since: i64,
) -> Result<serde_json::Value, String> {
    let (changes, max_seq) = state.astral.like_changes(since).await?;
    Ok(serde_json::json!({ "changes": changes, "maxSeq": max_seq }))
}

/// 全量分页拉取（游标丢失时的兜底）。返回后端原样 { songs, playlists, maxSeq }。
#[tauri::command(rename = "like_pull_all")]
pub async fn cmd_like_pull_all(
    state: State<'_, AppState>,
    page: i64,
    size: i64,
) -> Result<serde_json::Value, String> {
    state
        .astral
        .like_list(page, if size <= 0 { 100 } else { size })
        .await
}

/// 把云端变更落到本地收藏表。**不回推**云端，否则推送和拉取会来回震荡。
/// 云端记录不带封面和时长，落库前先用本地已有值补齐，避免把攒下的信息抹掉。
#[tauri::command(rename = "like_apply")]
pub async fn cmd_like_apply(
    state: State<'_, AppState>,
    changes: Vec<crate::astral::LikeChange>,
) -> Result<usize, String> {
    let Some(db) = state.db.clone() else {
        return Ok(0);
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| {
            let mut applied = 0usize;
            for c in changes {
                if c.id.is_empty() {
                    continue;
                }
                // 歌单收藏：云端只给元信息，够用了（曲目点开时再取）
                if c.kind == "playlist" {
                    if c.deleted {
                        crate::db::store::remove_liked_playlist(conn, &c.platform, &c.id)?;
                    } else {
                        let name = if c.name.is_empty() {
                            c.id.as_str()
                        } else {
                            c.name.as_str()
                        };
                        crate::db::store::add_liked_playlist(
                            conn,
                            &c.platform,
                            &c.id,
                            name,
                            &c.pic_url,
                            "",
                        )?;
                    }
                    applied += 1;
                    continue;
                }
                // 本期只同步 song / playlist 两类，其余（未知类型）跳过
                if c.kind != "song" {
                    continue;
                }
                let platform = match c.platform.as_str() {
                    "wyy" => crate::provider::types::SourceId::Wyy,
                    "qq" => crate::provider::types::SourceId::Qq,
                    "kw" => crate::provider::types::SourceId::Kw,
                    "kg" => crate::provider::types::SourceId::Kg,
                    _ => continue,
                };
                let db_id = format!("{platform}:{}", c.id);
                let existing: Option<(Option<String>, Option<i64>)> = match conn.query_row(
                    "SELECT pic_url, duration_ms FROM tracks WHERE id = ?1",
                    rusqlite::params![db_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                ) {
                    Ok(v) => Some(v),
                    Err(rusqlite::Error::QueryReturnedNoRows) => None,
                    Err(e) => return Err(e),
                };
                let (local_pic, local_duration_ms) = existing.unwrap_or((None, None));

                let track = Track {
                    id: c.id.clone(),
                    platform,
                    title: if c.name.is_empty() {
                        c.id.clone()
                    } else {
                        c.name.clone()
                    },
                    singer: c.singer.clone(),
                    album: c.album.clone(),
                    pic_url: if c.pic_url.is_empty() {
                        local_pic.unwrap_or_default()
                    } else {
                        c.pic_url.clone()
                    },
                    duration: local_duration_ms.unwrap_or(0) as f64 / 1000.0,
                    music_id: if c.hash.is_empty() {
                        None
                    } else {
                        Some(c.hash.clone())
                    },
                };

                if c.deleted {
                    // 云端取消收藏：整首下线，不管本地挂哪个歌单
                    crate::db::store::remove_liked_song(conn, &track, None)?;
                    applied += 1;
                } else if c.pid.is_empty() {
                    // 云端没带 pid（无归属）：不加载（v5 起无默认歌单）
                    log::info!("[like] 云端歌曲 {} 未归属歌单，跳过", c.id);
                } else {
                    // 必须有对应歌单（云端卡片或本地自建）才加载；
                    // pid 找不到歌单 → 不加载，等歌单同步过来后的全量重导再进
                    let known = crate::db::store::playlist_pid_exists(conn, &c.pid)?;
                    if !known {
                        log::info!("[like] 云端歌曲 {} 的歌单 {} 不存在，跳过", c.id, c.pid);
                    } else {
                        crate::db::store::add_liked_song(conn, &track, &c.pid)?;
                        applied += 1;
                    }
                }
            }
            Ok(applied)
        })
    })
    .await
    .map_err(|e| format!("应用收藏变更失败: {e}"))?
}

// ---------- 通用设置项（settings 表，供引导、小开关等零散状态用） ----------

/// 临时诊断：前端把关键路径（封面取色等）的阶段结果写入 app 日志。
#[tauri::command(rename = "debug_log")]
pub async fn cmd_debug_log(message: String) -> Result<(), String> {
    log::info!("[frontend-debug] {message}");
    Ok(())
}

#[tauri::command(rename = "get_setting")]
pub async fn cmd_get_setting(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::get_setting(conn, &key))
    })
    .await
    .map_err(|e| format!("读取设置失败: {e}"))?
}

#[tauri::command(rename = "set_setting")]
pub async fn cmd_set_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let Some(db) = state.db.clone() else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::set_setting(conn, &key, &value))
    })
    .await
    .map_err(|e| format!("保存设置失败: {e}"))?
}

// ---------- 听歌统计（DESIGN §5.3） ----------
// 数据由播放引擎在起播时写入 play_stats，这里只做查询。

#[tauri::command(rename = "get_play_overview")]
pub async fn cmd_get_play_overview(
    state: State<'_, AppState>,
) -> Result<crate::db::store::PlayOverview, String> {
    let Some(db) = state.db.clone() else {
        return Ok(crate::db::store::PlayOverview {
            total_plays: 0,
            total_ms: 0,
            track_count: 0,
            last_played_at: None,
        });
    };
    tauri::async_runtime::spawn_blocking(move || db.with(crate::db::store::play_overview))
        .await
        .map_err(|e| format!("读取听歌统计失败: {e}"))?
}

#[tauri::command(rename = "get_top_tracks")]
pub async fn cmd_get_top_tracks(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<crate::db::store::PlayStatItem>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::list_top_tracks(conn, limit))
    })
    .await
    .map_err(|e| format!("读取热门曲目失败: {e}"))?
}

#[tauri::command(rename = "get_top_singers")]
pub async fn cmd_get_top_singers(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<crate::db::store::SingerStat>, String> {
    let Some(db) = state.db.clone() else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::list_top_singers(conn, limit))
    })
    .await
    .map_err(|e| format!("读取热门歌手失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::{audio_ext_from_url, unique_download_path};
    use crate::provider::types::{SourceId, Track};

    #[test]
    fn ext_comes_from_url_path() {
        // 无损地址（四源实测都是 .flac），即使音质串是 320 也按 URL 走
        assert_eq!(
            audio_ext_from_url("http://kw-er.kuwo.cn/abc/resource/1/trackmedia/F000.flac", "flac"),
            "flac"
        );
        assert_eq!(
            audio_ext_from_url("https://m701.music.126.net/2026/x/y.e69f.flac", "320"),
            "flac"
        );
        // 查询串/片段不参与后缀截取
        assert_eq!(
            audio_ext_from_url("https://cdn/a.mp3?k=v#frag", "320"),
            "mp3"
        );
        // 大小写归一
        assert_eq!(audio_ext_from_url("https://cdn/A.FLAC", "flac"), "flac");
    }

    #[test]
    fn ext_falls_back_to_quality() {
        // 无后缀
        assert_eq!(audio_ext_from_url("https://cdn/track/file", "flac"), "flac");
        assert_eq!(audio_ext_from_url("https://cdn/track/file", "320"), "mp3");
        // 非音频后缀（如已失效的重定向地址）也走音质兜底
        assert_eq!(
            audio_ext_from_url("https://cdn/x.html", "flac"),
            "flac"
        );
        assert_eq!(audio_ext_from_url("https://cdn/x.html", "128"), "mp3");
    }

    fn sample_track() -> Track {
        Track {
            id: "1".to_string(),
            platform: SourceId::Kw,
            title: "晴天".to_string(),
            singer: "周杰伦".to_string(),
            album: String::new(),
            pic_url: String::new(),
            duration: 0.0,
            music_id: None,
        }
    }

    #[test]
    fn lossless_download_path_renames_to_flac_and_keeps_suffix_on_collision() {
        let dir = std::env::temp_dir().join(format!("ll-dl-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");

        let url = "http://kw-er.kuwo.cn/abc/resource/1/trackmedia/F000.flac";
        let first = unique_download_path(&dir, &sample_track(), "flac", url);
        assert_eq!(
            first.file_name().and_then(|s| s.to_str()),
            Some("周杰伦 - 晴天.flac")
        );

        std::fs::write(&first, b"x").expect("占位");
        let second = unique_download_path(&dir, &sample_track(), "flac", url);
        assert_eq!(
            second.file_name().and_then(|s| s.to_str()),
            Some("周杰伦 - 晴天 (2).flac")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
