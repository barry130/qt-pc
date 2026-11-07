//! 用户数据备份 / 恢复（报告 §3.1）。
//!
//! **备份什么**：歌单、收藏、播放历史与统计、本地曲库条目、设置、歌词、扫描目录 ——
//! 这些**全都在同一个 SQLite 文件里**，所以一次 `VACUUM INTO` 快照就是完整备份，
//! 再补一份同名 `.json` 清单（版本 / schema / 各表条数 / 导出时间）方便肉眼核对。
//! **不打包什么**：下载的音频本体与封面（动辄几十 GB），备份的是"记录"不是"文件"；
//! 导入后只要下载目录还在原处，记录照样能播（`tracks.missing` 会如实体检）。
//!
//! 备份直接使用 SQLite 单文件快照，无需额外封装压缩容器；拷进 U 盘或网盘即可保存。
//!
//! **导入两种模式**：
//! - 覆盖（replace）：先给当前库拍一张 `quietmusic-before-import-*.db` 快照，再用备份里
//!   的数据整体替换；
//! - 合并（merge）：逐表 `INSERT OR IGNORE`，已有记录（同名 id / 同名唯一键）保留现状。
//!
//! 两张表都是 `TEXT` 主键（uuid / `platform:id`），所以合并**不需要** id 重映射；
//! 代价是"同一首歌在两台机器上 id 不同"时会出现两条记录 —— 这比强行合并丢数据安全。

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::db::Database;

/// 导出文件名前缀（清单文件同名，只换扩展名）。
const EXPORT_PREFIX: &str = "quietmusic-backup-";
/// 覆盖导入前的自动快照前缀。
const SAFETY_PREFIX: &str = "quietmusic-before-import-";
/// 命令行开关：`QuietMusic.exe --export-backup <目录>`。
pub const EXPORT_FLAG: &str = "--export-backup";

/// 属于本机安全区的设置：**导入时只跳过源里的值、原样保留目标里的值（或"没有这个键"）**。
///
/// - `astral.session`：登录会话（令牌）。换机导入别人的备份时，绝不能把别人的会话带进来；
///   当前会话放在内存里，本来也不该从备份恢复。
/// - `astral.secureStorageVersion`：本机"旧会话已擦除"的完成标记（`credential_store` 写入）。
///   源备份里的 `1` 只说明**源机器**擦过，不能据此跳过本机的清理。
///
/// 两个键的语义都以 `crate::astral::SETTING_ASTRAL_SESSION` / `credential_store::sanitize_storage`
/// 为准；这里只做导入过滤，不改写它们。
const PROTECTED_SETTING_KEYS: &[&str] = &[
    crate::astral::SETTING_ASTRAL_SESSION,
    // `credential_store::sanitize_storage` 里的 `MARKER` 是函数内私有常量，这里照抄字面量。
    "astral.secureStorageVersion",
];

/// 参与备份 / 恢复的数据表（**不含** `schema_migrations`：它由迁移逻辑自己维护）。
/// 顺序 = 插入顺序：父表在前；另有 `defer_foreign_keys` 兜底，顺序偏差也不会中途失败。
///
/// **必须覆盖库里所有用户数据表**（C02）：早期列表只写了 18 张，后来加的
/// 智能歌单、标签编辑、播放队列外的统计与播客等表全漏了 —— 导出的是整库快照，
/// 导入却只搬一半，用户换机后智能歌单变空壳、scrobble 队列丢失。
/// `tests::every_user_table_is_covered_by_the_backup_list` 会拿 schema 里的表清单对账，新增表忘了加会红。
const TABLES: &[&str] = &[
    "tracks",
    "playlists",
    "smart_playlists",
    "liked_playlists",
    "liked_songs",
    "liked_song_playlists",
    "playlist_tracks",
    "play_history",
    "play_stats",
    "play_days",
    "download_tasks",
    "download_files",
    "scan_dirs",
    "pending_like_ops",
    "like_sync_state",
    "lyrics",
    "lyric_settings",
    "play_queue",
    "dislike_rules",
    "tag_edits",
    "track_ratings",
    "scrobbles",
    "podcast_shows",
    "podcast_episodes",
    "podcast_subtitles",
    "orphan_files",
    "library_health_ignored",
    "settings",
];

/// 导入方式：覆盖 / 合并。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportMode {
    Replace,
    Merge,
}

impl ImportMode {
    /// 前端传字符串（覆盖=replace / 合并=merge），未知值报错而不是静默取默认 ——
    /// 静默取默认意味着用户点了"覆盖"却做了"合并"，这类事不能靠猜。
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "replace" | "overwrite" | "覆盖" => Ok(Self::Replace),
            "merge" | "合并" => Ok(Self::Merge),
            other => Err(format!("未知的导入方式：{other}（应为 replace 或 merge）")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Replace => "replace",
            Self::Merge => "merge",
        }
    }
}

/// 导出结果（前端用来提示"备份到哪了、备了多少"）。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: String,
    pub manifest_path: String,
    pub schema_version: i64,
    pub tracks: i64,
    pub playlists: i64,
    pub liked_playlists: i64,
    pub history: i64,
}

/// 导入结果。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub mode: String,
    /// 本次写进去的行数（合并模式下被忽略的重复行不计入）
    pub rows: i64,
    pub tracks: i64,
    pub playlists: i64,
    pub history: i64,
    /// 覆盖模式下的自动快照路径（导入前的现状，反悔用）
    pub safety_copy: Option<String>,
}

/// 各表条数（只统计用户最关心的四个，清单里够用）。
#[derive(Debug, Default, Clone, Copy)]
struct Counts {
    tracks: i64,
    playlists: i64,
    liked_playlists: i64,
    history: i64,
}

/// 导出备份：`VACUUM INTO` 一份一致快照 + 一份 JSON 清单。
///
/// 用 `VACUUM INTO` 而不是复制 `.db`：WAL 下尚未 checkpoint 的写入还在 `-wal` 里，
/// 直接复制会静默丢掉最近的改动（与 `db::health::rolling_backup` 同一理由）。
pub fn export(db: &Database, dir: &Path) -> Result<BackupInfo, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建备份目录失败（{}）：{e}", dir.display()))?;
    let stamp = file_stamp();
    let target = unique_path(dir, EXPORT_PREFIX, &stamp, "db");
    let counts = db
        .with(|conn| {
            conn.execute("VACUUM INTO ?1", [target.to_string_lossy().to_string()])?;
            count_all(conn)
        })
        .map_err(|e| format!("导出备份失败：{e}"))?;

    let manifest_path = dir.join(format!("{EXPORT_PREFIX}{stamp}.json"));
    let manifest = serde_json::json!({
        "app": "轻听（QuietMusic）",
        "version": env!("CARGO_PKG_VERSION"),
        "schemaVersion": crate::db::migrations::CURRENT_VERSION,
        "exportedAt": crate::db::health::unix_now(),
        "database": target.file_name().map(|n| n.to_string_lossy().to_string()),
        "counts": {
            "tracks": counts.tracks,
            "playlists": counts.playlists,
            "likedPlaylists": counts.liked_playlists,
            "history": counts.history,
        },
        "note": "备份仅含数据（歌单/收藏/记录/设置/歌词），不含下载的音频文件本体",
    });
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| format!("生成备份清单失败：{e}"))?;
    std::fs::write(&manifest_path, bytes).map_err(|e| format!("写备份清单失败：{e}"))?;

    log::info!(
        "[backup] 已导出 {}（曲目 {} / 歌单 {} / 收藏歌单 {} / 记录 {}）",
        target.display(),
        counts.tracks,
        counts.playlists,
        counts.liked_playlists,
        counts.history
    );
    Ok(BackupInfo {
        path: target.to_string_lossy().to_string(),
        manifest_path: manifest_path.to_string_lossy().to_string(),
        schema_version: crate::db::migrations::CURRENT_VERSION,
        tracks: counts.tracks,
        playlists: counts.playlists,
        liked_playlists: counts.liked_playlists,
        history: counts.history,
    })
}

/// 导入备份。`work_dir` 用于放迁移副本与覆盖前的自动快照（传数据目录即可）。
pub fn import(
    db: &Database,
    source: &Path,
    mode: ImportMode,
    work_dir: &Path,
) -> Result<ImportSummary, String> {
    if !source.is_file() {
        return Err(format!("找不到备份文件：{}", source.display()));
    }
    std::fs::create_dir_all(work_dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
    let temp = work_dir.join(format!("import-{}.db", fastrand::u64(..)));
    std::fs::copy(source, &temp).map_err(|e| format!("复制备份文件失败：{e}"))?;

    // 迁移只在**副本**上做：直接迁移用户选中的文件会把他的备份改掉
    if let Err(e) = prepare_copy(&temp) {
        let _ = std::fs::remove_file(&temp);
        return Err(e);
    }

    // 覆盖前先留一张"现状"快照：覆盖是不可逆的，用户反悔时得有退路
    let safety_copy = if mode == ImportMode::Replace {
        match safety_snapshot(db, work_dir) {
            Ok(path) => Some(path.to_string_lossy().to_string()),
            Err(e) => {
                let _ = std::fs::remove_file(&temp);
                return Err(e);
            }
        }
    } else {
        None
    };

    let copied = db.with(|conn| {
        // 先把目标库里的安全区设置抓出来：覆盖模式下 settings 会被整表清掉，
        // 合并模式下源里的同名键也要跳过 —— 两种情况都得靠这份快照还原。
        let preserved = read_protected_settings(conn)?;
        // ATTACH 必须在事务外（SQLite 不允许在事务里 ATTACH），所以先挂载再开事务
        conn.execute(
            "ATTACH DATABASE ?1 AS backup_src",
            [temp.to_string_lossy().to_string()],
        )?;
        let result = (|| -> Result<i64, rusqlite::Error> {
            let tx = conn.unchecked_transaction()?;
            // 外键校验推迟到提交：插入顺序即使有偏差也不会中途报错，提交时仍会检查
            tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
            if mode == ImportMode::Replace {
                // 子表先删（父表的级联删除会顺手清掉子表，倒序更直观）
                for table in TABLES.iter().rev() {
                    tx.execute(&format!("DELETE FROM main.{table}"), [])?;
                }
            }
            let mut rows = 0i64;
            for table in TABLES {
                // settings 里混着安全区键：源备份里的跳过，目标的值等复制完再放回去
                let excluded: &[&str] = if *table == "settings" { PROTECTED_SETTING_KEYS } else { &[] };
                rows += copy_table_excluding(&tx, table, mode, excluded)?;
            }
            restore_protected_settings(&tx, &preserved)?;
            tx.commit()?;
            Ok(rows)
        })();
        // 无论成败都摘掉挂载（失败时事务已随之回滚）
        let _ = conn.execute("DETACH DATABASE backup_src", []);
        result
    });
    let _ = std::fs::remove_file(&temp);
    let rows = copied.map_err(|e| format!("导入失败：{e}"))?;

    let counts = db.with(count_all).map_err(|e| format!("导入后统计失败：{e}"))?;
    log::info!(
        "[backup] 已按 {} 导入 {} 行（曲目 {} / 歌单 {} / 记录 {}）",
        mode.as_str(),
        rows,
        counts.tracks,
        counts.playlists,
        counts.history
    );
    Ok(ImportSummary {
        mode: mode.as_str().to_string(),
        rows,
        tracks: counts.tracks,
        playlists: counts.playlists,
        history: counts.history,
        safety_copy,
    })
}

/// 校验并把副本升级到当前 schema。
fn prepare_copy(temp: &Path) -> Result<(), String> {
    if !crate::db::health::is_healthy(temp) {
        return Err("备份文件不是有效的 SQLite 数据库（完整性检查未通过）".into());
    }
    let conn = Connection::open(temp).map_err(|e| format!("打开备份文件失败：{e}"))?;
    let has_tracks: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'tracks'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if has_tracks == 0 {
        return Err("这不是轻听的备份文件（库里没有 tracks 表）".into());
    }
    // C19：先读版本，再决定要不要迁移。旧代码直接对新版本备份跑 `migrations::run`：
    // 所有已知版本都"已应用"，迁移本身跳过，但后面的 ensure_* 修复会就地改写副本，
    // 更糟的是旧代码还会用旧列语义去读新 schema 的数据。这种备份只能由新应用导入。
    let version = copy_schema_version(&conn).map_err(|e| format!("读取备份版本失败：{e}"))?;
    let supported = crate::db::migrations::CURRENT_VERSION;
    if version > supported {
        return Err(format!(
            "备份来自更高版本的轻听（备份 v{version}，当前只支持 v{supported}），请先升级应用再导入"
        ));
    }
    crate::db::migrations::run(&conn).map_err(|e| format!("备份文件的数据库结构无法升级：{e}"))?;
    Ok(())
}

/// 副本的 schema 版本；没有 `schema_migrations` 表（很老的备份）视为 0，交给迁移补齐。
fn copy_schema_version(conn: &Connection) -> Result<i64, rusqlite::Error> {
    let has_table: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
        [],
        |r| r.get(0),
    )?;
    if has_table == 0 {
        return Ok(0);
    }
    conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |r| r.get(0),
    )
}

/// 覆盖导入前的自动快照（失败即中止导入 —— 没有退路的覆盖不能做）。
fn safety_snapshot(db: &Database, dir: &Path) -> Result<PathBuf, String> {
    let stamp = file_stamp();
    let target = unique_path(dir, SAFETY_PREFIX, &stamp, "db");
    db.with(|conn| {
        conn.execute("VACUUM INTO ?1", [target.to_string_lossy().to_string()])?;
        Ok(())
    })
    .map_err(|e| format!("导入前快照失败（已放弃导入）：{e}"))?;
    log::info!("[backup] 导入前快照 {}", target.display());
    Ok(target)
}

/// 逐表复制；`excluded_keys` 非空时跳过这些键（只有 `settings` 表用得上）。
///
/// 过滤只加在 `settings` 这一张表上：它的 `key` 是主键，语义也是"按键跳过"；
/// 其他表主键各不相同，调用方传空切片即可。
fn copy_table_excluding(
    conn: &Connection,
    table: &str,
    mode: ImportMode,
    excluded_keys: &[&str],
) -> Result<i64, rusqlite::Error> {
    // 列名取两库交集：备份可能来自更老的 schema，副本虽然已被迁移补齐，
    // 但按实际列名拼 SQL 就不必假设列顺序，也不会因为缺列而整表失败
    let target_cols = columns(conn, "main", table)?;
    let source_cols = columns(conn, "backup_src", table)?;
    let cols: Vec<String> = target_cols
        .into_iter()
        .filter(|c| source_cols.contains(c))
        .collect();
    if cols.is_empty() {
        return Ok(0);
    }
    let list = cols.join(", ");
    let verb = match mode {
        // 合并：已有记录（同 id 或同唯一键）保持现状，绝不覆盖用户当前的歌单/歌词
        ImportMode::Merge => "INSERT OR IGNORE",
        ImportMode::Replace => "INSERT OR REPLACE",
    };
    let filter = if excluded_keys.is_empty() {
        String::new()
    } else {
        let marks = vec!["?"; excluded_keys.len()].join(", ");
        format!(" WHERE key NOT IN ({marks})")
    };
    let sql = format!("{verb} INTO main.{table} ({list}) SELECT {list} FROM backup_src.{table}{filter}");
    conn.execute(&sql, rusqlite::params_from_iter(excluded_keys.iter().copied()))
        .map(|n| n as i64)
}

/// `PRAGMA <schema>.table_info(<table>)` 的列名（第 1 列是 cid，第 2 列是 name）。
fn columns(conn: &Connection, schema: &str, table: &str) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(&format!("PRAGMA {schema}.table_info({table})"))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
    rows.collect()
}

/// 安全区设置的一行（键 / 值 / 更新时间）。
struct ProtectedSetting {
    key: String,
    value: String,
    updated_at: i64,
}

/// 读目标库里的安全区设置；没有这些键就返回空表，导入后也不会凭空造出来。
///
/// 在 ATTACH 之前调用，走默认的 `main` schema，不依赖挂载状态。
fn read_protected_settings(conn: &Connection) -> Result<Vec<ProtectedSetting>, rusqlite::Error> {
    let mut stmt =
        conn.prepare("SELECT key, value, updated_at FROM main.settings WHERE key IN (?1, ?2)")?;
    let rows = stmt.query_map(
        rusqlite::params![PROTECTED_SETTING_KEYS[0], PROTECTED_SETTING_KEYS[1]],
        |r| {
            Ok(ProtectedSetting {
                key: r.get(0)?,
                value: r.get(1)?,
                updated_at: r.get(2)?,
            })
        },
    )?;
    rows.collect()
}

/// 把目标库原有的安全区设置放回 `main.settings`（覆盖模式已被整表清掉，合并模式写回同值）。
fn restore_protected_settings(
    conn: &Connection,
    rows: &[ProtectedSetting],
) -> Result<(), rusqlite::Error> {
    for row in rows {
        conn.execute(
            "INSERT INTO main.settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            rusqlite::params![row.key, row.value, row.updated_at],
        )?;
    }
    Ok(())
}

fn count_one(conn: &Connection, table: &str) -> Result<i64, rusqlite::Error> {
    conn.query_row(&format!("SELECT COUNT(*) FROM main.{table}"), [], |r| r.get(0))
}

fn count_all(conn: &Connection) -> Result<Counts, rusqlite::Error> {
    Ok(Counts {
        tracks: count_one(conn, "tracks")?,
        playlists: count_one(conn, "playlists")?,
        liked_playlists: count_one(conn, "liked_playlists")?,
        history: count_one(conn, "play_history")?,
    })
}

/// 目标文件已存在时追加 `-2`、`-3`（同一秒内导两次不该互相覆盖）。
fn unique_path(dir: &Path, prefix: &str, stamp: &str, ext: &str) -> PathBuf {
    let first = dir.join(format!("{prefix}{stamp}.{ext}"));
    if !first.exists() {
        return first;
    }
    let mut n = 2;
    loop {
        let candidate = dir.join(format!("{prefix}{stamp}-{n}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// 文件名用的本地时间戳 "YYYY-MM-DD-HH-MM-SS"（`local_ts` 去掉毫秒）。
fn file_stamp() -> String {
    let ts = crate::file_logger::local_ts();
    let head = ts.split('.').next().unwrap_or("backup").to_string();
    head.replace([' ', ':'], "-")
}

/// 从命令行参数里取 `--export-backup <目录>` / `--export-backup=<目录>`。
pub fn export_dir_from_args(args: &[String]) -> Option<PathBuf> {
    let prefixed = format!("{EXPORT_FLAG}=");
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == EXPORT_FLAG {
            return Some(PathBuf::from(iter.next().map(String::as_str).unwrap_or(".")));
        }
        if let Some(rest) = arg.strip_prefix(&prefixed) {
            return Some(PathBuf::from(rest));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    struct OwnedImportDirectory(PathBuf);

    impl OwnedImportDirectory {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "quietmusic-owned-backup-{tag}-{}-{}", std::process::id(), fastrand::u64(..)
            ));
            std::fs::create_dir(&path).expect("create an exclusive owned backup fixture");
            Self(path)
        }
    }

    impl Drop for OwnedImportDirectory {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "quietmusic-backup-{tag}-{}-{}",
            std::process::id(),
            fastrand::u64(..)
        ));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    /// 直接写库，避免测试依赖上层命令；`tracks` 的必填列只有这几个。
    fn add_track(db: &Database, id: &str, title: &str) {
        db.with(|c| {
            c.execute(
                "INSERT INTO tracks (id, platform, title, singer, album, created_at, updated_at)
                 VALUES (?1, 'local', ?2, '', '', 1, 1)",
                rusqlite::params![id, title],
            )?;
            c.execute(
                "INSERT INTO play_history (id, track_id, played_at, played_duration_ms)
                 VALUES (?1, ?2, 5, 6)",
                rusqlite::params![format!("h-{id}"), id],
            )
        })
        .expect("写曲目");
    }

    fn has_track(db: &Database, id: &str) -> bool {
        db.with(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM tracks WHERE id = ?1",
                [id],
                |r| r.get::<_, i64>(0),
            )
        })
        .expect("查曲目")
            > 0
    }

    fn setting(db: &Database, key: &str) -> Option<String> {
        db.with(|c| crate::db::store::get_setting(c, key)).expect("读设置")
    }

    #[test]
    fn export_writes_a_readable_snapshot_and_a_manifest() {
        let dir = temp_dir("export");
        let db = Database::open(&dir.join("music.db")).expect("建库");
        db.with(|c| crate::db::store::set_setting(c, "backup.probe", "值"))
            .unwrap();
        add_track(&db, "local:C:/a.flac", "甲");

        let info = export(&db, &dir).expect("导出");
        assert!(Path::new(&info.path).is_file(), "快照文件应存在");
        assert_eq!(info.tracks, 1);
        assert_eq!(info.history, 1);
        assert_eq!(info.schema_version, crate::db::migrations::CURRENT_VERSION);

        // 快照能独立打开，且数据在里面
        let snap = Connection::open(&info.path).expect("打开快照");
        let value: String = snap
            .query_row(
                "SELECT value FROM settings WHERE key = 'backup.probe'",
                [],
                |r| r.get(0),
            )
            .expect("快照里应有设置");
        assert_eq!(value, "值");

        // 清单是合法 JSON，且写明了条数
        let text = std::fs::read_to_string(&info.manifest_path).expect("读清单");
        let json: serde_json::Value = serde_json::from_str(&text).expect("清单应是 JSON");
        assert_eq!(json["counts"]["tracks"], 1);
        assert_eq!(json["schemaVersion"], crate::db::migrations::CURRENT_VERSION);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn merge_import_adds_missing_rows_but_keeps_current_values() {
        let dir = temp_dir("merge");
        let source_dir = dir.join("source");
        std::fs::create_dir_all(&source_dir).unwrap();
        let source = Database::open(&source_dir.join("music.db")).expect("建源库");
        add_track(&source, "local:C:/a.flac", "甲");
        source
            .with(|c| crate::db::store::set_setting(c, "same.key", "备份值"))
            .unwrap();
        let snapshot = export(&source, &source_dir).expect("导出").path;

        let target = Database::open(&dir.join("target.db")).expect("建目标库");
        target
            .with(|c| crate::db::store::set_setting(c, "same.key", "当前值"))
            .unwrap();

        let first = import(&target, Path::new(&snapshot), ImportMode::Merge, &dir).expect("合并");
        assert!(first.rows > 0);
        assert!(first.safety_copy.is_none(), "合并不需要自动快照");
        assert!(has_track(&target, "local:C:/a.flac"));
        // 合并绝不覆盖当前值
        assert_eq!(setting(&target, "same.key").as_deref(), Some("当前值"));

        // 幂等：再合一次不会翻倍
        import(&target, Path::new(&snapshot), ImportMode::Merge, &dir).expect("再合并");
        assert_eq!(first.tracks, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn replace_import_swaps_the_data_and_keeps_a_safety_copy() {
        let dir = temp_dir("replace");
        let source_dir = dir.join("source");
        std::fs::create_dir_all(&source_dir).unwrap();
        let source = Database::open(&source_dir.join("music.db")).expect("建源库");
        add_track(&source, "local:C:/from-backup.flac", "备份曲");
        let snapshot = export(&source, &source_dir).expect("导出").path;

        let target = Database::open(&dir.join("target.db")).expect("建目标库");
        add_track(&target, "local:C:/current.flac", "当前曲");

        let summary =
            import(&target, Path::new(&snapshot), ImportMode::Replace, &dir).expect("覆盖导入");
        assert!(has_track(&target, "local:C:/from-backup.flac"), "备份数据应回来");
        assert!(!has_track(&target, "local:C:/current.flac"), "覆盖应清掉当前数据");

        // 自动快照里必须还能找回被覆盖掉的曲目
        let safety = summary.safety_copy.expect("覆盖模式应产出自动快照");
        let snap = Connection::open(&safety).expect("打开自动快照");
        let n: i64 = snap
            .query_row(
                "SELECT COUNT(*) FROM tracks WHERE id = 'local:C:/current.flac'",
                [],
                |r| r.get(0),
            )
            .expect("查快照");
        assert_eq!(n, 1, "自动快照应含导入前的数据");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_rejects_foreign_or_broken_files() {
        let dir = temp_dir("reject");
        let db = Database::open(&dir.join("music.db")).expect("建库");

        // ① 另一个 SQLite 库（没有 tracks 表）
        let foreign = dir.join("foreign.db");
        {
            let conn = Connection::open(&foreign).unwrap();
            conn.execute_batch("CREATE TABLE other (id TEXT PRIMARY KEY);")
                .unwrap();
        }
        let err = import(&db, &foreign, ImportMode::Merge, &dir).expect_err("应拒绝陌生库");
        assert!(err.contains("不是轻听的备份"), "实际报错：{err}");

        // ② 同名垃圾文件
        let junk = dir.join("junk.db");
        std::fs::write(&junk, b"not a database at all").unwrap();
        let err = import(&db, &junk, ImportMode::Merge, &dir).expect_err("应拒绝垃圾文件");
        assert!(err.contains("完整性检查未通过"), "实际报错：{err}");

        // ③ 不存在的路径
        let err = import(&db, &dir.join("nope.db"), ImportMode::Merge, &dir).expect_err("应报错");
        assert!(err.contains("找不到备份文件"), "实际报错：{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_dir_is_read_from_the_command_line() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            export_dir_from_args(&args(&["--export-backup", "D:/bak"])),
            Some(PathBuf::from("D:/bak"))
        );
        assert_eq!(
            export_dir_from_args(&args(&["--export-backup=D:/bak"])),
            Some(PathBuf::from("D:/bak"))
        );
        // 裸开关退化为当前目录，而不是当成"没传"
        assert_eq!(
            export_dir_from_args(&args(&["--export-backup"])),
            Some(PathBuf::from("."))
        );
        assert_eq!(export_dir_from_args(&args(&["C:/song.flac"])), None);
    }

    #[test]
    fn import_mode_parses_frontend_values() {
        assert_eq!(ImportMode::parse("replace").unwrap(), ImportMode::Replace);
        assert_eq!(ImportMode::parse("Merge").unwrap(), ImportMode::Merge);
        assert_eq!(ImportMode::parse(" 覆盖 ").unwrap(), ImportMode::Replace);
        assert!(ImportMode::parse("whatever").is_err());
    }

    /// 旧 `TABLES` 漏掉、但迁移 26 之后确实存在的表（C02 的回归清单）。
    const FEATURE_TABLES: &[&str] = &[
        "smart_playlists",
        "tag_edits",
        "track_ratings",
        "scrobbles",
        "podcast_shows",
        "podcast_episodes",
        "download_files",
        "orphan_files",
        "library_health_ignored",
    ];

    const SMART_PID: &str = "smart-backup-1";

    /// 被旧列表漏掉的表各写一行；智能歌单还要父表行和合法规则 JSON。
    fn add_feature_rows(db: &Database) {
        db.with(|c| {
            c.execute(
                "INSERT INTO playlists (id, name, is_smart, created_at, updated_at, pid)
                 VALUES ('pl-smart-backup', '智能歌单', 1, 1, 1, ?1)",
                [SMART_PID],
            )?;
            c.execute(
                "INSERT INTO smart_playlists (id, rules_json, limit_n, sort, updated_at)
                 VALUES ('pl-smart-backup', ?1, NULL, 'added_desc', 1)",
                [r#"{"matchAll":true,"rules":[{"field":"title","op":"contains","value":"甲"}]}"#],
            )?;
            c.execute(
                "INSERT INTO tag_edits (batch, path, before_json, at)
                 VALUES ('b1', 'D:/a.flac', '{}', 1)",
                [],
            )?;
            c.execute(
                "INSERT INTO track_ratings (key, rating, updated_at)
                 VALUES ('local:C:/a.flac', 5, 1)",
                [],
            )?;
            c.execute(
                "INSERT INTO scrobbles (target, track_id, artist, title, played_at)
                 VALUES ('lastfm', 'local:C:/a.flac', '甲', '甲', 1)",
                [],
            )?;
            c.execute(
                "INSERT INTO podcast_shows (id, url, title)
                 VALUES ('show1', 'https://example.com/feed.xml', '播客')",
                [],
            )?;
            c.execute(
                "INSERT INTO podcast_episodes (id, show_id, audio_url)
                 VALUES ('ep1', 'show1', 'https://example.com/ep1.mp3')",
                [],
            )?;
            c.execute(
                "INSERT INTO download_files (key, file_path, title, saved_at)
                 VALUES ('k1', 'D:/a.flac', '甲', 1)",
                [],
            )?;
            c.execute(
                "INSERT INTO orphan_files (file_path, title, indexed_at)
                 VALUES ('D:/b.flac', '乙', 1)",
                [],
            )?;
            c.execute(
                "INSERT INTO library_health_ignored (track_id, kind)
                 VALUES ('local:C:/a.flac', 'missing_file')",
                [],
            )?;
            Ok(())
        })
        .expect("写功能数据");
    }

    fn table_count(db: &Database, table: &str) -> i64 {
        db.with(|c| c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)))
            .expect("数行")
    }

    fn schema_tables(db: &Database) -> Vec<String> {
        db.with(|c| {
            let mut stmt = c.prepare(
                "SELECT name FROM sqlite_master
                  WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                  ORDER BY name",
            )?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
        .expect("读 schema 表清单")
    }

    fn foreign_key_violations(db: &Database) -> i64 {
        db.with(|c| {
            let mut stmt = c.prepare("PRAGMA foreign_key_check")?;
            let mut rows = stmt.query([])?;
            let mut n = 0i64;
            while rows.next()?.is_some() {
                n += 1;
            }
            Ok(n)
        })
        .expect("外键检查")
    }

    /// C02 的防回归：schema 新增表必须同步进 `TABLES`，否则导出看起来成功、导入静默丢数据。
    #[test]
    fn every_user_table_is_covered_by_the_backup_list() {
        let dir = temp_dir("coverage");
        let db = Database::open(&dir.join("music.db")).expect("建库");
        let tables = schema_tables(&db);
        assert!(tables.len() > 20, "schema 表清单异常：{tables:?}");

        for table in &tables {
            if table == "schema_migrations" {
                continue;
            }
            assert!(
                TABLES.contains(&table.as_str()),
                "备份列表漏了 {table}：换机导入会静默丢这张表"
            );
        }
        // 反向也查：列表里写了 schema 不存在的表，DELETE/INSERT 会直接报错
        for table in TABLES {
            assert!(
                tables.iter().any(|t| t == table),
                "备份列表里的 {table} 不在 schema 中"
            );
        }
        let mut sorted: Vec<&str> = TABLES.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), TABLES.len(), "备份列表有重复表");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// C02：合并导入必须把旧列表漏掉的表也搬回来，智能歌单不能只剩 playlists 壳。
    #[test]
    fn merge_import_restores_tables_missing_from_the_old_backup_list() {
        let dir = temp_dir("merge-feature");
        let source_dir = dir.join("source");
        std::fs::create_dir_all(&source_dir).unwrap();
        let source = Database::open(&source_dir.join("music.db")).expect("建源库");
        add_track(&source, "local:C:/a.flac", "甲");
        add_feature_rows(&source);
        let snapshot = export(&source, &source_dir).expect("导出").path;

        let target = Database::open(&dir.join("target.db")).expect("建目标库");
        import(&target, Path::new(&snapshot), ImportMode::Merge, &dir).expect("合并导入");

        for table in FEATURE_TABLES {
            assert_eq!(table_count(&target, table), 1, "{table} 应随备份恢复");
        }
        let meta = target
            .with(|c| crate::smart_playlist::smart_playlist(c, SMART_PID))
            .expect("查智能歌单")
            .expect("智能歌单应存在");
        assert_eq!(meta.name, "智能歌单");
        assert_eq!(meta.rules.rules.len(), 1, "规则必须一起回来");
        assert_eq!(
            foreign_key_violations(&target),
            0,
            "导入后不能留下外键孤儿"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// C02：覆盖导入要换掉目标库里的旧智能歌单，并且不能因为级联删除留下孤儿。
    #[test]
    fn replace_import_restores_smart_rules_and_leaves_no_foreign_keys() {
        let dir = temp_dir("replace-feature");
        let source_dir = dir.join("source");
        std::fs::create_dir_all(&source_dir).unwrap();
        let source = Database::open(&source_dir.join("music.db")).expect("建源库");
        add_track(&source, "local:C:/from-backup.flac", "备份曲");
        add_feature_rows(&source);
        let snapshot = export(&source, &source_dir).expect("导出").path;

        let target = Database::open(&dir.join("target.db")).expect("建目标库");
        add_track(&target, "local:C:/current.flac", "当前曲");
        // 目标里已有一份同 pid 的智能歌单：覆盖后必须换成备份里的规则，不能级联丢
        target
            .with(|c| {
                c.execute(
                    "INSERT INTO playlists (id, name, is_smart, created_at, updated_at, pid)
                     VALUES ('pl-target-smart', '旧智能', 1, 1, 1, ?1)",
                    [SMART_PID],
                )?;
                c.execute(
                    "INSERT INTO smart_playlists (id, rules_json, limit_n, sort, updated_at)
                     VALUES ('pl-target-smart', '{\"matchAll\":false,\"rules\":[]}', NULL, 'title', 1)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();

        import(&target, Path::new(&snapshot), ImportMode::Replace, &dir).expect("覆盖导入");
        assert!(!has_track(&target, "local:C:/current.flac"), "覆盖应清掉当前曲目");
        assert!(has_track(&target, "local:C:/from-backup.flac"));
        for table in FEATURE_TABLES {
            assert_eq!(table_count(&target, table), 1, "{table} 应随备份恢复");
        }
        let meta = target
            .with(|c| crate::smart_playlist::smart_playlist(c, SMART_PID))
            .expect("查智能歌单")
            .expect("备份的智能歌单应回来");
        assert_eq!(meta.sort, "added_desc");
        assert_eq!(meta.rules.rules.len(), 1, "智能歌单规则不能被覆盖成空壳");
        assert!(meta.rules.match_all);
        assert_eq!(
            foreign_key_violations(&target),
            0,
            "覆盖导入后不能留下外键孤儿"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// C19：更高版本 App 导出的备份必须明确拒绝，而且要在动目标库之前。
    #[test]
    fn import_rejects_backups_from_a_newer_app_schema() {
        let dir = temp_dir("future");
        let source_dir = dir.join("source");
        std::fs::create_dir_all(&source_dir).unwrap();
        let source = Database::open(&source_dir.join("music.db")).expect("建源库");
        add_track(&source, "local:C:/a.flac", "甲");
        let snapshot = export(&source, &source_dir).expect("导出").path;

        // 模拟「用更新版本 App 导出」：把版本戳改到当前支持版本的下一版
        let future_version = crate::db::migrations::CURRENT_VERSION + 1;
        {
            let conn = Connection::open(&snapshot).expect("打开快照");
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, 0)",
                [future_version],
            )
            .expect("写未来版本");
        }

        let target = Database::open(&dir.join("target.db")).expect("建目标库");
        let err = import(&target, Path::new(&snapshot), ImportMode::Merge, &dir)
            .expect_err("应拒绝更高版本的备份");
        assert!(err.contains("更高版本"), "实际报错：{err}");
        assert!(err.contains(&format!("v{future_version}")), "报错应写明备份版本：{err}");

        // 拒绝要在导入/迁移之前：目标库仍是空的，临时副本也要清掉
        assert_eq!(table_count(&target, "tracks"), 0, "拒绝后不该导入任何数据");
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("import-")
            })
            .count();
        assert_eq!(leftovers, 0, "被拒绝的导入应清掉临时副本");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn public_import_future_into_nonempty_merge_rejects_without_mutation() {
        exercise_public_future_nonempty(ImportMode::Merge);
    }

    #[test]
    fn public_import_future_into_nonempty_replace_rejects_without_mutation() {
        exercise_public_future_nonempty(ImportMode::Replace);
    }

    fn exercise_public_future_nonempty(mode: ImportMode) {
        let current_version = crate::db::migrations::CURRENT_VERSION;
        let future_version = current_version + 1;
        let directory = OwnedImportDirectory::new(mode.as_str());
        let backup_path = directory.0.join(format!("future-v{future_version}.db"));
        {
            let source = Database::open(&backup_path).unwrap();
            add_track(&source, "owned-future-track", "future source");
            source.with(|conn| conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")).unwrap();
        }
        {
            let future = Connection::open(&backup_path).unwrap();
            future.execute_batch(&format!("CREATE TABLE owned_future_feature (value TEXT NOT NULL);
                INSERT INTO owned_future_feature VALUES ('future schema data');
                INSERT INTO schema_migrations (version, applied_at) VALUES ({future_version}, 0);
                PRAGMA journal_mode = DELETE;")).unwrap();
        }
        let original_source = std::fs::read(&backup_path).unwrap();
        let target_path = directory.0.join("nonempty-target.db");
        let target = Database::open(&target_path).unwrap();
        add_track(&target, "owned-live-track", "live target");
        target.with(|conn| {
            crate::db::store::set_setting(conn, "owned.future.key", "live setting")?;
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        }).unwrap();
        let original_target = std::fs::read(&target_path).unwrap();
        let target_wal = PathBuf::from(format!("{}-wal", target_path.display()));
        let original_wal = std::fs::read(&target_wal).ok();
        let original_counts = TABLES.iter().map(|table| table_count(&target, table)).collect::<Vec<_>>();
        let work = directory.0.join("import-work");
        let error = import(&target, &backup_path, mode, &work).unwrap_err();
        assert!(error.contains("更高版本") && error.contains(&format!("v{future_version}")) && error.contains(&format!("v{current_version}")));
        assert_eq!(std::fs::read(&backup_path).unwrap(), original_source);
        assert_eq!(std::fs::read(&target_path).unwrap(), original_target);
        assert_eq!(std::fs::read(&target_wal).ok(), original_wal, "rejection must not write target WAL");
        assert_eq!(TABLES.iter().map(|table| table_count(&target, table)).collect::<Vec<_>>(), original_counts);
        assert!(has_track(&target, "owned-live-track") && !has_track(&target, "owned-future-track"));
        assert_eq!(setting(&target, "owned.future.key").as_deref(), Some("live setting"));
        assert_eq!(std::fs::read_dir(&work).unwrap().count(), 0, "future rejection must leave neither an import copy nor a Replace safety snapshot");
        let future = Connection::open_with_flags(&backup_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(future.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), future_version);
        assert_eq!(future.query_row("SELECT value FROM owned_future_feature", [], |row| row.get::<_, String>(0)).unwrap(), "future schema data");
        drop(future);
        drop(target);
    }

    #[test]
    fn public_import_v25_into_nonempty_merge_preserves_conflicts_and_source() {
        assert_eq!(crate::db::migrations::CURRENT_VERSION, 28, "fixture removes only the known v26-v28 podcast additions");
        let directory = OwnedImportDirectory::new("v25-merge");
        let backup_path = directory.0.join("old-v25.db");
        {
            let source = Database::open(&backup_path).unwrap();
            add_track(&source, "owned-shared", "backup title");
            add_track(&source, "owned-from-v25", "old imported track");
            source.with(|conn| crate::db::store::set_setting(conn, "owned.merge.key", "backup value")).unwrap();
            source.with(|conn| conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")).unwrap();
        }
        {
            let old = Connection::open(&backup_path).unwrap();
            // Build the actual pre-podcast schema, not a current database with a renamed version stamp.
            old.execute_batch("DROP TABLE podcast_subtitles; DROP TABLE podcast_episodes; DROP TABLE podcast_shows;
                DELETE FROM schema_migrations WHERE version >= 26; PRAGMA journal_mode = DELETE;").unwrap();
            assert_eq!(old.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), 25);
            assert_eq!(old.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('podcast_shows', 'podcast_episodes', 'podcast_subtitles', 'idx_podcast_episodes_show')", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        }
        let original_source = std::fs::read(&backup_path).unwrap();
        let target = Database::open(&directory.0.join("nonempty-target.db")).unwrap();
        add_track(&target, "owned-shared", "live title");
        add_track(&target, "owned-target-only", "target unique track");
        let target_playlist = target.with(|conn| crate::db::store::create_playlist(conn, "target unique playlist")).unwrap();
        target.with(|conn| {
            crate::db::store::set_setting(conn, "owned.merge.key", "live value")?;
            conn.execute("UPDATE play_history SET played_duration_ms = 66 WHERE track_id = 'owned-shared'", [])?;
            conn.execute("INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
                SELECT id, 'owned-target-only', 0, 1 FROM playlists WHERE pid = ?1", [&target_playlist])?;
            Ok(())
        }).unwrap();
        assert_eq!(table_count(&target, "tracks"), 2);
        let work = directory.0.join("import-work");
        let result = import(&target, &backup_path, ImportMode::Merge, &work).unwrap();
        assert_eq!(result.mode, "merge");
        assert!(result.safety_copy.is_none());
        assert!(result.rows > 0);
        assert_eq!(result.tracks, 3);
        assert_eq!(result.history, 3);
        assert!(has_track(&target, "owned-from-v25") && has_track(&target, "owned-target-only"));
        assert_eq!(target.with(|conn| conn.query_row("SELECT title FROM tracks WHERE id = 'owned-shared'", [], |row| row.get::<_, String>(0))).unwrap(), "live title");
        assert_eq!(setting(&target, "owned.merge.key").as_deref(), Some("live value"));
        assert_eq!(target.with(|conn| conn.query_row("SELECT played_duration_ms FROM play_history WHERE track_id = 'owned-shared'", [], |row| row.get::<_, i64>(0))).unwrap(), 66);
        assert_eq!(target.with(|conn| conn.query_row("SELECT COUNT(*) FROM playlist_tracks pt JOIN playlists p ON p.id = pt.playlist_id WHERE p.pid = ?1 AND pt.track_id = 'owned-target-only'", [&target_playlist], |row| row.get::<_, i64>(0))).unwrap(), 1);
        assert_eq!(target.with(|conn| conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get::<_, i64>(0))).unwrap(), 0);
        assert_eq!(std::fs::read(&backup_path).unwrap(), original_source, "migration must touch only the import copy");
        let old = Connection::open_with_flags(&backup_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(old.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), 25);
        assert_eq!(old.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('podcast_shows', 'podcast_episodes', 'podcast_subtitles')", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(std::fs::read_dir(&work).unwrap().count(), 0, "the actual migrated import copy must be cleaned up");
        drop(old);
        drop(target);
    }

    #[test]
    fn public_import_v25_into_nonempty_replace_keeps_actual_safety_snapshot() {
        assert_eq!(crate::db::migrations::CURRENT_VERSION, 28, "fixture removes only the known v26-v28 podcast additions");
        let directory = OwnedImportDirectory::new("v25-replace");
        let backup_path = directory.0.join("old-v25.db");
        {
            let source = Database::open(&backup_path).unwrap();
            add_track(&source, "owned-shared", "backup title");
            add_track(&source, "owned-from-v25", "old imported track");
            source.with(|conn| crate::db::store::set_setting(conn, "owned.merge.key", "backup value")).unwrap();
            source.with(|conn| conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")).unwrap();
        }
        {
            let old = Connection::open(&backup_path).unwrap();
            old.execute_batch("DROP TABLE podcast_subtitles; DROP TABLE podcast_episodes; DROP TABLE podcast_shows;
                DELETE FROM schema_migrations WHERE version >= 26; PRAGMA journal_mode = DELETE;").unwrap();
            assert_eq!(old.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), 25);
            assert_eq!(old.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('podcast_shows', 'podcast_episodes', 'podcast_subtitles', 'idx_podcast_episodes_show')", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        }
        let original_source = std::fs::read(&backup_path).unwrap();
        let target = Database::open(&directory.0.join("nonempty-target.db")).unwrap();
        add_track(&target, "owned-shared", "live title");
        add_track(&target, "owned-target-only", "target unique track");
        let target_playlist = target.with(|conn| crate::db::store::create_playlist(conn, "target unique playlist")).unwrap();
        target.with(|conn| {
            crate::db::store::set_setting(conn, "owned.merge.key", "live value")?;
            conn.execute("UPDATE play_history SET played_duration_ms = 66 WHERE track_id = 'owned-shared'", [])?;
            conn.execute("INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
                SELECT id, 'owned-target-only', 0, 1 FROM playlists WHERE pid = ?1", [&target_playlist])?;
            Ok(())
        }).unwrap();
        let work = directory.0.join("import-work");
        let result = import(&target, &backup_path, ImportMode::Replace, &work).unwrap();
        assert_eq!(result.mode, "replace");
        assert_eq!(result.tracks, 2);
        assert_eq!(result.history, 2);
        assert!(has_track(&target, "owned-from-v25") && !has_track(&target, "owned-target-only"));
        assert_eq!(target.with(|conn| conn.query_row("SELECT title FROM tracks WHERE id = 'owned-shared'", [], |row| row.get::<_, String>(0))).unwrap(), "backup title");
        assert_eq!(setting(&target, "owned.merge.key").as_deref(), Some("backup value"));
        assert_eq!(target.with(|conn| conn.query_row("SELECT played_duration_ms FROM play_history WHERE track_id = 'owned-shared'", [], |row| row.get::<_, i64>(0))).unwrap(), 6);
        assert_eq!(target.with(|conn| conn.query_row("SELECT COUNT(*) FROM playlists WHERE pid = ?1", [&target_playlist], |row| row.get::<_, i64>(0))).unwrap(), 0);
        assert_eq!(target.with(|conn| conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get::<_, i64>(0))).unwrap(), 0);
        let safety_path = PathBuf::from(result.safety_copy.unwrap());
        assert!(safety_path.starts_with(&work) && safety_path.is_file());
        let safety = Connection::open_with_flags(&safety_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(safety.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), crate::db::migrations::CURRENT_VERSION);
        assert_eq!(safety.query_row("SELECT title FROM tracks WHERE id = 'owned-shared'", [], |row| row.get::<_, String>(0)).unwrap(), "live title");
        assert_eq!(safety.query_row("SELECT COUNT(*) FROM tracks WHERE id = 'owned-target-only'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(safety.query_row("SELECT value FROM settings WHERE key = 'owned.merge.key'", [], |row| row.get::<_, String>(0)).unwrap(), "live value");
        assert_eq!(safety.query_row("SELECT played_duration_ms FROM play_history WHERE track_id = 'owned-shared'", [], |row| row.get::<_, i64>(0)).unwrap(), 66);
        assert_eq!(safety.query_row("SELECT COUNT(*) FROM playlist_tracks pt JOIN playlists p ON p.id = pt.playlist_id WHERE p.pid = ?1 AND pt.track_id = 'owned-target-only'", [&target_playlist], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(safety.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(std::fs::read(&backup_path).unwrap(), original_source);
        let old = Connection::open_with_flags(&backup_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(old.query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row.get::<_, i64>(0)).unwrap(), 25);
        assert_eq!(old.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('podcast_shows', 'podcast_episodes', 'podcast_subtitles')", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(std::fs::read_dir(&work).unwrap().count(), 1, "only the genuine pre-Replace safety snapshot may remain");
        drop(old);
        drop(safety);
        drop(target);
    }

    /// 两个属于本机安全区的设置键（与 `PROTECTED_SETTING_KEYS` 保持一致）。
    const SESSION_KEY: &str = crate::astral::SETTING_ASTRAL_SESSION;
    const CLEANUP_MARKER_KEY: &str = "astral.secureStorageVersion";

    fn seed_security_settings(db: &Database, session: Option<&str>, marker: Option<&str>) {
        db.with(|c| {
            if let Some(session) = session {
                crate::db::store::set_setting(c, SESSION_KEY, session)?;
            }
            if let Some(marker) = marker {
                crate::db::store::set_setting(c, CLEANUP_MARKER_KEY, marker)?;
            }
            Ok(())
        })
        .expect("写安全区设置");
    }

    /// 合并导入：源的会话/清理标记不能进目标库，目标自己的值要留着（task-12）。
    #[test]
    fn merge_import_skips_security_settings_from_the_source() {
        let dir = temp_dir("merge-protected");
        let source_dir = dir.join("source");
        std::fs::create_dir_all(&source_dir).unwrap();
        let source = Database::open(&source_dir.join("music.db")).expect("建源库");
        seed_security_settings(&source, Some(r#"{"token":"source-token"}"#), Some("1"));
        source
            .with(|c| crate::db::store::set_setting(c, "ui.theme", "dark"))
            .unwrap();
        let snapshot = export(&source, &source_dir).expect("导出").path;

        let target = Database::open(&dir.join("target.db")).expect("建目标库");
        seed_security_settings(&target, Some(r#"{"token":"target-token"}"#), None);
        target
            .with(|c| crate::db::store::set_setting(c, "ui.theme", "light"))
            .unwrap();

        import(&target, Path::new(&snapshot), ImportMode::Merge, &dir).expect("合并");

        // 目标自己的会话保留；源机器的"已清理"标记不能当成本机已清理
        assert_eq!(setting(&target, SESSION_KEY).as_deref(), Some(r#"{"token":"target-token"}"#));
        assert_eq!(setting(&target, CLEANUP_MARKER_KEY), None, "源里的清理标记不该被导入");
        // 普通设置照旧走合并语义（目标已有值优先）
        assert_eq!(setting(&target, "ui.theme").as_deref(), Some("light"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 覆盖导入：settings 整表被清掉后，只还原目标原有的安全区行；源里的一律丢弃。
    #[test]
    fn replace_import_keeps_target_security_settings_and_drops_source_ones() {
        let dir = temp_dir("replace-protected");
        let source_dir = dir.join("source");
        std::fs::create_dir_all(&source_dir).unwrap();
        let source = Database::open(&source_dir.join("music.db")).expect("建源库");
        seed_security_settings(&source, Some(r#"{"token":"source-token"}"#), Some("1"));
        source
            .with(|c| crate::db::store::set_setting(c, "ui.theme", "dark"))
            .unwrap();
        let snapshot = export(&source, &source_dir).expect("导出").path;

        let target = Database::open(&dir.join("target.db")).expect("建目标库");
        seed_security_settings(&target, Some(r#"{"token":"target-token"}"#), None);

        import(&target, Path::new(&snapshot), ImportMode::Replace, &dir).expect("覆盖导入");

        assert_eq!(setting(&target, SESSION_KEY).as_deref(), Some(r#"{"token":"target-token"}"#));
        assert_eq!(setting(&target, CLEANUP_MARKER_KEY), None, "目标没有的标记不该从源里补上");
        // 非安全区的设置随覆盖导入更新
        assert_eq!(setting(&target, "ui.theme").as_deref(), Some("dark"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 两种模式都必须保留目标已有的安全区值（源里没有这些键也不能把目标的值删掉）。
    #[test]
    fn protected_settings_keep_target_values_in_both_modes() {
        for mode in [ImportMode::Merge, ImportMode::Replace] {
            let tag = match mode {
                ImportMode::Merge => "merge-protected-keep",
                ImportMode::Replace => "replace-protected-keep",
            };
            let dir = temp_dir(tag);
            let source_dir = dir.join("source");
            std::fs::create_dir_all(&source_dir).unwrap();
            let source = Database::open(&source_dir.join("music.db")).expect("建源库");
            // 源里只有会话，没有清理标记
            seed_security_settings(&source, Some(r#"{"token":"source-token"}"#), None);
            let snapshot = export(&source, &source_dir).expect("导出").path;

            let target = Database::open(&dir.join("target.db")).expect("建目标库");
            seed_security_settings(
                &target,
                Some(r#"{"token":"target-token","machine":"target"}"#),
                Some("1"),
            );

            import(&target, Path::new(&snapshot), mode, &dir).expect("导入");

            assert_eq!(
                setting(&target, SESSION_KEY).as_deref(),
                Some(r#"{"token":"target-token","machine":"target"}"#),
                "{mode:?} 不能覆盖目标会话"
            );
            assert_eq!(
                setting(&target, CLEANUP_MARKER_KEY).as_deref(),
                Some("1"),
                "{mode:?} 不能把目标的清理标记删掉"
            );

            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
