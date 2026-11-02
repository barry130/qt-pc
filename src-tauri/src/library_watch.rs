//! 本地曲库文件夹监听（A3）：盯着扫描目录，有增删改就增量入库。
//!
//! ## 为什么不是"再挂一个定时器"
//!
//! 整库扫描（`library_scan.rs`）读每个文件的标签，几千首要几十秒；把它挂到定时器上
//! 是拿磁盘和 CPU 换"也许有变化"。这里用操作系统的目录通知（Windows
//! `ReadDirectoryChangesW`、macOS FSEvents、Linux inotify，由 `notify` 按平台挑），
//! 只有真的动了文件才会醒。
//!
//! ## 三件事必须做对
//!
//! 1. **去抖**：复制一张专辑会瞬间产生几十上百个事件，逐个入库等于把库锁死。
//!    所以收到第一条事件后开一个 [`DEBOUNCE`] 窗口，把窗口内的路径攒成一批再处理。
//! 2. **增量**：只对变动路径调 `local::scan_dirs_with_progress`（它同时接受文件和
//!    目录，还沿用用户的"忽略短音频 / 小文件"阈值），不做整库重扫。
//! 3. **不和用户抢**：处理走这条独立线程，`db.with` 只在写库那一小段持锁；
//!    扫库命令（`cmd_scan_library`）同时跑也不会死锁，最坏是顺序执行。
//!
//! 被删除的路径分两种：文件 → 按路径精确删；整个目录被删 → 按前缀把它下面的曲目
//! 一起清掉（否则那批曲目会永远躺在库里，还带着"文件缺失"标记）。删除只动数据库
//! 记录，不碰磁盘（磁盘上东西都没了，没什么可碰的）。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::store;
use crate::local::ScanFilter;

/// 曲库发生增量变化后广播给前端的事件名（前端据此刷新本地曲目列表）。
pub const EVENT_LIBRARY_CHANGED: &str = "library-changed";
/// 监听开关的设置键（"true" / "false"；缺省视为开启）。
pub const SETTING_LIBRARY_WATCH: &str = "library.watch";

/// 扫描阈值的设置键（与前端 `ipc.ts` 的 `SCAN_MIN_DURATION_KEY` 同值）。
const SETTING_SCAN_MIN_DURATION: &str = "scanMinDurationSecs";
const SETTING_SCAN_MIN_SIZE: &str = "scanMinSizeBytes";

/// 去抖窗口：复制一张专辑的事件会在这个窗口里攒成一批。
const DEBOUNCE: Duration = Duration::from_millis(600);
/// 单批最多处理多少条路径（防"整个盘被塞进来"时一次扫太久）。
const MAX_BATCH: usize = 4096;

/// 增量变化的结果，前端收到后只需刷新列表。
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryChangedPayload {
    /// 新增或更新的曲目条数
    pub added: usize,
    /// 从库里移除的曲目条数
    pub removed: usize,
}

/// 一个正在运行的目录监听。`drop` 它就等于停止监听（底层句柄随之关闭，
/// 投递通道断开，监听线程退出）。
pub struct LibraryWatcher {
    /// 必须持有：`notify` 的 watcher 一旦被丢弃，系统通知就停了。
    _watcher: notify::RecommendedWatcher,
    dirs: Vec<String>,
}

impl LibraryWatcher {
    /// 真正在监听的目录（不存在 / 无权限的目录会被跳过，不在这里面）。
    pub fn dirs(&self) -> &[String] {
        &self.dirs
    }
}

/// 启动监听（调用方负责先停掉旧的）。`dirs` 为空时返回 `None`。
pub fn start(app: AppHandle, dirs: Vec<String>) -> Result<Option<LibraryWatcher>, String> {
    if dirs.is_empty() {
        return Ok(None);
    }
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res| {
        // 通道断了（监听已停）就静默丢弃：这一下没有别的处理办法，
        // 也不该在系统回调线程里 panic。
        let _ = tx.send(res);
    })
    .map_err(|e| format!("创建文件监听失败: {e}"))?;

    let mut watched = Vec::new();
    for dir in &dirs {
        match watcher.watch(Path::new(dir), RecursiveMode::Recursive) {
            Ok(()) => watched.push(dir.clone()),
            // 目录被移走 / 没权限 / 是网络盘：跳过这一个，不拖垮整条监听
            Err(e) => log::warn!("[watch] 无法监听 {dir}: {e}"),
        }
    }
    if watched.is_empty() {
        return Ok(None);
    }

    std::thread::Builder::new()
        .name("library-watch".to_string())
        .spawn(move || drain_loop(&app, rx))
        .map_err(|e| format!("监听线程启动失败: {e}"))?;

    log::info!("[watch] 开始监听 {} 个目录", watched.len());
    Ok(Some(LibraryWatcher {
        _watcher: watcher,
        dirs: watched,
    }))
}

/// 按当前设置与扫描目录重启监听。设置关掉、没有扫描目录、或数据库不可用时
/// 只把旧监听停掉（不报错：这些都不是异常状态）。
pub fn restart_from_db(app: &AppHandle) {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return;
    };
    let Some(db) = state.db.clone() else {
        stop(app);
        return;
    };
    let enabled = db
        .with(|conn| store::get_setting(conn, SETTING_LIBRARY_WATCH))
        .ok()
        .flatten()
        .map(|raw| raw.trim() != "false")
        .unwrap_or(true);
    let dirs = if enabled {
        db.with(store::list_scan_dirs).unwrap_or_default()
    } else {
        Vec::new()
    };
    stop(app);
    if dirs.is_empty() {
        return;
    }
    match start(app.clone(), dirs) {
        Ok(started) => {
            let slot = state.library_watch.lock();
            let mut guard = slot.unwrap_or_else(|poison| poison.into_inner());
            *guard = started;
        }
        Err(e) => log::warn!("[watch] 启动失败: {e}"),
    }
}

/// 停掉当前监听（幂等）。
pub fn stop(app: &AppHandle) {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return;
    };
    let slot = state.library_watch.lock();
    let mut guard = slot.unwrap_or_else(|poison| poison.into_inner());
    if guard.take().is_some() {
        log::info!("[watch] 已停止监听");
    }
}

/// 当前是否在监听（供命令回报状态）。
pub fn watching_dirs(app: &AppHandle) -> Vec<String> {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return Vec::new();
    };
    let slot = state.library_watch.lock();
    let guard = slot.unwrap_or_else(|poison| poison.into_inner());
    guard.as_ref().map(|w| w.dirs().to_vec()).unwrap_or_default()
}

fn drain_loop(app: &AppHandle, rx: mpsc::Receiver<notify::Result<notify::Event>>) {
    loop {
        // 第一条事件之前无限等；关掉监听后通道断开，这里拿到 Err 直接退出。
        let Ok(first) = rx.recv() else {
            return;
        };
        let mut batch = BTreeSet::new();
        collect_paths(first, &mut batch);
        // 攒同批：每次收到事件就把去抖窗口往后推一格，直到安静下来。
        loop {
            match rx.recv_timeout(DEBOUNCE) {
                Ok(res) => collect_paths(res, &mut batch),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    apply(app, batch);
                    return;
                }
            }
            if batch.len() >= MAX_BATCH {
                break;
            }
        }
        apply(app, batch);
    }
}

/// 把一条通知里"值得处理"的路径收进批次。
///
/// 访问类事件（打开/读取/关闭）不算变化 —— 播放器自己读文件也会产生它们。
fn collect_paths(res: notify::Result<notify::Event>, out: &mut BTreeSet<PathBuf>) {
    let event = match res {
        Ok(event) => event,
        Err(e) => {
            log::debug!("[watch] 通知出错: {e}");
            return;
        }
    };
    if matches!(event.kind, EventKind::Access(_) | EventKind::Other) {
        return;
    }
    for path in event.paths {
        if out.len() >= MAX_BATCH {
            return;
        }
        if is_interesting_path(&path) {
            out.insert(path);
        }
    }
}

/// 只关心"音频/播放列表文件、目录、以及已经消失的路径（删除事件）"。
///
/// 其它东西（封面、歌词、`.tmp`、数据库文件、编辑器临时文件）即使变了也不该
/// 触发入库；其中 `.lrc` 变化要等用户重开歌词才生效，这次不做顺带刷新。
fn is_interesting_path(path: &Path) -> bool {
    if crate::local::is_audio_file(path) || crate::cue::is_cue_file(path) {
        return true;
    }
    // 删除事件到达时文件已经不存在了，`is_dir()` 也问不出来，只能靠扩展名排除。
    // 不认识的扩展名一律放行：宁可多扫一次，也不能漏掉"整个专辑目录被移走"。
    if !path.exists() {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        return !IGNORED_EXTENSIONS.contains(&ext.as_str());
    }
    path.is_dir()
}

/// 消失路径里这些扩展名的变化不值得触发入库（附件与临时文件）。
const IGNORED_EXTENSIONS: &[&str] = &[
    "jpg",
    "jpeg",
    "png",
    "gif",
    "webp",
    "bmp",
    "lrc",
    "txt",
    "nfo",
    "log",
    "tmp",
    "part",
    "crdownload",
    "db",
    "db-wal",
    "db-shm",
    "ini",
    "json",
];

fn apply(app: &AppHandle, batch: BTreeSet<PathBuf>) {
    if batch.is_empty() {
        return;
    }
    let Some(state) = app.try_state::<crate::AppState>() else {
        return;
    };
    let Some(db) = state.db.clone() else {
        return;
    };

    let mut touched = Vec::new();
    let mut gone = Vec::new();
    for path in batch {
        match path.to_str() {
            Some(raw) if path.exists() => touched.push(raw.to_string()),
            Some(raw) => gone.push(raw.to_string()),
            None => {}
        }
    }

    let filter = scan_filter(&db);
    let rows = if touched.is_empty() {
        Vec::new()
    } else {
        crate::local::scan_dirs_with_progress(&touched, filter, |_, _, _| {})
    };

    let mut added = 0usize;
    if !rows.is_empty() {
        match db.with(|conn| store::upsert_local_tracks(conn, &rows)) {
            // upsert 不回报影响行数（可能是插入也可能是更新），这里按处理过的
            // 曲目条数计——对前端而言"变了多少首"才是要看的信息。
            Ok(()) => added = rows.len(),
            Err(e) => log::warn!("[watch] 增量入库失败: {e}"),
        }
    }

    let mut removed = 0usize;
    for raw in &gone {
        let deleted = db.with(|conn| {
            // 先按文件路径精确删；删不到说明被移除的是目录，按前缀清掉整棵子树。
            let exact = store::delete_local_track(conn, raw)?;
            if exact > 0 {
                return Ok(exact);
            }
            store::delete_local_tracks_under(conn, raw)
        });
        match deleted {
            Ok(n) => removed += n,
            Err(e) => log::warn!("[watch] 移除记录失败（{raw}）: {e}"),
        }
    }

    if added == 0 && removed == 0 {
        return;
    }
    // 新曲目可能带 ReplayGain 标签：立刻刷新内存表，不必等重启（A1）。
    if added > 0 {
        match db.with(crate::audio::replay_gain::reload) {
            Ok(total) => log::debug!("[watch] ReplayGain 表已刷新：{total} 首带增益"),
            Err(e) => log::warn!("[watch] ReplayGain 表刷新失败: {e}"),
        }
    }
    log::info!("[watch] 曲库变化：新增/更新 {added} 首，移除 {removed} 首");
    let _ = app.emit(
        EVENT_LIBRARY_CHANGED,
        LibraryChangedPayload { added, removed },
    );
}

/// 读用户的扫描阈值（与设置页一致：时长缺省 60 秒、体积缺省 1 MB）。
fn scan_filter(db: &crate::db::Database) -> ScanFilter {
    let read = |key: &str, fallback: u64| -> u64 {
        db.with(|conn| store::get_setting(conn, key))
            .ok()
            .flatten()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .unwrap_or(fallback)
    };
    ScanFilter {
        min_duration_secs: read(SETTING_SCAN_MIN_DURATION, 60),
        min_size_bytes: read(SETTING_SCAN_MIN_SIZE, 1024 * 1024),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_and_cue_paths_are_interesting() {
        assert!(is_interesting_path(Path::new("D:/music/a.flac")));
        assert!(is_interesting_path(Path::new("D:/music/a.mp3")));
        assert!(is_interesting_path(Path::new("D:/music/album.cue")));
    }

    #[test]
    fn sidecar_and_temp_paths_are_ignored() {
        // 封面 / 歌词 / 半成品下载文件变了都不该触发入库
        assert!(!is_interesting_path(Path::new("D:/music/cover.jpg")));
        assert!(!is_interesting_path(Path::new("D:/music/a.lrc")));
        assert!(!is_interesting_path(Path::new("D:/music/a.flac.part")));
    }

    #[test]
    fn vanished_paths_are_judged_by_extension() {
        // 删除事件到达时文件已不存在，扩展名还在：音频文件放行交给上层按前缀清
        assert!(is_interesting_path(Path::new("D:/music/不存在的专辑/a.flac")));
        // 整个目录被移走时路径通常没有扩展名，必须放行才能清掉它下面的曲目
        assert!(is_interesting_path(Path::new("D:/music/旧专辑")));
        // 但消失的封面/歌词/半成品文件不该触发入库
        assert!(!is_interesting_path(Path::new("D:/music/vanished.jpg")));
        assert!(!is_interesting_path(Path::new("D:/music/vanished.lrc")));
        assert!(!is_interesting_path(Path::new("D:/music/vanished.flac.part")));
    }

    #[test]
    fn access_events_are_dropped() {
        let mut batch = BTreeSet::new();
        collect_paths(
            Ok(notify::Event::new(EventKind::Access(
                notify::event::AccessKind::Read,
            ))
            .add_path(PathBuf::from("D:/music/a.flac"))),
            &mut batch,
        );
        assert!(batch.is_empty(), "读取文件不该被当成曲库变化");

        collect_paths(
            Ok(notify::Event::new(EventKind::Create(
                notify::event::CreateKind::File,
            ))
            .add_path(PathBuf::from("D:/music/a.flac"))),
            &mut batch,
        );
        assert_eq!(batch.len(), 1);
    }
}
