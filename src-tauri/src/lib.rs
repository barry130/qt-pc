//! 轻听 PC 版 Tauri 入口（lib 形式，便于集成测试）。

pub mod audio;
pub mod astral;
pub mod commands;
pub mod db;
pub mod local;
pub mod lyric_window;
pub mod media;
pub mod provider;
pub mod qtres;
pub mod shortcuts;
pub mod tray;

use std::path::PathBuf;
use std::sync::Arc;

use audio::engine::AudioEngine;
use commands::*;
use db::Database;
use provider::registry::{PlayUrlCache, ProviderRegistry};
use provider::types::{Quality, SourceId, Track};
use provider::ProviderError;
use tauri::Manager;

/// 全局应用状态
pub struct AppState {
    pub registry: Arc<ProviderRegistry>,
    pub url_cache: Arc<PlayUrlCache>,
    pub engine: AudioEngine,
    pub audio_cache_dir: PathBuf,
    /// None = 打开/迁移失败（已记日志），播放等功能不受影响
    pub db: Option<Arc<Database>>,
    /// Astral 后端 HTTP 客户端（更新 / 消息 / 统计 / 反馈，§2.3.4）
    pub astral: Arc<astral::AstralClient>,
}

type CmdResult<T> = Result<T, ProviderError>;

/// 取播放地址：内存缓存（10 分钟）命中直接返回；未命中经 Provider 解析后写入缓存。
/// R1：只进进程内存，不写 SQLite。
pub(crate) async fn resolve_play_url_with(
    registry: &ProviderRegistry,
    cache: &PlayUrlCache,
    track: &Track,
    quality: Quality,
) -> CmdResult<(String, u64)> {
    let key = PlayUrlCache::cache_key(
        &track.platform.to_string(),
        &track.id,
        quality_str(quality),
    );
    if let Some((url, fetched_at)) = cache.get(&key) {
        return Ok((url, fetched_at));
    }
    let provider = registry.get(track.platform)?;
    let url = provider.play_url(track, quality).await?;
    cache.set(key.clone(), url.clone());
    // fetched_at 由 set 写入当前时间；这里再读一次拿到真实时间戳
    let fetched_at = cache.get(&key).map(|(_, at)| at).unwrap_or(0);
    Ok((url, fetched_at))
}

pub(crate) fn quality_str(q: Quality) -> &'static str {
    match q {
        Quality::Standard => "128",
        Quality::High => "320",
        Quality::Lossless => "flac",
    }
}

// ---------- 组装 ----------

pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .init();

    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("qtres", qtres::handle_qtres)
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // 本地音乐文件夹选择（/library/folders 用它的目录选择对话框）
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            // §4 关闭行为：点关闭 = 最小化到托盘，退出走托盘菜单
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let cache_base = handle
                .path()
                .app_cache_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let audio_cache_dir = cache_base.join("audio");
            let registry = Arc::new(ProviderRegistry::new());
            let url_cache = Arc::new(PlayUrlCache::new());

            // 数据库：DESIGN §8.1 %APPDATA%/LightListen/data/music.db
            // （identifier 是 com.qt.lightlisten，app_data_dir 与设计不一致，按设计拼）
            #[cfg(target_os = "windows")]
            let db_root = std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| cache_base)
                .join("LightListen");
            #[cfg(not(target_os = "windows"))]
            let db_root = cache_base;
            let db = match Database::open(&db_root.join("data").join("music.db")) {
                Ok(db) => Some(Arc::new(db)),
                Err(e) => {
                    log::error!("{e}；本次运行无持久化，播放不受影响");
                    None
                }
            };

            let engine = AudioEngine::spawn(
                handle.clone(),
                audio_cache_dir.clone(),
                Arc::clone(&registry),
                Arc::clone(&url_cache),
                db.clone(),
            );

            // 托盘 + 全局快捷键（§14.1 / §14.2；自定义快捷键从 settings 表读）
            let keymap = shortcuts::load_shortcuts(db.as_deref());

            let astral = Arc::new(astral::AstralClient::new(astral::DEFAULT_BASE_URL));

            // 回填上次的登录会话（token 存 settings 表），没过期才装进客户端
            if let Some(db) = &db {
                match db.with(|conn| {
                    crate::db::store::get_setting(conn, "astral.session")
                }) {
                    Ok(Some(json)) => {
                        match serde_json::from_str::<astral::AuthSession>(&json) {
                            Ok(session) if session.is_valid() => {
                                astral.set_token(Some(session.token));
                                log::info!("[astral] 已恢复上次登录会话");
                            }
                            Ok(_) => log::info!("[astral] 上次会话已过期，需要重新登录"),
                            Err(e) => log::warn!("[astral] 会话解析失败: {e}"),
                        }
                    }
                    Ok(None) => {}
                    Err(e) => log::warn!("[astral] 读取会话失败: {e}"),
                }
            }

            app.manage(AppState {
                registry,
                url_cache,
                engine,
                audio_cache_dir,
                db,
                astral,
            });

            tray::create_tray(&handle);
            shortcuts::register_shortcuts(&handle, &keymap);

            // 恢复上次开启的桌面歌词窗口（§4.2 位置记忆；失败不影响主流程）
            if lyric_window::get_state(&handle).visible {
                if let Err(e) = lyric_window::show(&handle) {
                    log::warn!("[lyric-window] 恢复失败: {e}");
                }
            }

            // visible:false → 等前端首帧 show()，避免白屏闪烁（DESIGN §4.1）
            if let Some(win) = handle.get_webview_window("main") {
                let _ = win.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmd_search_music,
            cmd_get_play_url,
            cmd_get_lyric,
            cmd_get_video_url,
            cmd_get_track_cover,
            cmd_get_playlist_categories,
            cmd_get_recommendations,
            cmd_get_latest_songs,
            cmd_get_all_latest_songs,
            cmd_get_charts,
            cmd_get_all_charts,
            cmd_get_chart_detail,
            cmd_get_playlist_detail,
            cmd_get_hot_words,
            cmd_get_all_hot_words,
            cmd_search_playlists,
            cmd_search_artists,
            cmd_search_albums,
            cmd_search_all_music_sources,
            cmd_get_artist_songs,
            cmd_get_videos,
            cmd_invalidate_play_url,
            cmd_play_track,
            cmd_play_queue,
            cmd_set_default_quality,
            cmd_set_track_quality,
            cmd_play_at,
            cmd_next,
            cmd_previous,
            cmd_set_play_mode,
            cmd_get_queue,
            cmd_clear_queue,
            cmd_pause,
            cmd_resume,
            cmd_stop,
            cmd_seek,
            cmd_list_output_devices,
            cmd_set_output_device,
            cmd_list_shortcuts,
            cmd_save_shortcuts,
            cmd_resolve_update_url,
            cmd_download_update_file,
            cmd_run_update_installer,
            cmd_run_update_browser,
            cmd_set_volume,
            cmd_set_muted,
            cmd_get_playback_state,
            cmd_restore_last_session,
            cmd_get_appearance,
            cmd_set_appearance,
            cmd_get_app_version,
            cmd_show_desktop_lyric,
            cmd_hide_desktop_lyric,
            cmd_get_desktop_lyric_state,
            cmd_set_desktop_lyric_locked,
            cmd_set_desktop_lyric_style,
            cmd_set_desktop_lyric_bounds,
            cmd_reset_desktop_lyric,
            cmd_astral_app_update,
            cmd_astral_check_official_version,
            cmd_astral_github_accels,
            cmd_astral_active_messages,
            cmd_astral_message_center,
            cmd_astral_unread_count,
            cmd_astral_ack_messages,
            cmd_astral_report_stats,
            cmd_astral_submit_feedback,
            cmd_astral_my_feedback,
            cmd_astral_public_feedback,
            cmd_astral_feedback_detail,
            cmd_astral_feedback_replies,
            cmd_astral_reply_feedback,
            // 账号（DESIGN §2.3.4；契约同 qt-uniappx AccountApi）
            cmd_astral_login,
            cmd_astral_register,
            cmd_astral_logout,
            cmd_astral_me,
            cmd_astral_refresh,
            cmd_astral_session,
            cmd_astral_send_email_code,
            cmd_astral_change_password,
            cmd_astral_update_profile,
            // 听歌统计（DESIGN §5.3）
            cmd_get_play_overview,
            cmd_get_top_tracks,
            cmd_get_top_singers,
            // 通用设置项
            cmd_get_setting,
            cmd_debug_log,
            cmd_set_setting,
            // 收藏同步（DESIGN §5.3；契约同 qt-uniappx services/like.ts）
            cmd_like_push_song,
            cmd_like_push_playlist,
            cmd_like_pull,
            cmd_like_pull_all,
            cmd_like_apply,
            // 本地音乐库（DESIGN §13）
            cmd_scan_library,
            cmd_get_local_tracks,
            cmd_get_scan_dirs,
            cmd_add_scan_dir,
            cmd_remove_scan_dir,
            // 收藏 / 播放历史（DESIGN §5.3）
            cmd_add_favorite,
            cmd_remove_favorite,
            cmd_list_favorites,
            cmd_list_track_playlists,
            cmd_is_favorite,
            cmd_favorite_playlist,
            cmd_unfavorite_playlist,
            cmd_list_favorite_playlists,
            cmd_is_playlist_favorited,
            cmd_list_history,
            cmd_clear_history,
            // 我的歌单（DESIGN §5.3）
            cmd_create_playlist,
            cmd_rename_playlist,
            cmd_delete_playlist,
            cmd_list_my_playlists,
            cmd_get_playlist_tracks,
            cmd_add_tracks_to_playlist,
            cmd_remove_track_from_playlist,
            // 下载管理（DESIGN §5.3）
            cmd_start_download,
            cmd_list_downloads,
            cmd_delete_download,
            cmd_get_download_dir,
            cmd_choose_download_dir,
            cmd_reset_download_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// SourceId 用于缓存键时的字符串化（保持 wyy/qq/kw/kg）
impl std::fmt::Display for SourceId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            SourceId::Wyy => "wyy",
            SourceId::Qq => "qq",
            SourceId::Kw => "kw",
            SourceId::Kg => "kg",
            SourceId::Local => "local",
        };
        f.write_str(s)
    }
}
