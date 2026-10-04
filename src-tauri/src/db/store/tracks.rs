//! `tracks` 表（曲目）域：主键口径、在线曲目入库、行 → `Track` 映射。
//!
//! 拆自原 `db/store.rs`（P2-7），函数体与 SQL 一行未改。
//! `db_track_id` / `split_db_track_id` 是全库唯一的曲目主键换算口径
//! （`platform:原始id`）：收藏 / 历史 / 统计 / 下载 / 队列都要用它落库与回读，
//! 所以留在曲目域统一定义，而不是让每个域各抄一份。

use rusqlite::{params, Connection};

use crate::provider::types::{SourceId, Track};

// 跨域共享的小工具（`db_track_id` / `now_ms` / `track_from_row` / `LOCAL_PLATFORM` …）
// 由 store/mod.rs 统一再导出，这里一次性引入，省得每个域各写一长串 use。
use super::*;
/// 本地歌单的平台标识（宿主唯一硬编码的音源值，见 `provider::types::LOCAL_SOURCE`）。
pub(crate) const LOCAL_PLATFORM: &str = crate::provider::types::LOCAL_SOURCE;

/// tracks 表主键口径：`platform:原始id`（跨音源唯一）。
pub(crate) fn db_track_id(track: &Track) -> String {
    format!("{}:{}", track.platform.as_str(), track.id)
}

/// 从 db 主键拆回 (platform, 原始id)。解析失败返回 None（脏数据直接跳过）。
pub(crate) fn split_db_track_id(db_id: &str) -> Option<(SourceId, String)> {
    let (p, id) = db_id.split_once(':')?;
    let platform = SourceId::parse(p)?;
    Some((platform, id.to_string()))
}

/// 在线曲目入库/更新（§8.3 入库时机：进入队列 / 收藏 / 加歌单 / 播放历史）。
/// 搜索结果与榜单不入库；本地曲目由扫描器（§13）负责，这里跳过。
pub(crate) fn upsert_tracks(conn: &Connection, tracks: &[&Track]) -> Result<(), rusqlite::Error> {
    let now = now_ms();
    for t in tracks {
        if t.platform.is_local() {
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

/// 把查询行还原成 Track：列序固定为
/// (sid, platform, name, singer, album, pic_url, duration_ms, music_id)。
///
/// 音源包全面开放后宿主不再认识平台清单，所以这里几乎不再丢弃任何行 ——
/// 只有「空平台」或「含 `:` 的平台」会被跳过（后者会拆坏 `platform:id` 主键，
/// 见 `split_db_track_id`）。此前这里是**静默丢行**的根因：音源包新增平台后，
/// 该平台的曲目会从所有列表里无声消失。
pub(crate) fn track_from_row(row: &rusqlite::Row<'_>) -> Result<Option<Track>, rusqlite::Error> {
    let platform: String = row.get(1)?;
    let Some(platform) = SourceId::parse(&platform) else {
        return Ok(None);
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
