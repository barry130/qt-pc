//! 应用数据根目录（单一真值）。
//!
//! Windows = `%APPDATA%/QuietMusic`（数据库 `data/music.db`、音源包 `source-bundle/`
//! 都在其下）；Linux = `$XDG_DATA_HOME/QuietMusic`（缺省 `~/.local/share/QuietMusic`）；
//! macOS = `~/Library/Application Support/QuietMusic` —— 后两者由 Tauri 的
//! `data_dir()`（平台数据目录，不含 identifier）+ 显式拼目录名得到，与 Windows 口径
//! 完全一致。
//!
//! 为什么不用 `app_data_dir()`：那是 `<identifier>` 口径（`com.qt.quietmusic`），
//! 与 DESIGN §8.1 的目录设计不一致，故按设计显式拼。
//!
//! 旧名迁移：1.0.3 之前目录叫 `LightListen`（应用当时叫 LightListen）。首次启动
//! 新版本时若新目录不存在而旧目录在，就整目录改名过去——曲库、收藏、播放历史、
//! 已装音源包全部保留。改名失败（被占用等）时**继续用旧目录**：宁可不迁移，也不能
//! 让用户看起来像数据没了。（迁移逻辑只在 Windows 有历史目录需要搬，非 Windows
//! 是全新口径，直接落新目录。）

use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::Manager;

/// 旧版（LightListen 时期）目录名
const LEGACY_DIR_NAME: &str = "LightListen";
/// 当前目录名（`runtime_config` 找 `app.config.local.json` 时也用这个口径）
pub(crate) const DIR_NAME: &str = "QuietMusic";

/// 安装目录（exe 所在目录）且**确认可写**；日志与缓存默认都挂在它下面。
///
/// 为什么不是 `app_cache_dir()`：那是 `%LOCALAPPDATA%` 口径 —— 装在 E 盘也把
/// 缓存/日志写到 C 盘用户目录，便携使用和「看安装目录就知道占了多少空间」都做不到。
/// 安装方式本身是 currentUser（无需管理员），exe 所在目录天然可写。
///
/// 为什么必须真探一次写权限：`create_dir_all` 在只读位置（Program Files、
/// AppImage 的只读挂载、`/usr/bin`）会失败，但「目录已存在」时也可能通过而后
/// 续写入被拒 —— 只有真写一个探针文件才能确定。探针用完即删。
///
/// 结果缓存：同一次运行里日志与缓存必须做出同样的选择，否则用户会在两个位置
/// 各看到一半数据。
///
/// macOS 排除在外：安装目录在 `.app` bundle 内部，往里写数据会破坏 bundle 的
/// 签名封装，因此继续用系统惯例 `~/Library/Logs` / `app_cache_dir()`。
#[cfg(not(target_os = "macos"))]
fn install_base() -> Option<&'static PathBuf> {
    static PROBED: OnceLock<Option<PathBuf>> = OnceLock::new();
    PROBED
        .get_or_init(|| {
            let dir = std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(PathBuf::from))?;
            if std::fs::create_dir_all(&dir).is_err() {
                return None;
            }
            let probe = dir.join(".quietmusic-write-probe");
            let ok = std::fs::write(&probe, b"").is_ok();
            let _ = std::fs::remove_file(&probe);
            ok.then_some(dir)
        })
        .as_ref()
}

#[cfg(target_os = "macos")]
fn install_base() -> Option<&'static PathBuf> {
    None
}

/// 应用数据根目录；首次调用时顺带完成旧名目录迁移（幂等，仅 Windows）。
pub(crate) fn data_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| cache_base(app));
        let root = base.join(DIR_NAME);
        if !root.exists() {
            let legacy = base.join(LEGACY_DIR_NAME);
            if legacy.exists() {
                match std::fs::rename(&legacy, &root) {
                    Ok(()) => log::info!(
                        "[app-paths] 数据目录已迁移: {} → {}",
                        legacy.display(),
                        root.display()
                    ),
                    Err(e) => {
                        log::error!(
                            "[app-paths] 数据目录迁移失败（{e}），本次继续使用旧目录 {}",
                            legacy.display()
                        );
                        return legacy;
                    }
                }
            }
        }
        root
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = LEGACY_DIR_NAME;
        app.path()
            .data_dir()
            .map(|base| base.join(DIR_NAME))
            .unwrap_or_else(|_| cache_base(app))
    }
}

/// 日志目录（不依赖 AppHandle：`run()` 里 file_logger 初始化时 Tauri 应用还没建）。
///
/// 默认**安装目录下的 `logs`**（见 [`install_base`]）；安装目录不可写时回落到
/// 各平台惯例：Windows `%APPDATA%/QuietMusic/logs`、macOS
/// `~/Library/Logs/QuietMusic`、Linux `$XDG_STATE_HOME/QuietMusic/logs`
/// （缺省 `~/.local/state/...`）。返回 None 时 file_logger 退化为仅 stderr。
pub(crate) fn logs_root_from_env() -> Option<PathBuf> {
    if let Some(base) = install_base() {
        return Some(base.join("logs"));
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(|b| PathBuf::from(b).join(DIR_NAME).join("logs"))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| {
            PathBuf::from(h)
                .join("Library")
                .join("Logs")
                .join(DIR_NAME)
        })
    }
    #[cfg(target_os = "linux")]
    {
        let base = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("state"))
            });
        base.map(|b| b.join(DIR_NAME).join("logs"))
    }
}

/// 播放缓存的默认根目录（`<安装目录>/cache`；不可写时回落 `app_cache_dir()`）。
/// 与日志目录同源，保证「安装目录下 cache/logs」这对默认值成立。
pub(crate) fn cache_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    if let Some(base) = install_base() {
        return base.join("cache");
    }
    cache_base(app)
}

/// 拿不到 APPDATA 时的兜底根目录
fn cache_base<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}
