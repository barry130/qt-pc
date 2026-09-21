//! 轻听 PC 版 Tauri 入口（lib 形式，便于集成测试）。

pub mod app_paths;
pub mod audio;
pub mod astral;
pub mod commands;
pub mod db;
pub mod download;
pub mod local;
pub mod lyric_window;
pub mod media;
pub mod provider;
pub mod playurl_bridge;
pub mod qtres;
pub mod shortcuts;
pub mod smtc;
pub mod source_bundle;
pub mod source_install;
pub mod source_window;
pub mod taskbar;
pub mod tray;

use std::path::PathBuf;
use std::sync::Arc;

use audio::engine::AudioEngine;
use commands::*;
use db::Database;
use provider::types::{Quality, SourceId, Track};
use provider::url_cache::PlayUrlCache;
use provider::ProviderError;
use tauri::{Emitter, Manager};

/// 全局应用状态
pub struct AppState {
    pub url_cache: Arc<PlayUrlCache>,
    pub engine: AudioEngine,
    pub audio_cache_dir: PathBuf,
    /// None = 打开/迁移失败（已记日志），播放等功能不受影响
    pub db: Option<Arc<Database>>,
    /// Astral 后端 HTTP 客户端（更新 / 消息 / 统计 / 反馈，§2.3.4）
    pub astral: Arc<astral::AstralClient>,
    /// 下载任务登记表（暂停 / 取消时置停止旗标，§5.3 下载 2.0）
    pub downloads: Arc<download::DownloadManager>,
}

type CmdResult<T> = Result<T, ProviderError>;

/// 取播放地址（脚本线路）：缓存（10 分钟）命中直接返回；未命中经 playurl_bridge
/// 问前端脚本包（前端按「换源顺序」跨源解析），拿到后写入缓存。
/// R1：只进进程内存，不写 SQLite。原生 Rust Provider 已删除，
/// 前端脚本线路是唯一的第三方取链路径（未就绪 / 超时 / 空串 = 无地址）。
pub(crate) async fn resolve_play_url_script(
    app: &tauri::AppHandle,
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
    let url = crate::playurl_bridge::ask_frontend(app, track, quality)
        .await
        .ok_or(ProviderError::NoPlayableUrl)?;
    if url.is_empty() {
        return Err(ProviderError::NoPlayableUrl);
    }
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
                    // 统计（STATS_DESIGN §4.1）：收进托盘 = 一轮 show→hide 结束，
                    // 让前端结算停留时长并冲队列
                    let _ = window.emit("stat_window_hidden", ());
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
            let url_cache = Arc::new(PlayUrlCache::new());

            // 数据库：DESIGN §8.1 %APPDATA%/QuietMusic/data/music.db
            // 口径集中在 app_paths::data_root（含 LightListen 旧目录迁移）
            let db_root = crate::app_paths::data_root(&handle);
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
                Arc::clone(&url_cache),
                db.clone(),
            );

            // 系统媒体控制（Windows SMTC）：系统媒体面板 + 硬件媒体键 / 蓝牙耳机按键。
            // 需要主窗口 HWND；取不到（异常环境）就静默降级，不影响播放。
            #[cfg(target_os = "windows")]
            {
                let hwnd = handle
                    .get_webview_window("main")
                    .and_then(|w| w.hwnd().ok())
                    .map(|h| h.0 as isize);
                match hwnd {
                    Some(raw) => {
                        if let Some(h) = smtc::init(raw, handle.clone(), engine.clone()) {
                            engine.set_smtc(Some(h));
                        }
                    }
                    None => log::warn!("[smtc] 取不到主窗口句柄，系统媒体控制未启用"),
                }
            }

            // 任务栏缩略图工具栏：悬停任务栏图标时在预览下方给「上一首 / 播放暂停 / 下一首」。
            // 与 SMTC 一样属于旁路能力，失败只记日志，不影响播放。
            if let Err(e) = taskbar::init(&handle) {
                log::warn!("[taskbar] 任务栏缩略图工具栏未启用: {e}");
            }

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
                url_cache,
                engine,
                audio_cache_dir,
                db,
                astral,
                downloads: Arc::new(download::DownloadManager::new()),
            });

            // 下载 2.0 收尾：上次退出时还在 pending / downloading 的任务已无工作线程，
            // 统一落成 paused（可「继续」），避免界面永远停在「下载中」
            if let Some(db) = &app.state::<AppState>().db {
                match db.with(crate::db::store::mark_stale_downloads_paused) {
                    Ok(n) if n > 0 => log::info!("[download] {n} 个中断任务已置为暂停"),
                    Err(e) => log::warn!("[download] 中断任务清理失败: {e}"),
                    _ => {}
                }
            }

            tray::create_tray(&handle);
            shortcuts::register_shortcuts(&handle, &keymap);

            // 恢复上次开启的桌面歌词窗口（§4.2 位置记忆；失败不影响主流程）
            if lyric_window::get_state(&handle).visible {
                if let Err(e) = lyric_window::show(&handle) {
                    log::warn!("[lyric-window] 恢复失败: {e}");
                }
            }

            // 音源引擎窗口（音源包热更新 P1）：常驻隐藏 webview，加载远程
            // 音源包跑取链；创建失败不影响主流程（主窗口有内置实现兜底）
            if let Err(e) = source_window::create(&handle) {
                log::warn!("[source-engine] 引擎窗口创建失败，取链走内置实现: {e}");
            }

            // visible:false → 等前端首帧 show()，避免白屏闪烁（DESIGN §4.1）
            if let Some(win) = handle.get_webview_window("main") {
                let _ = win.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmd_builtin_request,
            cmd_set_resolved_play_url,
            cmd_script_bridge_ready,
            cmd_resolve_play_url_reply,
            cmd_invalidate_play_url,
            source_bundle::cmd_source_chain_overlay,
            source_install::cmd_source_state,
            source_install::cmd_source_manifest,
            source_install::cmd_source_install,
            source_install::cmd_source_apply,
            source_install::cmd_app_restart,
            source_install::cmd_source_rollback_builtin,
            source_install::cmd_source_mark_bad,
            source_install::cmd_source_report,
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
            cmd_queue_add_next,
            cmd_queue_append,
            cmd_queue_remove_at,
            cmd_queue_move,
            cmd_queue_clear_after,
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
            cmd_open_lyric_settings,
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
            cmd_set_setting,
            // 收藏同步（DESIGN §5.3；契约同 qt-uniappx services/like.ts）
            cmd_like_push_song,
            cmd_like_push_playlist,
            cmd_like_pull,
            cmd_like_pull_all,
            cmd_like_apply,
            cmd_like_flush_pending,
            cmd_like_reconcile,
            cmd_like_clear_local,
            cmd_like_reset_sync,
            // 本地音乐库（DESIGN §13）
            cmd_scan_library,
            cmd_list_drives,
            cmd_get_local_tracks,
            cmd_get_scan_dirs,
            cmd_add_scan_dir,
            cmd_remove_scan_dir,
            cmd_reveal_local_track,
            cmd_delete_local_track,
            cmd_delete_local_tracks,
            cmd_get_missing_local_tracks,
            cmd_purge_missing_local_tracks,
            cmd_get_local_cover,
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
            cmd_list_downloaded_track_ids,
            cmd_delete_download,
            cmd_delete_downloads,
            cmd_pause_download,
            cmd_resume_download,
            cmd_retry_download,
            cmd_cancel_download,
            cmd_reveal_download,
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
