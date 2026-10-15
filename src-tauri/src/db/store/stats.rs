//! 听歌统计域（DESIGN §5.3）：`play_stats` 累计、概览与排行。
//!
//! 拆自原 `db/store.rs`（P2-7），函数体与 SQL 一行未改。
//! 统计由播放引擎在**一次收听结束时**结算（切歌 / 停止 / 播完），必须允许失败
//! （本地曲目未入库时撞外键就跳过），不能因为统计写库失败影响播放链路。

use rusqlite::{params, Connection, OptionalExtension};

use crate::provider::types::Track;

// 跨域共享的小工具（`db_track_id` / `now_ms` / `track_from_row` / `LOCAL_PLATFORM` …）
// 由 store/mod.rs 统一再导出，这里一次性引入，省得每个域各写一长串 use。
use super::*;
// ---------- 听歌统计（DESIGN §5.3） ----------
//
// play_stats 由播放引擎按**真实收听**累计：收听的秒数、有效播放次数、完播次数。
// 口径规则本身（`counts_as_play`）放在这一域里：它是「什么算一次播放」的业务定义，
// 引擎只负责按墙钟时间记账，判定与落库都在这里，改口径不用碰音频线程。

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
    /// 有效播放次数（半途跳过的歌不计，见 `counts_as_play`）
    pub total_plays: i64,
    /// 真实累计收听时长（毫秒；seek 跳过的那段不算）
    pub total_ms: i64,
    /// 有统计的曲目数（不是总播放次数）
    pub track_count: i64,
    /// 其中自然播完的次数
    pub finished_plays: i64,
    pub last_played_at: Option<i64>,
}

/// 一次「有效播放」的最低门槛：至少听满这么久（曲目时长未知时的兜底）。
pub(crate) const PLAY_MIN_MS: i64 = 30_000;

/// 这次收听算不算「一次播放」。
///
/// 规则（DESIGN §5.3）：① 自然播完 —— 一定算；② 没播完则要求
/// 收听时长 ≥ 曲目时长的一半**且**不少于 [`PLAY_MIN_MS`]。
///
/// 为什么不是「起播就算」：旧口径在起播那一刻就记满整曲时长 + 次数 +1，
/// 于是「点开听 3 秒跳过」和「完整听完」在报告里一模一样，累计时长也跟着虚高
/// （用户 m05920 的反馈：累计时长要考虑一首歌是不是听完了）。
/// 为什么是「一半 + 30 秒」而不是「必须听完」：纯完播口径会把
/// 「听了 90% 手动切掉」的真实收听全部丢掉，报告反而失真。
pub(crate) fn counts_as_play(finished: bool, listened_ms: i64, duration_ms: i64) -> bool {
    if finished {
        return true;
    }
    if listened_ms < PLAY_MIN_MS {
        return false;
    }
    // 时长未知（0）时只认 30 秒门槛：没有分母就没法算比例
    duration_ms <= 0 || listened_ms * 2 >= duration_ms
}

/// 结算一次收听：累加真实收听毫秒、有效播放次数、完播次数。
///
/// `listened_ms` 是引擎按墙钟累计的本次收听时长（暂停与 seek 跳过的不计），
/// `plays` / `finished_plays` 由引擎按 [`counts_as_play`] 判定后传入，取值 0 或 1。
/// 三个值都为 0 时调用方不会来（引擎侧短路），这里不做特判。
pub(crate) fn record_listen(
    conn: &Connection,
    track: &Track,
    listened_ms: i64,
    plays: i64,
    finished_plays: i64,
) -> Result<(), rusqlite::Error> {
    upsert_tracks(conn, &[track])?;
    let id = db_track_id(track);
    let known: bool = conn
        .query_row(
            "SELECT 1 FROM tracks WHERE id = ?1",
            params![id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !known {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO play_stats (track_id, play_count, finished_count, last_played_at, total_played_ms)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(track_id) DO UPDATE SET
           play_count = play_count + excluded.play_count,
           finished_count = finished_count + excluded.finished_count,
           last_played_at = excluded.last_played_at,
           total_played_ms = total_played_ms + excluded.total_played_ms",
        params![id, plays, finished_plays, now_ms(), listened_ms],
    )?;
    Ok(())
}

/// 概览：有效播放次数 / 真实收听时长 / 曲目数 / 完播次数 / 最近播放时间
pub(crate) fn play_overview(conn: &Connection) -> Result<PlayOverview, rusqlite::Error> {
    let (total_plays, total_ms, track_count, finished_plays, last_played_at): (
        i64,
        i64,
        i64,
        i64,
        Option<i64>,
    ) = conn.query_row(
        "SELECT COALESCE(SUM(play_count), 0),
                    COALESCE(SUM(total_played_ms), 0),
                    COUNT(*),
                    COALESCE(SUM(finished_count), 0),
                    MAX(last_played_at)
               FROM play_stats",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    Ok(PlayOverview {
        total_plays,
        total_ms,
        track_count,
        finished_plays,
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
