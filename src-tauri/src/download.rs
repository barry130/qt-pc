//! 下载 2.0：可暂停 / 继续 / 取消 / 重试的下载状态机（DESIGN §5.3）。
//!
//! - 落盘先写 `<最终名>.part`，全部写完并校验后才重命名为成品：中断不会留下
//!   看起来正常的半截文件，也不会被本地扫描器误收。
//! - HTTP 状态 / Content-Type / 字节数三重校验，错误页不会被当作音频存下来。
//! - 断点续传：暂停后保留 `.part`，继续时带 `Range` 从已有字节接着写。
//! - 网络类错误自动退避重试（最多 3 次）；HTTP 4xx 属于确定性失败，直接报错。
//! - 并发闸门：同时最多跑 N 个任务（N 默认 3，可选 1–6，见 `DEFAULT_CONCURRENCY`）。
//!   批量下载不限流会被音源/CDN 判成爬虫封 IP —— LX Music 就栽过（issue #1992），
//!   之后把默认并发压到 3 并在设置页限制 1–6。本项目封面代取（`qtres.rs` 的
//!   `COVER_FETCH_CONCURRENCY`）也走同一套思路，这里补齐下载侧。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

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

    fn limit(&self) -> usize {
        self.state.lock().unwrap().limit
    }

    fn running(&self) -> usize {
        self.state.lock().unwrap().running
    }

    /// 改并发上限。下调不打断在跑的任务，只是它们结束后不再补位。
    fn set_limit(&self, n: usize) {
        self.state.lock().unwrap().limit = clamp_concurrency(n);
        // 叫醒所有排队者重算：下调后可能已超额（它们得继续睡），
        // 上调后有空位（它们应该立刻开工）。
        self.wake.notify_waiters();
    }

    /// 尝试占一个并发位；满了返回 false。
    fn try_enter(&self) -> bool {
        let mut st = self.state.lock().unwrap();
        if st.running < st.limit {
            st.running += 1;
            true
        } else {
            false
        }
    }

    fn release(&self) {
        {
            let mut st = self.state.lock().unwrap();
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
            .unwrap()
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
        self.active.lock().unwrap().remove(id);
    }

    /// 请求停止（暂停 / 取消）。返回该任务当前是否真的在下载（或正在排队）。
    pub fn request_stop(&self, id: &str) -> bool {
        let hit = {
            let map = self.active.lock().unwrap();
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
        self.active.lock().unwrap().contains_key(id)
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
enum AttemptError {
    Stopped,
    Retryable(String),
    Fatal(String),
}

/// 执行一个下载任务（自动重试）。返回结果前会把状态写回数据库。
///
/// 并发闸门就在这个函数的入口：拿不到并发位就排队等着。放在这里而不是
/// 两个调用点各自 acquire，是为了让「启动下载」只有一条路径 ——
/// 漏改一处就等于闸门失效。
pub async fn run_job(
    app: tauri::AppHandle,
    db: Arc<Database>,
    manager: Arc<DownloadManager>,
    job: DownloadJob,
) -> DownloadOutcome {
    match manager.begin(&job.task_id).await {
        // 排队期间任务已登记（`is_active` 为真），所以暂停 / 取消能打断排队中的任务；
        // 若在排队时被取消，命令层已写好终态（paused / canceled），这里什么都不写。
        Some(slot) => run_job_with_slot(app, db, manager, job, slot).await,
        None => DownloadOutcome::Stopped,
    }
}

/// 已持有并发位时的执行入口。
///
/// 「继续 / 重试」那条路径要**先取址再下载**，取址本身也是对音源的一次请求，
/// 所以由调用方先 `begin` 拿到位子、连取址一起算进闸门，再调这里；
/// 这样批量继续 20 个任务不会先把 20 个取址请求同时打出去。
pub async fn run_job_with_slot(
    app: tauri::AppHandle,
    db: Arc<Database>,
    manager: Arc<DownloadManager>,
    job: DownloadJob,
    slot: Slot,
) -> DownloadOutcome {
    let cancel = Arc::clone(&slot.cancel);
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
                    tokio::time::sleep(std::time::Duration::from_millis(400 * attempt as u64))
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

    // 先摘登记表再还并发位：反过来的话，排队者可能在新任务已开工的同时
    // 被旧任务的 unregister 摘掉旗标，取消就落到空处了。
    manager.unregister(&job.task_id);
    drop(slot);
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
    // Referer 由音源包下发（空串 = 该源没声明，不发这个头）。
    // B 站部分 CDN 节点无它直接 403，403 不在 status_retryable 里 → 会被判 Fatal。
    if !job.referer.is_empty() {
        req = req.header("Referer", &job.referer);
    }
    if offset > 0 {
        req = req.header("Range", format!("bytes={offset}-"));
    }
    let resp = req.send().await.map_err(|e| {
        AttemptError::Retryable(format!("请求失败: {}", crate::astral::sanitize_err(e)))
    })?;

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
    let total = if remaining > 0 {
        offset + remaining
    } else {
        // 服务端没给 Content-Length（分块传输 / 省头）时用取链预检量到的总长兜底，
        // 好让下载页仍有进度条；量不到就还是 0（未知，只显示已下载字节）。
        job.declared_size.unwrap_or(0)
    };
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
                return Err(AttemptError::Retryable(format!(
                    "下载中断: {}",
                    crate::astral::sanitize_err(e)
                )));
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
    std::fs::rename(&job.part_path, &job.final_path)
        .map_err(|e| AttemptError::Fatal(format!("保存文件失败: {e}")))?;
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
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

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
        assert_eq!(peak.load(Ordering::SeqCst), 2, "第 3 个必须等前两个之一结束");
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
        let slot = queued
            .await
            .unwrap()
            .expect("提高上限后排队任务应立刻开工");
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
        let slot = queued
            .await
            .unwrap()
            .expect("腾出位子后排队任务应开工");
        assert_eq!(m.running(), 1);
        drop(slot);
        assert_eq!(m.running(), 0);
    }
}
