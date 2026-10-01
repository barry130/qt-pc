//! 应用数据根目录（单一真值）。
//!
//! Windows = `%APPDATA%/QuietMusic`（数据库 `data/music.db`、音源包 `source-bundle/`
//! 都在其下）；其他平台跟随 Tauri 的 `app_cache_dir`。
//!
//! 为什么不用 `app_data_dir()`：那是 `<identifier>` 口径（`com.qt.quietmusic`），
//! 与 DESIGN §8.1 的目录设计不一致，故按设计显式拼。
//!
//! 旧名迁移：1.0.3 之前目录叫 `LightListen`（应用当时叫 LightListen）。首次启动
//! 新版本时若新目录不存在而旧目录在，就整目录改名过去——曲库、收藏、播放历史、
//! 已装音源包全部保留。改名失败（被占用等）时**继续用旧目录**：宁可不迁移，也不能
//! 让用户看起来像数据没了。

use std::path::PathBuf;
use tauri::Manager;

/// 旧版（LightListen 时期）目录名
const LEGACY_DIR_NAME: &str = "LightListen";
/// 当前目录名
const DIR_NAME: &str = "QuietMusic";

/// 应用数据根目录；首次调用时顺带完成旧名目录迁移（幂等）。
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
        cache_base(app)
    }
}

/// 拿不到 APPDATA 时的兜底根目录
fn cache_base<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    app.path()
        .app_cache_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}
