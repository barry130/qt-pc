//! 歌单导出 / 导入（REQUIREMENTS §3.21.5，报告 §6.1）。
//!
//! 这里补的是全项目最刺眼的一处不对称：**能导入、不能导出**（§0 第 3 条）。
//! 三种格式的分工照需求原文来：
//! - `.json`：完整元数据（音源 id / 标题 / 歌手 / 专辑 / 时长 / 封面），**可跨设备恢复**；
//! - `.m3u8`：只写本地文件条目（在线曲目写进去也只是"过期就播不了"的假地址），
//!   在线条目按需求原文**跳过并提示**；
//! - M3U **导入**不做（REQUIREMENTS §2.3 明说不支持），`.json` 回环导入做。
//!
//! 为什么导出放在 Rust 而不是前端拼字符串：文件名要做 Windows 非法字符净化、
//! 本地条目的真实路径要去 `tracks.local_path` 查（本地曲目的 `Track.id` 虽然是
//! 绝对路径，但库里的 `local_path` 才是"缺文件标记"认的那一份），都是宿主侧的事；
//! 前端只负责选目录、选文件、报数。

use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::{store, Database};
use crate::provider::types::Track;

/// 歌单文件的身份标记与版本：导入时先认这两项，避免把别家的 json 当歌单读进来。
pub const KIND: &str = "quietmusic-playlist";
pub const VERSION: u32 = 1;

/// 文件名净化后的长度上限（Windows 的 260 字符路径预算里还得给目录留位置）。
const MAX_STEM: usize = 60;

/// `.json` 歌单文件的结构（`Track` 自带 camelCase，前端可直接当 `Playlist.tracks` 用）。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistFile {
    pub kind: String,
    pub version: u32,
    pub name: String,
    /// 导出时刻（秒），只作展示与"哪份更新"的粗判。
    /// 缺省容忍：手写/脚本生成的文件没有这一项也不该被拒（版本号才是硬校验）。
    #[serde(default)]
    pub exported_at: u64,
    pub tracks: Vec<Track>,
}

impl PlaylistFile {
    /// 组装待写盘的歌单文件。
    fn new(name: &str, tracks: Vec<Track>) -> Self {
        Self {
            kind: KIND.to_string(),
            version: VERSION,
            name: name.to_string(),
            exported_at: crate::db::health::unix_now(),
            tracks,
        }
    }
}

/// 导出结果（前端据此提示"写了几个文件、跳过了几首"）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub name: String,
    pub json_path: String,
    /// 全是本地文件时才写；一首本地文件都没有就是 `None`（不产出空 m3u8）
    pub m3u8_path: Option<String>,
    /// 歌单曲目总数
    pub total: u32,
    /// 写进 `.m3u8` 的条目数
    pub local: u32,
    /// 写不进 `.m3u8` 的条目数（在线曲目 + 本机已不存在的本地文件）
    pub skipped: u32,
}

/// `.json` 解析结果：曲目与"丢了几首"。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonPreview {
    pub name: String,
    pub exported_at: u64,
    pub tracks: Vec<Track>,
    /// 丢弃的条目数（本地文件在本机不存在 / 缺 id 或标题）
    pub skipped: u32,
}

/// 歌单名 → 安全的文件名主干。
///
/// Windows 非法字符（`\ / : * ? " < > |`）与控制字符一律换成 `_`，再收掉首尾的
/// 空格与点（结尾点会让资源管理器建不出文件），空名回落到"歌单"。
fn safe_file_name(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    // 连续的下划线收成一个：`a/b` 与 `a_b` 撞名时肉眼还能分辨
    while out.contains("__") {
        out = out.replace("__", "_");
    }
    let trimmed = out.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        return "歌单".to_string();
    }
    // 按字符截断，别把多字节汉字切一半
    if trimmed.chars().count() > MAX_STEM {
        return trimmed.chars().take(MAX_STEM).collect();
    }
    trimmed.to_string()
}

/// 同目录重名时避让：`名字.json` 已存在就退到 `名字 (2).json`。
fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() {
        return first;
    }
    for n in 2..1000 {
        let candidate = dir.join(format!("{stem} ({n}).{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    // 1000 份同名文件堆在一个目录里已经不是正常用法了，直接覆盖第一份
    first
}

/// 取歌单名（本地自建歌单在 `playlists` 表里，在线收藏的卡片在 `liked_playlists`
/// —— 但导出只对本地歌单开放，这里也只认前者）。
fn playlist_name(
    conn: &rusqlite::Connection,
    pid: &str,
) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row("SELECT name FROM playlists WHERE pid = ?1", params![pid], |r| {
        r.get::<_, String>(0)
    })
    .optional()
}

/// 本地曲目在本机的真实路径。
///
/// `local_path` 是扫描器写的权威值（清缺失记录按它匹配）；老数据里可能为空，
/// 这时回落到 `Track.id`（本地曲目的 id 本来就是绝对路径）。
fn local_path_of(
    conn: &rusqlite::Connection,
    track: &Track,
) -> Result<Option<String>, rusqlite::Error> {
    if !track.platform.is_local() {
        return Ok(None);
    }
    let id = store::db_track_id(track);
    let stored: Option<String> = conn
        .query_row(
            "SELECT local_path FROM tracks WHERE id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let path = stored
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| track.id.clone());
    Ok(Some(path))
}

/// 一首曲目 → m3u8 的 `#EXTINF` 行。时长取整秒（m3u8 的 EXTINF 单位就是秒），
/// 歌手为空时只写标题，别留下 `" - 标题"` 这种尾巴。
fn extinf(track: &Track) -> String {
    let label = if track.singer.trim().is_empty() {
        track.title.clone()
    } else {
        format!("{} - {}", track.singer, track.title)
    };
    format!("#EXTINF:{},{label}", track.duration.max(0.0).round() as i64)
}

/// 导出歌单到 `dir`：写 `.json`（必有）与 `.m3u8`（有本地文件条目才写）。
///
/// 目录必须已存在 —— 前端走系统目录选择框，拿到的一定是真实目录；这里不
/// `create_dir_all`，免得把打错的路径变出一串空目录。
pub fn export(db: &Database, pid: &str, dir: &Path) -> Result<ExportSummary, String> {
    if !dir.is_dir() {
        return Err(format!("导出目录不存在：{}", dir.display()));
    }
    let (name, tracks, paths) = db
        .with(|conn| {
            let name = playlist_name(conn, pid)?;
            let tracks = store::get_playlist_tracks(conn, pid)?;
            let mut paths = Vec::with_capacity(tracks.len());
            for t in &tracks {
                paths.push(local_path_of(conn, t)?);
            }
            Ok((name, tracks, paths))
        })
        .map_err(|e| format!("读取歌单失败：{e}"))?;
    let Some(name) = name else {
        return Err("歌单不存在（可能已被删除）".to_string());
    };

    let stem = safe_file_name(&name);
    // m3u8 条目：只有"本地 + 文件还在"的曲目能写
    let mut m3u8_lines = vec!["#EXTM3U".to_string()];
    let mut local = 0u32;
    let mut skipped = 0u32;
    for (t, p) in tracks.iter().zip(paths.iter()) {
        match p {
            // M3U8 没有通用的子轨区间语义；分轨完整保存在 JSON 中。
            Some(path) if t.start_ms.is_none() && t.end_ms.is_none() && Path::new(path).is_file() => {
                m3u8_lines.push(extinf(t));
                m3u8_lines.push(path.clone());
                local += 1;
            }
            // 在线曲目，或本机已经不存在的本地文件（后者也算"跳过"，一起报数）
            _ => skipped += 1,
        }
    }

    let json_path = unique_path(dir, &stem, "json");
    let total = tracks.len() as u32;
    let file = PlaylistFile::new(&name, tracks);
    let body = serde_json::to_string_pretty(&file).map_err(|e| format!("歌单序列化失败：{e}"))?;
    std::fs::write(&json_path, body)
        .map_err(|e| format!("写入 {} 失败：{e}", json_path.display()))?;

    // 一首本地文件都没有就不留空 m3u8：一个只有 `#EXTM3U` 的文件对任何播放器
    // 都是"这份歌单是空的"，比"没有这个文件"更误导
    let m3u8_path = if local > 0 {
        let path = unique_path(dir, &stem, "m3u8");
        let mut body = m3u8_lines.join("\r\n");
        body.push_str("\r\n");
        std::fs::write(&path, body).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
        Some(path)
    } else {
        None
    };

    Ok(ExportSummary {
        name,
        json_path: json_path.to_string_lossy().into_owned(),
        m3u8_path: m3u8_path.map(|p| p.to_string_lossy().into_owned()),
        total,
        local,
        skipped,
    })
}

/// 读回 `.json` 歌单文件（导入前的第一步：先解析并校验，再由前端选目标歌单）。
///
/// 本机不存在的本地文件条目在这里就丢掉并计数：跨设备导入时那些路径必然失效，
/// 留着只会变成一堆点了没反应的死行。
pub fn read_json(path: &Path) -> Result<JsonPreview, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
    let file: PlaylistFile = serde_json::from_str(&text)
        .map_err(|e| format!("这不是本应用导出的歌单文件（解析失败：{e}）"))?;
    if file.kind != KIND {
        return Err("这不是本应用导出的歌单文件（缺少 quietmusic-playlist 标记）".to_string());
    }
    if file.version > VERSION {
        return Err(format!(
            "歌单文件版本过高（v{}，本机支持 v{VERSION}），请先升级客户端",
            file.version
        ));
    }
    let mut tracks = Vec::with_capacity(file.tracks.len());
    let mut skipped = 0u32;
    for t in file.tracks {
        if t.id.trim().is_empty() || t.title.trim().is_empty() {
            skipped += 1;
            continue;
        }
        if t.platform.is_local() && !Path::new(crate::cue::strip_cue_suffix(&t.id)).is_file() {
            skipped += 1;
            continue;
        }
        tracks.push(t);
    }
    let name = {
        let n = file.name.trim();
        if n.is_empty() {
            path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "导入的歌单".to_string())
        } else {
            n.to_string()
        }
    };
    Ok(JsonPreview {
        name,
        exported_at: file.exported_at,
        tracks,
        skipped,
    })
}

/// 将预览的本地条目补入新库，再走既有歌单关系写入；预览本身不改数据库。
/// 只插入尚不存在的行，避免歌单文件覆盖已扫描的标签、CUE 来源与区间。
/// 传入的分轨可能只是专辑的一部分，因此这里不做整张 CUE 的缺失对账。
pub fn add_imported_tracks(
    conn: &rusqlite::Connection,
    pid: &str,
    tracks: &[Track],
) -> Result<usize, rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    let now = (crate::db::health::unix_now() as i64).saturating_mul(1000);
    let mut accepted = Vec::with_capacity(tracks.len());
    for track in tracks {
        if track.platform.is_local() {
            let path = Path::new(crate::cue::strip_cue_suffix(&track.id));
            if !path.is_absolute() || !path.is_file() || !crate::local::is_audio_file(path) {
                continue;
            }
            let valid_interval = match (track.start_ms, track.end_ms) {
                (Some(start), Some(end)) => end > start && i64::try_from(end).is_ok(),
                (Some(start), None) => i64::try_from(start).is_ok(),
                (None, Some(_)) => false,
                (None, None) => path.to_string_lossy() == track.id,
            };
            if !valid_interval || !track.duration.is_finite() || track.duration < 0.0 {
                continue;
            }
            let metadata = std::fs::metadata(path).ok();
            let file_size = metadata.as_ref().map(|m| m.len().min(i64::MAX as u64) as i64);
            let mtime = metadata.and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs().min(i64::MAX as u64) as i64);
            tx.execute(
                "INSERT INTO tracks (id, platform, title, singer, album, pic_url, duration_ms,
                                     music_id, local_path, file_size, format, mtime, missing,
                                     start_ms, end_ms, created_at, updated_at)
                 VALUES (?1, 'local', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0,
                         ?12, ?13, ?14, ?14)
                 ON CONFLICT(id) DO NOTHING",
                params![store::db_track_id(track), track.title, track.singer, track.album,
                        track.pic_url, (track.duration * 1000.0) as i64, track.music_id,
                        path.to_string_lossy(), file_size,
                        path.extension().and_then(|s| s.to_str()).unwrap_or_default().to_lowercase(),
                        mtime, track.start_ms.map(|v| v as i64), track.end_ms.map(|v| v as i64), now],
            )?;
        }
        accepted.push(track.clone());
    }
    let added = store::add_tracks_to_playlist(&tx, pid, &accepted)?;
    tx.commit()?;
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::types::SourceId;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "quietmusic-playlist-{tag}-{}-{}",
            std::process::id(),
            fastrand::u64(..)
        ));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    fn online_track(id: &str, title: &str) -> Track {
        Track {
            id: id.to_string(),
            platform: SourceId::new("qq"),
            title: title.to_string(),
            singer: "周杰伦".to_string(),
            album: "叶惠美".to_string(),
            pic_url: String::new(),
            duration: 269.0,
            music_id: None,
            start_ms: None,
            end_ms: None,
        }
    }

    fn local_track(path: &Path, title: &str) -> Track {
        Track {
            id: path.to_string_lossy().into_owned(),
            platform: SourceId::local(),
            title: title.to_string(),
            singer: String::new(),
            album: String::new(),
            pic_url: String::new(),
            duration: 30.0,
            music_id: None,
            start_ms: None,
            end_ms: None,
        }
    }

    /// 建一个本地歌单并塞进给定曲目，返回 pid。
    fn seed(db: &Database, name: &str, tracks: &[Track]) -> String {
        db.with(|c| {
            let pid = store::create_playlist(c, name)?;
            store::add_tracks_to_playlist(c, &pid, tracks)?;
            Ok(pid)
        })
        .expect("建歌单")
    }

    /// 本地曲目要先在 `tracks` 表里有行（`add_tracks_to_playlist` 对本地条目
    /// 只查存在、不代插入），并且真实文件得在盘上，否则导出会按"文件没了"跳过。
    fn seed_local_file(db: &Database, dir: &Path, stem: &str) -> PathBuf {
        let path = dir.join(stem);
        std::fs::write(&path, b"fake-audio").expect("写假音频");
        db.with(|c| {
            c.execute(
                "INSERT OR REPLACE INTO tracks
                   (id, platform, title, singer, album, local_path, duration_ms,
                    created_at, updated_at)
                 VALUES (?1, 'local', ?2, '', '', ?3, 30000, 1, 1)",
                params![
                    format!("local:{}", path.to_string_lossy()),
                    "本地曲",
                    path.to_string_lossy()
                ],
            )
        })
        .expect("写本地曲目行");
        path
    }

    #[test]
    fn safe_file_name_strips_illegal_chars_and_falls_back() {
        assert_eq!(safe_file_name("我的/歌单:2026"), "我的_歌单_2026");
        assert_eq!(safe_file_name("  ..  "), "歌单");
        assert_eq!(safe_file_name(""), "歌单");
        // 多字节不会被切一半
        let long = safe_file_name(&"长".repeat(200));
        assert_eq!(long.chars().count(), MAX_STEM);
    }

    #[test]
    fn export_writes_json_plus_m3u8_only_for_local_entries() {
        let dir = temp_dir("export");
        let db = Database::open(&dir.join("music.db")).expect("建库");
        let audio = seed_local_file(&db, &dir, "本地曲.flac");
        let pid = seed(
            &db,
            "我的/歌单",
            &[online_track("a1", "晴天"), local_track(&audio, "本地曲")],
        );

        let out = export(&db, &pid, &dir).expect("导出");
        assert_eq!(out.name, "我的/歌单");
        assert_eq!(out.total, 2);
        assert_eq!(out.local, 1);
        assert_eq!(out.skipped, 1);
        // 文件名被净化，别在 Windows 上建出二级路径
        assert!(out.json_path.ends_with("我的_歌单.json"), "{}", out.json_path);

        let json = std::fs::read_to_string(&out.json_path).expect("读 json");
        let parsed: PlaylistFile = serde_json::from_str(&json).expect("解析 json");
        assert_eq!(parsed.kind, KIND);
        assert_eq!(parsed.version, VERSION);
        assert_eq!(parsed.tracks.len(), 2);
        assert_eq!(parsed.tracks[0].title, "晴天");

        let m3u8_path = out.m3u8_path.clone().expect("有本地条目就该写 m3u8");
        let m3u8 = std::fs::read_to_string(&m3u8_path).expect("读 m3u8");
        assert!(m3u8.starts_with("#EXTM3U"));
        assert!(
            m3u8.contains(&audio.to_string_lossy().into_owned()),
            "{m3u8}"
        );
        assert!(m3u8.contains("#EXTINF:30,本地曲"), "{m3u8}");
        // 在线曲目不进 m3u8（过期地址写进去只会误导播放器）
        assert!(!m3u8.contains("晴天"), "{m3u8}");
    }

    #[test]
    fn cue_json_preserves_interval_and_m3u8_does_not_export_whole_album() {
        let dir = temp_dir("cue-export");
        let db = Database::open(&dir.join("music.db")).expect("建库");
        let audio = seed_local_file(&db, &dir, "专辑.flac");
        let mut cue = local_track(&audio, "第二首");
        cue.id.push_str("#cue:2");
        cue.start_ms = Some(60_000);
        cue.end_ms = Some(90_000);
        db.with(|c| c.execute(
            "INSERT INTO tracks (id, platform, title, singer, album, local_path, duration_ms,
                                 start_ms, end_ms, created_at, updated_at)
             VALUES (?1, 'local', '第二首', '', '', ?2, 30000, 60000, 90000, 1, 1)",
            params![store::db_track_id(&cue), audio.to_string_lossy()],
        )).unwrap();
        let pid = seed(&db, "分轨歌单", std::slice::from_ref(&cue));
        let out = export(&db, &pid, &dir).unwrap();
        assert_eq!(out.total, 1);
        assert_eq!(out.local, 0);
        assert_eq!(out.skipped, 1);
        assert!(out.m3u8_path.is_none());
        let preview = read_json(Path::new(&out.json_path)).unwrap();
        assert_eq!(preview.skipped, 0);
        assert_eq!(preview.tracks.len(), 1);
        let got = &preview.tracks[0];
        assert_eq!(got.id, cue.id);
        assert_eq!(got.start_ms, Some(60_000));
        assert_eq!(got.end_ms, Some(90_000));
        assert_eq!(got.duration, 30.0);

        // 新库尚未扫描音频也能真正加入歌单，区间不只停留在预览里。
        let fresh = Database::open(&dir.join("fresh.db")).unwrap();
        fresh.with(|c| {
            let pid = store::create_playlist(c, "导入分轨")?;
            assert_eq!(add_imported_tracks(c, &pid, &preview.tracks)?, 1);
            assert_eq!(add_imported_tracks(c, &pid, &preview.tracks)?, 0);
            let restored = store::get_playlist_tracks(c, &pid)?;
            assert_eq!(restored.len(), 1);
            assert_eq!(restored[0].id, cue.id);
            assert_eq!(restored[0].start_ms, Some(60_000));
            assert_eq!(restored[0].end_ms, Some(90_000));
            let physical: String = c.query_row("SELECT local_path FROM tracks WHERE id = ?1",
                params![store::db_track_id(&cue)], |r| r.get(0))?;
            assert_eq!(physical, audio.to_string_lossy());
            Ok(())
        }).unwrap();
    }

    #[test]
    fn import_does_not_replace_scanned_intervals_or_accept_invalid_bounds() {
        let dir = temp_dir("cue-import-validation");
        let db = Database::open(&dir.join("music.db")).unwrap();
        let audio = seed_local_file(&db, &dir, "整轨.flac");
        let mut invalid = local_track(&audio, "区间错误");
        invalid.id.push_str("#cue:1");
        invalid.start_ms = Some(90_000);
        invalid.end_ms = Some(60_000);
        db.with(|c| {
            let pid = store::create_playlist(c, "验证导入")?;
            assert_eq!(add_imported_tracks(c, &pid, &[invalid])?, 0);
            let original = local_track(&audio, "本地曲");
            let mut changed = original.clone();
            changed.duration = 999.0;
            assert_eq!(add_imported_tracks(c, &pid, &[changed])?, 1);
            let duration: i64 = c.query_row("SELECT duration_ms FROM tracks WHERE id = ?1",
                params![store::db_track_id(&original)], |r| r.get(0))?;
            assert_eq!(duration, 30_000);
            Ok(())
        }).unwrap();
    }

    #[test]
    fn export_skips_m3u8_when_nothing_is_local() {
        let dir = temp_dir("online-only");
        let db = Database::open(&dir.join("music.db")).expect("建库");
        let pid = seed(
            &db,
            "全是网络歌",
            &[online_track("a1", "甲"), online_track("a2", "乙")],
        );

        let out = export(&db, &pid, &dir).expect("导出");
        assert!(out.m3u8_path.is_none(), "没有本地条目就不该留空 m3u8");
        assert_eq!(out.local, 0);
        assert_eq!(out.skipped, 2);
        assert!(Path::new(&out.json_path).is_file());
    }

    #[test]
    fn export_avoids_overwriting_a_previous_export() {
        let dir = temp_dir("twice");
        let db = Database::open(&dir.join("music.db")).expect("建库");
        let pid = seed(&db, "重复导出", &[online_track("a1", "甲")]);

        let first = export(&db, &pid, &dir).expect("第一次");
        let second = export(&db, &pid, &dir).expect("第二次");
        assert_ne!(first.json_path, second.json_path);
        assert!(
            second.json_path.ends_with("重复导出 (2).json"),
            "{}",
            second.json_path
        );
        assert!(Path::new(&first.json_path).is_file(), "第一份不能被覆盖掉");
    }

    #[test]
    fn read_json_round_trips_an_exported_playlist() {
        let dir = temp_dir("roundtrip");
        let db = Database::open(&dir.join("music.db")).expect("建库");
        let audio = seed_local_file(&db, &dir, "回环.flac");
        let pid = seed(
            &db,
            "回环歌单",
            &[online_track("a1", "晴天"), local_track(&audio, "回环")],
        );
        let out = export(&db, &pid, &dir).expect("导出");

        let preview = read_json(Path::new(&out.json_path)).expect("读回");
        assert_eq!(preview.name, "回环歌单");
        assert_eq!(preview.tracks.len(), 2, "本机存在的本地条目要保留");
        assert_eq!(preview.skipped, 0);
        assert_eq!(preview.tracks[1].platform, SourceId::local());
    }

    #[test]
    fn read_json_drops_local_entries_missing_on_this_machine() {
        let dir = temp_dir("cross-device");
        let file = PlaylistFile::new(
            "别人机器上的歌单",
            vec![
                online_track("a1", "晴天"),
                local_track(&dir.join("不存在.flac"), "别人机器上的本地曲"),
            ],
        );
        let path = dir.join("foreign.json");
        std::fs::write(&path, serde_json::to_string_pretty(&file).unwrap()).expect("写 json");

        let preview = read_json(&path).expect("读回");
        assert_eq!(preview.tracks.len(), 1);
        assert_eq!(preview.skipped, 1);
        assert_eq!(preview.tracks[0].title, "晴天");
    }

    #[test]
    fn read_json_rejects_foreign_and_broken_files() {
        let dir = temp_dir("reject");
        let broken = dir.join("broken.json");
        std::fs::write(&broken, "not json at all").expect("写坏文件");
        let err = read_json(&broken).expect_err("坏文件该报错");
        assert!(err.contains("不是本应用导出的歌单文件"), "{err}");

        let foreign = dir.join("foreign.json");
        std::fs::write(&foreign, r#"{"hello":1}"#).expect("写外来文件");
        let err = read_json(&foreign).expect_err("外来文件该报错");
        assert!(err.contains("不是本应用导出的歌单文件"), "{err}");

        // 版本比本机高：宁可报错，也不要"读进来一半"再悄悄丢字段
        let future = dir.join("future.json");
        std::fs::write(
            &future,
            format!(
                r#"{{"kind":"{KIND}","version":{},"name":"未来","tracks":[]}}"#,
                VERSION + 1
            ),
        )
        .expect("写未来版本");
        let err = read_json(&future).expect_err("高版本该报错");
        assert!(err.contains("版本过高"), "{err}");

        let missing = dir.join("nope.json");
        let err = read_json(&missing).expect_err("文件不存在该报错");
        assert!(err.contains("读取"), "{err}");
    }
}
