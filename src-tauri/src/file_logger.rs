//! 文件日志（运维）：release 构建没有控制台（windows_subsystem），env_logger
//! 写的 stderr 一条都到不了用户机器上，报障时无现场可查。本模块把 log 记录与
//! panic 钩子统一落盘到 `%APPDATA%/QuietMusic/logs/`：
//! - 当前文件 `quietmusic.log`，写满 5 MiB 轮转出 `.1`~`.4`（总量上界
//!   5 文件 × 5 MiB；按大小轮转不按日期，重启不清空）；
//! - debug 构建同时保留 stderr 输出（dev 终端照常可见）；
//! - 不引入新依赖：时间戳 Windows 用 GetLocalTime，其他平台退化 UTC。
//!
//! 用法：`run()` 最开头 `init()` + `install_panic_hook()`，其余代码照常用
//! `log::` 宏，无感知。

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// 单文件上限 5 MiB
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// 轮转保留的历史文件数（quietmusic.log.1 ~ .4）
const MAX_BACKUPS: u32 = 4;
const CURRENT_NAME: &str = "quietmusic.log";

struct Inner {
    dir: Option<PathBuf>,
    file: Option<File>,
    /// 当前文件已写字节数（轮转判据）
    written: u64,
}

static LOGGER: OnceLock<Mutex<Inner>> = OnceLock::new();

/// 初始化文件日志。`dir` 传 None（拿不到 APPDATA 等异常环境）时退化为仅
/// stderr。必须在任何 log:: 宏调用之前执行。
pub fn init(dir: Option<PathBuf>) {
    let mut inner = Inner {
        dir: dir.clone(),
        file: None,
        written: 0,
    };
    if let Some(dir) = dir {
        if fs::create_dir_all(&dir).is_ok() {
            let current = dir.join(CURRENT_NAME);
            let oversize = fs::metadata(&current)
                .map(|m| m.len() >= MAX_FILE_BYTES)
                .unwrap_or(false);
            if oversize {
                inner.file = None;
                rotate(&dir);
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
    }));
}

struct FileLogger;

impl log::Log for FileLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::max_level()
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

/// 追加一行到当前日志（写满自动轮转；文件不可用时静默丢弃）。
/// panic 钩子与 Log 实现共用本函数。
fn append_line(line: &str) {
    let Some(mutex) = LOGGER.get() else { return };
    // 锁被毒化（写入中 panic 过）也继续用：宁可丢日志也不能让写入停摆
    let mut inner = mutex.lock().unwrap_or_else(|p| p.into_inner());
    let Some(dir) = inner.dir.clone() else { return };
    let need = line.len() as u64 + 1;
    if inner.file.is_none() || inner.written + need > MAX_FILE_BYTES {
        // Windows 上先关句柄才能改名轮转
        inner.file = None;
        if inner.written > 0 {
            rotate(&dir);
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

fn open_current(dir: &PathBuf) -> Option<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(CURRENT_NAME))
        .ok()
}

/// log.4 删掉、log.N → log.N+1、当前文件 → log.1（调用前须已关闭当前句柄）
fn rotate(dir: &PathBuf) {
    let _ = fs::remove_file(dir.join(format!("{CURRENT_NAME}.{}", MAX_BACKUPS)));
    for i in (1..MAX_BACKUPS).rev() {
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

/// RUST_LOG 兼容（只认单词，`RUST_LOG=debug` 之类），默认 info——与原先
/// env_logger 的 default_filter_or("info") 口径一致
fn level_from_env() -> log::LevelFilter {
    let lower = std::env::var("RUST_LOG")
        .unwrap_or_default()
        .to_ascii_lowercase();
    for (word, level) in [
        ("trace", log::LevelFilter::Trace),
        ("debug", log::LevelFilter::Debug),
        ("warn", log::LevelFilter::Warn),
        ("error", log::LevelFilter::Error),
        ("info", log::LevelFilter::Info),
    ] {
        if lower.contains(word) {
            return level;
        }
    }
    log::LevelFilter::Info
}

/// 本地时间戳 "YYYY-MM-DD HH:MM:SS.mmm"。Windows 用 GetLocalTime（应用只发
/// Windows 包）；其他平台退化成 UTC，仅影响日志可读性。
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
