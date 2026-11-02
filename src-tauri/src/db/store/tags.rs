//! 标签编辑的撤销清单：`tag_edits` 表（A2，2026-11-01）。
//!
//! 写文件标签是**破坏性操作**（用户编辑错一次就把文件里的原值覆盖了），分析
//! 文档的硬要求是「写前留存原值以便撤销」。这里只做清单的存取，真正的读改写
//! 在 `crate::tags`。
//!
//! 口径：
//! - 一次「保存」共用一个 `batch`（单曲编辑就是一个文件、批量编辑是 N 个文件）；
//! - `before_json` 是 [`crate::tags::TagValues`] 的序列化——整份原值，不是 diff，
//!   撤销时不需要推断「原来有没有这个字段」；
//! - 只保留最近 [`MAX_BATCHES`] 批，`prune_tag_edits` 在每次写入后裁一次，避免
//!   长年累月把用户改过的每一首歌都留在库里。

use rusqlite::{params, Connection};

use super::now_ms;

/// 保留的批次数上限。够撤销最近 20 次编辑，又不至于把表撑大。
pub(crate) const MAX_BATCHES: i64 = 20;

/// 一批撤销清单里的一行。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TagEditRow {
    pub path: String,
    pub before_json: String,
}

/// 记下「某个文件写标签前的原值」。同一批写多个文件就是多次调用。
pub(crate) fn record_tag_edit(
    conn: &Connection,
    batch: &str,
    path: &str,
    before_json: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO tag_edits (batch, path, before_json, at) VALUES (?1, ?2, ?3, ?4)",
        params![batch, path, before_json, now_ms()],
    )?;
    Ok(())
}

/// 取回某一批的全部原值（撤销用）。按写入顺序返回，撤销时逐条反向写回。
pub(crate) fn tag_edit_batch(
    conn: &Connection,
    batch: &str,
) -> Result<Vec<TagEditRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT path, before_json FROM tag_edits WHERE batch = ?1 ORDER BY id",
    )?;
    let rows = stmt.query_map(params![batch], |row| {
        Ok(TagEditRow {
            path: row.get(0)?,
            before_json: row.get(1)?,
        })
    })?;
    rows.collect()
}

/// 撤销成功后删掉这批清单：同一批不能被撤销两次（第二次会把中间状态当成原值）。
pub(crate) fn drop_tag_edit_batch(
    conn: &Connection,
    batch: &str,
) -> Result<usize, rusqlite::Error> {
    conn.execute("DELETE FROM tag_edits WHERE batch = ?1", params![batch])
}

/// 裁到最近 [`MAX_BATCHES`] 批。返回删掉的行数（0 = 没超）。
///
/// 同一毫秒内的多批（批量编辑写得很快）靠 `MAX(id)` 兜底排序，否则「谁更新」
/// 由 SQLite 的实现细节决定，可能把刚写的那批当旧的裁掉。
pub(crate) fn prune_tag_edits(conn: &Connection) -> Result<usize, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT batch FROM tag_edits GROUP BY batch ORDER BY MAX(at) DESC, MAX(id) DESC LIMIT -1 OFFSET ?1",
    )?;
    let stale: Vec<String> = stmt
        .query_map(params![MAX_BATCHES], |row| row.get::<_, String>(0))?
        .collect::<Result<_, _>>()?;
    let mut removed = 0usize;
    for batch in stale {
        removed += conn.execute("DELETE FROM tag_edits WHERE batch = ?1", params![batch])?;
    }
    Ok(removed)
}

/// 最近一批（给界面判断「还有没有可撤销的」）。
pub(crate) fn latest_tag_edit_batch(conn: &Connection) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT batch FROM tag_edits ORDER BY at DESC, id DESC LIMIT 1",
        [],
        |row| row.get::<_, String>(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(other),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::store::tests::new_conn;

    #[test]
    fn records_reads_and_drops_a_batch() {
        let conn = new_conn();
        record_tag_edit(&conn, "b1", "D:/m/a.mp3", "{\"title\":\"x\"}").unwrap();
        record_tag_edit(&conn, "b1", "D:/m/b.mp3", "{}").unwrap();
        let rows = tag_edit_batch(&conn, "b1").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].path, "D:/m/a.mp3");
        assert_eq!(rows[0].before_json, "{\"title\":\"x\"}");
        assert_eq!(latest_tag_edit_batch(&conn).unwrap().as_deref(), Some("b1"));

        assert_eq!(drop_tag_edit_batch(&conn, "b1").unwrap(), 2);
        assert!(tag_edit_batch(&conn, "b1").unwrap().is_empty());
        assert!(latest_tag_edit_batch(&conn).unwrap().is_none());
    }

    #[test]
    fn prune_keeps_only_the_newest_batches() {
        let conn = new_conn();
        let total = MAX_BATCHES + 3;
        for i in 0..total {
            record_tag_edit(&conn, &format!("b{i}"), "D:/m/a.mp3", "{}").unwrap();
        }
        // 3 批被裁掉，每批 1 行
        assert_eq!(prune_tag_edits(&conn).unwrap(), 3);
        assert!(tag_edit_batch(&conn, "b0").unwrap().is_empty());
        assert!(tag_edit_batch(&conn, "b2").unwrap().is_empty());
        assert_eq!(tag_edit_batch(&conn, "b3").unwrap().len(), 1);
        assert_eq!(
            tag_edit_batch(&conn, &format!("b{}", total - 1)).unwrap().len(),
            1
        );
        // 没超上限时不动
        assert_eq!(prune_tag_edits(&conn).unwrap(), 0);
    }

    #[test]
    fn latest_prefers_the_most_recently_written_batch() {
        let conn = new_conn();
        record_tag_edit(&conn, "old", "D:/m/a.mp3", "{}").unwrap();
        record_tag_edit(&conn, "new", "D:/m/b.mp3", "{}").unwrap();
        assert_eq!(latest_tag_edit_batch(&conn).unwrap().as_deref(), Some("new"));
    }
}
