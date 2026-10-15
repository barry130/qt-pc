//! 本地音乐库扫描服务。
//!
//! Tauri command 只负责把 IPC 参数交给本服务并转发进度事件；目录校验、文件扫描、
//! 分段写库和缺失标记全部留在这里，因此可在没有 Tauri runtime 的情况下单测。

use std::path::Path;
use std::time::{Duration, Instant};

use crate::db::Database;
use crate::local::{self, ScanFilter};
use crate::provider::types::Track;

/// 单进程 SQLite 连接的单次事务最大写入数。写完一段立即释放锁，让音频引擎的
/// `persist_state` 等读写可以插队；不能把整库扫描的数千条记录放进一个事务。
const UPSERT_CHUNK: usize = 500;
/// UI 更新节流：整盘扫描时避免每个目录项各发一次跨窗口事件。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanLibraryRequest {
    pub dirs: Vec<String>,
    #[serde(default)]
    pub min_duration_secs: Option<u64>,
    #[serde(default)]
    pub min_size_bytes: Option<u64>,
}

impl ScanLibraryRequest {
    pub fn filter(&self) -> ScanFilter {
        ScanFilter {
            min_duration_secs: self.min_duration_secs.unwrap_or(0),
            min_size_bytes: self.min_size_bytes.unwrap_or(0),
        }
    }
}

/// 可直接序列化给前端的扫描进度，避免 command 自己拼 JSON。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub visited: usize,
    pub found: usize,
    pub current: String,
}

/// 检查用户选择的每个扫描根目录。这个校验必须在扫描前完成，避免一半目录已经
/// 写库后才向用户报告另一个目录不存在。
pub fn validate_dirs(dirs: &[String]) -> Result<(), String> {
    for dir in dirs {
        if !Path::new(dir).exists() {
            return Err(format!("目录不存在: {dir}"));
        }
    }
    Ok(())
}

/// 扫描、分段写入并刷新缺失标记。
///
/// `on_progress` 在执行本函数的 blocking worker 上调用；调用方若向 Tauri 发事件，
/// 只应做非阻塞 emit。任一分段写入失败时不会执行 `mark_missing_local_tracks`，否则
/// 不完整的 present 集合会误把尚未写入的旧曲目标记成缺失。
pub fn scan_and_persist(
    db: &Database,
    request: &ScanLibraryRequest,
    mut on_progress: impl FnMut(ScanProgress),
) -> Result<Vec<Track>, String> {
    validate_dirs(&request.dirs)?;

    let mut last_emit: Option<Instant> = None;
    let rows = local::scan_dirs_with_progress(&request.dirs, request.filter(), |visited, found, current| {
        if last_emit.is_none_or(|at| at.elapsed() >= PROGRESS_INTERVAL) {
            last_emit = Some(Instant::now());
            on_progress(ScanProgress {
                visited,
                found,
                current: current.to_string_lossy().into_owned(),
            });
        }
    });
    let present = rows.iter().map(|row| row.path.clone()).collect();

    for chunk in rows.chunks(UPSERT_CHUNK) {
        if let Err(err) = db.with(|conn| crate::db::store::upsert_local_tracks(conn, chunk)) {
            log::error!("[local] 分段入库失败（段含 {} 条）: {err}", chunk.len());
            return Err(err);
        }
    }

    db.with(|conn| {
        crate::db::store::touch_scan_dirs(conn, &request.dirs)?;
        let missing = crate::db::store::mark_missing_local_tracks(conn, &request.dirs, &present)?;
        if missing > 0 {
            log::info!("[local] 标记缺失曲目 {missing} 条");
        }
        crate::db::store::query_local_tracks(conn)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_defaults_disable_filters() {
        let request = ScanLibraryRequest {
            dirs: vec!["C:\\Music".to_string()],
            min_duration_secs: None,
            min_size_bytes: None,
        };
        assert_eq!(request.filter().min_duration_secs, 0);
        assert_eq!(request.filter().min_size_bytes, 0);
    }

    #[test]
    fn validate_dirs_rejects_missing_root_before_scan() {
        let missing = std::env::temp_dir().join(format!("quietmusic-missing-{}", fastrand::u64(..)));
        let error = validate_dirs(&[missing.to_string_lossy().into_owned()]).unwrap_err();
        assert!(error.contains("目录不存在"));
    }
}
