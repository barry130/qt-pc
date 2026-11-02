//! 外部 scrobble 队列：`scrobbles` 表（A8，2026-11-01）。
//!
//! ## 为什么是「先落库再发」
//! Last.fm / ListenBrainz 都是 HTTP 旁路：断网、对方 502、token 过期都会失败。
//! 如果结算时就地发请求，播放链路会被网络拖住，而且失败的那次收听直接丢了。
//! 所以引擎只做一件事 —— **把「听过一首」写进队列表**，真正的发送由
//! `scrobble.rs` 的冲刷器按 `status = 'pending' AND next_at <= now` 取。
//!
//! ## 为什么一个目标一行
//! 同一首歌要同时记进 Last.fm 与 ListenBrainz，两边的失败与退避互不干扰：
//! Last.fm 挂了不该拖住 ListenBrainz，所以一个目标一个 `target` 值、各自重试。
//!
//! ## `status` 三态
//! · `pending`：等发（`next_at` 到点才取，退避靠它）；
//! · `sent`：已发（保留行便于界面显示"最近上报"，冲刷时不再取）；
//! · `dead`：重试用尽（`MAX_ATTEMPTS` 次），保留给用户看最后一条错误原因。
//!
//! 失败重试的 `reason` 只留最后一次：用户真正关心的是「现在为什么不行」，
//! 攒一整串历史错误既占地方又没用。

use rusqlite::{params, Connection, OptionalExtension};

use crate::provider::types::Track;

use super::now_ms;

/// Last.fm 目标值。
pub(crate) const TARGET_LASTFM: &str = "lastfm";
/// ListenBrainz 目标值。
pub(crate) const TARGET_LISTENBRAINZ: &str = "listenbrainz";

/// 同一条 scrobble 最多尝试几次（含首次）。超过就标 `dead`，不再打扰对方。
pub(crate) const MAX_ATTEMPTS: i64 = 8;
/// `sent` 行保留多少条（超出的老行在每次冲刷后清掉）：界面上"最近上报"够看即可。
const KEEP_SENT: i64 = 200;

/// 队列里的一行（已够拼请求体，不再回查 `tracks`：曲目可能已被移出曲库）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScrobbleRow {
    pub id: i64,
    pub target: String,
    /// `platform:id`（只作展示与去重用，请求体里不带）
    pub track_id: String,
    pub artist: String,
    pub title: String,
    pub album: String,
    pub duration_ms: i64,
    /// 收听**开始**的 unix 秒（Last.fm 要求的是开始时间，不是上报时间）
    pub played_at: i64,
    pub attempts: i64,
}

/// 队列概览（设置页显示用）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ScrobbleQueueStats {
    pub pending: i64,
    pub sent: i64,
    pub dead: i64,
    /// 最近一次失败原因（`dead` 或退避中的那条）
    pub last_error: Option<String>,
}

/// 把一次收听写进队列（幂等：同一目标 + 同一曲目 + 同一开始时间只留一行）。
///
/// 返回是否真的插入了新行。重复入队只可能是引擎重复结算（同一会话不该发生），
/// 这里挡住它，免得把一个会话算成两次收听。
pub(crate) fn scrobble_enqueue(
    conn: &Connection,
    target: &str,
    track: &Track,
    played_at: i64,
    duration_ms: i64,
) -> Result<bool, rusqlite::Error> {
    let target = target.trim();
    if target.is_empty() || track.title.trim().is_empty() || track.singer.trim().is_empty() {
        return Ok(false);
    }
    let n = conn.execute(
        "INSERT INTO scrobbles
           (target, track_id, artist, title, album, duration_ms, played_at, status, attempts, next_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', 0, 0)
         ON CONFLICT(target, track_id, played_at) DO NOTHING",
        params![
            target,
            track.id,
            track.singer.trim(),
            track.title.trim(),
            track.album.trim(),
            duration_ms.max(0),
            played_at,
        ],
    )?;
    Ok(n > 0)
}

/// 取到点该发的行（按入队顺序）。`limit` 是单次冲刷的上限（Last.fm 一次最多 50 首）。
pub(crate) fn scrobble_due(
    conn: &Connection,
    now: i64,
    limit: usize,
) -> Result<Vec<ScrobbleRow>, rusqlite::Error> {
    let limit = limit.clamp(1, 50) as i64;
    let mut stmt = conn.prepare(
        "SELECT id, target, track_id, artist, title, album, duration_ms, played_at, attempts
           FROM scrobbles
          WHERE status = 'pending' AND next_at <= ?1
          ORDER BY id ASC
          LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![now, limit], |r| {
        Ok(ScrobbleRow {
            id: r.get(0)?,
            target: r.get(1)?,
            track_id: r.get(2)?,
            artist: r.get(3)?,
            title: r.get(4)?,
            album: r.get(5)?,
            duration_ms: r.get(6)?,
            played_at: r.get(7)?,
            attempts: r.get(8)?,
        })
    })?;
    rows.collect()
}

/// 标记发送成功。
pub(crate) fn scrobble_mark_sent(conn: &Connection, ids: &[i64]) -> Result<(), rusqlite::Error> {
    for id in ids {
        conn.execute(
            "UPDATE scrobbles SET status = 'sent', attempts = attempts + 1, reason = NULL
              WHERE id = ?1",
            params![id],
        )?;
    }
    Ok(())
}

/// 标记这次失败：还有重试机会就退避，用尽则标 `dead`。
///
/// 返回是否已彻底放弃（供冲刷器统计）。退避是指数式的：`2^attempts` 分钟，
/// 上限 6 小时 —— 对方长时间 5xx 时不该每 30 秒捶一次。
pub(crate) fn scrobble_mark_failure(
    conn: &Connection,
    id: i64,
    attempts: i64,
    reason: &str,
) -> Result<bool, rusqlite::Error> {
    let attempts = attempts + 1;
    if attempts >= MAX_ATTEMPTS {
        conn.execute(
            "UPDATE scrobbles SET status = 'dead', attempts = ?2, reason = ?3 WHERE id = ?1",
            params![id, attempts, reason],
        )?;
        return Ok(true);
    }
    let backoff_min = (1i64 << attempts.min(12)).min(360);
    let next_at = now_ms() / 1000 + backoff_min * 60;
    conn.execute(
        "UPDATE scrobbles SET attempts = ?2, next_at = ?3, reason = ?4 WHERE id = ?1",
        params![id, attempts, next_at, reason],
    )?;
    Ok(false)
}

/// 标记彻底放弃（鉴权错误这类重试无意义的失败，直接判死）。
pub(crate) fn scrobble_mark_dead(
    conn: &Connection,
    id: i64,
    reason: &str,
) -> Result<bool, rusqlite::Error> {
    conn.execute(
        "UPDATE scrobbles SET status = 'dead', attempts = attempts + 1, reason = ?2 WHERE id = ?1",
        params![id, reason],
    )?;
    Ok(true)
}

/// 待发条数（后台循环判断要不要flush）。
pub(crate) fn scrobble_pending_count(conn: &Connection) -> Result<i64, rusqlite::Error> {
    conn.query_row(
        "SELECT COUNT(*) FROM scrobbles WHERE status = 'pending'",
        [],
        |r| r.get(0),
    )
}

/// 队列概览。
pub(crate) fn scrobble_stats(conn: &Connection) -> Result<ScrobbleQueueStats, rusqlite::Error> {
    let mut out = ScrobbleQueueStats::default();
    let mut stmt = conn.prepare("SELECT status, COUNT(*) FROM scrobbles GROUP BY status")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    for row in rows {
        let (status, n) = row?;
        match status.as_str() {
            "pending" => out.pending = n,
            "sent" => out.sent = n,
            "dead" => out.dead = n,
            _ => {}
        }
    }
    out.last_error = conn
        .query_row(
            "SELECT reason FROM scrobbles
              WHERE reason IS NOT NULL AND reason <> ''
              ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    Ok(out)
}

/// 清队列（断开某个目标时清该目标的行；`None` = 全清）。
pub(crate) fn scrobble_clear(conn: &Connection, target: Option<&str>) -> Result<usize, rusqlite::Error> {
    match target {
        Some(t) => conn.execute("DELETE FROM scrobbles WHERE target = ?1", params![t]),
        None => conn.execute("DELETE FROM scrobbles", []),
    }
}

/// 只保留最近 [`KEEP_SENT`] 条已发记录，其余删掉（每次冲刷后调一次）。
pub(crate) fn scrobble_prune_sent(conn: &Connection) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "DELETE FROM scrobbles
          WHERE status = 'sent'
            AND id NOT IN (SELECT id FROM scrobbles WHERE status = 'sent' ORDER BY id DESC LIMIT ?1)",
        params![KEEP_SENT],
    )
}

/// 最近几条已发 / 待发记录（设置页「最近上报」用）。
pub(crate) fn scrobble_recent(
    conn: &Connection,
    limit: usize,
) -> Result<Vec<(String, String, String, i64)>, rusqlite::Error> {
    let limit = limit.clamp(1, 50) as i64;
    let mut stmt = conn.prepare(
        "SELECT target, artist, title, played_at FROM scrobbles
          ORDER BY played_at DESC, id DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::store::tests::{new_conn, sample_track_with};

    fn track() -> Track {
        sample_track_with("晴天", "周杰伦")
    }

    /// 同一次收听重复结算只留一行：同一个 (target, track_id, played_at) 撞 UNIQUE。
    #[test]
    fn enqueue_is_idempotent_per_session() {
        let conn = new_conn();
        let t = track();
        assert!(scrobble_enqueue(&conn, TARGET_LASTFM, &t, 1_700_000_000, 269_000).unwrap());
        assert!(
            !scrobble_enqueue(&conn, TARGET_LASTFM, &t, 1_700_000_000, 269_000).unwrap(),
            "同一会话重复入队不该再插一行"
        );
        // 换个开始时间 = 另一次收听
        assert!(scrobble_enqueue(&conn, TARGET_LASTFM, &t, 1_700_001_000, 269_000).unwrap());
        // 换目标各记各的
        assert!(scrobble_enqueue(&conn, TARGET_LISTENBRAINZ, &t, 1_700_000_000, 269_000).unwrap());
        assert_eq!(scrobble_stats(&conn).unwrap().pending, 3);
    }

    /// 缺歌手 / 标题的行不入队：Last.fm 与 ListenBrainz 都会直接 400。
    #[test]
    fn enqueue_rejects_incomplete_tracks() {
        let conn = new_conn();
        let mut t = track();
        t.singer = "  ".into();
        assert!(!scrobble_enqueue(&conn, TARGET_LASTFM, &t, 1, 1000).unwrap());
        assert_eq!(scrobble_stats(&conn).unwrap().pending, 0);
    }

    /// 退避中的行不取；到点才取。
    #[test]
    fn due_skips_backed_off_rows() {
        let conn = new_conn();
        let t = track();
        scrobble_enqueue(&conn, TARGET_LASTFM, &t, 1_700_000_000, 269_000).unwrap();
        let now = now_ms() / 1000;
        assert_eq!(scrobble_due(&conn, now, 10).unwrap().len(), 1, "刚入队应该能取");

        let row = scrobble_due(&conn, now, 10).unwrap().remove(0);
        let dead = scrobble_mark_failure(&conn, row.id, row.attempts, "网络错误").unwrap();
        assert!(!dead, "第一次失败只是退避");
        assert_eq!(scrobble_due(&conn, now, 10).unwrap().len(), 0, "退避期内不该被取");
        assert_eq!(
            scrobble_due(&conn, now + 24 * 3600, 10).unwrap().len(),
            1,
            "退避到期后应重新可取"
        );
        assert_eq!(scrobble_stats(&conn).unwrap().last_error.as_deref(), Some("网络错误"));
    }

    /// 用尽重试次数后标 dead，不再出现在 due 里。
    #[test]
    fn mark_failure_gives_up_at_max_attempts() {
        let conn = new_conn();
        scrobble_enqueue(&conn, TARGET_LASTFM, &track(), 1_700_000_000, 269_000).unwrap();
        let id = scrobble_due(&conn, now_ms() / 1000, 10).unwrap()[0].id;
        let mut dead = false;
        for attempt in 0..MAX_ATTEMPTS {
            dead = scrobble_mark_failure(&conn, id, attempt, "502").unwrap();
        }
        assert!(dead, "到达 MAX_ATTEMPTS 必须放弃");
        assert_eq!(scrobble_due(&conn, now_ms() / 1000 + 365 * 24 * 3600, 10).unwrap().len(), 0);
        let s = scrobble_stats(&conn).unwrap();
        assert_eq!((s.pending, s.dead), (0, 1));
    }

    /// 发成功后转 sent，不再被取；`clear` 按目标清。
    #[test]
    fn mark_sent_and_clear_by_target() {
        let conn = new_conn();
        let t = track();
        scrobble_enqueue(&conn, TARGET_LASTFM, &t, 1_700_000_000, 269_000).unwrap();
        scrobble_enqueue(&conn, TARGET_LISTENBRAINZ, &t, 1_700_000_000, 269_000).unwrap();
        let fm = scrobble_due(&conn, now_ms() / 1000, 10)
            .unwrap()
            .into_iter()
            .filter(|r| r.target == TARGET_LASTFM)
            .collect::<Vec<_>>();
        scrobble_mark_sent(&conn, &[fm[0].id]).unwrap();
        assert_eq!(scrobble_stats(&conn).unwrap().sent, 1);
        assert_eq!(
            scrobble_due(&conn, now_ms() / 1000, 10).unwrap().len(),
            1,
            "已发的行不该再被取"
        );

        assert_eq!(scrobble_clear(&conn, Some(TARGET_LISTENBRAINZ)).unwrap(), 1);
        let s = scrobble_stats(&conn).unwrap();
        assert_eq!((s.pending, s.sent), (0, 1));
    }

    /// `recent` 按开始时间倒序，供设置页展示。
    #[test]
    fn recent_orders_by_played_at() {
        let conn = new_conn();
        let t = track();
        scrobble_enqueue(&conn, TARGET_LASTFM, &t, 1_700_000_000, 269_000).unwrap();
        scrobble_enqueue(&conn, TARGET_LASTFM, &t, 1_700_005_000, 269_000).unwrap();
        let rows = scrobble_recent(&conn, 5).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].3, 1_700_005_000, "最近一次在最前");
        assert_eq!((rows[0].1.as_str(), rows[0].2.as_str()), ("周杰伦", "晴天"));
    }
}
