//! 播放缓存的体积上限与选择性清理（设置页「通用」分区）。
//!
//! 上限策略：LRU —— 超过上限时优先删除最久未使用的流缓存文件，
//! 正在播放的那条流（`keep`）永不删除。网页缓存（WebView2 的 HTTP /
//! 脚本缓存）只做手动清理，且只删「纯缓存」子目录，绝不碰
//! Local Storage / Cookies / IndexedDB 等用户数据（界面设置与登录态）。

use std::io;
use std::path::{Path, PathBuf};

/// settings 键：播放缓存上限（MB；"0" = 不限）。引擎侧写入（SetCacheLimit），
/// 设置页读它做回显。
pub const SETTING_AUDIO_CACHE_LIMIT_MB: &str = "cache.audioLimitMb";
/// settings 里没有这条时的默认上限：512MB
pub const DEFAULT_AUDIO_CACHE_LIMIT_MB: u64 = 512;

/// 解析 settings 里的上限值：缺项 / 空串 / 脏数据都回落默认值
pub fn parse_cache_limit_mb(raw: Option<&str>) -> u64 {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => s.parse::<u64>().unwrap_or(DEFAULT_AUDIO_CACHE_LIMIT_MB),
        None => DEFAULT_AUDIO_CACHE_LIMIT_MB,
    }
}

/// 上限（MB）→ 字节口径；0 表示不限（映射成 u64::MAX，让「超没超」比较自然成立）
pub fn limit_bytes(limit_mb: u64) -> u64 {
    if limit_mb == 0 {
        u64::MAX
    } else {
        limit_mb.saturating_mul(1024 * 1024)
    }
}

/// 把 `dir` 修剪回 `limit_mb` 以内（LRU：mtime 最旧的先删）。
///
/// `keep` 是正在使用的缓存文件（在播流的 .part），永不删；删除失败
/// （Windows 上被占用的文件）跳过并继续。返回 (释放字节, 删除个数)。
pub fn prune_audio_cache(dir: &Path, limit_mb: u64, keep: Option<&Path>) -> (u64, usize) {
    let cap = limit_bytes(limit_mb);
    if cap == u64::MAX {
        return (0, 0);
    }
    let mut files = match collect_files(dir) {
        Ok(f) => f,
        Err(e) => {
            log::info!("[cache] 扫描缓存目录失败 {}: {e}", dir.display());
            return (0, 0);
        }
    };
    let total: u64 = files.iter().map(|f| f.size).sum();
    if total <= cap {
        return (0, 0);
    }
    // mtime 拿不到的文件按最旧处理（UNIX_EPOCH），先被清掉
    files.sort_by_key(|f| f.modified.unwrap_or(std::time::SystemTime::UNIX_EPOCH));
    let mut freed = 0u64;
    let mut removed = 0usize;
    let mut remaining = total;
    for f in files {
        if remaining <= cap {
            break;
        }
        if keep.is_some_and(|k| k == f.path) {
            continue;
        }
        match std::fs::remove_file(&f.path) {
            Ok(()) => {
                remaining -= f.size;
                freed += f.size;
                removed += 1;
            }
            Err(e) => {
                log::info!("[cache] 跳过删除失败文件 {}: {e}", f.path.display());
            }
        }
    }
    (freed, removed)
}

struct CacheFile {
    path: PathBuf,
    size: u64,
    modified: Option<std::time::SystemTime>,
}

/// 递归收集目录下的普通文件（缓存目录通常只有一层，按通用目录处理兜底）
fn collect_files(dir: &Path) -> io::Result<Vec<CacheFile>> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let entries = std::fs::read_dir(&d)?;
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            let path = entry.path();
            if ft.is_dir() {
                stack.push(path);
            } else if let Ok(meta) = entry.metadata() {
                out.push(CacheFile {
                    size: meta.len(),
                    modified: meta.modified().ok(),
                    path,
                });
            }
        }
    }
    Ok(out)
}

/// WebView2 用户数据目录（EBWebView）下的「纯缓存」子目录。
///
/// 只删这些目录里的文件 —— Local Storage / IndexedDB / Cookies /
/// Session Storage 等用户数据一律不在列表里（里面存着界面设置与登录态），
/// 所以这个清理是安全的：删掉的只是封面、脚本、HTTP 资源等可再生内容。
pub const WEBVIEW_CACHE_DIRS: &[&str] = &[
    "Default/Cache",
    "Default/Code Cache",
    "Default/GPUCache",
    "Default/DawnCache",
    "Default/DawnGraphiteCache",
    "Default/DawnWebGPUCache",
    "Default/Service Worker/CacheStorage",
    "Default/Service Worker/ScriptCache",
    "GrShaderCache",
    "ShaderCache",
];

/// 递归删除 `dir` 里的文件（保留目录骨架，Chromium 自己会重建），
/// `skip` 指定的文件跳过（正在播放的流缓存）。返回 (释放字节, 失败个数)。
pub fn clear_dir_files(dir: &Path, skip: Option<&Path>) -> (u64, u64) {
    let mut freed = 0u64;
    let mut failed = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            let path = entry.path();
            if ft.is_dir() {
                stack.push(path);
                continue;
            }
            // 元数据先读再删：删掉后就查不到大小了
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if skip.is_some_and(|s| s == path) {
                continue;
            }
            match std::fs::remove_file(&path) {
                Ok(()) => freed += size,
                Err(e) => {
                    // 文件可能刚好被并发使用：计入失败，不算错误
                    log::info!("[cache] 跳过删除失败文件 {}: {e}", path.display());
                    failed += 1;
                }
            }
        }
    }
    (freed, failed)
}

/// 递归统计目录体积（缓存统计展示用）
pub fn dir_stats(dir: &Path) -> (u64, u64) {
    let mut total = 0u64;
    let mut count = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                stack.push(entry.path());
            } else if let Ok(meta) = entry.metadata() {
                total += meta.len();
                count += 1;
            }
        }
    }
    (total, count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_file(dir: &Path, name: &str, len: usize) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, vec![0u8; len]).unwrap();
        path
    }

    /// 把文件 mtime 拨到指定时刻（std 1.75+ 的 File::set_modified），
    /// 让 LRU 顺序在测试里完全确定。
    fn set_mtime(path: &Path, secs_since_epoch: u64) {
        std::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .unwrap()
            .set_modified(
                std::time::SystemTime::UNIX_EPOCH
                    + std::time::Duration::from_secs(secs_since_epoch),
            )
            .unwrap();
    }

    #[test]
    fn parse_cache_limit_mb_falls_back_to_default() {
        assert_eq!(parse_cache_limit_mb(None), DEFAULT_AUDIO_CACHE_LIMIT_MB);
        assert_eq!(parse_cache_limit_mb(Some("")), DEFAULT_AUDIO_CACHE_LIMIT_MB);
        assert_eq!(
            parse_cache_limit_mb(Some("  ")),
            DEFAULT_AUDIO_CACHE_LIMIT_MB
        );
        assert_eq!(
            parse_cache_limit_mb(Some("abc")),
            DEFAULT_AUDIO_CACHE_LIMIT_MB
        );
        assert_eq!(parse_cache_limit_mb(Some("256")), 256);
        assert_eq!(parse_cache_limit_mb(Some(" 0 ")), 0);
    }

    #[test]
    fn limit_bytes_zero_means_unlimited() {
        assert_eq!(limit_bytes(0), u64::MAX);
        assert_eq!(limit_bytes(1), 1024 * 1024);
    }

    #[test]
    fn prune_noop_when_under_limit_or_unlimited() {
        let tmp = std::env::temp_dir().join(format!("qt-cache-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let a = write_file(&tmp, "a.part", 400);
        set_mtime(&a, 1_000);

        // 未超限（400B < 1MB）不动
        assert_eq!(prune_audio_cache(&tmp, 1, None), (0, 0));
        // 0 = 不限，不动
        assert_eq!(prune_audio_cache(&tmp, 0, None), (0, 0));
        assert!(a.exists());
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn prune_lru_order_with_mb_files() {
        let tmp = std::env::temp_dir().join(format!("qt-cache-test2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // 3 个 600KB 文件（1.76MB），mtime 递增；上限 1MB →
        // 从最旧开始删 a、b，剩 c（600KB ≤ 1MB）停手
        for (i, name) in ["a", "b", "c"].iter().enumerate() {
            let p = tmp.join(format!("{name}.part"));
            std::fs::write(&p, vec![0u8; 600 * 1024]).unwrap();
            set_mtime(&p, 1_000 + i as u64 * 1_000);
        }
        let (freed, removed) = prune_audio_cache(&tmp, 1, None);
        assert_eq!(removed, 2, "1.76MB -> 600KB 需要删两个最旧的");
        assert_eq!(freed, 1200 * 1024);
        let left = collect_files(&tmp).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].path.file_name().unwrap(), "c.part");
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn prune_never_deletes_kept_file() {
        let tmp = std::env::temp_dir().join(format!("qt-cache-test3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let busy = write_file(&tmp, "busy.part", 600 * 1024);
        set_mtime(&busy, 1_000); // 最旧，但在播
        let keep = write_file(&tmp, "new.part", 600 * 1024);
        set_mtime(&keep, 5_000);

        let (freed, removed) = prune_audio_cache(&tmp, 1, Some(&busy));
        // busy 被跳过 → 只能删 new，删完 600KB ≤ 1MB 停手
        assert_eq!((freed, removed), (600 * 1024, 1));
        assert!(busy.exists());
        assert!(!keep.exists());
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn clear_dir_files_removes_files_keeps_dirs_and_skips() {
        let tmp = std::env::temp_dir().join(format!("qt-cache-test4-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let sub = tmp.join("Cache_Data");
        std::fs::create_dir_all(&sub).unwrap();
        let f1 = write_file(&tmp, "a.tmp", 10);
        let f2 = write_file(&sub, "b.tmp", 20);
        let busy = write_file(&tmp, "busy.tmp", 30);

        let (freed, failed) = clear_dir_files(&tmp, Some(&busy));
        assert_eq!((freed, failed), (30, 0)); // a+b 共 30B，busy 跳过
        assert!(busy.exists());
        assert!(!f1.exists());
        assert!(!f2.exists());
        assert!(sub.is_dir(), "目录骨架保留");
        std::fs::remove_dir_all(&tmp).unwrap();
    }
}
