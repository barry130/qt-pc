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
    /// Stable local Track.id: physical path, or `<path>#cue:<number>`.
    pub id: String,
    /// Physical audio path (shared by all CUE subtracks).
    pub path: String,
    pub cue_path: Option<String>,
    pub start_ms: Option<u64>,
    pub end_ms: Option<u64>,
    pub title: String,
    pub singer: String,
    pub album: String,
    pub duration_ms: i64,
    pub file_size: i64,
    /// epoch 秒
    pub mtime: i64,
    /// 小写扩展名，如 "mp3"
    pub format: String,
    /// 内嵌歌词（ID3v2 USLT / Vorbis LYRICS）。**不是 tracks 表的列**：扫描器读标签时
    /// 顺手带出来的中间产物，由 `library_scan` 落进 `lyrics` 表，写完即弃。
    pub embedded_lyric: Option<String>,
    /// ReplayGain 单曲增益（dB，`REPLAYGAIN_TRACK_GAIN`）。没写标签 = None。
    ///
    /// 这三列**允许为空且不回填**：存量库里的老曲目要等文件 mtime 变了（重新扫描
    /// 命中更新的那支分支）或整库重扫才会补上；没有增益的歌照样正常播放。
    pub track_gain_db: Option<f32>,
    /// ReplayGain 单曲峰值（线性振幅，`REPLAYGAIN_TRACK_PEAK`），用于给增益封顶。
    pub track_peak: Option<f32>,
    /// ReplayGain 专辑增益（dB，`REPLAYGAIN_ALBUM_GAIN`）。
    pub album_gain_db: Option<f32>,
    /// 流派（标签 `TCON` / Vorbis `GENRE`），智能歌单（A5）按它筛选。
    pub genre: Option<String>,
    /// 四位年份（标签 `DATE` 等），智能歌单按它筛选。
    pub year: Option<i64>,
    /// 速度（BPM，标签 `TBPM` / Vorbis `BPM`）。读不到标签 = None（库里落 0）。
    pub bpm: Option<i64>,
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
        if r.cue_path.is_some() {
            // Keep references/history intact while retiring the duplicate album.
            tx.execute(
                "UPDATE tracks SET missing = 1, updated_at = ?1
                 WHERE id = ?2 AND platform = 'local' AND start_ms IS NULL",
                params![now, format!("local:{}", r.path)],
            )?;
        }
        tx.execute(
            "INSERT INTO tracks (id, platform, title, singer, album, pic_url, duration_ms,
                                 music_id, local_path, file_size, format, mtime, missing,
                                 created_at, updated_at, start_ms, end_ms, cue_path,
                                 track_gain_db, track_peak, album_gain_db, genre, year, bpm)
             VALUES (?1, 'local', ?2, ?3, ?4, NULL, ?5, NULL, ?6, ?7, ?8, ?9, 0, ?10, ?10, ?11, ?12, ?13,
                     ?14, ?15, ?16, ?17, ?18, ?19)
             ON CONFLICT(id) DO UPDATE SET
               title       = excluded.title,
               singer      = excluded.singer,
               album       = excluded.album,
               duration_ms = excluded.duration_ms,
               local_path  = excluded.local_path,
               file_size   = excluded.file_size,
               format      = excluded.format,
               mtime       = excluded.mtime,
               start_ms    = excluded.start_ms,
               end_ms      = excluded.end_ms,
               cue_path    = excluded.cue_path,
               -- 增益随文件标签走：重新扫描时标签改了要跟着改，没标签（NULL）也照写，
               -- 免得删掉标签后旧增益还留在库里。
               track_gain_db = excluded.track_gain_db,
               track_peak    = excluded.track_peak,
               album_gain_db = excluded.album_gain_db,
               -- 流派/年份同理（智能歌单的筛选字段，标签改了要跟着变）
               genre       = excluded.genre,
               year        = excluded.year,
               bpm         = excluded.bpm,
               missing     = 0,
               updated_at  = excluded.updated_at",
            params![
                format!("local:{}", r.id),
                r.title,
                r.singer,
                r.album,
                r.duration_ms,
                r.path,
                r.file_size,
                r.format,
                r.mtime,
                now,
                r.start_ms.and_then(|v| i64::try_from(v).ok()),
                r.end_ms.and_then(|v| i64::try_from(v).ok()),
                r.cue_path,
                r.track_gain_db,
                r.track_peak,
                r.album_gain_db,
                r.genre,
                r.year,
                // bpm 列 NOT NULL，未知统一落 0（见 V24 注释）
                r.bpm.unwrap_or(0),
            ],
        )?;
    }
    tx.commit()
}

/// 带 ReplayGain 的本地曲目（播放时用的内存查表来源，A1）。
#[derive(Debug, Clone)]
pub struct LocalGainRow {
    /// `tracks.id`，即 `local:<路径>`（与 [`db_track_id`] 同口径）
    pub key: String,
    pub track_gain_db: Option<f32>,
    pub track_peak: Option<f32>,
    pub album_gain_db: Option<f32>,
}

/// 读出库里所有带增益的曲目。
///
/// 只查三列非空的行：正经打标过的本地库通常是几百到几千首，一次全读进内存
/// （播放时按曲目键查表，不碰数据库 —— 音频线程不做 IO）。
pub fn list_replay_gains(conn: &Connection) -> Result<Vec<LocalGainRow>, rusqlite::Error> {
    let mut statement = conn.prepare(
        "SELECT id, track_gain_db, track_peak, album_gain_db FROM tracks
         WHERE track_gain_db IS NOT NULL OR album_gain_db IS NOT NULL OR track_peak IS NOT NULL",
    )?;
    let rows = statement.query_map([], |r| {
        Ok(LocalGainRow {
            key: r.get::<_, String>(0)?,
            track_gain_db: r.get::<_, Option<f64>>(1)?.map(|v| v as f32),
            track_peak: r.get::<_, Option<f64>>(2)?.map(|v| v as f32),
            album_gain_db: r.get::<_, Option<f64>>(3)?.map(|v| v as f32),
        })
    })?;
    rows.collect()
}

/// Retire old children after a complete CUE sheet was rescanned/opened. Call once
/// after all upsert chunks; a chunk alone cannot prove a sibling is absent.
pub fn reconcile_local_cue_tracks(
    conn: &Connection,
    rows: &[LocalTrackRow],
) -> Result<usize, rusqlite::Error> {
    let present: HashSet<String> = rows.iter().map(|r| format!("local:{}", r.id)).collect();
    let sheets: HashSet<&str> = rows.iter().filter_map(|r| r.cue_path.as_deref()).collect();
    let now = now_ms();
    let mut marked = 0;
    for cue in sheets {
        let stale = {
            let mut statement = conn.prepare(
                "SELECT id FROM tracks WHERE platform = 'local' AND cue_path = ?1 AND missing = 0",
            )?;
            let ids = statement
                .query_map(params![cue], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids
        };
        for id in stale.into_iter().filter(|id| !present.contains(id)) {
            marked += conn.execute(
                "UPDATE tracks SET missing = 1, updated_at = ?1 WHERE id = ?2",
                params![now, id],
            )?;
        }
    }
    Ok(marked)
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
        "SELECT id, local_path, cue_path FROM tracks
         WHERE platform = 'local' AND local_path IS NOT NULL AND missing = 0",
    )?;
    let stale: Vec<String> = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .filter(|(id, path, cue)| {
            !present.contains(&strip_local_prefix(id))
                && (under_any_dir(path, dirs)
                    || cue.as_ref().is_some_and(|p| under_any_dir(p, dirs)))
        })
        .map(|(id, _, _)| id)
        .collect();
    drop(stmt);

    let mut marked = 0usize;
    for id in &stale {
        marked += conn.execute(
            "UPDATE tracks SET missing = 1, updated_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
    }
    Ok(marked)
}

/// 读库内本地曲目（不扫磁盘）；`missing = 1` 的记录不返回。
pub fn query_local_tracks(conn: &Connection) -> Result<Vec<Track>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, title, singer, album, duration_ms, music_id, start_ms, end_ms
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
            start_ms: row
                .get::<_, Option<i64>>(6)?
                .and_then(|v| u64::try_from(v).ok()),
            end_ms: row
                .get::<_, Option<i64>>(7)?
                .and_then(|v| u64::try_from(v).ok()),
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
    /// 扫描时记录的小写文件扩展名；由前端按能力而非路径重新猜测音频格式。
    pub format: String,
}

/// 读库内本地曲目的文件大小与修改时间（不扫磁盘）。
pub fn query_local_track_files(
    conn: &Connection,
) -> Result<Vec<LocalTrackFileMeta>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, file_size, mtime, format
         FROM tracks
         WHERE platform = 'local' AND missing = 0",
    )?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let db_id: String = row.get(0)?;
        let file_size: i64 = row.get(1)?;
        let mtime: i64 = row.get(2)?;
        let format: String = row.get(3)?;
        out.push(LocalTrackFileMeta {
            id: strip_local_prefix(&db_id),
            file_size,
            mtime,
            format,
        });
    }
    Ok(out)
}

/// 读缺失的本地曲目（扫描时未命中、文件已不在），供本地曲库「体检」列表用。
/// `Track.id` 仍是原文件路径，前端可直接展示。
pub fn query_missing_local_tracks(conn: &Connection) -> Result<Vec<Track>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, title, singer, album, duration_ms, music_id, start_ms, end_ms
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
            start_ms: row
                .get::<_, Option<i64>>(6)?
                .and_then(|v| u64::try_from(v).ok()),
            end_ms: row
                .get::<_, Option<i64>>(7)?
                .and_then(|v| u64::try_from(v).ok()),
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
    "DELETE FROM tracks WHERE platform = 'local' AND (id = ?2 OR (local_path = ?1 AND start_ms IS NULL))";

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

/// 删除某个目录下的全部本地曲目记录（文件监听发现整目录被删 / 移走时用）。
///
/// 不用 `LIKE '前缀%'`：目录名里的 `_` / `%` 在 LIKE 里是通配符，得转义才安全；
/// `substr` 比长度没有这个问题。返回删除条数。
///
/// 盘符根（`D:\`）这种超短前缀一律不清 —— 一个外接盘临时拔掉不该清空整个盘
/// 的曲目记录，交给「文件缺失」与用户手动清理更稳。
pub fn delete_local_tracks_under(conn: &Connection, dir: &str) -> Result<usize, rusqlite::Error> {
    let trimmed = dir.trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        return Ok(0);
    }
    let prefix = format!("{trimmed}{}", std::path::MAIN_SEPARATOR);
    // substr 按字符计数（不是字节），中文目录名必须用 chars().count()
    let prefix_chars = prefix.chars().count();
    if prefix_chars <= 3 {
        log::debug!("[local] 拒绝按前缀清库（前缀过短）: {prefix}");
        return Ok(0);
    }
    conn.execute(
        "DELETE FROM tracks WHERE platform = 'local' AND substr(local_path, 1, ?1) = ?2",
        params![prefix_chars as i64, prefix],
    )
}

/// 子表里跟着曲目主键走的外键列（`FOREIGN KEY (track_id) REFERENCES tracks(id)`）。
///
/// 曲目主键是 `local:<路径>`，文件一移动主键就得跟着换；那张表的外键是
/// `ON DELETE CASCADE` 而不是 `ON UPDATE CASCADE`，所以**子表要自己改**，
/// 否则 COMMIT 时外键校验失败（详见 [`relocate_local_track`]）。
const TRACK_ID_CHILDREN: &[&str] = &[
    "playlist_tracks",
    "play_history",
    "play_stats",
    "download_tasks",
    "lyrics",
    "play_queue",
    "play_days",
];

/// 曲目文件换位置后同步库里那条记录（A11 整理执行 / 撤销都用它）。
///
/// 主键 `local:<path>` 里嵌了路径，改主键会牵动所有 `REFERENCES tracks(id)`
/// 子表，因此：
/// 1. 事务内 `PRAGMA defer_foreign_keys = ON` —— 否则改父行那一刻子表还指旧 id，
///    外键校验立刻失败（这个 pragma 只在事务内有效，见 migrations.rs 的同款注释）；
/// 2. 先改个子表的 `track_id`，再改 `tracks.id` / `local_path`，COMMIT 时校验一次。
///
/// 返回更新的曲目行数（0 = 老路径不在库里，或目标路径已被占用）。
pub fn relocate_local_track(
    conn: &Connection,
    from: &str,
    to: &str,
) -> Result<usize, rusqlite::Error> {
    let old_id = format!("local:{from}");
    let new_id = format!("local:{to}");
    if old_id == new_id {
        return Ok(0);
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch("PRAGMA defer_foreign_keys = ON;")?;
    for table in TRACK_ID_CHILDREN {
        tx.execute(
            &format!("UPDATE {table} SET track_id = ?1 WHERE track_id = ?2"),
            params![new_id, old_id],
        )?;
    }
    let moved = tx.execute(
        "UPDATE tracks SET id = ?1, local_path = ?2, missing = 0
         WHERE platform = 'local' AND id = ?3",
        params![new_id, to, old_id],
    )?;
    if moved > 0 {
        tx.commit()?;
    }
    Ok(moved)
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
    if dir == "/" {
        return path.starts_with('/');
    }
    let dir = dir.trim_end_matches(['/', '\\']);
    if dir.is_empty() {
        return false;
    }
    let path = path.replace('\\', "/");
    let dir = dir.replace('\\', "/");
    let (path, dir) = (path.to_lowercase(), dir.to_lowercase());
    path == dir
        || path
            .strip_prefix(&dir)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// 本地优先播放（DESIGN §7.13）候选池：本地曲库按元数据预筛。
///
/// K2 严格匹配（标题+歌手+时长）在 `local_first::matcher` 里做，这里只负责
/// 把候选集压小：时长已知（>0）按时长窗口 ±4s 预筛（比匹配器的 ±3s 略宽，
/// 给归一化误差留余量）；时长未知按**精确标题**兜底（LIKE 会把误配放大，
/// 宁可错过不能错放）。CUE 子轨（cue_path 非空）永远排除：替身链只接受
/// 完整文件，子轨的起止偏移属于另一个父文件，匹配上了也放不对位。
///
/// 这是 ⑤「在线歌先看本地曲库」与替身池 A 共用的同一个入口。
pub fn local_candidates_by_meta(
    conn: &Connection,
    want_title: &str,
    duration_ms: i64,
) -> Result<Vec<Track>, rusqlite::Error> {
    let (sql, params): (&str, Vec<&dyn rusqlite::ToSql>) = if duration_ms > 0 {
        (
            "SELECT id, title, singer, album, duration_ms, music_id, start_ms, end_ms
               FROM tracks
              WHERE platform = 'local' AND missing = 0 AND cue_path IS NULL
                AND duration_ms BETWEEN ?1 - 4000 AND ?1 + 4000",
            vec![&duration_ms],
        )
    } else {
        (
            "SELECT id, title, singer, album, duration_ms, music_id, start_ms, end_ms
               FROM tracks
              WHERE platform = 'local' AND missing = 0 AND cue_path IS NULL AND title = ?1",
            vec![&want_title],
        )
    };
    let mut stmt = conn.prepare(sql)?;
    let mut rows = stmt.query(params.as_slice())?;
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
            start_ms: row
                .get::<_, Option<i64>>(6)?
                .and_then(|v| u64::try_from(v).ok()),
            end_ms: row
                .get::<_, Option<i64>>(7)?
                .and_then(|v| u64::try_from(v).ok()),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::store::tests::new_conn;

    fn row(path: &str, title: &str) -> LocalTrackRow {
        LocalTrackRow {
            id: path.to_string(),
            path: path.to_string(),
            cue_path: None,
            start_ms: None,
            end_ms: None,
            title: title.to_string(),
            singer: "歌手".to_string(),
            album: "专辑".to_string(),
            duration_ms: 200_000,
            file_size: 1024,
            mtime: 1,
            format: "flac".to_string(),
            embedded_lyric: None,
            track_gain_db: None,
            track_peak: None,
            album_gain_db: None,
            genre: None,
            year: None,
            bpm: None,
        }
    }

    fn count(conn: &Connection, sql: &str, value: &str) -> i64 {
        conn.query_row(sql, params![value], |r| r.get(0)).unwrap()
    }

    #[test]
    fn bpm_column_round_trips_and_defaults_to_unknown() {
        let conn = new_conn();
        let mut with_bpm = row("D:/music/a.flac", "有速度");
        with_bpm.bpm = Some(128);
        upsert_local_tracks(&conn, &[with_bpm, row("D:/music/b.flac", "没速度")]).unwrap();

        let tagged: i64 = conn
            .query_row(
                "SELECT bpm FROM tracks WHERE title = '有速度'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tagged, 128);

        // 没标签 = 0（未知），不是 NULL：筛选 SQL 的数值比较不必到处 COALESCE
        let unknown: i64 = conn
            .query_row(
                "SELECT bpm FROM tracks WHERE title = '没速度'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(unknown, 0);

        // 重新扫描时标签改了要跟着改
        let mut again = row("D:/music/b.flac", "没速度");
        again.bpm = Some(96);
        upsert_local_tracks(&conn, &[again]).unwrap();
        let updated: i64 = conn
            .query_row(
                "SELECT bpm FROM tracks WHERE title = '没速度'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(updated, 96);
    }

    #[test]
    fn relocate_moves_primary_key_and_every_child_row() {
        let conn = new_conn();
        let old = "D:/music/乱七八糟/01.flac";
        let new = "D:/sorted/歌手/专辑/歌曲.flac";
        upsert_local_tracks(&conn, &[row(old, "歌曲")]).unwrap();
        conn.execute(
            "INSERT INTO playlists (id, name, created_at, updated_at) VALUES ('p1', '歌单', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
             VALUES ('p1', ?1, 0, 1)",
            params![format!("local:{old}")],
        )
        .unwrap();
        // 历史也挂在这条 id 上：换位置之后必须还找得到
        conn.execute(
            "INSERT INTO play_history (id, track_id, played_at, played_duration_ms, completed)
             VALUES ('h1', ?1, 1, 1000, 1)",
            params![format!("local:{old}")],
        )
        .unwrap();

        assert_eq!(relocate_local_track(&conn, old, new).unwrap(), 1);

        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM tracks WHERE id = ?1",
                &format!("local:{old}")
            ),
            0
        );
        // local_path 列存的是纯路径，不带 local: 前缀
        assert_eq!(
            count(&conn, "SELECT COUNT(*) FROM tracks WHERE local_path = ?1", new),
            1
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM playlist_tracks WHERE track_id = ?1",
                &format!("local:{new}")
            ),
            1
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM play_history WHERE track_id = ?1",
                &format!("local:{new}")
            ),
            1
        );
        assert_eq!(
            count(
                &conn,
                "SELECT COUNT(*) FROM tracks WHERE id = ?1 AND missing = 0",
                &format!("local:{new}")
            ),
            1
        );

        // 幂等：已经从老路径挪走的记录不会再把子表拽回去
        assert_eq!(relocate_local_track(&conn, old, new).unwrap(), 0);
    }

    #[test]
    fn relocate_reports_zero_for_unknown_path() {
        let conn = new_conn();
        assert_eq!(
            relocate_local_track(&conn, "D:/not/in/library.flac", "D:/moved.flac").unwrap(),
            0
        );
    }
}
