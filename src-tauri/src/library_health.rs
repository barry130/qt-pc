//! 库体检（B11）：把「重复文件」之外的三种慢性问题摊开给用户看。
//!
//! 重复检测（`library_maintenance`）解决的是「同一首歌存了好几份」，而真正
//! 把曲库拖脏的往往是另外三件事：
//!
//! - `missing`：库里还记着、磁盘上没了（扫描时置了 `tracks.missing = 1`）；
//! - `silent`：加入满 30 天却一次都没放过 —— 要么是不喜欢的，要么是坏文件；
//! - `long`：时长 ≥ 10 分钟且没有 CUE 分轨 —— 多半是整轨没切。
//!
//! 三条都只要**只读查询 + 一个忽略清单**，不需要动文件；这也是本模块与
//! `library_maintenance` 的分界：那边会搬文件，这边只列清单。
//!
//! ## 忽略清单按 `(track_id, kind)` 去重
//! 同一首歌可能既超长又零播放。忽略「超长」不该连带把「零播放」也藏掉，
//! 否则用户永远看不到另一半问题；所以主键是两列，`restore` 也是整表清空
//! （「恢复忽略」是个低频动作，做成一次性还原比按类还原更好解释）。
//!
//! ## 上限
//! 每类最多回 500 条（`MAX_ITEMS + 1` 用来判定「还有更多」）。曲库大到
//! 上万首时，两千条清单对用户没有意义，前端也只渲染前若干条；真正的批量
//! 处理是「全选忽略」而不是逐条盯着看。

use rusqlite::{params, Connection};
use tauri::State;

use crate::AppState;

const KIND_MISSING: &str = "missing";
const KIND_SILENT: &str = "silent";
const KIND_LONG: &str = "long";

/// 零播放要攒够多少天才算「沉默」：刚导入的曲库不该一打开就满屏报警。
const SILENT_DAYS: i64 = 30;
/// 超过 10 分钟且没有 CUE 分轨，提示「可能是整轨未分割」。
const LONG_MS: i64 = 10 * 60 * 1000;
/// 每类清单上限（多取一条用来判定 truncated）。
const MAX_ITEMS: usize = 500;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthTrack {
    /// 曲库里的 track id（带 `local:` 前缀，前端拿去调删除命令前会剥掉）
    id: String,
    title: String,
    singer: String,
    album: String,
    path: String,
    duration_ms: i64,
    /// 给用户看的一句话原因（「文件已不在原路径」/「加入 42 天从未播放」…）
    detail: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthKind {
    /// `missing` / `silent` / `long`
    kind: &'static str,
    /// 命中总数（可能大于 `items.len()`）
    total: usize,
    /// 是否因为上限被截断
    truncated: bool,
    items: Vec<HealthTrack>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    missing: HealthKind,
    silent: HealthKind,
    long: HealthKind,
    /// 被忽略的条数（清单页脚用来提示「还有 N 条被你忽略了」）
    ignored: usize,
}

/// 三类清单共用的列顺序；`detail` 在下面按类各自拼。
const COLUMNS: &str = "t.id, t.title, t.singer, t.album, COALESCE(t.local_path, ''), t.duration_ms";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn row_to_track(row: &rusqlite::Row<'_>, detail: String) -> Result<HealthTrack, rusqlite::Error> {
    Ok(HealthTrack {
        id: row.get(0)?,
        title: row.get(1)?,
        singer: row.get(2)?,
        album: row.get(3)?,
        path: row.get(4)?,
        duration_ms: row.get(5)?,
        detail,
    })
}

/// 文件不见了：不额外判断什么，扫描器已经把结论写进 `missing`。
fn missing_items(conn: &Connection) -> Result<Vec<HealthTrack>, rusqlite::Error> {
    let sql = format!(
        "SELECT {COLUMNS}
           FROM tracks t
          WHERE t.platform = 'local' AND t.missing = 1 AND t.cue_path IS NULL
            -- CUE 分轨入库时，`upsert_local_tracks` 会把同一路径的整轨父记录
            -- 置 missing=1 退休（它不该再被直接播）。这是「正常退休」不是
            -- 「文件丢了」：同一 local_path 上还有 cue_path 非空的活记录，就跳过。
            AND NOT EXISTS (SELECT 1 FROM tracks c
                             WHERE c.platform = 'local' AND c.missing = 0
                               AND c.cue_path IS NOT NULL
                               AND c.local_path = t.local_path)
            AND NOT EXISTS (SELECT 1 FROM library_health_ignored g
                             WHERE g.track_id = t.id AND g.kind = ?1)
          ORDER BY t.title COLLATE NOCASE ASC
          LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![KIND_MISSING, (MAX_ITEMS + 1) as i64])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(row_to_track(row, "文件已不在原路径".to_string())?);
    }
    Ok(out)
}

/// 零播放：`play_count` 缺失也算 0（`COALESCE`），并限定加入时间够久。
fn silent_items(conn: &Connection, now: i64) -> Result<Vec<HealthTrack>, rusqlite::Error> {
    let sql = format!(
        "SELECT {COLUMNS}, t.created_at
           FROM tracks t
           LEFT JOIN play_stats ps ON ps.track_id = t.id
          WHERE t.platform = 'local' AND t.missing = 0
            AND COALESCE(ps.play_count, 0) = 0
            AND t.created_at <= ?2
            AND NOT EXISTS (SELECT 1 FROM library_health_ignored g
                             WHERE g.track_id = t.id AND g.kind = ?1)
          ORDER BY t.created_at ASC, t.title COLLATE NOCASE ASC
          LIMIT ?3"
    );
    let boundary = now - SILENT_DAYS * 86_400_000;
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![KIND_SILENT, boundary, (MAX_ITEMS + 1) as i64])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let created_at: i64 = row.get(6)?;
        let days = ((now - created_at) / 86_400_000).max(0);
        out.push(row_to_track(row, format!("加入 {days} 天从未播放"))?);
    }
    Ok(out)
}

/// 超长：≥ 10 分钟且没有 CUE 分轨（有分轨的整轨文件是被拆着听的，不算问题）。
fn long_items(conn: &Connection) -> Result<Vec<HealthTrack>, rusqlite::Error> {
    let sql = format!(
        "SELECT {COLUMNS}
           FROM tracks t
          WHERE t.platform = 'local' AND t.missing = 0
            AND t.duration_ms >= ?2 AND t.cue_path IS NULL
            AND NOT EXISTS (SELECT 1 FROM library_health_ignored g
                             WHERE g.track_id = t.id AND g.kind = ?1)
          ORDER BY t.duration_ms DESC, t.title COLLATE NOCASE ASC
          LIMIT ?3"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![KIND_LONG, LONG_MS, (MAX_ITEMS + 1) as i64])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let duration_ms: i64 = row.get(5)?;
        let mins = duration_ms / 60_000;
        let secs = (duration_ms % 60_000) / 1000;
        out.push(row_to_track(row, format!("时长 {mins}:{secs:02}，可能是整轨未分割"))?);
    }
    Ok(out)
}

fn kind_from(kind: &'static str, items: Vec<HealthTrack>) -> HealthKind {
    let truncated = items.len() > MAX_ITEMS;
    let total = if truncated {
        // 截断了就是「至少 MAX_ITEMS + 1」，前端只需要知道「还有很多」
        MAX_ITEMS + 1
    } else {
        items.len()
    };
    HealthKind {
        kind,
        total,
        truncated,
        items: items.into_iter().take(MAX_ITEMS).collect(),
    }
}

fn scan(conn: &Connection, now: i64) -> Result<HealthReport, rusqlite::Error> {
    let ignored: i64 = conn.query_row("SELECT COUNT(*) FROM library_health_ignored", [], |r| r.get(0))?;
    Ok(HealthReport {
        missing: kind_from(KIND_MISSING, missing_items(conn)?),
        silent: kind_from(KIND_SILENT, silent_items(conn, now)?),
        long: kind_from(KIND_LONG, long_items(conn)?),
        ignored: usize::try_from(ignored).unwrap_or(0),
    })
}

fn ignore(conn: &Connection, kind: &str, track_ids: &[String], now: i64) -> Result<usize, rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    let mut added = 0usize;
    for id in track_ids {
        let id = id.trim();
        if id.is_empty() {
            continue;
        }
        added += tx.execute(
            "INSERT OR IGNORE INTO library_health_ignored (track_id, kind, created_at)
             VALUES (?1, ?2, ?3)",
            params![id, kind, now],
        )?;
    }
    tx.commit()?;
    Ok(added)
}

fn restore(conn: &Connection) -> Result<usize, rusqlite::Error> {
    conn.execute("DELETE FROM library_health_ignored", [])
}

fn check_kind(kind: &str) -> Result<(), String> {
    match kind.trim() {
        KIND_MISSING | KIND_SILENT | KIND_LONG => Ok(()),
        other => Err(format!("未知的体检类别：{other}")),
    }
}

#[tauri::command(rename = "scan_library_health")]
pub async fn cmd_scan_library_health(state: State<'_, AppState>) -> Result<HealthReport, String> {
    let db = state.db.clone().ok_or("数据库不可用")?;
    tauri::async_runtime::spawn_blocking(move || db.with(|conn| scan(conn, now_ms())))
        .await
        .map_err(|e| format!("库体检失败：{e}"))?
}

#[tauri::command(rename = "ignore_library_health")]
pub fn cmd_ignore_library_health(
    state: State<'_, AppState>,
    kind: String,
    track_ids: Vec<String>,
) -> Result<usize, String> {
    check_kind(&kind)?;
    let db = state.db.clone().ok_or("数据库不可用")?;
    let kind = kind.trim().to_string();
    db.with(|conn| ignore(conn, &kind, &track_ids, now_ms()))
}

#[tauri::command(rename = "restore_library_health_ignored")]
pub fn cmd_restore_library_health_ignored(state: State<'_, AppState>) -> Result<usize, String> {
    let db = state.db.clone().ok_or("数据库不可用")?;
    db.with(restore)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::store::tests::new_conn;
    use crate::db::store::{upsert_local_tracks, LocalTrackRow};

    fn local_row(path: &str, title: &str, duration_ms: i64) -> LocalTrackRow {
        LocalTrackRow {
            id: path.to_string(),
            path: path.to_string(),
            cue_path: None,
            start_ms: None,
            end_ms: None,
            title: title.to_string(),
            singer: "歌手".to_string(),
            album: "专辑".to_string(),
            duration_ms,
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

    fn set_created_at(conn: &Connection, title: &str, created_at: i64) {
        conn.execute(
            "UPDATE tracks SET created_at = ?1 WHERE title = ?2",
            params![created_at, title],
        )
        .unwrap();
    }

    #[test]
    fn missing_files_show_up_and_ignored_ones_disappear() {
        let conn = new_conn();
        upsert_local_tracks(&conn, &[local_row("D:/m/a.flac", "丢了", 200_000)]).unwrap();
        conn.execute("UPDATE tracks SET missing = 1", []).unwrap();

        let report = scan(&conn, now_ms()).unwrap();
        assert_eq!(report.missing.items.len(), 1);
        assert_eq!(report.missing.items[0].title, "丢了");
        assert!(report.missing.items[0].detail.contains("不在原路径"));

        let id = report.missing.items[0].id.clone();
        assert_eq!(ignore(&conn, KIND_MISSING, &[id], now_ms()).unwrap(), 1);
        let after = scan(&conn, now_ms()).unwrap();
        assert!(after.missing.items.is_empty());
        assert_eq!(after.ignored, 1);

        // 重复忽略不再增加
        let id2 = "local:D:/m/a.flac".to_string();
        assert_eq!(ignore(&conn, KIND_MISSING, &[id2], now_ms()).unwrap(), 0);
        assert_eq!(restore(&conn).unwrap(), 1);
        assert_eq!(scan(&conn, now_ms()).unwrap().missing.items.len(), 1);
    }

    #[test]
    fn silent_requires_thirty_days_and_no_play() {
        let conn = new_conn();
        upsert_local_tracks(
            &conn,
            &[
                local_row("D:/m/old.flac", "老歌", 200_000),
                local_row("D:/m/new.flac", "新歌", 200_000),
            ],
        )
        .unwrap();
        let now = now_ms();
        set_created_at(&conn, "老歌", now - 40 * 86_400_000);
        set_created_at(&conn, "新歌", now - 2 * 86_400_000);

        let report = scan(&conn, now).unwrap();
        assert_eq!(report.silent.items.len(), 1);
        assert_eq!(report.silent.items[0].title, "老歌");
        assert!(report.silent.items[0].detail.contains("40 天"));

        // 播过一次就不再算沉默
        conn.execute(
            "INSERT INTO play_stats (track_id, play_count, last_played_at, total_played_ms)
             VALUES ('local:D:/m/old.flac', 1, 1, 1000)",
            [],
        )
        .unwrap();
        assert!(scan(&conn, now).unwrap().silent.items.is_empty());
    }

    #[test]
    fn long_tracks_need_ten_minutes_and_cue_parent_is_not_noise() {
        let conn = new_conn();
        upsert_local_tracks(
            &conn,
            &[
                // 与下方 CUE 子轨同路径的整轨：入库时会被退休（missing=1）——
                // 这是正常退休，两条清单都不该报它。
                local_row("D:/m/album.flac", "整轨", 42 * 60_000),
            ],
        )
        .unwrap();
        let mut cue = local_row("D:/m/album.flac#cue:1", "整轨·第一首", 5 * 60_000);
        cue.path = "D:/m/album.flac".to_string();
        cue.cue_path = Some("D:/m/album.cue".to_string());
        upsert_local_tracks(&conn, &[cue]).unwrap();
        // 另一张没有 CUE 的长整轨：真问题
        upsert_local_tracks(&conn, &[local_row("D:/m/live.flac", "现场整轨", 42 * 60_000)]).unwrap();

        let report = scan(&conn, now_ms()).unwrap();
        assert_eq!(report.long.items.len(), 1, "只该报没有 CUE 的那张");
        assert_eq!(report.long.items[0].title, "现场整轨");
        assert!(report.long.items[0].detail.contains("42:00"));
        assert!(report.missing.items.is_empty(), "CUE 退休记录不该算丢文件");
    }

    #[test]
    fn short_tracks_are_not_long() {
        let conn = new_conn();
        upsert_local_tracks(&conn, &[local_row("D:/m/short.flac", "正常", 4 * 60_000)]).unwrap();
        assert!(scan(&conn, now_ms()).unwrap().long.items.is_empty());
    }

    #[test]
    fn unknown_kind_is_rejected() {
        assert!(check_kind("missing").is_ok());
        assert!(check_kind("whatever").is_err());
    }
}
