//! 歌词域：`lyric_settings`（逐曲目偏移 / 关联本地歌词文件）与 `lyrics`（歌词正文落库）。
//!
//! ## 为什么现在才接上这两张表
//! `lyrics` / `lyric_settings` 在 V11 迁移里建好了，但全库零读写 —— 歌词正文只活在
//! 前端 `localOnline.ts` 的进程内 LRU（`LYRIC_CACHE_CAP = 50`），退出即丢。对照
//! lx-music-desktop：它有 `lyric` 表（`id/source/type/text`，四种类型）落库，且
//! `lyric_settings.offset_ms` 是用户可配的歌词偏移（LX 的 `PlayTimeoutModal` 同级设置）。
//! 本文件补齐这两块：
//! - `lyric_settings.offset_ms`：逐曲目歌词时间轴偏移，用户可调，跨会话保留；
//! - `lyrics`：取词成功后落库，网络失败时作为兜底回读（离线也能看到上次歌词）。
//!
//! ## 偏移方向约定（与播放器一致，别反）
//! `offset_ms > 0` = 歌词**延后**出现（唱得比标的时间轴慢，需要把判定时间往前挪）。
//! 判定式统一为 `findActiveIndex(lines, position - offset_ms)`：
//! 想让歌词晚 500ms 出现，就要用「播放进度 - 500ms」去查 → offset = +500。
//! 钳位 ±10s（`MAX_OFFSET_MS`）：超过这个量级基本是取错词/错版本，用户该换源而不是
//! 继续拖滑块，钳位也避免脏数据把歌词推到完全不相关的位置。
//!
//! ## 外键
//! 两张表都 `REFERENCES tracks(id) ON DELETE CASCADE`，但本地曲目不入库
//! （`upsert_tracks` 跳过 local），所以写之前一律先判 tracks 存在，不存在直接跳过：
//! 歌词是锦上添花，不该因为外键失败把播放链路打断（与 stats 域同一取舍）。

use rusqlite::{params, Connection, OptionalExtension};

use super::*;

/// 歌词偏移的可调范围（毫秒）。超出即夹紧，不报错 —— 用户拖过头不会丢设置。
pub(crate) const MAX_OFFSET_MS: i64 = 10_000;

/// 夹到合法区间：NaN / 越界都归到端点（不信任前端传来的数字）。
fn clamp_offset(ms: i64) -> i64 {
    ms.clamp(-MAX_OFFSET_MS, MAX_OFFSET_MS)
}

/// 读逐曲目歌词偏移（毫秒）。没设过返回 0（表里没行 = 不偏移）。
pub(crate) fn get_lyric_offset(conn: &Connection, track_id: &str) -> Result<i64, rusqlite::Error> {
    conn.query_row(
        "SELECT offset_ms FROM lyric_settings WHERE track_id = ?1",
        params![track_id],
        |r| r.get::<_, i64>(0),
    )
    .optional()
    .map(|v| clamp_offset(v.unwrap_or(0)))
}

/// 写逐曲目歌词偏移。track_id 用 `db_track_id()` 口径（`platform:原始id`）。
///
/// 曲目不在 tracks 里（比如未被扫描入库的本地文件）直接跳过：撞外键会炸整条链路，
/// 而「这首的偏移没记住」的后果完全可以接受。
pub(crate) fn set_lyric_offset(
    conn: &Connection,
    track_id: &str,
    offset_ms: i64,
) -> Result<(), rusqlite::Error> {
    if !track_exists(conn, track_id)? {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO lyric_settings (track_id, offset_ms, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(track_id) DO UPDATE SET offset_ms = excluded.offset_ms,
                                             updated_at = excluded.updated_at",
        params![track_id, clamp_offset(offset_ms), now_ms()],
    )?;
    Ok(())
}

/// 歌词正文落库（取词成功 / 用户手动选词后调用，失败不影响播放）。
///
/// `source` 记音源（wyy/qq/kw/kg/local/换源后的目标源），回读时才知道这份词是哪来的。
///
/// `manual` 标这份词是不是**用户手动挑的**（播放页「搜索歌词」选的候选）：
/// - `true` —— 取词链路开头就直接回读它，连源站都不打。用户的选择优先级高于源站，
///   否则联网重取会拿回源站那份错词，用户等于白换（桌面歌词窗口是独立 WebView，
///   自己走一遍取词链路，表现就是「播放页换了、桌面歌词没换」）。
/// - `false` —— 自动取的词，仅作断网兜底。
///
/// 自动落库必须把 `manual` 写回 0：这首可能先前被手动换过，自动链路重新取到词时
/// 应当交回自动口径，否则手动标记会永久粘在这首歌上。
///
/// ## 四列全写（含 `word_lrc` / `romaji`）
/// 这两列在 V11 迁移里就建好了，但一直「没有产出方」：前端 `Lyric` 那时也只有
/// `lrc` / `translation` 两个面。2026-10-06 音源包补上了 `wordByWord`（QRC/KRC 逐字）
/// 与 `romanization`（罗马音），取词链路手上已经有这两个值，这里就一并落库，
/// 断网回读时逐字染色才不会退化成纯文本。
///
/// 注意**空值照写**（不做「新值为空就保留旧值」的保护）：`word_lrc` 的时间轴是跟
/// 主歌词配套的，换源后主词已经换成另一份，再拿旧源的逐字时间轴去叠新主词，
/// 只会错位到没法看 —— 宁可退化成无染色，也不要错位。
pub(crate) fn upsert_lyric(
    conn: &Connection,
    track_id: &str,
    lrc: &str,
    word_lrc: &str,
    translation: &str,
    romaji: &str,
    source: &str,
    manual: bool,
) -> Result<(), rusqlite::Error> {
    if !track_exists(conn, track_id)? {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO lyrics (track_id, lrc, word_lrc, translation, romaji, source, manual, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(track_id) DO UPDATE SET lrc = excluded.lrc,
                                             word_lrc = excluded.word_lrc,
                                             translation = excluded.translation,
                                             romaji = excluded.romaji,
                                             source = excluded.source,
                                             manual = excluded.manual,
                                             fetched_at = excluded.fetched_at",
        params![
            track_id,
            lrc,
            word_lrc,
            translation,
            romaji,
            source,
            manual as i64,
            now_ms()
        ],
    )?;
    Ok(())
}

/// 回读已落库的歌词（网络取词失败时的兜底）。没落过返回 None。
pub(crate) fn get_lyric(
    conn: &Connection,
    track_id: &str,
) -> Result<Option<LyricRecord>, rusqlite::Error> {
    conn.query_row(
        "SELECT lrc, word_lrc, translation, romaji, source, manual FROM lyrics WHERE track_id = ?1",
        params![track_id],
        |r| {
            Ok(LyricRecord {
                lrc: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                word_lrc: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                translation: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                romaji: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                source: r.get::<_, String>(4)?,
                manual: r.get::<_, i64>(5)? != 0,
            })
        },
    )
    .optional()
}

/// 落库的歌词正文（对齐前端 `Lyric`，多带一个来源标记）。
///
/// 字段名与列名故意不同：库里是 V11 迁移定下的 `word_lrc` / `romaji`，而对外
/// （`get_lyric` 命令的 JSON、前端 `LyricRecord extends Lyric`）统一用
/// `wordByWord` / `romanization` —— 与音源包契约 `ContractLyric` 的字段名一致，
/// 前端拿到就能直接当 `Lyric` 用，不必在两套名字之间来回翻译。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricRecord {
    pub lrc: String,
    /// 逐字歌词（库里列名 `word_lrc`；QRC 行内格式，见前端 `Lyric.wordByWord`）
    #[serde(rename = "wordByWord")]
    pub word_lrc: String,
    pub translation: String,
    /// 罗马音（库里列名 `romaji`；普通 LRC 格式，日文歌才有）
    #[serde(rename = "romanization")]
    pub romaji: String,
    /// 取词时的音源（换源兜底后是目标源）
    pub source: String,
    /// 是不是用户在播放页「搜索歌词」手动挑的（V13 起）。
    /// `true` 时取词链路直接回读它，不打源站。
    pub manual: bool,
}

/// tracks 里有没有这一行。两张歌词表都有指向 tracks 的外键，写前统一判一次。
fn track_exists(conn: &Connection, track_id: &str) -> Result<bool, rusqlite::Error> {
    conn.query_row(
        "SELECT 1 FROM tracks WHERE id = ?1",
        params![track_id],
        |_| Ok(()),
    )
    .optional()
    .map(|v| v.is_some())
}
