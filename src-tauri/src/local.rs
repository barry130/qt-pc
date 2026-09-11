//! 本地音乐库：目录扫描、音频元数据读取与入库（DESIGN §13）。
//!
//! - §13.1 扫描流程：遍历目录 → 过滤支持的音频格式 → 读取元数据 → 写入 SQLite。
//! - §13.2 增量扫描：本次命中的文件 `missing = 0`；扫描目录范围内未命中的旧记录 `missing = 1`。
//! - 元数据读不到时降级为「文件名解析」（`歌手 - 标题`），时长取不到记 0。
//!
//! ## 关键约定
//! 本地曲目的 `Track.id` 就是音频文件的**绝对路径字符串**，`platform = SourceId::Local`，
//! 因此 db 主键为 `local:<绝对路径>`（见 `db::store::db_track_id`）；播放时
//! `audio::engine` 已特判 Local——直接把 `id` 当文件路径解码。
//! `pic_url` 恒为空串、`music_id` 恒为 None（本地文件不参与在线封面/取址链路）。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::{MetadataOptions, MetadataRevision, StandardTagKey, Value};
use symphonia::core::probe::Hint;

use crate::db::store::LocalTrackRow;

/// 支持的音频扩展名（§13.1「过滤支持的音频格式」），比较时大小写不敏感。
pub const SUPPORTED_EXTS: [&str; 6] = ["mp3", "flac", "wav", "ogg", "m4a", "aac"];

/// 文件名降级解析的分隔符：常见命名习惯 `歌手 - 标题`。
const FILENAME_SEPARATOR: &str = " - ";

/// 单个音频文件的标签元数据（读不到或缺失的字段为 None）。
#[derive(Debug, Default, Clone)]
pub struct FileMeta {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// 秒；取不到时为 0.0
    pub duration_secs: f64,
}

/// 判断是否为受支持的音频文件（按扩展名，大小写不敏感）。
pub fn is_audio_file(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => SUPPORTED_EXTS
            .iter()
            .any(|known| known.eq_ignore_ascii_case(ext)),
        None => false,
    }
}

/// 文件名（不含扩展名）降级解析：按 `" - "` 分割，第 0 段作歌手、其余作标题；
/// 没有分隔符则整段作标题、歌手留空。返回 `(singer, title)`。
pub fn parse_file_stem(stem: &str) -> (String, String) {
    match stem.split_once(FILENAME_SEPARATOR) {
        Some((singer, title)) => (singer.trim().to_string(), title.trim().to_string()),
        None => (String::new(), stem.trim().to_string()),
    }
}

/// 递归收集目录下的音频文件（§13.1）。
/// 无法读取的目录（权限不足 / 已失效的链接等）直接跳过，不中断整次扫描。
pub fn collect_audio_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    collect_into(root, &mut out);
    out
}

fn collect_into(dir: &Path, out: &mut Vec<PathBuf>) {
    // 目录读不了（权限 / 被删除 / 设备未就绪）→ 记日志并跳过，不让扫描整体失败
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            log::debug!("[local] 目录读取失败，已跳过 {}: {e}", dir.display());
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_into(&path, out);
        } else if path.is_file() && is_audio_file(&path) {
            out.push(path);
        }
    }
}

/// 扫描若干目录，产出入库行（不触碰数据库，便于单测）。
/// 目录不存在时静默跳过；同一路径只会产出一条（多目录重叠时去重）。
pub fn scan_dirs(dirs: &[String]) -> Vec<LocalTrackRow> {
    let mut rows = Vec::new();
    let mut seen = HashSet::new();
    for dir in dirs {
        let root = Path::new(dir);
        if !root.exists() {
            log::warn!("[local] 目录不存在，已跳过: {dir}");
            continue;
        }
        for path in collect_audio_files(root) {
            let Some(path_str) = path.to_str().map(str::to_string) else {
                continue;
            };
            if !seen.insert(path_str.clone()) {
                continue;
            }
            rows.push(build_row(&path, path_str));
        }
    }
    rows.sort_by(|a, b| a.path.cmp(&b.path));
    rows
}

/// 组装入库行：优先 symphonia 元数据，缺失字段回落到文件名解析。
fn build_row(path: &Path, path_str: String) -> LocalTrackRow {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
    let (fallback_singer, fallback_title) = parse_file_stem(stem);
    let (title, singer, album, duration_secs) = match read_metadata(path) {
        Some(m) => (
            non_empty(m.title).unwrap_or(fallback_title),
            non_empty(m.artist).unwrap_or(fallback_singer),
            non_empty(m.album).unwrap_or_default(),
            m.duration_secs,
        ),
        None => (fallback_title, fallback_singer, String::new(), 0.0),
    };
    let (file_size, mtime) = file_stats(path);
    LocalTrackRow {
        path: path_str,
        title,
        singer,
        album,
        duration_ms: (duration_secs * 1000.0) as i64,
        file_size,
        mtime,
        format: extension_of(path),
    }
}

/// 读取容器/标签元数据（§13.1「读取元数据」）。文件打不开或格式不支持时返回 None，
/// 由调用方降级到文件名解析。
pub fn read_metadata(path: &Path) -> Option<FileMeta> {
    let file = std::fs::File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let mut probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .ok()?;

    // 时长：取所有音轨里最长的（多轨容器取主轨）
    let duration_secs = probed
        .format
        .tracks()
        .iter()
        .filter_map(|t| {
            let time_base = t.codec_params.time_base?;
            let frames = t.codec_params.n_frames?;
            let time = time_base.calc_time(frames);
            Some(time.seconds as f64 + time.frac)
        })
        .fold(0.0_f64, f64::max);

    let mut meta = FileMeta {
        duration_secs,
        ..FileMeta::default()
    };
    // 容器外挂标签（如 MP3 的 ID3v2）
    if let Some(mut md) = probed.metadata.get() {
        if let Some(rev) = md.skip_to_latest() {
            pick_tags(rev, &mut meta);
        }
    }
    // 容器内建标签（如 FLAC / OGG 的 Vorbis Comments）
    {
        let mut md = probed.format.metadata();
        if let Some(rev) = md.skip_to_latest() {
            pick_tags(rev, &mut meta);
        }
    }
    Some(meta)
}

/// 从一版标签里挑出标题 / 歌手 / 专辑（首次命中优先，后续不覆盖）。
/// `AlbumArtist` 仅在 `Artist` 缺失时作为歌手兜底。
fn pick_tags(rev: &MetadataRevision, meta: &mut FileMeta) {
    for tag in rev.tags() {
        let Some(value) = non_empty(tag_string(&tag.value)) else {
            continue;
        };
        match tag.std_key {
            Some(StandardTagKey::TrackTitle) => {
                meta.title.get_or_insert(value);
            }
            Some(StandardTagKey::Artist) => {
                meta.artist.get_or_insert(value);
            }
            Some(StandardTagKey::AlbumArtist) => {
                if meta.artist.is_none() {
                    meta.artist = Some(value);
                }
            }
            Some(StandardTagKey::Album) => {
                meta.album.get_or_insert(value);
            }
            _ => {}
        }
    }
}

/// 标签值转字符串；二进制等不可展示的类型直接丢弃。
fn tag_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Flag | Value::Binary(_) => None,
        other => Some(other.to_string()),
    }
}

/// 去掉空串与纯空白。
fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.trim().is_empty())
}

/// 扩展名（小写、不含点）；取不到返回空串。
fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_lowercase()
}

/// 文件大小（字节）与修改时间（epoch 秒），取不到记 0（§13.2 增量依据）。
fn file_stats(path: &Path) -> (i64, i64) {
    match path.metadata() {
        Ok(md) => {
            let size = md.len() as i64;
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            (size, mtime)
        }
        Err(_) => (0, 0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::db::store::{
        add_scan_dir, list_scan_dirs, mark_missing_local_tracks, query_local_tracks,
        remove_scan_dir, upsert_local_tracks,
    };
    use rusqlite::Connection;

    /// 建一个进程唯一的临时目录（不联网、不依赖真实音乐目录）
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lightlisten-local-{tag}-{}-{}",
            std::process::id(),
            fastrand::u64(..)
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn touch(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::create_dir_all(p.parent().unwrap()).expect("创建父目录");
        std::fs::write(&p, b"not-a-real-audio-file").expect("写入临时文件");
        p
    }

    // ---------- 扩展名过滤（§13.1） ----------

    #[test]
    fn audio_ext_filter_is_case_insensitive() {
        for name in [
            "a.mp3", "b.FLAC", "c.Wav", "d.ogg", "e.M4A", "f.aac", "g.AAC",
        ] {
            assert!(is_audio_file(Path::new(name)), "{name} 应被识别为音频");
        }
        for name in ["a.txt", "b.mp4", "c.lrc", "d.jpg", "noext", "e.mp3.bak"] {
            assert!(!is_audio_file(Path::new(name)), "{name} 不应被识别为音频");
        }
    }

    #[test]
    fn collect_recursively_and_skips_non_audio() {
        let root = temp_dir("collect");
        let a = touch(&root, "周杰伦 - 晴天.mp3");
        let b = touch(&root, "sub/deep/陈奕迅 - 富士山下.flac");
        touch(&root, "cover.jpg");
        touch(&root, "sub/lyric.lrc");

        let mut found = collect_audio_files(&root);
        found.sort();

        let expected = [a.clone(), b.clone()];
        let mut expected = expected.to_vec();
        expected.sort();
        assert_eq!(found, expected);
        assert!(found.contains(&a) && found.contains(&b));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unreadable_or_missing_dir_is_skipped() {
        let root = temp_dir("missing-dir");
        let _ = std::fs::remove_dir_all(&root);
        // 目录不存在：返回空而不是 panic
        assert!(collect_audio_files(&root).is_empty());
        // 扫描入口同样静默跳过
        assert!(scan_dirs(&[root.to_string_lossy().to_string()]).is_empty());
    }

    // ---------- 文件名降级解析 ----------

    #[test]
    fn stem_fallback_splits_on_separator() {
        assert_eq!(
            parse_file_stem("周杰伦 - 晴天"),
            ("周杰伦".to_string(), "晴天".to_string())
        );
        // 多个分隔符：第 0 段歌手，其余整体作标题
        assert_eq!(
            parse_file_stem("Beyond - 海阔天空 - Live"),
            ("Beyond".to_string(), "海阔天空 - Live".to_string())
        );
        // 无分隔符：整段作标题，歌手留空
        assert_eq!(
            parse_file_stem("夜空中最亮的星"),
            (String::new(), "夜空中最亮的星".to_string())
        );
    }

    // ---------- 端到端扫描（假文件 → 走降级路径） ----------

    #[test]
    fn scan_dirs_falls_back_to_filename_and_dedups() {
        let root = temp_dir("scan");
        let first = touch(&root, "五月天 - 倔强.mp3");
        let second = touch(&root, "nested/无分隔符标题.flac");
        touch(&root, "ignore.txt");

        let dirs = vec![root.to_string_lossy().to_string()];
        let rows = scan_dirs(&dirs);
        assert_eq!(rows.len(), 2, "只应产出两条音频记录");

        // 逐组件比较（Windows 下 `\` 与 `/` 等价，字符串直接比会假失败）
        let found_paths: Vec<PathBuf> = rows.iter().map(|r| PathBuf::from(&r.path)).collect();
        assert!(found_paths.contains(&first), "缺少 {first:?}");
        assert!(found_paths.contains(&second), "缺少 {second:?}");

        // 假文件：symphonia 读不出元数据 → 走文件名降级，时长 0
        let row = rows
            .iter()
            .find(|r| r.path.ends_with("五月天 - 倔强.mp3"))
            .expect("应有该文件");
        assert_eq!(row.singer, "五月天");
        assert_eq!(row.title, "倔强");
        assert_eq!(row.duration_ms, 0);
        assert_eq!(row.format, "mp3");

        let nested = rows
            .iter()
            .find(|r| r.path.ends_with("无分隔符标题.flac"))
            .expect("应有该文件");
        assert_eq!(nested.title, "无分隔符标题");
        assert_eq!(nested.singer, "");
        assert_eq!(nested.format, "flac");

        // 同一目录传两遍：路径去重
        let dup = scan_dirs(&[
            root.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
        ]);
        assert_eq!(dup.len(), 2, "重叠目录应去重");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn symphonia_probe_rejects_garbage_file() {
        let root = temp_dir("garbage");
        let p = touch(&root, "junk.mp3");
        assert!(
            read_metadata(&p).is_none(),
            "非真实音频应返回 None 以触发降级"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---------- 入库 / 缺失标记（§13.2） ----------

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        migrations::run(&conn).expect("migrations");
        conn
    }

    #[test]
    fn local_tracks_roundtrip_and_missing_flag() {
        let conn = test_conn();
        let root = temp_dir("upsert");
        let first = touch(&root, "朴树 - 平凡之路.mp3");
        let second = touch(&root, "朴树 - 白桦林.mp3");

        let dirs = vec![root.to_string_lossy().to_string()];
        let rows = scan_dirs(&dirs);
        assert_eq!(rows.len(), 2);
        upsert_local_tracks(&conn, &rows).expect("upsert");

        let tracks = query_local_tracks(&conn).expect("query");
        assert_eq!(tracks.len(), 2);
        assert!(tracks.iter().all(|t| t.platform == crate::provider::types::SourceId::Local));
        assert!(tracks.iter().all(|t| t.pic_url.is_empty()));
        assert!(tracks.iter().all(|t| t.music_id.is_none()));
        // id 必须是绝对路径，引擎直接拿它当播放路径用
        let ids: Vec<&str> = tracks.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&first.to_string_lossy().as_ref()));
        assert!(ids.contains(&second.to_string_lossy().as_ref()));

        // 重复扫描：更新而非插入重复行
        upsert_local_tracks(&conn, &rows).expect("upsert again");
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM tracks WHERE platform='local'", [], |r| {
                r.get(0)
            })
            .expect("count");
        assert_eq!(total, 2, "重复扫描不应产生重复行");

        // 删掉一个文件后重扫 → 该记录标 missing，查询时被过滤
        std::fs::remove_file(&second).expect("删除临时文件");
        let rows2 = scan_dirs(&dirs);
        assert_eq!(rows2.len(), 1);
        let present: HashSet<String> = rows2.iter().map(|r| r.path.clone()).collect();
        let marked = mark_missing_local_tracks(&conn, &dirs, &present).expect("mark");
        assert_eq!(marked, 1, "应标记 1 条缺失");

        let left = query_local_tracks(&conn).expect("query");
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, first.to_string_lossy());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_flag_only_touches_scanned_scope() {
        let conn = test_conn();
        let in_scope = temp_dir("scope-in");
        let out_scope = temp_dir("scope-out");
        let a = touch(&in_scope, "A - a.mp3");
        let b = touch(&out_scope, "B - b.mp3");

        let rows = scan_dirs(&[
            in_scope.to_string_lossy().to_string(),
            out_scope.to_string_lossy().to_string(),
        ]);
        upsert_local_tracks(&conn, &rows).expect("upsert");

        // 只扫描 in_scope，且文件已删 → 只标记 in_scope 的记录
        std::fs::remove_file(&a).expect("删除");
        let present: HashSet<String> = HashSet::new();
        let marked = mark_missing_local_tracks(
            &conn,
            &[in_scope.to_string_lossy().to_string()],
            &present,
        )
        .expect("mark");
        assert_eq!(marked, 1);

        let left = query_local_tracks(&conn).expect("query");
        assert_eq!(left.len(), 1, "范围外记录不应被标记");
        assert_eq!(left[0].id, b.to_string_lossy());

        let _ = std::fs::remove_dir_all(&in_scope);
        let _ = std::fs::remove_dir_all(&out_scope);
    }

    // ---------- 扫描目录清单（scan_dirs 表） ----------

    #[test]
    fn scan_dir_list_roundtrip() {
        let conn = test_conn();
        let root = temp_dir("dirlist");
        let path = root.to_string_lossy().to_string();

        assert!(list_scan_dirs(&conn).expect("list").is_empty());

        add_scan_dir(&conn, &path).expect("add");
        add_scan_dir(&conn, &path).expect("重复添加应幂等");
        assert_eq!(list_scan_dirs(&conn).expect("list"), vec![path.clone()]);

        remove_scan_dir(&conn, &path).expect("remove");
        assert!(list_scan_dirs(&conn).expect("list").is_empty());

        // 移除不存在的目录不报错
        remove_scan_dir(&conn, &path).expect("remove 幂等");

        let _ = std::fs::remove_dir_all(&root);
    }
}
