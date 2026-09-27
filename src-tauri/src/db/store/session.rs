//! 播放现场域（DESIGN §8.3）：`play_queue` 整表替换、播放状态存档与读取。
//!
//! 拆自原 `db/store.rs`（P2-7），函数体与 SQL 一行未改。
//! 队列与播放状态分开写（`save_queue` 只换队列，`save_play_state` 只写 settings），
//! 两者解耦，避免每次拖动进度条都重写整张队列表。

use rusqlite::{params, Connection, OptionalExtension};

use crate::provider::types::{Track};

// 跨域共享的小工具（`db_track_id` / `now_ms` / `track_from_row` / `LOCAL_PLATFORM` …）
// 由 store/mod.rs 统一再导出，这里一次性引入，省得每个域各写一长串 use。
use super::*;
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
