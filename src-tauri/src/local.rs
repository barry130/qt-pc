//! 本地音乐库：目录扫描、音频元数据读取与入库（DESIGN §13）。
//!
//! - §13.1 扫描流程：遍历目录 → 过滤支持的音频格式 → 读取元数据 → 写入 SQLite。
//! - §13.2 增量扫描：本次命中的文件 `missing = 0`；扫描目录范围内未命中的旧记录 `missing = 1`。
//! - 元数据读不到时降级为「文件名解析」（`歌手 - 标题`），时长取不到记 0。
//!
//! ## 关键约定
//! 本地曲目的 `Track.id` 就是音频文件的**绝对路径字符串**，`platform = SourceId::Local`，
//! 因此 db 主键为 `local:<绝对路径>`（见 `db::store::db_track_id`）；播放时
//! `audio::engine` 已特判 Local——直接把 `id` 当文件路径解码。
//! `pic_url` 恒为空串、`music_id` 恒为 None（本地文件不参与在线封面/取址链路）。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::{
    MetadataOptions, MetadataRevision, StandardTagKey, StandardVisualKey, Value,
};
use symphonia::core::probe::Hint;

use crate::db::store::LocalTrackRow;

/// 支持的音频扩展名（§13.1「过滤支持的音频格式」），比较时大小写不敏感。
///
/// 2026-10-18 扩充：解码后端（symphonia，被 rodio 的 `symphonia-all` 拉满特性）本来
/// 就覆盖 alac / aiff / caf / mkv / pcm / adpcm / mp1 / mp2，是这份清单把
/// `.aiff` `.aif` `.caf` `.mka` `.mp1` `.mp2` `.oga` 挡在了库外——扫描时直接丢掉，
/// 与解码能力无关。补上它们不需要动依赖。
///
/// APE / WMA / DSD / Opus 仍然不支持，且**不是扩展名的问题**：symphonia 0.5.5 的
/// `all-codecs` 里没有这几个解码器，要支持必须另立解码后端。
pub const SUPPORTED_EXTS: [&str; 13] = [
    "mp3", "flac", "wav", "ogg", "oga", "m4a", "aac", "aiff", "aif", "caf", "mka", "mp1", "mp2",
];

/// 文件名降级解析的分隔符：常见命名习惯 `歌手 - 标题`。
const FILENAME_SEPARATOR: &str = " - ";

/// 单个音频文件的标签元数据（读不到或缺失的字段为 None）。
#[derive(Debug, Default, Clone)]
pub struct FileMeta {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// 秒；取不到时为 0.0
    pub duration_secs: f64,
    /// 内嵌歌词正文（ID3v2 USLT / Vorbis `LYRICS` / `UNSYNCEDLYRICS`），取不到为 None。
    pub lyrics: Option<String>,
}

/// 判断是否为受支持的音频文件（按扩展名，大小写不敏感）。
pub fn is_audio_file(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => SUPPORTED_EXTS
            .iter()
            .any(|known| known.eq_ignore_ascii_case(ext)),
        None => false,
    }
}

/// 文件名（不含扩展名）降级解析：按 `" - "` 分割，第 0 段作歌手、其余作标题；
/// 没有分隔符则整段作标题、歌手留空。返回 `(singer, title)`。
pub fn parse_file_stem(stem: &str) -> (String, String) {
    match stem.split_once(FILENAME_SEPARATOR) {
        Some((singer, title)) => (singer.trim().to_string(), title.trim().to_string()),
        None => (String::new(), stem.trim().to_string()),
    }
}

/// 扫描进度事件名（整盘扫描可能上万文件，前端据此显示进度）。
pub const EVENT_LIBRARY_SCAN_PROGRESS: &str = "library-scan-progress";

/// 递归遍历时跳过的目录名（大小写不敏感）。整盘扫描遇到这些目录既不会有音乐，
/// 又往往极大或有权限问题，跳过可显著提速并避免噪声。
///
/// 刻意**不**跳过 `target` / `build` / `dist` 这类通用词——它们有可能被用户
/// 用来存放音乐（下载目录也常在 `target` 下），宁可多走几层也不误伤。
///
/// 跨平台补充（Linux/macOS）：按目录名匹配，无法区分「/proc」与用户自建的
/// 「~/Music/proc」——用宽泛词名换实现简单，音乐目录极少与系统目录同名，可接受。
const SKIP_DIR_NAMES: &[&str] = &[
    // 系统 / 权限受限目录（Windows）
    "$recycle.bin",
    "system volume information",
    "$winreagent",
    "$sysreset",
    "$windows.~bt",
    "$windows.~ws",
    "recovery",
    "perflogs",
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
    "appdata",
    // 版本控制 / 依赖缓存（不会有音乐，却可能有海量小文件）
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    ".cargo",
    ".cargo-home",
    ".gradle",
    ".m2",
    ".nuget",
    ".npm",
    ".pnpm-store",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    ".tox",
    ".next",
    // Linux：/proc /sys /dev /run /boot /snap /flatpak —— 伪文件系统递归
    // 无意义且可能极慢（/proc 尤甚），设备与运行态目录没有音乐。
    "proc",
    "procfs",
    "sys",
    "dev",
    "run",
    "boot",
    "lost+found",
    "snap",
    "flatpak",
    // macOS：/System /Library /private /Applications /cores 与卷元数据目录。
    // "library" 也会跳过用户目录下的同名文件夹，同上可接受。
    "system",
    "library",
    "private",
    "applications",
    "cores",
    ".trash",
    ".spotlight-v100",
    ".fseventsd",
    ".temporaryitems",
];

/// 递归深度上限：防御 junction / symlink 造成的异常层级或环。
const MAX_DEPTH: usize = 64;

/// 该目录名是否在跳过清单中（大小写不敏感）。
fn should_skip_dir(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SKIP_DIR_NAMES.contains(&lower.as_str())
}

/// 递归收集目录下的音频文件（§13.1）。
/// 无法读取的目录（权限不足 / 已失效的链接等）直接跳过，不中断整次扫描。
pub fn collect_audio_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut noop = |_: &Path| {};
    collect_into(root, &mut out, 0, &mut noop);
    out.retain(|path| is_audio_file(path));
    out
}

/// 递归实现。`on_entry` 每访问一个目录条目回调一次（整盘扫描的进度用）。
fn collect_into(dir: &Path, out: &mut Vec<PathBuf>, depth: usize, on_entry: &mut dyn FnMut(&Path)) {
    if depth > MAX_DEPTH {
        log::warn!(
            "[local] 目录层级超过 {MAX_DEPTH}，已停止深入: {}",
            dir.display()
        );
        return;
    }
    // 目录读不了（权限 / 被删除 / 设备未就绪）→ 记日志并跳过，不让扫描整体失败
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            log::debug!("[local] 目录读取失败，已跳过 {}: {e}", dir.display());
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // file_type() 不跟随链接：junction / symlink 一律跳过。整盘扫描时
        // Windows 的「All Users」这类联接会导致重复遍历甚至成环。
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if should_skip_dir(&entry.file_name().to_string_lossy()) {
                continue;
            }
            collect_into(&path, out, depth + 1, on_entry);
        } else if file_type.is_file() {
            on_entry(&path);
            if is_audio_file(&path) || crate::cue::is_cue_file(&path) {
                out.push(path);
            }
        }
    }
}

/// 扫描过滤条件。两个阈值都为 0 时不过滤，与前端「扫描配置」语义一致。
#[derive(Debug, Clone, Copy, Default)]
pub struct ScanFilter {
    /// 时长下限（秒）：已知时长且不高于该值的音频跳过
    pub min_duration_secs: u64,
    /// 体积下限（字节）：文件小于该值的跳过
    pub min_size_bytes: u64,
}

/// 扫描若干目录，产出入库行（不触碰数据库，便于单测）。
/// 目录不存在时静默跳过；同一路径只会产出一条（多目录重叠时去重）。
pub fn scan_dirs(dirs: &[String]) -> Vec<LocalTrackRow> {
    scan_dirs_with_progress(dirs, ScanFilter::default(), |_, _, _| {})
}

/// 时长过滤：仅当**时长已知**（`> 0`）且不高于阈值时判为过短。
/// 时长读不到的（0，通常是元数据解析失败的正常歌曲）一律保留，避免误伤。
pub fn is_too_short(row: &LocalTrackRow, min_duration_secs: u64) -> bool {
    min_duration_secs > 0
        && row.duration_ms > 0
        && row.duration_ms <= (min_duration_secs as i64) * 1000
}

/// 体积过滤：仅当文件存在且读得到大小时才比较，小于阈值判为过小。
/// 读不到大小的（权限 / 竞态删除）一律保留，与时长过滤同一口径。
pub fn is_too_small(path: &Path, min_size_bytes: u64) -> bool {
    min_size_bytes > 0
        && std::fs::metadata(path)
            .map(|m| m.len() < min_size_bytes)
            .unwrap_or(false)
}

/// 带进度与时长 / 体积过滤的扫描。
///
/// `filter.min_duration_secs > 0` 时丢弃时长不足该值的音频（用于整盘扫描时滤掉
/// 系统提示音、测试样本这类短文件）；`filter.min_size_bytes > 0` 时丢弃小于该
/// 体积的文件（滤掉广告音效、空壳文件）。两者为 0 均表示不过滤。
/// `on_progress(已访问条目数, 命中音频数, 当前路径)`，进度按目录条目回调（含非音频）。
pub fn scan_dirs_with_progress(
    dirs: &[String],
    filter: ScanFilter,
    mut on_progress: impl FnMut(usize, usize, &Path),
) -> Vec<LocalTrackRow> {
    let mut files = Vec::new();
    let mut visited = 0usize;
    let mut found = 0usize;
    for dir in dirs {
        let root = Path::new(dir);
        if !root.exists() {
            log::warn!("[local] 目录不存在，已跳过: {dir}");
            continue;
        }
        let mut tick = |path: &Path| {
            visited += 1;
            if is_audio_file(path) {
                found += 1;
            }
            on_progress(visited, found, path);
        };
        if root.is_file() {
            tick(root);
            if is_audio_file(root) || crate::cue::is_cue_file(root) {
                files.push(root.to_owned());
            }
        } else {
            collect_into(root, &mut files, 0, &mut tick);
        }
    }
    files.sort();
    let mut rows = build_scan_rows(&files, filter);
    rows.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then(a.start_ms.cmp(&b.start_ms))
            .then(a.id.cmp(&b.id))
    });
    rows
}

/// 可扫描的盘符根目录（Windows 枚举 A:–Z: 中真实存在的盘；macOS 枚举
/// `/Volumes` 下的挂载卷 + 根；Linux 给出根目录 + 用户家目录）。
/// 用于本地曲库的「扫描整个磁盘」入口。
#[cfg(target_os = "windows")]
pub fn list_drives() -> Vec<String> {
    ('A'..='Z')
        .map(|c| format!("{c}:\\"))
        .filter(|root| Path::new(root).exists())
        .collect()
}

/// macOS：`/` + `/Volumes/*`（外接盘 / U 盘 / DMG 都挂在这里）。
#[cfg(target_os = "macos")]
pub fn list_drives() -> Vec<String> {
    let mut roots = vec!["/".to_string()];
    if let Ok(entries) = std::fs::read_dir("/Volumes") {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                let vol = format!("/Volumes/{name}");
                if Path::new(&vol).is_dir() {
                    roots.push(vol);
                }
            }
        }
    }
    roots
}

/// Linux：根目录 + `$HOME`（音乐几乎总在家目录；/proc/mounts 解析留待后续按需）。
#[cfg(target_os = "linux")]
pub fn list_drives() -> Vec<String> {
    let mut roots = vec!["/".to_string()];
    if let Some(home) = std::env::var_os("HOME") {
        let home = home.to_string_lossy().to_string();
        if !home.is_empty() && !roots.contains(&home) {
            roots.push(home);
        }
    }
    roots
}

/// 组装入库行：优先 symphonia 元数据，缺失字段回落到文件名解析。
fn build_row(path: &Path, path_str: String) -> LocalTrackRow {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let (fallback_singer, fallback_title) = parse_file_stem(stem);
    let (title, singer, album, duration_secs, embedded_lyric) = match read_metadata(path) {
        Some(m) => (
            non_empty(m.title).unwrap_or(fallback_title),
            non_empty(m.artist).unwrap_or(fallback_singer),
            non_empty(m.album).unwrap_or_default(),
            m.duration_secs,
            non_empty(m.lyrics),
        ),
        None => (fallback_title, fallback_singer, String::new(), 0.0, None),
    };
    let (file_size, mtime) = file_stats(path);
    LocalTrackRow {
        id: path_str.clone(),
        path: path_str,
        cue_path: None,
        start_ms: None,
        end_ms: None,
        title,
        singer,
        album,
        duration_ms: (duration_secs * 1000.0) as i64,
        file_size,
        mtime,
        format: extension_of(path),
        embedded_lyric,
    }
}

/// 读取容器/标签元数据（§13.1「读取元数据」）。文件打不开或格式不支持时返回 None，
/// 由调用方降级到文件名解析。
pub fn read_metadata(path: &Path) -> Option<FileMeta> {
    let file = std::fs::File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let mut probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .ok()?;

    // 时长：取所有音轨里最长的（多轨容器取主轨）
    let duration_secs = probed
        .format
        .tracks()
        .iter()
        .filter_map(|t| {
            let time_base = t.codec_params.time_base?;
            let frames = t.codec_params.n_frames?;
            let time = time_base.calc_time(frames);
            Some(time.seconds as f64 + time.frac)
        })
        .fold(0.0_f64, f64::max);

    let mut meta = FileMeta {
        duration_secs,
        ..FileMeta::default()
    };
    // 容器外挂标签（如 MP3 的 ID3v2）
    if let Some(mut md) = probed.metadata.get() {
        if let Some(rev) = md.skip_to_latest() {
            pick_tags(rev, &mut meta);
        }
    }
    // 容器内建标签（如 FLAC / OGG 的 Vorbis Comments）
    {
        let mut md = probed.format.metadata();
        if let Some(rev) = md.skip_to_latest() {
            pick_tags(rev, &mut meta);
        }
    }
    Some(meta)
}

/// 从一版标签里挑出标题 / 歌手 / 专辑（首次命中优先，后续不覆盖）。
/// `AlbumArtist` 仅在 `Artist` 缺失时作为歌手兜底。
fn pick_tags(rev: &MetadataRevision, meta: &mut FileMeta) {
    for tag in rev.tags() {
        let Some(value) = non_empty(tag_string(&tag.value)) else {
            continue;
        };
        match tag.std_key {
            Some(StandardTagKey::TrackTitle) => {
                meta.title.get_or_insert(value);
            }
            Some(StandardTagKey::Artist) => {
                meta.artist.get_or_insert(value);
            }
            Some(StandardTagKey::AlbumArtist) => {
                if meta.artist.is_none() {
                    meta.artist = Some(value);
                }
            }
            Some(StandardTagKey::Album) => {
                meta.album.get_or_insert(value);
            }
            // 内嵌歌词：symphonia 把 ID3v2 的 USLT 与 Vorbis 的 LYRICS /
            // UNSYNCEDLYRICS 都归到 `Lyrics`（symphonia-metadata 的 id3v2/frames.rs
            // 与 vorbis.rs 各有一条映射），这里不必自己解析标签帧。
            Some(StandardTagKey::Lyrics) => {
                meta.lyrics.get_or_insert(value);
            }
            _ => {}
        }
    }
}

/// 读取内嵌封面（ID3v2 APIC / FLAC PICTURE / Vorbis METADATA_BLOCK_PICTURE）。
/// 优先 FrontCover，否则取第一张图片。返回 `(mime, 原始字节)`。
/// 读不到封面不是错误：本地曲目本来就可能没有封面，返回 None。
pub fn read_cover(path: &Path) -> Option<(String, Vec<u8>)> {
    let file = std::fs::File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let mut probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .ok()?;

    let mut best: Option<(String, Vec<u8>)> = None;
    if let Some(mut md) = probed.metadata.get() {
        if let Some(rev) = md.skip_to_latest() {
            pick_cover(rev, &mut best);
        }
    }
    {
        let mut md = probed.format.metadata();
        if let Some(rev) = md.skip_to_latest() {
            pick_cover(rev, &mut best);
        }
    }
    best
}

/// 从一版元数据里挑封面：先到先得，但遇到 FrontCover 会覆盖前者并立即收工。
fn pick_cover(rev: &MetadataRevision, best: &mut Option<(String, Vec<u8>)>) {
    for v in rev.visuals() {
        if !v.media_type.starts_with("image/") {
            continue;
        }
        let is_front = matches!(v.usage, Some(StandardVisualKey::FrontCover));
        if best.is_none() || is_front {
            *best = Some((v.media_type.clone(), v.data.to_vec()));
            if is_front {
                return;
            }
        }
    }
}

// ---------- 本地歌词：同名 .lrc / 内嵌标签（2026-10-18） ----------
//
// 背景：本地曲目此前**只能**靠酷我匹配拿词（前端 `localOnline.ts` 的
// `resolveLocalOnlineMeta`），离线或冷门歌就整页空白 —— 而用户自己放在音频旁边的
// `.lrc`、以及文件里本来就内嵌的歌词，一直都在那里，只是没人读。
// 这里补上「从本地文件取词」：同名 `.lrc` 优先，其次内嵌标签。取到的词由
// `library_scan` 落进 `lyrics` 表（source 记 `local-lrc` / `local-tag`），
// 于是离线也有词，而且走的是与在线词同一条回读链路。

/// 落库时写进 `lyrics.source`：词来自同名 `.lrc` 旁挂文件。
pub const LYRIC_SOURCE_SIDECAR: &str = "local-lrc";
/// 落库时写进 `lyrics.source`：词来自音频文件的内嵌标签。
pub const LYRIC_SOURCE_EMBEDDED: &str = "local-tag";

/// 一份本地歌词正文与它的出处。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalLyric {
    pub text: String,
    /// `LYRIC_SOURCE_SIDECAR` 或 `LYRIC_SOURCE_EMBEDDED`
    pub source: &'static str,
    /// 旁挂 `.lrc` 的路径（内嵌歌词为 None），落到 `lyric_settings.lyric_path`
    pub path: Option<String>,
}

/// 找与音频同名的 `.lrc` 旁挂文件。扩展名与主名都按大小写不敏感比较：Windows/macOS
/// 的文件系统本就不区分大小写，音乐库里 `.LRC` 与 `.lrc` 混用很常见。
/// 目录不可读、没有同名文件都返回 None（不是错误）。
pub fn find_lrc_sidecar(path: &Path) -> Option<PathBuf> {
    let stem = path.file_stem().and_then(|s| s.to_str())?;
    let dir = path.parent()?;
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path();
        if !candidate.is_file() {
            continue;
        }
        let Some(ext) = candidate.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if !ext.eq_ignore_ascii_case("lrc") {
            continue;
        }
        let same_stem = candidate
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case(stem));
        if same_stem {
            return Some(candidate);
        }
    }
    None
}

/// 解码歌词文本：UTF-8（含 BOM）优先，失败按 GB18030 兜底。
///
/// 中文曲库里的 `.lrc` 有相当一部分是 GBK/GB18030 编的，直接 `read_to_string`
/// 会整份读不出来（InvalidData），表现就是「明明有 .lrc 却没词」。
/// GB18030 是 GBK/GB2312 的超集，用它兜底能覆盖这类老文件。
fn decode_lyric_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => encoding_rs::GB18030.decode(bytes).0.into_owned(),
    }
}

/// 读同名 `.lrc` 正文。文件不存在 / 读不出来 / 正文全空白都返回 None。
fn read_sidecar_lyric(path: &Path) -> Option<LocalLyric> {
    let lrc = find_lrc_sidecar(path)?;
    let bytes = std::fs::read(&lrc).ok()?;
    let text = decode_lyric_text(&bytes);
    if text.trim().is_empty() {
        return None;
    }
    Some(LocalLyric {
        text,
        source: LYRIC_SOURCE_SIDECAR,
        path: Some(lrc.to_string_lossy().into_owned()),
    })
}

/// 读内嵌歌词。复用 `read_metadata`（它已经把标签读出来了），不重复实现探测。
pub fn read_embedded_lyric(path: &Path) -> Option<String> {
    let text = read_metadata(path)?.lyrics?;
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// 本地取词（按需，播放时兜底用）：同名 `.lrc` 优先，其次内嵌标签。
pub fn read_local_lyric(path: &Path) -> Option<LocalLyric> {
    if path
        .to_str()
        .is_some_and(|id| crate::cue::strip_cue_suffix(id) != id)
    {
        return None;
    }
    read_sidecar_lyric(path).or_else(|| {
        read_embedded_lyric(path).map(|text| LocalLyric {
            text,
            source: LYRIC_SOURCE_EMBEDDED,
            path: None,
        })
    })
}

/// 扫描落库用：内嵌歌词在扫描时已经读出来了（`LocalTrackRow.embedded_lyric`），
/// 传进来免得为同一个文件再开一次容器；旁挂 `.lrc` 仍按需读盘。
pub fn resolve_local_lyric(path: &Path, embedded: Option<&str>) -> Option<LocalLyric> {
    if path
        .to_str()
        .is_some_and(|id| crate::cue::strip_cue_suffix(id) != id)
    {
        return None;
    }
    read_sidecar_lyric(path).or_else(|| {
        let text = embedded.map(str::trim).filter(|t| !t.is_empty())?;
        Some(LocalLyric {
            text: text.to_string(),
            source: LYRIC_SOURCE_EMBEDDED,
            path: None,
        })
    })
}

/// 标签值转字符串；二进制等不可展示的类型直接丢弃。
fn tag_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Flag | Value::Binary(_) => None,
        other => Some(other.to_string()),
    }
}

/// 去掉空串与纯空白。
fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.trim().is_empty())
}

/// 扩展名（小写、不含点）；取不到返回空串。
fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_lowercase()
}

/// 文件大小（字节）与修改时间（epoch 秒），取不到记 0（§13.2 增量依据）。
fn file_stats(path: &Path) -> (i64, i64) {
    match path.metadata() {
        Ok(md) => {
            let size = md.len() as i64;
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            (size, mtime)
        }
        Err(_) => (0, 0),
    }
}

/// 按用户**显式指定的条目**产出入库行：拖拽入窗 / 命令行参数 / 第二实例转发共用。
///
/// 与 `scan_dirs` 的三点差别都是有意的：
/// 1. 文件与文件夹混着收 —— 拖进来的常常就是单个 `.flac`，不该要求用户先建扫描目录；
/// 2. **保留入参顺序** —— 拖一串文件时的松手顺序就是用户期望的播放顺序，
///    目录遍历顺序做不到这一点；
/// 3. **不套用扫描阈值**（时长 / 体积）—— 那两个阈值是「整盘扫描别把提示音收进来」
///    用的；这里是用户点名要播的文件，再拿默认 60 秒去滤会表现为「拖进去没反应」。
///
/// 返回 `(行, 被跳过的入参)`。被跳过的是不存在 / 扩展名不支持的条目，以及里面
/// 一个音频都没有的文件夹 —— 调用方据此提示「N 个条目没打开」，而不是安静地什么都不做。
pub fn scan_files(paths: &[String]) -> (Vec<LocalTrackRow>, Vec<String>) {
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut groups = Vec::new();
    for raw in paths {
        let path = Path::new(raw);
        let mut group = Vec::new();
        if path.is_dir() {
            collect_into(path, &mut group, 0, &mut |_| {});
            group.sort();
        } else if path.is_file() && (is_audio_file(path) || crate::cue::is_cue_file(path)) {
            group.push(path.to_owned());
        }
        if group.is_empty() {
            skipped.push(raw.clone());
        } else {
            groups.push((raw, group.clone()));
            files.extend(group);
        }
    }
    let rows = build_scan_rows(&files, ScanFilter::default());
    for (raw, group) in groups {
        if !group.iter().any(|p| {
            let key = path_key(&absolute_path(p));
            rows.iter().any(|r| {
                path_key(Path::new(&r.path)) == key
                    || r.cue_path
                        .as_ref()
                        .is_some_and(|c| path_key(Path::new(c)) == key)
            })
        }) {
            skipped.push(raw.clone());
        }
    }
    (rows, skipped)
}

/// Resolve relative components without adding Windows' verbatim-path prefix.
fn absolute_path(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_owned());
    let mut result = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        text.replace('\\', "/").to_lowercase()
    } else {
        text
    }
}

/// CUE sheets are resolved before any whole-file row, even if the caller lists
/// the audio first or scans overlapping roots. Metadata is probed once per file.
fn build_scan_rows(files: &[PathBuf], filter: ScanFilter) -> Vec<LocalTrackRow> {
    let files: Vec<PathBuf> = files.iter().map(|p| absolute_path(p)).collect();
    let mut metadata: HashMap<String, LocalTrackRow> = HashMap::new();
    let mut cue_rows: HashMap<String, Vec<LocalTrackRow>> = HashMap::new();
    let mut covered = HashSet::new();
    for cue in files.iter().filter(|p| crate::cue::is_cue_file(p)) {
        let cue_key = path_key(cue);
        if cue_rows.contains_key(&cue_key) {
            continue;
        }
        let tracks = match crate::cue::read_cue(cue) {
            Ok(tracks) => tracks,
            Err(error) => {
                log::warn!("[local] CUE skipped: {error}");
                continue;
            }
        };
        let mut children = Vec::new();
        for track in tracks {
            let path = absolute_path(&track.path);
            if is_too_small(&path, filter.min_size_bytes) {
                continue;
            }
            let key = path_key(&path);
            let Some(path_str) = path.to_str().map(str::to_owned) else {
                continue;
            };
            let original = metadata
                .entry(key.clone())
                .or_insert_with(|| build_row(&path, path_str));
            let duration = u64::try_from(original.duration_ms).ok().filter(|d| *d > 0);
            if duration.is_some_and(|d| track.start_ms >= d) {
                continue;
            }
            // A boundary beyond EOF cannot create an interval beyond the file.
            let end_ms = match (track.end_ms, duration) {
                (Some(end), Some(duration)) => Some(end.min(duration)),
                (end, duration) => end.or(duration),
            };
            if end_ms.is_some_and(|end| end <= track.start_ms || end > i64::MAX as u64)
                || track.start_ms > i64::MAX as u64
            {
                continue;
            }
            let mut row = original.clone();
            row.id = format!("{}#cue:{}", row.path, track.number);
            row.cue_path = cue.to_str().map(str::to_owned);
            row.start_ms = Some(track.start_ms);
            row.end_ms = end_ms;
            row.duration_ms = end_ms.map(|end| (end - track.start_ms) as i64).unwrap_or(0);
            if let Some(title) = track.title {
                row.title = title;
            }
            if let Some(singer) = track.performer {
                row.singer = singer;
            }
            if let Some(album) = track.album {
                row.album = album;
            }
            // Album-level embedded/sidecar lyrics cannot be reused without retiming.
            row.embedded_lyric = None;
            covered.insert(key);
            if !is_too_short(&row, filter.min_duration_secs) {
                children.push(row);
            }
        }
        cue_rows.insert(cue_key, children);
    }
    let mut rows = Vec::new();
    let mut seen = HashSet::new();
    for file in &files {
        let key = path_key(file);
        if crate::cue::is_cue_file(file) {
            if let Some(children) = cue_rows.remove(&key) {
                for row in children {
                    if seen.insert(path_key(Path::new(&row.id))) {
                        rows.push(row);
                    }
                }
            }
        } else if is_audio_file(file)
            && !covered.contains(&key)
            && !is_too_small(file, filter.min_size_bytes)
        {
            let Some(path) = file.to_str().map(str::to_owned) else {
                continue;
            };
            let row = metadata.entry(key).or_insert_with(|| build_row(file, path));
            if !is_too_short(row, filter.min_duration_secs)
                && seen.insert(path_key(Path::new(&row.id)))
            {
                rows.push(row.clone());
            }
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;
    use crate::db::store::{
        add_scan_dir, delete_local_track, delete_local_tracks, list_scan_dirs,
        mark_missing_local_tracks, query_local_tracks, remove_scan_dir, upsert_local_tracks,
    };
    use rusqlite::Connection;

    /// 建一个进程唯一的临时目录（不联网、不依赖真实音乐目录）
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "quietmusic-local-{tag}-{}-{}",
            std::process::id(),
            fastrand::u64(..)
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn touch(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::create_dir_all(p.parent().unwrap()).expect("创建父目录");
        std::fs::write(&p, b"not-a-real-audio-file").expect("写入临时文件");
        p
    }

    fn wav(dir: &Path, name: &str, seconds: u32) -> PathBuf {
        let path = dir.join(name);
        let size = seconds * 8_000;
        let mut bytes = Vec::with_capacity(size as usize + 44);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes()); // PCM
        bytes.extend_from_slice(&1_u16.to_le_bytes()); // mono
        bytes.extend_from_slice(&8_000_u32.to_le_bytes());
        bytes.extend_from_slice(&8_000_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&8_u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&size.to_le_bytes());
        bytes.resize(size as usize + 44, 128);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn cue_scan_splits_real_audio_and_final_track_uses_metadata() {
        let root = temp_dir("cue-split");
        let audio = wav(&root, "album.wav", 12);
        let cue = root.join("album.cue");
        std::fs::write(&cue, "PERFORMER \"Artist\"\nTITLE \"Album\"\nFILE \"album.wav\" WAVE\nTRACK 01 AUDIO\nTITLE \"First\"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE \"Second\"\nINDEX 01 00:05:00\nTRACK 03 AUDIO\nINDEX 01 00:20:00").unwrap();
        std::fs::write(root.join("album.lrc"), "[00:08.00]album lyric").unwrap();
        let dirs = [root.to_string_lossy().into_owned()];
        let rows = scan_dirs(&dirs);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, format!("{}#cue:1", audio.display()));
        assert_eq!(rows[1].id, format!("{}#cue:2", audio.display()));
        assert!(rows.iter().all(|r| Path::new(&r.path) == audio));
        assert!(read_local_lyric(Path::new(&rows[0].id)).is_none());
        assert!(
            resolve_local_lyric(Path::new(&rows[1].id), Some("[00:08.00]album lyric")).is_none()
        );
        assert_eq!(rows[0].title, "First");
        assert_eq!(rows[0].singer, "Artist");
        assert_eq!(rows[0].album, "Album");
        assert_eq!(
            (rows[0].start_ms, rows[0].end_ms, rows[0].duration_ms),
            (Some(0), Some(5_000), 5_000)
        );
        assert_eq!(
            (rows[1].start_ms, rows[1].end_ms, rows[1].duration_ms),
            (Some(5_000), Some(12_000), 7_000)
        );
        let conn = test_conn();
        upsert_local_tracks(&conn, &rows).unwrap();
        assert_eq!(crate::library_scan::persist_local_lyrics(&conn, &rows), 0);
        let lyric_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM lyrics", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            lyric_count, 0,
            "CUE must not inherit an unshifted album LRC"
        );
        let (opened, skipped) = scan_files(&[
            audio.to_string_lossy().into_owned(),
            cue.to_string_lossy().into_owned(),
        ]);
        assert!(skipped.is_empty());
        assert_eq!(
            opened.iter().map(|r| &r.id).collect::<Vec<_>>(),
            rows.iter().map(|r| &r.id).collect::<Vec<_>>()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn cue_scan_handles_multi_file_missing_and_non_audio_references() {
        let root = temp_dir("cue-multi");
        wav(&root, "one.wav", 8);
        wav(&root, "two.wav", 6);
        touch(&root, "picture.jpg");
        let cue = root.join("album.CUE");
        std::fs::write(&cue, "FILE \"one.wav\" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:01:00\nFILE \"missing.wav\" WAVE\nTRACK 02 AUDIO\nINDEX 01 00:00:00\nFILE \"picture.jpg\" WAVE\nTRACK 03 AUDIO\nINDEX 01 00:00:00\nFILE \"two.wav\" WAVE\nTRACK 04 AUDIO\nINDEX 01 00:00:00").unwrap();
        let (rows, skipped) = scan_files(&[cue.to_string_lossy().into_owned()]);
        assert!(skipped.is_empty());
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].duration_ms, rows[1].duration_ms), (7_000, 6_000));
        assert!(rows[0].id.ends_with("#cue:1"));
        assert!(rows[1].id.ends_with("#cue:4"));
        std::fs::remove_file(root.join("one.wav")).unwrap();
        std::fs::remove_file(root.join("two.wav")).unwrap();
        let (empty, skipped) = scan_files(&[cue.to_string_lossy().into_owned()]);
        assert!(empty.is_empty());
        assert_eq!(skipped, vec![cue.to_string_lossy().into_owned()]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn cue_repeated_rescans_retire_album_and_removed_children() {
        let conn = test_conn();
        let root = temp_dir("cue-rescan");
        let audio = wav(&root, "album.wav", 12);
        let dirs = [root.to_string_lossy().into_owned()];
        upsert_local_tracks(&conn, &scan_dirs(&dirs)).unwrap();
        assert_eq!(query_local_tracks(&conn).unwrap().len(), 1);
        let cue = root.join("album.cue");
        let sheet = "FILE \"album.wav\" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 00:05:00";
        std::fs::write(&cue, sheet).unwrap();
        for _ in 0..2 {
            let rows = scan_dirs(&dirs);
            let present = rows.iter().map(|r| r.id.clone()).collect();
            upsert_local_tracks(&conn, &rows).unwrap();
            mark_missing_local_tracks(&conn, &dirs, &present).unwrap();
            let tracks = query_local_tracks(&conn).unwrap();
            assert_eq!(tracks.len(), 2);
            assert!(tracks.iter().all(|t| t.start_ms.is_some()));
            assert!(tracks.iter().all(|t| t.end_ms.is_some()));
        }
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            total, 3,
            "one retired whole-file row and two stable child IDs"
        );
        std::fs::write(
            &cue,
            "FILE \"album.wav\" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00",
        )
        .unwrap();
        let rows = scan_dirs(&dirs);
        let present = rows.iter().map(|r| r.id.clone()).collect();
        upsert_local_tracks(&conn, &rows).unwrap();
        assert_eq!(
            mark_missing_local_tracks(&conn, &dirs, &present).unwrap(),
            1
        );
        let tracks = query_local_tracks(&conn).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(
            (tracks[0].start_ms, tracks[0].end_ms, tracks[0].duration),
            (Some(0), Some(12_000), 12.0)
        );
        std::fs::remove_file(&cue).unwrap();
        let rows = scan_dirs(&dirs);
        let present = rows.iter().map(|r| r.id.clone()).collect();
        upsert_local_tracks(&conn, &rows).unwrap();
        mark_missing_local_tracks(&conn, &dirs, &present).unwrap();
        let tracks = query_local_tracks(&conn).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].id, audio.to_string_lossy());
        assert_eq!((tracks[0].start_ms, tracks[0].end_ms), (None, None));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn cue_track_deletion_does_not_delete_siblings() {
        let root = temp_dir("cue-delete");
        wav(&root, "album.wav", 12);
        std::fs::write(root.join("album.cue"), "FILE \"album.wav\" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 00:05:00").unwrap();
        let rows = scan_dirs(&[root.to_string_lossy().into_owned()]);
        let conn = test_conn();
        upsert_local_tracks(&conn, &rows).unwrap();
        assert_eq!(delete_local_track(&conn, &rows[0].id).unwrap(), 1);
        let tracks = query_local_tracks(&conn).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].id, rows[1].id);
        let _ = std::fs::remove_dir_all(root);
    }

    // ---------- 扩展名过滤（§13.1） ----------

    #[test]
    fn audio_ext_filter_is_case_insensitive() {
        for name in [
            "a.mp3", "b.FLAC", "c.Wav", "d.ogg", "e.M4A", "f.aac", "g.AAC",
            // 2026-10-18 扩充：解码后端本来就支持，此前只是被这份扩展名清单挡在库外
            "h.aiff", "i.AIF", "j.caf", "k.MKA", "l.mp1", "m.MP2", "n.oga",
        ] {
            assert!(is_audio_file(Path::new(name)), "{name} 应被识别为音频");
        }
        for name in ["a.txt", "b.mp4", "c.lrc", "d.jpg", "noext", "e.mp3.bak"] {
            assert!(!is_audio_file(Path::new(name)), "{name} 不应被识别为音频");
        }
    }

    #[test]
    fn collect_recursively_and_skips_non_audio() {
        let root = temp_dir("collect");
        let a = touch(&root, "周杰伦 - 晴天.mp3");
        let b = touch(&root, "sub/deep/陈奕迅 - 富士山下.flac");
        touch(&root, "cover.jpg");
        touch(&root, "sub/lyric.lrc");

        let mut found = collect_audio_files(&root);
        found.sort();

        let expected = [a.clone(), b.clone()];
        let mut expected = expected.to_vec();
        expected.sort();
        assert_eq!(found, expected);
        assert!(found.contains(&a) && found.contains(&b));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unreadable_or_missing_dir_is_skipped() {
        let root = temp_dir("missing-dir");
        let _ = std::fs::remove_dir_all(&root);
        // 目录不存在：返回空而不是 panic
        assert!(collect_audio_files(&root).is_empty());
        // 扫描入口同样静默跳过
        assert!(scan_dirs(&[root.to_string_lossy().to_string()]).is_empty());
    }

    #[test]
    fn scan_skips_system_and_noise_dirs() {
        let root = temp_dir("skip-dirs");
        touch(&root, "keep.mp3");
        touch(&root, "node_modules/a.mp3");
        touch(&root, "$RECYCLE.BIN/b.mp3");
        touch(&root, "System Volume Information/c.mp3");
        touch(&root, ".git/d.mp3");
        touch(&root, ".cargo-home/e.mp3");
        // 三平台化新增项（目录名匹配与宿主平台无关，Windows 上同样生效）
        touch(&root, "proc/f.mp3");
        touch(&root, "Library/g.mp3");
        touch(&root, ".Trash/h.mp3");
        // 反向：音乐目录不能被跳过
        touch(&root, "Music/i.mp3");

        let found = collect_audio_files(&root);
        assert_eq!(found.len(), 2, "系统/噪声目录应被跳过: {found:?}");
        assert!(found.iter().any(|p| p.ends_with("keep.mp3")));
        assert!(found.iter().any(|p| p.ends_with("i.mp3")));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn skip_dir_names_are_case_insensitive() {
        assert!(should_skip_dir("Windows"));
        assert!(should_skip_dir("$RECYCLE.BIN"));
        assert!(should_skip_dir("Program Files (x86)"));
        assert!(should_skip_dir("AppData"));
        assert!(should_skip_dir(".cargo-home"));
        assert!(should_skip_dir("Node_Modules"));
        // 通用词不跳过：可能被用户用来放音乐
        assert!(!should_skip_dir("Music"));
        assert!(!should_skip_dir("我的音乐"));
        assert!(!should_skip_dir("target"));
        assert!(!should_skip_dir("build"));
    }

    #[test]
    fn scan_progress_reports_visited_and_found() {
        let root = temp_dir("progress");
        touch(&root, "a.mp3");
        touch(&root, "b.flac");
        touch(&root, "c.txt");

        let mut last = (0usize, 0usize);
        let rows = scan_dirs_with_progress(
            &[root.to_string_lossy().to_string()],
            ScanFilter::default(),
            |v, f, _| {
                last = (v, f);
            },
        );
        assert_eq!(rows.len(), 2, "只应产出两条音频记录");
        assert_eq!(last.0, 3, "共访问 3 个文件条目");
        assert_eq!(last.1, 2, "命中 2 首音频");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn duration_filter_only_drops_known_short_tracks() {
        let row = |duration_ms: i64| LocalTrackRow {
            id: "x.mp3".to_string(),
            path: "x.mp3".to_string(),
            cue_path: None,
            start_ms: None,
            end_ms: None,
            title: "x".to_string(),
            singer: String::new(),
            album: String::new(),
            duration_ms,
            file_size: 0,
            mtime: 0,
            format: "mp3".to_string(),
            embedded_lyric: None,
        };
        // 关闭过滤：一律保留
        assert!(!is_too_short(&row(1_000), 0));
        // 开启 60s：已知且 <= 60s 丢弃，> 60s 保留
        assert!(is_too_short(&row(12_000), 60), "12s 应被丢弃");
        assert!(
            is_too_short(&row(60_000), 60),
            "整 60s 按「大于 60s」应丢弃"
        );
        assert!(!is_too_short(&row(60_001), 60), "60s 出头应保留");
        assert!(!is_too_short(&row(240_000), 60), "长曲应保留");
        // 时长未知（读不到元数据）：保留，避免误伤
        assert!(!is_too_short(&row(0), 60), "时长未知不应被丢弃");
    }

    #[test]
    fn size_filter_drops_tiny_files_before_metadata() {
        let root = temp_dir("min-size");
        touch(&root, "small.mp3"); // 21 字节
        let big = root.join("big.mp3");
        std::fs::write(&big, vec![0u8; 4096]).expect("写入大文件");

        let dirs = [root.to_string_lossy().to_string()];
        // 不过滤：两条都在
        let all = scan_dirs_with_progress(&dirs, ScanFilter::default(), |_, _, _| {});
        assert_eq!(all.len(), 2, "不过滤时应保留两条: {all:?}");

        // 1 KiB 下限：只留大文件
        let kept = scan_dirs_with_progress(
            &dirs,
            ScanFilter {
                min_duration_secs: 0,
                min_size_bytes: 1024,
            },
            |_, _, _| {},
        );
        assert_eq!(kept.len(), 1, "小文件应被跳过: {kept:?}");
        assert!(kept[0].path.ends_with("big.mp3"));

        // 读不到文件大小：保留，避免误伤
        assert!(!is_too_small(Path::new("does-not-exist.mp3"), 1024));
        // 阈值为 0：关闭过滤
        assert!(!is_too_small(Path::new("does-not-exist.mp3"), 0));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn list_drives_returns_windows_roots() {
        let drives = list_drives();
        assert!(!drives.is_empty(), "至少应枚举到一个盘符");
        assert!(drives.iter().all(|d| d.ends_with(":\\")), "{drives:?}");
        assert!(
            drives.iter().any(|d| d.eq_ignore_ascii_case("c:\\")),
            "系统盘 C: 应被枚举到: {drives:?}"
        );
    }

    /// macOS：`/` 必在；`/Volumes/*` 每个都是目录（CI 上通常为空，但若存在必须合法）
    #[cfg(target_os = "macos")]
    #[test]
    fn list_drives_returns_macos_roots() {
        let drives = list_drives();
        assert!(
            drives.iter().any(|d| d == "/"),
            "根目录应被枚举到: {drives:?}"
        );
        for d in &drives {
            assert!(
                std::path::Path::new(d).is_dir(),
                "枚举出的挂载点必须真实存在: {d}"
            );
        }
        assert!(
            drives
                .iter()
                .all(|d| d == "/" || d.starts_with("/Volumes/")),
            "只应产出 / 与 /Volumes/*: {drives:?}"
        );
    }

    /// Linux：`/` 必在；`$HOME` 非空且存在时也在（两者不重复）
    #[cfg(target_os = "linux")]
    #[test]
    fn list_drives_returns_linux_roots() {
        let drives = list_drives();
        assert!(
            drives.iter().any(|d| d == "/"),
            "根目录应被枚举到: {drives:?}"
        );
        assert!(std::path::Path::new("/").is_dir());
        if let Some(home) = std::env::var_os("HOME") {
            let home = home.to_string_lossy().to_string();
            if !home.is_empty() && std::path::Path::new(&home).is_dir() {
                assert!(drives.contains(&home), "家目录应被枚举到: {drives:?}");
            }
        }
        let mut uniq = drives.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(uniq.len(), drives.len(), "不应有重复项: {drives:?}");
    }

    /// 三平台共用：新增的 Linux/macOS 跳过项必须生效，且不误伤通用音乐目录名
    #[test]
    fn skip_dir_names_cover_linux_and_macos() {
        // Linux 伪文件系统 / 系统目录
        for name in [
            "proc",
            "sys",
            "dev",
            "run",
            "boot",
            "lost+found",
            "snap",
            "flatpak",
        ] {
            assert!(should_skip_dir(name), "Linux 系统目录应跳过: {name}");
        }
        // macOS 系统目录与卷元数据
        for name in [
            "System",
            "Library",
            "private",
            "Applications",
            "cores",
            ".Trash",
            ".Spotlight-V100",
            ".fseventsd",
            ".TemporaryItems",
        ] {
            assert!(should_skip_dir(name), "macOS 系统目录应跳过: {name}");
        }
        // 反向：常见的音乐目录名一个都不能进跳过清单
        for name in [
            "Music",
            "音乐",
            "Songs",
            "Downloads",
            "下载",
            "Audio",
            "Media",
        ] {
            assert!(!should_skip_dir(name), "音乐目录不应被跳过: {name}");
        }
    }

    // ---------- 文件名降级解析 ----------

    #[test]
    fn stem_fallback_splits_on_separator() {
        assert_eq!(
            parse_file_stem("周杰伦 - 晴天"),
            ("周杰伦".to_string(), "晴天".to_string())
        );
        // 多个分隔符：第 0 段歌手，其余整体作标题
        assert_eq!(
            parse_file_stem("Beyond - 海阔天空 - Live"),
            ("Beyond".to_string(), "海阔天空 - Live".to_string())
        );
        // 无分隔符：整段作标题，歌手留空
        assert_eq!(
            parse_file_stem("夜空中最亮的星"),
            (String::new(), "夜空中最亮的星".to_string())
        );
    }

    // ---------- 端到端扫描（假文件 → 走降级路径） ----------

    #[test]
    fn scan_dirs_falls_back_to_filename_and_dedups() {
        let root = temp_dir("scan");
        let first = touch(&root, "五月天 - 倔强.mp3");
        let second = touch(&root, "nested/无分隔符标题.flac");
        touch(&root, "ignore.txt");

        let dirs = vec![root.to_string_lossy().to_string()];
        let rows = scan_dirs(&dirs);
        assert_eq!(rows.len(), 2, "只应产出两条音频记录");

        // 逐组件比较（Windows 下 `\` 与 `/` 等价，字符串直接比会假失败）
        let found_paths: Vec<PathBuf> = rows.iter().map(|r| PathBuf::from(&r.path)).collect();
        assert!(found_paths.contains(&first), "缺少 {first:?}");
        assert!(found_paths.contains(&second), "缺少 {second:?}");

        // 假文件：symphonia 读不出元数据 → 走文件名降级，时长 0
        let row = rows
            .iter()
            .find(|r| r.path.ends_with("五月天 - 倔强.mp3"))
            .expect("应有该文件");
        assert_eq!(row.singer, "五月天");
        assert_eq!(row.title, "倔强");
        assert_eq!(row.duration_ms, 0);
        assert_eq!(row.format, "mp3");

        let nested = rows
            .iter()
            .find(|r| r.path.ends_with("无分隔符标题.flac"))
            .expect("应有该文件");
        assert_eq!(nested.title, "无分隔符标题");
        assert_eq!(nested.singer, "");
        assert_eq!(nested.format, "flac");

        // 同一目录传两遍：路径去重
        let dup = scan_dirs(&[
            root.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
        ]);
        assert_eq!(dup.len(), 2, "重叠目录应去重");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn symphonia_probe_rejects_garbage_file() {
        let root = temp_dir("garbage");
        let p = touch(&root, "junk.mp3");
        assert!(
            read_metadata(&p).is_none(),
            "非真实音频应返回 None 以触发降级"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---------- 入库 / 缺失标记（§13.2） ----------

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        migrations::run(&conn).expect("migrations");
        conn
    }

    #[test]
    fn local_tracks_roundtrip_and_missing_flag() {
        let conn = test_conn();
        let root = temp_dir("upsert");
        let first = touch(&root, "朴树 - 平凡之路.mp3");
        let second = touch(&root, "朴树 - 白桦林.mp3");

        let dirs = vec![root.to_string_lossy().to_string()];
        let rows = scan_dirs(&dirs);
        assert_eq!(rows.len(), 2);
        upsert_local_tracks(&conn, &rows).expect("upsert");

        let tracks = query_local_tracks(&conn).expect("query");
        assert_eq!(tracks.len(), 2);
        assert!(tracks.iter().all(|t| t.platform.is_local()));
        assert!(tracks.iter().all(|t| t.pic_url.is_empty()));
        assert!(tracks.iter().all(|t| t.music_id.is_none()));
        // id 必须是绝对路径，引擎直接拿它当播放路径用
        let ids: Vec<&str> = tracks.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&first.to_string_lossy().as_ref()));
        assert!(ids.contains(&second.to_string_lossy().as_ref()));

        // 重复扫描：更新而非插入重复行
        upsert_local_tracks(&conn, &rows).expect("upsert again");
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tracks WHERE platform='local'",
                [],
                |r| r.get(0),
            )
            .expect("count");
        assert_eq!(total, 2, "重复扫描不应产生重复行");

        // 删掉一个文件后重扫 → 该记录标 missing，查询时被过滤
        std::fs::remove_file(&second).expect("删除临时文件");
        let rows2 = scan_dirs(&dirs);
        assert_eq!(rows2.len(), 1);
        let present: HashSet<String> = rows2.iter().map(|r| r.path.clone()).collect();
        let marked = mark_missing_local_tracks(&conn, &dirs, &present).expect("mark");
        assert_eq!(marked, 1, "应标记 1 条缺失");

        let left = query_local_tracks(&conn).expect("query");
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, first.to_string_lossy());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_flag_only_touches_scanned_scope() {
        let conn = test_conn();
        let in_scope = temp_dir("scope-in");
        let out_scope = temp_dir("scope-out");
        let a = touch(&in_scope, "A - a.mp3");
        let b = touch(&out_scope, "B - b.mp3");

        let rows = scan_dirs(&[
            in_scope.to_string_lossy().to_string(),
            out_scope.to_string_lossy().to_string(),
        ]);
        upsert_local_tracks(&conn, &rows).expect("upsert");

        // 只扫描 in_scope，且文件已删 → 只标记 in_scope 的记录
        std::fs::remove_file(&a).expect("删除");
        let present: HashSet<String> = HashSet::new();
        let marked =
            mark_missing_local_tracks(&conn, &[in_scope.to_string_lossy().to_string()], &present)
                .expect("mark");
        assert_eq!(marked, 1);

        let left = query_local_tracks(&conn).expect("query");
        assert_eq!(left.len(), 1, "范围外记录不应被标记");
        assert_eq!(left[0].id, b.to_string_lossy());

        let _ = std::fs::remove_dir_all(&in_scope);
        let _ = std::fs::remove_dir_all(&out_scope);
    }

    // ---------- 删除单条本地记录（§13 本地曲库管理） ----------

    #[test]
    fn delete_local_track_removes_one_row_and_cascades() {
        let conn = test_conn();
        let root = temp_dir("delete-one");
        let keep = touch(&root, "A - keep.mp3");
        let drop_one = touch(&root, "B - drop.mp3");

        let dirs = vec![root.to_string_lossy().to_string()];
        upsert_local_tracks(&conn, &scan_dirs(&dirs)).expect("upsert");

        // 挂进歌单：删除曲目记录应连带清掉 playlist_tracks 关联行
        let drop_db_id = format!("local:{}", drop_one.to_string_lossy());
        conn.execute(
            "INSERT INTO playlists (id, name, created_at, updated_at) VALUES ('p1','歌单',0,0)",
            [],
        )
        .expect("insert playlist");
        conn.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
             VALUES ('p1', ?1, 0, 0)",
            rusqlite::params![drop_db_id],
        )
        .expect("insert playlist track");

        let path = drop_one.to_string_lossy().to_string();
        assert_eq!(delete_local_track(&conn, &path).expect("delete"), 1);

        let left = query_local_tracks(&conn).expect("query");
        assert_eq!(left.len(), 1, "只该删掉指定的那一条");
        assert_eq!(left[0].id, keep.to_string_lossy());
        let links: i64 = conn
            .query_row("SELECT COUNT(*) FROM playlist_tracks", [], |r| r.get(0))
            .expect("count links");
        assert_eq!(links, 0, "歌单关联行应被级联删除");

        // 幂等：再删一次返回 0；删不在库里的路径同样不报错
        assert_eq!(delete_local_track(&conn, &path).expect("delete again"), 0);
        assert_eq!(
            delete_local_track(&conn, r"D:\no\such\file.flac").expect("delete missing"),
            0
        );
        // 磁盘文件不受影响（只删记录）
        assert!(drop_one.exists(), "只删记录不应动磁盘文件");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_local_tracks_batch_removes_selected_only() {
        let conn = test_conn();
        let root = temp_dir("delete-batch");
        let first = touch(&root, "A - one.mp3");
        let second = touch(&root, "B - two.mp3");
        let keep = touch(&root, "C - keep.mp3");

        let dirs = vec![root.to_string_lossy().to_string()];
        upsert_local_tracks(&conn, &scan_dirs(&dirs)).expect("upsert");

        let paths = vec![
            first.to_string_lossy().to_string(),
            second.to_string_lossy().to_string(),
        ];
        assert_eq!(delete_local_tracks(&conn, &paths).expect("batch"), 2);

        let left = query_local_tracks(&conn).expect("query");
        assert_eq!(left.len(), 1, "只该删掉选中的两条");
        assert_eq!(left[0].id, keep.to_string_lossy());

        // 幂等；空列表直接返回 0
        assert_eq!(delete_local_tracks(&conn, &paths).expect("again"), 0);
        assert_eq!(delete_local_tracks(&conn, &[]).expect("empty"), 0);

        let _ = std::fs::remove_dir_all(&root);
    }

    // ---------- 扫描目录清单（scan_dirs 表） ----------

    #[test]
    fn scan_dir_list_roundtrip() {
        let conn = test_conn();
        let root = temp_dir("dirlist");
        let path = root.to_string_lossy().to_string();

        assert!(list_scan_dirs(&conn).expect("list").is_empty());

        add_scan_dir(&conn, &path).expect("add");
        add_scan_dir(&conn, &path).expect("重复添加应幂等");
        assert_eq!(list_scan_dirs(&conn).expect("list"), vec![path.clone()]);

        remove_scan_dir(&conn, &path).expect("remove");
        assert!(list_scan_dirs(&conn).expect("list").is_empty());

        // 移除不存在的目录不报错
        remove_scan_dir(&conn, &path).expect("remove 幂等");

        let _ = std::fs::remove_dir_all(&root);
    }

    // ---------- 本地歌词：同名 .lrc / 内嵌标签（2026-10-18） ----------

    #[test]
    fn sidecar_lrc_wins_and_gbk_is_decoded() {
        let root = temp_dir("lyric-sidecar");
        let audio = touch(&root, "周杰伦 - 晴天.mp3");
        // GBK/GB18030 编的 .lrc 是中文曲库里的常态：按 UTF-8 读会整份失败，
        // 必须走 GB18030 兜底，否则表现就是「明明有 .lrc 却没词」。
        let gbk = encoding_rs::GB18030
            .encode("[00:01.00]晴天 - 周杰伦")
            .0
            .into_owned();
        std::fs::write(root.join("周杰伦 - 晴天.LRC"), &gbk).expect("写 .lrc");

        let found = read_local_lyric(&audio).expect("应有同名 .lrc");
        assert_eq!(found.source, LYRIC_SOURCE_SIDECAR);
        assert_eq!(found.text, "[00:01.00]晴天 - 周杰伦");
        assert!(
            found
                .path
                .as_deref()
                .is_some_and(|p| p.ends_with("周杰伦 - 晴天.LRC")),
            "应记下 .lrc 路径：{:?}",
            found.path
        );

        // 同名 .lrc 优先于内嵌标签：扫描时带出来的内嵌词此时被忽略
        let resolved = resolve_local_lyric(&audio, Some("[00:09.00]内嵌")).expect("仍应取到 .lrc");
        assert_eq!(resolved.source, LYRIC_SOURCE_SIDECAR);
        assert_eq!(resolved.text, "[00:01.00]晴天 - 周杰伦");

        // 没有 .lrc 时退回内嵌标签（正文两头空白会先被削掉）
        let other = touch(&root, "无旁挂.flac");
        let embedded =
            resolve_local_lyric(&other, Some("  [00:02.00]内嵌词  ")).expect("应取到内嵌词");
        assert_eq!(embedded.source, LYRIC_SOURCE_EMBEDDED);
        assert_eq!(embedded.text, "[00:02.00]内嵌词");
        assert!(embedded.path.is_none(), "内嵌歌词没有旁挂文件路径");

        // 没有 .lrc、也没有内嵌词（文件本身还不是有效音频）→ None，不 panic
        assert!(read_local_lyric(&other).is_none());
        // 空白内嵌词等同于没有
        assert!(resolve_local_lyric(&other, Some("   ")).is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sidecar_lrc_requires_same_stem() {
        let root = temp_dir("lyric-stem");
        let audio = touch(&root, "song.mp3");
        // 同目录但不同主名的 .lrc 不该被认成这首歌的词（一张专辑一个目录时很常见）
        std::fs::write(root.join("other.lrc"), "[00:01.00]别人的词").expect("写 other.lrc");
        assert!(find_lrc_sidecar(&audio).is_none());
        assert!(read_local_lyric(&audio).is_none());

        // 大小写不同的主名 / 扩展名要能配上（Windows、macOS 上本就是同一个文件）
        std::fs::write(root.join("SONG.Lrc"), "[00:01.00]自己的词").expect("写 SONG.Lrc");
        let found = read_local_lyric(&audio).expect("应配上同名 .lrc");
        assert_eq!(found.text, "[00:01.00]自己的词");

        let _ = std::fs::remove_dir_all(&root);
    }

    // ---------- 拖拽 / 命令行带入的条目（2026-10-19） ----------

    #[test]
    fn scan_files_keeps_order_and_reports_skipped() {
        let root = temp_dir("scan-files");
        let album = root.join("album");
        std::fs::create_dir_all(&album).expect("建专辑目录");
        let in_album = touch(&album, "c.ogg");
        let song = touch(&root, "a.flac");
        let text = touch(&root, "readme.txt");
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).expect("建空目录");
        let missing = root.join("不存在.mp3");

        let arg = |p: &Path| p.to_string_lossy().into_owned();
        let paths = vec![
            arg(&album),   // 文件夹：递归收，排除非音频
            arg(&song),    // 单文件
            arg(&text),    // 扩展名不支持 → 跳过
            arg(&missing), // 不存在 → 跳过
            arg(&empty),   // 里面没有音频 → 跳过
            arg(&song),    // 重复条目只收一次
        ];

        let (rows, skipped) = scan_files(&paths);
        let got: Vec<&str> = rows.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(
            got,
            vec![arg(&in_album), arg(&song)],
            "顺序应跟入参一致（目录内部文件排在该条目位置）"
        );
        assert_eq!(rows[0].format, "ogg");
        // 假文件读不出元数据（时长 0、体积 1 字节）仍要产出行：
        // 用户点名要播的文件不该被扫描的时长/体积阈值滤掉
        assert_eq!(rows[1].duration_ms, 0);
        assert_eq!(
            skipped,
            vec![arg(&text), arg(&missing), arg(&empty)],
            "跳过项要如实回传，界面才能提示「N 个条目没打开」"
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
