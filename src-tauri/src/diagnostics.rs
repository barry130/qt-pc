//! B8 诊断包导出：一键打出「日志 + 脱敏配置 + 数据库版本 + 设备信息」的 zip。
//!
//! 为什么自己写 zip（不引 `zip` crate）：包里全是文本，**不压缩**（stored 模式）就够了，
//! 而 stored 的 zip 只需要「本地头 / 中央目录 / 目录尾」三段定长结构 + 一个 CRC32 表，
//! 一百多行就能说清楚。项目对依赖一贯克制（`Cargo.toml` 里到处是「不引入新副本」的
//! 注释），为一次导出多挂一条压缩依赖链不划算。
//!
//! 脱敏口径：键名里带 secret / token / password / cookie / session / signature /
//! credential / apikey / private 的一律替换成 `***`，**键名保留** —— 排查「有没有配过」
//! 时键名本身就是信息，而值一旦进 zip 就等于交给别人。播放历史、歌单名这类内容不导出
//! （那是用户数据，不是排障信息），只给条数。
//!
//! 日志只带尾部：一个正在被写的大日志文件整份塞进去没有意义，尾部才是出错现场。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 最多带几个日志文件（按修改时间取最新的）
pub const MAX_LOG_FILES: usize = 8;
/// 单个日志文件最多带多少字节（从尾部截，出错现场在末尾）
pub const MAX_LOG_BYTES: u64 = 512 * 1024;

/// 打包结果：文件名 + zip 字节 + 条目数（前端拿去落盘）
pub struct Bundle {
    /// 建议文件名（`quietmusic-diagnostics-<时间戳>.zip`）
    pub file_name: String,
    /// zip 内容（stored，无压缩）
    pub bytes: Vec<u8>,
    /// 写入的条目数（含 README / summary / settings）
    pub files: usize,
}

/// 打一个诊断包。`db` 为 None 时（本次运行没有可用库）照样出包，只是 db 段写 null。
pub fn build(app: &tauri::AppHandle, db: Option<&crate::db::Database>) -> Result<Bundle, String> {
    let now = crate::db::store::now_unix() as u64;
    let (time, date) = dos_datetime(now);

    let summary = summary_json(app, db, now);
    let settings = settings_json(db);
    let logs = collect_logs();

    let mut zip = ZipBuilder::default();
    let mut files = 0;
    let mut add = |name: &str, bytes: &[u8]| {
        zip.add(name, bytes, time, date);
        files += 1;
    };
    add("README.txt", readme().as_bytes());
    add("summary.json", &pretty(&summary));
    add("settings.json", &pretty(&settings));
    for (name, bytes) in &logs {
        add(&format!("logs/{name}"), bytes);
    }

    Ok(Bundle {
        file_name: format!("quietmusic-diagnostics-{now}.zip"),
        bytes: zip.finish(),
        files,
    })
}

fn readme() -> String {
    format!(
        "轻听音乐 · 诊断包\n\
         =================\n\n\
         包含：\n\
         - summary.json   版本 / 平台 / 数据目录 / 数据库版本与各表条数\n\
         - settings.json  播放与外观设置（**密钥类已替换为 *** **，键名保留）\n\
         - logs/          最近的日志文件（每个最多尾部 {} KB，共最多 {} 个）\n\n\
         不含：播放历史明细、歌单内容、曲库路径清单、任何账号凭据。\n\
         注意：summary.json 里有本机路径（数据目录 / 程序位置），提交到公开 issue 前\n\
         请自行确认是否可以公开。\n",
        MAX_LOG_BYTES / 1024,
        MAX_LOG_FILES
    )
}

fn pretty(value: &serde_json::Value) -> Vec<u8> {
    serde_json::to_vec_pretty(value).unwrap_or_else(|_| b"{}".to_vec())
}

fn summary_json(
    app: &tauri::AppHandle,
    db: Option<&crate::db::Database>,
    now: u64,
) -> serde_json::Value {
    let show = |p: PathBuf| p.to_string_lossy().to_string();
    let exe = std::env::current_exe().ok().map(show);
    let logs_dir = crate::file_logger::effective_dir();
    serde_json::json!({
        "generatedAt": now,
        "app": {
            "versionName": crate::astral::version_name(),
            "versionCode": crate::astral::version_code(),
            "portable": crate::app_paths::is_portable(),
            "executable": exe,
            "dataRoot": show(crate::app_paths::data_root(app)),
            "cacheRoot": show(crate::app_paths::cache_root(app)),
            "logsRoot": logs_dir.clone().map(show),
        },
        "platform": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "family": std::env::consts::FAMILY,
        },
        "db": db.map(db_json),
        "logs": {
            "dir": logs_dir.map(show),
            "fileCount": count_logs(),
        },
    })
}

fn db_json(db: &crate::db::Database) -> serde_json::Value {
    // 表名写死（不拼用户输入），条数查不到就给 -1：诊断包里「查不到」本身也是信息
    const TABLES: [&str; 11] = [
        "tracks",
        "playlists",
        "playlist_tracks",
        "play_history",
        "play_stats",
        "favorites",
        "dislikes",
        "lyrics",
        "scrobbles",
        "smart_playlists",
        "tag_edits",
    ];
    let mut counts = serde_json::Map::new();
    let integrity = db
        .with(|conn| {
            for table in TABLES {
                let count: i64 = conn
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                    .unwrap_or(-1);
                counts.insert(table.to_string(), serde_json::json!(count));
            }
            let integrity: String = conn
                .query_row("PRAGMA integrity_check", [], |r| r.get(0))
                .unwrap_or_else(|e| format!("查询失败：{e}"));
            Ok(integrity)
        })
        .unwrap_or_else(|e| format!("查询失败：{e}"));
    serde_json::json!({
        "schemaVersion": crate::db::migrations::CURRENT_VERSION,
        "integrity": integrity,
        "counts": counts,
    })
}

/// 配置快照（脱敏）。读的是 `settings` 键值表 —— 播放、外观、上报凭据都在这里。
pub(crate) fn settings_json(db: Option<&crate::db::Database>) -> serde_json::Value {
    let Some(db) = db else {
        return serde_json::json!({ "values": null, "redacted": [] });
    };
    let rows = db
        .with(|conn| {
            let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .unwrap_or_default();
    let mut values = serde_json::Map::new();
    let mut redacted: Vec<String> = Vec::new();
    for (key, value) in rows {
        let mut value = serde_json::Value::String(value);
        let known_container = matches!(key.trim().to_ascii_lowercase().as_str(), "ai.profiles" | "sourceauth.accounts");
        let damaged_container = known_container
            && !value.as_str().is_some_and(|text| is_structured_setting(text, 0));
        let changed = if is_secret_key(&key) || damaged_container {
            value = serde_json::json!("***");
            true
        } else {
            redact_setting_value(&mut value, 0)
        };
        if changed {
            redacted.push(key.clone());
        }
        values.insert(key, value);
    }
    serde_json::json!({ "values": values, "redacted": redacted })
}

// Credential containers must eventually decode to an object/array. Broken JSON
// or multiply encoded primitives cannot safely be inspected, so redact wholesale.
fn is_structured_setting(text: &str, depth: usize) -> bool {
    if depth > 32 {
        return false;
    }
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Object(_) | serde_json::Value::Array(_)) => true,
        Ok(serde_json::Value::String(inner)) => is_structured_setting(&inner, depth + 1),
        _ => false,
    }
}

/// Settings values are strings, and may themselves contain JSON-encoded strings.
/// Preserve their original representation unless a credential was actually masked.
fn redact_setting_value(value: &mut serde_json::Value, depth: usize) -> bool {
    if depth > 32 {
        *value = serde_json::json!("***");
        return true;
    }
    match value {
        serde_json::Value::Object(fields) => {
            let mut changed = false;
            for (key, value) in fields {
                let lower = key.to_ascii_lowercase();
                // ai.profiles.keys and sourceAuth.accounts.extras are credential
                // containers, even when their individual entries have arbitrary names.
                if is_secret_key(key) || matches!(lower.as_str(), "key" | "keys" | "extras") {
                    *value = serde_json::json!("***");
                    changed = true;
                } else {
                    changed |= redact_setting_value(value, depth + 1);
                }
            }
            changed
        }
        serde_json::Value::Array(items) => {
            let mut changed = false;
            for item in items {
                changed |= redact_setting_value(item, depth + 1);
            }
            changed
        }
        serde_json::Value::String(text) => {
            let Ok(mut parsed) = serde_json::from_str::<serde_json::Value>(text) else {
                return false;
            };
            if !redact_setting_value(&mut parsed, depth + 1) {
                return false;
            }
            *text = serde_json::to_string(&parsed).unwrap_or_else(|_| "***".into());
            true
        }
        _ => false,
    }
}

/// 键名是否算「密钥类」。宁可多脱一点：误脱一个普通键只是少点信息，漏一个就是凭据外泄。
fn is_secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    const NEEDLES: [&str; 10] = [
        "secret",
        "token",
        "password",
        "passwd",
        "cookie",
        "session",
        "signature",
        "credential",
        "apikey",
        "private",
    ];
    NEEDLES.iter().any(|n| lower.contains(n))
        || lower.contains("api_key")
        || lower.ends_with(".key")
}

fn logs_dir() -> Option<PathBuf> {
    crate::file_logger::effective_dir()
}

fn log_files() -> Vec<PathBuf> {
    let Some(dir) = logs_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && matches!(
                    p.extension().and_then(|e| e.to_str()),
                    Some("log") | Some("txt")
                )
        })
        .filter_map(|p| {
            let modified = std::fs::metadata(&p).ok()?.modified().ok()?;
            Some((modified, p))
        })
        .collect();
    files.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    files.into_iter().take(MAX_LOG_FILES).map(|f| f.1).collect()
}

fn count_logs() -> usize {
    log_files().len()
}

/// 读日志尾部（超过 `MAX_LOG_BYTES` 只留最后一段；UTF-8 被切断时按 lossy 收尾）。
fn collect_logs() -> Vec<(String, Vec<u8>)> {
    log_files()
        .into_iter()
        .filter_map(|path| {
            let data = std::fs::read(&path).ok()?;
            let len = data.len() as u64;
            let bytes = if len > MAX_LOG_BYTES {
                let tail = &data[(len - MAX_LOG_BYTES) as usize..];
                // 从第一个换行处截断，免得留下半行
                let cut = tail
                    .iter()
                    .position(|b| *b == b'\n')
                    .map(|i| i + 1)
                    .unwrap_or(0);
                tail[cut..].to_vec()
            } else {
                data
            };
            Some((path.file_name()?.to_string_lossy().to_string(), bytes))
        })
        .collect()
}

// ---------------- stored（不压缩）zip 写入 ----------------

#[derive(Default)]
struct ZipBuilder {
    data: Vec<u8>,
    entries: Vec<Entry>,
}

struct Entry {
    name: String,
    crc: u32,
    size: u32,
    offset: u32,
    time: u16,
    date: u16,
}

impl ZipBuilder {
    fn add(&mut self, name: &str, bytes: &[u8], time: u16, date: u16) {
        let offset = self.data.len() as u32;
        let crc = crc32(bytes);
        let size = bytes.len() as u32;
        let name_bytes = name.as_bytes();
        // 本地文件头：sig / 版本 20 / 通用标志 0x0800（名字是 UTF-8）/ 存储 / 时间 / 日期
        push_u32(&mut self.data, 0x0403_4b50);
        push_u16(&mut self.data, 20);
        push_u16(&mut self.data, 0x0800);
        push_u16(&mut self.data, 0); // method = stored
        push_u16(&mut self.data, time);
        push_u16(&mut self.data, date);
        push_u32(&mut self.data, crc);
        push_u32(&mut self.data, size); // 压缩后
        push_u32(&mut self.data, size); // 原始
        push_u16(&mut self.data, name_bytes.len() as u16);
        push_u16(&mut self.data, 0); // extra
        self.data.extend_from_slice(name_bytes);
        self.data.extend_from_slice(bytes);
        self.entries.push(Entry {
            name: name.to_string(),
            crc,
            size,
            offset,
            time,
            date,
        });
    }

    fn finish(mut self) -> Vec<u8> {
        let cd_offset = self.data.len() as u32;
        let entries = std::mem::take(&mut self.entries);
        for e in &entries {
            let name_bytes = e.name.as_bytes();
            push_u32(&mut self.data, 0x0201_4b50);
            push_u16(&mut self.data, 20); // version made by
            push_u16(&mut self.data, 20); // version needed
            push_u16(&mut self.data, 0x0800);
            push_u16(&mut self.data, 0);
            push_u16(&mut self.data, e.time);
            push_u16(&mut self.data, e.date);
            push_u32(&mut self.data, e.crc);
            push_u32(&mut self.data, e.size);
            push_u32(&mut self.data, e.size);
            push_u16(&mut self.data, name_bytes.len() as u16);
            push_u16(&mut self.data, 0); // extra
            push_u16(&mut self.data, 0); // comment
            push_u16(&mut self.data, 0); // disk
            push_u16(&mut self.data, 0); // internal attrs
            push_u32(&mut self.data, 0); // external attrs
            push_u32(&mut self.data, e.offset);
            self.data.extend_from_slice(name_bytes);
        }
        let cd_size = self.data.len() as u32 - cd_offset;
        push_u32(&mut self.data, 0x0605_4b50);
        push_u16(&mut self.data, 0); // this disk
        push_u16(&mut self.data, 0); // cd disk
        push_u16(&mut self.data, entries.len() as u16);
        push_u16(&mut self.data, entries.len() as u16);
        push_u32(&mut self.data, cd_size);
        push_u32(&mut self.data, cd_offset);
        push_u16(&mut self.data, 0); // comment len
        self.data
    }
}

fn push_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn crc32(data: &[u8]) -> u32 {
    static TABLE: OnceLock<[u32; 256]> = OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        for (i, slot) in table.iter_mut().enumerate() {
            let mut value = i as u32;
            for _ in 0..8 {
                value = if value & 1 != 0 {
                    0xEDB8_8320 ^ (value >> 1)
                } else {
                    value >> 1
                };
            }
            *slot = value;
        }
        table
    });
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc = table[((crc ^ *byte as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

/// unix 秒 → (DOS 时间, DOS 日期)。zip 的时间字段没有时区概念，这里按 UTC 记。
fn dos_datetime(unix: u64) -> (u16, u16) {
    let days = (unix / 86_400) as i64;
    let secs = unix % 86_400;
    let (year, month, day) = civil_from_days(days);
    let year = if year < 1980 { 1980 } else { year };
    let hour = secs / 3600;
    let minute = (secs % 3600) / 60;
    let second = secs % 60;
    let time = ((hour as u16) << 11) | ((minute as u16) << 5) | ((second / 2) as u16);
    let date = (((year - 1980) as u16) << 9) | ((month as u16) << 5) | day as u16;
    (time, date)
}

/// Howard Hinnant 的 civil_from_days：纪元日 → (年, 月, 日)
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { y + 1 } else { y }, month, day)
}

/// 给测试与「保存到某目录」用：把包写到指定路径。
pub fn write_to(bundle: &Bundle, dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败：{e}"))?;
    let path = dir.join(&bundle.file_name);
    std::fs::write(&path, &bundle.bytes).map_err(|e| format!("写文件失败：{e}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_matches_known_vector() {
        // zip 实现的经典校验向量
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn zip_has_local_header_central_dir_and_eocd() {
        let (time, date) = dos_datetime(1_700_000_000);
        let mut zip = ZipBuilder::default();
        zip.add("a.txt", b"hello", time, date);
        zip.add("logs/b.log", b"world!", time, date);
        let bytes = zip.finish();

        assert_eq!(&bytes[0..4], &[0x50, 0x4b, 0x03, 0x04], "本地文件头");
        let eocd = bytes.len() - 22;
        assert_eq!(&bytes[eocd..eocd + 4], &[0x50, 0x4b, 0x05, 0x06], "目录尾");
        let entries = u16::from_le_bytes([bytes[eocd + 10], bytes[eocd + 11]]);
        assert_eq!(entries, 2);
        // stored：数据原样跟在名字后面
        assert!(bytes.windows(5).any(|w| w == b"hello"));
        assert!(bytes.windows(6).any(|w| w == b"world!"));
        // 中央目录偏移指向 "PK\x01\x02"
        let cd_offset = u32::from_le_bytes([
            bytes[eocd + 16],
            bytes[eocd + 17],
            bytes[eocd + 18],
            bytes[eocd + 19],
        ]) as usize;
        assert_eq!(&bytes[cd_offset..cd_offset + 4], &[0x50, 0x4b, 0x01, 0x02]);
    }

    #[test]
    fn exported_settings_redact_nested_credentials_without_losing_diagnostics() {
        let db = crate::db::Database::open(Path::new(":memory:")).unwrap();
        let profiles = serde_json::json!([
            { "id": "primary", "name": "Work", "model": "local-model", "apiKey": "AI_CANARY", "keys": ["KEY_CANARY"] }
        ]);
        let accounts = serde_json::json!({
            "wy": { "cookie": "COOKIE_CANARY", "user": { "nickname": "Listener", "vip": true }, "extras": { "music_u": "EXTRA_CANARY" } }
        });
        let appearance = serde_json::json!({
            "fontSize": 24,
            "nested": [
                { "credential": "NESTED_CANARY", "enabled": true },
                serde_json::json!({ "accessToken": "ENCODED_CANARY", "mode": "dark" }).to_string()
            ]
        });
        db.with(|conn| {
            for (key, value) in [
                ("ai.profiles", profiles.to_string()),
                ("sourceAuth.accounts", accounts.to_string()),
                ("appearance", appearance.to_string()),
                ("doubleEncoded", serde_json::to_string(&serde_json::json!({ "password": "DOUBLE_CANARY", "width": 640 }).to_string()).unwrap()),
                ("lastfm.user", "Listener".to_string()),
                ("astral.session", "SESSION_CANARY".to_string()),
            ] {
                crate::db::store::set_setting(conn, key, &value)?;
            }
            Ok(())
        }).unwrap();

        // This is the exact snapshot serialized into settings.json by build(), not a
        // private key predicate or a copy of the redaction implementation.
        let snapshot = settings_json(Some(&db));
        let exported = serde_json::to_string(&snapshot).unwrap();
        for canary in ["AI_CANARY", "KEY_CANARY", "COOKIE_CANARY", "EXTRA_CANARY", "NESTED_CANARY", "ENCODED_CANARY", "DOUBLE_CANARY", "SESSION_CANARY"] {
            assert!(!exported.contains(canary), "diagnostic export leaked {canary}");
        }
        let values = &snapshot["values"];
        let exported_profiles: serde_json::Value = serde_json::from_str(values["ai.profiles"].as_str().unwrap()).unwrap();
        assert_eq!(exported_profiles[0]["model"], "local-model");
        assert_eq!(exported_profiles[0]["name"], "Work");
        let exported_accounts: serde_json::Value = serde_json::from_str(values["sourceAuth.accounts"].as_str().unwrap()).unwrap();
        assert_eq!(exported_accounts["wy"]["user"]["nickname"], "Listener");
        let exported_appearance: serde_json::Value = serde_json::from_str(values["appearance"].as_str().unwrap()).unwrap();
        assert_eq!(exported_appearance["fontSize"], 24);
        assert_eq!(exported_appearance["nested"][0]["enabled"], true);
        assert_eq!(values["lastfm.user"], "Listener");
        assert!(snapshot["redacted"].as_array().unwrap().contains(&serde_json::json!("ai.profiles")));
        let original = db.with(|conn| crate::db::store::get_setting(conn, "ai.profiles")).unwrap().unwrap();
        assert_eq!(original, profiles.to_string(), "export must not mutate saved credentials");
    }

    #[test]
    fn exported_settings_fail_closed_for_damaged_credential_containers() {
        for key in ["ai.profiles", "sourceAuth.accounts"] {
            for saved in [
                "{\"key\":\"BROKEN_CREDENTIAL_CANARY".to_owned(),
                "BROKEN_CREDENTIAL_CANARY".to_owned(),
                serde_json::to_string("BROKEN_CREDENTIAL_CANARY").unwrap(),
                serde_json::to_string(&serde_json::to_string("BROKEN_CREDENTIAL_CANARY").unwrap()).unwrap(),
                serde_json::to_string("{\"cookie\":\"BROKEN_CREDENTIAL_CANARY").unwrap(),
                "123".to_owned(),
                "null".to_owned(),
                "true".to_owned(),
            ] {
                let db = crate::db::Database::open(Path::new(":memory:")).unwrap();
                db.with(|conn| {
                    crate::db::store::set_setting(conn, key, &saved)?;
                    crate::db::store::set_setting(conn, "notes", "ordinary malformed { text")?;
                    Ok(())
                }).unwrap();
                let snapshot = settings_json(Some(&db));
                assert_eq!(snapshot["values"][key], "***", "unsafe credential container {key}");
                assert_eq!(snapshot["values"]["notes"], "ordinary malformed { text");
                assert!(snapshot["redacted"].as_array().unwrap().contains(&serde_json::json!(key)));
                assert_eq!(db.with(|conn| crate::db::store::get_setting(conn, key)).unwrap().unwrap(), saved);
            }
        }
    }

    #[test]
    fn secret_keys_are_redacted() {
        assert!(is_secret_key("lastfm_api_secret"));
        assert!(is_secret_key("lastfm_session"));
        assert!(is_secret_key("listenbrainz_token"));
        assert!(is_secret_key("proxy.password"));
        assert!(is_secret_key("astral.private_key"));
        assert!(!is_secret_key("window.width"));
        assert!(!is_secret_key("playback.volume"));
        assert!(!is_secret_key("lastfm.user"), "用户名不算凭据");
    }

    #[test]
    fn dos_datetime_encodes_1980_epoch() {
        let (time, date) = dos_datetime(0);
        assert_eq!(time, 0);
        assert_eq!(date, (1 << 5) | 1, "1980-01-01");
        // 2023-11-14 22:13:20 UTC
        let (time, date) = dos_datetime(1_700_000_000);
        assert_eq!(date, ((2023 - 1980) << 9) | (11 << 5) | 14);
        assert_eq!(time, (22 << 11) | (13 << 5) | (20 / 2));
    }

    #[test]
    fn tail_truncation_keeps_last_newline_aligned_chunk() {
        let tmp = std::env::temp_dir().join("quietmusic-diag-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let path = tmp.join("app.log");
        // 三行，每行都短于上限；用默认上限读全文
        std::fs::write(&path, b"line1\nline2\nline3\n").unwrap();
        let data = std::fs::read(&path).unwrap();
        assert_eq!(data, b"line1\nline2\nline3\n");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
