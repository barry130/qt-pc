//! 具体存取：tracks 入库、play_queue 整表替换、settings 读写（DESIGN §8.3）。
//! 本地曲目（platform='local'）的入库/查询/缺失标记见本文件末尾「本地音乐库」段（§13）。
//!
//! ## 歌单的唯一定位（DESIGN §5.3 修订）
//! 歌单是唯一的组织单位，收藏不能脱离歌单存在。每个歌单由
//! `(platform, pid)` 二元组全局唯一定位：
//! - `platform = "local"`：本地歌单，`pid` 取 `playlists.id`；
//! - 其余（qq / wyy / kw / kg）：在线收藏的歌单，`pid` 是音源侧 id，
//!   由 `liked_playlists` 的 `UNIQUE(uid, platform, pid)` 兜底。
//!
//! 收藏歌曲用 `liked_songs.pid` 归属到歌单；散装收藏（没指定歌单、
//! 或云端同步回来的）挂在「我喜欢的歌曲」下，即 `("local", "local")`。

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

use crate::provider::types::{SourceId, Track};

/// 本地歌单的平台标识。
pub(crate) const LOCAL_PLATFORM: &str = "local";

/// tracks 表主键口径：`platform:原始id`（跨音源唯一）。
pub(crate) fn db_track_id(track: &Track) -> String {
    format!("{}:{}", track.platform, track.id)
}

/// 从 db 主键拆回 (platform, 原始id)。解析失败返回 None（脏数据直接跳过）。
fn split_db_track_id(db_id: &str) -> Option<(SourceId, String)> {
    let (p, id) = db_id.split_once(':')?;
    let platform = match p {
        "wyy" => SourceId::Wyy,
        "qq" => SourceId::Qq,
        "kw" => SourceId::Kw,
        "kg" => SourceId::Kg,
        "local" => SourceId::Local,
        _ => return None,
    };
    Some((platform, id.to_string()))
}

/// 在线曲目入库/更新（§8.3 入库时机：进入队列 / 收藏 / 加歌单 / 播放历史）。
/// 搜索结果与榜单不入库；本地曲目由扫描器（§13）负责，这里跳过。
pub(crate) fn upsert_tracks(conn: &Connection, tracks: &[&Track]) -> Result<(), rusqlite::Error> {
    let now = now_ms();
    for t in tracks {
        if t.platform == SourceId::Local {
            continue;
        }
        let duration_ms = (t.duration * 1000.0) as i64;
        conn.execute(
            "INSERT INTO tracks (id, platform, title, singer, album, pic_url, duration_ms,
                                 music_id, missing, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               singer = excluded.singer,
               album = excluded.album,
               pic_url = excluded.pic_url,
               duration_ms = excluded.duration_ms,
               music_id = excluded.music_id,
               missing = 0,
               updated_at = excluded.updated_at",
            params![
                db_track_id(t),
                t.platform.to_string(),
                t.title,
                t.singer,
                t.album,
                if t.pic_url.is_empty() {
                    None
                } else {
                    Some(t.pic_url.as_str())
                },
                duration_ms,
                t.music_id,
                now,
            ],
        )?;
    }
    Ok(())
}

/// 队列整表替换（连带曲目入库）。同一事务内完成，position 即队列序号。
/// 播放状态（index/position_ms/…）由 `save_play_state` 单独写，两者解耦。
pub(crate) fn save_queue(conn: &Connection, tracks: &[Track]) -> Result<(), rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    {
        let refs: Vec<&Track> = tracks.iter().collect();
        upsert_tracks(&tx, &refs)?;
        tx.execute("DELETE FROM play_queue", [])?;
        for (position, t) in tracks.iter().enumerate() {
            tx.execute(
                "INSERT INTO play_queue (position, track_id) VALUES (?1, ?2)",
                params![position as i64, db_track_id(t)],
            )?;
        }
    }
    tx.commit()
}

/// 上次播放现场（§8.3 注：queue_index / position_ms / quality / play_mode / volume 存 settings）。
#[derive(Debug, Clone)]
pub struct PlayState {
    pub index: usize,
    pub position_ms: u64,
    pub quality: String,
    pub play_mode: String,
    pub volume: f32,
    pub muted: bool,
}

/// 完整存档：队列曲目 + 播放状态。
#[derive(Debug, Clone)]
pub struct SavedSession {
    pub tracks: Vec<Track>,
    pub state: PlayState,
}

/// 读取现场：play_queue 为空返回 None（视为无存档）。
/// missing=1 的曲目不进队列；过滤后 index 顺移到过滤后的同名曲目位置。
pub(crate) fn load_session(conn: &Connection) -> Result<Option<SavedSession>, rusqlite::Error> {
    let old_state = load_play_state(conn)?;
    let old_index = old_state.as_ref().map(|s| s.index).unwrap_or(0);

    let mut stmt = conn.prepare(
        "SELECT q.position, t.id, t.platform, t.title, t.singer, t.album, t.pic_url,
                t.duration_ms, t.music_id
         FROM play_queue q JOIN tracks t ON t.id = q.track_id
         WHERE t.missing = 0
         ORDER BY q.position",
    )?;
    let mut tracks = Vec::new();
    let mut index = 0usize;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let position: i64 = row.get(0)?;
        let db_id: String = row.get(1)?;
        let Some((platform, orig_id)) = split_db_track_id(&db_id) else {
            continue;
        };
        let duration_ms: Option<i64> = row.get(7)?;
        let is_current = position as usize == old_index;
        tracks.push(Track {
            id: orig_id,
            platform,
            title: row.get(3)?,
            singer: row.get(4)?,
            album: row.get(5)?,
            pic_url: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
            duration: duration_ms.unwrap_or(0) as f64 / 1000.0,
            music_id: row.get(8)?,
        });
        if is_current {
            index = tracks.len() - 1;
        }
    }
    if tracks.is_empty() {
        return Ok(None);
    }
    let fallback = PlayState {
        index: 0,
        position_ms: 0,
        quality: "320".into(),
        play_mode: "listLoop".into(),
        volume: 0.8,
        muted: false,
    };
    let mut state = old_state.unwrap_or(fallback);
    state.index = index;
    Ok(Some(SavedSession { tracks, state }))
}

/// 播放状态写入 settings。
pub(crate) fn save_play_state(conn: &Connection, s: &PlayState) -> Result<(), rusqlite::Error> {
    set_setting(conn, "queue_index", &s.index.to_string())?;
    set_setting(conn, "position_ms", &s.position_ms.to_string())?;
    set_setting(conn, "quality", &s.quality)?;
    set_setting(conn, "play_mode", &s.play_mode)?;
    set_setting(conn, "volume", &format!("{}", s.volume))?;
    set_setting(conn, "muted", if s.muted { "1" } else { "0" })
}

pub(crate) fn load_play_state(conn: &Connection) -> Result<Option<PlayState>, rusqlite::Error> {
    let get = |key: &str| -> Result<Option<String>, rusqlite::Error> {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .optional()
    };
    let Some(index) = get("queue_index")? else {
        return Ok(None);
    };
    Ok(Some(PlayState {
        index: index.parse().unwrap_or(0),
        position_ms: get("position_ms")?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0),
        quality: get("quality")?.unwrap_or_else(|| "320".into()),
        play_mode: get("play_mode")?.unwrap_or_else(|| "listLoop".into()),
        volume: get("volume")?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.8),
        muted: get("muted")?.map(|v| v == "1").unwrap_or(false),
    }))
}

/// 通用 settings 读写（主题、窗口状态等后续单元复用）。
pub(crate) fn set_setting(
    conn: &Connection,
    key: &str,
    value: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now_ms()],
    )?;
    Ok(())
}

pub(crate) fn get_setting(
    conn: &Connection,
    key: &str,
) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
}

// ---------- 本地音乐库（DESIGN §13） ----------
//
// `upsert_tracks` 显式跳过 SourceId::Local（本地曲目由扫描器负责），本节即为该扫描器的落库端。
// 约定（与 §13 一致）：Track.id = 音频文件绝对路径，db 主键 = `local:<绝对路径>`
// （见 `db_track_id`）；`local_path` 同步写入，便于按目录范围做缺失标记。

/// 本地曲目入库行（`local::scan_dirs` 的产物）。
#[derive(Debug, Clone)]
pub struct LocalTrackRow {
    /// 文件绝对路径，同时作为 `Track.id`
    pub path: String,
    pub title: String,
    pub singer: String,
    pub album: String,
    pub duration_ms: i64,
    pub file_size: i64,
    /// epoch 秒
    pub mtime: i64,
    /// 小写扩展名，如 "mp3"
    pub format: String,
}

/// 本地曲目入库/更新（§13.2 要点 4「新文件插入」/ 要点 5「老文件恢复，取消缺失标记」）。
/// 重复扫描按主键 `ON CONFLICT DO UPDATE`，不会产生重复行。
pub fn upsert_local_tracks(
    conn: &Connection,
    rows: &[LocalTrackRow],
) -> Result<(), rusqlite::Error> {
    let now = now_ms();
    let tx = conn.unchecked_transaction()?;
    for r in rows {
        tx.execute(
            "INSERT INTO tracks (id, platform, title, singer, album, pic_url, duration_ms,
                                 music_id, local_path, file_size, format, mtime, missing,
                                 created_at, updated_at)
             VALUES (?1, 'local', ?2, ?3, ?4, NULL, ?5, NULL, ?6, ?7, ?8, ?9, 0, ?10, ?10)
             ON CONFLICT(id) DO UPDATE SET
               title       = excluded.title,
               singer      = excluded.singer,
               album       = excluded.album,
               duration_ms = excluded.duration_ms,
               local_path  = excluded.local_path,
               file_size   = excluded.file_size,
               format      = excluded.format,
               mtime       = excluded.mtime,
               missing     = 0,
               updated_at  = excluded.updated_at",
            params![
                format!("local:{}", r.path),
                r.title,
                r.singer,
                r.album,
                r.duration_ms,
                r.path,
                r.file_size,
                r.format,
                r.mtime,
                now,
            ],
        )?;
    }
    tx.commit()
}

/// 标记缺失（§13.2 要点 1）：扫描目录范围内、本次未命中的本地记录置 `missing = 1`。
/// 范围外的记录（未纳入本次扫描的目录）保持原状。返回被标记的行数。
pub fn mark_missing_local_tracks(
    conn: &Connection,
    dirs: &[String],
    present: &HashSet<String>,
) -> Result<usize, rusqlite::Error> {
    let now = now_ms();
    let mut stmt = conn.prepare(
        "SELECT local_path FROM tracks
         WHERE platform = 'local' AND local_path IS NOT NULL AND missing = 0",
    )?;
    let stale: Vec<String> = stmt
        .query_map([], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .filter(|path: &String| !present.contains(path) && under_any_dir(path, dirs))
        .collect();
    drop(stmt);

    let mut marked = 0usize;
    for path in &stale {
        marked += conn.execute(
            "UPDATE tracks SET missing = 1, updated_at = ?1 WHERE local_path = ?2",
            params![now, path],
        )?;
    }
    Ok(marked)
}

/// 读库内本地曲目（不扫磁盘）；`missing = 1` 的记录不返回。
pub fn query_local_tracks(conn: &Connection) -> Result<Vec<Track>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, title, singer, album, duration_ms, music_id
         FROM tracks
         WHERE platform = 'local' AND missing = 0
         ORDER BY title COLLATE NOCASE, singer COLLATE NOCASE",
    )?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let db_id: String = row.get(0)?;
        out.push(Track {
            id: strip_local_prefix(&db_id),
            platform: SourceId::Local,
            title: row.get(1)?,
            singer: row.get(2)?,
            album: row.get(3)?,
            pic_url: String::new(),
            duration: row.get::<_, Option<i64>>(4)?.unwrap_or(0) as f64 / 1000.0,
            music_id: row.get(5)?,
        });
    }
    Ok(out)
}

/// 扫描目录清单（scan_dirs 表，§13.1「读取启用目录」）。
pub fn list_scan_dirs(conn: &Connection) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT path FROM scan_dirs ORDER BY created_at, path")?;
    let out = stmt
        .query_map([], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(out)
}

/// 新增/刷新扫描目录（幂等：path 上建有 UNIQUE 索引）。
pub fn add_scan_dir(conn: &Connection, path: &str) -> Result<(), rusqlite::Error> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO scan_dirs (id, path, enabled, last_scan_at, created_at)
         VALUES (?1, ?1, 1, ?2, ?2)
         ON CONFLICT(path) DO UPDATE SET last_scan_at = excluded.last_scan_at",
        params![path, now],
    )?;
    Ok(())
}

/// 批量刷新 last_scan_at（一次扫描涉及多个目录时复用 `add_scan_dir` 的语义）。
pub fn touch_scan_dirs(conn: &Connection, dirs: &[String]) -> Result<(), rusqlite::Error> {
    for dir in dirs {
        add_scan_dir(conn, dir)?;
    }
    Ok(())
}

/// 移除扫描目录。只删清单条目，不删已入库曲目（避免误删用户数据）。
pub fn remove_scan_dir(conn: &Connection, path: &str) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM scan_dirs WHERE path = ?1", params![path])?;
    Ok(())
}

// ---------- 收藏 / 播放历史（DESIGN §5.3） ----------

/// 播放历史条目，序列化为 `{ track: {...}, playedAt: 123 }`。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub track: Track,
    /// 播放时间（Unix 毫秒）
    pub played_at: i64,
}

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
        params![
            db_track_id(track),
            track.id,
            track.platform.to_string(),
        ],
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

/// 把查询行还原成 Track：列序固定为
/// (sid, platform, name, singer, album, pic_url, duration_ms, music_id)。
/// 认不出来的音源直接跳过（脏数据不拖垮整个列表）。
fn track_from_row(row: &rusqlite::Row<'_>) -> Result<Option<Track>, rusqlite::Error> {
    let platform: String = row.get(1)?;
    let platform = match platform.as_str() {
        "wyy" => SourceId::Wyy,
        "qq" => SourceId::Qq,
        "kw" => SourceId::Kw,
        "kg" => SourceId::Kg,
        "local" => SourceId::Local,
        _ => return Ok(None),
    };
    Ok(Some(Track {
        id: row.get(0)?,
        platform,
        title: row.get(2)?,
        singer: row.get(3)?,
        album: row.get(4)?,
        pic_url: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
        duration: row.get::<_, Option<i64>>(6)?.unwrap_or(0) as f64 / 1000.0,
        music_id: row.get(7)?,
    }))
}

/// 记录一次播放（同一首歌只保留最近一条：先删旧记录再插入）。
/// 本地曲目若尚未被扫描入库，tracks 里没有对应行（外键），此时静默跳过。
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
pub(crate) fn list_my_playlists(
    conn: &Connection,
) -> Result<Vec<MyPlaylist>, rusqlite::Error> {
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

/// `local:<路径>` → `<路径>`（脏数据原样返回）。
fn strip_local_prefix(db_id: &str) -> String {
    db_id.strip_prefix("local:").unwrap_or(db_id).to_string()
}

/// 路径是否落在任一扫描目录下（路径比较统一按 `/`、大小写不敏感，兼容 Windows 盘符大小写）。
fn under_any_dir(path: &str, dirs: &[String]) -> bool {
    dirs.iter().any(|dir| is_under_dir(path, dir))
}

fn is_under_dir(path: &str, dir: &str) -> bool {
    let dir = dir.trim_end_matches(['/', '\\']);
    if dir.is_empty() {
        return false;
    }
    let path = path.replace('\\', "/");
    let dir = dir.replace('\\', "/");
    let (path, dir) = (path.to_lowercase(), dir.to_lowercase());
    path.strip_prefix(&dir)
        .is_some_and(|rest| rest.starts_with('/'))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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
        let candidate = super::migrations::new_uuid_v4();
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

/// 删除歌单（按 pid 定位）：摘掉该歌单下所有归属；
/// 一首歌若因此失去全部歌单，才跟着下线（软删，保留同步语义）。
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
    // 失去全部归属的歌下线；还有别的归属的保留
    conn.execute(
        "UPDATE liked_songs SET deleted_at = ?1
          WHERE deleted_at IS NULL
            AND id NOT IN (SELECT song_id FROM liked_song_playlists)",
        params![now_ms()],
    )?;
    conn.execute("DELETE FROM playlists WHERE pid = ?1", params![pid])?;
    Ok(())
}

/// 本地自建歌单列表（按更新时间倒序），附带曲目数。
/// 只列本地自建。合并视图走 `list_my_playlists`，这个留给只关心本地的场景。
#[allow(dead_code)]
pub(crate) fn list_playlists(
    conn: &Connection,
) -> Result<Vec<PlaylistSummary>, rusqlite::Error> {
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
) -> Result<(), rusqlite::Error> {
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
            conn.execute(
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
    Ok(())
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

// ---------- 下载管理（DESIGN §5.3） ----------

/// 下载任务。曲目信息由 download_tasks.track_id JOIN tracks 得到。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTask {
    pub id: String,
    pub track: Track,
    pub quality: String,
    /// pending / downloading / done / failed
    pub status: String,
    /// 0.0 ~ 1.0
    pub progress: f64,
    pub file_path: Option<String>,
    pub file_size: Option<i64>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 建任务，返回任务 id。曲目本体先入库（本地曲目由扫描器负责）。
pub(crate) fn create_download_task(
    conn: &Connection,
    track: &Track,
    quality: &str,
) -> Result<String, rusqlite::Error> {
    upsert_tracks(conn, &[track])?;
    let now = now_ms();
    let id = format!("dl_{}_{}", now, fastrand::u64(..));
    conn.execute(
        "INSERT INTO download_tasks (id, track_id, platform, quality, status, progress,
                                     created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?5)",
        params![id, db_track_id(track), track.platform.to_string(), quality, now],
    )?;
    Ok(id)
}

pub(crate) fn update_download_progress(
    conn: &Connection,
    id: &str,
    progress: f64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE download_tasks SET status = 'downloading', progress = ?1, updated_at = ?2
          WHERE id = ?3",
        params![progress, now_ms(), id],
    )?;
    Ok(())
}

pub(crate) fn finish_download_task(
    conn: &Connection,
    id: &str,
    file_path: &str,
    file_size: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE download_tasks
            SET status = 'done', progress = 1, file_path = ?1, file_size = ?2,
                error = NULL, updated_at = ?3
          WHERE id = ?4",
        params![file_path, file_size, now_ms(), id],
    )?;
    Ok(())
}

pub(crate) fn fail_download_task(
    conn: &Connection,
    id: &str,
    error: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE download_tasks SET status = 'failed', error = ?1, updated_at = ?2
          WHERE id = ?3",
        params![error, now_ms(), id],
    )?;
    Ok(())
}

/// 下载列表（按创建时间倒序）。
pub(crate) fn list_download_tasks(conn: &Connection) -> Result<Vec<DownloadTask>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT d.id, d.quality, d.status, d.progress, d.file_path, d.file_size, d.error,
                d.created_at, d.updated_at,
                t.id, t.platform, t.title, t.singer, t.album, t.duration_ms, t.music_id
           FROM download_tasks d
           JOIN tracks t ON t.id = d.track_id
          ORDER BY d.created_at DESC",
    )?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let db_id: String = row.get(9)?;
        let Some((platform, track_id)) = split_db_track_id(&db_id) else {
            continue;
        };
        out.push(DownloadTask {
            id: row.get(0)?,
            quality: row.get(1)?,
            status: row.get(2)?,
            progress: row.get(3)?,
            file_path: row.get(4)?,
            file_size: row.get(5)?,
            error: row.get(6)?,
            created_at: row.get(7)?,
            updated_at: row.get(8)?,
            track: Track {
                id: track_id,
                platform,
                title: row.get(11)?,
                singer: row.get(12)?,
                album: row.get(13)?,
                pic_url: String::new(),
                duration: row.get::<_, Option<i64>>(14)?.unwrap_or(0) as f64 / 1000.0,
                music_id: row.get(15)?,
            },
        });
    }
    Ok(out)
}

/// 删除任务记录，返回它曾下载的文件路径（由调用方决定是否删文件）。
pub(crate) fn delete_download_task(
    conn: &Connection,
    id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    let path: Option<String> = conn
        .query_row(
            "SELECT file_path FROM download_tasks WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    conn.execute("DELETE FROM download_tasks WHERE id = ?1", params![id])?;
    Ok(path)
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        migrations::run(&conn).expect("migrations");
        conn
    }

    fn track(id: &str, title: &str) -> Track {
        Track {
            id: id.to_string(),
            platform: SourceId::Wyy,
            title: title.to_string(),
            singer: "测试歌手".to_string(),
            album: "测试专辑".to_string(),
            pic_url: String::new(),
            duration: 210.0,
            music_id: None,
        }
    }

    /// 收藏：写入 / 幂等 / 查询 / 取消（DESIGN §5.3）
    #[test]
    fn favorite_roundtrip_is_idempotent() {
        let conn = test_conn();
        let t = track("1001", "晴天");
        assert!(!is_liked_song(&conn, &t).expect("is_liked"));

        let pid = create_playlist(&conn, "收藏测试").expect("create");
        add_liked_song(&conn, &t, &pid).expect("add");
        assert!(is_liked_song(&conn, &t).expect("is_liked after add"));

        // 重复收藏不产生重复行
        add_liked_song(&conn, &t, &pid).expect("add again");
        let list = list_liked_songs(&conn, Some(&pid)).expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "晴天");
        // 收藏会把曲目本体入库，因此时长应回得来
        assert!((list[0].duration - 210.0).abs() < 0.5);

        remove_liked_song(&conn, &t, None).expect("remove");
        assert!(!is_liked_song(&conn, &t).expect("is_liked after remove"));
        assert!(list_liked_songs(&conn, Some(&pid))
            .expect("list after remove")
            .is_empty());
    }

    /// 一首歌可以同时挂在多个歌单（多归属），从其中一个摘除不影响其他
    #[test]
    fn favorite_binds_to_playlist_by_pid() {
        let conn = test_conn();
        let a = track("3001", "稻香");
        let b = track("3002", "七里香");
        let pid = create_playlist(&conn, "开车听").expect("create");
        let other = create_playlist(&conn, "另一个").expect("create 2");

        // 同一首歌收藏进两个歌单（多选）
        add_liked_song(&conn, &a, &pid).expect("add to pid");
        add_liked_song(&conn, &a, &other).expect("add to other");
        assert_eq!(list_liked_songs(&conn, Some(&pid)).expect("开车听").len(), 1);
        assert_eq!(list_liked_songs(&conn, Some(&other)).expect("另一个").len(), 1);
        // 归属清单两处都有
        assert_eq!(list_track_playlists(&conn, &a).expect("归属").len(), 2);

        // 从「开车听」摘除 → 「另一个」里的还在
        remove_liked_song(&conn, &a, Some(&pid)).expect("detach");
        assert!(list_liked_songs(&conn, Some(&pid)).expect("开车听").is_empty());
        assert_eq!(list_liked_songs(&conn, Some(&other)).expect("另一个").len(), 1);

        // 最后一个归属也摘掉 → 整首下线
        remove_liked_song(&conn, &a, Some(&other)).expect("detach last");
        assert!(!is_liked_song(&conn, &a).expect("整首下线"));

        // 歌单详情只认自己的 pid
        add_liked_song(&conn, &b, &other).expect("add b");
        assert!(get_playlist_tracks(&conn, &pid).expect("tracks").is_empty());
        assert_eq!(get_playlist_tracks(&conn, &other).expect("tracks").len(), 1);
        // 删歌单：b 因失去全部归属而下线
        delete_playlist(&conn, &other).expect("delete");
        assert!(get_playlist_tracks(&conn, &other).expect("tracks").is_empty());
        assert!(!is_liked_song(&conn, &b).expect("b 整首下线"));
    }

    /// 无默认歌单：歌单列表只含本地自建 + 云端卡片，按 pid 去重
    #[test]
    fn playlist_list_merges_local_and_cloud_cards() {
        let conn = test_conn();
        // 本地自建一张
        let pid = create_playlist(&conn, "测试歌单").expect("create");
        // 云端同步回两张卡片（含一张 local「我喜欢的歌曲」）
        add_liked_playlist(&conn, "local", "local", "我喜欢的歌曲", "", "")
            .expect("cloud card 1");
        add_liked_playlist(&conn, "qq", "5033052", "拯救歌荒", "", "")
            .expect("cloud card 2");

        let all = list_my_playlists(&conn).expect("list");
        // 本地 1 张 + 云端 2 张，pid 各不相同
        assert_eq!(all.len(), 3);
        let mine = all.iter().find(|p| p.pid == pid).expect("自建歌单");
        assert!(mine.is_local);
        assert_eq!(mine.name, "测试歌单");
        let liked = all.iter().find(|p| p.pid == "local").expect("云端local卡片");
        assert!(!liked.is_local);
        assert_eq!(liked.name, "我喜欢的歌曲");
        assert_eq!(liked.track_count, 0);

        // 收藏进云端 local 卡片后，其曲目数实时可见
        add_liked_song(&conn, &track("7001", "晴天"), "local").expect("add to local");
        let all = list_my_playlists(&conn).expect("list");
        let liked = all.iter().find(|p| p.pid == "local").expect("云端local卡片");
        assert_eq!(liked.track_count, 1);
    }

    /// 历史：同曲目去重、按播放时间倒序、清空
    #[test]
    fn history_dedups_by_track_and_orders_desc() {
        let conn = test_conn();
        let a = track("2001", "A");
        let b = track("2002", "B");

        record_play_history(&conn, &a).expect("record a");
        record_play_history(&conn, &b).expect("record b");
        // 同一首再播一次：只保留最近一条
        record_play_history(&conn, &a).expect("record a again");

        let items = list_play_history(&conn, 0).expect("list");
        assert_eq!(items.len(), 2, "同一首歌应去重");
        assert_eq!(items[0].track.title, "A", "最近播放的排在最前");
        assert_eq!(items[1].track.title, "B");
        assert!(items[0].played_at >= items[1].played_at);

        clear_play_history(&conn).expect("clear");
        assert!(list_play_history(&conn, 0)
            .expect("list after clear")
            .is_empty());
    }

    /// 历史：limit 生效、默认 100 条；本地曲目未入库时静默跳过
    #[test]
    fn history_limit_and_untracked_local_track() {
        let conn = test_conn();
        for i in 0..5 {
            record_play_history(&conn, &track(&format!("300{i}"), &format!("T{i}")))
                .expect("record");
        }
        assert_eq!(list_play_history(&conn, 2).expect("limit 2").len(), 2);
        assert_eq!(
            list_play_history(&conn, 0).expect("default limit").len(),
            5
        );

        // 本地曲目若未被扫描入库（tracks 无行、外键指向不存在），记历史应静默跳过
        let local = Track {
            id: "D:\\no-such-file.mp3".to_string(),
            platform: SourceId::Local,
            ..track("local-1", "本地")
        };
        record_play_history(&conn, &local).expect("本地未入库时不应报错");
        let items = list_play_history(&conn, 0).expect("list");
        assert!(items.iter().all(|it| it.track.platform != SourceId::Local));
    }

    /// 我的歌单：创建 / 加歌去重 / 顺序 / 移除 / 重命名 / 删除（DESIGN §5.3）
    #[test]
    fn my_playlist_crud_and_ordering() {
        let conn = test_conn();
        let id = create_playlist(&conn, "开车听").expect("create");

        let a = track("4001", "A");
        let b = track("4002", "B");
        add_tracks_to_playlist(&conn, &id, &[a.clone(), b.clone()]).expect("add");
        // 重复添加不产生重复行，也不应改变原有顺序
        add_tracks_to_playlist(&conn, &id, std::slice::from_ref(&a)).expect("add again");

        let tracks = get_playlist_tracks(&conn, &id).expect("tracks");
        assert_eq!(tracks.len(), 2);
        let names: Vec<String> = tracks.iter().map(|t| t.title.clone()).collect();
        assert_eq!(names, vec!["A".to_string(), "B".to_string()], "应保持加入顺序");

        let lists = list_playlists(&conn).expect("list");
        let mine = lists
            .iter()
            .find(|p| p.pid == id)
            .expect("找到刚建的歌单");
        assert_eq!(mine.name, "开车听");
        assert_eq!(mine.platform, LOCAL_PLATFORM);
        assert_eq!(mine.track_count, 2);
        assert!(mine.is_local);

        remove_track_from_playlist(&conn, &id, &a).expect("remove");
        assert_eq!(get_playlist_tracks(&conn, &id).expect("tracks").len(), 1);

        rename_playlist(&conn, &id, "改个名字").expect("rename");
        let lists = list_playlists(&conn).expect("list");
        assert_eq!(
            lists.iter().find(|p| p.pid == id).expect("找到歌单").name,
            "改个名字"
        );

        delete_playlist(&conn, &id).expect("delete");
        assert!(list_playlists(&conn)
            .expect("list")
            .iter()
            .all(|p| p.pid != id));
        assert!(get_playlist_tracks(&conn, &id).expect("tracks").is_empty());
    }

    /// 下载任务生命周期：创建 → 进度 → 完成 / 失败 → 删除（DESIGN §5.3）
    #[test]
    fn download_task_lifecycle() {
        let conn = test_conn();
        let t = track("5001", "下载用歌");

        let id = create_download_task(&conn, &t, "320").expect("create task");
        let tasks = list_download_tasks(&conn).expect("list");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].status, "pending");
        assert_eq!(tasks[0].track.title, "下载用歌");
        assert_eq!(tasks[0].quality, "320");

        update_download_progress(&conn, &id, 0.5).expect("progress");
        let tasks = list_download_tasks(&conn).expect("list");
        assert_eq!(tasks[0].status, "downloading");
        assert!((tasks[0].progress - 0.5).abs() < 1e-6);

        finish_download_task(&conn, &id, "D:\\dl\\a.mp3", 12345).expect("finish");
        let tasks = list_download_tasks(&conn).expect("list");
        assert_eq!(tasks[0].status, "done");
        assert_eq!(tasks[0].file_path.as_deref(), Some("D:\\dl\\a.mp3"));
        assert_eq!(tasks[0].file_size, Some(12345));

        // 失败态单独走一条
        let id2 = create_download_task(&conn, &track("5002", "另一首"), "128").expect("create 2");
        fail_download_task(&conn, &id2, "网络错误").expect("fail");
        let tasks = list_download_tasks(&conn).expect("list");
        let failed = tasks.iter().find(|x| x.id == id2).expect("找到失败任务");
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.error.as_deref(), Some("网络错误"));

        // 删除任务会返回它曾下载的文件路径（是否删文件由调用方决定）
        assert_eq!(
            delete_download_task(&conn, &id).expect("delete").as_deref(),
            Some("D:\\dl\\a.mp3")
        );
        assert_eq!(list_download_tasks(&conn).expect("list").len(), 1);
    }

    /// 听歌统计：多次播放累计 / 概览 / 排名（DESIGN §5.3）
    #[test]
    fn play_stats_accumulate_overview_and_rank() {
        let conn = test_conn();
        let a = track("1001", "晴天");
        let b = track("1002", "稻香");

        record_play_stat(&conn, &a, 1000).expect("stat 1");
        record_play_stat(&conn, &a, 1000).expect("stat 2");
        record_play_stat(&conn, &b, 2000).expect("stat 3");

        let overview = play_overview(&conn).expect("overview");
        assert_eq!(overview.total_plays, 3);
        assert_eq!(overview.total_ms, 4000);
        assert_eq!(overview.track_count, 2);
        assert!(overview.last_played_at.is_some());

        let top = list_top_tracks(&conn, 10).expect("top tracks");
        assert_eq!(top.len(), 2);
        // 播放 2 次的排前面
        assert_eq!(top[0].track.title, "晴天");
        assert_eq!(top[0].play_count, 2);
        assert_eq!(top[1].play_count, 1);
        assert_eq!(top[0].total_played_ms, 2000);

        let singers = list_top_singers(&conn, 10).expect("top singers");
        assert_eq!(singers.len(), 1);
        assert_eq!(singers[0].singer, "测试歌手");
        assert_eq!(singers[0].play_count, 3);
    }

    /// 没被扫描进库的本地曲目：跳过统计而不是撞外键报错（统计不能影响播放）
    #[test]
    fn play_stats_skips_local_track_missing_from_library() {
        let conn = test_conn();
        let local = Track {
            id: "D:/music/未知.mp3".to_string(),
            platform: SourceId::Local,
            title: "本地歌".to_string(),
            singer: String::new(),
            album: String::new(),
            pic_url: String::new(),
            duration: 180.0,
            music_id: None,
        };
        record_play_stat(&conn, &local, 1000).expect("本地曲目统计不该报错");
        assert_eq!(play_overview(&conn).expect("overview").total_plays, 0);
    }

    /// 封面要能随曲目读回来：收藏 / 历史 / 歌单 / 统计这几个列表都从 tracks.pic_url 取。
    /// 之前这些查询把 pic_url 写死成空串，列表页就全是空白封面 —— 这里盯住别再退化。
    #[test]
    fn lists_keep_track_cover_url() {
        const COVER: &str = "https://img.example.com/cover.jpg";
        let conn = test_conn();
        let t = Track {
            id: "1001".to_string(),
            platform: SourceId::Wyy,
            title: "晴天".to_string(),
            singer: "测试歌手".to_string(),
            album: "测试专辑".to_string(),
            pic_url: COVER.to_string(),
            duration: 210.0,
            music_id: None,
        };

        let pid = create_playlist(&conn, "测试歌单").expect("建歌单");
        add_liked_song(&conn, &t, &pid).expect("收藏");
        record_play_history(&conn, &t).expect("历史");
        record_play_stat(&conn, &t, 210_000).expect("统计");
        add_tracks_to_playlist(&conn, &pid, std::slice::from_ref(&t)).expect("加歌");

        assert_eq!(
            list_liked_songs(&conn, Some(&pid)).expect("收藏列表")[0].pic_url,
            COVER
        );
        assert_eq!(
            list_play_history(&conn, 10).expect("历史列表")[0].track.pic_url,
            COVER
        );
        assert_eq!(
            list_top_tracks(&conn, 10).expect("统计列表")[0].track.pic_url,
            COVER
        );
        assert_eq!(
            get_playlist_tracks(&conn, &pid).expect("歌单曲目")[0].pic_url,
            COVER
        );
    }
}
