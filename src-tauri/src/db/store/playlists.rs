//! 歌单域（DESIGN §5.3）：`playlists` 自建歌单 CRUD、归属关联、
//! 云端确认点（`cloud_seq`，LIKE_SYNC_DESIGN.md §5 机制 B）、
//! 「我的歌单」合并视图、歌单内曲目增删。
//!
//! 拆自原 `db/store.rs`（P2-7），函数体与 SQL 一行未改。

use rusqlite::{params, Connection, OptionalExtension};

use crate::provider::types::Track;

// 跨域共享的小工具（`db_track_id` / `now_ms` / `track_from_row` / `LOCAL_PLATFORM` …）
// 由 store/mod.rs 统一再导出，这里一次性引入，省得每个域各写一长串 use。
use super::*;
// ---------- 我的歌单（本地自建 + 云端同步卡片，合并视图；DESIGN §5.3） ----------
//
// 歌单只有两个来源（v5 起无默认歌单）：
// - **云端卡片**（liked_playlists，含 platform=local 的「我喜欢的歌曲」）；
// - **本地自建**（playlists，platform 恒为 local）。
// 收藏歌曲按 pid 归属；pid 找不到歌单的歌不加载。

/// 合并视图用的就是 PlaylistSummary：platform 区分来源
pub type MyPlaylist = PlaylistSummary;

/// 我的歌单 = 云端卡片歌单 + 本地自建歌单（按 pid 去重），按创建时间倒序。
#[allow(dead_code)]
pub(crate) fn list_my_playlists(conn: &Connection) -> Result<Vec<MyPlaylist>, rusqlite::Error> {
    use std::collections::HashMap;

    // pid → 行（云端卡片先铺底，自建歌单覆盖同名条目并标记 is_local）
    let mut by_pid: HashMap<String, MyPlaylist> = HashMap::new();

    // 1) 云端同步回来的卡片（含 platform=local 的「我喜欢的歌曲」）。
    //    在线音源歌单的曲目不落本地，点开时向音源取，所以 track_count 给 0；
    //    platform=local 的卡片曲目就在本地 liked_songs 里，实时数。
    {
        let mut stmt = conn.prepare(
            "SELECT pid, platform, name, COALESCE(pic_url, ''), created_at, updated_at
               FROM liked_playlists
              WHERE deleted_at IS NULL
              ORDER BY created_at DESC",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let pid: String = row.get(0)?;
            let platform: String = row.get(1)?;
            let track_count = if platform == LOCAL_PLATFORM {
                conn.query_row(
                    "SELECT COUNT(*) FROM liked_songs
                      WHERE deleted_at IS NULL
                        AND id IN (SELECT song_id FROM liked_song_playlists WHERE pid = ?1)",
                    params![pid],
                    |r| r.get(0),
                )
                .unwrap_or(0)
            } else {
                0
            };
            by_pid.insert(
                pid.clone(),
                MyPlaylist {
                    id: pid.clone(),
                    pid: pid.clone(),
                    platform: platform.clone(),
                    name: row.get(2)?,
                    pic_url: row.get(3)?,
                    track_count,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    is_local: false,
                },
            );
        }
    }

    // 2) 本地自建歌单：覆盖同 pid 的云端卡片（本地行有老关系表/封面等信息）。
    //    曲目 = 挂在该 pid 下的收藏（liked_songs.pid）实时数。
    {
        let mut stmt = conn.prepare(
            "SELECT p.id, p.pid, p.name,
                    COALESCE(p.cover_path, ''),
                    (SELECT COUNT(*) FROM liked_songs ls
                      WHERE ls.pid = p.pid AND ls.deleted_at IS NULL
                      AND ls.id IN (SELECT song_id FROM liked_song_playlists WHERE pid = p.pid))
                    + (SELECT COUNT(*) FROM playlist_tracks pt
                        WHERE pt.playlist_id = p.id
                          AND NOT EXISTS (SELECT 1 FROM liked_songs ls2
                                           WHERE ls2.id = pt.track_id AND ls2.deleted_at IS NULL)),
                    p.created_at
               FROM playlists p
              ORDER BY p.created_at DESC",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let pid: String = row.get(1)?;
            by_pid.insert(
                pid.clone(),
                MyPlaylist {
                    id: row.get(0)?,
                    pid: pid.clone(),
                    platform: LOCAL_PLATFORM.to_string(),
                    name: row.get(2)?,
                    pic_url: row.get(3)?,
                    track_count: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(5)?,
                    is_local: true,
                },
            );
        }
    }

    let mut out: Vec<MyPlaylist> = by_pid.into_values().collect();
    out.sort_by_key(|a| std::cmp::Reverse(a.created_at));
    Ok(out)
}

// ---------- 我的歌单（DESIGN §5.3） ----------

/// 我的歌单摘要。`track_count` 由 playlist_tracks 聚合而来。
///
/// 合并了两种来源（DESIGN §5.3）：`platform` 为 `"local"` 是本地创建的，
/// 其余（qq / wyy / kw / kg）是在线收藏的歌单。在线歌单的曲目不落本地，
/// 点开时向音源取，所以 `track_count` 为 0。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSummary {
    /// 本地主键（playlist_tracks 老表外键；对用户不可见）
    pub id: String,
    /// 歌单的永久全局唯一标识（UUID v4，创建后不再变化）：
    /// 收藏歌曲 / 查询歌单 / 删除歌单 / 上送云端登记全按它走
    pub pid: String,
    pub name: String,
    pub platform: String,
    pub pic_url: String,
    pub track_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
    /// 是否本地自建（可改名/删除）；false = 云端同步卡片（「移除」= 取消收藏）
    pub is_local: bool,
}

/// 新建歌单，返回 pid。
///
/// pid 用 UUID v4 生成（(platform=local, pid) 全局唯一，创建后永不变），
/// 本地落库后由调用方上送云端登记；`id` 仍是纯本地主键（老表外键指着它）。
pub(crate) fn create_playlist(conn: &Connection, name: &str) -> Result<String, rusqlite::Error> {
    let now = now_ms();
    // pid 唯一索引兜底，撞了（概率可忽略）就重新生成
    let mut pid = String::new();
    for _ in 0..8 {
        let candidate = crate::db::migrations::new_uuid_v4();
        let taken: i64 = conn.query_row(
            "SELECT COUNT(*) FROM playlists WHERE pid = ?1",
            params![candidate],
            |r| r.get(0),
        )?;
        if taken == 0 {
            pid = candidate;
            break;
        }
    }
    if pid.is_empty() {
        return Err(rusqlite::Error::InvalidColumnName(
            "无法生成歌单的唯一 pid".into(),
        ));
    }
    let id = format!("pl_{}_{}", now, fastrand::u64(..));
    conn.execute(
        "INSERT INTO playlists (id, pid, name, is_smart, sort_order, is_favorite, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, 0, 0, ?4, ?4)",
        params![id, pid, name, now],
    )?;
    Ok(pid)
}

/// 某 pid 的歌单是否已存在（本地自建，或云端同步回来的卡片）。
/// 收藏歌曲落库前的准入检查：没有歌单的歌不加载（v5 起无归属不加载）。
pub(crate) fn playlist_pid_exists(conn: &Connection, pid: &str) -> Result<bool, rusqlite::Error> {
    let local: i64 = conn.query_row(
        "SELECT COUNT(*) FROM playlists WHERE pid = ?1",
        params![pid],
        |r| r.get(0),
    )?;
    if local > 0 {
        return Ok(true);
    }
    let cloud: i64 = conn.query_row(
        "SELECT COUNT(*) FROM liked_playlists WHERE pid = ?1 AND deleted_at IS NULL",
        params![pid],
        |r| r.get(0),
    )?;
    Ok(cloud > 0)
}

pub(crate) fn rename_playlist(
    conn: &Connection,
    pid: &str,
    name: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE playlists SET name = ?1, updated_at = ?2 WHERE pid = ?3",
        params![name, now_ms(), pid],
    )?;
    Ok(())
}

/// 登记本地自建歌单封面文件路径（playlists.cover_path）。按 pid 定位，
/// 返回受影响行数：0 = 该 pid 不是本地自建歌单（云端卡片不在此表）。
pub(crate) fn set_playlist_cover_path(
    conn: &Connection,
    pid: &str,
    cover_path: &str,
) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE playlists SET cover_path = ?1, updated_at = ?2 WHERE pid = ?3",
        params![cover_path, now_ms(), pid],
    )
}

/// 本地自建歌单的封面文件路径（playlists.cover_path）；
/// 不是本地自建歌单或未设置过封面返回 None。
pub(crate) fn playlist_cover_path(
    conn: &Connection,
    pid: &str,
) -> Result<Option<String>, rusqlite::Error> {
    match conn.query_row(
        "SELECT cover_path FROM playlists WHERE pid = ?1",
        params![pid],
        |r| r.get::<_, Option<String>>(0),
    ) {
        Ok(v) => Ok(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// 删除歌单（按 pid 定位）：摘掉该歌单下所有归属；
/// 一首歌若因此失去全部歌单，才跟着下线（软删，保留同步语义）。
/// 同步回来的同 pid 云端卡片一并清掉：登录状态下建单会收到服务器的
/// add 回声，`liked_playlists` 里因此留有同 pid 行，不清的话歌单会以
/// 0 首的幽灵卡片残留在「我的歌单」里（合并视图按 pid 去重掩盖了它）。
pub(crate) fn delete_playlist(conn: &Connection, pid: &str) -> Result<(), rusqlite::Error> {
    // 老关系表外键是本地 id，先按 pid 换算出来
    conn.execute(
        "DELETE FROM playlist_tracks
          WHERE playlist_id IN (SELECT id FROM playlists WHERE pid = ?1)",
        params![pid],
    )?;
    // 摘掉该歌单的全部归属
    conn.execute(
        "DELETE FROM liked_song_playlists WHERE pid = ?1",
        params![pid],
    )?;
    // 主归属恰好挂在被删歌单、但还有别的归属的歌：重绑到剩余任一归属
    //（云端按主归属单值建模，摘空会让下线误伤多归属歌）
    conn.execute(
        "UPDATE liked_songs
            SET pid = (SELECT lsp.pid FROM liked_song_playlists lsp
                        WHERE lsp.song_id = liked_songs.id LIMIT 1)
          WHERE deleted_at IS NULL AND pid = ?1
            AND id IN (SELECT song_id FROM liked_song_playlists)",
        params![pid],
    )?;
    // 失去全部归属的歌下线（软删，保留同步语义）
    conn.execute(
        "UPDATE liked_songs SET deleted_at = ?1
          WHERE deleted_at IS NULL
            AND id NOT IN (SELECT song_id FROM liked_song_playlists)",
        params![now_ms()],
    )?;
    conn.execute("DELETE FROM playlists WHERE pid = ?1", params![pid])?;
    // 同 pid 的云端卡片一并清理（幽灵歌单根因，见函数 doc）
    conn.execute("DELETE FROM liked_playlists WHERE pid = ?1", params![pid])?;
    Ok(())
}

// ---------- 歌单的云端确认点（LIKE_SYNC_DESIGN.md §5 机制 B，v8） ----------
//
// `playlists.cloud_seq` = 该歌单在云端被确认存在的最后 updated_seq。
// 没有它，对账无法区分「从未上送」（该补推）和「他端已删」（本地该跟随删），
// 本机建、他端删的歌单会被启动对账无限复活。

/// 对账用的自建歌单行：pid + 云端确认点。
/// `cloud_seq IS NULL` 表示从未被云端确认过。
pub(crate) fn list_playlist_sync_rows(
    conn: &Connection,
) -> Result<Vec<(String, Option<i64>)>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT pid, cloud_seq FROM playlists ORDER BY created_at ASC")?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.push((row.get(0)?, row.get(1)?));
    }
    Ok(out)
}

/// 记录歌单的云端确认点（推送成功 / 对账、拉取见到云端有它时调用）。
/// 取更大值单调推进：确认点只涨不跌，避免乱序回退。
pub(crate) fn mark_playlist_cloud_seq(
    conn: &Connection,
    pid: &str,
    seq: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE playlists SET cloud_seq = ?2
          WHERE pid = ?1 AND (cloud_seq IS NULL OR cloud_seq < ?2)",
        params![pid, seq],
    )?;
    Ok(())
}

/// 他端删除、本地跟随：按 pid 删自建行 + 摘归属 + 下线孤儿歌 + 清云端卡片。
/// 与用户手动删除（`delete_playlist`）同构，只是入口在对账 / apply 链路。
pub(crate) fn delete_playlist_follow_cloud(
    conn: &Connection,
    pid: &str,
) -> Result<(), rusqlite::Error> {
    delete_playlist(conn, pid)
}

/// 本地自建歌单列表（按更新时间倒序），附带曲目数。
/// 只列本地自建。合并视图走 `list_my_playlists`，这个留给只关心本地的场景。
#[allow(dead_code)]
pub(crate) fn list_playlists(conn: &Connection) -> Result<Vec<PlaylistSummary>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.pid, p.name,
                (SELECT COUNT(*) FROM liked_songs ls
                  WHERE ls.pid = p.pid AND ls.deleted_at IS NULL
                    AND ls.id IN (SELECT song_id FROM liked_song_playlists WHERE pid = p.pid)),
                p.created_at, p.updated_at,
                COALESCE(p.cover_path, '')
           FROM playlists p
          ORDER BY p.updated_at DESC, p.created_at DESC",
    )?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let pid: String = row.get(1)?;
        out.push(PlaylistSummary {
            id: row.get(0)?,
            pid: pid.clone(),
            name: row.get(2)?,
            track_count: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
            // 本地歌单天然就是 local，不需要落一列
            platform: LOCAL_PLATFORM.to_string(),
            pic_url: row.get(6)?,
            is_local: true,
        });
    }
    Ok(out)
}

/// 歌单内的曲目（按加入顺序）。`pid` 是歌单的永久全局唯一标识。
///
/// 歌单曲目 = 挂在该 pid 下的收藏（多归属关联表）——
/// **只认这个 pid**，别的歌单的歌绝不混进来。
/// 老的 `playlist_tracks` 行只在关联表没有对应行时才补在末尾（历史兜底）。
pub(crate) fn get_playlist_tracks(
    conn: &Connection,
    pid: &str,
) -> Result<Vec<Track>, rusqlite::Error> {
    let mut out = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT l.sid, l.platform, l.name, l.singer, l.album, t.pic_url,
                    t.duration_ms, t.music_id
               FROM liked_songs l
               LEFT JOIN tracks t ON t.id = l.id
              WHERE l.deleted_at IS NULL
                AND l.id IN (SELECT song_id FROM liked_song_playlists WHERE pid = ?1)
              ORDER BY l.created_at ASC",
        )?;
        let mut rows = stmt.query(params![pid])?;
        while let Some(row) = rows.next()? {
            if let Some(track) = track_from_row(row)? {
                out.push(track);
            }
        }
    }
    {
        let mut stmt = conn.prepare(
            "SELECT substr(pt.track_id, instr(pt.track_id, ':') + 1), t.platform,
                    t.title, t.singer, t.album, t.pic_url, t.duration_ms, t.music_id
               FROM playlist_tracks pt
               JOIN tracks t ON t.id = pt.track_id
               JOIN playlists p ON p.id = pt.playlist_id
              WHERE p.pid = ?1 AND t.missing = 0
                AND NOT EXISTS (SELECT 1 FROM liked_songs ls
                                 WHERE ls.id = pt.track_id AND ls.deleted_at IS NULL)
              ORDER BY pt.position ASC, pt.added_at ASC",
        )?;
        let mut rows = stmt.query(params![pid])?;
        while let Some(row) = rows.next()? {
            if let Some(track) = track_from_row(row)? {
                out.push(track);
            }
        }
    }
    Ok(out)
}

/// 批量加歌（追加到末尾）。已在歌单里的曲目**保持原有位置**不动（DO NOTHING），
/// 避免重复添加时把歌曲挤到末尾。
/// 曲目本体先入库；本地曲目若尚未扫描入库则跳过（外键指向 tracks）。
///
/// 加歌即收藏：往歌单的归属集合里追加一条（多归属，不影响这首歌
/// 已在的其他歌单）；liked_songs 的主归属同步指向本歌单。
pub(crate) fn add_tracks_to_playlist(
    conn: &Connection,
    pid: &str,
    tracks: &[Track],
) -> Result<usize, rusqlite::Error> {
    let refs: Vec<&Track> = tracks.iter().collect();
    upsert_tracks(conn, &refs)?;
    let now = now_ms();
    // 老关系表外键是本地 id，按 pid 换算（云端卡片歌单没有本地行，跳过）
    let local_id: Option<String> = conn
        .query_row(
            "SELECT id FROM playlists WHERE pid = ?1",
            params![pid],
            |r| r.get(0),
        )
        .optional()?;
    let max_pos: i64 = match &local_id {
        Some(lid) => conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) FROM playlist_tracks WHERE playlist_id = ?1",
                params![lid],
                |r| r.get(0),
            )
            .unwrap_or(-1),
        None => -1,
    };
    // 返回实际新增的关系行数（重复添加不重复计数）：歌单导入向导用它报
    // 「已导入 N / M 首」，与移动端 importSongsToPlaylist 的返回口径一致
    let mut added: usize = 0;
    for (i, t) in tracks.iter().enumerate() {
        let db_id = db_track_id(t);
        let exists: Option<i64> = conn
            .query_row("SELECT 1 FROM tracks WHERE id = ?1", params![db_id], |r| {
                r.get(0)
            })
            .optional()?;
        if exists.is_none() {
            continue;
        }
        if let Some(lid) = &local_id {
            added += conn.execute(
                "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(playlist_id, track_id) DO NOTHING",
                params![lid, db_id, max_pos + 1 + i as i64, now],
            )?;
        }
        add_liked_song(conn, t, pid)?;
    }
    if let Some(lid) = &local_id {
        conn.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![now, lid],
        )?;
    }
    // 云端卡片歌单没有本地关系表，无法按行计数：按全量推送口径返回
    if local_id.is_none() {
        return Ok(tracks.len());
    }
    Ok(added)
}

/// 从歌单里移除一首（= 摘掉它在当前歌单下的归属关联）。`pid` 定位歌单。
pub(crate) fn remove_track_from_playlist(
    conn: &Connection,
    pid: &str,
    track: &Track,
) -> Result<LikeRemoveOutcome, rusqlite::Error> {
    conn.execute(
        "DELETE FROM playlist_tracks
          WHERE playlist_id IN (SELECT id FROM playlists WHERE pid = ?1)
            AND track_id = ?2",
        params![pid, db_track_id(track)],
    )?;
    remove_liked_song(conn, track, Some(pid))
}
