//! 智能歌单（A5，DESIGN R65）：规则 → SQL **现算**，不存成员快照。
//!
//! ## 为什么现算而不是建成员表
//! 智能歌单的卖点是「永远跟着曲库走」：新扫描进来的歌、刚打的评分、刚记下的
//! 播放次数都应该立刻出现在歌单里。如果像普通歌单那样往 `playlist_tracks`
//! 塞快照，就得在扫描、评分、播放统计、标签编辑……每个写路径后面补一次刷新，
//! 漏一处就长期不一致。现算只有一个真相：`tracks` + `play_stats` +
//! `track_ratings` + `liked_songs`，打开时按规则拼一条 SELECT。
//!
//! 代价是每次打开都要扫一遍曲库。对本地库（几千到几万首）是毫秒级，且只读；
//! 真慢到需要索引时再加 `tracks(genre)` 之类的索引（V22 已经建了 genre）。
//!
//! ## 规则形状（一层 AND / OR，不做嵌套）
//! ```json
//! {"matchAll": true,
//!  "rules": [{"field": "genre", "op": "contains", "value": "摇滚"},
//!            {"field": "rating", "op": "gte", "value": "4"}]}
//! ```
//! 分析文档 §4.5 明确把嵌套列为不做：一层就够表达「我的摇滚五星」这类需求，
//! 而嵌套规则需要的 UI（可增删的条件组）与校验复杂度远超收益。
//!
//! ## 健壮性口径
//! - 未知字段 / 未知运算符 / 值解析失败 → **忽略这一条**，不报错：规则引用了
//!   已删除的字段时，歌单退化成「少一个条件」，而不是整页崩掉（验收要求）；
//! - 规则为空（或全部被忽略）→ 返回整个曲库：这正是「智能歌单」最常用的
//!   用法之一（先建空规则再慢慢加），也比返回空列表更符合直觉；
//! - `limit` 钳在 1–5000，`sort` 走白名单，任何用户输入都不会拼进 SQL 字符串，
//!   一律用绑定参数。

use rusqlite::{types::Value as SqlValue, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::store::track_from_row;
use crate::provider::types::Track;

/// 当前毫秒时间戳（口径与 `db::store` 一致；那个是 store 私有，这里自带一份）。
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 单条规则。`value` 一律按字符串存/传，后端按字段类型解析（数字/布尔）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartRule {
    pub field: String,
    pub op: String,
    #[serde(default)]
    pub value: String,
}

fn default_match_all() -> bool {
    true
}

/// 一整张智能歌单的规则集合。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartRules {
    /// true = 所有条件都要满足（AND）；false = 满足任意一条（OR）
    #[serde(default = "default_match_all")]
    pub match_all: bool,
    #[serde(default)]
    pub rules: Vec<SmartRule>,
}

impl Default for SmartRules {
    fn default() -> Self {
        Self {
            match_all: true,
            rules: Vec::new(),
        }
    }
}

/// 智能歌单的元信息（名字在 `playlists` 表，规则在这里）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartPlaylistMeta {
    pub pid: String,
    pub name: String,
    pub rules: SmartRules,
    /// 最多返回多少首；None = 不限
    pub limit: Option<i64>,
    /// 排序键（白名单，见 [`order_by`]）
    pub sort: String,
    pub updated_at: i64,
}

/// 规则值里最长允许的字符数（挡住手改 IPC 传来的巨型 LIKE）
const MAX_VALUE_LEN: usize = 120;
/// 单张歌单最多返回的曲目数
const MAX_LIMIT: i64 = 5000;

/// 解析前端/数据库里的规则 JSON。解析失败按「空规则」处理（= 全库）。
pub(crate) fn parse_rules(raw: &str) -> SmartRules {
    match serde_json::from_str::<SmartRules>(raw) {
        Ok(rules) => rules,
        Err(e) => {
            log::warn!("[smart] 规则 JSON 解析失败，按空规则处理：{e}");
            SmartRules::default()
        }
    }
}

fn like_pattern(value: &str) -> String {
    // LIKE 里的 `%` / `_` 转义成字面量，否则用户搜「100%」会变成通配
    let escaped = value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    format!("%{escaped}%")
}

/// 文本字段的列名（白名单）。返回 None = 未知字段，调用方忽略该条规则。
fn text_column(field: &str) -> Option<&'static str> {
    Some(match field {
        "title" => "t.title",
        "singer" => "t.singer",
        "album" => "t.album",
        "genre" => "t.genre",
        "format" => "t.format",
        _ => return None,
    })
}

/// 天数型字段的锚点列（`within` / `older_than` 用）。值单位是「天」。
fn day_column(field: &str) -> Option<&'static str> {
    Some(match field {
        // 最近播放：没播过的行 `last_played_at` 是 NULL，两种运算符都不命中
        "lastPlayed" => "ps.last_played_at",
        // 加入曲库时间
        "added" => "t.created_at",
        _ => return None,
    })
}

/// 数值型字段的取值表达式（白名单）。
///
/// 码率是**算**出来的：`tracks.bit_rate` 只有扫描时能拿到、且 symphonia 对
/// 部分容器给不出，而「文件大小 × 8 ÷ 时长」对 VBR/CBR 都够准（±1kbps），
/// 筛选「码率 ≥ 320」这种场景完全够用，也不依赖扫描写了哪一列。
fn number_expr(field: &str) -> Option<&'static str> {
    Some(match field {
        "year" => "t.year",
        // BPM（B10）：只喂标签里有的值，未知落 0；筛选时通常配 `gt 0` 或区间
        "bpm" => "t.bpm",
        "bitrate" => "(t.file_size * 8 / NULLIF(t.duration_ms, 0))",
        "duration" => "(t.duration_ms / 1000)",
        "playCount" => "COALESCE(ps.play_count, 0)",
        "rating" => "COALESCE(r.rating, 0)",
        _ => return None,
    })
}

/// 排序白名单：`sort` 直接来自前端，绝不能拼进 SQL。
fn order_by(sort: &str) -> &'static str {
    match sort {
        "added_asc" => "t.created_at ASC, t.title COLLATE NOCASE ASC",
        "title" => "t.title COLLATE NOCASE ASC",
        "singer" => "t.singer COLLATE NOCASE ASC, t.title COLLATE NOCASE ASC",
        // 专辑排序：库里没有碟号/音轨号列（C11），同专辑内只能按歌名兜底
        "album" => "t.album COLLATE NOCASE ASC, t.title COLLATE NOCASE ASC",
        "play_count" => "COALESCE(ps.play_count, 0) DESC, t.title COLLATE NOCASE ASC",
        "last_played" => "ps.last_played_at DESC, t.title COLLATE NOCASE ASC",
        "rating" => "COALESCE(r.rating, 0) DESC, t.title COLLATE NOCASE ASC",
        "random" => "RANDOM()",
        // 默认「最近加入的在前」
        _ => "t.created_at DESC, t.title COLLATE NOCASE ASC",
    }
}

/// 把一条规则编译成 `(SQL 片段, 绑定参数)`。返回 None = 忽略该条。
fn compile_rule(rule: &SmartRule, now: i64) -> Option<(String, Vec<SqlValue>)> {
    let op = rule.op.trim();
    let value = rule.value.trim();
    if value.len() > MAX_VALUE_LEN {
        return None;
    }
    // 文本字段
    if let Some(column) = text_column(&rule.field) {
        if value.is_empty() {
            return None;
        }
        return match op {
            "contains" => Some((
                format!("{column} LIKE ? ESCAPE '\\'"),
                vec![SqlValue::Text(like_pattern(value))],
            )),
            "not_contains" => Some((
                format!("({column} IS NULL OR {column} NOT LIKE ? ESCAPE '\\')"),
                vec![SqlValue::Text(like_pattern(value))],
            )),
            "is" => Some((
                format!("{column} = ?"),
                vec![SqlValue::Text(value.to_string())],
            )),
            "is_not" => Some((
                format!("({column} IS NULL OR {column} <> ?)"),
                vec![SqlValue::Text(value.to_string())],
            )),
            _ => None,
        };
    }
    // 天数型
    if let Some(column) = day_column(&rule.field) {
        let days: i64 = value.parse().ok()?;
        if !(0..=36500).contains(&days) {
            return None;
        }
        let boundary = now - days * 86_400_000;
        return match op {
            "within" => Some((
                format!("{column} IS NOT NULL AND {column} >= ?"),
                vec![SqlValue::Integer(boundary)],
            )),
            "older_than" => Some((
                format!("{column} IS NOT NULL AND {column} < ?"),
                vec![SqlValue::Integer(boundary)],
            )),
            _ => None,
        };
    }
    // 数值型
    if let Some(expr) = number_expr(&rule.field) {
        let number: f64 = value.parse().ok()?;
        let bound = if number.fract() == 0.0 {
            SqlValue::Integer(number as i64)
        } else {
            SqlValue::Real(number)
        };
        return match op {
            "gte" => Some((format!("{expr} >= ?"), vec![bound])),
            "lte" => Some((format!("{expr} <= ?"), vec![bound])),
            "eq" => Some((format!("{expr} = ?"), vec![bound])),
            _ => None,
        };
    }
    // 收藏（布尔）
    if rule.field == "liked" {
        let want = match value.to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => true,
            "false" | "0" | "no" => false,
            _ => return None,
        };
        // 关键点（C10）：`liked_songs.sid` 存的是音源原始 id，而 `tracks.id` 是
        // `platform:原始id`（tracks::db_track_id 的口径）。直接 `ls.sid = t.id`
        // 永远匹配不到；按同一个口径拆出原始 id 再比。
        let expr = "EXISTS (SELECT 1 FROM liked_songs ls
                      WHERE ls.deleted_at IS NULL
                        AND ls.platform = t.platform
                        AND ls.sid = substr(t.id, instr(t.id, ':') + 1))";
        return Some((
            if want { expr.to_string() } else { format!("NOT {expr}") },
            Vec::new(),
        ));
    }
    None
}

/// 按规则现算出曲目列表（智能歌单的唯一真相）。
pub(crate) fn resolve(
    conn: &Connection,
    rules: &SmartRules,
    limit: Option<i64>,
    sort: &str,
) -> Result<Vec<Track>, rusqlite::Error> {
    let now = now_ms();
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<SqlValue> = Vec::new();
    for rule in &rules.rules {
        if let Some((sql, values)) = compile_rule(rule, now) {
            conditions.push(sql);
            params.extend(values);
        }
    }

    let mut sql = String::from(
        "SELECT substr(t.id, instr(t.id, ':') + 1) AS sid, t.platform, t.title, t.singer,
                t.album, t.pic_url, t.duration_ms, t.music_id, t.start_ms, t.end_ms, t.recording_version, t.isrc, t.duration_reliable
           FROM tracks t
           LEFT JOIN play_stats ps ON ps.track_id = t.id
           LEFT JOIN track_ratings r ON r.key = t.id
          WHERE t.missing = 0",
    );
    if !conditions.is_empty() {
        // OR 模式下每一条分别加括号，避免与外层条件粘连
        let joiner = if rules.match_all { " AND " } else { " OR " };
        let wrapped: Vec<String> = conditions.iter().map(|c| format!("({c})")).collect();
        sql.push_str(" AND (");
        sql.push_str(&wrapped.join(joiner));
        sql.push(')');
    }
    sql.push_str(" ORDER BY ");
    sql.push_str(order_by(sort));
    let limit = limit.unwrap_or(MAX_LIMIT).clamp(1, MAX_LIMIT);
    sql.push_str(" LIMIT ?");
    params.push(SqlValue::Integer(limit));

    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(rusqlite::params_from_iter(params.iter()))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        if let Some(track) = track_from_row(row)? {
            out.push(track);
        }
    }
    Ok(out)
}

// ---------- 存储（smart_playlists 表 + playlists 元数据） ----------

/// 新建智能歌单，返回 pid。`playlists.is_smart = 1`。
pub(crate) fn create_smart_playlist(
    conn: &Connection,
    name: &str,
    rules: &SmartRules,
    limit: Option<i64>,
    sort: &str,
) -> Result<String, rusqlite::Error> {
    let rules_json = serde_json::to_string(rules).unwrap_or_else(|_| "{}".to_string());
    let pid = crate::db::store::create_playlist_kind(conn, name, true)?;
    let id: String = conn.query_row(
        "SELECT id FROM playlists WHERE pid = ?1",
        rusqlite::params![pid],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO smart_playlists (id, rules_json, limit_n, sort, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET rules_json = excluded.rules_json,
                                       limit_n = excluded.limit_n,
                                       sort = excluded.sort,
                                       updated_at = excluded.updated_at",
        rusqlite::params![
            id,
            rules_json,
            limit.map(|v| v.clamp(1, MAX_LIMIT)),
            sort,
            now_ms()
        ],
    )?;
    Ok(pid)
}

/// 更新规则 / 限制 / 排序（名字走既有的 `rename_playlist`）。
pub(crate) fn update_smart_playlist(
    conn: &Connection,
    pid: &str,
    rules: &SmartRules,
    limit: Option<i64>,
    sort: &str,
) -> Result<usize, rusqlite::Error> {
    let rules_json = serde_json::to_string(rules).unwrap_or_else(|_| "{}".to_string());
    conn.execute(
        "UPDATE smart_playlists SET rules_json = ?1, limit_n = ?2, sort = ?3, updated_at = ?4
          WHERE id IN (SELECT id FROM playlists WHERE pid = ?5 AND is_smart = 1)",
        rusqlite::params![
            rules_json,
            limit.map(|v| v.clamp(1, MAX_LIMIT)),
            sort,
            now_ms(),
            pid
        ],
    )
}

/// 读智能歌单元信息；`pid` 不是智能歌单时返回 None。
pub(crate) fn smart_playlist(conn: &Connection, pid: &str) -> Result<Option<SmartPlaylistMeta>, rusqlite::Error> {
    let row = conn
        .query_row(
            "SELECT p.pid, p.name, s.rules_json, s.limit_n, s.sort, COALESCE(s.updated_at, p.updated_at)
               FROM playlists p
               JOIN smart_playlists s ON s.id = p.id
              WHERE p.pid = ?1 AND p.is_smart = 1",
            rusqlite::params![pid],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                ))
            },
        )
        .optional()?;
    Ok(row.map(|(pid, name, rules_json, limit, sort, updated_at)| SmartPlaylistMeta {
        pid,
        name,
        rules: parse_rules(&rules_json),
        limit,
        sort,
        updated_at,
    }))
}

/// 某个 pid 是不是智能歌单（`get_playlist_tracks` 据此分流）。
pub(crate) fn is_smart_playlist(conn: &Connection, pid: &str) -> Result<bool, rusqlite::Error> {
    let smart: i64 = conn.query_row(
        "SELECT COUNT(*) FROM playlists WHERE pid = ?1 AND is_smart = 1",
        rusqlite::params![pid],
        |r| r.get(0),
    )?;
    Ok(smart > 0)
}

/// 按 pid 现算曲目。不是智能歌单时返回空（调用方会走普通歌单那条路）。
pub(crate) fn resolve_smart_playlist(
    conn: &Connection,
    pid: &str,
) -> Result<Vec<Track>, rusqlite::Error> {
    let Some(meta) = smart_playlist(conn, pid)? else {
        return Ok(Vec::new());
    };
    resolve(conn, &meta.rules, meta.limit, &meta.sort)
}

/// 「另存为静态歌单」：把此刻现算出来的曲目快照进一个普通歌单，返回新 pid。
///
/// 降级用途（分析文档 §4.5 验收项之一）：用户想把智能歌单的当前结果分享、
/// 或者固化成一波不再变化的歌。
pub(crate) fn save_as_static(
    conn: &Connection,
    pid: &str,
    name: &str,
) -> Result<Option<String>, rusqlite::Error> {
    let tracks = resolve_smart_playlist(conn, pid)?;
    if !is_smart_playlist(conn, pid)? {
        return Ok(None);
    }
    let new_pid = crate::db::store::create_playlist(conn, name)?;
    if !tracks.is_empty() {
        crate::db::store::add_tracks_to_playlist(conn, &new_pid, &tracks)?;
    }
    Ok(Some(new_pid))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 内存库 + 跑完全部迁移（`db::store::tests::new_conn` 是 store 私有，这里自带）。
    fn new_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        crate::db::migrations::run(&conn).expect("migrations");
        conn
    }

    /// 造一首本地曲目 + 可选的统计/评分/收藏，便于按规则命中。
    #[allow(clippy::too_many_arguments)]
    fn seed(conn: &Connection, title: &str, singer: &str, genre: Option<&str>, year: Option<i64>, play_count: i64, rating: Option<i64>, liked: bool) {
        let path = format!("D:/music/{title}.flac");
        let id = format!("local:{path}");
        conn.execute(
            "INSERT INTO tracks (id, platform, title, singer, album, duration_ms, file_size,
                                 format, missing, created_at, updated_at, genre, year)
             VALUES (?1, 'local', ?2, ?3, '专辑', 200000, 8000000, 'flac', 0, 1000, 1000, ?4, ?5)",
            rusqlite::params![id, title, singer, genre, year],
        )
        .unwrap();
        if play_count > 0 {
            conn.execute(
                "INSERT INTO play_stats (track_id, play_count, last_played_at, total_played_ms)
                 VALUES (?1, ?2, 2000, 1000)",
                rusqlite::params![id, play_count],
            )
            .unwrap();
        }
        if let Some(r) = rating {
            conn.execute(
                "INSERT INTO track_ratings (key, rating, updated_at) VALUES (?1, ?2, 1)",
                rusqlite::params![id, r],
            )
            .unwrap();
        }
        if liked {
            // 走真实收藏写入路径：`liked_songs.sid` 存音源原始 id，`id` 才是
            // `platform:sid`。手填前缀 id 会掩盖「规则永远匹配不到」的 bug（C10）。
            let track = Track {
                id: path,
                platform: crate::provider::types::SourceId::local(),
                title: title.to_string(),
                singer: singer.to_string(),
                album: "专辑".to_string(),
                pic_url: String::new(),
                duration: 200.0,
                recording: Default::default(), music_id: None,
                start_ms: None,
                end_ms: None,
            };
            crate::db::store::add_liked_song(conn, &track, "inbox").expect("写收藏");
        }
    }

    fn rules(match_all: bool, list: &[(&str, &str, &str)]) -> SmartRules {
        SmartRules {
            match_all,
            rules: list
                .iter()
                .map(|(field, op, value)| SmartRule {
                    field: field.to_string(),
                    op: op.to_string(),
                    value: value.to_string(),
                })
                .collect(),
        }
    }

    #[test]
    fn text_and_number_rules_filter_the_library() {
        let conn = new_conn();
        seed(&conn, "摇滚五星", "甲", Some("摇滚"), Some(2019), 12, Some(5), false);
        seed(&conn, "摇滚三星", "乙", Some("摇滚"), Some(2015), 3, Some(3), false);
        seed(&conn, "民谣五星", "丙", Some("民谣"), Some(2019), 8, Some(5), false);

        let hit = resolve(&conn, &rules(true, &[("genre", "contains", "摇滚"), ("rating", "gte", "4")]), None, "added_desc").unwrap();
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].title, "摇滚五星");

        // OR：摇滚 或 五星 = 3 首
        let any = resolve(&conn, &rules(false, &[("genre", "contains", "摇滚"), ("rating", "gte", "5")]), None, "added_desc").unwrap();
        assert_eq!(any.len(), 3);

        // 年份 + 播放次数
        let year = resolve(&conn, &rules(true, &[("year", "gte", "2018"), ("playCount", "gte", "8")]), None, "added_desc").unwrap();
        assert_eq!(year.len(), 2);
    }

    #[test]
    fn bpm_filter_uses_tagged_tempo_only() {
        let conn = new_conn();
        seed(&conn, "快歌", "甲", None, None, 0, None, false);
        seed(&conn, "慢歌", "乙", None, None, 0, None, false);
        seed(&conn, "没标签", "丙", None, None, 0, None, false);
        // 扫描器只搬标签（B10）：没标签的行 bpm 落 0，不该被 `bpm > 0` 之类条件捞出来
        conn.execute("UPDATE tracks SET bpm = 128 WHERE title = '快歌'", [])
            .unwrap();
        conn.execute("UPDATE tracks SET bpm = 72 WHERE title = '慢歌'", [])
            .unwrap();

        let fast = resolve(&conn, &rules(true, &[("bpm", "gte", "120")]), None, "title").unwrap();
        assert_eq!(fast.len(), 1);
        assert_eq!(fast[0].title, "快歌");

        // 区间：72 落在 70–90
        let slow = resolve(&conn, &rules(true, &[("bpm", "gte", "70"), ("bpm", "lte", "90")]), None, "title").unwrap();
        assert_eq!(slow.len(), 1);
        assert_eq!(slow[0].title, "慢歌");

        // 只要「有 BPM 的」：未知的 0 被排除（数值只支持 gte/lte/eq，没有 gt）
        let tagged = resolve(&conn, &rules(true, &[("bpm", "gte", "1")]), None, "title").unwrap();
        assert_eq!(tagged.len(), 2);
    }

    #[test]
    fn unknown_fields_and_bad_values_are_ignored_not_fatal() {
        let conn = new_conn();
        seed(&conn, "唯一", "甲", Some("摇滚"), Some(2019), 1, None, false);
        // 已删除字段 + 垃圾数字：两条都忽略 → 退化成全库
        let hit = resolve(&conn, &rules(true, &[("mood", "is", "happy"), ("year", "gte", "不是数字")]), None, "added_desc").unwrap();
        assert_eq!(hit.len(), 1);
        // 未知运算符同样忽略
        let hit = resolve(&conn, &rules(true, &[("genre", "正则匹配", "摇")]), None, "added_desc").unwrap();
        assert_eq!(hit.len(), 1);
    }

    #[test]
    fn empty_rules_return_the_whole_library() {
        let conn = new_conn();
        seed(&conn, "一", "甲", None, None, 0, None, false);
        seed(&conn, "二", "乙", None, None, 0, None, false);
        assert_eq!(resolve(&conn, &SmartRules::default(), None, "added_desc").unwrap().len(), 2);
    }

    #[test]
    fn limit_and_sort_are_applied() {
        let conn = new_conn();
        seed(&conn, "三", "甲", None, None, 30, None, false);
        seed(&conn, "一", "甲", None, None, 10, None, false);
        seed(&conn, "二", "甲", None, None, 20, None, false);
        let top = resolve(&conn, &SmartRules::default(), Some(2), "play_count").unwrap();
        assert_eq!(top.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), vec!["三", "二"]);
        let by_title = resolve(&conn, &SmartRules::default(), None, "title").unwrap();
        assert_eq!(by_title.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), vec!["一", "三", "二"]);
    }

    /// UI 里能选的每种排序都必须能在真实库上执行（C11：`album` 曾引用不存在的列）。
    #[test]
    fn every_ui_sort_option_is_executable() {
        let conn = new_conn();
        seed(&conn, "丙", "甲", None, None, 0, None, false);
        seed(&conn, "乙", "甲", None, None, 0, None, false);
        conn.execute("UPDATE tracks SET album = 'B 专辑' WHERE title = '丙'", [])
            .unwrap();
        conn.execute("UPDATE tracks SET album = 'A 专辑' WHERE title = '乙'", [])
            .unwrap();

        for sort in [
            "added_desc",
            "added_asc",
            "title",
            "singer",
            "album",
            "play_count",
            "last_played",
            "rating",
            "random",
        ] {
            resolve(&conn, &SmartRules::default(), None, sort)
                .unwrap_or_else(|e| panic!("排序 {sort} 不能在真实库上执行：{e}"));
        }

        // 专辑排序：不同专辑按专辑名，同专辑内按歌名
        let by_album = resolve(&conn, &SmartRules::default(), None, "album").unwrap();
        assert_eq!(
            by_album.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(),
            vec!["乙", "丙"]
        );
    }

    #[test]
    fn like_rules_use_the_liked_songs_table() {
        let conn = new_conn();
        seed(&conn, "喜欢", "甲", None, None, 0, None, true);
        seed(&conn, "没喜欢", "乙", None, None, 0, None, false);
        let liked = resolve(&conn, &rules(true, &[("liked", "is", "true")]), None, "added_desc").unwrap();
        assert_eq!(liked.len(), 1);
        assert_eq!(liked[0].title, "喜欢");
        let unliked = resolve(&conn, &rules(true, &[("liked", "is", "false")]), None, "added_desc").unwrap();
        assert_eq!(unliked.len(), 1);
        assert_eq!(unliked[0].title, "没喜欢");
    }

    #[test]
    fn smart_playlist_round_trips_and_snapshots_as_static() {
        let conn = new_conn();
        seed(&conn, "摇滚五星", "甲", Some("摇滚"), Some(2019), 0, Some(5), false);
        seed(&conn, "民谣", "丙", Some("民谣"), Some(2019), 0, None, false);
        let pid = create_smart_playlist(&conn, "我的摇滚", &rules(true, &[("genre", "is", "摇滚")]), None, "title").unwrap();
        assert!(is_smart_playlist(&conn, &pid).unwrap());

        let meta = smart_playlist(&conn, &pid).unwrap().unwrap();
        assert_eq!(meta.name, "我的摇滚");
        assert_eq!(meta.rules.rules.len(), 1);

        // 更新规则后现算结果立刻变
        update_smart_playlist(&conn, &pid, &rules(true, &[]), None, "title").unwrap();
        assert_eq!(resolve_smart_playlist(&conn, &pid).unwrap().len(), 2);

        // 另存为静态歌单：快照当前 2 首
        let static_pid = save_as_static(&conn, &pid, "摇滚快照").unwrap().unwrap();
        assert!(!is_smart_playlist(&conn, &static_pid).unwrap());
        assert_eq!(crate::db::store::get_playlist_tracks(&conn, &static_pid).unwrap().len(), 2);
        // 普通歌单「另存为」返回 None
        assert!(save_as_static(&conn, &static_pid, "再存").unwrap().is_none());
    }

    #[test]
    fn missing_tracks_never_show_up() {
        let conn = new_conn();
        seed(&conn, "在", "甲", None, None, 0, None, false);
        seed(&conn, "没了", "乙", None, None, 0, None, false);
        conn.execute("UPDATE tracks SET missing = 1 WHERE title = '没了'", []).unwrap();
        let hit = resolve(&conn, &SmartRules::default(), None, "added_desc").unwrap();
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].title, "在");
    }
}
