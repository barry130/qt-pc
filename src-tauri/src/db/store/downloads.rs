//! 下载任务域（DESIGN §5.3）：`download_tasks` 生命周期、进度、去重与离线查找。
//!
//! 拆自原 `db/store.rs`（P2-7），函数体与 SQL 一行未改。

use rusqlite::{params, Connection, OptionalExtension};

use crate::provider::types::{Track};

// 跨域共享的小工具（`db_track_id` / `now_ms` / `track_from_row` / `LOCAL_PLATFORM` …）
// 由 store/mod.rs 统一再导出，这里一次性引入，省得每个域各写一长串 use。
use super::*;
// ---------- 下载管理（DESIGN §5.3） ----------

/// 下载任务。曲目信息由 download_tasks.track_id JOIN tracks 得到。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTask {
    pub id: String,
    pub track: Track,
    pub quality: String,
    /// pending / downloading / paused / done / failed / canceled
    pub status: String,
    /// 0.0 ~ 1.0
    pub progress: f64,
    pub file_path: Option<String>,
    pub file_size: Option<i64>,
    pub error: Option<String>,
    /// 断点续传的临时文件路径（`.part`），完成后被重命名为 `file_path`
    #[serde(default)]
    pub part_path: Option<String>,
    /// 服务端声明的总字节数（Content-Length），用于写完后校验
    #[serde(default)]
    pub total_bytes: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 建任务，返回任务 id。曲目本体先入库（本地曲目由扫描器负责）。
/// `part_path` 由调用方按「任务 id 唯一」生成，暂停 / 继续 / 重试都复用它。
pub(crate) fn create_download_task(
    conn: &Connection,
    track: &Track,
    quality: &str,
    part_path: &str,
) -> Result<String, rusqlite::Error> {
    upsert_tracks(conn, &[track])?;
    let now = now_ms();
    let id = format!("dl_{}_{}", now, fastrand::u64(..));
    conn.execute(
        "INSERT INTO download_tasks (id, track_id, platform, quality, status, progress,
                                     part_path, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?6, ?6)",
        params![id, db_track_id(track), track.platform.to_string(), quality, part_path, now],
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

/// 记录服务端声明的总字节数（每次成功建连后写一次，供写完后校验）。
pub(crate) fn set_download_total_bytes(
    conn: &Connection,
    id: &str,
    total: i64,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE download_tasks SET total_bytes = ?1, updated_at = ?2 WHERE id = ?3",
        params![total, now_ms(), id],
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
                part_path = NULL, error = NULL, updated_at = ?3
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

/// 下载任务的公共查询列（`list` / `by_id` / `by_track` 共用，保证映射口径一致）。
const DOWNLOAD_SELECT_COLUMNS: &str = "d.id, d.quality, d.status, d.progress, d.file_path, d.file_size,
            d.error, d.part_path, d.total_bytes, d.created_at, d.updated_at,
            t.id, t.platform, t.title, t.singer, t.album, t.duration_ms, t.music_id";

/// 把一行下载任务映射成 `DownloadTask`。轨道主键解析失败返回 None（脏数据跳过）。
fn map_download_row(row: &rusqlite::Row<'_>) -> Result<Option<DownloadTask>, rusqlite::Error> {
    let db_id: String = row.get(11)?;
    let Some((platform, track_id)) = split_db_track_id(&db_id) else {
        return Ok(None);
    };
    Ok(Some(DownloadTask {
        id: row.get(0)?,
        quality: row.get(1)?,
        status: row.get(2)?,
        progress: row.get(3)?,
        file_path: row.get(4)?,
        file_size: row.get(5)?,
        error: row.get(6)?,
        part_path: row.get(7)?,
        total_bytes: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        track: Track {
            id: track_id,
            platform,
            title: row.get(13)?,
            singer: row.get(14)?,
            album: row.get(15)?,
            pic_url: String::new(),
            duration: row.get::<_, Option<i64>>(16)?.unwrap_or(0) as f64 / 1000.0,
            music_id: row.get(17)?,
        },
    }))
}

/// 下载列表（按创建时间倒序）。
pub(crate) fn list_download_tasks(conn: &Connection) -> Result<Vec<DownloadTask>, rusqlite::Error> {
    let sql = format!(
        "SELECT {DOWNLOAD_SELECT_COLUMNS}
           FROM download_tasks d
           JOIN tracks t ON t.id = d.track_id
          ORDER BY d.created_at DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        if let Some(t) = map_download_row(row)? {
            out.push(t);
        }
    }
    Ok(out)
}

/// 按任务 id 取单条（重试 / 继续前读原参数用）。
pub(crate) fn download_task_by_id(
    conn: &Connection,
    id: &str,
) -> Result<Option<DownloadTask>, rusqlite::Error> {
    let sql = format!(
        "SELECT {DOWNLOAD_SELECT_COLUMNS}
           FROM download_tasks d
           JOIN tracks t ON t.id = d.track_id
          WHERE d.id = ?1"
    );
    conn.query_row(&sql, params![id], |row| map_download_row(row))
        .optional()
        .map(Option::flatten)
}

/// 同一曲目 + 音质是否已有任务（去重）。已完成 / 进行中 / 暂停都算命中，
/// 只有失败 / 取消的任务不挡新任务。
pub(crate) fn find_download_task(
    conn: &Connection,
    db_track_id: &str,
    quality: &str,
) -> Result<Option<DownloadTask>, rusqlite::Error> {
    let sql = format!(
        "SELECT {DOWNLOAD_SELECT_COLUMNS}
           FROM download_tasks d
           JOIN tracks t ON t.id = d.track_id
          WHERE d.track_id = ?1 AND d.quality = ?2
            AND d.status IN ('pending', 'downloading', 'paused', 'done')
          LIMIT 1"
    );
    conn.query_row(&sql, params![db_track_id, quality], |row| map_download_row(row))
        .optional()
        .map(Option::flatten)
}

/// 通用状态更新（暂停 / 取消 / 重试 / 失败共用）。`error = None` 时清空错误。
pub(crate) fn set_download_status(
    conn: &Connection,
    id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE download_tasks SET status = ?1, error = ?2, updated_at = ?3 WHERE id = ?4",
        params![status, error, now_ms(), id],
    )?;
    Ok(())
}

/// 重试前重置：回到 pending、清进度与错误（文件由下载器按 `.part` 续传决定去留）。
pub(crate) fn reset_download_for_retry(
    conn: &Connection,
    id: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE download_tasks
            SET status = 'pending', progress = 0, error = NULL, updated_at = ?1
          WHERE id = ?2",
        params![now_ms(), id],
    )?;
    Ok(())
}

/// 记录 / 更新临时文件路径（续传、重试都复用同一个 `.part`）。
pub(crate) fn set_download_part_path(
    conn: &Connection,
    id: &str,
    part_path: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE download_tasks SET part_path = ?1, updated_at = ?2 WHERE id = ?3",
        params![part_path, now_ms(), id],
    )?;
    Ok(())
}

/// 应用启动时清理：上次退出时仍在 pending / downloading 的任务已无工作线程，
/// 统一落成 paused，避免界面永远显示「下载中」。
pub(crate) fn mark_stale_downloads_paused(conn: &Connection) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE download_tasks
            SET status = 'paused', error = '上次未完成，点击「继续」接着下载', updated_at = ?1
          WHERE status IN ('pending', 'downloading')",
        params![now_ms()],
    )
}

/// 离线播放用：该曲目是否有已下载完成且文件路径在库的任务。
/// 返回文件路径（是否仍存在由调用方确认）。
pub(crate) fn downloaded_file_for(
    conn: &Connection,
    db_track_id: &str,
) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT file_path FROM download_tasks
          WHERE track_id = ?1 AND status = 'done' AND file_path IS NOT NULL
          ORDER BY updated_at DESC LIMIT 1",
        params![db_track_id],
        |r| r.get::<_, String>(0),
    )
    .optional()
}

/// 已下载完成的曲目 db 主键集合（前端给「已下载」打标用）。
pub(crate) fn downloaded_track_ids(conn: &Connection) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT track_id FROM download_tasks
          WHERE status = 'done' AND file_path IS NOT NULL",
    )?;
    let out = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .filter_map(Result::ok)
        .collect();
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

/// 批量删除任务记录（单事务），返回被删任务的 `(成品路径, 临时路径)`，
/// 供调用方在事务外决定删哪些文件。语义与 `delete_download_task` 一致。
pub(crate) fn delete_download_tasks(
    conn: &Connection,
    ids: &[String],
) -> Result<Vec<(Option<String>, Option<String>)>, rusqlite::Error> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let tx = conn.unchecked_transaction()?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(t) = download_task_by_id(&tx, id)? {
            out.push((t.file_path, t.part_path));
        }
        tx.execute("DELETE FROM download_tasks WHERE id = ?1", params![id])?;
    }
    tx.commit()?;
    Ok(out)
}
