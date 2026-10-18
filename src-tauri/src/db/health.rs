//! 数据库健康检查 / 损坏自愈 / 启动滚动备份（旧清单 P0②）。
//!
//! 为什么需要这一层：SQLite 文件损坏（断电、磁盘坏道、杀进程杀在 checkpoint 中间）
//! 之前的表现为"应用起不来且无提示"——`Database::open` 直接返回 Err，`lib.rs` 把它
//! 降级成"本次运行无持久化"，用户看到的是"歌单/记录全没了"，而且**每次启动都一样**，
//! 旧文件还压在那里没人知道。这里的口径是：
//! 1. 启动前体检（`PRAGMA integrity_check`）；
//! 2. 判定损坏就**改名隔离**（不删！用户还能拿去抢救）+ 重建空库；
//! 3. 健康则做一份滚动备份，保留最近 `KEEP_BACKUPS` 份，坏的那天有得回滚；
//! 4. 把"发生过自愈"记成一次性说明，界面如实告诉用户而不是静默重置。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;

/// 滚动备份保留份数：再多只占盘，真回滚也用不到第 4 份
const KEEP_BACKUPS: usize = 3;
/// 备份文件名前缀（`<前缀><unix 秒>`）；等宽数字，按文件名排序即按时间排序
const BACKUP_PREFIX: &str = "music.db.bak-";
/// 隔离损坏库时插在扩展名前的标记
const CORRUPT_MARK: &str = ".corrupt-";

/// 「本次启动发生过数据库自愈」的一次性说明（进程内，取走即消失）
static NOTICE: Mutex<Option<String>> = Mutex::new(None);

/// 记下自愈说明（同时落日志，IM 不问界面也能从日志看到）
pub fn set_notice(text: String) {
    log::warn!("[db] {text}");
    let mut slot = NOTICE.lock().unwrap_or_else(|e| e.into_inner());
    *slot = Some(text);
}

/// 取走自愈说明。取空是原子的 —— 前端挂载时取一次，不会重复提示。
pub fn take_notice() -> Option<String> {
    NOTICE.lock().unwrap_or_else(|e| e.into_inner()).take()
}

/// 体检：能打开、且 `PRAGMA integrity_check` 全部返回 ok。
///
/// 用**读写**连接而不是只读连接：带热 WAL 的库只读打开会直接失败（SQLite 需要写
/// `-shm` 做恢复），那样会把一个好库判成坏库并隔离 —— 是破坏性误判。读写打开还能
/// 顺带让 SQLite 自己把 WAL 恢复掉。
pub fn is_healthy(path: &Path) -> bool {
    match Connection::open(path) {
        Ok(conn) => integrity_ok(&conn),
        Err(e) => {
            log::warn!("[db] 体检打不开 {}: {e}", path.display());
            false
        }
    }
}

/// `integrity_check` 是否全绿。返回多行时只要有一行不是 `ok` 就算坏。
fn integrity_ok(conn: &Connection) -> bool {
    let mut stmt = match conn.prepare("PRAGMA integrity_check") {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[db] integrity_check 无法执行: {e}");
            return false;
        }
    };
    let mut rows = match stmt.query([]) {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[db] integrity_check 无法执行: {e}");
            return false;
        }
    };
    let mut any = false;
    loop {
        match rows.next() {
            Ok(Some(row)) => {
                any = true;
                match row.get::<_, String>(0) {
                    Ok(text) if text.eq_ignore_ascii_case("ok") => {}
                    Ok(text) => {
                        log::warn!("[db] integrity_check 报错: {text}");
                        return false;
                    }
                    Err(e) => {
                        log::warn!("[db] integrity_check 结果无法读取: {e}");
                        return false;
                    }
                }
            }
            Ok(None) => break,
            Err(e) => {
                log::warn!("[db] integrity_check 中断: {e}");
                return false;
            }
        }
    }
    any
}

/// 把损坏的库连同 `-wal` / `-shm` 一起改名隔离，返回隔离后的主文件名。
///
/// **只改名不删除**：这些文件是用户唯一的歌单/播放记录，能不能抢救由用户/工具决定，
/// 程序没有资格替他们扔掉。`-wal`/`-shm` 必须一起挪走，否则新建的空库会被残留的
/// WAL 认领，等于立刻又坏一次。
pub fn quarantine(path: &Path) -> Option<PathBuf> {
    let stamp = unix_now();
    let mut main_new = None;
    for suffix in ["", "-wal", "-shm"] {
        let from = if suffix.is_empty() {
            path.to_path_buf()
        } else {
            PathBuf::from(format!("{}{suffix}", path.display()))
        };
        if !from.exists() {
            continue;
        }
        let Some(name) = from.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        let dest = from.with_file_name(format!("{name}{CORRUPT_MARK}{stamp}"));
        match std::fs::rename(&from, &dest) {
            Ok(()) => {
                log::info!("[db] 已隔离 {} → {}", from.display(), dest.display());
                if suffix.is_empty() {
                    main_new = Some(dest);
                }
            }
            Err(e) => log::error!("[db] 隔离失败 {}: {e}", from.display()),
        }
    }
    main_new
}

/// 滚动备份：`VACUUM INTO` 一份整理过的单文件快照，并把旧份数裁到 `KEEP_BACKUPS`。
///
/// 为什么不用"复制 `music.db`"：WAL 模式下未 checkpoint 的写入还在 `-wal` 里，
/// 直接复制出来的 `.db` 会**静默地少一截数据**——备份看起来成功，回滚时才发现是旧的。
/// `VACUUM INTO` 由 SQLite 自己产出内容一致的单文件快照，顺带整理碎片。
pub fn rolling_backup(conn: &Connection, dir: &Path) -> Option<PathBuf> {
    // VACUUM INTO 的目标文件必须不存在，所以同一秒内再备一次要换名字
    let target = next_backup_path(dir);
    if let Err(e) = conn.execute("VACUUM INTO ?1", [target.to_string_lossy().to_string()]) {
        log::warn!("[db] 滚动备份失败: {e}");
        return None;
    }
    prune_backups(dir);
    log::info!("[db] 已滚动备份到 {}", target.display());
    Some(target)
}

/// 下一份备份的文件名：`<前缀><unix 秒>-<序号>`。
///
/// 序号**总是**带上（即使该秒内是第一份）：因为 `prune_backups` 按名字排序删最旧的，
/// 而"裸名字"（`…bak-<秒>`）排序时排在 `…bak-<秒>-1` 前面 —— 若第一份用裸名字、后续用
/// 带序号的，第一份会被优先删掉倒也无妨，但**同一秒内新建的裸名字会再次排到最前**，
/// 于是"刚备份好就被当成最旧的裁掉"。统一带序号即可让名字严格单调。
fn next_backup_path(dir: &Path) -> PathBuf {
    let stamp = unix_now();
    let max_sub = std::fs::read_dir(dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter_map(|name| {
            let rest = name.strip_prefix(BACKUP_PREFIX)?;
            let (secs, sub) = match rest.split_once('-') {
                Some((secs, sub)) => (secs, Some(sub)),
                None => (rest, None),
            };
            if secs.parse::<u64>().ok()? != stamp {
                return None;
            }
            // 裸名字（老版本留下的）当作序号 1
            Some(sub.and_then(|s| s.parse::<u32>().ok()).unwrap_or(1))
        })
        .max();
    match max_sub {
        Some(max) => dir.join(format!("{BACKUP_PREFIX}{stamp}-{}", max + 1)),
        None => dir.join(format!("{BACKUP_PREFIX}{stamp}-1")),
    }
}

/// 只留最近 `KEEP_BACKUPS` 份（名字里是等宽 unix 秒，字典序即时间序）。
fn prune_backups(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| n.starts_with(BACKUP_PREFIX))
        .collect();
    if names.len() <= KEEP_BACKUPS {
        return;
    }
    names.sort();
    for name in names.iter().take(names.len() - KEEP_BACKUPS) {
        if let Err(e) = std::fs::remove_file(dir.join(name)) {
            log::warn!("[db] 清理旧备份失败 {name}: {e}");
        }
    }
}

/// 当前 Unix 秒（备份文件名与清单时间戳共用；`backup.rs` 也要用，所以是 crate 可见）
pub(crate) fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 进程唯一临时目录（与本项目其它测试同口径）
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "quietmusic-dbhealth-{tag}-{}-{}",
            std::process::id(),
            fastrand::u64(..)
        ));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    #[test]
    fn integrity_check_flags_garbage_and_passes_on_a_real_db() {
        let dir = temp_dir("integrity");
        let good = dir.join("music.db");
        let db = crate::db::Database::open(&good).expect("建库");
        drop(db);
        assert!(is_healthy(&good), "刚建的库应体检通过");

        let bad = dir.join("bad.db");
        std::fs::write(&bad, b"not a sqlite file, just garbage with the same name").expect("写垃圾文件");
        assert!(!is_healthy(&bad), "非数据库文件必须被判为坏");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn quarantine_renames_db_and_its_wal_siblings() {
        let dir = temp_dir("quarantine");
        let db = dir.join("music.db");
        std::fs::write(&db, b"corrupt db").expect("写坏库");
        std::fs::write(dir.join("music.db-wal"), b"wal").expect("写 wal");
        std::fs::write(dir.join("music.db-shm"), b"shm").expect("写 shm");

        let moved = quarantine(&db).expect("应隔离主文件");
        assert!(!db.exists(), "原文件不应还在原名上");
        let moved_name = moved.file_name().unwrap().to_string_lossy().to_string();
        assert!(moved_name.starts_with("music.db.corrupt-"), "实际: {moved_name}");
        // 残留的 -wal/-shm 会把新建的空库又带坏，必须一起挪走
        let stamp = moved_name.trim_start_matches("music.db.corrupt-").to_string();
        assert!(!dir.join("music.db-wal").exists());
        assert!(!dir.join("music.db-shm").exists());
        assert!(dir.join(format!("music.db-wal.corrupt-{stamp}")).exists());
        assert!(dir.join(format!("music.db-shm.corrupt-{stamp}")).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rolling_backup_is_a_readable_snapshot_and_prunes_old_ones() {
        let dir = temp_dir("backup");
        let db_path = dir.join("music.db");
        let db = crate::db::Database::open(&db_path).expect("建库");
        db.with(|c| crate::db::store::set_setting(c, "backup.probe", "值"))
            .unwrap();

        // 连备 5 次：应只剩 KEEP_BACKUPS 份，且最后一份内容完整（能打开、设置读得出）
        let mut last = None;
        for _ in 0..5 {
            last = db.with(|c| Ok(rolling_backup(c, &dir))).unwrap();
        }
        let backups: Vec<PathBuf> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with(BACKUP_PREFIX))
            })
            .collect();
        assert_eq!(backups.len(), KEEP_BACKUPS, "应裁到 {KEEP_BACKUPS} 份");

        let snap = last.expect("应产出备份");
        assert!(snap.exists(), "最后一份备份不该被裁掉");
        let conn = Connection::open(&snap).expect("备份应能打开");
        let value: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'backup.probe'",
                [],
                |r| r.get(0),
            )
            .expect("备份里应有写入的数据");
        assert_eq!(value, "值");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
