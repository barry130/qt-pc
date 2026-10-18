//! 播放历史域（DESIGN §5.3）：`play_history` 单条去重写入、最近播放列表、清空。
//!
//! 拆自原 `db/store.rs`（P2-7），函数体与 SQL 一行未改。

use rusqlite::{params, Connection, OptionalExtension};

use crate::provider::types::Track;

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
    conn.execute(
        "DELETE FROM play_history WHERE track_id = ?1",
        params![db_id],
    )?;
    conn.execute(
        "INSERT INTO play_history (id, track_id, played_at, played_duration_ms, completed)
         VALUES (?1, ?2, ?3, 0, 0)",
        params![format!("{db_id}:{now}"), db_id, now],
    )?;
    Ok(())
}

/// 播放结束时回填这一条历史的真实收听时长与完播标记。
///
/// `play_history` 一首歌只留最近一条（见 [`record_play_history`]），所以这里按
/// `track_id` 直接覆盖绝对值：`listened_ms` 是本次收听的累计秒数，不是增量。
/// 与统计同源、同一批结算调用（引擎切歌 / 停止 / 播完），失败只记日志 —— 历史是旁路数据。
pub(crate) fn update_play_history_progress(
    conn: &Connection,
    track: &Track,
    listened_ms: i64,
    completed: bool,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE play_history SET played_duration_ms = ?2, completed = ?3 WHERE track_id = ?1",
        params![db_track_id(track), listened_ms, completed as i64],
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
                t.pic_url, t.duration_ms, t.music_id, t.start_ms, t.end_ms
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
                start_ms: row.get::<_, Option<i64>>(9)?.and_then(|v| u64::try_from(v).ok()),
                end_ms: row.get::<_, Option<i64>>(10)?.and_then(|v| u64::try_from(v).ok()),
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

/// 删掉一首歌的播放记录（`db_id` 是 tracks 主键口径 `platform:原始id`）。返回是否真删到。
///
/// 历史页此前只有「清空」：手滑听过一首不想留痕的歌，只能把整页记录一起清掉。
/// `play_history` 一首歌只留最近一条（见 [`record_play_history`]），
/// 所以按 `track_id` 删就等于「删掉这首歌的记录」。
pub(crate) fn remove_play_history(
    conn: &Connection,
    db_id: &str,
) -> Result<bool, rusqlite::Error> {
    let n = conn.execute(
        "DELETE FROM play_history WHERE track_id = ?1",
        params![db_id],
    )?;
    Ok(n > 0)
}

/// 批量删除播放记录（历史页多选删除）。返回真正删掉的行数。
///
/// 空列表直接返回 0：拼出来会是 `IN ()`，SQLite 直接报语法错误。
pub(crate) fn remove_play_history_many(
    conn: &Connection,
    db_ids: &[String],
) -> Result<usize, rusqlite::Error> {
    if db_ids.is_empty() {
        return Ok(0);
    }
    let placeholders = std::iter::repeat_n("?", db_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let n = conn.execute(
        &format!("DELETE FROM play_history WHERE track_id IN ({placeholders})"),
        rusqlite::params_from_iter(db_ids.iter()),
    )?;
    Ok(n)
}

/// 统计「指向已丢失文件」的播放记录条数。
///
/// [`list_play_history`] 过滤了 `t.missing = 1`，这些行在界面上根本看不见 ——
/// 用户清空后如果还有残留，页面上没有任何线索。所以单独给一个计数，
/// 让历史页能提示「另有 N 条记录的文件已不在」并一键清掉。
pub(crate) fn count_missing_play_history(conn: &Connection) -> Result<i64, rusqlite::Error> {
    conn.query_row(
        "SELECT COUNT(*) FROM play_history h
           JOIN tracks t ON t.id = h.track_id
          WHERE t.missing = 1",
        [],
        |r| r.get(0),
    )
}

/// 清掉指向已丢失文件的播放记录，返回条数。这些条目在列表里本来就看不到，纯占地方。
pub(crate) fn purge_missing_play_history(conn: &Connection) -> Result<usize, rusqlite::Error> {
    let n = conn.execute(
        "DELETE FROM play_history
          WHERE track_id IN (SELECT id FROM tracks WHERE missing = 1)",
        [],
    )?;
    Ok(n)
}
