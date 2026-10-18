//! 下载 2.0：可暂停 / 继续 / 取消 / 重试的下载状态机（DESIGN §5.3）。
//!
//! - 落盘先写 `<最终名>.part`，全部写完并校验后才重命名为成品：中断不会留下
//!   看起来正常的半截文件，也不会被本地扫描器误收。
//! - HTTP 状态 / Content-Type / 字节数三重校验，错误页不会被当作音频存下来。
//! - 断点续传：暂停后保留 `.part`，回读最多 64 KiB 尾部核对后才追加新字节。
//! - 网络类错误自动退避重试（最多 3 次）；416 安全重下，其他确定性 4xx 直接报错。
//! - 并发闸门：同时最多跑 N 个任务（N 默认 3，可选 1–6，见 `DEFAULT_CONCURRENCY`）。
//!   批量下载不限流会被音源/CDN 判成爬虫封 IP —— LX Music 就栽过（issue #1992），
//!   之后把默认并发压到 3 并在设置页限制 1–6。本项目封面代取（`qtres.rs` 的
//!   `COVER_FETCH_CONCURRENCY`）也走同一套思路，这里补齐下载侧。

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Emitter;
use tokio::sync::Notify;

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

/// 退避重试的最大尝试次数（含首次）。注意：这是**单个任务**的重试次数，
/// 与下面的并发上限是两回事，别混。
const MAX_ATTEMPTS: u32 = 3;

/// 只回读已有文件的尾部，限制内存 / 重复流量；确认一致后才允许追加新字节。
const RESUME_OVERLAP: u64 = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CHUNK_TIMEOUT: Duration = Duration::from_secs(30);
// 暂停旗标仍沿用 AtomicBool；网络静默时也必须及时响应，而不是等下一个 chunk。
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// 同时下载数的默认值。3 是 LX Music 的默认值（它曾因批量下载被封 IP）。
pub const DEFAULT_CONCURRENCY: usize = 3;

/// 同时下载数的可选下限 / 上限（与设置页 UI、`cmd_set_download_concurrency` 一致）。
pub const MIN_CONCURRENCY: usize = 1;
pub const MAX_CONCURRENCY: usize = 6;

/// 把任意来源（设置表里的字符串、命令参数）的并发数夹到合法范围。
/// 单一真源：命令层、启动时读设置、测试都走这里，避免三处各写一遍 clamp。
pub fn clamp_concurrency(n: usize) -> usize {
    n.clamp(MIN_CONCURRENCY, MAX_CONCURRENCY)
}

/// 下载状态变化广播给前端的事件名（主窗口刷新列表 / 已下载标记用）。
pub const EVENT_DOWNLOADS_CHANGED: &str = "downloads-changed";

/// 并发闸门。用「配置上限 + 在跑计数」两个整数表达并发，而不是直接拿
/// `tokio::sync::Semaphore` 的许可数当上限：设置页允许**运行中**改并发数，
/// 而信号量的许可被在跑任务借走后，下调时 `forget_permits` 只能收回**空闲**
/// 许可，会出现「设成 1 了却还在跑 3 个、而且再也降不下来」的隐性失效。
/// 这里改上限即刻生效，且不打断在跑的任务（不能凭空掐掉用户已在等的下载）。
struct Gate {
    state: Mutex<GateState>,
    /// 空出并发位 / 上限变化 / 取消排队时叫醒等待者
    wake: Notify,
}

struct GateState {
    limit: usize,
    running: usize,
}

impl Gate {
    fn new(limit: usize) -> Self {
        Self {
            state: Mutex::new(GateState {
                limit: clamp_concurrency(limit),
                running: 0,
            }),
            wake: Notify::new(),
        }
    }

    // 本文件所有取锁点统一「毒锁容忍」（与 db/mod.rs::conn 同口径）：Cargo.toml
    // 已恢复 panic=unwind，任何一次持锁 panic 都会毒化 Mutex，之后所有
    // lock().unwrap() 连锁失败 —— 一次偶发 panic 会让整个下载调度在本次
    // 运行里永久瘫痪。into_inner() 拿回的数据最坏是脏计数，saturating_sub
    // 与 clamp_concurrency 已兜住。
    fn limit(&self) -> usize {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).limit
    }

    fn running(&self) -> usize {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).running
    }

    /// 改并发上限。下调不打断在跑的任务，只是它们结束后不再补位。
    fn set_limit(&self, n: usize) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).limit = clamp_concurrency(n);
        // 叫醒所有排队者重算：下调后可能已超额（它们得继续睡），
        // 上调后有空位（它们应该立刻开工）。
        self.wake.notify_waiters();
    }

    /// 尝试占一个并发位；满了返回 false。
    fn try_enter(&self) -> bool {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if st.running < st.limit {
            st.running += 1;
            true
        } else {
            false
        }
    }

    fn release(&self) {
        {
            let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
            // saturating_sub 兜底：即使计数被弄脏也不至于下溢成天文数字
            st.running = st.running.saturating_sub(1);
        }
        // 只叫一个 —— 空出来的位子只够一个排队者
        self.wake.notify_one();
    }
}

/// 并发位凭证：持有它代表占着一个并发名额，drop 即归还。
/// 下载中途失败 / 被取消 / panic 展开都会走到 `Drop`，并发位不会泄漏。
pub struct Slot {
    /// 该任务的取消旗标（暂停 / 取消共用），下载循环按它中止
    pub cancel: Arc<AtomicBool>,
    gate: Arc<Gate>,
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.gate.release();
    }
}

/// `enter` 的三种结果。把「满了」和「已取消」分开，是因为前者要接着排队，
/// 后者必须立刻收工 —— 混成一个 bool 会让排队循环分不清该睡还是该退。
enum Enter {
    Entered(Slot),
    Full,
    Canceled,
}

/// 进行中任务的取消旗标登记表 + 并发闸门。暂停与取消共用同一个旗标，
/// 区别只在收尾时 `.part` 留不留（由调用方按最终状态决定）。
pub struct DownloadManager {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
    gate: Arc<Gate>,
}

impl Default for DownloadManager {
    fn default() -> Self {
        Self::new()
    }
}

impl DownloadManager {
    pub fn new() -> Self {
        Self::with_concurrency(DEFAULT_CONCURRENCY)
    }

    pub fn with_concurrency(n: usize) -> Self {
        Self {
            active: Mutex::new(HashMap::new()),
            gate: Arc::new(Gate::new(n)),
        }
    }

    /// 登记一个正在执行（或正在排队）的任务并返回它的取消旗标。
    ///
    /// 已登记过的 id **复用**原旗标而不是换一个新的：同一个任务重复入队时，
    /// 之前那次 `request_stop` 置起的旗标不能被悄悄抹掉，否则「取消」会失效。
    fn register(&self, id: &str) -> Arc<AtomicBool> {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    /// 预登记：在 `spawn` 之前先占住登记表，让任务从「已建任务」这一刻起就能被
    /// 暂停 / 取消打断。否则 spawn 到 `begin` 之间那一小段窗口里 `request_stop`
    /// 会返回 false（用户点了暂停却还在下）。返回的旗标由 `begin` 复用，
    /// 所以这里置起的取消在排队时同样有效。
    pub fn reserve(&self, id: &str) -> Arc<AtomicBool> {
        self.register(id)
    }

    /// 撤销一次尚未进入 `begin` 的预登记（spawn 的任务在排队前就失败时用）。
    pub fn release(&self, id: &str) {
        self.unregister(id);
    }

    fn unregister(&self, id: &str) {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }

    /// 请求停止（暂停 / 取消）。返回该任务当前是否真的在下载（或正在排队）。
    pub fn request_stop(&self, id: &str) -> bool {
        let hit = {
            let map = self.active.lock().unwrap_or_else(|e| e.into_inner());
            match map.get(id) {
                Some(flag) => {
                    flag.store(true, Ordering::SeqCst);
                    true
                }
                None => false,
            }
        };
        if hit {
            // 叫醒还在排队的等待者，让它们立刻看到旗标收工。
            // 不叫醒也不会出错（一旦有任务结束腾出位置，排队者同样会看到旗标），
            // 但那样「取消一个排队中的任务」要等下一个下载结束才生效，体感是卡住。
            self.gate.wake.notify_waiters();
        }
        hit
    }

    /// 任务是否已登记（在下载**或**在排队）。排队中也算 —— 否则连点两次
    /// 「继续」会往闸门里排两个重复任务，白白占一个并发位。
    pub fn is_active(&self, id: &str) -> bool {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(id)
    }

    /// 排队等一个并发位。返回 `None` = 任务在排队期间被暂停 / 取消，
    /// 调用方不得再启动它（登记表已由本函数清理，调用方无需再 unregister）。
    pub async fn begin(self: &Arc<Self>, id: &str) -> Option<Slot> {
        let cancel = self.register(id);
        // 排队前先看一次：任务可能在建任务与 spawn 之间就被暂停了
        if cancel.load(Ordering::SeqCst) {
            self.unregister(id);
            return None;
        }
        loop {
            match self.enter(&cancel) {
                Enter::Entered(slot) => return Some(slot),
                Enter::Canceled => {
                    self.unregister(id);
                    return None;
                }
                Enter::Full => {}
            }
            // 满了：注册等待者再睡。`enable()` 必须在 `await` 之前 ——
            // 通知若落在「建 future」与「开始等」之间就会被丢掉，排队任务会一直
            // 睡到某个下载结束才醒（结果仍正确，但「取消排队中的任务」就不即时了）。
            let notified = self.gate.wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            // 注册完再查一次：取消（或腾位）可能恰好发生在 enable() 之前，
            // 那次通知我们没登记、收不到，只能靠自己重查补上。
            match self.enter(&cancel) {
                Enter::Entered(slot) => return Some(slot),
                Enter::Canceled => {
                    self.unregister(id);
                    return None;
                }
                Enter::Full => {}
            }
            notified.await;
        }
    }

    /// 抢一个并发位，并确认自己没被取消。
    fn enter(&self, cancel: &Arc<AtomicBool>) -> Enter {
        if cancel.load(Ordering::SeqCst) {
            return Enter::Canceled;
        }
        if !self.gate.try_enter() {
            return Enter::Full;
        }
        // 抢到位子后再确认一次：可能刚好在 try_enter 与这次检查之间被取消，
        // 那就把位子还回去 —— 绝不能带着「已取消」的旗标开始下载。
        if cancel.load(Ordering::SeqCst) {
            self.gate.release();
            return Enter::Canceled;
        }
        Enter::Entered(Slot {
            cancel: Arc::clone(cancel),
            gate: Arc::clone(&self.gate),
        })
    }

    /// 改并发上限（设置页改「同时下载数」时调用）。
    pub fn set_concurrency(&self, n: usize) {
        self.gate.set_limit(n);
    }

    /// 当前配置的并发上限。
    pub fn concurrency(&self) -> usize {
        self.gate.limit()
    }

    /// 当前真正在下载的任务数（不含排队的）。
    pub fn running(&self) -> usize {
        self.gate.running()
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
    /// 取这个地址时要带的 Referer（音源包按源声明，空串 = 不发）。
    ///
    /// 下载器自己向 CDN 取字节，拿不到"声明它的那一侧"；B 站部分 CDN 节点
    /// 没有 Referer 直接 403 text/html，而 403 不在 `status_retryable` 里，
    /// 会被判 Fatal —— 表现为"取链成功但下载必失败"。
    pub referer: String,
    /// 取链时 Range 预检实测到的文件总字节数（音源包 `probeMedia` 量出来的；
    /// `None` = 当时没读到 `Content-Range` 的 total）。
    ///
    /// 只在响应不带 `Content-Length`（分块传输 / 服务端省头）时拿来当进度
    /// 分母的兜底，不参与"下载是否完整"的判定 —— 那个判定只认实际字节数。
    pub declared_size: Option<u64>,
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
    let ct = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
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
#[derive(Debug)]
enum AttemptError {
    Stopped,
    Retryable(String),
    Fatal(String),
}

/// 已持有并发位时的执行入口（唯一入口，自动重试）。返回结果前会把状态写回数据库。
///
/// 所有路径（新任务、继续、重试）都由 `launch_download` 先 `begin` 拿到位子、
/// 连取址一起算进闸门，再调这里 —— 取址本身也是对音源的一次请求，批量入队 /
/// 批量继续 20 个任务时不能先把 20 个取址请求同时打出去。闸门只在 `begin`
/// 一个地方进，漏改一处就等于闸门失效。
pub async fn run_job_with_slot(
    app: tauri::AppHandle,
    db: Arc<Database>,
    manager: Arc<DownloadManager>,
    job: DownloadJob,
    slot: Slot,
) -> DownloadOutcome {
    let cancel = Arc::clone(&slot.cancel);
    let outcome = run_attempts(&db, &job, &cancel).await;

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

    // 先摘登记表再还并发位：反过来的话，排队者可能在新任务已开工的同时
    // 被旧任务的 unregister 摘掉旗标，取消就落到空处了。
    manager.unregister(&job.task_id);
    drop(slot);
    let _ = app.emit(EVENT_DOWNLOADS_CHANGED, ());
    outcome
}

async fn run_attempts(
    db: &Arc<Database>,
    job: &DownloadJob,
    cancel: &Arc<AtomicBool>,
) -> DownloadOutcome {
    let mut last_err = String::from("下载失败");
    for attempt in 1..=MAX_ATTEMPTS {
        if cancel.load(Ordering::SeqCst) {
            return DownloadOutcome::Stopped;
        }
        match attempt_once(db, job, cancel).await {
            Ok(size) => return DownloadOutcome::Done(size),
            Err(AttemptError::Stopped) => return DownloadOutcome::Stopped,
            // 确定性错误必须原样返回，不能被上一轮（或初始）的 last_err 覆盖。
            Err(AttemptError::Fatal(msg)) => return DownloadOutcome::Failed(msg),
            Err(AttemptError::Retryable(msg)) => {
                last_err = msg;
                if attempt < MAX_ATTEMPTS {
                    log::warn!(
                        "[download] {} 第 {attempt} 次失败，退避重试：{last_err}",
                        job.task_id
                    );
                    if until_stopped(
                        cancel,
                        tokio::time::sleep(Duration::from_millis(400 * attempt as u64)),
                    )
                    .await
                    .is_err()
                    {
                        return DownloadOutcome::Stopped;
                    }
                }
            }
        }
    }
    DownloadOutcome::Failed(last_err)
}

async fn until_stopped<T>(
    cancel: &AtomicBool,
    future: impl Future<Output = T>,
) -> Result<T, AttemptError> {
    tokio::select! {
        biased;
        _ = async {
            while !cancel.load(Ordering::SeqCst) {
                tokio::time::sleep(CANCEL_POLL_INTERVAL).await;
            }
        } => Err(AttemptError::Stopped),
        value = future => Ok(value),
    }
}

async fn network_wait<T>(
    cancel: &AtomicBool,
    timeout: Duration,
    operation: &str,
    future: impl Future<Output = Result<T, reqwest::Error>>,
) -> Result<T, AttemptError> {
    until_stopped(cancel, tokio::time::timeout(timeout, future))
        .await?
        .map_err(|_| AttemptError::Retryable(format!("{operation}超时，请稍后重试")))?
        .map_err(|e| {
            AttemptError::Retryable(format!(
                "{operation}失败: {}",
                crate::astral::sanitize_err(e.without_url())
            ))
        })
}

#[derive(Debug, PartialEq, Eq)]
struct ByteRange {
    start: u64,
    end: u64,
    total: u64,
}

fn parse_byte_range(value: &str) -> Option<ByteRange> {
    let (unit, value) = value.split_once(' ')?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let number = |s: &str| {
        (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse::<u64>().ok())
            .flatten()
    };
    let range = ByteRange {
        start: number(start)?,
        end: number(end)?,
        total: number(total)?,
    };
    (range.start <= range.end && range.end < range.total && range.total <= i64::MAX as u64)
        .then_some(range)
}

struct ResponseLayout {
    body_length: Option<u64>,
    total: Option<u64>,
}

/// 开区间请求必须覆盖到对象末尾；Content-Length 与 Content-Range 必须互相吻合。
/// declared_size 故意不进入这里：取链时量到的大小只影响进度显示。
fn response_layout(
    resp: &reqwest::Response,
    requested_start: Option<u64>,
    existing: u64,
) -> Result<ResponseLayout, String> {
    let invalid = || "服务器返回的下载范围或长度无效".to_string();
    let mut lengths = resp
        .headers()
        .get_all(reqwest::header::CONTENT_LENGTH)
        .iter();
    let length = lengths
        .next()
        .map(|v| {
            let text = v.to_str().map_err(|_| invalid())?;
            if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
                return Err(invalid());
            }
            text.parse::<u64>()
                .ok()
                .filter(|n| *n <= i64::MAX as u64)
                .ok_or_else(invalid)
        })
        .transpose()?;
    if lengths.next().is_some() {
        return Err(invalid());
    }
    if resp
        .headers()
        .get_all(reqwest::header::CONTENT_ENCODING)
        .iter()
        .any(|v| !v.as_bytes().eq_ignore_ascii_case(b"identity"))
    {
        return Err("服务器返回了不支持的下载编码".to_string());
    }
    if resp.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        let mut values = resp
            .headers()
            .get_all(reqwest::header::CONTENT_RANGE)
            .iter();
        let range = values
            .next()
            .and_then(|v| v.to_str().ok())
            .and_then(parse_byte_range)
            .ok_or_else(invalid)?;
        let body_length = range.end - range.start + 1;
        if values.next().is_some()
            || range.start != requested_start.unwrap_or(0)
            || range.end != range.total - 1
            || range.total < existing
            || length.is_some_and(|n| n != body_length)
        {
            return Err(invalid());
        }
        Ok(ResponseLayout {
            body_length: Some(body_length),
            total: Some(range.total),
        })
    } else {
        if resp.headers().contains_key(reqwest::header::CONTENT_RANGE) {
            return Err(invalid());
        }
        Ok(ResponseLayout {
            body_length: length,
            total: length,
        })
    }
}

/// 重下先写独立文件。失败 / 暂停时只清理该文件，已有 .part 的字节不受影响。
struct RestartFile(PathBuf);

impl Drop for RestartFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn open_output(
    job: &DownloadJob,
    append: bool,
    existing: u64,
) -> Result<(std::fs::File, Option<RestartFile>), AttemptError> {
    let error = |e| AttemptError::Fatal(format!("打开临时文件失败: {e}"));
    if append {
        let file = std::fs::OpenOptions::new()
            .append(true)
            .open(&job.part_path)
            .map_err(error)?;
        if file.metadata().map_err(error)?.len() != existing {
            return Err(AttemptError::Fatal(
                "临时文件已改变，请重试下载".to_string(),
            ));
        }
        Ok((file, None))
    } else if existing > 0 {
        let mut path = job.part_path.as_os_str().to_os_string();
        path.push(format!(".restart-{}.part", fastrand::u64(..)));
        let path = PathBuf::from(path);
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(error)?;
        Ok((file, Some(RestartFile(path))))
    } else {
        Ok((std::fs::File::create(&job.part_path).map_err(error)?, None))
    }
}

/// 单次下载尝试：最多一次安全重下 → 重叠字节校验 → 流式写入 → 完整校验后重命名。
async fn attempt_once(
    db: &Arc<Database>,
    job: &DownloadJob,
    cancel: &Arc<AtomicBool>,
) -> Result<i64, AttemptError> {
    use std::io::{Read, Seek, SeekFrom, Write};

    if cancel.load(Ordering::SeqCst) {
        return Err(AttemptError::Stopped);
    }
    if let Some(parent) = job.part_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AttemptError::Fatal(format!("创建下载目录失败: {e}")))?;
    }

    let (existing, overlap) = match std::fs::File::open(&job.part_path) {
        Ok(mut file) => {
            let read_error = |e| AttemptError::Fatal(format!("读取临时文件失败: {e}"));
            let size = file.metadata().map_err(read_error)?.len();
            if size > i64::MAX as u64 {
                return Err(AttemptError::Fatal(
                    "临时文件过大，无法继续下载".to_string(),
                ));
            }
            let mut tail = vec![0; size.min(RESUME_OVERLAP) as usize];
            file.seek(SeekFrom::Start(size - tail.len() as u64))
                .map_err(read_error)?;
            file.read_exact(&mut tail).map_err(read_error)?;
            (size, tail)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (0, Vec::new()),
        Err(e) => return Err(AttemptError::Fatal(format!("读取临时文件失败: {e}"))),
    };

    // 第二波（代理）：下载走的也是音源网络，构建时应用全局代理配置。
    // 请求头等待、连接、每段数据分别限时，避免给整首大文件设置过短的总时限。
    let client = crate::net_config::configure(
        reqwest::Client::builder()
            .user_agent("Mozilla/5.0")
            // 即使将来其他依赖合并开启解压 feature，也不能让字节范围被透明解码。
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(CHUNK_TIMEOUT)
            .pool_max_idle_per_host(0),
    )
    .build()
    .map_err(|e| {
        AttemptError::Fatal(format!(
            "初始化下载客户端失败: {}",
            crate::astral::sanitize_err(e)
        ))
    })?;
    let mut resume = existing > 0;
    'request: loop {
        let requested_start = resume.then_some(existing - overlap.len() as u64);
        let mut req = client
            .get(&job.url)
            .header(reqwest::header::ACCEPT_ENCODING, "identity");
        if !job.referer.is_empty() {
            req = req.header(reqwest::header::REFERER, &job.referer);
        }
        if let Some(start) = requested_start {
            req = req.header(reqwest::header::RANGE, format!("bytes={start}-"));
        }
        let mut resp = network_wait(cancel, REQUEST_TIMEOUT, "下载请求", req.send()).await?;
        let code = resp.status().as_u16();
        if code == 416 && resume {
            // 即使 */total 恰好等于 .part 长度也不能认定完整：旧文件可能已换版本。
            resume = false;
            continue;
        }
        if code != 200 && code != 206 {
            let msg = format!("服务器返回 HTTP {code}");
            return Err(if status_retryable(code) {
                AttemptError::Retryable(msg)
            } else {
                AttemptError::Fatal(msg)
            });
        }
        // 忽略 Range 的 200 是整包响应，必须写入独立临时文件，不能直接截断旧断点。
        let append = resume && code == 206;
        let layout = match response_layout(
            &resp,
            requested_start.filter(|_| append),
            if append { existing } else { 0 },
        ) {
            Ok(layout) => layout,
            Err(_) if append => {
                resume = false;
                continue;
            }
            Err(msg) => return Err(AttemptError::Fatal(msg)),
        };
        let ctype = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok());
        if !content_type_acceptable(ctype) {
            return Err(AttemptError::Fatal(
                "返回的不是音频文件，已中止".to_string(),
            ));
        }

        let total = layout.total.or(job.declared_size).unwrap_or(0);
        if total > 0 {
            let task_id = job.task_id.clone();
            let progress_total = total.min(i64::MAX as u64) as i64;
            let _ = with_db(db, move |c| {
                crate::db::store::set_download_total_bytes(c, &task_id, progress_total)
            })
            .await;
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(AttemptError::Stopped);
        }
        let (output, staged) = open_output(job, append, existing)?;
        // file 后声明先析构，Windows 上清理 staged 时文件句柄已关闭。
        let mut file = output;
        let mut written = if append { existing } else { 0 };
        let mut received = 0u64;
        let mut verified = 0usize;
        let tail = if append { overlap.as_slice() } else { &[] };
        let mut last_pct = -1.0f64;
        let mut last_write = std::time::Instant::now();
        loop {
            let Some(chunk) =
                network_wait(cancel, CHUNK_TIMEOUT, "读取下载数据", resp.chunk()).await?
            else {
                break;
            };
            if cancel.load(Ordering::SeqCst) {
                return Err(AttemptError::Stopped);
            }
            received = received
                .checked_add(chunk.len() as u64)
                .filter(|n| *n <= i64::MAX as u64)
                .ok_or_else(|| AttemptError::Fatal("下载文件过大".to_string()))?;
            if layout.body_length.is_some_and(|n| received > n) {
                return Err(AttemptError::Retryable(
                    "下载数据超出服务器声明的长度".to_string(),
                ));
            }
            let check = (tail.len() - verified).min(chunk.len());
            if chunk[..check] != tail[verified..verified + check] {
                // 尚未核完重叠段时一个新字节也没有追加；只允许这一次从零重下。
                drop(file);
                resume = false;
                continue 'request;
            }
            verified += check;
            let data = &chunk[check..];
            file.write_all(data).map_err(|e| {
                if is_disk_full(&e) {
                    AttemptError::Fatal("磁盘空间不足，请清理后重试".to_string())
                } else {
                    AttemptError::Fatal(format!("写入文件失败: {e}"))
                }
            })?;
            written += data.len() as u64;

            // 进度按 2% 或 1s 节流写库，declared_size 只作分母，不参与收尾校验。
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

        if verified != tail.len()
            || layout.body_length.is_some_and(|n| received != n)
            || layout.total.is_some_and(|n| written != n)
        {
            return Err(AttemptError::Retryable(
                "下载不完整，请稍后重试".to_string(),
            ));
        }
        if written == 0 {
            return Err(AttemptError::Fatal("下载内容为空".to_string()));
        }
        file.flush()
            .map_err(|e| AttemptError::Fatal(format!("写入文件失败: {e}")))?;
        file.sync_all()
            .map_err(|e| AttemptError::Fatal(format!("刷新磁盘失败: {e}")))?;
        drop(file);
        if cancel.load(Ordering::SeqCst) {
            return Err(AttemptError::Stopped);
        }

        let source = staged.as_ref().map_or(&job.part_path, |f| &f.0);
        if let Some(parent) = job.final_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AttemptError::Fatal(format!("创建下载目录失败: {e}")))?;
        }
        // std::fs::rename 会替换已有目标；失败时保留旧成品与断点，不先删文件。
        std::fs::rename(source, &job.final_path)
            .map_err(|e| AttemptError::Fatal(format!("保存文件失败: {e}")))?;
        if staged.is_some() {
            let _ = std::fs::remove_file(&job.part_path);
        }
        return Ok(written as i64);
    }
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

/// 「下载完成后同时保存封面 / 歌词」两个开关的设置键（用户 2026-11 下载管理
/// 完善：参考网易云等，歌拷到别的播放器 / 设备上也能有图有词）。
/// 与 settings 表通用口径一致：`"0"` = 关，其他 / 未设置 = 开，**默认开**。
pub const SETTING_DOWNLOAD_SAVE_COVER: &str = "download.saveCover";
pub const SETTING_DOWNLOAD_SAVE_LYRIC: &str = "download.saveLyric";

/// 封面字节 → 扩展名。只认常见的四种魔数；认不出（错误页 / HTML）就不落盘，
/// 免得在下载目录里攒垃圾文件。
fn cover_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        Some("png")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else if bytes.starts_with(b"GIF8") {
        Some("gif")
    } else {
        None
    }
}

/// 读取「下载 sidecar」类开关：`"0"` = 关，其他（含未设置）= 开。默认开——
/// 网易云 / QQ 音乐也都是默认连封面歌词一起存，想要干净目录的去设置页关。
async fn download_flag_on(db: &Arc<Database>, key: &str) -> bool {
    let key = key.to_string();
    with_db(db, move |c| crate::db::store::get_setting(c, &key))
        .await
        .ok()
        .flatten()
        .map(|v| v != "0")
        .unwrap_or(true)
}

/// 下载成功后把封面 / 歌词存到歌曲旁边（`<音频文件名>.<ext>` / `.lrc`）。
/// 由 `launch_download` 在 [`run_job_with_slot`] 拿到 Done 之后调用：
/// - 封面：取**原图**（不走代取的缩略图改写与内存缓存，见
///   `qtres::fetch_cover_original_bytes`），按魔数定扩展名；
/// - 歌词：把库里已有的歌词先落一份 `.lrc`。下载当时还没词的（比如刚加的新歌），
///   前端在之后拿到词时经 `write_download_lyric` 命令补写同一个文件。
///
/// 任何一步失败都只记日志：sidecar 是锦上添花，不能反过来把下载链路拖挂。
pub async fn save_download_extras(
    db: Arc<Database>,
    track: &crate::provider::types::Track,
    final_path: &Path,
) {
    let save_cover = download_flag_on(&db, SETTING_DOWNLOAD_SAVE_COVER).await;
    let save_lyric = download_flag_on(&db, SETTING_DOWNLOAD_SAVE_LYRIC).await;

    if save_cover && !track.pic_url.trim().is_empty() {
        let url = track.pic_url.clone();
        // 封面代取是阻塞 HTTP，挪进 blocking 池，别占着 tokio worker
        let bytes = tauri::async_runtime::spawn_blocking(move || {
            crate::qtres::fetch_cover_original_bytes(&url)
        })
        .await
        .ok()
        .flatten();
        if let Some(bytes) = bytes {
            match cover_ext(&bytes) {
                Some(ext) => {
                    let cover_path = final_path.with_extension(ext);
                    if let Err(e) = std::fs::write(&cover_path, &bytes) {
                        log::warn!("[download] 封面存盘失败: {e}");
                    } else {
                        log::info!("[download] 封面已存: {}", cover_path.display());
                    }
                }
                None => log::warn!("[download] 封面格式未识别，跳过存盘"),
            }
        }
    }

    if save_lyric {
        let track_key = crate::db::store::db_track_id(track);
        let existing = with_db(&db, move |c| crate::db::store::get_lyric(c, &track_key))
            .await
            .ok()
            .flatten();
        if let Some(rec) = existing {
            if !rec.lrc.trim().is_empty() {
                let lrc_path = final_path.with_extension("lrc");
                if let Err(e) = std::fs::write(&lrc_path, rec.lrc.as_bytes()) {
                    log::warn!("[download] 歌词存盘失败: {e}");
                } else {
                    log::info!("[download] 歌词已存: {}", lrc_path.display());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::AtomicUsize;
    use std::thread;

    struct HttpReply {
        bytes: Vec<u8>,
        hold_headers: bool,
        hold_body: bool,
    }

    impl HttpReply {
        fn new(code: u16, headers: &str, body: &[u8]) -> Self {
            let mut bytes = format!(
                "HTTP/1.1 {code} Test\r\nContent-Type: audio/mpeg\r\nConnection: close\r\n{headers}\r\n"
            )
            .into_bytes();
            bytes.extend_from_slice(body);
            Self {
                bytes,
                hold_headers: false,
                hold_body: false,
            }
        }

        fn full(body: &[u8]) -> Self {
            Self::new(200, &format!("Content-Length: {}\r\n", body.len()), body)
        }

        fn range(start: u64, total: u64, body: &[u8]) -> Self {
            Self::new(
                206,
                &format!(
                    "Content-Range: bytes {start}-{}/{total}\r\nContent-Length: {}\r\n",
                    total - 1,
                    body.len()
                ),
                body,
            )
        }
    }

    /// 真实 TCP / reqwest 链路，不改全局代理配置；停止旗标保证失败断言也能收线程。
    struct MockHttp {
        url: String,
        requests: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        thread: Option<thread::JoinHandle<()>>,
    }

    impl MockHttp {
        fn new(replies: Vec<HttpReply>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!(
                "http://{}/audio?signature=private",
                listener.local_addr().unwrap()
            );
            let requests = Arc::new(Mutex::new(Vec::new()));
            let recorded = Arc::clone(&requests);
            let stop = Arc::new(AtomicBool::new(false));
            let stopped = Arc::clone(&stop);
            let thread = thread::spawn(move || {
                for reply in replies {
                    let mut stream = loop {
                        if stopped.load(Ordering::SeqCst) {
                            return;
                        }
                        match listener.accept() {
                            Ok((stream, _)) => break stream,
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                thread::sleep(Duration::from_millis(2));
                            }
                            Err(e) => panic!("mock accept: {e}"),
                        }
                    };
                    stream
                        .set_read_timeout(Some(Duration::from_millis(100)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut request = Vec::new();
                    while !request.ends_with(b"\r\n\r\n") {
                        if stopped.load(Ordering::SeqCst) {
                            return;
                        }
                        let mut buf = [0; 1024];
                        match stream.read(&mut buf) {
                            Ok(0) => return,
                            Ok(n) => request.extend_from_slice(&buf[..n]),
                            Err(e)
                                if matches!(
                                    e.kind(),
                                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                                ) =>
                            {
                                continue
                            }
                            Err(_) => return,
                        }
                        assert!(request.len() < 16 * 1024);
                    }
                    recorded
                        .lock()
                        .unwrap()
                        .push(String::from_utf8(request).unwrap());
                    if !reply.hold_headers {
                        let _ = stream.write_all(&reply.bytes);
                        let _ = stream.flush();
                    }
                    while (reply.hold_headers || reply.hold_body) && !stopped.load(Ordering::SeqCst)
                    {
                        thread::sleep(Duration::from_millis(2));
                    }
                }
            });
            Self {
                url,
                requests,
                stop,
                thread: Some(thread),
            }
        }

        fn ranges(&self) -> Vec<Option<String>> {
            self.requests
                .lock()
                .unwrap()
                .iter()
                .map(|r| {
                    r.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("range")
                            .then(|| value.trim().to_string())
                    })
                })
                .collect()
        }
    }

    impl Drop for MockHttp {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            self.thread.take().unwrap().join().unwrap();
        }
    }

    struct TestDir(PathBuf);

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    struct DownloadFixture {
        db: Arc<Database>,
        job: DownloadJob,
        _dir: TestDir,
    }

    impl DownloadFixture {
        fn new(server: &MockHttp, existing: &[u8]) -> Self {
            let dir = TestDir(std::env::temp_dir().join(format!(
                "quietmusic-download-{}-{}",
                std::process::id(),
                fastrand::u64(..)
            )));
            std::fs::create_dir_all(&dir.0).unwrap();
            let db = Arc::new(Database::open(&dir.0.join("test.db")).unwrap());
            let final_path = dir.0.join("track.mp3");
            let part_path = part_path_for(&final_path);
            std::fs::write(&part_path, existing).unwrap();
            let job = DownloadJob {
                task_id: "test-download".to_string(),
                url: server.url.clone(),
                referer: "https://example.test/player".to_string(),
                declared_size: None,
                final_path,
                part_path,
            };
            Self { db, job, _dir: dir }
        }

        async fn attempt(&self) -> Result<i64, AttemptError> {
            attempt_once(&self.db, &self.job, &Arc::new(AtomicBool::new(false))).await
        }

        fn assert_done(&self, bytes: &[u8]) {
            assert_eq!(std::fs::read(&self.job.final_path).unwrap(), bytes);
            assert!(!self.job.part_path.exists());
        }

        fn assert_retained(&self, bytes: &[u8]) {
            assert!(!self.job.final_path.exists(), "无效响应不得提升成品");
            assert_eq!(std::fs::read(&self.job.part_path).unwrap(), bytes);
            assert!(
                !std::fs::read_dir(&self._dir.0).unwrap().any(|entry| {
                    entry
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .contains(".restart-")
                }),
                "重下临时文件必须在退出时清理"
            );
        }
    }

    #[test]
    fn content_range_parser_rejects_invalid_or_unknown_bounds() {
        assert_eq!(
            parse_byte_range("bytes 2-9/10"),
            Some(ByteRange {
                start: 2,
                end: 9,
                total: 10
            })
        );
        for value in [
            "",
            "items 0-9/10",
            "bytes 0-9/*",
            "bytes */10",
            "bytes 9-2/10",
            "bytes 0-10/10",
            "bytes 0-0/0",
            "bytes +0-9/10",
            "bytes 0-9/10, bytes 0-9/10",
            "bytes 0-9/18446744073709551616",
        ] {
            assert!(parse_byte_range(value).is_none(), "{value}");
        }
    }

    #[tokio::test]
    async fn http_resume_verifies_bounded_tail_before_appending() {
        let body: Vec<u8> = (0..150_000).map(|i| (i % 251) as u8).collect();
        let existing = 100_000;
        let start = existing - RESUME_OVERLAP as usize;
        let server = MockHttp::new(vec![HttpReply::range(
            start as u64,
            body.len() as u64,
            &body[start..],
        )]);
        let fixture = DownloadFixture::new(&server, &body[..existing]);
        assert_eq!(fixture.attempt().await.unwrap(), body.len() as i64);
        fixture.assert_done(&body);
        assert_eq!(server.ranges(), vec![Some(format!("bytes={start}-"))]);
        assert!(server.requests.lock().unwrap()[0]
            .to_ascii_lowercase()
            .contains("referer: https://example.test/player"));
    }

    #[tokio::test]
    async fn http_changed_overlap_restarts_once_without_combining_versions() {
        let server = MockHttp::new(vec![
            HttpReply::range(0, 8, b"new-data"),
            HttpReply::full(b"new-data"),
        ]);
        let fixture = DownloadFixture::new(&server, b"old-");
        assert_eq!(fixture.attempt().await.unwrap(), 8);
        fixture.assert_done(b"new-data");
        assert_eq!(server.ranges(), vec![Some("bytes=0-".into()), None]);
    }

    #[tokio::test]
    async fn http_ignored_range_uses_full_body_without_old_prefix() {
        let server = MockHttp::new(vec![HttpReply::full(b"new-data")]);
        let fixture = DownloadFixture::new(&server, b"old-");
        assert_eq!(fixture.attempt().await.unwrap(), 8);
        fixture.assert_done(b"new-data");
        assert_eq!(server.ranges().len(), 1);
    }

    #[tokio::test]
    async fn http_invalid_ranges_restart_safely_once() {
        for header in [
            "",
            "Content-Range: bytes 1-7/8\r\n",
            "Content-Range: bytes 0-8/8\r\n",
            "Content-Range: bytes 0-3/8\r\n",
            "Content-Range: bytes 0-7/*\r\n",
            "Content-Range: bytes 0-7/8\r\nContent-Length: 7\r\n",
            "Content-Range: bytes 0-7/8\r\nContent-Range: bytes 0-7/8\r\n",
        ] {
            let server = MockHttp::new(vec![
                HttpReply::new(206, header, b"old-data"),
                HttpReply::full(b"new-data"),
            ]);
            let fixture = DownloadFixture::new(&server, b"old-");
            assert_eq!(fixture.attempt().await.unwrap(), 8, "{header}");
            fixture.assert_done(b"new-data");
            assert_eq!(server.ranges(), vec![Some("bytes=0-".into()), None]);
        }
    }

    #[tokio::test]
    async fn http_repeated_bad_range_stops_after_one_restart() {
        let server = MockHttp::new(vec![
            HttpReply::new(206, "", b"data"),
            HttpReply::new(206, "", b"data"),
        ]);
        let fixture = DownloadFixture::new(&server, b"old-");
        assert!(matches!(
            fixture.attempt().await,
            Err(AttemptError::Fatal(_))
        ));
        fixture.assert_retained(b"old-");
        assert_eq!(server.ranges(), vec![Some("bytes=0-".into()), None]);
    }

    #[tokio::test]
    async fn http_416_never_promotes_existing_bytes_without_verification() {
        for total in [4, 99] {
            let server = MockHttp::new(vec![
                HttpReply::new(
                    416,
                    &format!("Content-Range: bytes */{total}\r\nContent-Length: 0\r\n"),
                    b"",
                ),
                HttpReply::full(b"new-data"),
            ]);
            let fixture = DownloadFixture::new(&server, b"old-");
            assert_eq!(fixture.attempt().await.unwrap(), 8);
            fixture.assert_done(b"new-data");
            assert_eq!(server.ranges(), vec![Some("bytes=0-".into()), None]);
        }
    }

    #[tokio::test]
    async fn http_truncated_restart_preserves_existing_partial() {
        let server = MockHttp::new(vec![HttpReply::new(
            200,
            "Content-Length: 100\r\n",
            b"short",
        )]);
        let fixture = DownloadFixture::new(&server, b"old-partial");
        assert!(matches!(
            fixture.attempt().await,
            Err(AttemptError::Retryable(_))
        ));
        fixture.assert_retained(b"old-partial");
    }

    #[tokio::test]
    async fn http_truncated_resume_keeps_only_verified_new_bytes() {
        let server = MockHttp::new(vec![HttpReply::new(
            206,
            "Content-Range: bytes 0-9/10\r\nContent-Length: 10\r\n",
            b"abcdef",
        )]);
        let fixture = DownloadFixture::new(&server, b"abc");
        assert!(matches!(
            fixture.attempt().await,
            Err(AttemptError::Retryable(_))
        ));
        let partial = std::fs::read(&fixture.job.part_path).unwrap();
        assert!(b"abcdef".starts_with(&partial));
        assert!(partial.starts_with(b"abc"));
        assert!(!fixture.job.final_path.exists());
    }

    #[tokio::test]
    async fn http_empty_full_response_is_rejected_and_retains_partial() {
        let server = MockHttp::new(vec![HttpReply::full(b"")]);
        let fixture = DownloadFixture::new(&server, b"old-partial");
        assert!(
            matches!(fixture.attempt().await, Err(AttemptError::Fatal(msg)) if msg == "下载内容为空")
        );
        fixture.assert_retained(b"old-partial");
    }

    #[tokio::test]
    async fn http_declared_size_is_progress_only_without_content_length() {
        let server = MockHttp::new(vec![HttpReply::new(
            200,
            "Transfer-Encoding: chunked\r\n",
            b"3\r\nabc\r\n3\r\ndef\r\n0\r\n\r\n",
        )]);
        let mut fixture = DownloadFixture::new(&server, b"");
        fixture.job.declared_size = Some(99);
        assert_eq!(fixture.attempt().await.unwrap(), 6);
        fixture.assert_done(b"abcdef");
    }

    #[tokio::test]
    async fn http_chunked_resume_checks_overlap_across_chunks() {
        let server = MockHttp::new(vec![HttpReply::new(
            206,
            "Content-Range: bytes 0-7/8\r\nTransfer-Encoding: chunked\r\n",
            b"2\r\nab\r\n2\r\ncd\r\n4\r\nefgh\r\n0\r\n\r\n",
        )]);
        let fixture = DownloadFixture::new(&server, b"abcd");
        assert_eq!(fixture.attempt().await.unwrap(), 8);
        fixture.assert_done(b"abcdefgh");
    }

    #[tokio::test]
    async fn http_chunked_range_rejects_short_and_oversized_bodies() {
        for body in [
            b"3\r\nabc\r\n0\r\n\r\n".as_slice(),
            b"9\r\nabcdefghi\r\n0\r\n\r\n".as_slice(),
        ] {
            let server = MockHttp::new(vec![HttpReply::new(
                206,
                "Content-Range: bytes 0-7/8\r\nTransfer-Encoding: chunked\r\n",
                body,
            )]);
            let fixture = DownloadFixture::new(&server, b"abcd");
            assert!(matches!(
                fixture.attempt().await,
                Err(AttemptError::Retryable(_))
            ));
            fixture.assert_retained(b"abcd");
        }
    }

    #[tokio::test]
    async fn http_unsolicited_partial_must_cover_the_complete_object() {
        let server = MockHttp::new(vec![HttpReply::range(2, 8, b"cdefgh")]);
        let fixture = DownloadFixture::new(&server, b"");
        assert!(matches!(
            fixture.attempt().await,
            Err(AttemptError::Fatal(_))
        ));
        fixture.assert_retained(b"");
    }

    #[tokio::test]
    async fn http_fatal_error_keeps_specific_message_in_retry_runner() {
        let server = MockHttp::new(vec![HttpReply::new(403, "Content-Length: 0\r\n", b"")]);
        let fixture = DownloadFixture::new(&server, b"old-partial");
        assert!(
            matches!(run_attempts(&fixture.db, &fixture.job, &Arc::new(AtomicBool::new(false))).await, DownloadOutcome::Failed(msg) if msg == "服务器返回 HTTP 403")
        );
        fixture.assert_retained(b"old-partial");
        assert_eq!(server.ranges().len(), 1);
    }

    #[tokio::test]
    async fn http_cancel_interrupts_header_and_body_waits_preserving_partial() {
        for headers in [true, false] {
            let mut reply = HttpReply::new(200, "Content-Length: 100\r\n", b"some-data");
            reply.hold_headers = headers;
            reply.hold_body = !headers;
            let server = MockHttp::new(vec![reply]);
            let fixture = DownloadFixture::new(&server, b"old-partial");
            let cancel = Arc::new(AtomicBool::new(false));
            let stopper = Arc::clone(&cancel);
            let requests = Arc::clone(&server.requests);
            let stop_task = tokio::spawn(async move {
                while requests.lock().unwrap().is_empty() {
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
                stopper.store(true, Ordering::SeqCst);
            });
            let result = tokio::time::timeout(
                Duration::from_secs(2),
                attempt_once(&fixture.db, &fixture.job, &cancel),
            )
            .await
            .expect("暂停必须及时打断静默网络");
            stop_task.abort();
            assert!(matches!(result, Err(AttemptError::Stopped)));
            fixture.assert_retained(b"old-partial");
        }
    }

    #[tokio::test]
    async fn http_verified_restart_replaces_existing_final_file() {
        let server = MockHttp::new(vec![HttpReply::full(b"new-data")]);
        let fixture = DownloadFixture::new(&server, b"old-partial");
        std::fs::write(&fixture.job.final_path, b"previous-complete").unwrap();
        assert_eq!(fixture.attempt().await.unwrap(), 8);
        fixture.assert_done(b"new-data");
    }

    #[tokio::test]
    async fn http_failed_fallback_preserves_partial_after_mismatch_and_416() {
        for first in [
            HttpReply::range(0, 8, b"new-data"),
            HttpReply::new(416, "Content-Length: 0\r\n", b""),
        ] {
            let server = MockHttp::new(vec![
                first,
                HttpReply::new(503, "Content-Length: 0\r\n", b""),
            ]);
            let fixture = DownloadFixture::new(&server, b"old-");
            assert!(matches!(
                fixture.attempt().await,
                Err(AttemptError::Retryable(_))
            ));
            fixture.assert_retained(b"old-");
            assert_eq!(server.ranges(), vec![Some("bytes=0-".into()), None]);
        }
    }

    #[tokio::test]
    async fn http_full_headers_override_stale_declared_size() {
        let server = MockHttp::new(vec![HttpReply::full(b"abcdef")]);
        let mut fixture = DownloadFixture::new(&server, b"");
        fixture.job.declared_size = Some(99);
        assert_eq!(fixture.attempt().await.unwrap(), 6);
        fixture.assert_done(b"abcdef");
    }

    #[tokio::test]
    async fn http_encoded_or_non_audio_full_response_preserves_partial() {
        for headers in [
            "Content-Encoding: gzip\r\nContent-Length: 3\r\n",
            "Content-Encoding: identity\r\nContent-Encoding: gzip\r\nContent-Length: 3\r\n",
            "Content-Range: bytes 0-2/3\r\nContent-Length: 3\r\n",
        ] {
            let server = MockHttp::new(vec![HttpReply::new(200, headers, b"abc")]);
            let fixture = DownloadFixture::new(&server, b"old-partial");
            assert!(matches!(
                fixture.attempt().await,
                Err(AttemptError::Fatal(_))
            ));
            fixture.assert_retained(b"old-partial");
        }
        let mut reply = HttpReply::full(b"bad");
        reply.bytes = b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 3\r\nConnection: close\r\n\r\nbad".to_vec();
        let server = MockHttp::new(vec![reply]);
        let fixture = DownloadFixture::new(&server, b"old-partial");
        assert!(
            matches!(fixture.attempt().await, Err(AttemptError::Fatal(msg)) if msg.contains("不是音频"))
        );
        fixture.assert_retained(b"old-partial");
    }

    #[tokio::test]
    async fn http_fatal_after_retryable_keeps_last_specific_error() {
        let server = MockHttp::new(vec![
            HttpReply::new(503, "Content-Length: 0\r\n", b""),
            HttpReply::new(403, "Content-Length: 0\r\n", b""),
        ]);
        let fixture = DownloadFixture::new(&server, b"old-partial");
        assert!(
            matches!(run_attempts(&fixture.db, &fixture.job, &Arc::new(AtomicBool::new(false))).await, DownloadOutcome::Failed(msg) if msg == "服务器返回 HTTP 403")
        );
        fixture.assert_retained(b"old-partial");
        assert_eq!(server.ranges().len(), 2);
    }

    #[tokio::test]
    async fn http_complete_partial_still_requires_overlap_verification() {
        let server = MockHttp::new(vec![HttpReply::range(0, 8, b"abcdefgh")]);
        let fixture = DownloadFixture::new(&server, b"abcdefgh");
        assert_eq!(fixture.attempt().await.unwrap(), 8);
        fixture.assert_done(b"abcdefgh");
    }

    #[tokio::test]
    async fn http_fresh_truncation_and_empty_body_never_promote() {
        for response in [
            HttpReply::new(200, "Content-Length: 8\r\n", b"abc"),
            HttpReply::full(b""),
        ] {
            let server = MockHttp::new(vec![response]);
            let fixture = DownloadFixture::new(&server, b"");
            assert!(fixture.attempt().await.is_err());
            assert!(!fixture.job.final_path.exists());
            assert!(fixture.job.part_path.exists());
        }
    }

    #[tokio::test]
    async fn network_timeout_and_retry_backoff_are_cancelable() {
        let cancel = Arc::new(AtomicBool::new(false));
        let result = network_wait(
            &cancel,
            Duration::from_millis(20),
            "下载请求",
            std::future::pending::<Result<(), reqwest::Error>>(),
        )
        .await;
        assert!(matches!(result, Err(AttemptError::Retryable(msg)) if msg.contains("超时")));
        let flag = Arc::clone(&cancel);
        let stopper = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            flag.store(true, Ordering::SeqCst);
        });
        assert!(matches!(
            tokio::time::timeout(
                Duration::from_secs(1),
                until_stopped(&cancel, tokio::time::sleep(Duration::from_secs(30)))
            )
            .await
            .unwrap(),
            Err(AttemptError::Stopped)
        ));
        stopper.await.unwrap();
    }

    #[test]
    fn part_path_is_suffixed_next_to_target() {
        // 用正斜杠拼路径：Windows 与 Unix 都认它作分隔符。
        // 不能写成 "D:\Music\x.flac" —— 在 Unix 上反斜杠不是分隔符，
        // 整个串会被当成一个文件名，断言只在 Windows 成立。
        let p = part_path_for(Path::new("Music/周杰伦 - 晴天.flac"));
        assert_eq!(
            p.file_name().unwrap().to_str().unwrap(),
            "周杰伦 - 晴天.flac.part"
        );
        // 临时文件与目标文件同目录，否则 rename 会跨设备失败
        assert_eq!(p.parent().unwrap(), Path::new("Music"));
    }

    #[test]
    fn part_path_falls_back_when_target_has_no_file_name() {
        assert_eq!(
            part_path_for(Path::new(""))
                .file_name()
                .unwrap()
                .to_str()
                .unwrap(),
            "download.part"
        );
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
        // 重复登记必须复用同一个旗标：换一个新的会把已置起的取消旗标悄悄抹掉，
        // 表现为「暂停了却还在下」。
        let again = m.register("t1");
        assert!(Arc::ptr_eq(&flag, &again));
        assert!(again.load(Ordering::SeqCst));
        m.unregister("t1");
        assert!(!m.is_active("t1"));
    }

    #[test]
    fn concurrency_is_clamped_to_supported_range() {
        assert_eq!(DEFAULT_CONCURRENCY, 3);
        assert_eq!(clamp_concurrency(0), MIN_CONCURRENCY);
        assert_eq!(clamp_concurrency(1), 1);
        assert_eq!(clamp_concurrency(6), MAX_CONCURRENCY);
        assert_eq!(clamp_concurrency(99), MAX_CONCURRENCY);
        assert_eq!(DownloadManager::new().concurrency(), DEFAULT_CONCURRENCY);
        assert_eq!(DownloadManager::with_concurrency(0).concurrency(), 1);
    }

    /// 闸门核心行为：上限为 2 时第 3 个任务必须等待，而不是一起冲上去。
    #[tokio::test]
    async fn gate_allows_only_configured_concurrency() {
        let m = Arc::new(DownloadManager::with_concurrency(2));
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for i in 0..3 {
            let m = Arc::clone(&m);
            let running = Arc::clone(&running);
            let peak = Arc::clone(&peak);
            handles.push(tokio::spawn(async move {
                let slot = m.begin(&format!("t{i}")).await?;
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                // 模拟一次真实的下载耗时（不碰网络）
                tokio::time::sleep(Duration::from_millis(30)).await;
                running.fetch_sub(1, Ordering::SeqCst);
                drop(slot);
                Some(())
            }));
        }
        // 前两个在跑、第三个还在排队 —— 这一步就是「第 3 个必须等待」的断言
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(m.running(), 2, "上限 2 时最多只该有 2 个在跑");
        for h in handles {
            assert!(h.await.unwrap().is_some(), "三个任务最终都该拿到并发位");
        }
        assert_eq!(
            peak.load(Ordering::SeqCst),
            2,
            "第 3 个必须等前两个之一结束"
        );
        assert_eq!(m.running(), 0, "全部结束后并发位必须归还");
    }

    /// 并发位凭证靠 `Drop` 归还：失败（提前 return）与取消（置旗标）两条路径
    /// 都不能泄漏并发位，否则下载几次之后闸门就永久卡死。
    #[tokio::test]
    async fn slot_is_returned_after_failure_and_cancel() {
        let m = Arc::new(DownloadManager::with_concurrency(1));
        let a = m.begin("a").await.expect("空闸门应立即拿到位子");
        assert_eq!(m.running(), 1);
        // 失败路径：任务中途出错直接 return，凭证随之 drop
        drop(a);
        assert_eq!(m.running(), 0, "失败后并发位必须归还");

        // 取消路径：旗标置起后凭证照样归还
        let b = m.begin("b").await.expect("空出来的位子应立即拿到");
        assert!(m.request_stop("b"), "在下载的任务必须能被取消");
        assert!(b.cancel.load(Ordering::SeqCst));
        drop(b);
        assert_eq!(m.running(), 0, "取消后并发位必须归还");

        // 归还干净了：闸门仍能正常工作
        let c = m.begin("c").await.expect("归还后应能再拿到位子");
        drop(c);
        assert_eq!(m.running(), 0);
    }

    /// 取消一个**还在排队、尚未拿到并发位**的任务：它不得启动，也不占并发位。
    #[tokio::test]
    async fn queued_task_can_be_canceled_before_it_starts() {
        let m = Arc::new(DownloadManager::with_concurrency(1));
        let held = m.begin("running").await.expect("占住唯一的并发位");

        let m2 = Arc::clone(&m);
        let queued = tokio::spawn(async move { m2.begin("queued").await });
        // 让排队任务先跑到「登记完、正在等」的位置
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert!(
            m.is_active("queued"),
            "排队中的任务也必须在登记表里，否则暂停 / 取消够不着它"
        );
        assert_eq!(m.running(), 1, "排队中的任务不占并发位");

        assert!(m.request_stop("queued"), "排队中的任务必须能被取消");
        let slot = queued.await.unwrap();
        assert!(slot.is_none(), "排队中被取消的任务不得启动");
        assert!(!m.is_active("queued"), "被取消后应从登记表摘除");
        assert_eq!(m.running(), 1, "被取消的排队任务不该占位子");

        // 取消不会影响正主
        drop(held);
        assert_eq!(m.running(), 0);
    }

    /// 提高上限要立刻叫醒排队者（否则用户把 1 改成 6 之后毫无反应）。
    #[tokio::test]
    async fn raising_limit_wakes_queued_task() {
        let m = Arc::new(DownloadManager::with_concurrency(1));
        let held = m.begin("a").await.expect("占住唯一的并发位");

        let m2 = Arc::clone(&m);
        let queued = tokio::spawn(async move { m2.begin("b").await });
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert_eq!(m.running(), 1, "上限 1 时第 2 个只能排队");

        m.set_concurrency(2);
        let slot = queued.await.unwrap().expect("提高上限后排队任务应立刻开工");
        assert_eq!(m.running(), 2);
        drop(slot);
        drop(held);
        assert_eq!(m.running(), 0);
    }

    /// 下调上限不掐断在跑的任务，但后续补位立刻按新上限来。
    #[tokio::test]
    async fn lowering_limit_keeps_running_and_applies_to_next() {
        let m = Arc::new(DownloadManager::with_concurrency(3));
        let a = m.begin("a").await.unwrap();
        let b = m.begin("b").await.unwrap();
        let c = m.begin("c").await.unwrap();
        assert_eq!(m.running(), 3);

        m.set_concurrency(1);
        assert_eq!(m.concurrency(), 1);
        assert_eq!(m.running(), 3, "下调上限不该掐断用户已经在等的下载");

        drop(a);
        drop(b);
        assert_eq!(m.running(), 1);

        // 已经到新上限了：第 4 个必须排队
        let m2 = Arc::clone(&m);
        let queued = tokio::spawn(async move { m2.begin("d").await });
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert_eq!(m.running(), 1);

        drop(c);
        let slot = queued.await.unwrap().expect("腾出位子后排队任务应开工");
        assert_eq!(m.running(), 1);
        drop(slot);
        assert_eq!(m.running(), 0);
    }
}
