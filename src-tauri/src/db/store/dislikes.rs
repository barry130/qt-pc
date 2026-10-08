//! 不喜欢列表（屏蔽规则）域：`dislike_rules` 表。
//!
//! ## 为什么不是「按 id 屏蔽」
//! 曲目 id 是平台私有的（`qt-sources` 的 `contract.ts` 里 `Source` 是开放字符串），
//! 同一首歌跨音源 id 不通，换源兜底后连 platform 都会变。所以屏蔽规则只能按
//! **歌名 + 歌手**匹配 —— 这也是 lx-music-desktop `dislike_list` 的做法。
//! 代价是「匹配」本身变成一等公民：见下面的 `normalize_key`。
//!
//! ## LX 的两个坑（本表刻意避开）
//! 1. LX 的 `dislike_list` 里 delete / update / clear 三个 dbHelper 被整体注释掉了，
//!    用户**只能追加或整体覆盖，无法逐条删除**。这里 `id` 是真主键，逐条删除
//!    是一等公民。
//! 2. LX 的匹配是纯 `lower + trim`，没有任何归一化：全角标点、多歌手写法、
//!    带 `(Live)` 后缀的版本差一点就漏匹配。这里 `name` / `singer` 两列存的是
//!    **归一化后的匹配键**（`normalize_key`），`*_raw` 只在设置页回显用户当初
//!    看到的那串字。
//!
//! ## 匹配语义
//! - `kind = 'singer'`：屏蔽这个歌手的所有歌。曲目只要有一个歌手词命中就屏蔽。
//! - `kind = 'song'`：屏蔽这一首。`name` 必须相等；`singer` 为空 = 不限歌手
//!   （同名翻唱、不同版本一起屏蔽），否则要求**歌手词集合有交集**
//!   （「周杰伦」能命中「周杰伦、方文山」）。
//!
//! ## 外键
//! 刻意不挂 `REFERENCES tracks(id)`：规则描述的是「这首歌我不想听」，与它有没有
//! 进过曲库无关；跟着 tracks 级联会在曲目被清理时把用户的偏好一起删掉。

use std::collections::HashSet;

use rusqlite::{params, Connection};

use crate::provider::types::Track;

use super::*;

/// 屏蔽规则的两种粒度。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DislikeKind {
    /// 屏蔽具体的一首歌（歌名 + 歌手）
    Song,
    /// 屏蔽这个歌手的所有歌
    Singer,
}

impl DislikeKind {
    fn as_str(self) -> &'static str {
        match self {
            DislikeKind::Song => "song",
            DislikeKind::Singer => "singer",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "singer" => DislikeKind::Singer,
            _ => DislikeKind::Song,
        }
    }
}

/// 一条屏蔽规则（设置页展示 / 跨进程传输用）。
///
/// `name` / `singer` 是归一化后的匹配键，`name_raw` / `singer_raw` 是用户看到原文。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DislikeRule {
    pub id: i64,
    pub kind: DislikeKind,
    pub name: String,
    pub name_raw: String,
    pub singer: String,
    pub singer_raw: String,
    pub created_at: i64,
}

/// **归一化歌名 / 歌手到匹配键。**
///
/// 三步：
/// 1. 全角 ASCII（`！`→`!`）与全角空格（`U+3000`）折成半角 —— 元数据里最常见的脏数据；
/// 2. `to_lowercase()`（char 级，覆盖西里尔/希腊等；不引 `unicode-normalization`）；
/// 3. 丢掉所有非字母数字字符（含空格与标点）——中日韩汉字本身就是 alphanumeric，
///    所以这一步只吃掉标点，不需要额外判 CJK。
///
/// 结果用于精确相等比较，所以宁可「归一化过头把两条不同的歌折成同一个键」，
/// 也不能漏：漏了规则不生效（只是没屏蔽掉），过头了最多是多屏蔽一首。
pub(crate) fn normalize_key(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.trim().chars() {
        // 全角 → 半角：U+3000 是空格，U+FF01–U+FF5E 是 ASCII 的全角形式
        let folded = match ch {
            '\u{3000}' => ' ',
            c @ '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            other => other,
        };
        // rustfmt 会拆不开这个 chain，手动换行保持可读性
        for lower in folded.to_lowercase() {
            if lower.is_alphanumeric() {
                out.push(lower);
            }
        }
    }
    out
}

/// 剥掉括号修饰段：`稻香 (Live)` / `稻香（Live）` / `稻香【现场版】` → `稻香`。
///
/// **只做这一件事，不做隐私/版权无关的更多推测**：同一个录音在不同音源上的版本后缀
/// 写法五花八门（`Live` / `现场版` / `remix` / `伴奏`），但都装在括号里，剥括号是
/// 性价比最高的那一步。别再往里加关键词表 —— 那会把「稻香」主题真正的衍生<｜hy_place▁holder▁no▁813｜>
/// 不确定性里，而漏匹配的代价（多放一首你不爱听的歌）远比误屏蔽小。
fn strip_note_segments(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut depth = 0usize;
    for ch in raw.chars() {
        match ch {
            '(' | '（' | '[' | '【' | '{' => depth += 1,
            ')' | '）' | ']' | '】' | '}' => {
                if depth > 0 {
                    depth -= 1;
                }
            }
            _ => {
                if depth == 0 {
                    out.push(ch);
                }
            }
        }
    }
    // 剥完括号会留下悬空空格（`稻香 (Live)`→`稻香 `），这里一并修掉：
    // 跨端向量表比对的是字面结果，不做 trim 两端就永远对不齐
    // （后续 normalize_key 反正也会 trim，所以这里 trim 不改变匹配语义）。
    out.trim().to_string()
}

/// 拆分多歌手写成的若干歌手词（**原文**，去空白、丢空段）。
///
/// 与 `split_singers` 同分隔符集合，只差最后一步是否归一化 —— 存规则时要留原文
/// 供设置页回显（`Taylor Swift` 被归一化成 `taylorswift` 再显示出去是掉信息）。
fn split_singer_parts(raw: &str) -> Vec<String> {
    raw.split(|c: char| {
        matches!(
            c,
            ',' | '，' | '、' | ';' | '；' | '/' | '|' | '&' | '＆' | '　'
        )
    })
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .collect()
}

/// 拆分多歌手写成的若干歌手词。`周杰伦、方文山` / `A, B` / `A / B` / `A & B` 都能拆。
///
/// 拆不开也没事：整串会作为一个词进入集合，只是匹配面变窄。
fn split_singers(raw: &str) -> Vec<String> {
    split_singer_parts(raw)
        .iter()
        .map(|s| normalize_key(s))
        .filter(|s| !s.is_empty())
        .collect()
}

/// 按 name / singer 两列拼接。注意：构造 DislikeRule 时 name/singer 用原文。
fn build_dislike_rule(
    row: (i64, String, String, String, String, String, i64),
) -> DislikeRule {
    let (id, kind, name, name_raw, singer, singer_raw, created_at) = row;
    DislikeRule {
        id,
        kind: DislikeKind::parse(&kind),
        name,
        name_raw,
        singer,
        singer_raw,
        created_at,
    }
}

/// 全部屏蔽规则（按添加时间倒序，最近屏蔽的排前面 → 设置页所见即所得）。
pub(crate) fn list_dislikes(conn: &Connection) -> Result<Vec<DislikeRule>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, name, name_raw, singer, singer_raw, created_at
         FROM dislike_rules ORDER BY created_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, i64>(6)?,
        ))
    })?;
    rows.map(|r| r.map(build_dislike_rule)).collect()
}

/// 内部 INSERT/UPDATE：命中同一 (kind,name,singer) 时只刷新原文回显，不动 created_at
/// （用户重复屏蔽同一首不该把排序位置顶到最前）。
fn insert_rule(
    conn: &Connection,
    kind: DislikeKind,
    name: &str,
    name_raw: &str,
    singer: &str,
    singer_raw: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO dislike_rules (kind, name, name_raw, singer, singer_raw, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(kind, name, singer) DO UPDATE SET
           name_raw = excluded.name_raw,
           singer_raw = excluded.singer_raw",
        params![
            kind.as_str(),
            name,
            name_raw,
            singer,
            singer_raw,
            now_ms()
        ],
    )?;
    Ok(())
}

/// 屏蔽一首歌（`kind = 'song'`）。返回这条规则的 id（设置页逐条删除要用）。
///
/// `singer` 用完整原文的归一化结果匹配；集合交集判定在 `DislikeMatcher` 里，
/// 所以这里不需要把多歌手拆开存。
pub(crate) fn add_dislike_song(
    conn: &Connection,
    track: &Track,
) -> Result<i64, rusqlite::Error> {
    let name_raw = track.title.clone();
    let singer_raw = track.singer.clone();
    let name = normalize_key(&strip_note_segments(&name_raw));
    let singer = normalize_key(&singer_raw);
    if name.is_empty() {
        // 歌名全是标点/空串 → 屏蔽它等于屏蔽所有无名曲目，宁可拒绝
        return Ok(0);
    }
    insert_rule(
        conn,
        DislikeKind::Song,
        &name,
        &name_raw,
        &singer,
        &singer_raw,
    )?;
    rule_id(conn, DislikeKind::Song, &name, &singer)
}

/// 屏蔽某人（`kind = 'singer'`）。返回**本次涉及的每一条规则 id**（按歌手词顺序）。
///
/// 传进来的多半是曲目行里的完整歌手串（可能含多人）—— 逐词拆开各建一条规则，
/// 因为用户点「屏蔽歌手」时的意图是「这些人我都不想听」，而不是屏蔽这个组合。
///
/// 返回值必须给全：早先只回第一个词的 id，前端 `singerRuleIds` 存的就是那一条，
/// 撤销时只会撤掉第一位歌手 ——「屏蔽 A/B/C 再取消」会留下 B、C 两条孤儿规则，
/// 用户以为取消了，实际那两个人的歌还在被跳。拆不出词（空串/纯分隔符）返回空数组。
pub(crate) fn add_dislike_singer(
    conn: &Connection,
    singer_raw: &str,
) -> Result<Vec<i64>, rusqlite::Error> {
    let parts = split_singer_parts(singer_raw);
    let mut ids = Vec::with_capacity(parts.len());
    for raw in &parts {
        let key = normalize_key(raw);
        if key.is_empty() {
            continue;
        }
        // name 存归一化键（匹配用），name_raw 存用户写的原文（设置页回显）
        insert_rule(conn, DislikeKind::Singer, &key, raw, "", "")?;
        ids.push(rule_id(conn, DislikeKind::Singer, &key, "")?);
    }
    Ok(ids)
}

fn rule_id(
    conn: &Connection,
    kind: DislikeKind,
    name: &str,
    singer: &str,
) -> Result<i64, rusqlite::Error> {
    conn.query_row(
        "SELECT id FROM dislike_rules WHERE kind = ?1 AND name = ?2 AND singer = ?3",
        params![kind.as_str(), name, singer],
        |r| r.get::<_, i64>(0),
    )
}

/// 按 id 删除一条规则（LX 做不到的那件事）。返回是否真的删掉了。
pub(crate) fn remove_dislike_rule(conn: &Connection, id: i64) -> Result<bool, rusqlite::Error> {
    let n = conn.execute("DELETE FROM dislike_rules WHERE id = ?1", params![id])?;
    Ok(n > 0)
}

/// 按整串歌手撤销屏蔽：拆词后逐条删。返回删掉了几条。
///
/// 与 `add_dislike_singer` 严格互逆 —— 两边共用 `split_singers`，所以
/// 「屏蔽 A/B/C」之后一次撤销能干净撤掉三条；不这样做的话前端只能记 id，
/// 而重启后前端记忆表就没了，多歌手串会撤不干净（孤儿规则继续生效）。
pub(crate) fn remove_dislike_singer(
    conn: &Connection,
    singer_raw: &str,
) -> Result<usize, rusqlite::Error> {
    let mut removed = 0usize;
    for t in split_singers(singer_raw) {
        removed += conn.execute(
            "DELETE FROM dislike_rules WHERE kind = ?1 AND name = ?2 AND singer = ''",
            params![DislikeKind::Singer.as_str(), t],
        )?;
    }
    Ok(removed)
}

/// 清空全部规则（设置页「清空全部」）。
pub(crate) fn clear_dislikes(conn: &Connection) -> Result<usize, rusqlite::Error> {
    conn.execute("DELETE FROM dislike_rules", [])
}

// ---------- 匹配 ----------

/// 一次性装载全部规则做内存判定。
///
/// 规则量级是几十条，而一次列表播放要判定上百首曲目 —— 走 SQL 就是上百次往返。
/// 反过来，把整张表读进三个 Set 之后判定是 O(歌手词数) 的哈希查找。
pub(crate) struct DislikeMatcher {
    /// 歌名维度的规则：不限歌手（屏蔽所有同名版本）
    song_any: HashSet<String>,
    /// 歌名 + 歌手词维度的规则
    song_named: HashSet<(String, String)>,
    /// 歌手屏蔽
    singers: HashSet<String>,
}

impl DislikeMatcher {
    /// 从库里装载。表不存在 / 无规则时得到一个「什么都不屏蔽」的 matcher。
    pub(crate) fn load(conn: &Connection) -> Result<Self, rusqlite::Error> {
        let mut m = Self {
            song_any: HashSet::new(),
            song_named: HashSet::new(),
            singers: HashSet::new(),
        };
        let mut stmt = conn.prepare("SELECT kind, name, singer FROM dislike_rules")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (kind, name, singer) = row?;
            match DislikeKind::parse(&kind) {
                DislikeKind::Singer => {
                    m.singers.insert(name);
                }
                DislikeKind::Song => {
                    let tokens = split_singers(&singer);
                    if tokens.is_empty() {
                        m.song_any.insert(name);
                    } else {
                        for t in tokens {
                            m.song_named.insert((name.clone(), t));
                        }
                    }
                }
            }
        }
        Ok(m)
    }

    /// 空 matcher（db 不可用时的降级：**宁可不屏蔽，也不能让播放失败**）。
    pub(crate) fn empty() -> Self {
        Self {
            song_any: HashSet::new(),
            song_named: HashSet::new(),
            singers: HashSet::new(),
        }
    }

    /// 规则条数（只用于启动日志，判断「装载了几条」比看 debug 输出方便）。
    pub(crate) fn len(&self) -> usize {
        self.song_any.len() + self.song_named.len() + self.singers.len()
    }

    pub(crate) fn matches(&self, track: &Track) -> bool {
        let singers = split_singers(&track.singer);
        for s in &singers {
            if self.singers.contains(s) {
                return true;
            }
        }
        let name = normalize_key(&strip_note_segments(&track.title));
        if name.is_empty() {
            return false;
        }
        if self.song_any.contains(&name) {
            return true;
        }
        singers
            .iter()
            .any(|s| self.song_named.contains(&(name.clone(), s.clone())))
    }
}

/// 批量判定，返回与入参等长的布尔向量（顺序一致）。
///
/// 一次装载规则判定整张列表 —— GUI 一次渲染可能要问上百行的「是否被屏蔽」，
/// 逐行走 IPC 会把事件通道打满。
pub(crate) fn filter_disliked_flags(
    conn: &Connection,
    tracks: &[Track],
) -> Result<Vec<bool>, rusqlite::Error> {
    let m = DislikeMatcher::load(conn)?;
    Ok(tracks.iter().map(|t| m.matches(t)).collect())
}

/// 列表入队前过滤：剔除被屏蔽的曲目，并把 start index 修正到同一首歌上。
///
/// **被点的那首永远保留**：用户在列表里明确点了第 7 首，哪怕它命中了屏蔽规则也要播
/// —— 屏蔽规则的语义是「别让它自动出现」，不是「禁止聆听」。这也是为什么 index
/// 要重新算：过滤会产生新下标。
pub(crate) fn filter_disliked_tracks(
    conn: &Connection,
    tracks: Vec<Track>,
    start: usize,
) -> Result<(Vec<Track>, usize), rusqlite::Error> {
    if tracks.is_empty() {
        return Ok((tracks, 0));
    }
    let m = DislikeMatcher::load(conn)?;
    let mut kept: Vec<Track> = Vec::with_capacity(tracks.len());
    let mut new_start = 0usize;
    for (i, track) in tracks.into_iter().enumerate() {
        if i == start || !m.matches(&track) {
            if i == start {
                new_start = kept.len();
            }
            kept.push(track);
        }
    }
    if kept.is_empty() {
        // 极端情况：整张列表只剩用户点的那一首也保不住（不可能，start 一定保留）
        new_start = 0;
    }
    Ok((kept, new_start))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_folds_fullwidth_and_drops_punctuation() {
        assert_eq!(normalize_key("稻香"), "稻香");
        assert_eq!(normalize_key(" 稻 香 "), "稻香");
        assert_eq!(normalize_key("Ｄｏｎ＇ｔ　Ｂｒｅａｋ"), "dontbreak");
        assert_eq!(normalize_key("Hello, World!"), "helloworld");
        // U+3000 全角空格同样被吃掉
        assert_eq!(normalize_key("晴\u{3000}天"), "晴天");
    }

    #[test]
    fn song_rule_matches_across_note_suffixes() {
        let conn = crate::db::store::tests::new_conn();
        let plain = sample("稻香", "周杰伦");
        add_dislike_song(&conn, &plain).unwrap();
        let m = DislikeMatcher::load(&conn).unwrap();
        assert!(m.matches(&plain));
        // 不同音源给的歌词版本后缀不该漏掉
        assert!(m.matches(&sample("稻香 (Live)", "周杰伦")));
        assert!(m.matches(&sample("稻香（现场版）", "周杰伦")));
        // 同名不同歌手：不屏蔽（歌嘿嘿名字撞了不该连坐）
        assert!(!m.matches(&sample("稻香", "八三夭")));
        // 多歌手之一命中 → 屏蔽
        assert!(m.matches(&sample("稻香", "周杰伦、方文山")));
    }

    #[test]
    fn singer_rule_matches_every_token() {
        let conn = crate::db::store::tests::new_conn();
        add_dislike_singer(&conn, "周杰伦、方文山").unwrap();
        let m = DislikeMatcher::load(&conn).unwrap();
        assert!(m.matches(&sample("稻香", "周杰伦")));
        assert!(m.matches(&sample("晴天", "方文山")));
        assert!(!m.matches(&sample("晴天", "苏打绿")));
    }

    #[test]
    fn banning_a_singer_returns_every_rule_id() {
        let conn = crate::db::store::tests::new_conn();
        let ids = add_dislike_singer(&conn, "周杰伦、方文山").unwrap();
        assert_eq!(ids.len(), 2, "多歌手串必须把每条规则的 id 都返回去");
        assert_ne!(ids[0], ids[1]);
        // 空串 / 纯分隔符：不建规则，返回空数组（前端据此认为「没屏蔽成功」）
        assert!(add_dislike_singer(&conn, "、").unwrap().is_empty());
        // 回显保留用户写法（归一化只进 name 列）
        add_dislike_singer(&conn, "Taylor Swift").unwrap();
        let rows = list_dislikes(&conn).unwrap();
        let taylor = rows.iter().find(|r| r.name == "taylorswift").unwrap();
        assert_eq!(taylor.name_raw, "Taylor Swift");
    }

    #[test]
    fn unbanning_a_singer_string_removes_all_its_rules() {
        let conn = crate::db::store::tests::new_conn();
        add_dislike_singer(&conn, "周杰伦、方文山").unwrap();
        add_dislike_song(&conn, &sample("稻香", "周杰伦")).unwrap();
        // 撤歌手不能顺手撤掉同名歌曲规则
        assert_eq!(remove_dislike_singer(&conn, "周杰伦、方文山").unwrap(), 2);
        let rest = list_dislikes(&conn).unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].kind, DislikeKind::Song);
        assert_eq!(remove_dislike_singer(&conn, "周杰伦、方文山").unwrap(), 0, "重复撤销返回 0");
    }

    #[test]
    fn rules_can_be_removed_one_by_one() {
        let conn = crate::db::store::tests::new_conn();
        let a = sample("稻香", "周杰伦");
        let b = sample("晴天", "周杰伦");
        let id_a = add_dislike_song(&conn, &a).unwrap();
        add_dislike_song(&conn, &b).unwrap();
        assert_eq!(list_dislikes(&conn).unwrap().len(), 2);
        assert!(remove_dislike_rule(&conn, id_a).unwrap());
        let rest = list_dislikes(&conn).unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].name_raw, "晴天");
        assert!(!remove_dislike_rule(&conn, id_a).unwrap(), "重复删除应当返回 false");
    }

    #[test]
    fn adding_the_same_song_twice_keeps_one_rule() {
        let conn = crate::db::store::tests::new_conn();
        let t = sample("稻香", "周杰伦");
        let first = add_dislike_song(&conn, &t).unwrap();
        let second = add_dislike_song(&conn, &t).unwrap();
        assert_eq!(first, second);
        assert_eq!(list_dislikes(&conn).unwrap().len(), 1);
        // 回显的是用户看到的原文（含版本后缀也算同一首）
        add_dislike_song(&conn, &sample("稻香 (Live)", "周杰伦")).unwrap();
        assert_eq!(list_dislikes(&conn).unwrap().len(), 1);
    }

    #[test]
    fn clear_removes_everything() {
        let conn = crate::db::store::tests::new_conn();
        add_dislike_song(&conn, &sample("稻香", "周杰伦")).unwrap();
        add_dislike_singer(&conn, "方文山").unwrap();
        assert!(clear_dislikes(&conn).unwrap() >= 1);
        assert!(list_dislikes(&conn).unwrap().is_empty());
    }

    #[test]
    fn queue_filter_keeps_the_clicked_track_and_rewrites_index() {
        let conn = crate::db::store::tests::new_conn();
        add_dislike_song(&conn, &sample("晴天", "周杰伦")).unwrap();
        let tracks = vec![
            sample("稻香", "周杰伦"),
            sample("晴天", "周杰伦"),
            sample("七里香", "周杰伦"),
        ];
        let (kept, idx) = filter_disliked_tracks(&conn, tracks, 2).unwrap();
        assert_eq!(kept.len(), 2);
        assert_eq!(idx, 1, "原来第 3 首在新数组里是第 2 首");
        assert_eq!(kept[1].title, "七里香");

        // 被点的那首即便命中规则也保留
        let tracks = vec![
            sample("稻香", "周杰伦"),
            sample("晴天", "周杰伦"),
            sample("七里香", "周杰伦"),
        ];
        let (kept, idx) = filter_disliked_tracks(&conn, tracks, 1).unwrap();
        assert_eq!(kept.len(), 3, "start 那首保留");
        assert_eq!(idx, 1);
    }

    #[test]
    fn batch_flags_stay_aligned_with_input() {
        let conn = crate::db::store::tests::new_conn();
        add_dislike_song(&conn, &sample("晴天", "周杰伦")).unwrap();
        let tracks = vec![
            sample("稻香", "周杰伦"),
            sample("晴天", "周杰伦"),
            sample("七里香", "周杰伦"),
        ];
        assert_eq!(
            filter_disliked_flags(&conn, &tracks).unwrap(),
            vec![false, true, false]
        );
    }

    /// 跨端向量表：与 qt-uniappx 的 UTS 移植共用同一份 `dislike-parity.json`。
    ///
    /// 两端算法（normalize_key / strip_note_segments / split_singers）有任何一边改动，
    /// 这里或对端的 `npm run check:dislike` 立刻红 —— 屏蔽规则「PC 生效、安卓不生效」
    /// 这种只有用户才发现得了的漂移，就是靠这张表挡住的。
    #[test]
    fn parity_fixture_is_satisfied() {
        let raw = include_str!("../../../tests/fixtures/dislike-parity.json");
        let fx: serde_json::Value = serde_json::from_str(raw).expect("向量表不是合法 JSON");
        let mut checked = 0usize;
        for case in fx["normalize"].as_array().expect("缺 normalize 段") {
            let input = case["input"].as_str().unwrap();
            assert_eq!(normalize_key(input), case["expect"].as_str().unwrap(), "normalize: {input:?}");
            checked += 1;
        }
        for case in fx["strip"].as_array().expect("缺 strip 段") {
            let input = case["input"].as_str().unwrap();
            assert_eq!(strip_note_segments(input), case["expect"].as_str().unwrap(), "strip: {input:?}");
            checked += 1;
        }
        for case in fx["split"].as_array().expect("缺 split 段") {
            let input = case["input"].as_str().unwrap();
            let expect: Vec<String> = case["expect"]
                .as_array()
                .expect("split.expect 必须是数组")
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            assert_eq!(split_singers(input), expect, "split: {input:?}");
            checked += 1;
        }
        for case in fx["splitRaw"].as_array().expect("缺 splitRaw 段") {
            let input = case["input"].as_str().unwrap();
            let expect: Vec<String> = case["expect"]
                .as_array()
                .expect("splitRaw.expect 必须是数组")
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            assert_eq!(split_singer_parts(input), expect, "splitRaw: {input:?}");
            checked += 1;
        }
        assert!(checked >= 20, "向量表被清空了也没人发现：{checked}");
    }

    fn sample(title: &str, singer: &str) -> Track {
        crate::db::store::tests::sample_track_with(title, singer)
    }
}
