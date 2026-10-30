//! 下载任务域（DESIGN §5.3）：`download_tasks` 生命周期、进度、去重与离线查找。
//!
//! 拆自原 `db/store.rs`（P2-7），函数体与 SQL 一行未改。

use rusqlite::{params, Connection, OptionalExtension};

use crate::provider::types::Track;

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
    /// **请求**档位：用户点下载时选的（`128` / `320` / `flac` / 包声明的任意档）
    pub quality: String,
    /// **实测**档位：取址时按「实测字节 ÷ 时长」重标的结果（只降不升）。
    /// `None` = 这次没测出来，显示方应退回 `quality`。
    #[serde(default)]
    pub actual_quality: Option<String>,
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
///
/// 「只入队不取址」后，新建时还没有 `.part` —— 成品名要等取到地址才知道
/// 扩展名 —— `part_path` 传 `None`（NULL = 还没轮到取址，与空串分开，口径
/// 同 `actual_quality`），取址后由 `set_download_part_path` 补写。
/// `actual_quality` 是取址时算出的实测档位，没测出来传 `None`。
pub(crate) fn create_download_task(
    conn: &Connection,
    track: &Track,
    quality: &str,
    part_path: Option<&str>,
    actual_quality: Option<&str>,
) -> Result<String, rusqlite::Error> {
    upsert_tracks(conn, &[track])?;
    let now = now_ms();
    let id = format!("dl_{}_{}", now, fastrand::u64(..));
    conn.execute(
        "INSERT INTO download_tasks (id, track_id, platform, quality, actual_quality,
                                     status, progress, part_path, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?7, ?7)",
        params![
            id,
            db_track_id(track),
            track.platform.to_string(),
            quality,
            actual_quality,
            part_path,
            now
        ],
    )?;
    Ok(id)
}

/// 记录取址时算出的实测档位（`None` = 没测出来，写 NULL）。
///
/// 续传 / 重试时会重新取址，实测档位可能和上次不同（换了线路），所以是覆盖写。
pub(crate) fn set_download_actual_quality(
    conn: &Connection,
    id: &str,
    actual: Option<&str>,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE download_tasks SET actual_quality = ?1, updated_at = ?2 WHERE id = ?3",
        params![actual, now_ms(), id],
    )?;
    Ok(())
}

pub(crate) fn update_download_progress(
    conn: &Connection,
    id: &str,
    progress: f64,
) -> Result<(), rusqlite::Error> {
    // 状态守卫：暂停/取消只置取消旗标，后台任务要等下一个 chunk 边界才收工
    // （最长 CHUNK_TIMEOUT）。这中间任何一次进度写都会把刚落的终态改回
    // 'downloading'，任务随后以 Stopped 退出、不再写任何东西 → 行卡在
    // 「下载中 + 冻结进度」，要重启应用才被 mark_stale_downloads_paused 修正
    // （评审，2026-10-29 修）。
    conn.execute(
        "UPDATE download_tasks SET status = 'downloading', progress = ?1, updated_at = ?2
          WHERE id = ?3 AND status IN ('pending', 'queued', 'downloading')",
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
    let now = now_ms();
    let updated = conn.execute(
        "UPDATE download_tasks
            SET status = 'done', progress = 1, file_path = ?1, file_size = ?2,
                part_path = NULL, error = NULL, updated_at = ?3
          WHERE id = ?4",
        params![file_path, file_size, now, id],
    )?;
    // 任务行已被用户删掉（下载中点删除）时，这一趟什么都别写：
    // 否则「刚删掉的下载」会被下面这段回填进 download_files 账本，于是
    // 文件复活在磁盘上、又回到「已下载」列表里（评审，2026-10-29 修）。
    if updated == 0 {
        return Ok(());
    }
    // 本地优先账本（§7.13）：下载完成当场把「身份 → 文件」固化进 download_files。
    // 任务行之后被删（清空下载列表）不影响解析链——这正是账本存在的意义。
    // 元数据从 tracks 行冗余一份，仅供 K2 元数据级匹配兜底（身份级命中永远优先）。
    let key: Option<String> = conn
        .query_row(
            "SELECT track_id FROM download_tasks WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(key) = key {
        let meta = conn
            .query_row(
                "SELECT title, singer, duration_ms FROM tracks WHERE id = ?1",
                params![key],
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, Option<String>>(1)?,
                        r.get::<_, Option<i64>>(2)?,
                    ))
                },
            )
            .optional()?
            .unwrap_or((None, None, None));
        upsert_download_file(
            conn,
            &key,
            file_path,
            meta.0.as_deref().unwrap_or(""),
            meta.1.as_deref().unwrap_or(""),
            meta.2.unwrap_or(0),
            Some(file_size),
        )?;
    }
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
const DOWNLOAD_SELECT_COLUMNS: &str =
    "d.id, d.quality, d.actual_quality, d.status, d.progress, d.file_path, d.file_size,
            d.error, d.part_path, d.total_bytes, d.created_at, d.updated_at,
            t.id, t.platform, t.title, t.singer, t.album, t.duration_ms, t.music_id,
            t.start_ms, t.end_ms";

/// 把一行下载任务映射成 `DownloadTask`。轨道主键解析失败返回 None（脏数据跳过）。
fn map_download_row(row: &rusqlite::Row<'_>) -> Result<Option<DownloadTask>, rusqlite::Error> {
    let db_id: String = row.get(12)?;
    let Some((platform, track_id)) = split_db_track_id(&db_id) else {
        return Ok(None);
    };
    Ok(Some(DownloadTask {
        id: row.get(0)?,
        quality: row.get(1)?,
        actual_quality: row.get(2)?,
        status: row.get(3)?,
        progress: row.get(4)?,
        file_path: row.get(5)?,
        file_size: row.get(6)?,
        error: row.get(7)?,
        part_path: row.get(8)?,
        total_bytes: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        track: Track {
            id: track_id,
            platform,
            title: row.get(14)?,
            singer: row.get(15)?,
            album: row.get(16)?,
            pic_url: String::new(),
            duration: row.get::<_, Option<i64>>(17)?.unwrap_or(0) as f64 / 1000.0,
            music_id: row.get(18)?,
            start_ms: row.get::<_, Option<i64>>(19)?.and_then(|v| u64::try_from(v).ok()),
            end_ms: row.get::<_, Option<i64>>(20)?.and_then(|v| u64::try_from(v).ok()),
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
    conn.query_row(&sql, params![id], map_download_row)
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
    conn.query_row(&sql, params![db_track_id, quality], |row| {
        map_download_row(row)
    })
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
pub(crate) fn reset_download_for_retry(conn: &Connection, id: &str) -> Result<(), rusqlite::Error> {
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

/// 批量暂停（多选 / 全部暂停共用）：只把仍在进行的任务（pending / downloading）
/// 置为 paused 并写上继续提示，已完成 / 失败 / 已取消的行原样跳过。
/// 返回实际置上的条数。逐条 UPDATE + 状态过滤，天然幂等：重复调用不会把
/// paused 改成 paused 之外的任何东西，也不会碰已完成的行。
pub(crate) fn pause_download_tasks(
    conn: &Connection,
    ids: &[String],
) -> Result<usize, rusqlite::Error> {
    let mut paused = 0;
    for id in ids {
        paused += conn.execute(
            "UPDATE download_tasks
                SET status = 'paused', error = '已暂停，点击「继续」接着下载', updated_at = ?2
              WHERE id = ?1 AND status IN ('pending', 'downloading')",
            params![id, now_ms()],
        )?;
    }
    Ok(paused)
}

/// 批量取消（多选 / 单选取消共用）：把仍在进行或暂停的任务置为 canceled，
/// 返回 (实际取消的条数, 这些任务的 `.part` 路径)，调用方负责删临时文件。
/// `.part` 在取消后没有续传价值，留在磁盘上只会被用户当成垃圾文件。
pub(crate) fn cancel_download_tasks(
    conn: &Connection,
    ids: &[String],
) -> Result<(usize, Vec<String>), rusqlite::Error> {
    let mut canceled = 0;
    let mut parts: Vec<String> = Vec::new();
    for id in ids {
        let affected = conn.execute(
            "UPDATE download_tasks
                SET status = 'canceled', error = NULL, updated_at = ?2
              WHERE id = ?1 AND status IN ('pending', 'downloading', 'paused')",
            params![id, now_ms()],
        )?;
        if affected == 0 {
            continue;
        }
        canceled += affected;
        if let Some(part) = conn
            .query_row(
                "SELECT part_path FROM download_tasks WHERE id = ?1",
                params![id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
        {
            parts.push(part);
        }
    }
    Ok((canceled, parts))
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
#[allow(clippy::type_complexity)] // (成品路径, 临时路径) 二元组即文档化的返回契约，见上方 doc
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

// ---------- 本地优先播放（DESIGN §7.13）：文件账本 / 孤儿索引 ----------
//
// 账本（download_files）与孤儿（orphan_files）的表结构见 migrations.rs 的 V19。
// 写入方与清理时机：
// - 下载完成 → `upsert_download_file`（记录身份→文件，行删了它还在）；
// - 删除任务且勾选删文件 / 对账发现文件不在 → `remove_download_file_by_path`；
// - 启动对账 → `rescue_done_tasks_to_ledger`（V19 前已 done 的存量补进账本）、
//   `prune_*` 清掉文件已消失的条目、孤儿扫描重建 orphan_files（见 local_first.rs）。

/// 账本/孤儿共用的「本地文件 + 元数据」快照：K2 严格匹配（标题+歌手+时长）
/// 的输入。只要文件路径 + 元数据；身份键匹配直接在 SQL 里按 key 查（`download_file_for`）。
#[derive(Debug, Clone)]
pub(crate) struct MetaFileRow {
    pub path: String,
    pub title: String,
    pub singer: String,
    pub duration_ms: i64,
}

/// 下载完成写账本（幂等）：身份 → 文件 + 冗余元数据。
/// 元数据来自下载时的曲目快照，仅供 K2 元数据级匹配兜底；身份级命中永远优先。
pub(crate) fn upsert_download_file(
    conn: &Connection,
    key: &str,
    file_path: &str,
    title: &str,
    singer: &str,
    duration_ms: i64,
    size: Option<i64>,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO download_files (key, file_path, title, singer, duration_ms, size, saved_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(key) DO UPDATE SET
           file_path = excluded.file_path,
           title = excluded.title,
           singer = excluded.singer,
           duration_ms = excluded.duration_ms,
           size = excluded.size,
           saved_at = excluded.saved_at",
        params![key, file_path, title, singer, duration_ms, size, now_ms()],
    )?;
    Ok(())
}

/// 账本按身份查（只查账本，不含 download_tasks 兜底）。
pub(crate) fn download_file_for(
    conn: &Connection,
    key: &str,
) -> Result<Option<MetaFileRow>, rusqlite::Error> {
    conn.query_row(
        "SELECT file_path, title, singer, duration_ms FROM download_files WHERE key = ?1",
        params![key],
        |r| {
            Ok(MetaFileRow {
                path: r.get(0)?,
                title: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                singer: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                duration_ms: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
            })
        },
    )
    .optional()
}

/// 统一身份级查找：账本优先（任务行删了它还在），再回落 download_tasks
/// （V19 之前已经下载完成的存量）。返回文件路径，存在性由调用方确认。
pub(crate) fn local_file_for_track(
    conn: &Connection,
    db_track_id: &str,
) -> Result<Option<MetaFileRow>, rusqlite::Error> {
    if let Some(row) = download_file_for(conn, db_track_id)? {
        return Ok(Some(row));
    }
    conn.query_row(
        "SELECT t.file_path, tr.title, tr.singer, tr.duration_ms
           FROM download_tasks t LEFT JOIN tracks tr ON tr.id = t.track_id
          WHERE t.track_id = ?1 AND t.status = 'done' AND t.file_path IS NOT NULL
          ORDER BY t.updated_at DESC LIMIT 1",
        params![db_track_id],
        |r| {
            Ok(MetaFileRow {
                path: r.get(0)?,
                title: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                singer: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                duration_ms: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
            })
        },
    )
    .optional()
}

/// 按文件路径删账本条目（删任务勾删文件 / 对账发现文件没了），返回删掉的行数。
pub(crate) fn remove_download_file_by_path(
    conn: &Connection,
    file_path: &str,
) -> Result<usize, rusqlite::Error> {
    conn.execute("DELETE FROM download_files WHERE file_path = ?1", params![file_path])
}

/// 全量账本（对账清尸体 + K2 元数据级匹配的候选池 B 的一部分）。
pub(crate) fn all_download_files(conn: &Connection) -> Result<Vec<MetaFileRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT file_path, title, singer, duration_ms FROM download_files",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(MetaFileRow {
                path: r.get(0)?,
                title: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                singer: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                duration_ms: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
            })
        })?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

/// V19 存量救援：把 download_tasks 里已 done 且账本还没有的行补进账本。
/// 幂等（ON CONFLICT 跳过），返回补写的行数。
pub(crate) fn rescue_done_tasks_to_ledger(conn: &Connection) -> Result<usize, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO download_files (key, file_path, title, singer, duration_ms, saved_at)
         SELECT t.track_id, t.file_path, tr.title, tr.singer, tr.duration_ms, ?1
           FROM download_tasks t LEFT JOIN tracks tr ON tr.id = t.track_id
          WHERE t.status = 'done' AND t.file_path IS NOT NULL",
    )?;
    let n = stmt.execute(params![now_ms()])?;
    Ok(n)
}

/// 孤儿文件入库（对账扫描重建，见 local_first.rs）。
pub(crate) fn upsert_orphan_file(
    conn: &Connection,
    file_path: &str,
    title: &str,
    singer: &str,
    duration_ms: i64,
    size: Option<i64>,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO orphan_files (file_path, title, singer, duration_ms, size, indexed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(file_path) DO UPDATE SET
           title = excluded.title,
           singer = excluded.singer,
           duration_ms = excluded.duration_ms,
           size = excluded.size,
           indexed_at = excluded.indexed_at",
        params![file_path, title, singer, duration_ms, size, now_ms()],
    )?;
    Ok(())
}

/// 全量孤儿（K2 元数据级匹配的候选池 B 的一部分）。
pub(crate) fn all_orphan_files(conn: &Connection) -> Result<Vec<MetaFileRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT file_path, title, singer, duration_ms FROM orphan_files",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(MetaFileRow {
                path: r.get(0)?,
                title: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                singer: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                duration_ms: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
            })
        })?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

/// 清空孤儿索引（每次对账全量重建前调用）。
pub(crate) fn clear_orphan_files(conn: &Connection) -> Result<usize, rusqlite::Error> {
    conn.execute("DELETE FROM orphan_files", [])
}

/// 删单条孤儿（解析链发现文件已消失时顺手清尸体，见 local_first.rs）。
pub(crate) fn remove_orphan_file(conn: &Connection, file_path: &str) -> Result<usize, rusqlite::Error> {
    conn.execute("DELETE FROM orphan_files WHERE file_path = ?1", params![file_path])
}
