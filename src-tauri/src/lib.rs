//! 轻听 PC 版 Tauri 入口（lib 形式，便于集成测试）。

pub mod ai_local;
pub mod app_config;
pub mod app_paths;
pub mod astral;
pub mod audio;
pub mod backup;
pub mod cache;
pub mod commands;
pub mod cue;
pub mod db;
pub mod download;
/// 下载成品内嵌封面 / 歌词（「下载存储方式 = 音乐内嵌」，lofty 读写标签）
pub mod embed;
/// 「外部打开」的待取队列与命令行解析（拖拽入窗 / 命令行参数 / 第二实例转发）
pub mod external_open;
/// 文件关联与「设为默认播放器」（第二波）
pub mod file_assoc;
pub mod file_logger;
pub mod ipc_guard;
/// 重复文件检测与只读整理预览
pub mod library_maintenance;
pub mod library_scan;
/// 听歌报告只读分页查询
pub mod listen_report;
/// 本地优先播放（DESIGN §7.13）：解析链 / 替身链 / 启动对账
pub mod local_first;
pub mod local;
pub mod lyric_window;
pub mod media;
/// 迷你播放器悬浮窗（第二波）
pub mod mini_window;
/// 全局网络配置：代理与单源超时（第二波）
pub mod net_config;
pub mod net_guard;
pub mod pack_safety;
pub mod pack_signature;
pub mod playlist_io;
pub mod playurl_bridge;
/// 私有配置的编译期常量（由 scripts/sync-config.mjs 生成；缺失时 build.rs 补空壳）
pub mod private_config;
pub mod provider;
pub mod qtres;
/// 本地化推荐合辑（第二波）
pub mod recommend;
/// 运行期私有配置（自有域名 / 生产后端 / 官网地址，启动时按顺序找本地文件）
pub mod runtime_config;
/// 引擎 → 前端替身搜索桥（本地优先池 C，DESIGN §7.13）
pub mod search_bridge;
pub mod settings_keys;
pub mod shortcuts;
pub mod smtc;
pub mod source_bundle;
pub mod source_install;
pub mod source_pack_header;
pub mod source_window;
pub mod taskbar;
pub mod tray;
/// 音源账号网页登录（v17 契约 auth.webLogin：官方登录页 + Cookie 捕获）
pub mod web_login;

use std::path::PathBuf;
use std::sync::Arc;

use audio::engine::AudioEngine;
use commands::*;
use db::Database;
use provider::types::{Quality, Track};
use provider::url_cache::{PlayUrlCache, ResolvedPlayUrl};
use provider::ProviderError;
use tauri::{Emitter, Manager};

/// 主窗口 label（= tauri.conf.json `app.windows[0].label`；前端对应
/// src/lib/window-labels.ts）。托盘 / SMTC / 任务栏 / 单实例 / 歌词窗的跨窗口
/// 通信都以它定位主窗口，调用点不要散写字面量（契约由 tests/window-labels-contract.test.ts 守护）。
pub const MAIN_WINDOW_LABEL: &str = "main";

/// 全局应用状态
pub struct AppState {
    pub url_cache: Arc<PlayUrlCache>,
    pub engine: AudioEngine,
    /// 播放缓存的**根目录**（默认安装目录下的 `cache`，设置页可改，settings
    /// key = `cache.dir`）。音频缓存是它下面的 `audio`。
    ///
    /// 用 `Mutex` 而不是普通字段：设置页换目录后，`audio_cache_stats` /
    /// `clear_audio_cache` 必须跟着看新目录，否则用户换完目录再点「清理缓存」
    /// 清的还是旧位置。锁中毒按仓库惯例 `unwrap_or_else(|p| p.into_inner())`。
    pub cache_root: std::sync::Mutex<PathBuf>,
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
/// 前端脚本线路是唯一的第三方取链路径。
///
/// **失败必须分级**（2026-10-03 弱网修复）：`ask_frontend` 的三种结果映射到
/// 两种语义完全不同的错误 ——
/// · `NoUrl`（脚本链跑完但没地址）→ `NoPlayableUrl`：**内容问题**，这首都
///   没有可播地址，应该跳下一首、计入熔断；
/// · `Stalled`（等待超时 / 前端未就绪）→ `ResolveStalled`：**环境问题**，
///   等一会儿可能就好，绝不能计入熔断，否则弱网 5 首就把自动切歌关死
///   （`ProviderError::is_stalled` 是引擎侧判据的唯一来源）。
pub(crate) async fn resolve_play_url_script(
    app: &tauri::AppHandle,
    cache: &PlayUrlCache,
    track: &Track,
    quality: Quality,
) -> CmdResult<ResolvedPlayUrl> {
    let key = PlayUrlCache::cache_key(track.platform.as_str(), &track.id, quality_str(&quality));
    if let Some(hit) = cache.get(&key) {
        return Ok(hit);
    }
    let reply = match crate::playurl_bridge::ask_frontend(app, track, quality).await {
        crate::playurl_bridge::AskOutcome::Url {
            url,
            referer,
            size,
            actual_quality,
        } => crate::provider::url_cache::ResolvedPlayUrl {
            url,
            referer,
            size,
            actual_quality,
            fetched_at: 0,
        },
        crate::playurl_bridge::AskOutcome::NoUrl => return Err(ProviderError::NoPlayableUrl),
        crate::playurl_bridge::AskOutcome::Stalled => return Err(ProviderError::ResolveStalled),
    };
    cache.set(key.clone(), reply);
    // fetched_at 由 set 写入当前时间；这里再读一次拿到真实时间戳
    cache.get(&key).ok_or(ProviderError::NoPlayableUrl)
}

pub(crate) fn quality_str(q: &Quality) -> &str {
    q.as_str()
}

// ---------- 组装 ----------

/// 托盘是否注册成功。默认 true（Windows/macOS 托盘始终可用）；
/// setup 里 create_tray 失败（Linux 无托盘宿主）时置 false，
/// 主窗口的关闭语义随之从「收进托盘」切换为「直接退出」。
static TRAY_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

pub fn run() {
    // 文件日志与 panic 钩子最先装：release 无控制台，之后所有 log:: 输出和
    // panic 现场都要有落盘处（Windows: %APPDATA%/QuietMusic/logs；
    // macOS: ~/Library/Logs/QuietMusic；Linux: $XDG_STATE_HOME/QuietMusic/logs，
    // 见 app_paths::logs_root_from_env 与 file_logger 模块注释）
    file_logger::init(crate::app_paths::logs_root_from_env());
    file_logger::install_panic_hook();

    tauri::Builder::default()
        // 单实例必须最先注册（插件内部靠启动竞态判定谁是主实例）：
        // 第二个实例拉起时把已有主窗口带到前台然后立刻退出
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // 第二实例可能是被「打开方式 / 拖到图标上」拉起来的，它带的文件参数
            // 要由**已经在运行的**我们打开（第二个实例本身马上就退出了）。
            // 参数先入待取队列再叫前端来取：前端此刻可能还没注册监听。
            let paths =
                crate::external_open::paths_from_args(&args, Some(std::path::Path::new(&cwd)));
            if !paths.is_empty() {
                crate::external_open::push(paths);
                crate::external_open::notify(app);
            }
            let _ = crate::mini_window::hide(app);
        }))
        .register_asynchronous_uri_scheme_protocol("qtres", qtres::handle_qtres)
        // 开机自启（设置页「通用」分区读写；Windows 实现为注册表 Run 键）
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // 本地音乐文件夹选择（/library/folders 用它的目录选择对话框）
        .plugin(tauri_plugin_dialog::init())
        // 系统通知（音频引擎自动切歌熔断时后台告知，audio::engine::notify_failure）
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            // §4 关闭行为：点关闭 = 最小化到托盘，退出走托盘菜单。
            // 托盘不可用的环境（Linux GNOME 无托盘扩展等，setup 里
            // create_tray 返回 false 时置 TRAY_READY=false）没有「藏起来」
            // 这一说——收进托盘等于再也找不到，所以放行真关闭退出。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN_WINDOW_LABEL
                    && TRAY_READY.load(std::sync::atomic::Ordering::Acquire)
                {
                    // 统计（STATS_DESIGN §4.1）：收进托盘 = 一轮 show→hide 结束，
                    // 让前端结算停留时长并冲队列
                    let _ = window.emit("stat_window_hidden", ());
                    api.prevent_close();
                    let _ = window.hide();
                } else if window.label() == crate::mini_window::MINI_WINDOW_LABEL {
                    // 迷你窗的「关闭」（Alt+F4 / 系统菜单）= 回主窗，不销毁、
                    // 不退出应用：用户按关闭想的是「退出迷你模式」。
                    api.prevent_close();
                    let _ = crate::mini_window::hide(window.app_handle());
                }
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // 首个实例自己的命令行参数（「打开方式」/终端 `QuietMusic.exe 歌.flac`）：
            // 这里只入队，不 emit —— 此刻前端还没起来，挂载时会主动来取
            // （见 crate::external_open 模块注释）。
            let startup_paths = crate::external_open::paths_from_args(
                &crate::external_open::argv_from_env(),
                std::env::current_dir().ok().as_deref(),
            );
            if !startup_paths.is_empty() {
                log::info!("[open] 命令行待打开 {} 个条目", startup_paths.len());
                crate::external_open::push(startup_paths);
            }
            // 数据库：DESIGN §8.1 %APPDATA%/QuietMusic/data/music.db
            // 口径集中在 app_paths::data_root（含 LightListen 旧目录迁移）
            let db_root = crate::app_paths::data_root(&handle);
            // 走 open_checked 而不是 open：坏库要隔离重建（并给用户回执），
            // 好库则顺手做一份滚动备份（详见 db::health）
            let db = match Database::open_checked(&db_root.join("data").join("music.db")) {
                Ok((db, _notice)) => Some(Arc::new(db)),
                Err(e) => {
                    log::error!("{e}；本次运行无持久化，播放不受影响");
                    None
                }
            };

            // 命令行导出（`QuietMusic.exe --export-backup <目录>`）：给自动备份/换机迁移用。
            // 主窗口在配置里是 `visible: false`（由前端就绪后再 show），所以这里导完直接
            // 退出不会闪一个空窗口；失败用非 0 退出码，方便任务计划/脚本判断。
            if let Some(dir) =
                crate::backup::export_dir_from_args(&crate::external_open::argv_from_env())
            {
                let code = match db.as_ref() {
                    Some(db) => match crate::backup::export(db, &dir) {
                        Ok(info) => {
                            log::info!("[backup] 命令行导出完成：{}", info.path);
                            0
                        }
                        Err(e) => {
                            log::error!("[backup] 命令行导出失败：{e}");
                            1
                        }
                    },
                    None => {
                        log::error!("[backup] 数据库不可用，命令行导出中止");
                        1
                    }
                };
                std::process::exit(code);
            }

            // 日志参数（级别 / 单文件大小 / 保留份数 / 目录）：必须等数据库打开后
            // 才能读到用户配置。这里只做一次「盖上去」——运行期改配置走设置命令。
            {
                let read = |key: &str| -> Option<String> {
                    db.as_ref()
                        .and_then(|db| db.with(|c| crate::db::store::get_setting(c, key)).ok())
                        .flatten()
                };
                let dir = read(crate::file_logger::SETTING_LOG_DIR);
                let level = read(crate::file_logger::SETTING_LOG_LEVEL);
                let file_mb = read(crate::file_logger::SETTING_LOG_FILE_MB);
                let backups = read(crate::file_logger::SETTING_LOG_BACKUPS);
                crate::file_logger::apply_settings(
                    dir.as_deref(),
                    level.as_deref(),
                    file_mb.as_deref(),
                    backups.as_deref(),
                );
            }

            // 本地优先播放（DESIGN §7.13）启动对账：把 V19 之前已 done 的
            // 存量任务补进账本、清掉指向已消失文件的账本条目、重建孤儿
            // 索引。后台跑不卡冷启动；失败只记日志（下次启动重试，期间
            // 解析链照常工作——账本/孤儿可能少几条，回落在线不受影响）。
            if let Some(db) = db.clone() {
                let dl_dir = crate::commands::download_dir_for(Some(&db));
                tauri::async_runtime::spawn_blocking(move || match dl_dir {
                    Ok(dir) => crate::local_first::reconcile(&db, &dir),
                    Err(e) => log::warn!("[local-first] 下载目录不可用，跳过对账: {e}"),
                });
            }

            // 缓存根目录：默认**安装目录下的 `cache`**（见 app_paths::cache_root），
            // 安装目录不可写时回落 app_cache_dir()。设置页可改成任意目录
            // （settings key = cache.dir，见 commands::cmd_choose_cache_dir）。
            let cache_root = match db.as_ref().and_then(|db| {
                db.with(|c| crate::db::store::get_setting(c, crate::cache::SETTING_CACHE_DIR))
                    .ok()
                    .flatten()
            }) {
                Some(dir) if !dir.trim().is_empty() => PathBuf::from(dir.trim()),
                _ => crate::app_paths::cache_root(&handle),
            };
            let audio_cache_dir = cache_root.join("audio");

            let url_cache = Arc::new(PlayUrlCache::new());

            let engine = AudioEngine::spawn(
                handle.clone(),
                audio_cache_dir,
                Arc::clone(&url_cache),
                db.clone(),
            );

            // 系统媒体控制（Windows SMTC / Linux MPRIS / macOS 正在播放）：
            // 系统媒体面板 + 硬件媒体键 / 蓝牙耳机按键。需要主窗口 HWND 的只有
            // Windows（SMTC 绑定窗口），其他平台忽略；取不到或初始化失败就
            // 静默降级，不影响播放。
            #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
            {
                #[cfg(target_os = "windows")]
                let hwnd = handle
                    .get_webview_window(MAIN_WINDOW_LABEL)
                    .and_then(|w| w.hwnd().ok())
                    .map(|h| h.0 as isize);
                #[cfg(not(target_os = "windows"))]
                let hwnd = Some(0isize);
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

            // 私有配置（自有域名 / 生产后端 / 官网）的来源：运维排查"改了地址怎么没生效"
            // 时，第一件要知道的就是这次运行到底读没读到文件、读到的是哪一个。
            // 没读到不算故障（公开仓库形态本来就该没有），所以是 info 不是 warn。
            match runtime_config::source_path() {
                Some(p) => log::info!("[config] 私有配置来源 {}", p.display()),
                None => log::info!(
                    "[config] 未找到 {}，编译期私有常量生效（自有域名列表为空则明文下载一律被拒）",
                    runtime_config::FILE_NAME
                ),
            }

            let astral = Arc::new(astral::AstralClient::new(runtime_config::base_url()));
            // 401 自动刷新换到的新会话要能落库（否则重启又回到过期会话）
            astral.set_session_db(db.clone());

            // 回填上次的登录会话（token 存 settings 表），没过期才装进客户端
            if let Some(db) = &db {
                match db.with(|conn| {
                    crate::db::store::get_setting(conn, crate::astral::SETTING_ASTRAL_SESSION)
                }) {
                    // 登出写的是空串（astral::clear_persisted_session），空值 = 未登录。
                    // 空串喂给 serde_json 只会得到 "EOF while parsing a value"，
                    // 每次启动白打一条像故障的 WARN —— 先判空再解析。
                    Ok(Some(json)) if !json.trim().is_empty() => {
                        match serde_json::from_str::<astral::AuthSession>(&json) {
                            Ok(session) if session.is_valid() => {
                                astral.set_session(&session);
                                log::info!("[astral] 已恢复上次登录会话");
                            }
                            Ok(_) => log::info!("[astral] 上次会话已过期，需要重新登录"),
                            Err(e) => log::warn!("[astral] 会话解析失败: {e}"),
                        }
                    }
                    Ok(_) => {}
                    Err(e) => log::warn!("[astral] 读取会话失败: {e}"),
                }
            }

            app.manage(AppState {
                url_cache,
                engine,
                cache_root: std::sync::Mutex::new(cache_root),
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
                // 回填用户设置的「同时下载数」（settings 表 key = download.maxConcurrent）。
                // 必须在这里做而不是在 manage() 之前：AppState 还没建，拿不到闸门。
                match commands::load_download_concurrency(db) {
                    Ok(Some(n)) => {
                        let n = download::clamp_concurrency(n);
                        app.state::<AppState>().downloads.set_concurrency(n);
                        log::info!("[download] 同时下载数 = {n}");
                    }
                    Ok(None) => {}
                    Err(e) => log::warn!("[download] 读取同时下载数失败: {e}"),
                }
            }

            // 网络配置（第二波：代理与单源超时）装载必须赶在任何 HTTP 客户端
            // 首次构建前 —— 常驻客户端按代际缓存重建（net_config::shared_*_client），
            // 这里先装好全局，客户端首建即吃到用户配置。失败不影响启动
            //（回退默认：跟随系统 + 10s）。
            if let Some(db) = &app.state::<AppState>().db {
                let _ = db.with(|conn| {
                    crate::net_config::init_from_db(conn);
                    Ok(())
                });
            }

            // 托盘注册：失败（Linux GNOME 无托盘扩展、无 StatusNotifier 宿主等）
            // 不能只记日志——「点关闭 = 收进托盘」的关闭语义在没有托盘时等于
            // 用户没有任何退出入口（主窗口藏起来后只能 kill）。因此托盘没建成
            // 时改主窗口关闭语义为直接退出（见 on_window_event 的 tray_ready）。
            let tray_ok = tray::create_tray(&handle);
            if !tray_ok {
                log::warn!("[tray] 托盘不可用，主窗口关闭将直接退出应用");
                TRAY_READY.store(false, std::sync::atomic::Ordering::Release);
            }
            shortcuts::register_shortcuts(&handle, &keymap);

            // 恢复上次开启的桌面歌词窗口（§4.2 位置记忆；失败不影响主流程）
            if lyric_window::get_state(&handle).visible {
                if let Err(e) = lyric_window::show(&handle) {
                    log::warn!("[lyric-window] 恢复失败: {e}");
                }
            }

            // 音源引擎窗口（音源包热更新 P1）：常驻隐藏 webview，加载已安装
            // 音源包跑取链；创建失败不影响主流程（在线功能暂不可用）
            if let Err(e) = source_window::create(&handle) {
                log::warn!("[source-engine] 引擎窗口创建失败，在线取链不可用: {e}");
            }

            // visible:false → 等前端首帧 show()，避免白屏闪烁（DESIGN §4.1）
            if let Some(win) = handle.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = win.show();
            }
            Ok(())
        })
        // 所有应用命令都过一层来源授权：音源引擎窗口（会把第三方脚本 import
        // 进自己 JS 环境）默认只能调用 ipc_guard 白名单里的命令（见 ipc_guard.rs）
        .invoke_handler(ipc_guard::guarded(tauri::generate_handler![
            cmd_builtin_request,
            cmd_set_resolved_play_url,
            cmd_script_bridge_ready,
            cmd_resolve_play_url_reply,
            cmd_search_substitute_reply,
            cmd_get_local_first,
            cmd_set_local_first,
            cmd_resolve_local_file,
            cmd_invalidate_play_url,
            source_bundle::cmd_source_chain_overlay,
            source_install::cmd_source_state,
            source_install::cmd_source_discover_updates,
            source_install::cmd_source_apply_update,
            source_install::cmd_source_install_from_url,
            source_install::cmd_source_install_from_text,
            source_install::cmd_source_install_local_file,
            source_install::cmd_source_stage_from_url,
            source_install::cmd_source_stage_from_file,
            source_install::cmd_source_install_staged,
            source_install::cmd_source_activate_pack,
            source_install::cmd_source_uninstall_pack,
            source_install::cmd_source_pack_describe,
            source_install::cmd_source_pack_verified,
            source_install::cmd_source_pack_load_failed,
            source_install::cmd_source_meta_loaded,
            source_install::cmd_source_meta_load_failed,
            source_install::cmd_source_report,
            source_install::cmd_source_engine_log,
            web_login::source_web_login_open,
            web_login::source_web_login_capture,
            web_login::source_web_login_close,
            web_login::source_web_login_diagnose_names,
            cmd_play_track,
            cmd_play_queue,
            cmd_set_default_quality,
            cmd_set_track_quality,
            cmd_set_source_qualities,
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
            cmd_queue_remove_indices,
            cmd_pause,
            cmd_resume,
            cmd_stop,
            cmd_seek,
            cmd_set_speed,
            cmd_set_gapless,
            cmd_set_sleep_timer,
            cmd_get_fx_state,
            cmd_set_eq,
            cmd_set_loudnorm,
            cmd_set_fade,
            cmd_set_spectrum,
            cmd_audio_cache_stats,
            cmd_clear_audio_cache,
            cmd_clear_web_cache,
            cmd_clear_play_url_cache,
            cmd_set_audio_cache_limit,
            cmd_autostart_state,
            cmd_set_autostart,
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
            cmd_official_site_url,
            cmd_show_desktop_lyric,
            cmd_hide_desktop_lyric,
            cmd_get_desktop_lyric_state,
            cmd_set_desktop_lyric_locked,
            cmd_set_desktop_lyric_style,
            cmd_set_desktop_lyric_bounds,
            cmd_reset_desktop_lyric,
            cmd_open_lyric_settings,
            cmd_get_lyric_offset,
            cmd_set_lyric_offset,
            cmd_save_lyric,
            cmd_get_lyric,
            cmd_save_binary_file,
            cmd_list_dislikes,
            cmd_add_dislike_song,
            cmd_add_dislike_singer,
            cmd_remove_dislike_singer,
            cmd_remove_dislike_rule,
            cmd_clear_dislikes,
            cmd_check_disliked,
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
            // AI 助手（契约同 qt-uniappx services/ai.ts；clientType 固定 QT_PC）
            cmd_astral_ai_agents,
            cmd_astral_ai_capabilities,
            cmd_astral_ai_conversations,
            cmd_astral_ai_create_conversation,
            cmd_astral_ai_conversation,
            cmd_astral_ai_delete_conversation,
            cmd_astral_ai_messages,
            cmd_astral_ai_send_message,
            cmd_astral_ai_events,
            cmd_astral_ai_cancel_request,
            cmd_astral_ai_feedback,
            cmd_astral_ai_execute_action,
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
            // 媒体直传（UPDATE_DESIGN.md §5.2/§5.3）
            cmd_astral_upload_avatar,
            cmd_astral_upload_playlist_cover,
            cmd_astral_clear_playlist_cover,
            // 听歌统计（DESIGN §5.3）
            cmd_get_play_overview,
            cmd_get_top_tracks,
            cmd_get_top_singers,
            listen_report::cmd_get_listen_report,
            listen_report::cmd_get_listen_day_report,
            cmd_seed_listen_days,
            cmd_clear_listen_stats,
            recommend::cmd_list_local_mixes,
            recommend::cmd_get_local_mix_tracks,
            // 客户端直连模型（每日推荐 AI 精选；Key 只留在 Rust 侧）
            ai_local::cmd_ai_local_config,
            ai_local::cmd_ai_local_save_config,
            ai_local::cmd_ai_local_test,
            ai_local::cmd_ai_local_list_models,
            ai_local::cmd_ai_local_chat,
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
            cmd_get_local_track_files,
            cmd_get_scan_dirs,
            cmd_add_scan_dir,
            cmd_remove_scan_dir,
            cmd_reveal_local_track,
            cmd_delete_local_track,
            cmd_delete_local_tracks,
            cmd_get_missing_local_tracks,
            cmd_purge_missing_local_tracks,
            library_maintenance::cmd_find_library_duplicates,
            library_maintenance::cmd_cancel_library_duplicate_scan,
            library_maintenance::cmd_preview_library_organization,
            cmd_get_local_cover,
            cmd_read_local_lyric,
            cmd_open_local_paths,
            cmd_take_pending_open_paths,
            cmd_take_db_notice,
            cmd_export_backup,
            cmd_import_backup,
            cmd_export_playlist,
            cmd_parse_playlist_json,
            // 收藏 / 播放历史（DESIGN §5.3）
            cmd_add_favorite,
            cmd_remove_favorite,
            cmd_list_favorites,
            cmd_list_track_playlists,
            cmd_is_favorite,
            cmd_check_favorite_flags,
            cmd_favorite_playlist,
            cmd_unfavorite_playlist,
            cmd_list_favorite_playlists,
            cmd_is_playlist_favorited,
            cmd_list_history,
            cmd_clear_history,
            cmd_remove_history,
            cmd_remove_history_many,
            cmd_count_missing_history,
            cmd_purge_missing_history,
            // 我的歌单（DESIGN §5.3）
            cmd_create_playlist,
            cmd_rename_playlist,
            cmd_delete_playlist,
            cmd_set_playlist_cover,
            cmd_get_playlist_cover,
            cmd_list_my_playlists,
            cmd_get_playlist_tracks,
            cmd_add_tracks_to_playlist,
            cmd_remove_track_from_playlist,
            cmd_remove_tracks_from_playlist,
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
            cmd_pause_downloads,
            cmd_resume_downloads,
            cmd_cancel_downloads,
            cmd_write_download_lyric,
            cmd_reveal_download,
            cmd_reveal_logs,
            cmd_write_log,
            cmd_get_download_dir,
            cmd_choose_download_dir,
            cmd_reset_download_dir,
            cmd_get_download_concurrency,
            cmd_set_download_concurrency,
            // 日志与缓存目录（设置页「通用 → 诊断」；日志级别仅 qt_admin 可见）
            cmd_get_log_config,
            cmd_set_log_config,
            cmd_choose_log_dir,
            cmd_reset_log_dir,
            cmd_get_cache_dir,
            cmd_choose_cache_dir,
            cmd_reset_cache_dir,
            // 网络设置（第二波：代理与单源超时）
            cmd_get_net_config,
            cmd_set_net_config,
            cmd_test_net_config,
            // 迷你播放器窗口（第二波 §3.21.7.2）
            cmd_toggle_mini_player,
            cmd_get_file_association_state,
            cmd_register_file_associations,
            cmd_unregister_file_associations,
            cmd_open_default_apps_settings,
        ]))
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                crate::mini_window::remember_position(app);
            }
        });
}
