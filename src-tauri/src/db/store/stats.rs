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
    /// 有收听记录的天数（按本地自然日去重，只统计 V18 之后的按天明细）
    pub active_days: i64,
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
///
/// 除累计表 `play_stats` 外，同时累加 `play_days` 的 `(track_id, 今天)` 一行 ——
/// 报告页的「今天 / 近 7 天 / 近 30 天」日榜只读后者，累计榜只读前者，
/// 两个口径同源同刻，不会出现「累计涨了、日榜没涨」的错位。
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
    // 两张表共用同一个结算时刻：分两次调 now_ms() 会在整点前后落进不同的自然日，
    // 同一次收听被拆到两天里（日榜和累计榜都看得出）。
    let at = now_ms();
    conn.execute(
        "INSERT INTO play_stats (track_id, play_count, finished_count, last_played_at, total_played_ms)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(track_id) DO UPDATE SET
           play_count = play_count + excluded.play_count,
           finished_count = finished_count + excluded.finished_count,
           last_played_at = excluded.last_played_at,
           total_played_ms = total_played_ms + excluded.total_played_ms",
        params![id, plays, finished_plays, at, listened_ms],
    )?;
    // `day` 交给 SQLite 按**本地时区**算，与查询侧推窗口下界用的是同一个表达式
    // （`date(? / 1000, 'unixepoch', 'localtime', ...)`）；Rust 侧不引 chrono，
    // 也不会出现「写入按 UTC 分日、查询按本地分日」的错位。
    conn.execute(
        "INSERT INTO play_days (track_id, day, play_count, total_played_ms, last_played_at)
         VALUES (?1, date(?4 / 1000, 'unixepoch', 'localtime'), ?2, ?3, ?4)
         ON CONFLICT(track_id, day) DO UPDATE SET
           play_count = play_count + excluded.play_count,
           total_played_ms = total_played_ms + excluded.total_played_ms,
           last_played_at = excluded.last_played_at",
        params![id, plays, listened_ms, at],
    )?;
    Ok(())
}

/// 概览：有效播放次数 / 真实收听时长 / 曲目数 / 完播次数 / 最近播放时间 / 活跃天数
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
    // 活跃天数只认 `play_days`（V18 起才有的按天明细）：老库升级前那些播放的
    // 具体日期无从考证，用 `last_played_at` 反推只会得到一个偏小的假数字。
    let active_days: i64 = conn.query_row(
        "SELECT COUNT(DISTINCT day) FROM play_days WHERE play_count > 0 OR total_played_ms > 0",
        [],
        |r| r.get(0),
    )?;
    Ok(PlayOverview {
        total_plays,
        total_ms,
        track_count,
        finished_plays,
        last_played_at,
        active_days,
    })
}

/// 把升级前「只有累计值、没有按天明细」的存量播放一次性归到今天。
///
/// **为什么补的是差额，而不是把 `play_stats` 整笔搬过来**：`play_stats` 是
/// **含今天**的累计值，V18 之后今天的播放已经同步写进了 `play_days`，
/// 整笔搬会把今天听的那几次再加一遍（累计 12 次、今天 2 次的库会记成 14 次）。
/// 这里只搬「累计 − 明细已有之和」，守住
/// `SUM(play_days.play_count) == play_stats.play_count` 这个不变量。
///
/// 因此这个函数**天然幂等**：第二次调用差额为 0，一行都不写，也就不需要
/// `stats.daysSeeded` 之类的持久化标记 —— 那种标记在「恢复备份后 `play_days`
/// 为空、标记却是真」的场景下会让存量永远补不回来。读一次盘就重算一次，
/// 代价只是一条聚合约。
///
/// 返回本次补齐的行数。空库 / 全部已补齐时返回 0。
pub(crate) fn seed_play_days(conn: &Connection) -> Result<usize, rusqlite::Error> {
    // INSERT ... SELECT 带 ON CONFLICT 时，SQLite 的语法分析器只有看到 WHERE
    // 子句才敢确定 `ON` 不是 JOIN 的 ON（少了它会报 near "ON": syntax error）。
    conn.execute(
        "INSERT INTO play_days (track_id, day, play_count, total_played_ms, last_played_at)
         SELECT s.track_id,
                date(?1 / 1000, 'unixepoch', 'localtime'),
                s.play_count - COALESCE(d.play_count, 0),
                s.total_played_ms - COALESCE(d.total_played_ms, 0),
                s.last_played_at
           FROM play_stats s
           LEFT JOIN (SELECT track_id,
                             SUM(play_count)      AS play_count,
                             SUM(total_played_ms) AS total_played_ms
                        FROM play_days
                       GROUP BY track_id) d ON d.track_id = s.track_id
          WHERE s.play_count > COALESCE(d.play_count, 0)
             OR s.total_played_ms > COALESCE(d.total_played_ms, 0)
         ON CONFLICT(track_id, day) DO UPDATE SET
           play_count = play_count + excluded.play_count,
           total_played_ms = total_played_ms + excluded.total_played_ms,
           last_played_at = MAX(play_days.last_played_at, excluded.last_played_at)",
        params![now_ms()],
    )
}

/// 清除听歌统计：累计表与按天明细一起删，返回删掉的曲目数。
///
/// 只动这两张表 —— `play_history`（播放记录）、收藏、歌单、下载都不受影响，
/// 与移动端「清除听歌统计」同口径：统计归零，但「最近听了什么」还在。
pub(crate) fn clear_play_stats(conn: &Connection) -> Result<i64, rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM play_days", [])?;
    let removed = tx.execute("DELETE FROM play_stats", [])? as i64;
    tx.commit()?;
    Ok(removed)
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
                t.duration_ms, t.music_id, t.start_ms, t.end_ms
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
                start_ms: row.get::<_, Option<i64>>(11)?.and_then(|v| u64::try_from(v).ok()),
                end_ms: row.get::<_, Option<i64>>(12)?.and_then(|v| u64::try_from(v).ok()),
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

// ---------- 本地化推荐合辑取数（recommend.rs 消费，纯只读 SELECT） ----------
//
// 「本地化推荐合辑」完全用本地既有数据拼出几个合辑卡片，不联网：
//   · play_history —— 最近一次播放（历史表一首歌只留最近一条，见
//     record_play_history），「最近在听」「深夜歌单」按它判定；
//   · play_stats —— 全历史累计（次数 / 最后播放时间），「循环最多的歌」
//     与「久未重温」按它判定；
//   · liked_songs × play_stats —— 「收藏里的常客」。
// 不建新表、不加迁移，这里只有 SELECT。所有查询都过滤 `t.missing = 0`：
// 文件已经不在的曲目不该再被推荐出来。
//
// 顺带的三个 `count_*` 是给合辑副标题用的：列表查询带 LIMIT（合辑是精选），
// 副标题里的动态数字（「近 14 天听过 37 首」）得用不带 LIMIT 的真实计数，
// 否则数字永远停在 LIMIT 上，看起来像坏了。

/// 行映射：`play_stats JOIN tracks` 的 13 列（列序与 [`list_top_tracks`] 完全一致）。
///
/// `tracks.id` 是 `platform:原始id` 复合主键，解析失败的行跳过，同
/// [`list_top_tracks`] 口径 —— 宁可少一首，不给上层一个拼不出来的 Track。
fn stat_item_from_row(row: &rusqlite::Row<'_>) -> Result<Option<PlayStatItem>, rusqlite::Error> {
    let db_id: String = row.get(3)?;
    let Some((platform, track_id)) = split_db_track_id(&db_id) else {
        return Ok(None);
    };
    Ok(Some(PlayStatItem {
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
            start_ms: row.get::<_, Option<i64>>(11)?.and_then(|v| u64::try_from(v).ok()),
            end_ms: row.get::<_, Option<i64>>(12)?.and_then(|v| u64::try_from(v).ok()),
        },
    }))
}

/// 近一段时间（`since_ms` 毫秒起）听过的曲目，最近播放在前。
///
/// `play_history` 天然一首一条（见 [`record_play_history`]），无需再去重。
/// 列序刻意对齐 [`track_from_row`]（sid 由 substr 拆出），直接复用既有行映射。
pub(crate) fn list_recent_tracks(
    conn: &Connection,
    since_ms: i64,
    limit: u32,
) -> Result<Vec<Track>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT substr(t.id, instr(t.id, ':') + 1), t.platform, t.title, t.singer,
                t.album, t.pic_url, t.duration_ms, t.music_id, t.start_ms, t.end_ms
           FROM play_history h
           JOIN tracks t ON t.id = h.track_id
          WHERE h.played_at >= ?1 AND t.missing = 0
          ORDER BY h.played_at DESC, h.rowid DESC
          LIMIT ?2",
    )?;
    let mut rows = stmt.query(params![since_ms, limit])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        if let Some(track) = track_from_row(row)? {
            out.push(track);
        }
    }
    Ok(out)
}

/// 近一段时间听过的**曲目总数**（合辑副标题用；与 [`list_recent_tracks`]
/// 同口径，不限条数）。
pub(crate) fn count_recent_tracks(conn: &Connection, since_ms: i64) -> Result<i64, rusqlite::Error> {
    conn.query_row(
        "SELECT COUNT(*)
           FROM play_history h JOIN tracks t ON t.id = h.track_id
          WHERE h.played_at >= ?1 AND t.missing = 0",
        params![since_ms],
        |r| r.get(0),
    )
}

/// 全历史播放次数 ≥ `min_plays` 的曲目，次数降序、同次数最近听过在前。
pub(crate) fn list_most_played_tracks(
    conn: &Connection,
    min_plays: i64,
    limit: u32,
) -> Result<Vec<PlayStatItem>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT s.play_count, s.last_played_at, s.total_played_ms,
                t.id, t.platform, t.title, t.singer, t.album, t.pic_url,
                t.duration_ms, t.music_id, t.start_ms, t.end_ms
           FROM play_stats s JOIN tracks t ON t.id = s.track_id
          WHERE s.play_count >= ?1 AND t.missing = 0
          ORDER BY s.play_count DESC, s.last_played_at DESC
          LIMIT ?2",
    )?;
    let mut rows = stmt.query(params![min_plays, limit])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        if let Some(item) = stat_item_from_row(row)? {
            out.push(item);
        }
    }
    Ok(out)
}

/// 听过 ≥ `min_plays` 次、但 `before_ms` 之后就再没听过的曲目，
/// **最久没听的排最前**（`last_played_at` 升序）——「久未重温」的取数。
pub(crate) fn list_unreplayed_tracks(
    conn: &Connection,
    min_plays: i64,
    before_ms: i64,
    limit: u32,
) -> Result<Vec<PlayStatItem>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT s.play_count, s.last_played_at, s.total_played_ms,
                t.id, t.platform, t.title, t.singer, t.album, t.pic_url,
                t.duration_ms, t.music_id, t.start_ms, t.end_ms
           FROM play_stats s JOIN tracks t ON t.id = s.track_id
          WHERE s.play_count >= ?1 AND s.last_played_at < ?2 AND t.missing = 0
          ORDER BY s.last_played_at ASC
          LIMIT ?3",
    )?;
    let mut rows = stmt.query(params![min_plays, before_ms, limit])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        if let Some(item) = stat_item_from_row(row)? {
            out.push(item);
        }
    }
    Ok(out)
}

/// 「久未重温」口径的曲目总数（合辑副标题用；不限条数）。
pub(crate) fn count_unreplayed_tracks(
    conn: &Connection,
    min_plays: i64,
    before_ms: i64,
) -> Result<i64, rusqlite::Error> {
    conn.query_row(
        "SELECT COUNT(*)
           FROM play_stats s JOIN tracks t ON t.id = s.track_id
          WHERE s.play_count >= ?1 AND s.last_played_at < ?2 AND t.missing = 0",
        params![min_plays, before_ms],
        |r| r.get(0),
    )
}

/// 拼深夜窗口条件。`start_hour > end_hour` 表示窗口跨零点（22 → 6），用 OR；
/// 否则是普通区间（0 → 24 即全天，单测用它验证整条管道）。小时一律按
/// SQLite 的 `localtime` 折算 —— 「深夜」跟用户墙钟一致才有意义。
/// 两个参数是内部常量传进来的 i64 字面量，`format!` 拼接没有注入面。
fn late_night_window(start_hour: i64, end_hour: i64) -> String {
    let hour =
        "CAST(strftime('%H', h.played_at / 1000, 'unixepoch', 'localtime') AS INTEGER)";
    if start_hour <= end_hour {
        format!("{hour} >= {start_hour} AND {hour} < {end_hour}")
    } else {
        format!("{hour} >= {start_hour} OR {hour} < {end_hour}")
    }
}

/// 播放时刻落在本地时区 `[start_hour, end_hour)` 的曲目，最近播放在前。
/// 同 [`list_recent_tracks`]，以**最近一次播放**的时刻判定（历史表一首一条）。
pub(crate) fn list_late_night_tracks(
    conn: &Connection,
    start_hour: i64,
    end_hour: i64,
    limit: u32,
) -> Result<Vec<Track>, rusqlite::Error> {
    let sql = format!(
        "SELECT substr(t.id, instr(t.id, ':') + 1), t.platform, t.title, t.singer,
                t.album, t.pic_url, t.duration_ms, t.music_id, t.start_ms, t.end_ms
           FROM play_history h
           JOIN tracks t ON t.id = h.track_id
          WHERE t.missing = 0 AND ({})
          ORDER BY h.played_at DESC, h.rowid DESC
          LIMIT ?1",
        late_night_window(start_hour, end_hour)
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![limit])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        if let Some(track) = track_from_row(row)? {
            out.push(track);
        }
    }
    Ok(out)
}

/// 深夜窗口内的**曲目总数**（合辑副标题用；不限条数）。
pub(crate) fn count_late_night_tracks(
    conn: &Connection,
    start_hour: i64,
    end_hour: i64,
) -> Result<i64, rusqlite::Error> {
    conn.query_row(
        &format!(
            "SELECT COUNT(*)
               FROM play_history h JOIN tracks t ON t.id = h.track_id
              WHERE t.missing = 0 AND ({})",
            late_night_window(start_hour, end_hour)
        ),
        [],
        |r| r.get(0),
    )
}

/// 收藏里实际听得最多的曲目（播放次数降序，同次数最近听过在前）。
///
/// `liked_songs.id` / `play_stats.track_id` / `tracks.id` 都是 `platform:原始id`
/// 口径，直接相等连接；从没播过的收藏不进榜（没有播放数据谈不上「常客」），
/// 已删除的收藏（`deleted_at` 非空）不算。
pub(crate) fn list_favorite_tracks_by_plays(
    conn: &Connection,
    limit: u32,
) -> Result<Vec<Track>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT substr(t.id, instr(t.id, ':') + 1), t.platform, t.title, t.singer,
                t.album, t.pic_url, t.duration_ms, t.music_id, t.start_ms, t.end_ms
           FROM liked_songs l
           JOIN play_stats s ON s.track_id = l.id
           JOIN tracks t ON t.id = l.id
          WHERE l.deleted_at IS NULL AND s.play_count >= 1 AND t.missing = 0
          ORDER BY s.play_count DESC, s.last_played_at DESC
          LIMIT ?1",
    )?;
    let mut rows = stmt.query(params![limit])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        if let Some(track) = track_from_row(row)? {
            out.push(track);
        }
    }
    Ok(out)
}

/// 追加段（本地化推荐合辑取数）的单元测试。既有函数的测试在
/// db/store/tests.rs，这里只覆盖文件末尾新增的 SELECT。
#[cfg(test)]
mod local_mix_queries_tests {
    use super::*;
    use rusqlite::params;

    fn conn() -> Connection {
        crate::db::store::tests::new_conn()
    }

    fn sample(title: &str) -> Track {
        crate::db::store::tests::sample_track_with(title, "测试歌手")
    }

    /// 种一首曲目：入库 + 一条播放历史 + 一份全历史统计（原始 SQL，
    /// 时间戳精确可控，绕开 record_play_history / record_listen 的「当前时刻」）。
    fn seed(conn: &Connection, track: &Track, played_at: i64, play_count: i64) {
        upsert_tracks(conn, &[track]).expect("upsert");
        let db_id = db_track_id(track);
        conn.execute(
            "INSERT OR REPLACE INTO play_history
                 (id, track_id, played_at, played_duration_ms, completed)
             VALUES (?1, ?2, ?3, 0, 0)",
            params![format!("{db_id}:{played_at}"), db_id, played_at],
        )
        .expect("seed history");
        conn.execute(
            "INSERT OR REPLACE INTO play_stats
                 (track_id, play_count, finished_count, last_played_at, total_played_ms)
             VALUES (?1, ?2, 0, ?3, 0)",
            params![db_id, play_count, played_at],
        )
        .expect("seed stats");
    }

    /// 窗口拼接：跨零点用 OR，普通区间用 AND —— 拼错会把深夜窗口变成
    /// 永远为空（`>= 22 AND < 6`）或全天，这里把形状锁死。
    #[test]
    fn late_night_window_shape() {
        let wrap = late_night_window(22, 6);
        assert!(
            wrap.contains(" OR ") && !wrap.contains(" AND "),
            "跨零点窗口要用 OR: {wrap}"
        );
        let plain = late_night_window(0, 24);
        assert!(
            plain.contains(" AND ") && !plain.contains(" OR "),
            "普通区间要用 AND: {plain}"
        );
    }

    /// 近期窗口：只收窗口内、文件还在的曲目；最近播放在前；计数与列表同口径。
    #[test]
    fn recent_tracks_respect_window_and_missing() {
        let conn = conn();
        let now = now_ms();
        let day = 24 * 3600 * 1000;
        let fresh = sample("新歌");
        let stale = sample("老歌");
        let lost = sample("丢文件");
        seed(&conn, &fresh, now - 3600 * 1000, 2);
        seed(&conn, &stale, now - 20 * day, 2); // 窗口外
        seed(&conn, &lost, now - 2 * 3600 * 1000, 2);
        conn.execute(
            "UPDATE tracks SET missing = 1 WHERE id = ?1",
            params![db_track_id(&lost)],
        )
        .expect("mark missing");

        let since = now - 14 * day;
        let recent = list_recent_tracks(&conn, since, 10).expect("list recent");
        assert_eq!(recent.len(), 1, "窗口外与丢文件的都不该出现: {recent:?}");
        assert_eq!(recent[0].title, "新歌");
        assert_eq!(
            count_recent_tracks(&conn, since).expect("count recent"),
            1
        );
    }

    /// 循环榜：min_plays 门槛 + 次数降序。
    #[test]
    fn most_played_threshold_and_order() {
        let conn = conn();
        let now = now_ms();
        let twice = sample("两次的");
        let five = sample("五次的");
        let once = sample("一次的");
        seed(&conn, &twice, now - 3000, 2);
        seed(&conn, &five, now - 2000, 5);
        seed(&conn, &once, now - 1000, 1);
        let top = list_most_played_tracks(&conn, 2, 10).expect("list most");
        assert_eq!(top.len(), 2, "只播过一次的不过门槛: {top:?}");
        assert_eq!(top[0].track.title, "五次的");
        assert_eq!(top[0].play_count, 5);
        assert_eq!(top[1].track.title, "两次的");
    }

    /// 久未重温：次数够 + 冷却线外没再听，最久没听的排最前。
    #[test]
    fn unreplayed_order_oldest_first() {
        let conn = conn();
        let now = now_ms();
        let day = 24 * 3600 * 1000;
        let oldest = sample("四十天前");
        let newer = sample("三十五天前");
        let active = sample("还在听");
        seed(&conn, &oldest, now - 40 * day, 3);
        seed(&conn, &newer, now - 35 * day, 4);
        seed(&conn, &active, now - day, 5);
        let before = now - 30 * day;
        let list = list_unreplayed_tracks(&conn, 3, before, 10).expect("list unreplayed");
        assert_eq!(list.len(), 2, "还在听的不算: {list:?}");
        assert_eq!(list[0].track.title, "四十天前");
        assert_eq!(list[1].track.title, "三十五天前");
        assert_eq!(
            count_unreplayed_tracks(&conn, 3, before).expect("count unreplayed"),
            2
        );
    }

    /// 收藏里的常客：必须既有收藏又有播放，没播过的收藏不进榜。
    #[test]
    fn favorite_tracks_need_plays() {
        let conn = conn();
        let now = now_ms();
        let hot = sample("常客");
        let quiet = sample("没播过的收藏");
        seed(&conn, &hot, now - 1000, 4);
        upsert_tracks(&conn, &[&quiet]).expect("upsert quiet");
        add_liked_song(&conn, &hot, "local").expect("like hot");
        add_liked_song(&conn, &quiet, "local").expect("like quiet");
        let favs = list_favorite_tracks_by_plays(&conn, 10).expect("list favorites");
        assert_eq!(favs.len(), 1, "没播过的收藏不进榜: {favs:?}");
        assert_eq!(favs[0].title, "常客");
    }

    /// 深夜取数管道：0 → 24 是「全天」，与时区无关，插过的历史全部命中且
    /// 倒序；跨零点窗口（22 → 6）在真库上跑一遍，保证拼出的 SQL 语法成立
    /// （命中与否取决于种子行的本地钟点，不在这里断言）。
    #[test]
    fn late_night_full_day_and_wrap_query_run() {
        let conn = conn();
        let now = now_ms();
        let first = sample("夜一");
        let second = sample("夜二");
        seed(&conn, &first, now - 2000, 1);
        seed(&conn, &second, now - 1000, 1);
        let all = list_late_night_tracks(&conn, 0, 24, 10).expect("全天窗口");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].title, "夜二", "最近播放在前");
        let wrap = list_late_night_tracks(&conn, 22, 6, 10).expect("跨零点窗口 SQL 必须合法");
        let n = count_late_night_tracks(&conn, 22, 6).expect("跨零点计数 SQL 必须合法");
        assert_eq!(n, wrap.len() as i64, "计数与列表同口径");
    }
}

/// 按天明细（V18 `play_days`）与累计表同源同刻，日榜据此按自然日切窗口。
#[cfg(test)]
mod play_day_tests {
    use super::*;

    fn conn() -> Connection {
        crate::db::store::tests::new_conn()
    }

    fn sample(title: &str) -> Track {
        crate::db::store::tests::sample_track_with(title, "测试歌手")
    }

    #[test]
    fn record_listen_writes_one_day_bucket_and_accumulates() {
        let conn = conn();
        let track = sample("按天结算");
        // 两次结算：一次算有效播放（30 秒 + plays 1），一次只听不算播放。
        record_listen(&conn, &track, 30_000, 1, 0).expect("第一次结算");
        record_listen(&conn, &track, 20_000, 0, 0).expect("第二次结算");
        let id = db_track_id(&track);

        let (days, plays, ms): (i64, i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), SUM(play_count), SUM(total_played_ms)
                   FROM play_days WHERE track_id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .expect("读按天明细");
        assert_eq!(days, 1, "同一天两次结算只落一行");
        assert_eq!(plays, 1, "listen_ms > 0 但 plays = 0 时次数不涨");
        assert_eq!(ms, 50_000, "两次的收听时长都要累加");

        // 写入侧与查询侧必须是同一个本地日期口径，否则推窗口下界时永远差一天。
        let (bucket, today): (String, String) = conn
            .query_row(
                "SELECT (SELECT day FROM play_days WHERE track_id = ?1),
                        date('now', 'localtime')",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("读日期");
        assert_eq!(bucket, today);
    }

    #[test]
    fn overview_counts_active_days_across_buckets() {
        let conn = conn();
        let a = sample("甲");
        record_listen(&conn, &a, 40_000, 1, 0).expect("结算甲");
        record_listen(&conn, &a, 40_000, 1, 0).expect("再结算甲");
        let b = sample("乙");
        record_listen(&conn, &b, 40_000, 1, 0).expect("结算乙");
        // 补一个历史日期：活跃天数按 day 去重，不是「只算今天」。
        conn.execute(
            "INSERT INTO play_days (track_id, day, play_count, total_played_ms, last_played_at)
             VALUES (?1, '2020-01-02', 1, 1000, 1)",
            params![db_track_id(&b)],
        )
        .expect("补历史日");

        let overview = play_overview(&conn).expect("概览");
        assert_eq!(overview.active_days, 2, "今天 + 2020-01-02");
        assert_eq!(overview.total_plays, 3);
    }

    #[test]
    fn active_days_ignores_all_zero_buckets() {
        let conn = conn();
        let track = sample("零值");
        upsert_tracks(&conn, &[&track]).expect("入库");
        let id = db_track_id(&track);
        conn.execute(
            "INSERT INTO play_days (track_id, day, play_count, total_played_ms, last_played_at)
             VALUES (?1, '2021-03-04', 0, 0, 1)",
            params![id],
        )
        .expect("插入零值行");
        conn.execute(
            "INSERT INTO play_stats
                 (track_id, play_count, finished_count, last_played_at, total_played_ms)
             VALUES (?1, 0, 0, 1, 0)",
            params![id],
        )
        .expect("插入曲目统计行");

        let overview = play_overview(&conn).expect("概览");
        assert_eq!(overview.active_days, 0, "全零的一天不算活跃");
    }

    /// 存量补齐：升级前只有累计值的库，第一次进报告页把整笔归到今天；
    /// 再调一次一行都不写（幂等，不需要持久化标记）。
    #[test]
    fn seed_moves_stock_totals_to_today_and_is_idempotent() {
        let conn = conn();
        let track = sample("存量");
        upsert_tracks(&conn, &[&track]).expect("入库");
        let id = db_track_id(&track);
        // 直接写累计表：模拟 v18 之前的老库（play_days 里什么都没有）
        conn.execute(
            "INSERT INTO play_stats
                 (track_id, play_count, finished_count, last_played_at, total_played_ms)
             VALUES (?1, 10, 3, 1000, 100_000)",
            params![id],
        )
        .expect("造存量");

        assert_eq!(seed_play_days(&conn).expect("首次补齐"), 1, "一首有存量的歌补一行");
        let (plays, ms, day, today): (i64, i64, String, String) = conn
            .query_row(
                "SELECT play_count, total_played_ms, day, date('now', 'localtime')
                   FROM play_days WHERE track_id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .expect("读补齐结果");
        assert_eq!((plays, ms), (10, 100_000), "存量整笔归到当天");
        assert_eq!(day, today, "归到本地自然日的今天，与查询侧同口径");
        assert_eq!(
            play_overview(&conn).expect("概览").active_days,
            1,
            "补齐后活跃天数是 1，不再是 0"
        );

        assert_eq!(seed_play_days(&conn).expect("再补齐"), 0, "第二次没有差额可补");
        let (rows, plays): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), SUM(play_count) FROM play_days WHERE track_id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("复查");
        assert_eq!((rows, plays), (1, 10), "幂等：不新增行也不翻倍");
    }

    /// 差额口径的关键用例：今天的真实播放已经按天记过，补齐只能补差额，
    /// 不能把 `play_stats` 整笔再搬一遍（那会把今天听的那几次变成两次）。
    #[test]
    fn seed_only_tops_up_the_difference_after_real_plays_today() {
        let conn = conn();
        let track = sample("差额");
        record_listen(&conn, &track, 30_000, 1, 0).expect("今天的真实播放");
        let id = db_track_id(&track);
        // 累计 = 升级前的 10 次 + 今天的 1 次（时长同理），明细里只有今天的 1 次
        conn.execute(
            "UPDATE play_stats SET play_count = 11, total_played_ms = 130_000 WHERE track_id = ?1",
            params![id],
        )
        .expect("造存量");

        assert_eq!(seed_play_days(&conn).expect("补齐"), 1);
        let (day_plays, day_ms, stat_plays, stat_ms): (i64, i64, i64, i64) = conn
            .query_row(
                "SELECT (SELECT SUM(play_count) FROM play_days WHERE track_id = ?1),
                        (SELECT SUM(total_played_ms) FROM play_days WHERE track_id = ?1),
                        (SELECT play_count FROM play_stats WHERE track_id = ?1),
                        (SELECT total_played_ms FROM play_stats WHERE track_id = ?1)",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .expect("对账");
        assert_eq!(day_plays, stat_plays, "明细之和必须等于累计值，今天的 1 次不能算两遍");
        assert_eq!(day_ms, stat_ms, "时长同理");
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM play_days WHERE track_id = ?1",
                params![id],
                |r| r.get::<_, i64>(0),
            )
            .expect("行数"),
            1,
            "只落在今天这一行"
        );
    }

    /// 清除统计：两张表一起清空，但播放记录、收藏等别的数据一概不动。
    #[test]
    fn clear_play_stats_empties_both_tables_and_keeps_history() {
        let conn = conn();
        let track = sample("清统计");
        record_listen(&conn, &track, 30_000, 1, 0).expect("结算");
        let id = db_track_id(&track);
        conn.execute(
            "INSERT OR REPLACE INTO play_history
                 (id, track_id, played_at, played_duration_ms, completed)
             VALUES (?1, ?2, 1, 0, 0)",
            params![format!("{id}:1"), id],
        )
        .expect("写播放记录");

        assert_eq!(clear_play_stats(&conn).expect("清除"), 1, "返回删掉的曲目数");
        let count = |table: &str| -> i64 {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .expect("计数")
        };
        assert_eq!((count("play_days"), count("play_stats")), (0, 0), "两张统计表都清空");
        assert_eq!(count("play_history"), 1, "播放记录不受影响");
        let overview = play_overview(&conn).expect("概览");
        assert_eq!(
            (overview.total_plays, overview.total_ms, overview.active_days),
            (0, 0, 0),
            "概览回到全零"
        );
    }
}
