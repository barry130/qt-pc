//! 听歌统计域（DESIGN §5.3）：`play_stats` 累计、概览与排行。
//!
//! 拆自原 `db/store.rs`（P2-7），函数体与 SQL 一行未改。
//! 统计由播放引擎在起播时累计，必须允许失败（本地曲目未入库时撞外键就跳过），
//! 不能因为统计写库失败影响播放链路。

use rusqlite::{params, Connection, OptionalExtension};

use crate::provider::types::{Track};

// 跨域共享的小工具（`db_track_id` / `now_ms` / `track_from_row` / `LOCAL_PLATFORM` …）
// 由 store/mod.rs 统一再导出，这里一次性引入，省得每个域各写一长串 use。
use super::*;
// ---------- 听歌统计（DESIGN §5.3） ----------
//
// play_stats 由播放引擎在每次起播时累计（次数 +1 / 时长累加），这里只负责落库与查询。

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayStatItem {
    pub track: Track,
    pub play_count: i64,
    pub last_played_at: i64,
    pub total_played_ms: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SingerStat {
    pub singer: String,
    /// 该歌手统计里出现过的一个音源（分组只按歌手名，音源取其一，供前端跳歌手页用）
    pub platform: String,
    pub play_count: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayOverview {
    pub total_plays: i64,
    pub total_ms: i64,
    /// 有统计的曲目数（不是总播放次数）
    pub track_count: i64,
    pub last_played_at: Option<i64>,
}

/// 累计一次播放。`played_ms` 是本次计入的时长（起播时按曲目时长记）。
/// 本地曲目没被扫描进 tracks 时会撞外键，这里直接跳过——统计不该影响播放。
pub(crate) fn record_play_stat(
    conn: &Connection,
    track: &Track,
    played_ms: i64,
) -> Result<(), rusqlite::Error> {
    upsert_tracks(conn, &[track])?;
    let id = db_track_id(track);
    let known: bool = conn
        .query_row("SELECT 1 FROM tracks WHERE id = ?1", params![id], |_| Ok(()))
        .optional()?
        .is_some();
    if !known {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO play_stats (track_id, play_count, last_played_at, total_played_ms)
         VALUES (?1, 1, ?2, ?3)
         ON CONFLICT(track_id) DO UPDATE SET
           play_count = play_count + 1,
           last_played_at = excluded.last_played_at,
           total_played_ms = total_played_ms + excluded.total_played_ms",
        params![id, now_ms(), played_ms],
    )?;
    Ok(())
}

/// 概览：总次数 / 总时长 / 曲目数 / 最近播放时间
pub(crate) fn play_overview(conn: &Connection) -> Result<PlayOverview, rusqlite::Error> {
    let (total_plays, total_ms, track_count, last_played_at): (i64, i64, i64, Option<i64>) =
        conn.query_row(
            "SELECT COALESCE(SUM(play_count), 0),
                    COALESCE(SUM(total_played_ms), 0),
                    COUNT(*),
                    MAX(last_played_at)
               FROM play_stats",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
    Ok(PlayOverview {
        total_plays,
        total_ms,
        track_count,
        last_played_at,
    })
}

/// 播放最多的曲目（次数降序，同次数按最近播放）
pub(crate) fn list_top_tracks(
    conn: &Connection,
    limit: u32,
) -> Result<Vec<PlayStatItem>, rusqlite::Error> {
    let limit = if limit == 0 { 20 } else { limit.min(200) };
    let mut stmt = conn.prepare(
        "SELECT s.play_count, s.last_played_at, s.total_played_ms,
                t.id, t.platform, t.title, t.singer, t.album, t.pic_url,
                t.duration_ms, t.music_id
           FROM play_stats s JOIN tracks t ON t.id = s.track_id
          ORDER BY s.play_count DESC, s.last_played_at DESC
          LIMIT ?1",
    )?;
    let mut rows = stmt.query(params![limit])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let db_id: String = row.get(3)?;
        let Some((platform, track_id)) = split_db_track_id(&db_id) else {
            continue;
        };
        out.push(PlayStatItem {
            play_count: row.get(0)?,
            last_played_at: row.get(1)?,
            total_played_ms: row.get(2)?,
            track: Track {
                id: track_id,
                platform,
                title: row.get(5)?,
                singer: row.get(6)?,
                album: row.get(7)?,
                pic_url: row.get::<_, Option<String>>(8)?.unwrap_or_default(),
                duration: row.get::<_, Option<i64>>(9)?.unwrap_or(0) as f64 / 1000.0,
                music_id: row.get(10)?,
            },
        });
    }
    Ok(out)
}

/// 播放最多的歌手（按曲目次数汇总）
pub(crate) fn list_top_singers(
    conn: &Connection,
    limit: u32,
) -> Result<Vec<SingerStat>, rusqlite::Error> {
    let limit = if limit == 0 { 10 } else { limit.min(100) };
    let mut stmt = conn.prepare(
        "SELECT t.singer, MAX(t.platform) AS platform, SUM(s.play_count) AS c
           FROM play_stats s JOIN tracks t ON t.id = s.track_id
          WHERE t.singer IS NOT NULL AND t.singer <> ''
          GROUP BY t.singer
          ORDER BY c DESC
          LIMIT ?1",
    )?;
    let mut rows = stmt.query(params![limit])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(SingerStat {
            singer: row.get(0)?,
            platform: row.get(1)?,
            play_count: row.get(2)?,
        });
    }
    Ok(out)
}
