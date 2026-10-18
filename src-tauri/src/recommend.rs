//! 本地化推荐合辑（第二波）：纯本地听歌数据驱动的合辑卡片。
//!
//! 「推荐」在这里**不联网**，也不伪造任何数据：五类规则**统一消费本地库的
//! 累计表** ——
//! · `play_stats`（全历史累计：最后播放时间 / 次数）→「最近在听」「深夜歌单」
//!   「循环最多的歌」「久未重温」（四类）；
//! · `liked_songs` × `play_stats` →「收藏里的常客」。
//! 取数函数全部在 db/store/stats.rs 的追加段（只读 SELECT，无新表无迁移）。
//!
//! 刻意不读 `play_history`：它一首歌只留最近一条，时间戳与
//! `play_stats.last_played_at` 记的是同一个，但只覆盖最近播过的那 20 来行 ——
//! 拿它算「最近在听」会把大半有累计的曲目挡在门外。「清除听歌统计」已经连
//! `play_history` 一起清，但那是「同源同命」；五类规则统一读累计表口径才一致。
//!
//! 合辑顺序写死（[`build_mixes`] 里 push 的次序），前端照单全收无需再排；
//! 曲目凑不够 [`MIN_TRACKS`] 的合辑直接不出现 —— 推荐位宁缺毋滥，
//! 空荡荡的卡片比没有卡片更伤观感。

use rusqlite::Connection;
use tauri::State;

use crate::db::store::{
    count_late_night_tracks, count_recent_tracks, count_unreplayed_tracks,
    list_favorite_tracks_by_plays, list_late_night_tracks, list_most_played_tracks,
    list_recent_tracks, list_unreplayed_tracks,
};
use crate::provider::types::Track;
use crate::AppState;

/// 「最近在听」回看窗口：14 天。
const RECENT_WINDOW_MS: i64 = 14 * 24 * 3600 * 1000;
/// 「久未重温」的冷却线：30 天没碰过才算久。
const UNHEARD_WINDOW_MS: i64 = 30 * 24 * 3600 * 1000;
/// 深夜窗口：本地 22:00（含）到次日 6:00（不含）。
const NIGHT_START_HOUR: i64 = 22;
const NIGHT_END_HOUR: i64 = 6;
/// 合辑最少曲目数：不足直接不出。
const MIN_TRACKS: usize = 5;
/// 每个合辑最多曲目数：合辑是「精选」，不是歌单全量。
const MAX_TRACKS: u32 = 20;
/// 「循环最多的歌」起步线：只听过一次谈不上循环。
const MOST_PLAYED_MIN_PLAYS: i64 = 2;
/// 「久未重温」起步线：没听过 3 次谈不上重温。
const UNHEARD_MIN_PLAYS: i64 = 3;

/// 合辑卡片摘要（`list_local_mixes` 的返回）。前端先拿摘要铺卡片，
/// 用户点开再按 `key` 取完整曲目。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMixSummary {
    /// 稳定标识（规则名，跨次启动不变；`get_local_mix_tracks` 按它取曲目）
    pub key: String,
    pub title: String,
    /// 一句话描述，带动态数字（「近 14 天听过 37 首」）
    pub subtitle: String,
    /// 封面预览：前 3 首里有图的最前 3 张；本地曲目无图自然跳过，
    /// 全没有就给空数组（卡片回退到占位图）
    pub cover_urls: Vec<String>,
}

/// 内部完整合辑：比摘要多一份完整曲目。只在生成层流转，不出模块。
#[derive(Debug)]
struct LocalMix {
    key: &'static str,
    title: &'static str,
    subtitle: String,
    tracks: Vec<Track>,
}

/// 本地毫秒墙钟（store::now_ms 是 store 模块私有，这里同款一份）。
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 门槛 + 组装：曲目数够 [`MIN_TRACKS`] 才成辑，不够返回 `None`。
fn finish_mix(
    key: &'static str,
    title: &'static str,
    subtitle: String,
    tracks: Vec<Track>,
) -> Option<LocalMix> {
    // then_some 而非 then：构造只是搬四个字段，没有额外开销
    (tracks.len() >= MIN_TRACKS).then_some(LocalMix {
        key,
        title,
        subtitle,
        tracks,
    })
}

/// 生成全部合辑，顺序固定：最近在听 → 循环最多的歌 → 收藏里的常客 →
/// 深夜歌单 → 久未重温。
///
/// 副标题里的窗口数字（14 天 / 30 天 / 22 点）与上方常量是**手工同步**的：
/// 改常量记得同步改文案，别让数字说谎。副标题计数用不带 LIMIT 的
/// `count_*`（列表被截到 20 首，但「听过多少首」要说真实数字）；
/// 「循环最多的歌」例外 —— 它说的是「这 N 首」即本辑内容的总次数，自洽。
fn build_mixes(conn: &Connection) -> Result<Vec<LocalMix>, rusqlite::Error> {
    let now = now_ms();
    let mut mixes = Vec::new();

    // 1. 最近在听：近 14 天播过的曲目，最近播放在前。
    let recent = list_recent_tracks(conn, now - RECENT_WINDOW_MS, MAX_TRACKS)?;
    let recent_count = count_recent_tracks(conn, now - RECENT_WINDOW_MS)?;
    if let Some(mix) = finish_mix(
        "recent",
        "最近在听",
        format!("近 14 天听过 {recent_count} 首"),
        recent,
    ) {
        mixes.push(mix);
    }

    // 2. 循环最多的歌：全历史播放次数 ≥ 2，次数降序。
    let most = list_most_played_tracks(conn, MOST_PLAYED_MIN_PLAYS, MAX_TRACKS)?;
    let total_plays: i64 = most.iter().map(|s| s.play_count).sum();
    if let Some(mix) = finish_mix(
        "most_played",
        "循环最多的歌",
        format!("这 {} 首歌一共听了 {total_plays} 次", most.len()),
        most.into_iter().map(|s| s.track).collect(),
    ) {
        mixes.push(mix);
    }

    // 3. 收藏里的常客：收藏 × 播放次数的交集，常听的收藏在前。
    let favorites = list_favorite_tracks_by_plays(conn, MAX_TRACKS)?;
    if let Some(mix) = finish_mix(
        "favorite_picks",
        "收藏里的常客",
        format!("收藏里循环最多的 {} 首", favorites.len()),
        favorites,
    ) {
        mixes.push(mix);
    }

    // 4. 深夜歌单：最近一次播放落在本地 22:00–次日 6:00 的曲目。
    //    出不出场取决于用户是否真的在深夜听过歌，与当前钟点无关。
    let late = list_late_night_tracks(conn, NIGHT_START_HOUR, NIGHT_END_HOUR, MAX_TRACKS)?;
    let late_count = count_late_night_tracks(conn, NIGHT_START_HOUR, NIGHT_END_HOUR)?;
    if let Some(mix) = finish_mix(
        "late_night",
        "深夜歌单",
        format!("22:00–次日 06:00 听过 {late_count} 首"),
        late,
    ) {
        mixes.push(mix);
    }

    // 5. 久未重温：听过 ≥ 3 次但 30 天没碰，最久没听的排最前。
    let unheard_cutoff = now - UNHEARD_WINDOW_MS;
    let unheard = list_unreplayed_tracks(conn, UNHEARD_MIN_PLAYS, unheard_cutoff, MAX_TRACKS)?;
    let unheard_count = count_unreplayed_tracks(conn, UNHEARD_MIN_PLAYS, unheard_cutoff)?;
    if let Some(mix) = finish_mix(
        "nostalgic",
        "久未重温",
        format!("有 {unheard_count} 首歌超过 30 天没听了"),
        unheard.into_iter().map(|s| s.track).collect(),
    ) {
        mixes.push(mix);
    }

    Ok(mixes)
}

/// 摘要：key / title / subtitle + 封面预览（前 3 张非空图）。
fn summarize(mix: &LocalMix) -> LocalMixSummary {
    LocalMixSummary {
        key: mix.key.to_string(),
        title: mix.title.to_string(),
        subtitle: mix.subtitle.clone(),
        cover_urls: mix
            .tracks
            .iter()
            .filter(|t| !t.pic_url.is_empty())
            .map(|t| t.pic_url.clone())
            .take(3)
            .collect(),
    }
}

/// 按 key 取合辑完整曲目。`None` = 本次数据里没有这个合辑（key 根本不存在，
/// 或当次曲目数不足门槛）—— 命令层统一转成 Err，前端不必区分两种情况。
fn mix_tracks(conn: &Connection, key: &str) -> Result<Option<Vec<Track>>, rusqlite::Error> {
    Ok(build_mixes(conn)?
        .into_iter()
        .find(|m| m.key == key)
        .map(|m| m.tracks))
}

/// 列出全部本地推荐合辑（摘要：key / title / subtitle + 封面预览）。
#[tauri::command(rename = "list_local_mixes")]
pub fn cmd_list_local_mixes(state: State<'_, AppState>) -> Result<Vec<LocalMixSummary>, String> {
    let db = state.db.clone().ok_or_else(|| "数据库不可用".to_string())?;
    db.with(|conn| Ok(build_mixes(conn)?.iter().map(summarize).collect()))
        .map_err(|e| format!("生成推荐合辑失败: {e}"))
}

/// 取单个合辑的完整曲目（`key` 来自 `list_local_mixes` 的返回）。
#[tauri::command(rename = "get_local_mix_tracks")]
pub fn cmd_get_local_mix_tracks(
    state: State<'_, AppState>,
    key: String,
) -> Result<Vec<Track>, String> {
    let db = state.db.clone().ok_or_else(|| "数据库不可用".to_string())?;
    // clone 进闭包：key 本体留给最后的错误信息，避免 E0382
    let mix_key = key.clone();
    db.with(move |conn| mix_tracks(conn, &mix_key))
        .map_err(|e| format!("生成推荐合辑失败: {e}"))?
        .ok_or_else(|| format!("未知的合辑标识: {key}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    use crate::db::migrations;
    use crate::db::store::{add_liked_song, db_track_id, upsert_tracks};
    use crate::provider::types::SourceId;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        migrations::run(&conn).expect("migrations");
        conn
    }

    fn track(id: &str, title: &str, pic_url: &str) -> Track {
        Track {
            id: id.to_string(),
            platform: SourceId::new("wyy"),
            title: title.to_string(),
            singer: "测试歌手".to_string(),
            album: "测试专辑".to_string(),
            pic_url: pic_url.to_string(),
            duration: 210.0,
            music_id: None,
            start_ms: None,
            end_ms: None,
        }
    }

    /// 种一首曲目 + 全历史统计（原始 SQL，时间戳精确可控，绕开
    /// record_listen 的「当前时刻」取值）。顺带写一条播放记录，好让
    /// 「清完统计播放记录仍在」那条断言在合辑测试里也成立。
    fn seed_history_and_stat(conn: &Connection, t: &Track, played_at: i64, play_count: i64) {
        upsert_tracks(conn, &[t]).expect("upsert");
        let db_id = db_track_id(t);
        conn.execute(
            "INSERT OR REPLACE INTO play_history
                 (id, track_id, played_at, played_duration_ms, completed)
             VALUES (?1, ?2, ?3, 0, 0)",
            params![format!("{db_id}:{played_at}"), db_id, played_at],
        )
        .expect("seed history");
        seed_stat_only(conn, t, played_at, play_count);
    }

    /// 只种全历史统计、不写播放历史：「久未重温」的老歌很久没播，
    /// 历史表里本来就不该有它们的记录。
    fn seed_stat_only(conn: &Connection, t: &Track, last_played_at: i64, play_count: i64) {
        conn.execute(
            "INSERT OR REPLACE INTO play_stats
                 (track_id, play_count, finished_count, last_played_at, total_played_ms)
             VALUES (?1, ?2, 0, ?3, 0)",
            params![db_track_id(t), play_count, last_played_at],
        )
        .expect("seed stats");
    }

    /// 空库（还没听过任何歌）时一个合辑都不出。
    #[test]
    fn empty_db_has_no_mixes() {
        let conn = conn();
        let mixes = build_mixes(&conn).expect("build");
        assert!(mixes.is_empty(), "空库不应出任何合辑: {mixes:?}");
    }

    /// 曲目不足门槛（MIN_TRACKS = 5）的合辑直接不出现：
    /// 只有 4 首近期播放时连「最近在听」都拿不出来。
    #[test]
    fn below_threshold_mix_is_hidden() {
        let conn = conn();
        let now = now_ms();
        for i in 0..4 {
            seed_history_and_stat(
                &conn,
                &track(&format!("r{i}"), &format!("仅{i}"), ""),
                now - 1000,
                1,
            );
        }
        let mixes = build_mixes(&conn).expect("build");
        assert!(mixes.is_empty(), "4 首不该凑出任何合辑: {mixes:?}");
    }

    /// 完整场景：固定 key 顺序、副标题动态数字、封面取前 3 张非空图。
    /// 「深夜歌单」是否出现取决于种子行的本地钟点（跑测试的时刻），
    /// 这里只锁它在场时的相对次序，不强制出现。
    #[test]
    fn mixes_fixed_order_subtitles_and_covers() {
        let conn = conn();
        let now = now_ms();
        let hour = 3600 * 1000;

        // 6 首近期在听（1 小时前起依次错开 1 秒，最近播放在前），
        // 播放计数都是 2；封面：r0/r1/r3 有图、r2/r4/r5 没图。
        let recent: Vec<Track> = (0..6)
            .map(|i| {
                let pic = match i {
                    0 => "http://x/1.jpg",
                    1 => "http://x/2.jpg",
                    3 => "http://x/4.jpg",
                    _ => "",
                };
                track(&format!("r{i}"), &format!("近期{i}"), pic)
            })
            .collect();
        for (i, t) in recent.iter().enumerate() {
            seed_history_and_stat(&conn, t, now - hour - i as i64 * 1000, 2);
        }
        // 前 5 首进收藏 → 「收藏里的常客」正好 5 首
        for t in recent.iter().take(5) {
            add_liked_song(&conn, t, "local").expect("like");
        }
        // 5 首 40 天没听的老歌（只进统计、不进历史）→ 「久未重温」，
        // 顺带把「循环最多的歌」凑到 11 首 / 27 次。
        for i in 0..5 {
            let t = track(&format!("old{i}"), &format!("老歌{i}"), "");
            upsert_tracks(&conn, &[&t]).expect("upsert old");
            seed_stat_only(&conn, &t, now - 40 * 24 * hour, 3);
        }

        let mixes = build_mixes(&conn).expect("build");
        let keys: Vec<&str> = mixes.iter().map(|m| m.key).collect();
        // 固定顺序 + 只含已知 key；深夜合辑允许在场/缺席，相对次序不能乱
        let expected = ["recent", "most_played", "favorite_picks", "late_night", "nostalgic"];
        let known: Vec<&str> = expected
            .iter()
            .copied()
            .filter(|k| keys.contains(k))
            .collect();
        assert_eq!(keys, known, "合辑顺序必须固定");
        for k in ["recent", "most_played", "favorite_picks", "nostalgic"] {
            assert!(keys.contains(&k), "缺少合辑 {k}: {keys:?}");
        }

        let by = |k: &str| mixes.iter().find(|m| m.key == k).unwrap();
        assert_eq!(by("recent").subtitle, "近 14 天听过 6 首");
        assert_eq!(by("most_played").subtitle, "这 11 首歌一共听了 27 次");
        assert_eq!(by("favorite_picks").subtitle, "收藏里循环最多的 5 首");
        assert_eq!(by("nostalgic").subtitle, "有 5 首歌超过 30 天没听了");

        let recent_mix = by("recent");
        assert_eq!(recent_mix.tracks.len(), 6);
        assert_eq!(recent_mix.tracks[0].title, "近期0", "最近播放在前");
        let summary = summarize(recent_mix);
        assert_eq!(summary.key, "recent");
        assert_eq!(summary.title, "最近在听");
        assert_eq!(
            summary.cover_urls,
            vec!["http://x/1.jpg", "http://x/2.jpg", "http://x/4.jpg"],
            "封面预览 = 前 3 张非空图"
        );
    }

    /// mix_tracks：按 key 拿完整曲目；未知 key（或本次数据不够没出的）都是 None。
    #[test]
    fn mix_tracks_by_key_and_unknown() {
        let conn = conn();
        let now = now_ms();
        for i in 0..5 {
            seed_history_and_stat(
                &conn,
                &track(&format!("m{i}"), &format!("月{i}"), ""),
                now - 1000 * (i as i64 + 1),
                2,
            );
        }
        let tracks = mix_tracks(&conn, "recent").expect("db").expect("recent 在场");
        assert_eq!(tracks.len(), 5);
        assert!(
            mix_tracks(&conn, "nope").expect("db").is_none(),
            "未知 key 必须是 None"
        );
    }

    /// 清完听歌统计，首页不该还有任何合辑 —— 统计与播放记录一起清，同源同命。
    ///
    /// 背景：早先「最近在听」「深夜歌单」读 `play_history`，而清除只删统计表，
    /// 用户清完统计回到首页照样看到推荐歌；合辑门槛降到「至少 2 类」后更显眼。
    /// 这里是 UI 真正调用的那条路径（`build_mixes`），把现象钉在这一层。
    #[test]
    fn clearing_listen_stats_empties_mixes_and_history() {
        let conn = conn();
        let now = now_ms();
        let hour = 3600 * 1000;
        // 6 首近期、每首 3 次 → 「最近在听」+「循环最多的歌」正好两类
        for i in 0..6 {
            seed_history_and_stat(
                &conn,
                &track(&format!("c{i}"), &format!("清{i}"), ""),
                now - i as i64 * hour,
                3,
            );
        }
        assert_eq!(
            build_mixes(&conn).expect("build").len(),
            2,
            "清之前应当凑够两类"
        );

        crate::db::store::clear_listen_stats(&conn).expect("清除");
        let count = |table: &str| -> i64 {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .expect("计数")
        };
        assert_eq!(
            (count("play_stats"), count("play_history")),
            (0, 0),
            "统计与播放记录一起清"
        );
        assert!(
            build_mixes(&conn).expect("build after clear").is_empty(),
            "清完统计不该还有合辑"
        );
        assert!(
            mix_tracks(&conn, "recent").expect("db").is_none(),
            "详情页也不该再拿到曲目"
        );
    }
}
