//! 播放历史域（DESIGN §5.3）：`play_history` 单条去重写入、最近播放列表、清空。
//!
//! 拆自原 `db/store.rs`（P2-7），函数体与 SQL 一行未改。

use rusqlite::{params, Connection, OptionalExtension};

use crate::provider::types::{Track};

// 跨域共享的小工具（`db_track_id` / `now_ms` / `track_from_row` / `LOCAL_PLATFORM` …）
// 由 store/mod.rs 统一再导出，这里一次性引入，省得每个域各写一长串 use。
use super::*;
// ---------- 收藏 / 播放历史（DESIGN §5.3） ----------

/// 播放历史条目，序列化为 `{ track: {...}, playedAt: 123 }`。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub track: Track,
    /// 播放时间（Unix 毫秒）
    pub played_at: i64,
}

/// 记录一次播放（同一首歌只保留最近一条：先删旧记录再插入）。
/// 本地曲目若尚未被扫描入库，tracks 里没有对应行（外键），此时静默跳过。
pub(crate) fn record_play_history(conn: &Connection, track: &Track) -> Result<(), rusqlite::Error> {
    upsert_tracks(conn, &[track])?;
    let db_id = db_track_id(track);
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM tracks WHERE id = ?1",
            params![db_id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Ok(());
    }
    let now = now_ms();
    conn.execute("DELETE FROM play_history WHERE track_id = ?1", params![db_id])?;
    conn.execute(
        "INSERT INTO play_history (id, track_id, played_at, played_duration_ms, completed)
         VALUES (?1, ?2, ?3, 0, 0)",
        params![format!("{db_id}:{now}"), db_id, now],
    )?;
    Ok(())
}

/// 最近播放（按时间倒序）。`limit = 0` 时给默认 100 条。
pub(crate) fn list_play_history(
    conn: &Connection,
    limit: u32,
) -> Result<Vec<HistoryItem>, rusqlite::Error> {
    let limit = if limit == 0 { 100 } else { limit };
    let mut stmt = conn.prepare(
        "SELECT h.played_at, t.id, t.platform, t.title, t.singer, t.album,
                t.pic_url, t.duration_ms, t.music_id
           FROM play_history h
           JOIN tracks t ON t.id = h.track_id
          WHERE t.missing = 0
          ORDER BY h.played_at DESC, h.rowid DESC
          LIMIT ?1",
    )?;
    let mut rows = stmt.query(params![limit])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let db_id: String = row.get(1)?;
        let Some((platform, id)) = split_db_track_id(&db_id) else {
            continue;
        };
        out.push(HistoryItem {
            track: Track {
                id,
                platform,
                title: row.get(3)?,
                singer: row.get(4)?,
                album: row.get(5)?,
                pic_url: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                duration: row.get::<_, Option<i64>>(7)?.unwrap_or(0) as f64 / 1000.0,
                music_id: row.get(8)?,
            },
            played_at: row.get(0)?,
        });
    }
    Ok(out)
}

pub(crate) fn clear_play_history(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM play_history", [])?;
    Ok(())
}
