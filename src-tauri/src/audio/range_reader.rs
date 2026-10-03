//! HttpRangeReader（DESIGN §6.12）：HTTP Range + 磁盘缓冲 + 就绪区间位图。
//!
//! - 为 symphonia 解码器提供 `Read + Seek` 输入（HTTP 响应体只有 Read，无法直接喂解码器）
//! - 后台下载线程顺序写入 `cache/audio/<sha1(url)>.part`，以**字节粒度区间集**记录就绪进度
//!   （读端可立即消费已落盘字节，不等整块；首包超时 8s 判不可播放）
//! - read 落在未就绪区间 → 阻塞等待；seek 到未就绪区间 → 通知下载线程
//!   发起新 Range 请求重定位下载点（含前向 seek；由此产生的空洞由读取触发时回填）
//! - 服务端不支持 Range（200 而非 206）→ 退化为「先下完再播」（spool 模式）
//! - 单曲缓冲上限 100MB

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use sha1::{Digest, Sha1};

/// 首包超时（DESIGN §6.12：默认 8s，判定为不可播放）
pub const FIRST_PACKET_TIMEOUT: Duration = Duration::from_secs(8);
/// 单曲缓冲上限（覆盖 FLAC）
const MAX_BUFFER_BYTES: u64 = 100 * 1024 * 1024;
/// 流中断重试次数（连续失败 → failed，上层广播 audio-error）
const MAX_RETRIES: u32 = 3;
/// 空洞待回填时空闲轮询间隔
const IDLE_POLL: Duration = Duration::from_millis(100);
/// 单个 HTTP 请求的**总量挂死保护**（宽上限，防线程永久阻塞，不是判活）。
///
/// blocking reqwest 只有「总超时」（覆盖到响应体读完）没有空闲读超时：设成
/// FIRST_PACKET_TIMEOUT 的 8s 会把慢源大文件掐死在半路（spool 模式更是下载
/// 超 8s 必失败）。这里放宽到 120s —— 只兜「连接僵死永不返回」的底，让下载
/// 线程最终能带着 Err 退出；真正的**首包/假死判活**由解码侧 `ensure_ready`
/// 的 FIRST_PACKET_TIMEOUT deadline 承担（8s 内等不到数据直接对用户报错，
/// 不等 HTTP 层）。
const HTTP_TOTAL_GUARD: Duration = Duration::from_secs(120);

/// 响应体**单次读**的空闲超时（真・判活）。
///
/// reqwest blocking 没有空闲读超时，只有覆盖「建连 + 读完整个 body」的总超时；
/// 服务端收下请求后既不回数据也不关连接时，`body.read()` 会一直阻塞 —— 上面
/// 的 HTTP_TOTAL_GUARD 是挂在 request 上的总超时，而这个 body 已经在读了，
/// 只能等它自己到点，最坏就是把下载线程按 120s 冻住。弱网下反复触发会把
/// 缓冲卡成「有洞但不补齐」，解码侧只能靠 ensure_ready 判死后换源。
///
/// 所以这里用 `BodyReader` 把 body 挪进独立线程，用 channel 收包：下载线程侧
/// 只做 `recv_timeout`，超时即判定连接假死，丢掉整个 reader（后台线程随 body 的
/// 总超时自行退出）并按 Err 走既有的重连/重试路径。这比调 client 的
/// `read_timeout` 更可靠 —— reqwest blocking 从未提供过该选项（本仓历史上也没
/// 有）。空闲阈值取 20s：明显大于正常分片间隔（首包判活另有 ensure_ready 的
/// 8s），又远小于 120s 总兜底，弱网下能及时暴露假死连接。
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(20);
/// `BodyReader` 收包用的有界通道容量（1 帧 8KB，够了；上限防慢读方堆积内存）
const BODY_CHANNEL_CAP: usize = 8;
/// 有序、不相交的就绪字节区间集 `[start, end)`。下载线程写，读线程锁内等。
#[derive(Default)]
struct ReadySpans {
    spans: Vec<(u64, u64)>,
}

impl ReadySpans {
    fn add(&mut self, start: u64, end: u64) {
        if end <= start {
            return;
        }
        let (mut s, mut e) = (start, end);
        let mut out: Vec<(u64, u64)> = Vec::with_capacity(self.spans.len() + 1);
        let mut placed = false;
        for &(a, b) in &self.spans {
            if a > e {
                if !placed {
                    out.push((s, e));
                    placed = true;
                }
                out.push((a, b));
            } else if b >= s {
                // 相交或相邻合并
                s = s.min(a);
                e = e.max(b);
            } else {
                out.push((a, b));
            }
        }
        if !placed {
            out.push((s, e));
        }
        self.spans = out;
    }

    /// `pos` 所在就绪区间的末端（pos 未就绪则返回 pos 本身）
    fn ready_upto(&self, pos: u64) -> u64 {
        for &(a, b) in &self.spans {
            if a > pos {
                break;
            }
            if pos < b {
                return b;
            }
        }
        pos
    }

    fn is_ready_at(&self, pos: u64) -> bool {
        self.ready_upto(pos) > pos
    }

    fn covers(&self, start: u64, end: u64) -> bool {
        if end <= start {
            return true;
        }
        let mut p = start;
        while p < end {
            let u = self.ready_upto(p);
            if u <= p {
                return false;
            }
            p = u;
        }
        true
    }

    fn total_bytes(&self) -> u64 {
        self.spans.iter().map(|(a, b)| b - a).sum()
    }
}

/// 跨线程共享状态：下载线程写，读线程等。
pub struct RangeShared {
    url: String,
    file_path: PathBuf,
    supports_ranges: bool,
    ready: Mutex<ReadySpans>,
    ready_cv: Condvar,
    /// 读取方期望的下载位置（seek 重定位，字节精确）
    desired: AtomicU64,
    /// 总长度；spool 模式在完成后回填
    total_len: Mutex<Option<u64>>,
    complete: AtomicBool,
    failed: AtomicBool,
}

impl RangeShared {
    pub fn url(&self) -> &str {
        &self.url
    }

    /// 本流的磁盘缓冲文件路径（清理缓存时跳过正在使用的文件）。
    pub fn path(&self) -> &Path {
        &self.file_path
    }

    pub fn supports_ranges(&self) -> bool {
        self.supports_ranges
    }

    pub fn total_len(&self) -> Option<u64> {
        *self.total_len.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn complete(&self) -> bool {
        self.complete.load(Ordering::SeqCst)
    }

    pub fn failed(&self) -> bool {
        self.failed.load(Ordering::SeqCst)
    }

    /// 已就绪字节总数（供 bufferedMs 估算）
    pub fn ready_bytes(&self) -> u64 {
        self.ready.lock().unwrap_or_else(|p| p.into_inner()).total_bytes()
    }

    fn set_total(&self, len: u64) {
        let mut t = self.total_len.lock().unwrap_or_else(|p| p.into_inner());
        if t.is_none() || t.is_some_and(|v| len > v) {
            *t = Some(len);
        }
    }

    fn add_ready(&self, start: u64, end: u64) {
        self.ready.lock().unwrap_or_else(|p| p.into_inner()).add(start, end);
        self.ready_cv.notify_all();
    }

    fn is_ready_at(&self, pos: u64) -> bool {
        self.ready.lock().unwrap_or_else(|p| p.into_inner()).is_ready_at(pos)
    }

    fn covers(&self, start: u64, end: u64) -> bool {
        self.ready.lock().unwrap_or_else(|p| p.into_inner()).covers(start, end)
    }

    fn wake_all(&self) {
        self.ready_cv.notify_all();
    }
}

struct DownloaderGuard {
    shared: Arc<RangeShared>,
}

impl Drop for DownloaderGuard {
    fn drop(&mut self) {
        // 下载线程退出时唤醒所有等待者，避免 read 永久阻塞
        self.shared.wake_all();
    }
}

/// 打开远程音频：发首个 Range 请求，创建缓冲文件，启动后台下载线程。
/// 返回 (reader, shared)；reader 随后包进 BufReader 交给 Decoder。
pub fn open(
    url: &str,
    client: &reqwest::blocking::Client,
    cache_dir: &Path,
) -> io::Result<(HttpRangeReader, Arc<RangeShared>)> {
    std::fs::create_dir_all(cache_dir)?;

    let file_path = cache_dir.join(format!("{}.part", sha1_hex(url)));

    // M0：不处理 .part 续传，残留直接删除重建
    if file_path.exists() {
        let _ = std::fs::remove_file(&file_path);
    }

    // 首个 Range 请求：bytes=0- 同时探测 Accept-Ranges 与总长。
    // 判活不用短总超时：per-request .timeout() 覆盖到响应体读完，8s 会把慢源
    // 大文件掐死在半路（spool 模式更是必失败）。这里只挂 HTTP_TOTAL_GUARD
    // 兜「请求永不返回」的底；用户可见的首包判活由 ensure_ready 的 8s deadline
    // 承担（见该函数与 HTTP_TOTAL_GUARD 的注释）
    let resp = client
        .get(url)
        .header("Range", "bytes=0-")
        .timeout(HTTP_TOTAL_GUARD)
        .send()
        .map_err(|e| {
            // 完整地址只进日志；抛给上层的错误不带 URL（含后端/存储域名）
            log::warn!("[audio] 打开音频流失败: {url} ({e})");
            io::Error::other(format!(
                "打开音频流失败: {}",
                crate::astral::sanitize_err(e)
            ))
        })?;
    let status = resp.status();
    if !status.is_success() {
        return Err(io::Error::other(format!("音频流 HTTP {status}")));
    }
    // 206 时确认起点真的是 0（我们请求的就是 bytes=0-）：起点不符说明这响应
    // 不是我们要的那段，喂给解码器就是错位数据（详见 issue_range 的说明）。
    if status == reqwest::StatusCode::PARTIAL_CONTENT {
        if let Some(start) = content_range_start(&resp) {
            if start != 0 {
                return Err(io::Error::other(format!(
                    "音频流响应起点异常（Content-Range 起点 {start}）"
                )));
            }
        }
    }
    let supports_ranges = status == reqwest::StatusCode::PARTIAL_CONTENT
        || resp
            .headers()
            .get("accept-ranges")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.eq_ignore_ascii_case("bytes"));
    let total_from_header = resp
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&file_path)?;

    let shared = Arc::new(RangeShared {
        url: url.to_string(),
        file_path: file_path.clone(),
        supports_ranges,
        ready: Mutex::new(ReadySpans::default()),
        ready_cv: Condvar::new(),
        desired: AtomicU64::new(0),
        total_len: Mutex::new(total_from_header),
        complete: AtomicBool::new(false),
        failed: AtomicBool::new(false),
    });

    if let Some(len) = total_from_header {
        if len > MAX_BUFFER_BYTES {
            return Err(io::Error::other(format!(
                "音频文件超出缓冲上限（{len} 字节）"
            )));
        }
        file.set_len(len)?;
    }

    let reader = HttpRangeReader {
        file,
        pos: 0,
        shared: Arc::clone(&shared),
    };

    // 后台下载线程：每曲一个（DESIGN §7.4「下载/解码线程」）
    let dl_shared = Arc::clone(&shared);
    let dl_url = url.to_string();
    let dl_client = client.clone();
    std::thread::Builder::new()
        .name("audio-downloader".into())
        .spawn(move || {
            let _guard = DownloaderGuard {
                shared: Arc::clone(&dl_shared),
            };
            run_downloader(dl_shared, dl_url, dl_client, resp);
        })?;

    Ok((reader, shared))
}

/// 把 HTTP 响应体挪进独立线程、以有界通道回传的 `Read` 包装。
///
/// 存在的唯一理由：给 `body.read()` 加**空闲超时**。blocking reqwest 的
/// `Response::read` 没有超时参数，服务端收下请求后既不发包也不关连接时它会一直
/// 阻塞，把下载线程冻到 120s 的 HTTP_TOTAL_GUARD 才醒（弱网下频繁发生）。
/// 把读操作丢到后台线程后，下载线程侧就能用 `recv_timeout` 主动判死并放弃该连接。
///
/// 语义：
/// - 超时 → `TimedOut`（调用方按断流处理，重发 Range 或计数重试）
/// - 通道断开（后台线程退出）→ `Ok(0)`，等价于原 body 的 EOF
/// - 后台线程是 detached 的：被放弃后它会继续阻塞到 body 总超时再自然退出，
///   不改内存安全性（它只持有 body 和 sender，不碰共享状态）
struct BodyReader {
    rx: std::sync::mpsc::Receiver<io::Result<Vec<u8>>>,
    pending: Vec<u8>,
    off: usize,
    /// 当前帧发完后是否已有 EOF 信号（后台线程在 EOF 后退出 → 通道断开）
    done: bool,
}

/// `BodyReader::read` 的结果：区分「真 EOF」与「空闲超时」
enum BodyRead {
    Data(usize),
    Eof,
    TimedOut,
}

impl BodyReader {
    /// 起一个 detach 的读线程把 `body` 的内容推入有界通道
    fn new(mut body: Box<dyn Read + Send>) -> Self {
        let (tx, rx) = std::sync::mpsc::sync_channel::<io::Result<Vec<u8>>>(BODY_CHANNEL_CAP);
        let _ = std::thread::Builder::new()
            .name("audio-body-read".into())
            .spawn(move || {
                let mut buf = vec![0u8; 64 * 1024];
                loop {
                    match body.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            // 通道断开 = 下载线程已放弃本连接，直接退出
                            if tx.send(Ok(buf[..n].to_vec())).is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            let _ = tx.send(Err(e));
                            break;
                        }
                    }
                }
            });
        Self {
            rx,
            pending: Vec::new(),
            off: 0,
            done: false,
        }
    }

    /// 带空闲超时的读：只有真 EOF 才返回 `BodyRead::Eof`
    fn read_with_timeout(&mut self, out: &mut [u8], idle: Duration) -> BodyRead {
        if self.off >= self.pending.len() {
            if self.done {
                return BodyRead::Eof;
            }
            match self.rx.recv_timeout(idle) {
                Ok(Ok(data)) => {
                    if data.is_empty() {
                        self.done = true;
                        return BodyRead::Eof;
                    }
                    self.pending = data;
                    self.off = 0;
                }
                Ok(Err(e)) => {
                    // 读错误与「连接假死」在上层同路（都走重连），这里留一行日志区分
                    log::warn!("[audio] 响应体读取失败: {e}");
                    self.done = true;
                    return BodyRead::TimedOut;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => return BodyRead::TimedOut,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    self.done = true;
                    return BodyRead::Eof;
                }
            }
        }
        let n = (self.pending.len() - self.off).min(out.len());
        out[..n].copy_from_slice(&self.pending[self.off..self.off + n]);
        self.off += n;
        BodyRead::Data(n)
    }
}

fn run_downloader(
    shared: Arc<RangeShared>,
    url: String,
    client: reqwest::blocking::Client,
    initial_resp: reqwest::blocking::Response,
) {
    let file = match OpenOptions::new().write(true).open(&shared.file_path) {
        Ok(f) => f,
        Err(_) => {
            shared.failed.store(true, Ordering::SeqCst);
            shared.wake_all();
            return;
        }
    };
    let mut writer = file;
    let mut pos: u64 = 0;
    // 初始响应体就是从 0 开始的流（206 bytes=0- 或 200 全量）
    let mut body = BodyReader::new(Box::new(initial_resp));
    let mut retries: u32 = 0;
    let mut buf = vec![0u8; 64 * 1024];
    // 流已读到 EOF 但文件尚未完整（存在空洞或被提前掐断）
    let mut eof: bool = false;

    loop {
        if shared.complete.load(Ordering::SeqCst) || shared.failed.load(Ordering::SeqCst) {
            return;
        }

        // seek 重定位：读取方想要的位置未就绪 → 重新发 Range 请求
        // （§6.12：落在未就绪区间且服务端支持 Range → 发起新 Range 请求并重定位下载点）
        // 流已 EOF 时即使 want == pos 也要重发：连接可能被提前掐断，重连补数据
        let want = shared.desired.load(Ordering::SeqCst);
        if shared.supports_ranges && !shared.is_ready_at(want) && (want != pos || eof) {
            match issue_range(&client, &url, want) {
                Ok(resp) => {
                    body = BodyReader::new(Box::new(resp));
                    pos = want;
                    eof = false;
                    retries = 0;
                }
                Err(_) => {
                    retries += 1;
                    if retries >= MAX_RETRIES {
                        shared.failed.store(true, Ordering::SeqCst);
                        shared.wake_all();
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                    continue;
                }
            }
        }

        if eof {
            // 空洞待回填且无读取方请求：空闲等待 desired 变化
            std::thread::sleep(IDLE_POLL);
            continue;
        }

        match body.read_with_timeout(&mut buf, READ_IDLE_TIMEOUT) {
            BodyRead::Eof => {
                // EOF：流到达文件尾。仅当就绪区间连续覆盖到总长才算完成；
                // 存在空洞（前向 seek 跳过的区间）时转入空闲，等读取方触发回填。
                // 注：判活是 BodyReader 的空闲读超时（READ_IDLE_TIMEOUT），卡死的
                // 连接走 TimedOut 重试而不是伪装成 EOF —— 走到这里的 Eof 只可能是
                // 服务端正常收尾（无 Content-Length 的 close-delimited 响应），
                // 此时以已收字节数为总长是「信任收尾」的正确语义
                eof = true;
                let total = shared.total_len().unwrap_or(pos);
                if shared.total_len().is_none() {
                    log::warn!("[audio] 无 Content-Length 的流在 {pos} 字节处收尾（close-delimited）");
                }
                shared.set_total(total);
                let _ = writer.set_len(total);
                if shared.covers(0, total) {
                    shared.complete.store(true, Ordering::SeqCst);
                    shared.wake_all();
                    return;
                }
                shared.wake_all();
            }
            BodyRead::Data(n) => {
                if shared.total_len().is_some_and(|t| pos + n as u64 > t) {
                    // 超出声明的总长：视为异常，防止缓冲越界
                    shared.failed.store(true, Ordering::SeqCst);
                    shared.wake_all();
                    return;
                }
                if writer.seek(SeekFrom::Start(pos)).is_err()
                    || writer.write_all(&buf[..n]).is_err()
                {
                    shared.failed.store(true, Ordering::SeqCst);
                    shared.wake_all();
                    return;
                }
                shared.add_ready(pos, pos + n as u64);
                pos += n as u64;
                shared.wake_all();
                retries = 0;
            }
            BodyRead::TimedOut => {
                // 空闲读超时（连接假死）与读错误同路：重连或计数重试
                retries += 1;
                log::warn!(
                    "[audio] 响应体空闲超过 {}s，判定连接假死（pos={pos} 第 {retries} 次）",
                    READ_IDLE_TIMEOUT.as_secs()
                );
                if retries >= MAX_RETRIES || !shared.supports_ranges {
                    shared.failed.store(true, Ordering::SeqCst);
                    shared.wake_all();
                    return;
                }
                std::thread::sleep(Duration::from_millis(500 * retries as u64));
                // Range 模式从当前断点重连
                match issue_range(&client, &url, pos) {
                    Ok(resp) => body = BodyReader::new(Box::new(resp)),
                    Err(_) => continue,
                }
            }
        }
    }
}

/// 断流重连用的 Range 请求。
///
/// **必须确认响应体真的从 `from` 开始**（2026-10-03 事故）：服务端偶尔会无视
/// Range 头直接返回 200 + 整文件（CDN 回源、WAF 改写、签名 URL 换源都可能）。
/// 把这种 body 当成「从 from 开始的字节」写进文件偏移 `from`，整条流从此字节错位；
/// 解码器按错位数据切 FLAC 帧，最终在 symphonia 里以整数下溢 panic 打死音频回调
/// 线程 —— 用户看到的是「播到一半卡死、没有任何报错」。
/// 所以这里只接受 2xx 且（`from > 0` 时）必须是 206，Content-Range 起点不符即丢弃。
fn issue_range(
    client: &reqwest::blocking::Client,
    url: &str,
    from: u64,
) -> Result<reqwest::blocking::Response, ()> {
    let resp = client
        .get(url)
        .header("Range", format!("bytes={from}-"))
        // 宽总量挂死保护（HTTP_TOTAL_GUARD），不是判活：断流重连也要保证
        // 下载线程最终能带着 Err 退出重试
        .timeout(HTTP_TOTAL_GUARD)
        .send()
        .map_err(|_| ())?;
    let status = resp.status();
    // 4xx/5xx 的响应体绝不能当音频数据写进缓冲
    if !status.is_success() {
        log::warn!("[audio] 重连返回 HTTP {status}（请求 bytes={from}-），丢弃本次响应");
        return Err(());
    }
    // from == 0 时 200（整文件）与 206 语义等价，可直接用；from > 0 时 200
    // 意味着 body 从 0 开始，写进去就是错位数据，必须拒绝
    if from > 0 && status != reqwest::StatusCode::PARTIAL_CONTENT {
        log::warn!(
            "[audio] 重连时服务端未按 Range 应答（HTTP {status}，请求 bytes={from}-），丢弃本次响应"
        );
        return Err(());
    }
    if let Some(start) = content_range_start(&resp) {
        if start != from {
            log::warn!(
                "[audio] 重连响应起点不符（Content-Range 起点 {start} ≠ 请求 {from}），丢弃本次响应"
            );
            return Err(());
        }
    }
    Ok(resp)
}

/// 取 `Content-Range: bytes start-end/total` 里的起点；头缺失或形态异常返回 None。
fn content_range_start(resp: &reqwest::blocking::Response) -> Option<u64> {
    parse_content_range_start(resp.headers().get("content-range")?.to_str().ok()?)
}

/// `content_range_start` 的纯解析部分（单测直接打它）。
fn parse_content_range_start(raw: &str) -> Option<u64> {
    let rest = raw.trim().strip_prefix("bytes")?;
    rest.trim_start().split('-').next()?.trim().parse::<u64>().ok()
}

/// 供 rodio/symphonia 使用的 Read + Seek 包装。
pub struct HttpRangeReader {
    file: File,
    pos: u64,
    shared: Arc<RangeShared>,
}

impl HttpRangeReader {
    pub fn shared(&self) -> Arc<RangeShared> {
        Arc::clone(&self.shared)
    }
}

impl Read for HttpRangeReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let shared = &self.shared;
        self.ensure_ready(self.pos)?;

        let total = shared.total_len();
        if let Some(t) = total {
            if self.pos >= t {
                return Ok(0);
            }
        } else if shared.complete() {
            return Ok(0);
        }

        // 只读当前 pos 所在就绪区间的末端为止，绝不越过未就绪字节
        let span_end = shared.ready.lock().unwrap_or_else(|p| p.into_inner()).ready_upto(self.pos);
        let upper = total.unwrap_or(u64::MAX).min(span_end);
        let max = upper.saturating_sub(self.pos) as usize;
        let want = buf.len().min(max);
        if want == 0 {
            // ensure_ready 已确认就绪但区间为空：仅可能 complete 且 pos == total
            return Ok(0);
        }

        let mut f = &self.file;
        f.seek(SeekFrom::Start(self.pos))?;
        let n = f.read(&mut buf[..want])?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for HttpRangeReader {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let new_pos = match to {
            SeekFrom::Start(p) => p as i64,
            SeekFrom::End(e) => {
                let total = self
                    .shared
                    .total_len()
                    .ok_or_else(|| io::Error::other("seek End：总长未知"))?;
                total as i64 + e
            }
            SeekFrom::Current(d) => self.pos as i64 + d,
        };
        if new_pos < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek 到负位置"));
        }
        self.pos = new_pos as u64;
        // seek 到未就绪区间 → 通知下载线程重定位（字节精确）
        let shared = &self.shared;
        if !shared.complete() && shared.supports_ranges && !shared.is_ready_at(self.pos) {
            shared.desired.store(self.pos, Ordering::SeqCst);
            shared.wake_all();
        }
        Ok(self.pos)
    }
}

impl HttpRangeReader {
    fn ensure_ready(&self, pos: u64) -> io::Result<()> {
        let shared = &self.shared;
        if shared.failed() {
            return Err(io::Error::other("音频下载失败"));
        }
        if shared.complete() {
            return Ok(());
        }
        if !shared.supports_ranges && shared.is_ready_at(pos) {
            return Ok(());
        }

        let deadline = Instant::now() + FIRST_PACKET_TIMEOUT;
        loop {
            if shared.is_ready_at(pos) {
                return Ok(());
            }
            if shared.failed.load(Ordering::SeqCst) {
                return Err(io::Error::other("音频下载失败"));
            }
            if shared.complete.load(Ordering::SeqCst) {
                // complete 但 pos 未就绪：pos 超出实际数据长度
                return match shared.total_len() {
                    Some(t) if pos >= t => Ok(()),
                    _ => Err(io::Error::other("音频数据不完整")),
                };
            }
            // 通知下载线程重定位到读取位置
            shared.desired.store(pos, Ordering::SeqCst);
            shared.wake_all();
            let guard = shared.ready.lock().unwrap_or_else(|p| p.into_inner());
            let (g, timeout) = shared
                .ready_cv
                .wait_timeout(guard, Duration::from_millis(100))
                // 毒化容忍：持锁线程 panic 后 Condvar 返回 PoisonError，
                // 就绪区间数据本身不受损，取回内部守卫继续等即可（与上方案
                // file_logger/db/playurl_bridge 的口径一致），否则该请求永久挂起
                .unwrap_or_else(|p| p.into_inner());
            drop(g);
            if timeout.timed_out() && Instant::now() >= deadline && !shared.is_ready_at(pos) {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "等待音频数据超时"));
            }
        }
    }
}

fn sha1_hex(s: &str) -> String {
    let mut h = Sha1::new();
    h.update(s.as_bytes());
    let out = h.finalize();
    out.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_spans_merge_and_cover() {
        let mut s = ReadySpans::default();
        s.add(0, 100);
        s.add(200, 300);
        assert!(s.is_ready_at(0) && s.is_ready_at(50) && !s.is_ready_at(150));
        assert_eq!(s.ready_upto(150), 150);
        assert_eq!(s.ready_upto(0), 100);
        s.add(100, 200); // 相邻合并
        assert_eq!(s.ready_upto(0), 300);
        s.add(400, 500);
        s.add(300, 400); // 三段合并
        assert!(s.covers(0, 500));
        assert_eq!(s.total_bytes(), 500);
    }

    #[test]
    fn ready_spans_backward_overlap() {
        let mut s = ReadySpans::default();
        s.add(0, 1000);
        s.add(500, 1500); // 重叠合并
        assert_eq!(s.ready_upto(0), 1500);
        assert_eq!(s.total_bytes(), 1500);
    }

    /// Content-Range 起点解析：断流重连靠它判定「body 到底从哪开始」，
    /// 判错就会把错位数据写进缓冲（2026-10-03 FLAC panic 事故的源头）。
    #[test]
    fn parse_content_range_start_variants() {
        assert_eq!(parse_content_range_start("bytes 0-1023/4096"), Some(0));
        assert_eq!(parse_content_range_start("bytes 1024-2047/4096"), Some(1024));
        assert_eq!(parse_content_range_start("bytes  1024-2047/*"), Some(1024));
        assert_eq!(parse_content_range_start("  bytes 4096-8191/8192  "), Some(4096));
        // 形态异常一律 None（调用方只在拿到 Some 时做强校验）
        assert_eq!(parse_content_range_start(""), None);
        assert_eq!(parse_content_range_start("bytes */4096"), None);
        assert_eq!(parse_content_range_start("items 0-1/2"), None);
        assert_eq!(parse_content_range_start("bytes abc-2047/4096"), None);
    }

    /// 正常流：BodyReader 应按序吐字节，并把 EOF 稳定报成 Eof。
    #[test]
    fn body_reader_yields_bytes_then_eof() {
        let src: Box<dyn Read + Send> = Box::new(std::io::Cursor::new(vec![1u8, 2, 3, 4, 5]));
        let mut body = BodyReader::new(src);
        let mut out = [0u8; 8];
        match body.read_with_timeout(&mut out, Duration::from_secs(5)) {
            BodyRead::Data(n) => assert_eq!(&out[..n], &[1, 2, 3, 4, 5]),
            _ => panic!("期望读到数据"),
        }
        assert!(matches!(
            body.read_with_timeout(&mut out, Duration::from_secs(5)),
            BodyRead::Eof
        ));
        // EOF 可重复读取，不应再次阻塞
        assert!(matches!(
            body.read_with_timeout(&mut out, Duration::from_secs(5)),
            BodyRead::Eof
        ));
    }

    /// 假死连接：服务端不关连接也不发数据 → 必须报 TimedOut 而不是把下载线程冻死。
    #[test]
    fn body_reader_reports_idle_timeout() {
        /// 永不返回的 Read，模拟「连上了但不发包也不关连接」
        struct BlackHole;
        impl Read for BlackHole {
            fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
                std::thread::sleep(Duration::from_secs(30));
                Ok(0)
            }
        }
        let src: Box<dyn Read + Send> = Box::new(BlackHole);
        let mut body = BodyReader::new(src);
        let mut out = [0u8; 8];
        let started = Instant::now();
        let got = body.read_with_timeout(&mut out, Duration::from_millis(150));
        assert!(matches!(got, BodyRead::TimedOut));
        // 关键：判死必须发生在空闲阈值上，而不是被后台线程拖到 30s
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    /// 读侧缓冲区小于单帧时，帧内剩余字节必须留到下一次读，不能丢。
    #[test]
    fn body_reader_preserves_partial_frame() {
        let src: Box<dyn Read + Send> = Box::new(std::io::Cursor::new(vec![7u8; 100]));
        let mut body = BodyReader::new(src);
        let mut out = [0u8; 3];
        match body.read_with_timeout(&mut out, Duration::from_secs(5)) {
            BodyRead::Data(n) => assert_eq!(n, 3),
            _ => panic!("期望读到数据"),
        }
        assert_eq!(out, [7, 7, 7]);
        match body.read_with_timeout(&mut out, Duration::from_secs(5)) {
            BodyRead::Data(n) => assert_eq!(n, 3),
            _ => panic!("期望继续读到数据"),
        }
    }
}
