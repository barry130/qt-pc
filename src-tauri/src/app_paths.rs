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
//!
//! 便携模式（DESIGN §8.2）：exe 同目录放一个 `portable.txt`（或用环境变量
//! `QUIETMUSIC_PORTABLE=1` 强制打开 / `=0` 强制关闭），数据根就改回 exe 目录
//! —— 库、音源包、歌单封面全在 `./data` 与 `./source-bundle`，整个文件夹拷到新机
//! 即可继续用，本机用户目录里不留任何东西。日志与缓存本来默认就在 exe 旁
//! （见 [`install_base`]），因此便携模式下两者天然同源。
//!
//! 便携模式排在旧名迁移之前：便携版是「自带数据」的，不该去搬 `%APPDATA%` 里的
//! 老库。反过来，只有 exe 目录**确认可写**才算便携（只读 U 盘上放 `portable.txt`
//! 会被忽略并回落常规目录，否则整次运行都没有持久化）。

use std::path::PathBuf;
// 只被 install_base()（macOS 除外）用到，所以跟着它一起条件编译：
// macOS 上留着这个 import 会撞 `-D unused-imports`
#[cfg(any(not(target_os = "macos"), test))]
use std::sync::OnceLock;
use tauri::Manager;

/// 旧版（LightListen 时期）目录名
const LEGACY_DIR_NAME: &str = "LightListen";
/// 当前目录名（`runtime_config` 找 `app.config.local.json` 时也用这个口径）
pub(crate) const DIR_NAME: &str = "QuietMusic";
/// 便携标记：exe 同目录放这个文件即走便携模式（内容不关心）
pub(crate) const PORTABLE_FLAG_FILE: &str = "portable.txt";
/// 便携开关的环境变量：`1/true/yes/on` 强制开，`0/false/no/off` 强制关，
/// 其余取值（含未设置）回到看标记文件 —— 覆盖装在只读介质、只想临时试一次的场景。
pub(crate) const PORTABLE_ENV: &str = "QUIETMUSIC_PORTABLE";

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
/// 真写一个探针文件确认目录可写（探针用完即删）。
///
/// 「目录已存在」不等于可写：Program Files、AppImage 的只读挂载、`/usr/bin`
/// 都可能建得出来却在写入时才被拒，所以必须真落一个字节。
// cfg 门与唯一的普通调用方 install_base() 对齐（macOS 上它不存在），单测也用。
// macOS 的非 test 构建里没有调用方，不跟着条件编译就是死码（CI -D warnings）。
#[cfg(any(not(target_os = "macos"), test))]
fn probe_writable(dir: &std::path::Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".quietmusic-write-probe");
    let ok = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

#[cfg(all(not(target_os = "macos"), not(test)))]
fn install_candidate() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from))
}

#[cfg(test)]
fn install_candidate() -> Option<PathBuf> {
    let dir = crate::public_test_fixture::root().join("qm-native-install");
    std::fs::create_dir(&dir).expect("exclusive owned install fixture");
    Some(dir)
}

#[cfg(any(not(target_os = "macos"), test))]
fn install_base() -> Option<&'static PathBuf> {
    static PROBED: OnceLock<Option<PathBuf>> = OnceLock::new();
    PROBED
        .get_or_init(|| {
            let dir = install_candidate()?;
            let writable = probe_writable(&dir);
            #[cfg(test)]
            assert!(
                writable,
                "owned install fixture must never fall back to user paths"
            );
            writable.then_some(dir)
        })
        .as_ref()
}

#[cfg(all(target_os = "macos", not(test)))]
fn install_base() -> Option<&'static PathBuf> {
    None
}

/// 便携开关判定：`env` 是 [`PORTABLE_ENV`] 的取值（`None` = 未设置）。
///
/// 环境变量优先于标记文件，好处是「同一份安装包，临时用环境变量试一次」不必
/// 到处放文件；写错的取值不报错、静默回到看标记文件 —— 这个开关不值得让启动失败。
fn portable_enabled_in(dir: &std::path::Path, env: Option<&str>) -> bool {
    match env.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("1" | "true" | "yes" | "on") => return true,
        Some("0" | "false" | "no" | "off") => return false,
        _ => {}
    }
    dir.join(PORTABLE_FLAG_FILE).is_file()
}

/// 便携数据根（= exe 目录）；未开便携或安装目录不可写时 `None`。
///
/// 结果来自 [`install_base`]（已带可写探测与 `OnceLock` 缓存），所以这里不再
/// 单独探一次：同一次运行里「日志挂在 exe 旁」与「数据挂在 exe 旁」必须同进同退。
fn portable_override(key: &str) -> Option<String> {
    #[cfg(test)]
    {
        assert_eq!(key, PORTABLE_ENV, "unexpected ambient environment lookup");
        // Explicit synthetic input keeps all default app paths in the attested root.
        Some("1".to_owned())
    }
    #[cfg(not(test))]
    {
        std::env::var(key).ok()
    }
}

pub(crate) fn portable_base_from<'a>(
    probed_dir: Option<&'a PathBuf>,
    env: Option<&str>,
) -> Option<&'a PathBuf> {
    probed_dir.filter(|dir| portable_enabled_in(dir, env))
}

pub(crate) fn portable_base() -> Option<&'static PathBuf> {
    let env = portable_override(PORTABLE_ENV);
    portable_base_from(install_base(), env.as_deref())
}

/// 当前是否处于便携模式（设置页 / 诊断包展示用）。
pub(crate) fn is_portable() -> bool {
    portable_base().is_some()
}

/// 应用数据根目录；首次调用时顺带完成旧名目录迁移（幂等，仅 Windows）。
pub(crate) fn data_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    // 便携模式：数据根 = exe 目录，整包拷走就能用。必须排在 `%APPDATA%` 与旧名
    // 迁移之前 —— 便携版自带数据，不该去动本机用户目录里的老库。
    if let Some(base) = portable_base() {
        let _ = std::fs::create_dir_all(base.join("data"));
        return base.clone();
    }
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
        std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Library").join("Logs").join(DIR_NAME))
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 独立临时目录（并行测试不撞名；用完删）
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = crate::public_test_fixture::root()
            .join(format!("qm-app-paths-{}-{tag}", std::process::id()));
        std::fs::create_dir(&dir).expect("排他创建已认证临时目录");
        dir
    }

    /// exe 同目录有 `portable.txt` → 便携
    #[test]
    fn portable_flag_file_opens_portable_mode() {
        let dir = temp_dir("flag");
        assert!(!portable_enabled_in(&dir, None), "没有标记文件不该是便携");
        std::fs::write(dir.join(PORTABLE_FLAG_FILE), b"").expect("写标记");
        assert!(portable_enabled_in(&dir, None));
        // 目录（而不是文件）不算标记：别让同名目录误开便携
        let other = temp_dir("flag-dir");
        std::fs::create_dir_all(other.join(PORTABLE_FLAG_FILE)).expect("建同名目录");
        assert!(!portable_enabled_in(&other, None));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }

    /// 环境变量优先于标记文件，取值不合法时回到看标记
    #[test]
    fn portable_env_overrides_flag() {
        let dir = temp_dir("env");
        // 没标记文件，环境变量打开
        for on in ["1", "true", "YES", " on "] {
            assert!(portable_enabled_in(&dir, Some(on)), "{on:?} 应开启便携");
        }
        std::fs::write(dir.join(PORTABLE_FLAG_FILE), b"").expect("写标记");
        // 有标记文件，环境变量关闭
        for off in ["0", "false", "No", "off"] {
            assert!(!portable_enabled_in(&dir, Some(off)), "{off:?} 应关闭便携");
        }
        // 认不出来的取值不打断启动，回到标记文件口径
        for junk in ["", "maybe", "2"] {
            assert!(
                portable_enabled_in(&dir, Some(junk)),
                "{junk:?} 应回落标记文件"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 探针会建目录、真写一次就删掉；建不出来的路径返回 false
    #[test]
    fn probe_writable_checks_real_write() {
        let dir = temp_dir("probe");
        let nested = dir.join("a").join("b");
        assert!(probe_writable(&nested), "新目录应可写");
        assert!(nested.is_dir());
        assert!(
            !nested.join(".quietmusic-write-probe").exists(),
            "探针必须删掉"
        );
        // 父路径是个文件 → 目录建不出来 → false（而不是 panic）
        let blocked = dir.join("blocker");
        std::fs::write(&blocked, b"").expect("写阻塞文件");
        assert!(!probe_writable(&blocked.join("child")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 未开便携时不认 exe 目录；明确关掉时即便有标记文件也不是便携
    #[test]
    fn portable_base_requires_flag() {
        let default = portable_base().expect("explicit synthetic portable input");
        assert_eq!(
            default.parent().unwrap().to_path_buf(),
            crate::public_test_fixture::root().to_path_buf()
        );
        assert!(is_portable());
        assert!(!default.join(".quietmusic-write-probe").exists());
        assert_eq!(logs_root_from_env(), Some(default.join("logs")));
        let dir = temp_dir("base");
        assert!(probe_writable(&dir));
        assert!(
            portable_base_from(Some(&dir), None).is_none(),
            "干净环境不该判定为便携"
        );
        std::fs::write(dir.join(PORTABLE_FLAG_FILE), b"").expect("写标记");
        assert!(
            portable_base_from(Some(&dir), Some("off")).is_none(),
            "明确关闭时标记不得开启便携"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
