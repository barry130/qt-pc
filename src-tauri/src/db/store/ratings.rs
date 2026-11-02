//! 评分域：`track_ratings` 表（A6，2026-11-01）。
//!
//! ## 为什么是 1–5 星 + 0 = 清除
//! 主流播放器（foobar2000 / MusicBee / 网易云）都是五星制；`0` 在存储层等价于
//! 「没有这一行」，所以清除评分走 DELETE 而不是写 0 —— 表里只留用户真正表达过
//! 意见的曲目，`rating >= 4` 这类筛选也不用额外排除 0。
//!
//! ## 键的口径
//! `platform:id`（与 `tracks.id`、`download_files.key` 同一字符串）。不挂外键：
//! 曲目被清出曲库不该抹掉用户偏好，评分表与曲库生命周期解耦。
//!
//! ## 调用方
//! - 行内 / 播放页的星级按钮（`set_track_rating` 立即落库，界面乐观更新）；
//! - 列表批量回显（`get_track_ratings` 一次取一屏，避免 N 次 IPC）；
//! - 智能歌单（A5）与库维护（B11）按星级筛选（`rated_keys_at_least`）。

use std::collections::HashMap;

use rusqlite::{params, Connection};

use super::now_ms;

/// 最低有效星级（0 表示清除）。
pub(crate) const MIN_RATING: i64 = 1;
/// 最高星级。
pub(crate) const MAX_RATING: i64 = 5;
/// `IN (…)` 单次最多绑定的参数个数。SQLite 默认上限 999，留出余量。
const KEYS_PER_QUERY: usize = 400;

/// 写入 / 更新 / 清除一首歌的评分。
///
/// `rating <= 0` 或空键 → 删除该行（幂等）。超过 5 的输入按 5 存（前端只发
/// 1–5，这里钳一下是为了挡住手改 IPC 的调用）。
pub(crate) fn set_track_rating(
    conn: &Connection,
    key: &str,
    rating: i64,
) -> Result<(), rusqlite::Error> {
    let key = key.trim();
    if key.is_empty() {
        return Ok(());
    }
    if rating < MIN_RATING {
        conn.execute("DELETE FROM track_ratings WHERE key = ?1", params![key])?;
        return Ok(());
    }
    let rating = rating.min(MAX_RATING);
    conn.execute(
        "INSERT INTO track_ratings (key, rating, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at",
        params![key, rating, now_ms()],
    )?;
    Ok(())
}

/// 批量读取评分（只返回有评分的键）。
///
/// 列表页一次给一屏曲目（几十到几百个键），分块拼 `IN (…)`：SQLite 的绑定参数
/// 上限是 999，整屏一次性拼会在长列表上炸。
pub(crate) fn get_track_ratings(
    conn: &Connection,
    keys: &[String],
) -> Result<HashMap<String, i64>, rusqlite::Error> {
    let mut out = HashMap::new();
    for chunk in keys.chunks(KEYS_PER_QUERY) {
        let clean: Vec<&str> = chunk
            .iter()
            .map(|k| k.trim())
            .filter(|k| !k.is_empty())
            .collect();
        if clean.is_empty() {
            continue;
        }
        // 占位符按实际条数生成：`?,?,?`
        let placeholders = vec!["?"; clean.len()].join(",");
        let sql = format!("SELECT key, rating FROM track_ratings WHERE key IN ({placeholders})");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(clean.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (key, rating) = row?;
            out.insert(key, rating);
        }
    }
    Ok(out)
}

/// 评分不低于 `min_rating` 的全部键（按评分降序、更新时间降序）。
///
/// 智能歌单的 `rating >= N` 条件与库维护的「按星级整理」共用这一份口径：
/// 排序稳定，同样星级里最近打分的排前面。
pub(crate) fn rated_keys_at_least(
    conn: &Connection,
    min_rating: i64,
) -> Result<Vec<String>, rusqlite::Error> {
    let min = min_rating.clamp(MIN_RATING, MAX_RATING);
    let mut stmt = conn.prepare(
        "SELECT key FROM track_ratings WHERE rating >= ?1
         ORDER BY rating DESC, updated_at DESC",
    )?;
    let rows = stmt.query_map(params![min], |row| row.get::<_, String>(0))?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::store::tests::new_conn;

    /// 写入 → 读回 → 改分 → 清除，四个动作都在同一行上收敛。
    #[test]
    fn rating_roundtrip() {
        let conn = new_conn();
        set_track_rating(&conn, "qq:abc", 4).expect("set");
        let map = get_track_ratings(&conn, &["qq:abc".to_string()]).expect("get");
        assert_eq!(map.get("qq:abc"), Some(&4));

        // 改分：同一键只保留一行
        set_track_rating(&conn, "qq:abc", 2).expect("update");
        let map = get_track_ratings(&conn, &["qq:abc".to_string()]).expect("get");
        assert_eq!(map.get("qq:abc"), Some(&2));
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM track_ratings", [], |r| r.get(0))
            .expect("count");
        assert_eq!(rows, 1);

        // 清除：DELETE 而不是写 0
        set_track_rating(&conn, "qq:abc", 0).expect("clear");
        let map = get_track_ratings(&conn, &["qq:abc".to_string()]).expect("get");
        assert!(map.is_empty());
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM track_ratings", [], |r| r.get(0))
            .expect("count");
        assert_eq!(rows, 0);
    }

    /// 超出 1–5 的输入钳到边界，空键直接忽略（手改 IPC 的兜底）。
    #[test]
    fn rating_is_clamped_and_key_trimmed() {
        let conn = new_conn();
        set_track_rating(&conn, "  wyy:x  ", 9).expect("set");
        let map = get_track_ratings(&conn, &["wyy:x".to_string()]).expect("get");
        assert_eq!(map.get("wyy:x"), Some(&5));

        set_track_rating(&conn, "   ", 3).expect("empty key is a no-op");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM track_ratings", [], |r| r.get(0))
            .expect("count");
        assert_eq!(rows, 1);
    }

    /// 批量读取只回答问到的键；未打分的键不出现在结果里（前端据此"没有就是 0 星"）。
    #[test]
    fn batch_read_returns_only_rated_keys() {
        let conn = new_conn();
        set_track_rating(&conn, "qq:a", 5).expect("set a");
        set_track_rating(&conn, "qq:b", 1).expect("set b");
        let keys = vec![
            "qq:a".to_string(),
            "qq:b".to_string(),
            "qq:c".to_string(),
        ];
        let map = get_track_ratings(&conn, &keys).expect("get");
        assert_eq!(map.len(), 2);
        assert_eq!(map.get("qq:c"), None);
    }

    /// `rating >= N` 筛选按星级降序，供智能歌单与库维护共用。
    #[test]
    fn rated_keys_at_least_sorted_by_rating() {
        let conn = new_conn();
        set_track_rating(&conn, "qq:low", 2).expect("set");
        set_track_rating(&conn, "qq:high", 5).expect("set");
        set_track_rating(&conn, "qq:mid", 3).expect("set");

        let all = rated_keys_at_least(&conn, 1).expect("list");
        assert_eq!(all, vec!["qq:high", "qq:mid", "qq:low"]);

        let top = rated_keys_at_least(&conn, 4).expect("list");
        assert_eq!(top, vec!["qq:high"]);
    }
}
