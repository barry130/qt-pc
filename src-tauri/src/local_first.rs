//! 本地优先播放（DESIGN §7.13）：把「播放」从「身份 ↔ 文件」的强绑定里解耦。
//!
//! 背景：收藏的本地歌在文件被移动 / 改名 / 删除后变成「打不开的死条目」；
//! 下载过的在线歌在「清空下载列表」（只删行不删文件）后明明盘上有文件
//! 却回到在线取链。两类问题同根：**播放只认当初那一个文件路径**。
//!
//! 统一解法是两条链：
//!
//! **解析链**（在线曲目播之前，全部本地查询，零网络）：
//! ① 账本 `download_files`（身份级命中，零误判）→ ② `download_tasks`
//! done 行兜底（V19 前的存量）→ ④ 孤儿索引（账本上线前被清掉记录的
//! 下载目录存量，K2 元数据级匹配）→ ⑤ 本地曲库（K2）。任一命中且文件
//! 在就直接当本地文件播。
//!
//! **替身链**（本地曲目打不开之后）：
//! 池 A 本地曲库（同名同歌手同时长的另一份文件）→ 池 B 账本/孤儿 →
//! 池 C 前端搜索桥（在线替身，前 5 条里时长最接近的一条）。只决定本次
//! 播什么，**不改收藏**（用户定案 2026-10-28：收藏是用户自己落的选择，
//! 失效时提示出来，不替用户做主重链）。
//!
//! 总开关 `play.localFirst`（settings_keys.rs）：关 = 两条链全关，完全
//! 回到在线取链（连老的「已下载文件离线播」一起关）。

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::db::store::{self, MetaFileRow};
use crate::db::Database;
use crate::provider::types::Track;

/// 开关读取：键不存在 / 读库失败都按**开**处理（新功能默认生效，老用户
/// 无感升级）；显式写 `false` 才关。
pub fn enabled(conn: &rusqlite::Connection) -> bool {
    store::get_setting(conn, crate::settings_keys::SETTING_PLAY_LOCAL_FIRST)
        .ok()
        .flatten()
        .map(|v| v != "false")
        .unwrap_or(true)
}

// ---------- K2 匹配器（纯函数） ----------
//
// 两级匹配口径（DESIGN §7.13）：
// - K1 身份级：`platform:music_id` 或 `local:<路径>` 完全相等。零误判，
//   账本 / 曲库主键都走它；
// - K2 元数据级：归一化标题**完全相同** + 歌手集合相交 + 时长差 ≤ 3s。
//   孤儿索引、本地曲库、池 B 都走它。标题相同已经是很强的信号（搜索
//   场景里「同名不同歌」通常标题写法不同），加上歌手与时长双护栏后
//   误配概率足够低；宁可错过（回落在线），不能错放（放错歌比放不出
//   歌更糟）。标题/歌手的**方向不固定**（文件名可能写成「歌名 - 歌手」），
//   所以本地行侧交换后再试一次，见 `row_hit_meta`。

/// 归一化：小写 + 只留字母数字（全角字符按 Unicode 归一）。标点、空格、
/// 《》「」等装饰全部丢掉——「Canon (经典版)」与「canon经典版」相等。
pub fn normalize_text(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 歌手串拆成归一化 token 集合：`周杰伦/费玉清` → {周杰伦, 费玉清}；
/// ` feat. ` 这类拉丁分隔自然按非字母数字切开。
fn singer_tokens(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(normalize_text)
        .filter(|t| !t.is_empty())
        .collect()
}

/// 歌手集合相交判定（K2 的歌手护栏）。两侧都空（纯音乐 / 标签缺失）
/// 视为通过——标题 + 时长护栏还在，不靠歌手兜底就永远匹配不上纯音乐。
pub fn singers_overlap(a: &str, b: &str) -> bool {
    let ta = singer_tokens(a);
    let tb = singer_tokens(b);
    if ta.is_empty() && tb.is_empty() {
        return true;
    }
    ta.iter().any(|t| tb.contains(t))
}

/// 时长护栏：两侧都已知（>0）且差 ≤ 3s。任一侧未知就放行给标题+歌手
/// 把关——孤儿文件读不到时长的情况不少（容器损坏 / 标签缺失）。
pub fn duration_close_ms(a_ms: i64, b_ms: i64) -> bool {
    if a_ms <= 0 || b_ms <= 0 {
        return true;
    }
    (a_ms - b_ms).abs() <= 3_000
}

/// K2 单行命中判定（**两种读法都算**）：文件名里的「歌手 - 歌名」与
/// 「歌名 - 歌手」从字符串本身判断不出来——`晴天 - 周杰伦.mp3` 和
/// `周杰伦 - 晴天.mp3` 是同一种形状。所以本地行侧的标题/歌手交换后也试
/// 一次，任一通过即命中；在线一方的标题/歌手来自接口，是权威的，不交换。
///
/// 为什么不二选一：猜错方向就会「一边命中一边不命中」，而两种写法的存量
/// 文件都真实存在；标题全等 + 歌手相交 + 时长三道光卡都在，认错方向几乎
/// 不可能同时满足。
fn row_hit_meta(
    want_title_n: &str,
    want_singer: &str,
    want_duration_ms: i64,
    row_title: &str,
    row_singer: &str,
    row_duration_ms: i64,
) -> bool {
    if !duration_close_ms(want_duration_ms, row_duration_ms) {
        return false;
    }
    if normalize_text(row_title) == want_title_n && singers_overlap(want_singer, row_singer) {
        return true;
    }
    normalize_text(row_singer) == want_title_n && singers_overlap(want_singer, row_title)
}

/// K2 元数据级匹配：账本/孤儿行（`MetaFileRow`）。
pub(crate) fn strict_hit_meta(
    want_title: &str,
    want_singer: &str,
    want_duration_ms: i64,
    rows: &[MetaFileRow],
) -> Option<MetaFileRow> {
    let want_title_n = normalize_text(want_title);
    if want_title_n.is_empty() {
        return None;
    }
    rows.iter()
        .find(|r| {
            row_hit_meta(
                &want_title_n,
                want_singer,
                want_duration_ms,
                &r.title,
                &r.singer,
                r.duration_ms,
            )
        })
        .cloned()
}

/// K2 元数据级匹配：本地曲库 / 搜索候选（`Track`，时长按秒存）。
pub(crate) fn strict_hit_track(
    want_title: &str,
    want_singer: &str,
    want_duration_ms: i64,
    rows: &[Track],
) -> Option<Track> {
    let want_title_n = normalize_text(want_title);
    if want_title_n.is_empty() {
        return None;
    }
    rows.iter()
        .find(|r| {
            row_hit_meta(
                &want_title_n,
                want_singer,
                want_duration_ms,
                &r.title,
                &r.singer,
                (r.duration * 1000.0) as i64,
            )
        })
        .cloned()
}

/// 池 C 挑选（DESIGN §7.13 已批准口径）：前 5 条里时长最接近的第一条，
/// 护栏 ≤ 5s；都不接近取第 1 条兜底。搜索结果来自 `title singer` 关键词，
/// 平台排序已经是相关性排序，不做标题复核（复核会把「现场版/重录版」
/// 这类真实存在的替身也拒掉）。
pub fn pick_best_search(candidates: &[Track], want_duration_ms: i64) -> Option<Track> {
    let head: Vec<&Track> = candidates.iter().take(5).collect();
    let first = head.first()?;
    if want_duration_ms <= 0 {
        return Some((*first).clone());
    }
    head.iter()
        .filter(|t| t.duration > 0.0)
        .min_by_key(|t| {
            ((t.duration * 1000.0) as i64 - want_duration_ms).abs()
        })
        .and_then(|best| {
            let diff = (((best.duration * 1000.0) as i64) - want_duration_ms).abs();
            (diff <= 5_000).then(|| (*best).clone())
        })
        .or_else(|| Some((*first).clone()))
}

// ---------- 解析链（在线曲目 → 本地文件） ----------

/// 解析链命中：文件路径 + 哪一层命中的（日志与事件用）。
pub struct OnlineLocalHit {
    pub path: String,
    /// ledger / task / orphan / library
    pub kind: &'static str,
}

/// 在线曲目播之前找本地文件：② 账本 → ② done 任务兜底 → ④ 孤儿 →
/// ⑤ 本地曲库。命中且文件真实存在才返回；账本/孤儿条目指向已消失的
/// 文件时顺手清掉（自愈，下次不用再白查一遍）。
pub async fn find_online_local_file(db: &std::sync::Arc<Database>, track: &Track) -> Option<OnlineLocalHit> {
    let track = track.clone();
    let db = std::sync::Arc::clone(db);
    tauri::async_runtime::spawn_blocking(move || find_online_local_file_blocking(&db, &track))
        .await
        .ok()
        .flatten()
}

fn find_online_local_file_blocking(
    db: &std::sync::Arc<Database>,
    track: &Track,
) -> Option<OnlineLocalHit> {
    let db_id = store::db_track_id(track);
    let duration_ms = (track.duration * 1000.0) as i64;

    // 第一段（短锁）：只查库、只选候选，**不碰文件系统**。
    // 为什么要拆：旧实现整条链都在 `db.with(...)` 里跑，而 `with` 拿的是全局
    // 连接锁；链里的 `Path::exists()` 落在机械盘/网络盘上可能几十毫秒，
    // 这期间所有播放、收藏、下载的写入都得排队（评审 P1，2026-10-29 修）。
    struct Plan {
        enabled: bool,
        ledger: Option<(String, &'static str)>,
        orphan: Option<String>,
        library: Option<String>,
    }

    let plan = db.with(|conn| -> Result<Plan, rusqlite::Error> {
        // 总开关关：整条链不做（调用方直接回落在线取链）
        if !enabled(conn) {
            return Ok(Plan { enabled: false, ledger: None, orphan: None, library: None });
        }
        // ①② 身份级：账本 → done 任务（哪个命中由库内查询决定）
        let ledger = match store::local_file_for_track(conn, &db_id)? {
            Some(row) => {
                let kind = if store::download_file_for(conn, &db_id)?.is_some() {
                    "ledger"
                } else {
                    "task"
                };
                Some((row.path.clone(), kind))
            }
            None => None,
        };
        // ④ 孤儿索引（K2）：匹配是纯 CPU（无 IO），放在锁内不影响延迟
        let orphan = strict_hit_meta(
            &track.title,
            &track.singer,
            duration_ms,
            &store::all_orphan_files(conn)?,
        )
        .map(|r| r.path);
        // ⑤ 本地曲库（K2）
        let library = strict_hit_track(
            &track.title,
            &track.singer,
            duration_ms,
            &store::local_candidates_by_meta(conn, &track.title, duration_ms)?,
        )
        .map(|c| c.id);
        Ok(Plan { enabled: true, ledger, orphan, library })
    });

    let plan = match plan {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[local-first] 解析链查询失败，回落在线: {e}");
            return None;
        }
    };
    if !plan.enabled {
        return None;
    }

    // 第二段（**不持锁**）：按优先级验文件是否真实存在。
    let mut stale_ledger: Option<String> = None;
    let mut stale_orphan: Option<String> = None;

    let mut hit = plan.ledger.clone().and_then(|(path, kind)| {
        if Path::new(&path).exists() {
            Some(OnlineLocalHit { path, kind })
        } else {
            stale_ledger = Some(path);
            None
        }
    });

    if hit.is_none() {
        if let Some(path) = plan.orphan.clone() {
            if Path::new(&path).exists() {
                hit = Some(OnlineLocalHit { path, kind: "orphan" });
            } else {
                stale_orphan = Some(path);
            }
        }
    }

    if hit.is_none() {
        if let Some(path) = plan.library.filter(|p| Path::new(p).exists()) {
            hit = Some(OnlineLocalHit { path, kind: "library" });
        }
    }

    // 第三段（再次短锁）：死条目顺手清掉（自愈，下次不用再白查一遍）。
    // 文件系统校验放在锁外，写回只做单条 DELETE。
    if stale_ledger.is_some() || stale_orphan.is_some() {
        let ledger = stale_ledger.clone();
        let orphan = stale_orphan.clone();
        let _ = db.with(|conn| -> Result<(), rusqlite::Error> {
            if let Some(path) = ledger.as_deref() {
                // 账本条目按「当前库里的路径」删，避免误删刚被重新下载写入的新行
                if store::download_file_for(conn, &db_id)?.is_some() {
                    store::remove_download_file_by_path(conn, path)?;
                }
            }
            if let Some(path) = orphan.as_deref() {
                store::remove_orphan_file(conn, path)?;
            }
            Ok(())
        });
    }

    hit
}

// ---------- 替身链（本地曲目打不开 → 池 A/B/C） ----------

/// 替身结果。用户定案（2026-10-28）：只换播放、**不改收藏**——池 A/B
/// 命中也只把替身当本次播放对象，不重链收藏身份（`liked_songs` 不动）。
pub enum Substitute {
    /// 本地文件替身（池 A 曲库 / 池 B 账本、孤儿），`kind` 供事件透出。
    Local { track: Track, kind: &'static str },
    /// 在线替身（池 C 搜索桥）：由引擎走正常在线取链播放。
    Online { track: Track },
}

/// 本地曲目打不开后找替身：池 A（本地曲库）→ 池 B（账本 + 孤儿）→
/// 池 C（前端搜索桥）。只决定本次播什么，不改任何收藏/曲库数据。
/// 每层都验证文件真实存在（死条目不能拿来顶死条目）。
pub async fn find_local_substitute(
    app: &tauri::AppHandle,
    db: &std::sync::Arc<Database>,
    broken: &Track,
) -> Option<Substitute> {
    let want_duration_ms = (broken.duration * 1000.0) as i64;

    // 池 A + 池 B：一次 blocking 查询全拿出来。None = 总开关关（整个
    // 替身链不做，与解析链的开关同一把 `play.localFirst`）。
    let broken_clone = broken.clone();
    let db_a = std::sync::Arc::clone(db);
    let pools = tauri::async_runtime::spawn_blocking(move || {
        db_a.with(|conn| {
            if !enabled(conn) {
                return Ok(None);
            }
            let library = store::local_candidates_by_meta(conn, &broken_clone.title, want_duration_ms)?;
            let mut pool_b = store::all_download_files(conn)?;
            pool_b.extend(store::all_orphan_files(conn)?);
            Ok(Some((library, pool_b)))
        })
    })
    .await
    .ok()
    .and_then(|r| r.ok())
    .flatten();
    let (library, pool_b) = pools?;

    // 池 A：本地曲库严格匹配（排除自己——自己就是那个打不开的文件）
    let broken_path = crate::cue::strip_cue_suffix(&broken.id).to_string();
    if let Some(hit) = strict_hit_track(&broken.title, &broken.singer, want_duration_ms, &library) {
        let path = crate::cue::strip_cue_suffix(&hit.id).to_string();
        if path != broken_path && Path::new(&path).exists() {
            return Some(Substitute::Local {
                track: hit,
                kind: "library",
            });
        }
    }
    // 池 B：账本 + 孤儿（K2；排除死文件）
    if let Some(hit) = strict_hit_meta(&broken.title, &broken.singer, want_duration_ms, &pool_b) {
        if Path::new(&hit.path).exists() {
            let track = Track {
                id: hit.path.clone(),
                platform: crate::provider::types::SourceId::local(),
                title: hit.title,
                singer: hit.singer,
                album: broken.album.clone(),
                pic_url: String::new(),
                duration: if hit.duration_ms > 0 { hit.duration_ms as f64 / 1000.0 } else { broken.duration },
                music_id: None,
                start_ms: None,
                end_ms: None,
            };
            return Some(Substitute::Local { track, kind: "file" });
        }
    }

    // 池 C：前端搜索桥（桥未就绪 / 超时 / 无结果都按 None 处理）
    let found = crate::search_bridge::ask(app, &broken.title, &broken.singer, want_duration_ms).await?;
    let best = pick_best_search(&found, want_duration_ms)?;
    Some(Substitute::Online { track: best })
}

// ---------- 启动对账 ----------

/// 启动后台对账（一次，幂等）：
/// 1. `download_tasks` 里 done 且账本没有的行 → 补进账本（V19 存量救援）；
/// 2. 账本里指向已消失文件的条目 → 清掉（尸体不占索引）；
/// 3. 孤儿索引全量重建：下载目录里**不在账本**的音频文件读标签入库。
///    重建而不是增量：目录改名 / 移动后增量会留下永不消失的死条目，
///    全量重建天然幂等，代价是读一遍目录（启动后台跑，不卡冷启动）。
pub fn reconcile(db: &std::sync::Arc<Database>, download_dir: &Path) {
    let db = std::sync::Arc::clone(db);
    let dir = download_dir.to_path_buf();
    let res = db.with(move |conn| reconcile_blocking(conn, &dir));
    match res {
        Ok((rescued, pruned, orphans)) => log::info!(
            "[local-first] 对账完成：账本救援 {rescued} 条，清尸体 {pruned} 条，孤儿索引 {orphans} 条"
        ),
        Err(e) => log::warn!("[local-first] 对账失败（下次启动重试）: {e}"),
    }
}

fn reconcile_blocking(conn: &rusqlite::Connection, dir: &Path) -> Result<(usize, usize, usize), rusqlite::Error> {
    let rescued = store::rescue_done_tasks_to_ledger(conn)?;
    let mut pruned = 0usize;
    for row in store::all_download_files(conn)? {
        if !Path::new(&row.path).exists() {
            pruned += store::remove_download_file_by_path(conn, &row.path)?;
        }
    }
    // 孤儿全量重建：账本路径集合 = 已有身份的文件，剩余音频文件才建孤儿行
    let ledger_paths: HashSet<String> = store::all_download_files(conn)?
        .into_iter()
        .map(|r| r.path)
        .collect();
    store::clear_orphan_files(conn)?;
    let mut orphans = 0usize;
    for path in audio_files_under(dir) {
        let path_str = path.to_string_lossy().to_string();
        if ledger_paths.contains(&path_str) {
            continue;
        }
        let (title, singer, duration_ms) = match crate::local::read_metadata(&path) {
            Some(m) => (
                m.title.unwrap_or_default(),
                m.artist.unwrap_or_default(),
                (m.duration_secs * 1000.0) as i64,
            ),
            None => (String::new(), String::new(), 0),
        };
        store::upsert_orphan_file(
            conn,
            &path_str,
            &title,
            &singer,
            duration_ms,
            std::fs::metadata(&path).ok().map(|m| m.len() as i64),
        )?;
        orphans += 1;
    }
    Ok((rescued, pruned, orphans))
}

/// 下载目录下的音频文件（两层目录足够：下载目录不分子目录，最多容一层
/// 手动整理的子目录）。`.part` 临时文件天然不满足 `is_audio_file`。
fn audio_files_under(dir: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) {
        if depth > 2 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, depth + 1, out);
            } else if crate::local::is_audio_file(&path) {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, 0, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track_of(title: &str, singer: &str, duration: f64) -> Track {
        Track {
            id: "netease:1".into(),
            platform: crate::provider::types::SourceId::parse("netease").unwrap(),
            title: title.into(),
            singer: singer.into(),
            album: String::new(),
            pic_url: String::new(),
            duration,
            music_id: None,
            start_ms: None,
            end_ms: None,
        }
    }

    #[test]
    fn normalize_drops_punct_and_case() {
        assert_eq!(normalize_text("Canon (经典版)"), "canon经典版");
        assert_eq!(normalize_text("Canon（经典版）"), "canon经典版");
        assert_eq!(normalize_text("  A-B_C "), "abc");
    }

    #[test]
    fn singer_tokens_split_on_separators() {
        assert_eq!(
            singer_tokens("周杰伦/费玉清"),
            vec!["周杰伦".to_string(), "费玉清".to_string()]
        );
        // 拉丁分隔（空格/点）自然切开：feat. 本身也成一个 token，无碍
        // —— K2 比较的是 token 集合相交，多出的连接词不会误伤匹配。
        assert_eq!(singer_tokens("Eminem feat. Dr. Dre").len(), 4);
    }

    #[test]
    fn singers_overlap_empty_both_passes() {
        assert!(singers_overlap("", ""));
        assert!(!singers_overlap("", "周杰伦"));
        assert!(singers_overlap("周杰伦/费玉清", "费玉清"));
    }

    #[test]
    fn duration_close_rules() {
        assert!(duration_close_ms(200_000, 202_999));
        assert!(!duration_close_ms(200_000, 204_000));
        assert!(duration_close_ms(0, 100)); // 未知放行
        assert!(duration_close_ms(100, 0));
    }

    #[test]
    fn strict_hit_requires_exact_title() {
        let want = track_of("卡农", "dylanf", 200.0);
        let rows = vec![
            MetaFileRow { path: "a.mp3".into(), title: "卡农 (Live)".into(), singer: "dylanf".into(), duration_ms: 200_000 },
            MetaFileRow { path: "b.mp3".into(), title: "卡农".into(), singer: "dylanf".into(), duration_ms: 201_000 },
        ];
        let hit = strict_hit_meta(&want.title, &want.singer, 200_000, &rows).unwrap();
        assert_eq!(hit.path, "b.mp3");
    }

    #[test]
    fn strict_hit_rejects_same_title_different_singer() {
        let rows = vec![MetaFileRow {
            path: "x.mp3".into(),
            title: "卡农".into(),
            singer: "别人".into(),
            duration_ms: 200_000,
        }];
        assert!(strict_hit_meta("卡农", "dylanf", 200_000, &rows).is_none());
    }

    #[test]
    fn pick_best_search_takes_closest_within_guard() {
        let want = 240_000i64;
        let cands = vec![
            track_of("远", "a", 100.0),
            track_of("近1", "b", 242.0),
            track_of("近2", "c", 239.0),
        ];
        let best = pick_best_search(&cands, want).unwrap();
        assert_eq!(best.title, "近2"); // 1000ms 差 < 近1 的 2000ms
    }

    #[test]
    fn pick_best_search_falls_back_to_first_when_all_far() {
        let cands = vec![
            track_of("a", "a", 100.0),
            track_of("b", "b", 20.0),
        ];
        let best = pick_best_search(&cands, 240_000).unwrap();
        assert_eq!(best.title, "a");
    }

    #[test]
    fn pick_best_search_with_unknown_duration_takes_first() {
        let cands = vec![track_of("a", "a", 0.0), track_of("b", "b", 100.0)];
        let best = pick_best_search(&cands, 0).unwrap();
        assert_eq!(best.title, "a");
    }
}
