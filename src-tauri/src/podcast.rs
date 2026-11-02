//! 播客 / 有声书 RSS 订阅（B9）。
//!
//! 三块拼成一个闭环：
//! 1. **订阅**：`add_podcast_show` 拉一次 RSS，频道信息与全部单集入库；
//! 2. **播放**：单集音频地址作为 `Track.id`、平台 `podcast` 交给引擎，
//!    由 `audio/engine.rs` 的播客分支直接当在线流播（不经过音源脚本取链）；
//! 3. **续播**：`save_podcast_progress` 记住每集听到哪，前端下次点开时
//!    起播后 `seek` 回去（位置存在 `podcast_episodes.position_ms`）。
//!
//! ## 为什么不引 RSS/XML crate
//! 播客订阅只需要频道标题 / 描述 / 封面 + 每集的标题 / 地址 / 时长 / 发布时间，
//! 都是「找标签、取文本」的活；而 `quick-xml` 之类要额外引入一条依赖链，还得
//! 处理它的 feature 与 MSRV。这里用一套 30 行的标签扫描（大小写不敏感、
//! 支持 CDATA 与常见实体），够用且完全可测。**不做**的是：完整 RFC 一致性
//! （`<item>` 之外的自定义命名空间一律忽略）、XPath、DTD。
//!
//! ## 解析失败一律当「这个源不可用」
//! 频道标题为空就报错：一个连标题都取不到的 XML，八成是验证码页 / 404 页 /
//! 登录墙，静默存一条空歌单只会让用户以为订阅成功了。

use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use sha1::{Digest, Sha1};
use tauri::State;

use crate::AppState;

/// 单个订阅一次最多入库多少集。老牌播客动辄上千集，一次全塞会让首屏列表
/// 和数据库都变重；超过上限的按发布时间倒序丢弃最旧的。
const MAX_EPISODES: usize = 300;
/// 拉取超时。播客源多为个人服务器，比 API 慢，但 20s 还没响应基本就没救了。
const FETCH_TIMEOUT_SECS: u64 = 20;
/// 超过这个大小的响应体直接放弃：正常 RSS 几百 KB，几十 MB 只可能是下错了。
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastShow {
    id: String,
    url: String,
    title: String,
    author: String,
    description: String,
    image: String,
    /// 上次成功刷新的时间（epoch ms），0 = 还没刷过
    last_fetched_at: i64,
    /// 单集数（列表页直接显示，省得为每张卡再查一次）
    episode_count: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastEpisode {
    id: String,
    show_id: String,
    title: String,
    description: String,
    audio_url: String,
    duration_ms: i64,
    published_at: i64,
    played: bool,
    position_ms: i64,
}

/// 解析结果（尚未入库）。
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedFeed {
    pub title: String,
    pub author: String,
    pub description: String,
    pub image: String,
    pub episodes: Vec<ParsedEpisode>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedEpisode {
    pub title: String,
    pub description: String,
    pub audio_url: String,
    pub duration_ms: i64,
    pub published_at: i64,
}

// ---------- 文本小工具 ----------

/// ASCII 小写化。**必须字节长度不变**：调用方拿它在小写副本上 `find`，
/// 再用同一个下标去切原始字符串；标签名全是 ASCII，中文正文不会被改动。
fn lc(s: &str) -> String {
    s.to_ascii_lowercase()
}

fn decode_entities(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        // 只认短的实体（`&…;` 里超过 10 个字符的当普通文本），这样正文里写
        // 「Tom & Jerry; 1970」也不会被误当实体吞掉。
        let entity_end = if bytes[i] == b'&' {
            raw[i..].find(';').filter(|p| *p <= 10)
        } else {
            None
        };
        if let Some(semi) = entity_end {
            let entity = &raw[i + 1..i + semi];
            let decoded = match entity {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                    u32::from_str_radix(&entity[2..], 16).ok().and_then(char::from_u32)
                }
                _ if entity.starts_with('#') => entity[1..].parse::<u32>().ok().and_then(char::from_u32),
                // 认不出的实体原样保留：宁可显示 `&foo;` 也不要凭空吞字
                _ => None,
            };
            if let Some(ch) = decoded {
                out.push(ch);
                i += semi + 1;
                continue;
            }
        }
        let ch = raw[i..].chars().next().unwrap_or('\0');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// 取标签文本：`<name …>正文</name>`。自闭合或没闭合时返回 None。
fn tag_text(xml: &str, name: &str) -> Option<String> {
    let lower = lc(xml);
    let open = format!("<{}", name.to_ascii_lowercase());
    let start = lower.find(&open)?;
    // 必须确认是完整标签名（避免 `<title` 命中 `<titleSort`）
    let after = lower.as_bytes().get(start + open.len()).copied()?;
    if !matches!(after, b'>' | b' ' | b'\t' | b'\r' | b'\n' | b'/') {
        return None;
    }
    let text_start = start + lower[start..].find('>')? + 1;
    let lower_close = format!("</{}>", name.to_ascii_lowercase());
    let end = lower[text_start..].find(&lower_close)? + text_start;
    Some(clean_text(&xml[text_start..end]))
}

/// 取标签属性：`<name attr="v">`。属性值支持单/双引号。
fn tag_attr(xml: &str, name: &str, attr: &str) -> Option<String> {
    let lower = lc(xml);
    let open = format!("<{}", name.to_ascii_lowercase());
    let start = lower.find(&open)?;
    let inside_end = start + lower[start..].find('>')?;
    let inside = &lower[start..inside_end];
    let needle = format!("{}=", attr.to_ascii_lowercase());
    let at = inside.find(&needle)? + needle.len();
    // inside_end 已经是**绝对**下标（上面加了 start），这里不能再加一次
    let raw = &xml[start + at..inside_end];
    let quote = raw.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let rest = &raw[1..];
    let value = &rest[..rest.find(quote)?];
    Some(decode_entities(value).trim().to_string())
}

/// 文本清洗：去 CDATA 包装、去 HTML 标签、压空白。
fn clean_text(raw: &str) -> String {
    let text = raw.trim();
    let text = text
        .strip_prefix("<![CDATA[")
        .and_then(|inner| inner.strip_suffix("]]>"))
        .unwrap_or(text);
    // 描述里常混 `<p>` / `<br>`：标题与摘要都不该把它们显示出来
    let mut plain = String::with_capacity(text.len());
    let mut depth = 0usize;
    for ch in text.chars() {
        match ch {
            '<' => depth += 1,
            '>' if depth > 0 => depth -= 1,
            _ if depth == 0 => plain.push(ch),
            _ => {}
        }
    }
    decode_entities(&plain).split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 时长：`3723` / `62:03` / `1:02:03`（iTunes 三种写法都见过）。
fn parse_duration(raw: &str) -> i64 {
    let text = raw.trim();
    if text.is_empty() {
        return 0;
    }
    let parts: Vec<&str> = text.split(':').collect();
    let secs = match parts.as_slice() {
        [s] => s.trim().parse::<i64>().unwrap_or(0),
        [m, s] => m.trim().parse::<i64>().unwrap_or(0) * 60 + s.trim().parse::<i64>().unwrap_or(0),
        [h, m, s] => {
            h.trim().parse::<i64>().unwrap_or(0) * 3600
                + m.trim().parse::<i64>().unwrap_or(0) * 60
                + s.trim().parse::<i64>().unwrap_or(0)
        }
        _ => 0,
    };
    if secs <= 0 { 0 } else { secs * 1000 }
}

/// Hinnant 的 days_from_civil：公历日期 → 1970-01-01 起的天数。
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

/// RFC 2822 发布时间 → epoch ms。认不出的返回 0（按「不知道」处理，不猜）。
///
/// 只认 `Wed, 01 Nov 2025 12:00:00 +0800` 这一种主流写法（可省略星期与偏移）。
/// Atom 的 ISO 8601 也顺手支持一下：`2025-11-01T12:00:00Z`。
fn parse_published(raw: &str) -> i64 {
    parse_published_opt(raw).unwrap_or(0)
}

fn parse_published_opt(raw: &str) -> Option<i64> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    // ISO 8601：2025-11-01T12:00:00Z / +08:00
    if text.len() >= 19 && text.as_bytes().get(4) == Some(&b'-') {
        let year = text[0..4].parse::<i64>().ok()?;
        let month = text[5..7].parse::<i64>().ok()?;
        let day = text[8..10].parse::<i64>().ok()?;
        let hour = text[11..13].parse::<i64>().ok()?;
        let minute = text[14..16].parse::<i64>().ok()?;
        let second = text[17..19].parse::<i64>().ok()?;
        if year <= 0 || month <= 0 || day <= 0 {
            return None;
        }
        return Some(
            (days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second) * 1000,
        );
    }
    let parts: Vec<&str> = text.split_whitespace().collect();
    let mut idx = 0;
    // 星期几可以带逗号（`Wed,`）也可以不带（`Wed`），整个跳过
    if parts
        .first()
        .map(|s| {
            s.ends_with(',') || s.len() == 3 && !s.chars().all(|c| c.is_ascii_digit())
        })
        .unwrap_or(false)
    {
        idx = 1;
    }
    let day = parts.get(idx)?.parse::<i64>().ok()?;
    let month_name = parts.get(idx + 1)?.to_ascii_lowercase();
    let month = MONTHS
        .iter()
        .position(|m| month_name.starts_with(m))
        .map(|p| p as i64 + 1)?;
    let year = parts.get(idx + 2)?.parse::<i64>().ok()?;
    let time = parts.get(idx + 3)?;
    let clock: Vec<i64> = time.split(':').filter_map(|p| p.parse::<i64>().ok()).collect();
    if clock.len() < 2 {
        return None;
    }
    let mut offset_secs = 0i64;
    if let Some(zone) = parts.get(idx + 4) {
        offset_secs = parse_zone(zone);
    }
    let local = days_from_civil(year, month, day) * 86_400
        + clock[0] * 3600
        + clock[1] * 60
        + clock.get(2).copied().unwrap_or(0);
    Some((local - offset_secs) * 1000)
}

/// 时区：`+0800` / `-05:00` / `GMT` / `UTC`（默认 0）。
fn parse_zone(zone: &str) -> i64 {
    let z = zone.trim();
    let (sign, rest) = match z.as_bytes().first() {
        Some(b'+') => (1i64, &z[1..]),
        Some(b'-') => (-1i64, &z[1..]),
        _ => (0i64, z),
    };
    if sign == 0 {
        return 0;
    }
    let digits: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
    let (h, m) = match digits.len() {
        4 => (digits[0..2].parse::<i64>().unwrap_or(0), digits[2..4].parse::<i64>().unwrap_or(0)),
        _ => (0, 0),
    };
    sign * (h * 3600 + m * 60)
}

fn sha1_hex(text: &str) -> String {
    let mut h = Sha1::new();
    h.update(text.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// 解析一份 RSS / Atom。频道标题取不到就报错（见模块注释）。
pub fn parse_feed(xml: &str) -> Result<ParsedFeed, String> {
    if xml.trim().is_empty() {
        return Err("订阅源是空的".to_string());
    }
    // 频道信息只取第一个 `<item>` 之前的部分：条目自己的 `<title>` 更不能当频道名
    let lower = lc(xml);
    let head_end = lower.find("<item").unwrap_or(lower.len());
    let head = &xml[..head_end.min(xml.len())];
    let title = tag_text(head, "title").unwrap_or_default();
    if title.trim().is_empty() {
        return Err("这个地址不像是播客订阅源（没找到频道标题）".to_string());
    }
    let author = tag_text(head, "itunes:author")
        .or_else(|| tag_text(head, "author"))
        .filter(|s| !s.is_empty())
        .unwrap_or_default();
    let description = tag_text(head, "description")
        .or_else(|| tag_text(head, "itunes:summary"))
        .unwrap_or_default();
    let image = tag_attr(head, "itunes:image", "href")
        .or_else(|| tag_text(head, "url"))
        .filter(|s| !s.is_empty())
        .unwrap_or_default();

    let mut episodes = Vec::new();
    let mut cursor = 0usize;
    while let Some(open_rel) = lower[cursor..].find("<item") {
        let open = cursor + open_rel;
        let close = lower[open..]
            .find("</item>")
            .map(|p| open + p)
            .unwrap_or(lower.len());
        if close >= lower.len() {
            break;
        }
        let block = &xml[open..close];
        cursor = close + "</item>".len();
        let audio_url = tag_attr(block, "enclosure", "url")
            .or_else(|| tag_attr(block, "media:content", "url"))
            // Atom 的 <link rel="enclosure" href="…">
            .or_else(|| {
                let lower_block = lc(block);
                let rel_at = lower_block.find("rel=\"enclosure\"")?;
                let tail = &block[rel_at..];
                let href_at = lc(tail).find("href=\"")?;
                let rest = &tail[href_at + 6..];
                Some(decode_entities(&rest[..rest.find('"')?]))
            });
        let Some(audio_url) = audio_url.filter(|s| s.starts_with("http")) else {
            continue;
        };
        let ep_title = tag_text(block, "title").unwrap_or_else(|| "未命名单集".to_string());
        let duration_ms = tag_text(block, "itunes:duration")
            .map(|raw| parse_duration(&raw))
            .unwrap_or(0);
        let published_at = tag_text(block, "pubdate")
            .or_else(|| tag_text(block, "published"))
            .or_else(|| tag_text(block, "updated"))
            .map(|raw| parse_published(&raw))
            .unwrap_or(0);
        let description = tag_text(block, "description")
            .or_else(|| tag_text(block, "itunes:summary"))
            .or_else(|| tag_text(block, "content:encoded"))
            .unwrap_or_default();
        episodes.push(ParsedEpisode {
            title: ep_title,
            description,
            audio_url,
            duration_ms,
            published_at,
        });
    }
    if episodes.is_empty() {
        return Err("订阅源里没有可播放的单集（没找到 enclosure 地址）".to_string());
    }
    episodes.sort_by_key(|a| std::cmp::Reverse(a.published_at));
    episodes.truncate(MAX_EPISODES);
    Ok(ParsedFeed {
        title,
        author,
        description,
        image,
        episodes,
    })
}

// ---------- 网络 ----------

static CLIENT: std::sync::OnceLock<std::sync::RwLock<(u64, reqwest::Client)>> =
    std::sync::OnceLock::new();

fn client() -> reqwest::Client {
    crate::net_config::shared_async_client(&CLIENT, || {
        crate::net_config::configure(
            reqwest::Client::builder()
                .user_agent(format!("QuietMusic/{}", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS)),
        )
        .build()
        .unwrap_or_default()
    })
}

async fn fetch_feed(url: &str) -> Result<(ParsedFeed, String), String> {
    let url = normalize_url(url)?;
    let resp = client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("订阅源拉取失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("订阅源返回 HTTP {}", resp.status().as_u16()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("订阅源读取失败：{e}"))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err("订阅源太大（超过 8MB），不像是 RSS".to_string());
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok((parse_feed(&text)?, url))
}

/// 只接受 http(s)：`file://` 之类的本地路径交给播放器的「打开文件」，
/// 不该从订阅入口进（否则就是一个任意文件读取面）。
fn normalize_url(raw: &str) -> Result<String, String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err("请先填写订阅地址".to_string());
    }
    let lower = lc(url);
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("订阅地址要以 http:// 或 https:// 开头".to_string());
    }
    Ok(url.to_string())
}

// ---------- 入库 ----------

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn store_show(conn: &Connection, url: &str, feed: &ParsedFeed) -> Result<String, rusqlite::Error> {
    let id = format!("podcast:{}", sha1_hex(url));
    let now = now_ms();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO podcast_shows (id, url, title, author, description, image, last_fetched_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT(id) DO UPDATE SET
           title           = excluded.title,
           author          = excluded.author,
           description     = excluded.description,
           image           = excluded.image,
           last_fetched_at = excluded.last_fetched_at",
        params![id, url, feed.title, feed.author, feed.description, feed.image, now],
    )?;
    for ep in &feed.episodes {
        let ep_id = format!("{}:{}", id, sha1_hex(&ep.audio_url));
        // played / position_ms 不出现在 DO UPDATE 里：刷新订阅只该带来新单集
        // 与更新的元信息，绝不能把「听了一半」的进度冲掉。
        tx.execute(
            "INSERT INTO podcast_episodes
               (id, show_id, title, description, audio_url, duration_ms, published_at, played, position_ms, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0, ?8)
             ON CONFLICT(id) DO UPDATE SET
               title        = excluded.title,
               description  = excluded.description,
               duration_ms  = excluded.duration_ms,
               published_at = excluded.published_at",
            params![
                ep_id,
                id,
                ep.title,
                ep.description,
                ep.audio_url,
                ep.duration_ms,
                ep.published_at,
                now
            ],
        )?;
    }
    tx.commit()?;
    Ok(id)
}

fn show_by_id(conn: &Connection, id: &str) -> Result<PodcastShow, rusqlite::Error> {
    conn.query_row(
        "SELECT s.id, s.url, s.title, s.author, s.description, s.image, s.last_fetched_at,
                (SELECT COUNT(*) FROM podcast_episodes e WHERE e.show_id = s.id)
           FROM podcast_shows s WHERE s.id = ?1",
        params![id],
        |row| {
            Ok(PodcastShow {
                id: row.get(0)?,
                url: row.get(1)?,
                title: row.get(2)?,
                author: row.get(3)?,
                description: row.get(4)?,
                image: row.get(5)?,
                last_fetched_at: row.get(6)?,
                episode_count: row.get(7)?,
            })
        },
    )
}

fn list_shows(conn: &Connection) -> Result<Vec<PodcastShow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.url, s.title, s.author, s.description, s.image, s.last_fetched_at,
                (SELECT COUNT(*) FROM podcast_episodes e WHERE e.show_id = s.id)
           FROM podcast_shows s ORDER BY s.created_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(PodcastShow {
            id: row.get(0)?,
            url: row.get(1)?,
            title: row.get(2)?,
            author: row.get(3)?,
            description: row.get(4)?,
            image: row.get(5)?,
            last_fetched_at: row.get(6)?,
            episode_count: row.get(7)?,
        })
    })?;
    rows.collect()
}

fn list_episodes(conn: &Connection, show_id: &str) -> Result<Vec<PodcastEpisode>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, show_id, title, description, audio_url, duration_ms, published_at, played, position_ms
           FROM podcast_episodes WHERE show_id = ?1
          ORDER BY published_at DESC, created_at DESC",
    )?;
    let rows = stmt.query_map(params![show_id], |row| {
        Ok(PodcastEpisode {
            id: row.get(0)?,
            show_id: row.get(1)?,
            title: row.get(2)?,
            description: row.get(3)?,
            audio_url: row.get(4)?,
            duration_ms: row.get(5)?,
            published_at: row.get(6)?,
            played: row.get::<_, i64>(7)? != 0,
            position_ms: row.get(8)?,
        })
    })?;
    rows.collect()
}

fn save_progress(conn: &Connection, episode_id: &str, position_ms: i64, played: bool) -> Result<bool, rusqlite::Error> {
    let changed = conn.execute(
        "UPDATE podcast_episodes SET position_ms = ?2, played = ?3 WHERE id = ?1",
        params![episode_id, position_ms.max(0), i64::from(played)],
    )?;
    Ok(changed > 0)
}

fn episode_audio(conn: &Connection, episode_id: &str) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT audio_url FROM podcast_episodes WHERE id = ?1",
        params![episode_id],
        |row| row.get(0),
    )
    .optional()
}

fn remove_show(conn: &Connection, show_id: &str) -> Result<usize, rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM podcast_episodes WHERE show_id = ?1", params![show_id])?;
    let removed = tx.execute("DELETE FROM podcast_shows WHERE id = ?1", params![show_id])?;
    tx.commit()?;
    Ok(removed)
}

// ---------- 命令 ----------

#[tauri::command(rename = "list_podcast_shows")]
pub async fn cmd_list_podcast_shows(state: State<'_, AppState>) -> Result<Vec<PodcastShow>, String> {
    let db = state.db.clone().ok_or("数据库不可用")?;
    tauri::async_runtime::spawn_blocking(move || db.with(list_shows))
        .await
        .map_err(|e| format!("读取订阅失败：{e}"))?
}

#[tauri::command(rename = "add_podcast_show")]
pub async fn cmd_add_podcast_show(state: State<'_, AppState>, url: String) -> Result<PodcastShow, String> {
    let db = state.db.clone().ok_or("数据库不可用")?;
    let (feed, url) = fetch_feed(&url).await?;
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| {
            let id = store_show(conn, &url, &feed)?;
            show_by_id(conn, &id)
        })
    })
    .await
    .map_err(|e| format!("保存订阅失败：{e}"))?
}

#[tauri::command(rename = "refresh_podcast_show")]
pub async fn cmd_refresh_podcast_show(state: State<'_, AppState>, show_id: String) -> Result<PodcastShow, String> {
    let db = state.db.clone().ok_or("数据库不可用")?;
    let url = {
        let db = db.clone();
        let id = show_id.clone();
        tauri::async_runtime::spawn_blocking(move || db.with(|conn| show_by_id(conn, &id)))
            .await
            .map_err(|e| format!("读取订阅失败：{e}"))??
            .url
    };
    let (feed, url) = fetch_feed(&url).await?;
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| {
            let id = store_show(conn, &url, &feed)?;
            show_by_id(conn, &id)
        })
    })
    .await
    .map_err(|e| format!("刷新订阅失败：{e}"))?
}

#[tauri::command(rename = "remove_podcast_show")]
pub async fn cmd_remove_podcast_show(state: State<'_, AppState>, show_id: String) -> Result<usize, String> {
    let db = state.db.clone().ok_or("数据库不可用")?;
    tauri::async_runtime::spawn_blocking(move || db.with(|conn| remove_show(conn, &show_id)))
        .await
        .map_err(|e| format!("删除订阅失败：{e}"))?
}

#[tauri::command(rename = "list_podcast_episodes")]
pub async fn cmd_list_podcast_episodes(
    state: State<'_, AppState>,
    show_id: String,
) -> Result<Vec<PodcastEpisode>, String> {
    let db = state.db.clone().ok_or("数据库不可用")?;
    tauri::async_runtime::spawn_blocking(move || db.with(|conn| list_episodes(conn, &show_id)))
        .await
        .map_err(|e| format!("读取单集失败：{e}"))?
}

#[tauri::command(rename = "save_podcast_progress")]
pub async fn cmd_save_podcast_progress(
    state: State<'_, AppState>,
    episode_id: String,
    position_ms: i64,
    played: bool,
) -> Result<bool, String> {
    let db = state.db.clone().ok_or("数据库不可用")?;
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| save_progress(conn, &episode_id, position_ms, played))
    })
    .await
    .map_err(|e| format!("保存进度失败：{e}"))?
}

/// 单集的可播放地址（前端拿去组 `Track`：`platform="podcast"`、`id=audioUrl`）。
#[tauri::command(rename = "podcast_episode_audio")]
pub async fn cmd_podcast_episode_audio(
    state: State<'_, AppState>,
    episode_id: String,
) -> Result<String, String> {
    let db = state.db.clone().ok_or("数据库不可用")?;
    let found = tauri::async_runtime::spawn_blocking(move || db.with(|conn| episode_audio(conn, &episode_id)))
        .await
        .map_err(|e| format!("读取单集失败：{e}"))??;
    found.ok_or_else(|| "这一集已经不在订阅里了".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::store::tests::new_conn;

    const FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>轻声漫谈</title>
    <description>聊点慢的 &amp; 有意思的</description>
    <itunes:author>阿轻</itunes:author>
    <itunes:image href="https://img.test/cover.jpg"/>
    <item>
      <title>第 2 期：慢下来</title>
      <description><![CDATA[<p>这一期聊慢生活</p>]]></description>
      <enclosure url="https://cdn.test/ep2.mp3" type="audio/mpeg" length="12345"/>
      <itunes:duration>1:02:03</itunes:duration>
      <pubDate>Wed, 01 Nov 2025 12:00:00 +0800</pubDate>
    </item>
    <item>
      <title>第 1 期：开场</title>
      <enclosure url="https://cdn.test/ep1.mp3" type="audio/mpeg"/>
      <itunes:duration>3723</itunes:duration>
      <pubDate>Tue, 31 Oct 2025 20:30:00 GMT</pubDate>
    </item>
    <item>
      <title>没有音频的一集</title>
      <pubDate>Mon, 30 Oct 2025 10:00:00 +0800</pubDate>
    </item>
  </channel>
</rss>"#;

    #[test]
    fn parses_channel_and_skips_items_without_audio() {
        let feed = parse_feed(FEED).unwrap();
        assert_eq!(feed.title, "轻声漫谈");
        assert_eq!(feed.author, "阿轻");
        assert_eq!(feed.description, "聊点慢的 & 有意思的");
        assert_eq!(feed.image, "https://img.test/cover.jpg");
        // 第 3 条没有 enclosure，直接跳过
        assert_eq!(feed.episodes.len(), 2);
        // 按发布时间倒序
        assert_eq!(feed.episodes[0].title, "第 2 期：慢下来");
        assert_eq!(feed.episodes[0].duration_ms, 3_723_000);
        assert_eq!(feed.episodes[0].description, "这一期聊慢生活");
        assert_eq!(feed.episodes[1].duration_ms, 3_723_000);
        assert!(feed.episodes[0].published_at > feed.episodes[1].published_at);
    }

    #[test]
    fn rejects_html_and_empty_feeds() {
        assert!(parse_feed("").is_err());
        assert!(parse_feed("<html><body>404</body></html>").is_err());
        // 有标题但没有单集：也当不可用
        assert!(parse_feed("<rss><channel><title>空播客</title></channel></rss>").is_err());
    }

    #[test]
    fn duration_and_date_variants() {
        assert_eq!(parse_duration("01:02:03"), 3_723_000);
        assert_eq!(parse_duration("62:03"), 3_723_000);
        assert_eq!(parse_duration("3723"), 3_723_000);
        assert_eq!(parse_duration(""), 0);
        assert_eq!(parse_duration("不是数字"), 0);

        // 2025-11-01T04:00:00Z == 2025-11-01 12:00:00+08:00
        let utc = parse_published("2025-11-01T04:00:00Z");
        let cst = parse_published("Sat, 01 Nov 2025 12:00:00 +0800");
        assert_eq!(utc, cst);
        assert_eq!(parse_published("Tue, 31 Oct 2025 20:30:00 GMT"), parse_published("2025-10-31T20:30:00Z"));
        assert_eq!(parse_published(""), 0);
    }

    #[test]
    fn only_http_urls_are_accepted() {
        assert!(normalize_url(" https://a.test/f.xml ").is_ok());
        assert!(normalize_url("file:///c:/secret.xml").is_err());
        assert!(normalize_url("").is_err());
    }

    fn sample_feed() -> ParsedFeed {
        parse_feed(FEED).unwrap()
    }

    #[test]
    fn storing_twice_keeps_progress_and_updates_titles() {
        let conn = new_conn();
        let id = store_show(&conn, "https://a.test/f.xml", &sample_feed()).unwrap();
        let shows = list_shows(&conn).unwrap();
        assert_eq!(shows.len(), 1);
        assert_eq!(shows[0].episode_count, 2);

        let episodes = list_episodes(&conn, &id).unwrap();
        assert_eq!(episodes.len(), 2);
        assert!(!episodes[0].played);
        assert_eq!(episodes[0].position_ms, 0);

        // 听了一半
        assert!(save_progress(&conn, &episodes[0].id, 65_432, false).unwrap());
        assert!(save_progress(&conn, &episodes[1].id, 3_000, true).unwrap());

        // 刷新：标题变了，进度不能被冲掉
        let mut refreshed = sample_feed();
        refreshed.episodes[0].title = "第 2 期：慢下来（重制）".to_string();
        store_show(&conn, "https://a.test/f.xml", &refreshed).unwrap();

        let episodes = list_episodes(&conn, &id).unwrap();
        assert_eq!(episodes[0].title, "第 2 期：慢下来（重制）");
        assert_eq!(episodes[0].position_ms, 65_432);
        assert!(!episodes[0].played);
        assert!(episodes[1].played);
        assert_eq!(list_shows(&conn).unwrap().len(), 1, "刷新不该多出一条订阅");
    }

    #[test]
    fn removing_a_show_takes_its_episodes() {
        let conn = new_conn();
        let id = store_show(&conn, "https://a.test/f.xml", &sample_feed()).unwrap();
        assert_eq!(remove_show(&conn, &id).unwrap(), 1);
        assert!(list_shows(&conn).unwrap().is_empty());
        assert!(list_episodes(&conn, &id).unwrap().is_empty());
        // 同一地址重新订阅还能回来（id 由 url 哈希决定，稳定）
        let again = store_show(&conn, "https://a.test/f.xml", &sample_feed()).unwrap();
        assert_eq!(again, id);
    }

    #[test]
    fn episode_audio_lookup_reports_missing() {
        let conn = new_conn();
        let id = store_show(&conn, "https://a.test/f.xml", &sample_feed()).unwrap();
        let episodes = list_episodes(&conn, &id).unwrap();
        assert_eq!(
            episode_audio(&conn, &episodes[0].id).unwrap().as_deref(),
            Some("https://cdn.test/ep2.mp3")
        );
        assert_eq!(episode_audio(&conn, "podcast:nope").unwrap(), None);
    }
}
