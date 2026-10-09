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
use tauri::Manager;

/// 旧版（LightListen 时期）目录名
const LEGACY_DIR_NAME: &str = "LightListen";
/// 当前目录名
const DIR_NAME: &str = "QuietMusic";

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
/// Windows 保持既有口径 `%APPDATA%/QuietMusic/logs`；macOS 用系统惯例
/// `~/Library/Logs/QuietMusic`；Linux 用 XDG 规范 `$XDG_STATE_HOME/QuietMusic/logs`
/// （缺省 `~/.local/state/...`，XDG_STATE_HOME 就是给日志/运行态数据定义的家）。
/// 返回 None 时 file_logger 退化为仅 stderr（与拿不到 APPDATA 的既有行为一致）。
pub(crate) fn logs_root_from_env() -> Option<PathBuf> {
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

/// 拿不到 APPDATA 时的兜底根目录
fn cache_base<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}
