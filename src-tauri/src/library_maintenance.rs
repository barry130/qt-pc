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
}
