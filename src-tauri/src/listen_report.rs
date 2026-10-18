//! 听歌报告查询：只读、可分页的曲目 / 歌手 / 音源排行。
//!
//! 报告直接读取 `play_stats JOIN tracks`（带 `days` 窗口时改读 `play_days` 的
//! 窗口聚合，见 [`SOURCE_CTE`]），不把全表拉进 Rust 再截断。
//! 计数与当前页查询在同一个 SQLite 只读事务中完成，避免 total 与 items
//! 来自不同的数据快照。
//!
//! 两条查询路径共用一个数据源形状：`get_listen_report` 给累计榜与「近 N 天」的
//! 分页明细，`get_listen_day_report` 在此基础上再多给一份逐日趋势与窗口总量，
//! 专门喂报告页的日榜卡片（今天 / 近 7 天 / 近 30 天）。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::provider::types::Track;
use crate::AppState;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ListenReportKind {
    Tracks,
    Singers,
    Sources,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ListenReportOrder {
    Count,
    Duration,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenReportQuery {
    pub kind: ListenReportKind,
    pub order: ListenReportOrder,
    pub offset: i64,
    pub limit: i64,
    #[serde(default)]
    pub singer: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    /// 只看最近 N 天（1 = 今天 / 7 / 30）；省略 = 全部累计。
    ///
    /// 带上它时明细读 `play_days` 的窗口聚合，分组、排序、分页口径与累计榜完全一致，
    /// 于是「今天听过哪些歌手」点进去看到的歌，与那一天榜单里的歌手是同一批。
    #[serde(default)]
    pub days: Option<i64>,
}

/// 日榜查询：窗口天数 + 分组维度 + 排行条数（不分页，只取前 N 条）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenDayReportQuery {
    pub kind: ListenReportKind,
    pub order: ListenReportOrder,
    /// 窗口天数：1 = 今天、7 = 近 7 天、30 = 近 30 天
    pub days: i64,
    /// 排行条数（日榜一次只显示前 N 条，不分页）
    pub limit: i64,
}

/// 窗口内某一天的汇总（没有记录的日子也会出现在列表里，值为 0）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenDayPoint {
    /// 本地自然日 `YYYY-MM-DD`
    pub day: String,
    pub play_count: i64,
    pub total_played_ms: i64,
}

/// 日榜一次性汇总：逐日趋势 + 窗口总量 + 前 N 条排行。
///
/// 逐日趋势与排行来自同一张 `play_days`，一次往返就能把卡片填满，
/// 前端不需要为「切换时间档」再补一次逐日查询。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenDayReport {
    /// 窗口内逐日汇总，升序；没有记录的日子补 0，趋势轴因此不会缺格
    pub daily: Vec<ListenDayPoint>,
    /// 窗口内有记录的天数
    pub active_days: i64,
    /// 窗口内总有效播放次数（不受 limit 截断）
    pub total_plays: i64,
    /// 窗口内总实际收听时长（毫秒）
    pub total_played_ms: i64,
    /// 窗口内去重曲目数
    pub track_count: i64,
    /// 排行前 limit 条，口径与 `get_listen_report` 带 `days` 时完全一致
    pub items: Vec<ListenReportEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenReportEntry {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub play_count: i64,
    pub total_played_ms: i64,
    pub track_count: i64,
    pub last_played_at: i64,
    pub track: Option<Track>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenReportResult {
    pub items: Vec<ListenReportEntry>,
    pub total: i64,
}

fn page_bounds(query: &ListenReportQuery) -> (i64, i64) {
    let offset = query.offset.max(0);
    let limit = match query.limit {
        0 => 50,
        n if n < 1 => 1,
        n => n.min(100),
    };
    (offset, limit)
}

/// 「近 N 天」窗口的合法范围：1 天（今天）到一年。
///
/// 端点来自前端的分段控件（1 / 7 / 30），这里只做防御性钳位：
/// 0 或负数会推成「今天之后」，把窗口清空；超大值会让递归 CTE 生成过多行。
fn window_days(days: i64) -> i64 {
    days.clamp(1, 365)
}

/// 明细的数据源 CTE（名字固定为 `s`，下面的分组 / 排序 / 计数 SQL 都按这个别名写）。
///
/// 两个分支写在**一条** CTE 里，而不是按模式拼两套 SQL，原因有两个：
/// 1. `?5`（当前时刻）/ `?6`（往前天数）在两种模式下都必须出现在语句里 ——
///    rusqlite 对多余的绑定值会报 `InvalidParameterCount`，参数个数必须与占位符一致；
/// 2. 聚合回「每首歌一行」的形态之后，三种分组、两种排序、分页和计数
///    全都能复用同一套 SQL，差别只有这一段。
///
/// 不带窗口（`?5 IS NULL`）读 `play_stats` 全量累计，与加日榜之前逐字一致；
/// 带窗口读 `play_days` 在窗口内的聚合。窗口下界用与**写入侧完全相同**的
/// `date(...)` 表达式推出：读写两侧同一个函数、同一个时区口径，
/// 不会出现「写进周三、查出来算周二」的错位。
///
/// `?5 IS NULL` / `?5 IS NOT NULL` 不是可省的分支判断：SQLite 只在
/// `play_stats` / `play_days` 上各扫一次，NULL 那一侧直接产出零行。
const SOURCE_CTE: &str = "SELECT track_id, play_count, total_played_ms, last_played_at
           FROM play_stats
          WHERE ?5 IS NULL
         UNION ALL
         SELECT track_id, SUM(play_count), SUM(total_played_ms), MAX(last_played_at)
           FROM play_days
          WHERE ?5 IS NOT NULL
            AND day >= date(?5 / 1000, 'unixepoch', 'localtime', '-' || ?6 || ' days')
          GROUP BY track_id";

/// All predicates here are fixed SQL. User supplied filters are always bound
/// parameters; only the enum values select one of these fixed query shapes.
const FILTER: &str = "WHERE (s.play_count > 0 OR s.total_played_ms > 0)
  AND (?1 IS NULL OR t.singer = ?1)
  AND (?2 IS NULL OR t.platform = ?2)";

const SINGER_FILTER: &str = "WHERE (s.play_count > 0 OR s.total_played_ms > 0)
  AND trim(t.singer) <> ''
  AND (?1 IS NULL OR t.singer = ?1)
  AND (?2 IS NULL OR t.platform = ?2)";

fn order_sql(order: ListenReportOrder, kind: ListenReportKind) -> &'static str {
    match (kind, order) {
        (ListenReportKind::Tracks, ListenReportOrder::Count) => {
            "s.play_count DESC, s.total_played_ms DESC, s.last_played_at DESC, t.id ASC"
        }
        (ListenReportKind::Tracks, ListenReportOrder::Duration) => {
            "s.total_played_ms DESC, s.play_count DESC, s.last_played_at DESC, t.id ASC"
        }
        (ListenReportKind::Singers, ListenReportOrder::Count) => {
            "SUM(s.play_count) DESC, SUM(s.total_played_ms) DESC, MAX(s.last_played_at) DESC, t.singer ASC"
        }
        (ListenReportKind::Singers, ListenReportOrder::Duration) => {
            "SUM(s.total_played_ms) DESC, SUM(s.play_count) DESC, MAX(s.last_played_at) DESC, t.singer ASC"
        }
        (ListenReportKind::Sources, ListenReportOrder::Count) => {
            "SUM(s.play_count) DESC, SUM(s.total_played_ms) DESC, MAX(s.last_played_at) DESC, t.platform ASC"
        }
        (ListenReportKind::Sources, ListenReportOrder::Duration) => {
            "SUM(s.total_played_ms) DESC, SUM(s.play_count) DESC, MAX(s.last_played_at) DESC, t.platform ASC"
        }
    }
}

/// 计数与分页 SQL 的公共前缀：数据源 CTE + 与 `tracks` 的连接。
/// 两个查询共用同一个 `s`，因此 total 与 items 必然来自同一份数据。
const FROM_SOURCE: &str = "FROM s JOIN tracks t ON t.id = s.track_id ";

fn count_sql(kind: ListenReportKind) -> String {
    let projection = match kind {
        ListenReportKind::Tracks => "COUNT(*)",
        ListenReportKind::Singers => "COUNT(DISTINCT t.singer)",
        ListenReportKind::Sources => "COUNT(DISTINCT t.platform)",
    };
    format!("WITH s AS ({SOURCE_CTE}) SELECT {projection} {FROM_SOURCE}")
}

/// 一次报表查询的六个绑定值。
///
/// 抽成结构体是为了让窗口参数（`?5` 当前时刻 / `?6` 往前天数）有个确定的宿主：
/// 不带窗口时它们绑定 NULL，但**必须**出现在语句里才能凑够占位符个数
/// （见 [`SOURCE_CTE`] 的说明），因此不能按模式少绑两个。
struct ReportParams<'a> {
    singer: Option<&'a str>,
    platform: Option<&'a str>,
    limit: i64,
    offset: i64,
    /// 当前时刻（毫秒）；不带窗口时为 NULL，`SOURCE_CTE` 据此走累计分支
    now: Option<i64>,
    /// 窗口下界相对今天往前几天（窗口天数 - 1）；不带窗口时为 NULL
    back: Option<i64>,
}

impl ReportParams<'_> {
    fn bindings(&self) -> Vec<&dyn rusqlite::ToSql> {
        vec![
            &self.singer,
            &self.platform,
            &self.limit,
            &self.offset,
            &self.now,
            &self.back,
        ]
    }
}

fn query_report(
    conn: &Connection,
    query: &ListenReportQuery,
) -> Result<ListenReportResult, rusqlite::Error> {
    let (offset, limit) = page_bounds(query);
    let window = query.days.map(window_days);
    let bind = ReportParams {
        singer: query.singer.as_deref(),
        platform: query.platform.as_deref(),
        limit,
        offset,
        // 时刻只在带窗口时才需要：绑定值恒在，值本身可以为 NULL。
        now: window.map(|_| crate::astral::now_ms()),
        back: window.map(|days| days - 1),
    };
    // `unchecked_transaction` only needs &Connection and keeps the count and
    // page query on one SQLite read snapshot while Database's mutex is held.
    let tx = conn.unchecked_transaction()?;
    let filter = match query.kind {
        ListenReportKind::Singers => SINGER_FILTER,
        ListenReportKind::Tracks | ListenReportKind::Sources => FILTER,
    };
    let total: i64 = tx.query_row(
        &format!("{} {}", count_sql(query.kind), filter),
        bind.bindings().as_slice(),
        |row| row.get(0),
    )?;

    let page_sql = match query.kind {
        ListenReportKind::Tracks => format!(
            "WITH s AS ({SOURCE_CTE})
             SELECT substr(t.id, instr(t.id, ':') + 1), t.platform, t.title,
                    t.singer, t.album, t.pic_url, t.duration_ms, t.music_id,
                    t.start_ms, t.end_ms,
                    t.id, s.play_count, s.total_played_ms, s.last_played_at
               {FROM_SOURCE}
              {filter}
              ORDER BY {} LIMIT ?3 OFFSET ?4",
            order_sql(query.order, query.kind)
        ),
        ListenReportKind::Singers => format!(
            "WITH s AS ({SOURCE_CTE})
             SELECT t.singer, MAX(t.platform),
                    SUM(s.play_count), SUM(s.total_played_ms),
                    COUNT(*), MAX(s.last_played_at)
               {FROM_SOURCE}
              {filter}
              GROUP BY t.singer
              ORDER BY {} LIMIT ?3 OFFSET ?4",
            order_sql(query.order, query.kind)
        ),
        ListenReportKind::Sources => format!(
            "WITH s AS ({SOURCE_CTE})
             SELECT t.platform, t.platform, t.platform,
                    SUM(s.play_count), SUM(s.total_played_ms),
                    COUNT(*), MAX(s.last_played_at)
               {FROM_SOURCE}
              {filter}
              GROUP BY t.platform
              ORDER BY {} LIMIT ?3 OFFSET ?4",
            order_sql(query.order, query.kind)
        ),
    };

    let mut stmt = tx.prepare(&page_sql)?;
    let mut rows = stmt.query(bind.bindings().as_slice())?;
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        let entry = match query.kind {
            ListenReportKind::Tracks => {
                let track = crate::db::store::track_from_row(row)?;
                let Some(track) = track else {
                    continue;
                };
                ListenReportEntry {
                    id: row.get(10)?,
                    name: row.get(2)?,
                    platform: row.get(1)?,
                    play_count: row.get(11)?,
                    total_played_ms: row.get(12)?,
                    track_count: 1,
                    last_played_at: row.get(13)?,
                    track: Some(track),
                }
            }
            ListenReportKind::Singers => ListenReportEntry {
                id: row.get(0)?,
                name: row.get(0)?,
                platform: row.get(1)?,
                play_count: row.get(2)?,
                total_played_ms: row.get(3)?,
                track_count: row.get(4)?,
                last_played_at: row.get(5)?,
                track: None,
            },
            ListenReportKind::Sources => ListenReportEntry {
                id: row.get(0)?,
                name: row.get(1)?,
                platform: row.get(2)?,
                play_count: row.get(3)?,
                total_played_ms: row.get(4)?,
                track_count: row.get(5)?,
                last_played_at: row.get(6)?,
                track: None,
            },
        };
        items.push(entry);
    }
    drop(rows);
    drop(stmt);
    tx.commit()?;
    Ok(ListenReportResult { items, total })
}

/// 窗口内的逐日汇总，**含没有记录的日子**（值为 0），升序。
///
/// 日期轴用递归 CTE 生成完整的 `days` 行再左连接 `play_days`：
/// 趋势图上「这天没听」和「这天不存在」是两件事，缺格会把 30 天的走势
/// 压成看起来连续的几段。日期同样用写入侧的 `date(...)` 表达式推，两边同口径。
fn day_series(
    conn: &Connection,
    now: i64,
    days: i64,
) -> Result<Vec<ListenDayPoint>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE seq(i) AS (
           SELECT 0
           UNION ALL
           SELECT i + 1 FROM seq WHERE i + 1 < ?2
         )
         SELECT date(?1 / 1000, 'unixepoch', 'localtime', '-' || (?2 - 1 - seq.i) || ' days'),
                COALESCE(SUM(d.play_count), 0),
                COALESCE(SUM(d.total_played_ms), 0)
           FROM seq
           LEFT JOIN play_days d
             ON d.day = date(?1 / 1000, 'unixepoch', 'localtime', '-' || (?2 - 1 - seq.i) || ' days')
          GROUP BY seq.i
          ORDER BY seq.i",
    )?;
    let mut rows = stmt.query(rusqlite::params![now, days])?;
    let mut daily = Vec::new();
    while let Some(row) = rows.next()? {
        daily.push(ListenDayPoint {
            day: row.get(0)?,
            play_count: row.get(1)?,
            total_played_ms: row.get(2)?,
        });
    }
    Ok(daily)
}

/// 窗口内去重曲目数（窗口天数决定下界，与 `SOURCE_CTE` 同一表达式）。
fn window_track_count(conn: &Connection, now: i64, days: i64) -> Result<i64, rusqlite::Error> {
    conn.query_row(
        "SELECT COUNT(DISTINCT track_id) FROM play_days
          WHERE day >= date(?1 / 1000, 'unixepoch', 'localtime', '-' || ?2 || ' days')",
        rusqlite::params![now, days - 1],
        |r| r.get(0),
    )
}

/// 日榜：逐日趋势 + 窗口总量 + 前 N 条排行，一次查询全部给出。
///
/// 排行复用 [`query_report`]（`days = Some(..)`），所以日榜的歌手 / 音源 / 歌曲
/// 与「点进去看到的歌」严格同口径 —— 不需要为日榜再写一套分组 SQL。
fn query_day_report(
    conn: &Connection,
    query: &ListenDayReportQuery,
) -> Result<ListenDayReport, rusqlite::Error> {
    let days = window_days(query.days);
    // 日榜只显示前若干条、不分页，上限比累计榜的 100 更紧。
    let limit = query.limit.clamp(1, 50);
    // 一次查询用同一个 `now`：跨零点执行时才不会出现「趋势算今天、排行算昨天」。
    let now = crate::astral::now_ms();
    let daily = day_series(conn, now, days)?;
    let mut total_plays = 0;
    let mut total_played_ms = 0;
    let mut active_days = 0;
    for point in &daily {
        total_plays += point.play_count;
        total_played_ms += point.total_played_ms;
        if point.play_count > 0 || point.total_played_ms > 0 {
            active_days += 1;
        }
    }
    let track_count = window_track_count(conn, now, days)?;
    let items = query_report(
        conn,
        &ListenReportQuery {
            kind: query.kind,
            order: query.order,
            offset: 0,
            limit,
            singer: None,
            platform: None,
            days: Some(days),
        },
    )?
    .items;
    Ok(ListenDayReport {
        daily,
        active_days,
        total_plays,
        total_played_ms,
        track_count,
        items,
    })
}

/// Read-only day-window report IPC. A missing database is an empty report.
#[tauri::command(rename = "get_listen_day_report")]
pub async fn cmd_get_listen_day_report(
    state: State<'_, AppState>,
    query: ListenDayReportQuery,
) -> Result<ListenDayReport, String> {
    let Some(db) = state.db.clone() else {
        return Ok(ListenDayReport {
            daily: Vec::new(),
            active_days: 0,
            total_plays: 0,
            total_played_ms: 0,
            track_count: 0,
            items: Vec::new(),
        });
    };
    tauri::async_runtime::spawn_blocking(move || db.with(|conn| query_day_report(conn, &query)))
        .await
        .map_err(|e| format!("读取日榜失败: {e}"))?
        .map_err(|e| format!("读取日榜失败: {e}"))
}

/// Read-only paginated listen report IPC. A missing database is an empty page.
#[tauri::command(rename = "get_listen_report")]
pub async fn cmd_get_listen_report(
    state: State<'_, AppState>,
    query: ListenReportQuery,
) -> Result<ListenReportResult, String> {
    let Some(db) = state.db.clone() else {
        return Ok(ListenReportResult {
            items: Vec::new(),
            total: 0,
        });
    };
    tauri::async_runtime::spawn_blocking(move || db.with(|conn| query_report(conn, &query)))
        .await
        .map_err(|e| format!("读取听歌报告失败: {e}"))?
        .map_err(|e| format!("读取听歌报告失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::provider::types::SourceId;
    use rusqlite::params;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.pragma_update(None, "foreign_keys", "ON")
            .expect("foreign keys");
        migrations::run(&conn).expect("migrations");
        conn
    }

    fn insert_track(
        conn: &Connection,
        db_id: &str,
        platform: &str,
        title: &str,
        singer: &str,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
    ) {
        conn.execute(
            "INSERT INTO tracks
                (id, platform, title, singer, album, pic_url, duration_ms, music_id,
                 start_ms, end_ms, cue_path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'album', 'pic', 180000, 'mid', ?5, ?6,
                     '/music/disc.cue', 1, 1)",
            params![db_id, platform, title, singer, start_ms, end_ms],
        )
        .expect("insert track");
    }

    fn insert_stat(conn: &Connection, db_id: &str, count: i64, duration: i64, last: i64) {
        conn.execute(
            "INSERT INTO play_stats
                (track_id, play_count, finished_count, last_played_at, total_played_ms)
             VALUES (?1, ?2, 0, ?3, ?4)",
            params![db_id, count, last, duration],
        )
        .expect("insert stat");
    }

    fn query(
        kind: ListenReportKind,
        order: ListenReportOrder,
        offset: i64,
        limit: i64,
    ) -> ListenReportQuery {
        ListenReportQuery {
            kind,
            order,
            offset,
            limit,
            singer: None,
            platform: None,
            days: None,
        }
    }

    #[test]
    fn tracks_keep_platform_identity_and_round_trip_cue_fields() {
        let conn = conn();
        insert_track(
            &conn,
            "wyy:same-id",
            "wyy",
            "网易版",
            "歌手",
            Some(1234),
            Some(5678),
        );
        insert_track(&conn, "qq:same-id", "qq", "QQ版", "歌手", None, None);
        insert_stat(&conn, "wyy:same-id", 1, 1000, 20);
        insert_stat(&conn, "qq:same-id", 1, 2000, 10);

        let report = query_report(
            &conn,
            &query(ListenReportKind::Tracks, ListenReportOrder::Count, 0, 10),
        )
        .expect("report");
        assert_eq!(report.total, 2);
        assert_eq!(report.items[0].id, "qq:same-id");
        assert_eq!(report.items[1].id, "wyy:same-id");
        let cue = report.items[1].track.as_ref().expect("track");
        assert_eq!(cue.platform, SourceId::new("wyy"));
        assert_eq!(cue.id, "same-id");
        assert_eq!(cue.start_ms, Some(1234));
        assert_eq!(cue.end_ms, Some(5678));
    }

    #[test]
    fn groups_keep_collaborators_together_and_include_zero_count_duration() {
        let conn = conn();
        insert_track(&conn, "wyy:a", "wyy", "A", "甲 & 乙", None, None);
        insert_track(&conn, "qq:b", "qq", "B", "甲 & 乙", None, None);
        insert_track(&conn, "kg:c", "kg", "C", "   ", None, None);
        insert_stat(&conn, "wyy:a", 2, 100, 30);
        insert_stat(&conn, "qq:b", 0, 200, 20);
        insert_stat(&conn, "kg:c", 0, 300, 10);

        let singers = query_report(
            &conn,
            &query(
                ListenReportKind::Singers,
                ListenReportOrder::Duration,
                0,
                10,
            ),
        )
        .expect("singers");
        assert_eq!(singers.total, 1, "blank singer is ignored");
        assert_eq!(singers.items[0].id, "甲 & 乙");
        assert_eq!(singers.items[0].play_count, 2);
        assert_eq!(singers.items[0].total_played_ms, 300);
        assert_eq!(singers.items[0].track_count, 2);
        assert!(singers.items[0].track.is_none());

        let sources = query_report(
            &conn,
            &query(
                ListenReportKind::Sources,
                ListenReportOrder::Duration,
                0,
                10,
            ),
        )
        .expect("sources");
        assert_eq!(sources.total, 3);
        assert_eq!(sources.items[0].id, "kg");
        assert_eq!(sources.items[0].play_count, 0);
        assert_eq!(sources.items[0].total_played_ms, 300);
        assert!(sources.items[0].track.is_none());
    }

    #[test]
    fn sorting_pagination_filters_and_limit_boundaries_are_stable() {
        let conn = conn();
        for (id, platform, singer, count, duration, last) in [
            ("a", "wyy", "甲", 3, 100, 10),
            ("b", "wyy", "乙", 3, 200, 20),
            ("c", "qq", "甲", 1, 900, 30),
            ("d", "qq", "丙", 0, 500, 40),
        ] {
            let db_id = format!("{platform}:{id}");
            insert_track(&conn, &db_id, platform, id, singer, None, None);
            insert_stat(&conn, &db_id, count, duration, last);
        }

        let count = query_report(
            &conn,
            &query(ListenReportKind::Tracks, ListenReportOrder::Count, 0, 0),
        )
        .expect("count order");
        assert_eq!(count.total, 4);
        assert_eq!(count.items.len(), 4, "limit 0 defaults to 50");
        assert_eq!(count.items[0].id, "wyy:b", "duration breaks count tie");
        assert_eq!(count.items[1].id, "wyy:a");

        let duration = query_report(
            &conn,
            &query(ListenReportKind::Tracks, ListenReportOrder::Duration, 0, 2),
        )
        .expect("duration order");
        assert_eq!(
            duration
                .items
                .iter()
                .map(|i| i.id.as_str())
                .collect::<Vec<_>>(),
            ["qq:c", "qq:d"]
        );

        let mut filtered = query(ListenReportKind::Tracks, ListenReportOrder::Count, 0, 1000);
        filtered.platform = Some("wyy".into());
        filtered.singer = Some("甲".into());
        let filtered = query_report(&conn, &filtered).expect("filters");
        assert_eq!(filtered.total, 1);
        assert_eq!(filtered.items[0].id, "wyy:a");

        let paged = query(ListenReportKind::Tracks, ListenReportOrder::Count, -9, -1);
        let paged = query_report(&conn, &paged).expect("clamped page");
        assert_eq!(
            paged.items.len(),
            1.min(100),
            "negative limit clamps to one"
        );
        let offset = query(ListenReportKind::Tracks, ListenReportOrder::Count, 2, 1);
        let offset = query_report(&conn, &offset).expect("offset page");
        assert_eq!(offset.items.len(), 1);
        assert_eq!(offset.total, 4);
    }

    /// 种一条按天明细：`offset` 是 SQLite 的日期修饰串（如 `"-3 days"`），
    /// 日期由 SQLite 现算 —— 测试不自己写一套会和实现漂移的本地日期算术。
    fn insert_day(conn: &Connection, db_id: &str, offset: &str, count: i64, duration: i64) {
        conn.execute(
            "INSERT INTO play_days (track_id, day, play_count, total_played_ms, last_played_at)
             VALUES (?1, date('now', 'localtime', ?2), ?3, ?4, 1)",
            params![db_id, offset, count, duration],
        )
        .expect("insert day");
    }

    fn day_query(kind: ListenReportKind, days: i64, limit: i64) -> ListenDayReportQuery {
        ListenDayReportQuery {
            kind,
            order: ListenReportOrder::Count,
            days,
            limit,
        }
    }

    #[test]
    fn day_window_scopes_the_report_and_keeps_grouping_consistent() {
        let conn = conn();
        for (id, singer) in [("a", "甲"), ("b", "乙"), ("c", "甲"), ("d", "甲")] {
            insert_track(
                &conn,
                &format!("wyy:{id}"),
                "wyy",
                id,
                singer,
                None,
                None,
            );
            insert_stat(&conn, &format!("wyy:{id}"), 1, 100, 5);
        }
        // 按天明细故意与累计表不同：a/d 今天、b 三天前、c 四十天前。
        insert_day(&conn, "wyy:a", "0 days", 2, 200);
        insert_day(&conn, "wyy:d", "0 days", 1, 100);
        insert_day(&conn, "wyy:b", "-3 days", 1, 100);
        insert_day(&conn, "wyy:c", "-40 days", 5, 500);
        // 累计表里 b 是老账最多的一首，用来证明不带窗口时读的是 play_stats。
        conn.execute(
            "UPDATE play_stats SET play_count = 9, total_played_ms = 900 WHERE track_id = 'wyy:b'",
            [],
        )
        .expect("b 的累计账单");

        let all = query_report(
            &conn,
            &query(ListenReportKind::Tracks, ListenReportOrder::Count, 0, 10),
        )
        .expect("累计榜");
        assert_eq!(all.total, 4, "不带窗口读 play_stats");
        assert_eq!(all.items[0].id, "wyy:b", "b 的累计次数最高");
        assert_eq!(all.items[0].play_count, 9);

        let mut week = query(ListenReportKind::Tracks, ListenReportOrder::Count, 0, 10);
        week.days = Some(7);
        let week = query_report(&conn, &week).expect("近 7 天");
        assert_eq!(week.total, 3, "近 7 天不含 40 天前的 c");
        assert_eq!(
            week
                .items
                .iter()
                .map(|i| i.id.as_str())
                .collect::<Vec<_>>(),
            ["wyy:a", "wyy:b", "wyy:d"],
            "按次数降序，同次数按时长/最近播放/id 定序"
        );
        assert_eq!(week.items[0].play_count, 2);
        assert_eq!(week.items[1].play_count, 1, "窗口内 b 只算这 3 天里的 1 次");

        let mut today = query(ListenReportKind::Singers, ListenReportOrder::Count, 0, 10);
        today.days = Some(1);
        let today = query_report(&conn, &today).expect("今天歌手榜");
        assert_eq!(today.total, 1, "今天只有甲（b 是三天前）");
        assert_eq!(today.items[0].id, "甲");
        assert_eq!(today.items[0].play_count, 3, "a 两次 + d 一次");
        assert_eq!(today.items[0].track_count, 2, "a 与 d 两首");
    }

    #[test]
    fn day_report_fills_the_window_axis_and_totals_the_whole_window() {
        let conn = conn();
        for (id, singer) in [("a", "甲"), ("b", "乙"), ("c", "甲"), ("d", "甲")] {
            insert_track(
                &conn,
                &format!("wyy:{id}"),
                "wyy",
                id,
                singer,
                None,
                None,
            );
        }
        insert_day(&conn, "wyy:a", "0 days", 2, 200);
        insert_day(&conn, "wyy:d", "0 days", 1, 100);
        insert_day(&conn, "wyy:b", "-3 days", 1, 100);
        insert_day(&conn, "wyy:c", "-40 days", 5, 500);

        let report =
            query_day_report(&conn, &day_query(ListenReportKind::Tracks, 7, 10)).expect("近 7 天日榜");
        assert_eq!(report.daily.len(), 7, "没有记录的日子也要占一格");
        assert_eq!(
            report.daily.last().expect("最后一天").play_count,
            3,
            "升序排列，末位是今天"
        );
        assert_eq!(report.active_days, 2, "只有今天与三天前有记录");
        assert_eq!(report.total_plays, 4, "汇总算整个窗口，不受 limit 截断");
        assert_eq!(report.total_played_ms, 400);
        assert_eq!(report.track_count, 3);
        assert_eq!(report.items.len(), 3);

        let today =
            query_day_report(&conn, &day_query(ListenReportKind::Tracks, 1, 10)).expect("今天");
        assert_eq!(today.daily.len(), 1);
        assert_eq!(today.active_days, 1);
        assert_eq!(today.total_plays, 3);
        assert_eq!(today.items.len(), 2);

        // 只取前 2 条时，汇总仍是整个窗口的数（不是这 2 条的和）。
        let top2 =
            query_day_report(&conn, &day_query(ListenReportKind::Tracks, 7, 2)).expect("前 2 条");
        assert_eq!(top2.items.len(), 2);
        assert_eq!(top2.total_plays, 4);

        // 窗口天数钳位：0 与负数按 1 天算，不会推成「今天之后」把榜清空。
        let clamped =
            query_day_report(&conn, &day_query(ListenReportKind::Tracks, -5, 10)).expect("钳位");
        assert_eq!(clamped.daily.len(), 1);
        assert_eq!(clamped.total_plays, 3);

        // 空窗口：给一个不存在的分组维度也不该报错，items 为空、轴仍在。
        let empty =
            query_day_report(&conn, &day_query(ListenReportKind::Sources, 1, 10)).expect("音源日榜");
        assert_eq!(empty.items.len(), 1, "今天三首都在 wyy 上");
        assert_eq!(empty.items[0].id, "wyy");
    }
}
