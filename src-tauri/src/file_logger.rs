//! 文件日志（运维）：release 构建没有控制台（windows_subsystem），env_logger
//! 写的 stderr 一条都到不了用户机器上，报障时无现场可查。本模块把 log 记录与
//! panic 钩子统一落盘到 [`crate::app_paths::logs_root_from_env`] 给出的目录
//! （默认是**安装目录下的 `logs`**，安装目录不可写时回落
//! `%APPDATA%/QuietMusic/logs` / `~/Library/Logs/QuietMusic` /
//! `$XDG_STATE_HOME/QuietMusic/logs`；用户可在设置页改到任意目录）：
//! - 当前文件 `quietmusic.log`，写满一个文件就轮转出 `.1`~`.N`
//!   （默认 5 个备份 × 每份 10 MiB，按大小轮转不按日期，重启不清空）；
//! - 级别默认按构建区分：debug 构建（含 `tauri dev`）留 `Debug`，
//!   发行包只留 `Warn`（Info 里绝大多数是启动流程，真要看的是 Warn/Error）；
//!   `RUST_LOG` 与设置页里的 `log.level` 都能覆盖；
//! - debug 构建同时保留 stderr 输出（dev 终端照常可见）；
//! - 不引入新依赖：时间戳 Windows 用 GetLocalTime，其他平台退化 UTC。
//!
//! 用法：`run()` 最开头 `init()` + `install_panic_hook()`，其余代码照常用
//! `log::` 宏，无感知；数据库打开后再 `apply_settings()` 把用户配置（级别 /
//! 单文件大小 / 保留份数 / 目录）盖上去。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// settings 键：日志目录（空串 = 用默认，见 [`crate::app_paths::logs_root_from_env`]）。
/// 与 `download.dir` / `cache.audioLimitMb` 一样走点号风格。
pub const SETTING_LOG_DIR: &str = "log.dir";
/// settings 键：日志级别（debug / info / warn / error）
pub const SETTING_LOG_LEVEL: &str = "log.level";
/// settings 键：单个日志文件上限（MB）
pub const SETTING_LOG_FILE_MB: &str = "log.fileMb";
/// settings 键：日志轮转保留份数
pub const SETTING_LOG_BACKUPS: &str = "log.backups";

/// 默认单文件上限 10 MiB
pub const DEFAULT_FILE_MB: u64 = 10;
/// 默认轮转保留份数（quietmusic.log.1 ~ .5）
pub const DEFAULT_BACKUPS: u32 = 5;
/// 单文件上限允许区间（MB）：太小会一启动就轮转，太大一份文件不好往外发
pub const MIN_FILE_MB: u64 = 1;
pub const MAX_FILE_MB: u64 = 512;
/// 保留份数允许区间（份）
pub const MIN_BACKUPS: u32 = 1;
pub const MAX_BACKUPS: u32 = 50;

const CURRENT_NAME: &str = "quietmusic.log";

/// 运行期可变的日志参数。
///
/// 单文件上限与保留份数由设置页决定（默认 10 MiB × 5），所以不能是常量 ——
/// 但也不需要单独再造一个结构体，直接挂在已有的 [`Inner`] 上。
struct Inner {
    dir: Option<PathBuf>,
    file: Option<File>,
    /// 当前文件已写字节数（轮转判据）
    written: u64,
    /// 单个文件的上限（字节）
    max_file_bytes: u64,
    /// 轮转保留的历史文件数（quietmusic.log.1 ~ .N）
    max_backups: u32,
}

static LOGGER: OnceLock<Mutex<Inner>> = OnceLock::new();

/// 初始化文件日志。`dir` 传 None（拿不到 APPDATA 等异常环境）时退化为仅
/// stderr。必须在任何 log:: 宏调用之前执行。
pub fn init(dir: Option<PathBuf>) {
    let mut inner = Inner {
        dir: dir.clone(),
        file: None,
        written: 0,
        max_file_bytes: DEFAULT_FILE_MB * 1024 * 1024,
        max_backups: DEFAULT_BACKUPS,
    };
    if let Some(dir) = dir {
        if fs::create_dir_all(&dir).is_ok() {
            let current = dir.join(CURRENT_NAME);
            let oversize = fs::metadata(&current)
                .map(|m| m.len() >= inner.max_file_bytes)
                .unwrap_or(false);
            if oversize {
                inner.file = None;
                rotate(&dir, inner.max_backups);
            }
            inner.file = open_current(&dir);
            inner.written = fs::metadata(&current).map(|m| m.len()).unwrap_or(0);
        } else {
            inner.dir = None;
        }
    }
    let _ = LOGGER.set(Mutex::new(inner));
    let _ = log::set_boxed_logger(Box::new(FileLogger));
    log::set_max_level(level_from_env());
}

/// 当前日志目录（本次运行未启用文件日志时 None）。设置页「打开日志文件夹」用。
pub fn logs_dir() -> Option<PathBuf> {
    let mutex = LOGGER.get()?;
    let inner = mutex.lock().unwrap_or_else(|p| p.into_inner());
    inner.dir.clone()
}

/// 当前日志目录，拿不到运行期目录时回落默认目录。
///
/// 与 [`logs_dir`] 的区别：后者是「本次运行真的在写哪」，拿不到就是 None；
/// 这个多一步兜底，专门给设置页回显用 —— 用户改目录前也得看见「现在的目录
/// 是哪个」，而不是一个空白。
pub fn effective_dir() -> Option<PathBuf> {
    logs_dir().or_else(crate::app_paths::logs_root_from_env)
}

/// 当前生效的级别（设置页回显用）。
pub fn current_level() -> log::LevelFilter {
    log::max_level()
}

/// 当前生效的单文件上限（MB，设置页回显用）。
pub fn current_file_mb() -> u64 {
    LOGGER
        .get()
        .map(|m| {
            let inner = m.lock().unwrap_or_else(|p| p.into_inner());
            (inner.max_file_bytes / (1024 * 1024)).max(MIN_FILE_MB)
        })
        .unwrap_or(DEFAULT_FILE_MB)
}

/// 当前生效的保留份数（设置页回显用）。
pub fn current_backups() -> u32 {
    LOGGER
        .get()
        .map(|m| m.lock().unwrap_or_else(|p| p.into_inner()).max_backups)
        .unwrap_or(DEFAULT_BACKUPS)
}

/// `log.level` 的词 → 级别。无法识别的词返回 None（调用方回落默认）。
pub fn parse_level(raw: &str) -> Option<log::LevelFilter> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "trace" => Some(log::LevelFilter::Trace),
        "debug" => Some(log::LevelFilter::Debug),
        "info" => Some(log::LevelFilter::Info),
        "warn" | "warning" => Some(log::LevelFilter::Warn),
        "error" => Some(log::LevelFilter::Error),
        _ => None,
    }
}

/// 级别的稳定字符串（写回 settings / 回显用）。
pub fn level_name(level: log::LevelFilter) -> &'static str {
    match level {
        log::LevelFilter::Off => "error",
        log::LevelFilter::Error => "error",
        log::LevelFilter::Warn => "warn",
        log::LevelFilter::Info => "info",
        log::LevelFilter::Debug => "debug",
        log::LevelFilter::Trace => "trace",
    }
}

/// 把设置页里的数值夹进允许区间（脏数据不能让日志系统瘫痪）。
pub fn clamp_file_mb(mb: u64) -> u64 {
    mb.clamp(MIN_FILE_MB, MAX_FILE_MB)
}

/// 同上，保留份数。
pub fn clamp_backups(n: u32) -> u32 {
    n.clamp(MIN_BACKUPS, MAX_BACKUPS)
}

/// `log.dir` 的原始值 → 目录：空串（含全空白）表示「用默认目录」
/// （[`crate::app_paths::logs_root_from_env`]），否则按原样取路径。
fn resolve_dir(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        crate::app_paths::logs_root_from_env()
    } else {
        Some(PathBuf::from(trimmed))
    }
}

/// 数据库打开后调用：把用户配置盖到运行期参数上。
///
/// 四个参数都是「原始字符串」，解析与夹紧都收在本模块里 —— 调用方
/// （`lib.rs` setup 与设置命令）只需要把 settings 表里的值递进来。
///
/// **`None` 一律表示「这一项不动」**，不是「回落默认值」：启动时库里没配过
/// 这几条键，`init()` 已经装好默认档（`DEFAULT_FILE_MB` × `DEFAULT_BACKUPS` ×
/// `level_from_env()`），不动的结果与显式回落默认完全一致；而设置页只改其中
/// 一项时（比如只换目录），另外两项也不会被顺手打回默认。目录的「回到默认」
/// 走空串（[`resolve_dir`]），和「不动」区分开。
///
/// 换目录会先关旧句柄（Windows 上不关就没法改名/删除）再在新目录重开。
pub fn apply_settings(
    dir: Option<&str>,
    level: Option<&str>,
    file_mb: Option<&str>,
    backups: Option<&str>,
) {
    if let Some(level) = level.and_then(parse_level) {
        log::set_max_level(level);
    }

    let Some(mutex) = LOGGER.get() else { return };
    let mut inner = mutex.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(mb) = file_mb.and_then(|s| s.trim().parse::<u64>().ok()) {
        inner.max_file_bytes = clamp_file_mb(mb) * 1024 * 1024;
    }
    if let Some(n) = backups.and_then(|s| s.trim().parse::<u32>().ok()) {
        inner.max_backups = clamp_backups(n);
    }

    let Some(raw_dir) = dir else { return };
    let Some(new_dir) = resolve_dir(raw_dir) else {
        return;
    };
    if inner.dir.as_deref() == Some(new_dir.as_path()) {
        return;
    }
    // 换目录：先关句柄，再在新目录重开
    inner.file = None;
    inner.written = 0;
    inner.dir = None;
    if fs::create_dir_all(&new_dir).is_ok() {
        let current = new_dir.join(CURRENT_NAME);
        let oversize = fs::metadata(&current)
            .map(|m| m.len() >= inner.max_file_bytes)
            .unwrap_or(false);
        if oversize {
            rotate(&new_dir, inner.max_backups);
        }
        inner.file = open_current(&new_dir);
        inner.written = fs::metadata(&current).map(|m| m.len()).unwrap_or(0);
        inner.dir = Some(new_dir);
    }
}

/// 安装 panic 钩子：panic 信息落日志文件（release 无 stderr 可看，否则
/// 「应用凭空消失」连一条现场都没有）。钩子里不能走 log:: 宏——若 panic
/// 发生在持锁写日志时会同锁重入死锁，因此直接走 [`append_line`]。
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("<unnamed>");
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_default();
        let payload = info.payload();
        let msg = payload
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(|s| s.as_str()))
            .unwrap_or("未知 panic 载荷");
        let line = format!("{} PANIC [{name}] {msg} at {location}", local_ts());
        append_line(&line);
        if cfg!(debug_assertions) {
            eprintln!("{line}");
        }
        // 音频回调线程（cpal_wasapi_out 等）panic：cpal 不会重建线程，也不会调
        // rodio 的 error callback，输出流从此静默死亡、`Player::get_pos()`/`empty()`
        // 双双冻结 —— 必须通知引擎去看门狗兜底（2026-10-03 卡死事故）。
        // 这里只投一条无界 channel 消息：不加锁、不写日志，钩子里可安全调用。
        if name.starts_with("cpal") {
            crate::audio::engine::notify_audio_thread_panic(&format!("{name}: {msg}"));
        }
    }));
}

struct FileLogger;

impl log::Log for FileLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::max_level() && !suppressed(metadata.target(), metadata.level())
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format!(
            "{} {:<5} [{}] {}",
            local_ts(),
            record.level(),
            record.target(),
            record.args()
        );
        append_line(&line);
        if cfg!(debug_assertions) {
            eprintln!("{line}");
        }
    }

    fn flush(&self) {}
}

/// 第三方依赖的刷屏静音名单。
///
/// 为什么需要：`RUST_LOG` 只能设一个全局级别，而这里要压的是**某个依赖**的
/// WARN —— 它不影响功能、却按千行/秒地写。2026-10-10 实测 symphonia 的 MP3
/// demuxer 在 43 秒里写了 56,378 行 WARN（"invalid mpeg audio header" /
/// "skipping junk at ..."），一晚上轮转掉 4 个 5 MiB 文件，把真正的故障现场
/// 全冲走了（诊断日志里翻不到任何有用信息）。
///
/// 只按 target 前缀静音，且 Error 一律放行（真解码失败还是要看得见）。
/// 想连这些一起看时用 `RUST_LOG=debug` 或 `trace`（此时不过滤，见下）。
fn suppressed(target: &str, level: log::Level) -> bool {
    suppressed_at(target, level, log::max_level())
}

/// 判定本体，把全局级别当参数传进来 —— 便于单测（不依赖进程级 log 状态）。
fn suppressed_at(target: &str, level: log::Level, max: log::LevelFilter) -> bool {
    /// 静音名单：这些 target 只放 Error 过去
    const NOISY_TARGETS: [&str; 2] = ["symphonia_bundle_mp3", "symphonia_format_isomp4"];
    // 显式调高到 debug/trace 时是「我要看细节」，过滤让位
    if max >= log::LevelFilter::Debug {
        return false;
    }
    // log::Level 的序是 Error < Warn < Info < Debug < Trace（越严重越小）
    if level <= log::Level::Error {
        return false;
    }
    NOISY_TARGETS
        .iter()
        .any(|prefix| target.starts_with(prefix))
}

/// 追加一行到当前日志（写满自动轮转；文件不可用时静默丢弃）。
/// panic 钩子与 Log 实现共用本函数。
fn append_line(line: &str) {
    let Some(mutex) = LOGGER.get() else { return };
    // 锁被毒化（写入中 panic 过）也继续用：宁可丢日志也不能让写入停摆
    let mut inner = mutex.lock().unwrap_or_else(|p| p.into_inner());
    let Some(dir) = inner.dir.clone() else { return };
    let need = line.len() as u64 + 1;
    if inner.file.is_none() || inner.written + need > inner.max_file_bytes {
        // Windows 上先关句柄才能改名轮转
        inner.file = None;
        if inner.written > 0 {
            rotate(&dir, inner.max_backups);
        }
        inner.file = open_current(&dir);
        inner.written = fs::metadata(dir.join(CURRENT_NAME))
            .map(|m| m.len())
            .unwrap_or(0);
    }
    if let Some(f) = inner.file.as_mut() {
        let ok = f
            .write_all(line.as_bytes())
            .and_then(|_| f.write_all(b"\n"))
            .is_ok();
        if ok {
            inner.written += need;
        } else {
            // 磁盘满 / 句柄失效：放弃文件输出，下一条日志时重开
            inner.file = None;
            inner.written = 0;
        }
    }
}

fn open_current(dir: &Path) -> Option<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(CURRENT_NAME))
        .ok()
}

/// log.N 删掉、log.i → log.i+1、当前文件 → log.1（调用前须已关闭当前句柄）。
/// `backups` 是保留份数：调小后多出来的旧文件也要一并清掉，否则用户把份数
/// 从 50 改到 5 之后，磁盘上仍留着 45 份历史文件。
fn rotate(dir: &Path, backups: u32) {
    let _ = fs::remove_file(dir.join(format!("{CURRENT_NAME}.{backups}")));
    // 调小份数后遗留的更高编号（最多 MAX_BACKUPS 次探测，代价可忽略）
    for i in (backups + 1)..=MAX_BACKUPS {
        let _ = fs::remove_file(dir.join(format!("{CURRENT_NAME}.{i}")));
    }
    for i in (1..backups).rev() {
        let _ = fs::rename(
            dir.join(format!("{CURRENT_NAME}.{i}")),
            dir.join(format!("{CURRENT_NAME}.{}", i + 1)),
        );
    }
    let _ = fs::rename(
        dir.join(CURRENT_NAME),
        dir.join(format!("{CURRENT_NAME}.1")),
    );
}

/// RUST_LOG 兼容（只认单词，`RUST_LOG=debug` 之类）。
///
/// 默认级别**按构建区分**：debug 构建（含 `tauri dev`）留 `Debug`，发行包只留
/// `Warn` —— 发行包里 Info 绝大多数是启动流程，真要看的是 Warn/Error，而
/// 2026-10-10 的教训是一晚上能写出 20 MiB 噪音把现场冲走。
/// 只取首个逗号段做**精确**匹配：子串匹配会把 `RUST_LOG=info,wgpu=warn`
/// 里的目标识别降成 Warn（丢了全局 info），`off` 等无法识别的词回落默认值。
fn level_from_env() -> log::LevelFilter {
    let raw = std::env::var("RUST_LOG").unwrap_or_default();
    let first = raw.split(',').next().unwrap_or("").trim().to_ascii_lowercase();
    match first.as_str() {
        "trace" => log::LevelFilter::Trace,
        "debug" => log::LevelFilter::Debug,
        "info" => log::LevelFilter::Info,
        "warn" => log::LevelFilter::Warn,
        "error" => log::LevelFilter::Error,
        _ => default_level(),
    }
}

/// 未显式配置时的默认级别：debug 构建 Debug，release 构建 Warn。
/// （`pub` 是给设置页回显用：让用户看见「没配置时默认是多少」。）
pub fn default_level() -> log::LevelFilter {
    if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Warn
    }
}

/// 本地时间戳 "YYYY-MM-DD HH:MM:SS.mmm"。Windows 用 GetLocalTime 拿本地时区；
/// 其他平台退化成 UTC（只影响日志可读性，不影响排查所需的事件顺序）。
#[cfg(target_os = "windows")]
fn local_ts() -> String {
    use windows::Win32::Foundation::SYSTEMTIME;
    use windows::Win32::System::SystemInformation::GetLocalTime;
    // windows 0.62 的 GetLocalTime 直接返回 SYSTEMTIME（Foundation 里定义）
    let st: SYSTEMTIME = unsafe { GetLocalTime() };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds
    )
}

#[cfg(not(target_os = "windows"))]
fn local_ts() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let s = secs.rem_euclid(86_400);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC",
        s / 3600,
        (s % 3600) / 60,
        s % 60
    )
}

/// days since epoch → (年, 月, 日)（Howard Hinnant 算法，仅非 Windows 兜底用）
#[cfg(not(target_os = "windows"))]
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 默认档（Info，用户把级别调到 info 时的档位）下，symphonia 的 WARN/INFO
    /// 刷屏必须被静音 —— 2026-10-10 就是它们以约 1300 行/秒把诊断日志冲成 4 个
    /// 轮转文件。
    #[test]
    fn symphonia_noise_is_suppressed_at_info_level() {
        let info = log::LevelFilter::Info;
        assert!(suppressed_at(
            "symphonia_bundle_mp3::demuxer",
            log::Level::Warn,
            info
        ));
        assert!(suppressed_at(
            "symphonia_bundle_mp3::demuxer",
            log::Level::Info,
            info
        ));
        assert!(suppressed_at(
            "symphonia_format_isomp4::demuxer",
            log::Level::Warn,
            info
        ));
    }

    /// 但真解码失败（Error）不能被吞掉，否则「放不出声」又没现场可查。
    #[test]
    fn symphonia_errors_still_pass() {
        assert!(!suppressed_at(
            "symphonia_bundle_mp3::demuxer",
            log::Level::Error,
            log::LevelFilter::Info
        ));
    }

    /// 本项目自己的日志一条都不能被误伤。
    #[test]
    fn own_targets_are_never_suppressed() {
        let info = log::LevelFilter::Info;
        for target in [
            "quietmusic_lib::qtres",
            "quietmusic_lib::audio::engine",
            "quietmusic_lib",
            "quietmusic_lib::commands",
        ] {
            assert!(
                !suppressed_at(target, log::Level::Info, info),
                "{target} 被误静音了"
            );
            assert!(!suppressed_at(target, log::Level::Warn, info));
        }
    }

    /// 显式要细节（RUST_LOG=debug/trace）时过滤让位：静音只是默认档的降噪，
    /// 不能变成「永远看不到」。
    #[test]
    fn debug_level_disables_the_filter() {
        for max in [log::LevelFilter::Debug, log::LevelFilter::Trace] {
            assert!(!suppressed_at(
                "symphonia_bundle_mp3::demuxer",
                log::Level::Warn,
                max
            ));
        }
    }

    /// 前缀匹配不能误伤同前缀以外的 target。
    #[test]
    fn prefix_match_is_not_overbroad() {
        assert!(!suppressed_at(
            "symphonia_core",
            log::Level::Warn,
            log::LevelFilter::Info
        ));
        assert!(suppressed_at(
            "symphonia_bundle_mp3::demuxer",
            log::Level::Warn,
            log::LevelFilter::Info
        ));
    }

    /// 级别词 → 过滤器：大小写与空白都容忍，认不出的词返回 None（调用方回落
    /// 默认档），绝不 panic。
    #[test]
    fn parse_level_accepts_known_words_only() {
        assert_eq!(parse_level("DEBUG"), Some(log::LevelFilter::Debug));
        assert_eq!(parse_level("  Warn "), Some(log::LevelFilter::Warn));
        assert_eq!(parse_level("warning"), Some(log::LevelFilter::Warn));
        assert_eq!(parse_level("info"), Some(log::LevelFilter::Info));
        assert_eq!(parse_level("error"), Some(log::LevelFilter::Error));
        assert_eq!(parse_level("off"), None);
        assert_eq!(parse_level(""), None);
    }

    /// level_name 与 parse_level 必须互逆 —— 设置页回显的就是写回去的值，
    /// 一旦不互逆，用户「点开设置什么都没改」也会把级别改掉。
    #[test]
    fn level_name_round_trips_through_parse_level() {
        for lv in [
            log::LevelFilter::Error,
            log::LevelFilter::Warn,
            log::LevelFilter::Info,
            log::LevelFilter::Debug,
            log::LevelFilter::Trace,
        ] {
            assert_eq!(parse_level(level_name(lv)), Some(lv), "{lv:?} 不能往返");
        }
    }

    /// 未设 RUST_LOG 时默认档按构建区分：debug 构建 Debug，发行包 Warn。
    #[test]
    fn default_level_follows_build_kind() {
        let expected = if cfg!(debug_assertions) {
            log::LevelFilter::Debug
        } else {
            log::LevelFilter::Warn
        };
        assert_eq!(default_level(), expected);
    }

    /// 大小与份数的夹紧：脏数据（0 / 超大）不能把日志系统弄瘫。
    #[test]
    fn clamps_keep_values_in_range() {
        assert_eq!(clamp_file_mb(0), MIN_FILE_MB);
        assert_eq!(clamp_file_mb(u64::MAX), MAX_FILE_MB);
        assert_eq!(clamp_file_mb(20), 20);
        assert_eq!(clamp_backups(0), MIN_BACKUPS);
        assert_eq!(clamp_backups(999), MAX_BACKUPS);
        assert_eq!(clamp_backups(5), 5);
    }

    /// 空串是「回到默认目录」，不是「不动」—— 设置页的「恢复默认」就是写空串。
    /// 空白串同理（库里存了空格也得当默认，否则会建出一个名字是空格的目录）。
    #[test]
    fn blank_dir_means_default() {
        let expected = crate::app_paths::logs_root_from_env();
        assert_eq!(resolve_dir(""), expected);
        assert_eq!(resolve_dir("   "), expected);
        assert_eq!(resolve_dir("\t\n"), expected);
    }

    /// 非空串原样取路径（含相对路径：用户自己填的，不做「必须绝对路径」的额外
    /// 门槛 —— 与 download.dir 一致）。两端的空白要去掉，否则 Windows 上
    /// `PathBuf::from(" D:\\logs ")` 会带空格建目录。
    #[test]
    fn non_blank_dir_is_used_verbatim() {
        assert_eq!(
            resolve_dir("D:\\logs\\qm"),
            Some(PathBuf::from("D:\\logs\\qm"))
        );
        assert_eq!(resolve_dir("  D:\\logs\\qm  "), Some(PathBuf::from("D:\\logs\\qm")));
    }

    /// `apply_settings` 的 `None` = 「这一项不动」：设置页只改大小的时候，级别
    /// 与份数都不能被顺手打回默认。
    #[test]
    fn none_arguments_leave_other_items_untouched() {
        // 级别是进程级全局量，测试之间会互相串；先存后还，别把这个测试的
        // 副作用留给同进程的其他测试。
        let level_before = log::max_level();
        let mutex = LOGGER.get_or_init(|| {
            Mutex::new(Inner {
                dir: None,
                file: None,
                written: 0,
                max_file_bytes: DEFAULT_FILE_MB * 1024 * 1024,
                max_backups: DEFAULT_BACKUPS,
            })
        });
        // 先摆一个非默认状态
        apply_settings(None, Some("error"), Some("77"), Some("9"));
        assert_eq!(log::max_level(), log::LevelFilter::Error);
        {
            let inner = mutex.lock().unwrap_or_else(|p| p.into_inner());
            assert_eq!(inner.max_file_bytes, 77 * 1024 * 1024);
            assert_eq!(inner.max_backups, 9);
        }
        // 只改份数：级别与大小保持刚才的值
        apply_settings(None, None, None, Some("3"));
        assert_eq!(log::max_level(), log::LevelFilter::Error);
        {
            let inner = mutex.lock().unwrap_or_else(|p| p.into_inner());
            assert_eq!(inner.max_file_bytes, 77 * 1024 * 1024);
            assert_eq!(inner.max_backups, 3);
        }
        // 认不出的级别词不动任何东西（不 panic、不回落默认）
        apply_settings(None, Some("nonsense"), None, None);
        assert_eq!(log::max_level(), log::LevelFilter::Error);
        // 脏数据同样只是「不动」
        apply_settings(None, None, Some("abc"), None);
        {
            let inner = mutex.lock().unwrap_or_else(|p| p.into_inner());
            assert_eq!(inner.max_file_bytes, 77 * 1024 * 1024);
        }
        // 还原：份数回默认，级别回测试前的档
        {
            let mut inner = mutex.lock().unwrap_or_else(|p| p.into_inner());
            inner.max_file_bytes = DEFAULT_FILE_MB * 1024 * 1024;
            inner.max_backups = DEFAULT_BACKUPS;
        }
        log::set_max_level(level_before);
    }
}
