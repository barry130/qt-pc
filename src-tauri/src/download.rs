//! 下载 2.0：可暂停 / 继续 / 取消 / 重试的下载状态机（DESIGN §5.3）。
//!
//! - 落盘先写 `<最终名>.part`，全部写完并校验后才重命名为成品：中断不会留下
//!   看起来正常的半截文件，也不会被本地扫描器误收。
//! - HTTP 状态 / Content-Type / 字节数三重校验，错误页不会被当作音频存下来。
//! - 断点续传：暂停后保留 `.part`，继续时带 `Range` 从已有字节接着写。
//! - 网络类错误自动退避重试（最多 3 次）；HTTP 4xx 属于确定性失败，直接报错。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::Emitter;

use crate::db::Database;

/// 任务状态字符串（与 DB、前端一一对应）。
pub mod status {
    pub const PENDING: &str = "pending";
    pub const DOWNLOADING: &str = "downloading";
    pub const PAUSED: &str = "paused";
    pub const DONE: &str = "done";
    pub const FAILED: &str = "failed";
    pub const CANCELED: &str = "canceled";
}

/// 退避重试的最大尝试次数（含首次）。
const MAX_ATTEMPTS: u32 = 3;

/// 下载状态变化广播给前端的事件名（主窗口刷新列表 / 已下载标记用）。
pub const EVENT_DOWNLOADS_CHANGED: &str = "downloads-changed";

/// 进行中任务的取消旗标登记表。暂停与取消共用同一个旗标，
/// 区别只在收尾时 `.part` 留不留（由调用方按最终状态决定）。
#[derive(Default)]
pub struct DownloadManager {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl DownloadManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记一个正在执行的任务并返回它的取消旗标。
    fn register(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.active
            .lock()
            .unwrap()
            .insert(id.to_string(), Arc::clone(&flag));
        flag
    }

    fn unregister(&self, id: &str) {
        self.active.lock().unwrap().remove(id);
    }

    /// 请求停止（暂停 / 取消）。返回该任务当前是否真的在下载中。
    pub fn request_stop(&self, id: &str) -> bool {
        let map = self.active.lock().unwrap();
        match map.get(id) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        }
    }

    pub fn is_active(&self, id: &str) -> bool {
        self.active.lock().unwrap().contains_key(id)
    }
}

/// 一次下载的最终结果。
pub enum DownloadOutcome {
    /// 写完并已重命名为成品，值为最终字节数
    Done(i64),
    /// 用户暂停 / 取消（`.part` 去留由调用方决定）
    Stopped,
    /// 重试后仍失败，值为面向用户的错误说明
    Failed(String),
}

/// 单个下载任务的执行参数。
pub struct DownloadJob {
    pub task_id: String,
    pub url: String,
    /// 最终成品路径
    pub final_path: PathBuf,
    /// `.part` 临时路径（断点续传就续写它）
    pub part_path: PathBuf,
}

/// 由最终路径推出临时路径（没有持久化 `part_path` 时的兜底）。
pub fn part_path_for(final_path: &Path) -> PathBuf {
    let name = final_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download");
    final_path.with_file_name(format!("{name}.part"))
}

/// Content-Type 是否可接受为音频。类型未知时放行（不少源不返回），
/// 明确是网页 / JSON 的则拒绝 —— 这类响应体写进 `.mp3` 只会得到坏文件。
pub fn content_type_acceptable(ct: Option<&str>) -> bool {
    let Some(ct) = ct else { return true };
    let ct = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    ct.is_empty()
        || ct.starts_with("audio/")
        || ct.starts_with("video/")
        || ct == "application/octet-stream"
        || ct == "binary/octet-stream"
}

/// HTTP 状态码是否值得重试（超时 / 限流 / 服务端错误）。
pub fn status_retryable(code: u16) -> bool {
    code == 408 || code == 425 || code == 429 || code >= 500
}

/// 磁盘写满的识别（Windows 112 / 常见 ENOSPC 28、39），给用户一句人话。
pub fn is_disk_full(err: &std::io::Error) -> bool {
    matches!(err.raw_os_error(), Some(28) | Some(112) | Some(39))
}

/// 单次尝试的失败分类，决定重试还是直接放弃。
enum AttemptError {
    Stopped,
    Retryable(String),
    Fatal(String),
}

/// 执行一个下载任务（自动重试）。返回结果前会把状态写回数据库。
pub async fn run_job(
    app: tauri::AppHandle,
    db: Arc<Database>,
    manager: Arc<DownloadManager>,
    job: DownloadJob,
) -> DownloadOutcome {
    let cancel = manager.register(&job.task_id);
    let mut last_err = String::from("下载失败");
    let mut outcome = DownloadOutcome::Failed(last_err.clone());

    for attempt in 1..=MAX_ATTEMPTS {
        if cancel.load(Ordering::SeqCst) {
            outcome = DownloadOutcome::Stopped;
            break;
        }
        match attempt_once(&db, &job, &cancel).await {
            Ok(size) => {
                outcome = DownloadOutcome::Done(size);
                break;
            }
            Err(AttemptError::Stopped) => {
                outcome = DownloadOutcome::Stopped;
                break;
            }
            Err(AttemptError::Fatal(msg)) => {
                outcome = DownloadOutcome::Failed(msg);
                break;
            }
            Err(AttemptError::Retryable(msg)) => {
                last_err = msg;
                if attempt < MAX_ATTEMPTS {
                    log::warn!(
                        "[download] {} 第 {attempt} 次失败，退避重试：{last_err}",
                        job.task_id
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(
                        400 * attempt as u64,
                    ))
                    .await;
                }
            }
        }
    }
    if let DownloadOutcome::Failed(_) = &outcome {
        outcome = DownloadOutcome::Failed(last_err);
    }

    // 终态落库：Done / Failed 由这里写；Stopped 的 paused / canceled 由
    // 发起暂停 / 取消的命令先写（含 `.part` 去留），此处不覆盖。
    let task_id = job.task_id.clone();
    match &outcome {
        DownloadOutcome::Done(size) => {
            let path = job.final_path.to_string_lossy().to_string();
            let size = *size;
            let _ = with_db(&db, move |c| {
                crate::db::store::finish_download_task(c, &task_id, &path, size)
            })
            .await;
        }
        DownloadOutcome::Failed(msg) => {
            let msg = msg.clone();
            let _ = with_db(&db, move |c| {
                crate::db::store::fail_download_task(c, &task_id, &msg)
            })
            .await;
        }
        DownloadOutcome::Stopped => {}
    }

    manager.unregister(&job.task_id);
    let _ = app.emit(EVENT_DOWNLOADS_CHANGED, ());
    outcome
}

/// 单次下载尝试：续传探测 → 校验 → 流式写入 → 原子重命名。
async fn attempt_once(
    db: &Arc<Database>,
    job: &DownloadJob,
    cancel: &Arc<AtomicBool>,
) -> Result<i64, AttemptError> {
    use std::io::Write;

    if let Some(parent) = job.part_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AttemptError::Fatal(format!("创建下载目录失败: {e}")))?;
    }

    // 已有临时文件的字节数 = 本次续传起点
    let mut offset = std::fs::metadata(&job.part_path)
        .map(|m| m.len())
        .unwrap_or(0);

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0")
        .pool_max_idle_per_host(0)
        .build()
        .map_err(|e| AttemptError::Fatal(format!("初始化下载客户端失败: {e}")))?;
    let mut req = client.get(&job.url);
    if offset > 0 {
        req = req.header("Range", format!("bytes={offset}-"));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| AttemptError::Retryable(format!("请求失败: {e}")))?;

    let code = resp.status().as_u16();
    if offset > 0 && resp.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        // 服务端支持续传：总长 = 已下载 + 本次剩余
    } else if offset > 0 && resp.status().is_success() {
        // 服务端忽略 Range，整包重来
        log::info!("[download] {} 服务端不支持续传，从头下载", job.task_id);
        offset = 0;
    } else if !resp.status().is_success() {
        let msg = format!("服务器返回 HTTP {code}");
        return Err(if status_retryable(code) {
            AttemptError::Retryable(msg)
        } else {
            AttemptError::Fatal(msg)
        });
    }

    let ctype = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if !content_type_acceptable(ctype.as_deref()) {
        return Err(AttemptError::Fatal(format!(
            "返回的不是音频文件（{}），已中止",
            ctype.as_deref().unwrap_or("未知类型")
        )));
    }

    let remaining = resp.content_length().unwrap_or(0);
    let total = if remaining > 0 { offset + remaining } else { 0 };
    if total > 0 {
        let task_id = job.task_id.clone();
        let _ = with_db(db, move |c| {
            crate::db::store::set_download_total_bytes(c, &task_id, total as i64)
        })
        .await;
    }

    let mut file = if offset > 0 && job.part_path.exists() {
        std::fs::OpenOptions::new()
            .append(true)
            .open(&job.part_path)
            .map_err(|e| AttemptError::Fatal(format!("打开临时文件失败: {e}")))?
    } else {
        offset = 0;
        std::fs::File::create(&job.part_path)
            .map_err(|e| AttemptError::Fatal(format!("创建临时文件失败: {e}")))?
    };

    let mut resp = resp;
    let mut written: u64 = offset;
    let mut last_pct = -1.0f64;
    let mut last_write = std::time::Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = file.flush();
            return Err(AttemptError::Stopped);
        }
        let chunk = match resp.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                let _ = file.flush();
                return Err(AttemptError::Retryable(format!("下载中断: {e}")));
            }
        };
        file.write_all(&chunk).map_err(|e| {
            if is_disk_full(&e) {
                AttemptError::Fatal("磁盘空间不足，请清理后重试".to_string())
            } else {
                AttemptError::Fatal(format!("写入文件失败: {e}"))
            }
        })?;
        written += chunk.len() as u64;

        // 进度按 2% 或 1s 节流写库，别让高频写库拖慢下载
        let pct = if total > 0 {
            written as f64 / total as f64
        } else {
            0.0
        };
        if total > 0 && (pct - last_pct >= 0.02 || last_write.elapsed().as_secs() >= 1) {
            last_pct = pct;
            last_write = std::time::Instant::now();
            let progress = pct.clamp(0.0, 1.0);
            let task_id = job.task_id.clone();
            let _ = with_db(db, move |c| {
                crate::db::store::update_download_progress(c, &task_id, progress)
            })
            .await;
        }
    }

    file.flush()
        .map_err(|e| AttemptError::Fatal(format!("写入文件失败: {e}")))?;
    file.sync_all()
        .map_err(|e| AttemptError::Fatal(format!("刷新磁盘失败: {e}")))?;
    drop(file);

    if total > 0 && written != total {
        return Err(AttemptError::Retryable(format!(
            "下载不完整（{written}/{total} 字节）"
        )));
    }
    if written == 0 {
        return Err(AttemptError::Fatal("下载内容为空".to_string()));
    }

    // 原子收尾：临时文件 → 成品。Windows 下 rename 不覆盖已存在的目标，
    // 先删掉可能残留的旧同名文件（正常不会出现，重试路径才可能）。
    if job.final_path.exists() {
        let _ = std::fs::remove_file(&job.final_path);
    }
    if let Some(parent) = job.final_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::rename(&job.part_path, &job.final_path).map_err(|e| {
        AttemptError::Fatal(format!("保存文件失败: {e}"))
    })?;
    Ok(written as i64)
}

/// 在阻塞线程池里跑一段数据库操作（写库失败不影响下载主流程）。
async fn with_db<T: Send + 'static>(
    db: &Arc<Database>,
    f: impl FnOnce(&rusqlite::Connection) -> Result<T, rusqlite::Error> + Send + 'static,
) -> Result<T, String> {
    let db = Arc::clone(db);
    tauri::async_runtime::spawn_blocking(move || db.with(f))
        .await
        .map_err(|e| format!("数据库任务异常: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_path_is_suffixed_next_to_target() {
        let p = part_path_for(Path::new("D:\\Music\\周杰伦 - 晴天.flac"));
        assert_eq!(p.file_name().unwrap().to_str().unwrap(), "周杰伦 - 晴天.flac.part");
    }

    #[test]
    fn content_type_gate_rejects_pages_keeps_audio() {
        assert!(content_type_acceptable(None));
        assert!(content_type_acceptable(Some("")));
        assert!(content_type_acceptable(Some("audio/mpeg")));
        assert!(content_type_acceptable(Some("audio/flac; charset=utf-8")));
        assert!(content_type_acceptable(Some("application/octet-stream")));
        assert!(content_type_acceptable(Some("video/mp4")));
        // 错误页 / JSON 一律拒绝
        assert!(!content_type_acceptable(Some("text/html")));
        assert!(!content_type_acceptable(Some("text/html; charset=utf-8")));
        assert!(!content_type_acceptable(Some("application/json")));
    }

    #[test]
    fn retryable_status_classification() {
        assert!(status_retryable(408));
        assert!(status_retryable(429));
        assert!(status_retryable(500));
        assert!(status_retryable(503));
        // 确定性失败不重试
        assert!(!status_retryable(403));
        assert!(!status_retryable(404));
        assert!(!status_retryable(200));
    }

    #[test]
    fn disk_full_detection() {
        let e = std::io::Error::from_raw_os_error(112);
        assert!(is_disk_full(&e));
        let e = std::io::Error::from_raw_os_error(2);
        assert!(!is_disk_full(&e));
    }

    #[test]
    fn manager_registers_stops_and_unregisters() {
        let m = DownloadManager::new();
        assert!(!m.request_stop("nope"), "未登记的任务不应报已停止");
        let flag = m.register("t1");
        assert!(m.is_active("t1"));
        assert!(m.request_stop("t1"));
        assert!(flag.load(Ordering::SeqCst), "旗标应被置起");
        m.unregister("t1");
        assert!(!m.is_active("t1"));
    }
}
