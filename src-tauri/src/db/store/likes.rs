//! 收藏域（DESIGN §5.3 / LIKE_SYNC_DESIGN.md）：`liked_songs` 收藏、
//! `liked_playlists` 云端歌单卡片、`pending_like_ops` 离线重放队列、
//! 账号切换（全清）与登出（只清同步状态）的复位。
//!
//! 拆自原 `db/store.rs`（P2-7），函数体与 SQL 一行未改。
//! 收藏必须挂在歌单下（v5「无归属不加载」），所以本域与 `playlists` 域互相
//! 调用：加歌进歌单走 `playlists::add_tracks_to_playlist` → `add_liked_song`。

use rusqlite::{params, Connection, OptionalExtension};

use crate::provider::types::Track;

// 跨域共享的小工具（`db_track_id` / `now_ms` / `track_from_row` / `LOCAL_PLATFORM` …）
// 由 store/mod.rs 统一再导出，这里一次性引入，省得每个域各写一长串 use。
use super::*;
/// 收藏一首歌到某个歌单（幂等）。曲目本体先入库，
/// 本地曲目由扫描器（§13）负责，`upsert_tracks` 内部会跳过。
///
/// `pid` 是归属歌单的永久标识（见模块头的 (platform, pid) 约定），**必传**：
/// 没有歌单的歌不入库（v5 起"无归属不加载"）。
/// 一首歌可以同时挂在多个歌单（v6 起多对多）：
/// `liked_songs` 行本身只存一份（主归属 pid = 本次收藏的歌单），
/// 完整归属在 `liked_song_playlists` 关联表里。
pub(crate) fn add_liked_song(
    conn: &Connection,
    track: &Track,
    pid: &str,
) -> Result<(), rusqlite::Error> {
    upsert_tracks(conn, &[track])?;
    let now = now_ms();
    conn.execute(
        "INSERT INTO liked_songs (id, uid, sid, platform, name, singer, album, hash, pid,
                                  updated_seq, updated_at, created_at)
         VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)
         ON CONFLICT(uid, platform, sid) DO UPDATE SET
           name = excluded.name,
           singer = excluded.singer,
           album = excluded.album,
           hash = excluded.hash,
           pid = excluded.pid,
           deleted_at = NULL,
           updated_at = excluded.updated_at",
        params![
            db_track_id(track),
            track.id,
            track.platform.to_string(),
            track.title,
            track.singer,
            track.album,
            track.music_id.as_deref(),
            pid,
            now,
        ],
    )?;
    // 多归属：追加这条歌单关联（已存在则刷新时间，保持幂等）
    conn.execute(
        "INSERT INTO liked_song_playlists (song_id, pid, added_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(song_id, pid) DO UPDATE SET added_at = excluded.added_at",
        params![db_track_id(track), pid, now],
    )?;
    Ok(())
}

/// 从某个歌单移除一首歌的结果，决定云端推送动作。
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum LikeRemoveOutcome {
    /// 关联全部摘光，歌本体已下线 → 云端也删（remove）
    RemovedAll,
    /// 主归属切换到该 pid（摘的是主归属，歌还有别的归属）→ 云端 push add(新 pid)
    Rebound(String),
    /// 只摘掉了非主归属歌单 → 云端无需变化
    DetachedOnly,
}

/// 从某个歌单移除一首歌（多归属下只摘掉这一条关联）。
/// 关联全部摘光后，歌曲本体同步下线（没有歌单的歌不加载，v5 规则）。
/// `pid` 为 `None` 表示整首取消收藏（所有归属一起下线）。
pub(crate) fn remove_liked_song(
    conn: &Connection,
    track: &Track,
    pid: Option<&str>,
) -> Result<LikeRemoveOutcome, rusqlite::Error> {
    let now = now_ms();
    let db_id = db_track_id(track);
    match pid {
        Some(p) => {
            // 记下摘除前的主归属（没有活跃行时视为无归属）
            let current_main: Option<String> = conn
                .query_row(
                    "SELECT pid FROM liked_songs
                      WHERE id = ?1 AND deleted_at IS NULL",
                    params![db_id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            conn.execute(
                "DELETE FROM liked_song_playlists WHERE song_id = ?1 AND pid = ?2",
                params![db_id, p],
            )?;
            let remaining: Option<String> = conn
                .query_row(
                    "SELECT pid FROM liked_song_playlists WHERE song_id = ?1 LIMIT 1",
                    params![db_id],
                    |r| r.get(0),
                )
                .optional()?;
            match remaining {
                Some(next) => {
                    // 摘的是主归属 → 切到剩余的；摘的不是主归属 → 云端无感
                    if current_main.as_deref() == Some(p) {
                        conn.execute(
                            "UPDATE liked_songs SET pid = ?1 WHERE id = ?2",
                            params![next, db_id],
                        )?;
                        Ok(LikeRemoveOutcome::Rebound(next))
                    } else {
                        Ok(LikeRemoveOutcome::DetachedOnly)
                    }
                }
                None => {
                    // 最后一个歌单也摘了 → 整首下线（同步语义保留）
                    conn.execute(
                        "UPDATE liked_songs SET deleted_at = ?1 WHERE id = ?2",
                        params![now, db_id],
                    )?;
                    // 老关系表一并清掉，免得 legacy 分支把歌又补回来
                    conn.execute(
                        "DELETE FROM playlist_tracks WHERE track_id = ?1",
                        params![db_id],
                    )?;
                    Ok(LikeRemoveOutcome::RemovedAll)
                }
            }
        }
        None => {
            // 整首取消收藏：所有归属一起下线
            conn.execute(
                "DELETE FROM liked_song_playlists WHERE song_id = ?1",
                params![db_id],
            )?;
            conn.execute(
                "UPDATE liked_songs SET deleted_at = ?1
                  WHERE sid = ?2 AND platform = ?3 AND deleted_at IS NULL",
                params![now, track.id, track.platform.to_string()],
            )?;
            conn.execute(
                "DELETE FROM playlist_tracks WHERE track_id = ?1",
                params![db_id],
            )?;
            Ok(LikeRemoveOutcome::RemovedAll)
        }
    }
}

/// 这首歌挂在哪些歌单下（返回 pid 列表，**多归属**）。
pub(crate) fn list_track_playlists(
    conn: &Connection,
    track: &Track,
) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT pid FROM liked_song_playlists WHERE song_id = ?1
         UNION
         SELECT pid FROM liked_songs
          WHERE sid = ?2 AND platform = ?3 AND deleted_at IS NULL",
    )?;
    let rows = stmt.query_map(
        params![db_track_id(track), track.id, track.platform.to_string(),],
        |r| r.get::<_, String>(0),
    )?;
    rows.collect()
}

pub(crate) fn is_liked_song(conn: &Connection, track: &Track) -> Result<bool, rusqlite::Error> {
    let hit: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM liked_songs
              WHERE sid = ?1 AND platform = ?2 AND deleted_at IS NULL",
            params![track.id, track.platform.to_string()],
            |row| row.get(0),
        )
        .optional()?;
    Ok(hit.is_some())
}

/// 收藏列表（按收藏时间倒序）。Join tracks 补齐时长等信息；
/// tracks 缺行时（本地曲目尚未扫描入库）用 liked_songs 自带字段兜底。
///
/// `pid` 为 `Some` 时只取该歌单下的曲目（走多归属关联表，歌单详情走这条路径），
/// `None` 取全部收藏。
pub(crate) fn list_liked_songs(
    conn: &Connection,
    pid: Option<&str>,
) -> Result<Vec<Track>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT l.sid, l.platform, l.name, l.singer, l.album, t.pic_url,
                t.duration_ms, t.music_id
           FROM liked_songs l
           LEFT JOIN tracks t ON t.id = l.id
          WHERE l.deleted_at IS NULL
            AND (?1 IS NULL OR l.id IN
                 (SELECT song_id FROM liked_song_playlists WHERE pid = ?1))
          ORDER BY l.created_at DESC",
    )?;
    let mut rows = stmt.query(params![pid])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        if let Some(track) = track_from_row(row)? {
            out.push(track);
        }
    }
    Ok(out)
}

/// 启动对账用：未删除收藏的原始行（含主归属 pid），字段全量带出，
/// 补推 /like/song 的请求体需要这些。返回
/// (sid, platform, name, singer, album, hash, pic_url, 主归属 pid)。
pub(crate) fn list_liked_songs_raw(
    conn: &Connection,
) -> Result<
    Vec<(
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
    )>,
    rusqlite::Error,
> {
    let mut stmt = conn.prepare(
        "SELECT l.sid, l.platform, l.name, l.singer, l.album,
                COALESCE(t.pic_url, ''), l.hash, COALESCE(l.pid, '')
           FROM liked_songs l
           LEFT JOIN tracks t ON t.id = l.id
          WHERE l.deleted_at IS NULL",
    )?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get::<_, Option<String>>(6)?.unwrap_or_default(),
            row.get(5)?,
            row.get(7)?,
        ));
    }
    Ok(out)
}

// ---------- 收藏的在线歌单（DESIGN §5.3，schema v2） ----------
//
// 只存歌单元信息快照（不存曲目）：曲目在点开时向音源取，
// 免得本地存一份必然过期的副本。收藏/取消与歌曲收藏同一套同步机制。

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LikedPlaylist {
    pub id: String,
    pub platform: String,
    pub name: String,
    pub pic_url: String,
    pub play_count: String,
    pub created_at: i64,
}

fn liked_playlist_id(platform: &str, pid: &str) -> String {
    format!("{platform}:{pid}")
}

/// 收藏歌单（幂等）。封面为空时不覆盖已有值，避免把攒下的封面抹掉。
pub(crate) fn add_liked_playlist(
    conn: &Connection,
    platform: &str,
    pid: &str,
    name: &str,
    pic_url: &str,
    _play_count: &str,
) -> Result<(), rusqlite::Error> {
    // uid 固定 0，与 add_liked_song 同口径（本地收藏不区分账号，uid 是后端的概念）。
    // 表里也没有 play_count 列 —— 歌单的播放数属于音源数据，不落快照。
    let id = liked_playlist_id(platform, pid);
    let now = now_ms();
    conn.execute(
        "INSERT INTO liked_playlists (id, uid, pid, platform, name, pic_url,
                                      updated_seq, updated_at, created_at)
         VALUES (?1, 0, ?2, ?3, ?4, ?5, 0, ?6, ?6)
         ON CONFLICT(uid, platform, pid) DO UPDATE SET
           name = excluded.name,
           pic_url = COALESCE(NULLIF(excluded.pic_url, ''), liked_playlists.pic_url),
           deleted_at = NULL,
           updated_at = excluded.updated_at",
        params![id, pid, platform, name, pic_url, now],
    )?;
    Ok(())
}

pub(crate) fn remove_liked_playlist(
    conn: &Connection,
    platform: &str,
    pid: &str,
) -> Result<(), rusqlite::Error> {
    let id = liked_playlist_id(platform, pid);
    conn.execute("DELETE FROM liked_playlists WHERE id = ?1", params![id])?;
    Ok(())
}

pub(crate) fn is_liked_playlist(
    conn: &Connection,
    platform: &str,
    pid: &str,
) -> Result<bool, rusqlite::Error> {
    let id = liked_playlist_id(platform, pid);
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM liked_playlists WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// 收藏的歌单（按收藏时间倒序）
pub(crate) fn list_liked_playlists(
    conn: &Connection,
) -> Result<Vec<LikedPlaylist>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT pid, platform, name, pic_url, created_at
           FROM liked_playlists
          ORDER BY created_at DESC",
    )?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(LikedPlaylist {
            id: row.get(0)?,
            platform: row.get(1)?,
            name: row.get(2)?,
            pic_url: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            // 表里不存播放数，列表页展示时退化为「在线歌单」
            play_count: String::new(),
            created_at: row.get(4)?,
        });
    }
    Ok(out)
}

// ---------- 收藏推送离线队列（LIKE_SYNC_DESIGN.md §3 pendingOps 的 PC 版） ----------
//
// v1 建表时就预留了 pending_like_ops（当时未启用）：本地收藏写库成功、
// 云端推送失败（断网 / 后端不可达）的操作落在这里，登录后或网络恢复时
// 由 flush_pending_like_ops 按序重放。云端按 (sid,pid)/(uid,pid,platform)
// upsert 幂等，重复执行安全。
// 去重规则：同一目标键的最新操作胜出 —— 新 add 覆盖旧 remove、
// 新 remove 覆盖旧 add（重放后到者生效，等价移动端队列的顺序语义）。

/// 账号切换时清空本地收藏（LIKE_SYNC_DESIGN.md §6 的 PC 版）：
/// 收藏歌曲 / 歌单卡片 / 自建歌单 / 多归属关联 / 离线队列全清，
/// 游标与全量导入标记复位（下次登录自动全量拉取新账号数据）。
/// 播放历史、下载等设备级数据不动。返回清掉的行数（诊断用）。
pub(crate) fn clear_like_local(conn: &Connection) -> Result<i64, rusqlite::Error> {
    ensure_pending_like_ops_table(conn)?;
    let mut n = 0i64;
    for sql in [
        "DELETE FROM liked_song_playlists",
        "DELETE FROM liked_songs",
        "DELETE FROM liked_playlists",
        "DELETE FROM playlists",
        "DELETE FROM pending_like_ops",
        "DELETE FROM pending_like_targets",
    ] {
        n += conn.execute(sql, [])? as i64;
    }
    set_setting(conn, "like.sync.seq", "")?;
    set_setting(conn, "like.imported", "")?;
    Ok(n)
}

/// 退出登录时重置收藏同步状态（保留收藏数据与账号归属标记，同账号重登无缝）：
/// 清离线队列 + 游标 + 全量导入标记，下次登录自动走全量拉取合并。
pub(crate) fn reset_like_sync_state(conn: &Connection) -> Result<(), rusqlite::Error> {
    ensure_pending_like_ops_table(conn)?;
    conn.execute("DELETE FROM pending_like_ops", [])?;
    conn.execute("DELETE FROM pending_like_targets", [])?;
    set_setting(conn, "like.sync.seq", "")?;
    set_setting(conn, "like.imported", "")?;
    Ok(())
}

/// 推送队列条目。payload_json 是 `/like/song` 或 `/like/playlist` 的请求体。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingLikeOp {
    pub id: String,
    /// "song" | "playlist"
    pub kind: String,
    pub action: String,
    pub payload_json: String,
    pub retry_count: i64,
    pub next_retry_at: Option<i64>,
    pub created_at: i64,
}

/// 入队（或覆盖同目标键的旧操作）。`target_key` 是去重键：
/// song 用 `song:{platform}:{sid}`，playlist 用 `playlist:{platform}:{pid}`。
pub(crate) fn enqueue_pending_like_op(
    conn: &Connection,
    kind: &str,
    action: &str,
    target_key: &str,
    payload_json: &str,
) -> Result<(), rusqlite::Error> {
    // 历史版本建库可能没有这张表（v1 schema 只在全新库完整执行）
    ensure_pending_like_ops_table(conn)?;
    let now = now_ms();
    let id = crate::db::migrations::new_uuid_v4();
    // 同键旧操作直接作废（新操作重放后就是最终状态）
    conn.execute(
        "DELETE FROM pending_like_ops WHERE id IN (SELECT target_id FROM pending_like_targets WHERE target_key = ?1)",
        params![target_key],
    )?;
    conn.execute(
        "INSERT INTO pending_like_ops (id, uid, type, action, payload_json, retry_count, created_at)
         VALUES (?1, 0, ?2, ?3, ?4, 0, ?5)",
        params![id, kind, action, payload_json, now],
    )?;
    conn.execute(
        "INSERT INTO pending_like_targets (target_key, target_id) VALUES (?1, ?2)
         ON CONFLICT(target_key) DO UPDATE SET target_id = excluded.target_id",
        params![target_key, id],
    )?;
    Ok(())
}

/// 取待重放的操作（按入队顺序）。为空返回空 Vec。
pub(crate) fn list_pending_like_ops(
    conn: &Connection,
) -> Result<Vec<PendingLikeOp>, rusqlite::Error> {
    ensure_pending_like_ops_table(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, type, action, payload_json, retry_count, next_retry_at, created_at
           FROM pending_like_ops ORDER BY created_at ASC",
    )?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push(PendingLikeOp {
            id: row.get(0)?,
            kind: row.get(1)?,
            action: row.get(2)?,
            payload_json: row.get(3)?,
            retry_count: row.get(4)?,
            next_retry_at: row.get(5)?,
            created_at: row.get(6)?,
        });
    }
    Ok(out)
}

/// 重放成功：删除队列条目和它的去重键。
pub(crate) fn ack_pending_like_op(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM pending_like_ops WHERE id = ?1", params![id])?;
    conn.execute(
        "DELETE FROM pending_like_targets WHERE target_id = ?1",
        params![id],
    )?;
    Ok(())
}

/// 重放失败：记次数并退避（1/2/4/8…分钟，封顶 30 分钟）。
pub(crate) fn defer_pending_like_op(
    conn: &Connection,
    id: &str,
    retries: i64,
) -> Result<(), rusqlite::Error> {
    let backoff_ms = std::cmp::min(60_000i64 * (1 << retries.min(5)), 30 * 60_000).max(60_000);
    conn.execute(
        "UPDATE pending_like_ops
            SET retry_count = ?2, next_retry_at = ?3
          WHERE id = ?1",
        params![id, retries + 1, now_ms() + backoff_ms],
    )?;
    Ok(())
}

/// 队列条目数（诊断用）。
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn count_pending_like_ops(conn: &Connection) -> Result<i64, rusqlite::Error> {
    ensure_pending_like_ops_table(conn)?;
    conn.query_row("SELECT COUNT(*) FROM pending_like_ops", [], |r| r.get(0))
}

/// 老库兜底建表（与 v1 schema 同构；幂等）。
/// v1 的 CREATE TABLE 只在全新库执行，老库若因故缺表，这里补上。
fn ensure_pending_like_ops_table(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS pending_like_ops (
           id TEXT PRIMARY KEY,
           uid INTEGER NOT NULL,
           type TEXT NOT NULL,
           action TEXT NOT NULL,
           payload_json TEXT NOT NULL,
           retry_count INTEGER NOT NULL DEFAULT 0,
           next_retry_at INTEGER,
           created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_pending_like_ops_retry
           ON pending_like_ops(uid, next_retry_at);
         CREATE TABLE IF NOT EXISTS pending_like_targets (
           target_key TEXT PRIMARY KEY,
           target_id  TEXT NOT NULL
         );",
    )?;
    Ok(())
}
