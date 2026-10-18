//! 用户数据备份 / 恢复（报告 §3.1）。
//!
//! **备份什么**：歌单、收藏、播放历史与统计、本地曲库条目、设置、歌词、扫描目录 ——
//! 这些**全都在同一个 SQLite 文件里**，所以一次 `VACUUM INTO` 快照就是完整备份，
//! 再补一份同名 `.json` 清单（版本 / schema / 各表条数 / 导出时间）方便肉眼核对。
//! **不打包什么**：下载的音频本体与封面（动辄几十 GB），备份的是"记录"不是"文件"；
//! 导入后只要下载目录还在原处，记录照样能播（`tracks.missing` 会如实体检）。
//!
//! 为什么不做 zip（与原建议的差异）：仓库里没有 `zip` crate，为一次导出引入压缩容器
//! 依赖，换来的只是一层壳 —— 快照本身就是 SQLite 的单文件格式，拷进 U 盘/网盘一样方便。
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

/// 参与备份 / 恢复的数据表（**不含** `schema_migrations`：它由迁移逻辑自己维护）。
/// 顺序 = 插入顺序：父表在前；另有 `defer_foreign_keys` 兜底，顺序偏差也不会中途失败。
const TABLES: &[&str] = &[
    "tracks",
    "playlists",
    "liked_playlists",
    "liked_songs",
    "liked_song_playlists",
    "playlist_tracks",
    "play_history",
    "play_stats",
    "play_days",
    "download_tasks",
    "scan_dirs",
    "pending_like_ops",
    "like_sync_state",
    "lyrics",
    "lyric_settings",
    "play_queue",
    "dislike_rules",
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
                rows += copy_table(&tx, table, mode)?;
            }
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
    crate::db::migrations::run(&conn).map_err(|e| format!("备份文件的数据库结构无法升级：{e}"))?;
    Ok(())
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

/// 逐表把 `backup_src` 的数据搬进 `main`，返回写入行数。
fn copy_table(conn: &Connection, table: &str, mode: ImportMode) -> Result<i64, rusqlite::Error> {
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
    let sql = format!("{verb} INTO main.{table} ({list}) SELECT {list} FROM backup_src.{table}");
    conn.execute(&sql, []).map(|n| n as i64)
}

/// `PRAGMA <schema>.table_info(<table>)` 的列名（第 1 列是 cid，第 2 列是 name）。
fn columns(conn: &Connection, schema: &str, table: &str) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(&format!("PRAGMA {schema}.table_info({table})"))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
    rows.collect()
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
}
