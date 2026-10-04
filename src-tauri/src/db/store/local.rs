//! 本地音乐库域（DESIGN §13）：本地曲目入库 / 缺失标记 / 删除 + 扫描目录清单。
//!
//! 拆自原 `db/store.rs`（P2-7），函数体与 SQL 一行未改。
//! 本地曲目与在线曲目共用 `tracks` 表，但写入方（扫描器）与生命周期（磁盘文件
//! 可能消失）都不同，所以单独成域：这里的函数只被本地扫描 / 本地曲库界面调用。

use std::collections::HashSet;

use rusqlite::{params, Connection};

use crate::provider::types::{SourceId, Track};

// 跨域共享的小工具（`db_track_id` / `now_ms` / `track_from_row` / `LOCAL_PLATFORM` …）
// 由 store/mod.rs 统一再导出，这里一次性引入，省得每个域各写一长串 use。
use super::*;
// ---------- 本地音乐库（DESIGN §13） ----------
//
// `upsert_tracks` 显式跳过 SourceId::Local（本地曲目由扫描器负责），本节即为该扫描器的落库端。
// 约定（与 §13 一致）：Track.id = 音频文件绝对路径，db 主键 = `local:<绝对路径>`
// （见 `db_track_id`）；`local_path` 同步写入，便于按目录范围做缺失标记。

/// 本地曲目入库行（`local::scan_dirs` 的产物）。
#[derive(Debug, Clone)]
pub struct LocalTrackRow {
    /// 文件绝对路径，同时作为 `Track.id`
    pub path: String,
    pub title: String,
    pub singer: String,
    pub album: String,
    pub duration_ms: i64,
    pub file_size: i64,
    /// epoch 秒
    pub mtime: i64,
    /// 小写扩展名，如 "mp3"
    pub format: String,
}

/// 本地曲目入库/更新（§13.2 要点 4「新文件插入」/ 要点 5「老文件恢复，取消缺失标记」）。
/// 重复扫描按主键 `ON CONFLICT DO UPDATE`，不会产生重复行。
pub fn upsert_local_tracks(
    conn: &Connection,
    rows: &[LocalTrackRow],
) -> Result<(), rusqlite::Error> {
    let now = now_ms();
    let tx = conn.unchecked_transaction()?;
    for r in rows {
        tx.execute(
            "INSERT INTO tracks (id, platform, title, singer, album, pic_url, duration_ms,
                                 music_id, local_path, file_size, format, mtime, missing,
                                 created_at, updated_at)
             VALUES (?1, 'local', ?2, ?3, ?4, NULL, ?5, NULL, ?6, ?7, ?8, ?9, 0, ?10, ?10)
             ON CONFLICT(id) DO UPDATE SET
               title       = excluded.title,
               singer      = excluded.singer,
               album       = excluded.album,
               duration_ms = excluded.duration_ms,
               local_path  = excluded.local_path,
               file_size   = excluded.file_size,
               format      = excluded.format,
               mtime       = excluded.mtime,
               missing     = 0,
               updated_at  = excluded.updated_at",
            params![
                format!("local:{}", r.path),
                r.title,
                r.singer,
                r.album,
                r.duration_ms,
                r.path,
                r.file_size,
                r.format,
                r.mtime,
                now,
            ],
        )?;
    }
    tx.commit()
}

/// 标记缺失（§13.2 要点 1）：扫描目录范围内、本次未命中的本地记录置 `missing = 1`。
/// 范围外的记录（未纳入本次扫描的目录）保持原状。返回被标记的行数。
pub fn mark_missing_local_tracks(
    conn: &Connection,
    dirs: &[String],
    present: &HashSet<String>,
) -> Result<usize, rusqlite::Error> {
    let now = now_ms();
    let mut stmt = conn.prepare(
        "SELECT local_path FROM tracks
         WHERE platform = 'local' AND local_path IS NOT NULL AND missing = 0",
    )?;
    let stale: Vec<String> = stmt
        .query_map([], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .filter(|path: &String| !present.contains(path) && under_any_dir(path, dirs))
        .collect();
    drop(stmt);

    let mut marked = 0usize;
    for path in &stale {
        marked += conn.execute(
            "UPDATE tracks SET missing = 1, updated_at = ?1 WHERE local_path = ?2",
            params![now, path],
        )?;
    }
    Ok(marked)
}

/// 读库内本地曲目（不扫磁盘）；`missing = 1` 的记录不返回。
pub fn query_local_tracks(conn: &Connection) -> Result<Vec<Track>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, title, singer, album, duration_ms, music_id
         FROM tracks
         WHERE platform = 'local' AND missing = 0
         ORDER BY title COLLATE NOCASE, singer COLLATE NOCASE",
    )?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let db_id: String = row.get(0)?;
        out.push(Track {
            id: strip_local_prefix(&db_id),
            platform: SourceId::local(),
            title: row.get(1)?,
            singer: row.get(2)?,
            album: row.get(3)?,
            pic_url: String::new(),
            duration: row.get::<_, Option<i64>>(4)?.unwrap_or(0) as f64 / 1000.0,
            music_id: row.get(5)?,
        });
    }
    Ok(out)
}

/// 本地曲目文件属性（大小 / 修改时间），供本地曲库按「大小 / 修改时间」排序。
/// `id` 与 `query_local_tracks` 产出的 `Track.id`（即文件绝对路径）一致，前端据此合并。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTrackFileMeta {
    pub id: String,
    pub file_size: i64,
    pub mtime: i64,
}

/// 读库内本地曲目的文件大小与修改时间（不扫磁盘）。
pub fn query_local_track_files(
    conn: &Connection,
) -> Result<Vec<LocalTrackFileMeta>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, file_size, mtime
         FROM tracks
         WHERE platform = 'local' AND missing = 0",
    )?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let db_id: String = row.get(0)?;
        let file_size: i64 = row.get(1)?;
        let mtime: i64 = row.get(2)?;
        out.push(LocalTrackFileMeta {
            id: strip_local_prefix(&db_id),
            file_size,
            mtime,
        });
    }
    Ok(out)
}

/// 读缺失的本地曲目（扫描时未命中、文件已不在），供本地曲库「体检」列表用。
/// `Track.id` 仍是原文件路径，前端可直接展示。
pub fn query_missing_local_tracks(conn: &Connection) -> Result<Vec<Track>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, title, singer, album, duration_ms, music_id
         FROM tracks
         WHERE platform = 'local' AND missing = 1
         ORDER BY title COLLATE NOCASE, singer COLLATE NOCASE",
    )?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let db_id: String = row.get(0)?;
        out.push(Track {
            id: strip_local_prefix(&db_id),
            platform: SourceId::local(),
            title: row.get(1)?,
            singer: row.get(2)?,
            album: row.get(3)?,
            pic_url: String::new(),
            duration: row.get::<_, Option<i64>>(4)?.unwrap_or(0) as f64 / 1000.0,
            music_id: row.get(5)?,
        });
    }
    Ok(out)
}

/// 清理所有缺失的本地记录（连带级联删除歌单归属等关联行）。返回删除条数。
pub fn purge_missing_local_tracks(conn: &Connection) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "DELETE FROM tracks WHERE platform = 'local' AND missing = 1",
        [],
    )
}

/// 删本地记录的 SQL：优先按 `local_path` 匹配，老数据没写 `local_path` 时回退到主键
/// `local:<path>`。本地曲目的 `local_path` 与 `id` 都唯一，不会误伤其它行。
const DELETE_LOCAL_TRACK_SQL: &str =
    "DELETE FROM tracks WHERE platform = 'local' AND (local_path = ?1 OR id = ?2)";

/// 删除一条本地曲目记录（连带级联删除歌单归属 / 收藏 / 历史等关联行）。
/// 返回删除条数（0 表示该路径不在库里）。**不动磁盘文件**。
pub fn delete_local_track(conn: &Connection, path: &str) -> Result<usize, rusqlite::Error> {
    conn.execute(
        DELETE_LOCAL_TRACK_SQL,
        params![path, format!("local:{path}")],
    )
}

/// 批量删除本地记录（单事务，返回删除条数），供列表多选删除用。
/// 语义与 `delete_local_track` 一致：只删记录，不动磁盘文件。
pub fn delete_local_tracks(conn: &Connection, paths: &[String]) -> Result<usize, rusqlite::Error> {
    if paths.is_empty() {
        return Ok(0);
    }
    let tx = conn.unchecked_transaction()?;
    let mut removed = 0usize;
    for path in paths {
        removed += tx.execute(
            DELETE_LOCAL_TRACK_SQL,
            params![path, format!("local:{path}")],
        )?;
    }
    tx.commit()?;
    Ok(removed)
}

/// 扫描目录清单（scan_dirs 表，§13.1「读取启用目录」）。
pub fn list_scan_dirs(conn: &Connection) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT path FROM scan_dirs ORDER BY created_at, path")?;
    let out = stmt
        .query_map([], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(out)
}

/// 新增/刷新扫描目录（幂等：path 上建有 UNIQUE 索引）。
pub fn add_scan_dir(conn: &Connection, path: &str) -> Result<(), rusqlite::Error> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO scan_dirs (id, path, enabled, last_scan_at, created_at)
         VALUES (?1, ?1, 1, ?2, ?2)
         ON CONFLICT(path) DO UPDATE SET last_scan_at = excluded.last_scan_at",
        params![path, now],
    )?;
    Ok(())
}

/// 批量刷新 last_scan_at（一次扫描涉及多个目录时复用 `add_scan_dir` 的语义）。
pub fn touch_scan_dirs(conn: &Connection, dirs: &[String]) -> Result<(), rusqlite::Error> {
    for dir in dirs {
        add_scan_dir(conn, dir)?;
    }
    Ok(())
}

/// 移除扫描目录。只删清单条目，不删已入库曲目（避免误删用户数据）。
pub fn remove_scan_dir(conn: &Connection, path: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM scan_dirs WHERE path = ?1", params![path])?;
    Ok(())
}

/// `local:<路径>` → `<路径>`（脏数据原样返回）。
fn strip_local_prefix(db_id: &str) -> String {
    db_id.strip_prefix("local:").unwrap_or(db_id).to_string()
}

/// 路径是否落在任一扫描目录下（路径比较统一按 `/`、大小写不敏感，兼容 Windows 盘符大小写）。
fn under_any_dir(path: &str, dirs: &[String]) -> bool {
    dirs.iter().any(|dir| is_under_dir(path, dir))
}

fn is_under_dir(path: &str, dir: &str) -> bool {
    let dir = dir.trim_end_matches(['/', '\\']);
    if dir.is_empty() {
        return false;
    }
    let path = path.replace('\\', "/");
    let dir = dir.replace('\\', "/");
    let (path, dir) = (path.to_lowercase(), dir.to_lowercase());
    path.strip_prefix(&dir)
        .is_some_and(|rest| rest.starts_with('/'))
}
