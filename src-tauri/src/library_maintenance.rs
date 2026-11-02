//! Read-only library maintenance. File IO runs outside the database lock and audio thread.
//! CUE rows are collapsed to physical files before hashing or planning paths.
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};

use crate::AppState;
use ring::digest::{Context, SHA256};
use rusqlite::Connection;
use tauri::{Emitter, State};

pub const PROGRESS_EVENT: &str = "library-duplicate-progress";

#[derive(Debug, Clone)]
struct LibraryFile {
    path: String,
    title: String,
    singer: String,
    album: String,
    cue: bool,
    track_count: usize,
}

fn library_files(conn: &Connection) -> Result<Vec<LibraryFile>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT local_path, title, singer, album, cue_path IS NOT NULL
         FROM tracks WHERE platform = 'local' AND missing = 0 AND local_path IS NOT NULL
         ORDER BY local_path, start_ms, id",
    )?;
    let mut files: BTreeMap<String, LibraryFile> = BTreeMap::new();
    for row in stmt.query_map([], |r| {
        Ok(LibraryFile {
            path: r.get(0)?,
            title: r.get(1)?,
            singer: r.get(2)?,
            album: r.get(3)?,
            cue: r.get(4)?,
            track_count: 1,
        })
    })? {
        let file = row?;
        let key = path_key(Path::new(&file.path));
        if let Some(previous) = files.get_mut(&key) {
            previous.track_count += 1;
            previous.cue |= file.cue;
            if previous.singer != file.singer {
                previous.singer = "多位歌手".into();
            }
            if previous.album != file.album {
                previous.album = "多张专辑".into();
            }
        } else {
            files.insert(key, file);
        }
    }
    Ok(files.into_values().collect())
}

fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        text.replace('/', "\\").to_lowercase()
    } else {
        text
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceIssue {
    path: String,
    message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateFile {
    path: String,
    track_count: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    sha256: String,
    file_size: u64,
    files: Vec<DuplicateFile>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateReport {
    scanned_files: usize,
    hashed_files: usize,
    groups: Vec<DuplicateGroup>,
    issues: Vec<MaintenanceIssue>,
    cancelled: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateProgress {
    scan_id: String,
    checked: usize,
    total: usize,
    current: String,
}

struct ActiveScan {
    id: String,
    cancelled: Arc<AtomicBool>,
}
fn active_scan() -> &'static Mutex<Option<ActiveScan>> {
    static ACTIVE: OnceLock<Mutex<Option<ActiveScan>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}
struct ScanGuard {
    id: String,
    cancelled: Arc<AtomicBool>,
}
impl Drop for ScanGuard {
    fn drop(&mut self) {
        let mut active = active_scan().lock().unwrap_or_else(|e| e.into_inner());
        if active
            .as_ref()
            .is_some_and(|scan| Arc::ptr_eq(&scan.cancelled, &self.cancelled))
        {
            *active = None;
        }
    }
}
fn begin_scan(id: String) -> Result<ScanGuard, String> {
    if id.is_empty() || id.len() > 128 {
        return Err("检测标识无效".into());
    }
    let mut active = active_scan().lock().unwrap_or_else(|e| e.into_inner());
    if active.is_some() {
        return Err("重复文件检测正在进行，请等待完成或取消".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    *active = Some(ActiveScan {
        id: id.clone(),
        cancelled: cancelled.clone(),
    });
    Ok(ScanGuard { id, cancelled })
}

fn hash_file(
    path: &Path,
    expected_size: u64,
    cancel: &AtomicBool,
) -> Result<Option<String>, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let before = file.metadata().map_err(|e| e.to_string())?;
    if before.len() != expected_size {
        return Err("文件大小在检测过程中发生变化，请重新检测".into());
    }
    let mut context = Context::new(&SHA256);
    let mut buffer = vec![0; 256 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        context.update(&buffer[..count]);
    }
    let after = file.metadata().map_err(|e| e.to_string())?;
    let current = fs::metadata(path).map_err(|e| e.to_string())?;
    if before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || before.len() != current.len()
        || before.modified().ok() != current.modified().ok()
    {
        return Err("文件在检测过程中发生变化，请重新检测".into());
    }
    Ok(Some(
        context
            .finish()
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    ))
}

fn find_duplicates(
    files: Vec<LibraryFile>,
    cancel: &AtomicBool,
    mut progress: impl FnMut(usize, usize, &str),
) -> DuplicateReport {
    let mut report = DuplicateReport::default();
    if cancel.load(Ordering::Relaxed) {
        report.cancelled = true;
        return report;
    }
    progress(0, 0, "");
    let mut by_size: BTreeMap<u64, Vec<LibraryFile>> = BTreeMap::new();
    let mut seen = HashSet::new();
    for mut file in files {
        if cancel.load(Ordering::Relaxed) {
            report.cancelled = true;
            return report;
        }
        let path = Path::new(&file.path);
        let result = fs::canonicalize(path)
            .and_then(|canonical| fs::metadata(&canonical).map(|meta| (canonical, meta)));
        match result {
            Ok((canonical, meta)) if meta.is_file() => {
                if !seen.insert(path_key(&canonical)) {
                    continue;
                }
                file.path = canonical.to_string_lossy().into_owned();
                report.scanned_files += 1;
                // Empty files cannot be playable duplicate audio.
                if meta.len() > 0 {
                    by_size.entry(meta.len()).or_default().push(file);
                }
            }
            Ok(_) => report.issues.push(MaintenanceIssue {
                path: file.path,
                message: "不是普通文件".into(),
            }),
            Err(e) => report.issues.push(MaintenanceIssue {
                path: file.path,
                message: e.to_string(),
            }),
        }
    }
    let total = by_size.values().filter(|g| g.len() > 1).map(Vec::len).sum();
    let mut checked = 0;
    for (file_size, group) in by_size.into_iter().filter(|(_, g)| g.len() > 1) {
        let mut hashes: BTreeMap<String, Vec<DuplicateFile>> = BTreeMap::new();
        for file in group {
            progress(checked, total, &file.path);
            if cancel.load(Ordering::Relaxed) {
                report.cancelled = true;
                return report;
            }
            match hash_file(Path::new(&file.path), file_size, cancel) {
                Ok(Some(sha)) => {
                    report.hashed_files += 1;
                    hashes.entry(sha).or_default().push(DuplicateFile {
                        path: file.path,
                        track_count: file.track_count,
                    });
                }
                Ok(None) => {
                    report.cancelled = true;
                    return report;
                }
                Err(e) => report.issues.push(MaintenanceIssue {
                    path: file.path,
                    message: e,
                }),
            }
            checked += 1;
            progress(checked, total, "");
        }
        report
            .groups
            .extend(
                hashes
                    .into_iter()
                    .filter(|(_, g)| g.len() > 1)
                    .map(|(sha256, files)| DuplicateGroup {
                        sha256,
                        file_size,
                        files,
                    }),
            );
    }
    report.cancelled = cancel.load(Ordering::Relaxed);
    report
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeEntry {
    source: String,
    target: String,
    track_count: usize,
    status: &'static str,
    message: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizePreview {
    entries: Vec<OrganizeEntry>,
    ready: usize,
    blocked: usize,
    unchanged: usize,
}

/// Windows-safe path components, including reserved names and traversal tokens.
fn safe_component(raw: &str, fallback: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(60)
        .collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        return fallback.into();
    }
    let stem = trimmed.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|n| {
                matches!(
                    n,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
    if reserved {
        format!("_{trimmed}")
    } else {
        trimmed.into()
    }
}

fn organize_preview(
    files: Vec<LibraryFile>,
    destination: &Path,
) -> Result<OrganizePreview, String> {
    if !destination.is_absolute() || !destination.is_dir() {
        return Err("请选择已存在的目标文件夹".into());
    }
    let root = fs::canonicalize(destination).map_err(|e| format!("读取目标文件夹失败：{e}"))?;
    let mut entries = Vec::new();
    for file in files {
        let source = Path::new(&file.path);
        let stem = if file.cue {
            source
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("整轨")
        } else {
            &file.title
        };
        let extension = source.extension().and_then(|s| s.to_str()).unwrap_or("");
        let name = safe_component(stem, "未命名");
        let name = if extension.is_empty() {
            name
        } else {
            format!("{name}.{}", safe_component(extension, "audio"))
        };
        let artist = root.join(safe_component(&file.singer, "未知歌手"));
        let album = artist.join(safe_component(&file.album, "未知专辑"));
        let target = album.join(name);
        let mut status = "ready";
        let mut message = String::new();
        if !source.is_file() {
            status = "blocked";
            message = "源文件已不存在或无法读取".into();
        } else if file.cue {
            status = "blocked";
            message = "CUE 整轨需连同分轨表维护，保留原位置".into();
        } else if path_key(&fs::canonicalize(source).unwrap_or_else(|_| source.to_owned()))
            == path_key(&target)
        {
            status = "unchanged";
            message = "已在建议位置".into();
        } else if [artist, album].iter().any(|p| {
            fs::symlink_metadata(p).is_ok_and(|m| !m.is_dir() || m.file_type().is_symlink())
        }) {
            status = "blocked";
            message = "目标上级路径不是普通目录".into();
        } else if fs::symlink_metadata(&target).is_ok() {
            status = "blocked";
            message = "目标已存在，不能覆盖".into();
        } else if target.as_os_str().to_string_lossy().encode_utf16().count() > 240 {
            status = "blocked";
            message = "目标路径过长，请缩短目标目录或元数据".into();
        } else if source.with_extension("lrc").exists() {
            status = "blocked";
            message = "包含同名歌词，整理时需连同歌词一起维护".into();
        }
        entries.push(OrganizeEntry {
            source: file.path,
            target: target.to_string_lossy().into_owned(),
            track_count: file.track_count,
            status,
            message,
        });
    }
    // A preview must show every collision; do not arbitrarily pick a winner.
    let mut counts = BTreeMap::<String, usize>::new();
    for entry in &entries {
        *counts.entry(entry.target.to_lowercase()).or_default() += 1;
    }
    for entry in &mut entries {
        if counts
            .get(&entry.target.to_lowercase())
            .copied()
            .unwrap_or(0)
            > 1
        {
            entry.status = "blocked";
            entry.message = "多个源文件映射到相同目标，请先调整标签或文件名".into();
        }
    }
    Ok(OrganizePreview {
        ready: entries.iter().filter(|e| e.status == "ready").count(),
        blocked: entries.iter().filter(|e| e.status == "blocked").count(),
        unchanged: entries.iter().filter(|e| e.status == "unchanged").count(),
        entries,
    })
}

#[tauri::command(rename = "find_library_duplicates")]
pub async fn cmd_find_library_duplicates(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    scan_id: String,
) -> Result<DuplicateReport, String> {
    let db = state.db.clone().ok_or("数据库不可用")?;
    let guard = begin_scan(scan_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let files = db.with(library_files)?;
        Ok(find_duplicates(
            files,
            &guard.cancelled,
            |checked, total, current| {
                let _ = app.emit(
                    PROGRESS_EVENT,
                    DuplicateProgress {
                        scan_id: guard.id.clone(),
                        checked,
                        total,
                        current: current.into(),
                    },
                );
            },
        ))
    })
    .await
    .map_err(|e| format!("重复文件检测失败：{e}"))?
}

#[tauri::command(rename = "cancel_library_duplicate_scan")]
pub fn cmd_cancel_library_duplicate_scan(scan_id: String) -> bool {
    let active = active_scan().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(scan) = active.as_ref().filter(|scan| scan.id == scan_id) {
        scan.cancelled.store(true, Ordering::Relaxed);
        true
    } else {
        false
    }
}

#[tauri::command(rename = "preview_library_organization")]
pub async fn cmd_preview_library_organization(
    state: State<'_, AppState>,
    destination: String,
) -> Result<OrganizePreview, String> {
    let db = state.db.clone().ok_or("数据库不可用")?;
    tauri::async_runtime::spawn_blocking(move || {
        let files = db.with(library_files)?;
        organize_preview(files, &PathBuf::from(destination))
    })
    .await
    .map_err(|e| format!("生成整理预览失败：{e}"))?
}

// ---------------- 整理执行 + 撤销（A11） ----------------
//
// 预览是只读的，这里才真动文件。三条硬规矩：
// 1. **先落撤销清单再搬文件**：搬一半崩了，重启后照样能撤（清单只保留最近一次）；
// 2. 只搬预览里 `ready` 的项，`blocked` / `unchanged` 一概不碰；
// 3. 文件搬成功但库没跟上就把文件搬回去，不留「文件在新位置、库里还在旧位置」的半截状态。

/// 撤销清单文件名（应用数据根目录下）。只保留最近一次整理。
const UNDO_FILE: &str = "organize-undo.json";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UndoMove {
    source: String,
    target: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UndoFile {
    /// epoch 毫秒
    at: i64,
    moves: Vec<UndoMove>,
}

/// 一条搬失败的原因（逐条回报，不整批回滚）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeFailure {
    source: String,
    target: String,
    message: String,
}

/// 整理执行结果。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeOutcome {
    moved: usize,
    blocked: usize,
    unchanged: usize,
    failed: Vec<OrganizeFailure>,
    undo_available: bool,
}

/// 撤销清单的概要（前端用来决定要不要显示「撤销上次整理」）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeUndoState {
    /// epoch 毫秒
    at: i64,
    count: usize,
}

/// 撤销结果。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizeUndoOutcome {
    restored: usize,
    failed: Vec<OrganizeFailure>,
}

fn undo_file_path(dir: &Path) -> PathBuf {
    dir.join(UNDO_FILE)
}

fn read_undo(dir: &Path) -> Option<UndoFile> {
    let raw = fs::read(undo_file_path(dir)).ok()?;
    let parsed: UndoFile = serde_json::from_slice(&raw).ok()?;
    (!parsed.moves.is_empty()).then_some(parsed)
}

/// 原子写：先写 `.json.tmp` 再 `rename`，中途崩掉不会留下半个 JSON。
fn write_undo(dir: &Path, undo: &UndoFile) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let path = undo_file_path(dir);
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(undo).map_err(|e| format!("写入撤销记录失败：{e}"))?;
    fs::write(&tmp, json).map_err(|e| format!("写入撤销记录失败：{e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("写入撤销记录失败：{e}"))
}

fn clear_undo(dir: &Path) {
    let _ = fs::remove_file(undo_file_path(dir));
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 搬一个文件：同盘 `rename` 最快也最原子；跨盘（EXDEV）退化成复制 + 删源。
fn move_file(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        return Err("目标位置已存在同名文件".into());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目标文件夹失败：{e}"))?;
    }
    match fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            fs::copy(source, target).map_err(|e| format!("移动失败：{rename_err}；复制也失败：{e}"))?;
            fs::remove_file(source).map_err(|e| format!("已复制到新位置，但原文件删不掉：{e}"))?;
            Ok(())
        }
    }
}

/// 按 `ready` 清单搬文件，`sync` 负责把库里那条记录挪到新路径。
/// 清单先落盘再动手；全部失败时把清单清掉（没什么可撤的）。
fn apply_moves<F>(moves: &[UndoMove], undo_dir: &Path, mut sync: F) -> OrganizeOutcome
where
    F: FnMut(&str, &str) -> Result<(), String>,
{
    let mut outcome = OrganizeOutcome {
        moved: 0,
        blocked: 0,
        unchanged: 0,
        failed: Vec::new(),
        undo_available: false,
    };
    if moves.is_empty() {
        return outcome;
    }
    let at = now_ms();
    // 先写「计划清单」：只要开始搬，就必须有据可撤。
    if let Err(e) = write_undo(
        undo_dir,
        &UndoFile {
            at,
            moves: moves.to_vec(),
        },
    ) {
        for m in moves {
            outcome.failed.push(OrganizeFailure {
                source: m.source.clone(),
                target: m.target.clone(),
                message: format!("写不了撤销记录，为安全起见没有移动：{e}"),
            });
        }
        return outcome;
    }
    let mut done: Vec<UndoMove> = Vec::new();
    for m in moves {
        let source = PathBuf::from(&m.source);
        let target = PathBuf::from(&m.target);
        if let Err(e) = move_file(&source, &target) {
            outcome.failed.push(OrganizeFailure {
                source: m.source.clone(),
                target: m.target.clone(),
                message: e,
            });
            continue;
        }
        if let Err(e) = sync(&m.source, &m.target) {
            // 文件已在新位置、库没跟上：搬回去，保持两边一致。
            let back = move_file(&target, &source)
                .err()
                .map(|rollback| format!("；回退也失败：{rollback}"))
                .unwrap_or_default();
            outcome.failed.push(OrganizeFailure {
                source: m.source.clone(),
                target: m.target.clone(),
                message: format!("更新曲库失败：{e}{back}"),
            });
            continue;
        }
        done.push(m.clone());
        outcome.moved += 1;
    }
    if done.is_empty() {
        clear_undo(undo_dir);
    } else {
        // 只留下真搬成功的项，撤销时才不会去搬没搬过的文件。
        let _ = write_undo(
            undo_dir,
            &UndoFile {
                at,
                moves: done,
            },
        );
        outcome.undo_available = true;
    }
    outcome
}

/// 撤销上一次整理：倒序搬回原位置并同步库。返回恢复条数与逐条失败原因。
fn undo_moves<F>(undo_dir: &Path, mut sync: F) -> Result<OrganizeUndoOutcome, String>
where
    F: FnMut(&str, &str) -> Result<(), String>,
{
    let Some(state) = read_undo(undo_dir) else {
        return Err("没有可撤销的整理记录".into());
    };
    let mut restored = 0usize;
    let mut failed = Vec::new();
    let mut remaining: Vec<UndoMove> = Vec::new();
    for m in state.moves.iter().rev() {
        let target = PathBuf::from(&m.target);
        let source = PathBuf::from(&m.source);
        let reason = if !target.is_file() {
            Some("撤销时目标位置已找不到文件".to_string())
        } else if source.exists() {
            Some("原位置已被别的文件占用".to_string())
        } else {
            move_file(&target, &source)
                .and_then(|()| sync(&m.target, &m.source))
                .err()
        };
        match reason {
            None => restored += 1,
            Some(message) => {
                failed.push(OrganizeFailure {
                    source: m.source.clone(),
                    target: m.target.clone(),
                    message,
                });
                remaining.push(m.clone());
            }
        }
    }
    if remaining.is_empty() {
        clear_undo(undo_dir);
    } else {
        write_undo(
            undo_dir,
            &UndoFile {
                at: state.at,
                moves: remaining,
            },
        )?;
    }
    Ok(OrganizeUndoOutcome { restored, failed })
}

#[tauri::command(rename = "apply_library_organization")]
pub async fn cmd_apply_library_organization(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    destination: String,
) -> Result<OrganizeOutcome, String> {
    let db = state.db.clone().ok_or("数据库不可用")?;
    let undo_dir = crate::app_paths::data_root(&app);
    tauri::async_runtime::spawn_blocking(move || {
        // 不信任前端传来的条目：重新算一次预览，只搬现在就 ready 的。
        let files = db.with(library_files)?;
        let preview = organize_preview(files, &PathBuf::from(&destination))?;
        let moves: Vec<UndoMove> = preview
            .entries
            .iter()
            .filter(|entry| entry.status == "ready")
            .map(|entry| UndoMove {
                source: entry.source.clone(),
                target: entry.target.clone(),
            })
            .collect();
        let mut outcome = apply_moves(&moves, &undo_dir, |from, to| {
            db.with(|conn| crate::db::store::relocate_local_track(conn, from, to))
                .map(|_| ())
        });
        outcome.blocked = preview.blocked;
        outcome.unchanged = preview.unchanged;
        Ok(outcome)
    })
    .await
    .map_err(|e| format!("整理失败：{e}"))?
}

#[tauri::command(rename = "undo_library_organization")]
pub async fn cmd_undo_library_organization(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<OrganizeUndoOutcome, String> {
    let db = state.db.clone().ok_or("数据库不可用")?;
    let undo_dir = crate::app_paths::data_root(&app);
    tauri::async_runtime::spawn_blocking(move || {
        undo_moves(&undo_dir, |from, to| {
            db.with(|conn| crate::db::store::relocate_local_track(conn, from, to))
                .map(|_| ())
        })
    })
    .await
    .map_err(|e| format!("撤销整理失败：{e}"))?
}

#[tauri::command(rename = "library_organize_undo_state")]
pub fn cmd_library_organize_undo_state(app: tauri::AppHandle) -> Option<OrganizeUndoState> {
    read_undo(&crate::app_paths::data_root(&app)).map(|undo| OrganizeUndoState {
        at: undo.at,
        count: undo.moves.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "qm-maintenance-{}-{}",
                std::process::id(),
                fastrand::u64(..)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn file(&self, name: &str, bytes: &[u8]) -> LibraryFile {
            let path = self.0.join(name);
            fs::write(&path, bytes).unwrap();
            LibraryFile {
                path: path.to_string_lossy().into_owned(),
                title: "歌曲".into(),
                singer: "歌手".into(),
                album: "专辑".into(),
                cue: false,
                track_count: 1,
            }
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn hashes_full_content_and_reports_missing_files_without_writing() {
        let temp = Temp::new();
        let a = temp.file("a.flac", b"same bytes");
        let b = temp.file("b.flac", b"same bytes");
        let c = temp.file("c.flac", b"diff bytes");
        let mut absent = a.clone();
        absent.path = temp.0.join("gone").to_string_lossy().into_owned();
        let report = find_duplicates(
            vec![a.clone(), b, c, absent],
            &AtomicBool::new(false),
            |_, _, _| {},
        );
        assert_eq!(report.scanned_files, 3);
        assert_eq!(report.hashed_files, 3);
        assert_eq!(report.groups.len(), 1);
        assert_eq!(report.groups[0].files.len(), 2);
        assert_eq!(report.groups[0].sha256.len(), 64);
        assert_eq!(report.issues.len(), 1);
        assert_eq!(fs::read(a.path).unwrap(), b"same bytes");
    }
    #[test]
    fn size_change_after_bucketing_is_reported_instead_of_grouped() {
        let temp = Temp::new();
        let a = temp.file("a.flac", b"same bytes");
        let b = temp.file("b.flac", b"same bytes");
        let mut changed = false;
        let report = find_duplicates(vec![a, b], &AtomicBool::new(false), |_, total, current| {
            if total > 0 && !current.is_empty() && !changed {
                fs::write(current, b"changed size").unwrap();
                changed = true;
            }
        });
        assert!(changed);
        assert!(report.groups.is_empty());
        assert_eq!(report.hashed_files, 1);
        assert_eq!(report.issues.len(), 1);
        assert!(report.issues[0]
            .message
            .contains("文件大小在检测过程中发生变化"));
    }
    #[test]
    fn cancellation_stops_before_disk_read() {
        let temp = Temp::new();
        let report = find_duplicates(
            vec![temp.file("a.mp3", b"a")],
            &AtomicBool::new(true),
            |_, _, _| panic!("must not hash"),
        );
        assert!(report.cancelled);
        assert_eq!(report.hashed_files, 0);
    }
    #[test]
    fn cue_rows_collapse_by_physical_path_in_database() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        for id in ["album.flac#cue:1", "album.flac#cue:2"] {
            conn.execute("INSERT INTO tracks (id, platform, title, singer, album, local_path, cue_path, created_at, updated_at) VALUES (?1, 'local', '歌曲', '歌手', '专辑', 'album.flac', 'album.cue', 0, 0)", [id]).unwrap();
        }
        let files = library_files(&conn).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].track_count, 2);
        assert!(files[0].cue);
    }
    #[test]
    fn aliases_of_same_physical_path_do_not_become_duplicates() {
        let temp = Temp::new();
        let file = temp.file("a.mp3", b"a");
        let report = find_duplicates(
            vec![file.clone(), file],
            &AtomicBool::new(false),
            |_, _, _| {},
        );
        assert_eq!(report.scanned_files, 1);
        assert!(report.groups.is_empty());
    }
    #[test]
    fn preview_blocks_collisions_cue_and_existing_targets_and_leaves_source_intact() {
        let temp = Temp::new();
        let dest = temp.0.join("out");
        fs::create_dir(&dest).unwrap();
        let a = temp.file("a.flac", b"a");
        let b = temp.file("b.flac", b"b");
        let report = organize_preview(vec![a.clone(), b], &dest).unwrap();
        assert_eq!(report.blocked, 2);
        assert!(!dest.join("歌手").exists());
        let report = organize_preview(vec![a.clone()], &dest).unwrap();
        assert_eq!(report.ready, 1);
        let target = Path::new(&report.entries[0].target);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, b"existing").unwrap();
        assert_eq!(organize_preview(vec![a.clone()], &dest).unwrap().blocked, 1);
        let mut cue = a.clone();
        cue.cue = true;
        assert_eq!(organize_preview(vec![cue], &dest).unwrap().blocked, 1);
        assert_eq!(fs::read(a.path).unwrap(), b"a");
        assert_eq!(fs::read(target).unwrap(), b"existing");
    }
    #[test]
    fn path_components_cannot_escape_or_use_windows_reserved_names() {
        assert_eq!(safe_component("..", "fallback"), "fallback");
        assert_eq!(safe_component("CON.mp3", "fallback"), "_CON.mp3");
        assert_eq!(safe_component("a/b\\c:*", "fallback"), "a_b_c__");
        assert_eq!(safe_component("  title. ", "fallback"), "title");
        assert!(organize_preview(vec![], Path::new("relative")).is_err());
    }
    // ---- A11 整理执行 / 撤销（文件搬运部分；库同步用闭包替身） ----

    fn ready_moves(preview: &OrganizePreview) -> Vec<UndoMove> {
        preview
            .entries
            .iter()
            .filter(|entry| entry.status == "ready")
            .map(|entry| UndoMove {
                source: entry.source.clone(),
                target: entry.target.clone(),
            })
            .collect()
    }

    #[test]
    fn apply_moves_the_file_and_leaves_an_undo_record() {
        let temp = Temp::new();
        let dest = temp.0.join("out");
        fs::create_dir(&dest).unwrap();
        let a = temp.file("a.flac", b"alpha");
        let preview = organize_preview(vec![a.clone()], &dest).unwrap();
        assert_eq!(preview.ready, 1);
        let moves = ready_moves(&preview);

        let mut synced: Vec<(String, String)> = Vec::new();
        let dir = temp.0.join("data");
        let outcome = apply_moves(&moves, &dir, |from, to| {
            synced.push((from.to_string(), to.to_string()));
            Ok(())
        });
        assert_eq!(outcome.moved, 1);
        assert!(outcome.failed.is_empty());
        assert!(outcome.undo_available);
        assert_eq!(synced, vec![(a.path.clone(), moves[0].target.clone())]);
        assert!(!Path::new(&a.path).exists(), "源文件应该已经搬走");
        let target = Path::new(&moves[0].target);
        assert_eq!(fs::read(target).unwrap(), b"alpha");

        let undo = read_undo(&dir).expect("应该有撤销记录");
        assert_eq!(undo.moves.len(), 1);
        assert_eq!(undo.moves[0].source, a.path);
        assert_eq!(undo.moves[0].target, moves[0].target);
    }

    #[test]
    fn undo_moves_everything_back_then_forgets_itself() {
        let temp = Temp::new();
        let dest = temp.0.join("out");
        fs::create_dir(&dest).unwrap();
        let a = temp.file("a.flac", b"alpha");
        let preview = organize_preview(vec![a.clone()], &dest).unwrap();
        let moves = ready_moves(&preview);
        let dir = temp.0.join("data");
        let outcome = apply_moves(&moves, &dir, |_, _| Ok(()));
        assert_eq!(outcome.moved, 1);

        let mut synced: Vec<(String, String)> = Vec::new();
        let undo = undo_moves(&dir, |from, to| {
            synced.push((from.to_string(), to.to_string()));
            Ok(())
        })
        .unwrap();
        assert_eq!(undo.restored, 1);
        assert!(undo.failed.is_empty());
        assert_eq!(synced, vec![(moves[0].target.clone(), a.path.clone())]);
        assert_eq!(fs::read(&a.path).unwrap(), b"alpha", "文件应该回到原位置");
        assert!(!Path::new(&moves[0].target).exists());
        assert!(read_undo(&dir).is_none(), "撤销成功后清单要清掉");
        assert!(undo_moves(&dir, |_, _| Ok(())).is_err(), "没有清单时撤销要报错");
    }

    #[test]
    fn apply_skips_vanished_sources_and_keeps_going() {
        let temp = Temp::new();
        let dest = temp.0.join("out");
        fs::create_dir(&dest).unwrap();
        let a = temp.file("a.flac", b"alpha");
        // 两首文件名不同、标题也得不同，否则预览会把它们判成「映射到同一目标」
        let mut b = temp.file("b.flac", b"beta");
        b.title = "另一首歌".into();
        let preview = organize_preview(vec![a.clone(), b.clone()], &dest).unwrap();
        assert_eq!(preview.ready, 2);
        let mut moves = ready_moves(&preview);
        // 预览之后源文件被别人删了：一条失败，另一条照搬
        fs::remove_file(&b.path).unwrap();
        moves.sort_by(|x, y| x.source.cmp(&y.source));
        let dir = temp.0.join("data");
        let outcome = apply_moves(&moves, &dir, |_, _| Ok(()));
        assert_eq!(outcome.moved, 1);
        assert_eq!(outcome.failed.len(), 1);
        assert!(outcome.failed[0].message.contains("目标位置已存在")
            || outcome.failed[0].message.contains("移动失败")
            || outcome.failed[0].message.contains("复制也失败"));
        assert!(outcome.undo_available);
        assert_eq!(read_undo(&dir).unwrap().moves.len(), 1, "撤销记录只留真搬成功的");
    }

    #[test]
    fn apply_rolls_the_file_back_when_the_library_cannot_follow() {
        let temp = Temp::new();
        let dest = temp.0.join("out");
        fs::create_dir(&dest).unwrap();
        let a = temp.file("a.flac", b"alpha");
        let preview = organize_preview(vec![a.clone()], &dest).unwrap();
        let moves = ready_moves(&preview);
        let dir = temp.0.join("data");
        let outcome = apply_moves(&moves, &dir, |_, _| Err("库被锁住了".into()));
        assert_eq!(outcome.moved, 0);
        assert_eq!(outcome.failed.len(), 1);
        assert!(outcome.failed[0].message.contains("库被锁住了"));
        assert!(outcome.failed[0].message.contains("更新曲库失败"));
        assert_eq!(fs::read(&a.path).unwrap(), b"alpha", "库没跟上就要把文件搬回去");
        assert!(!Path::new(&moves[0].target).exists());
        assert!(!outcome.undo_available);
        assert!(read_undo(&dir).is_none(), "没有真搬成功的，清单要清掉");
    }

    #[test]
    fn apply_refuses_to_move_anything_when_the_undo_record_cannot_be_written() {
        let temp = Temp::new();
        let dest = temp.0.join("out");
        fs::create_dir(&dest).unwrap();
        let a = temp.file("a.flac", b"alpha");
        let preview = organize_preview(vec![a.clone()], &dest).unwrap();
        let moves = ready_moves(&preview);
        // 用一个「文件」当数据目录：create_dir_all 必然失败
        let blocked = temp.0.join("not-a-dir");
        fs::write(&blocked, b"x").unwrap();
        let outcome = apply_moves(&moves, &blocked, |_, _| Ok(()));
        assert_eq!(outcome.moved, 0);
        assert_eq!(outcome.failed.len(), 1);
        assert!(outcome.failed[0].message.contains("写不了撤销记录"));
        assert_eq!(fs::read(&a.path).unwrap(), b"alpha", "没有撤销记录就不许动文件");
    }
}
