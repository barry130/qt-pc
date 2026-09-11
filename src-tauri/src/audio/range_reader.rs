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

    pub fn supports_ranges(&self) -> bool {
        self.supports_ranges
    }

    pub fn total_len(&self) -> Option<u64> {
        *self.total_len.lock().unwrap()
    }

    pub fn complete(&self) -> bool {
        self.complete.load(Ordering::SeqCst)
    }

    pub fn failed(&self) -> bool {
        self.failed.load(Ordering::SeqCst)
    }

    /// 已就绪字节总数（供 bufferedMs 估算）
    pub fn ready_bytes(&self) -> u64 {
        self.ready.lock().unwrap().total_bytes()
    }

    fn set_total(&self, len: u64) {
        let mut t = self.total_len.lock().unwrap();
        if t.is_none() || t.is_some_and(|v| len > v) {
            *t = Some(len);
        }
    }

    fn add_ready(&self, start: u64, end: u64) {
        self.ready.lock().unwrap().add(start, end);
        self.ready_cv.notify_all();
    }

    fn is_ready_at(&self, pos: u64) -> bool {
        self.ready.lock().unwrap().is_ready_at(pos)
    }

    fn covers(&self, start: u64, end: u64) -> bool {
        self.ready.lock().unwrap().covers(start, end)
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

    // 首个 Range 请求：bytes=0- 同时探测 Accept-Ranges 与总长
    let resp = client
        .get(url)
        .header("Range", "bytes=0-")
        .timeout(Duration::from_secs(15))
        .send()
        .map_err(|e| io::Error::other(format!("打开音频流失败: {url} ({e})")))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(io::Error::other(format!("音频流 HTTP {status}")));
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
            let _guard = DownloaderGuard { shared: Arc::clone(&dl_shared) };
            run_downloader(dl_shared, dl_url, dl_client, resp);
        })?;

    Ok((reader, shared))
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
    let mut body: Box<dyn Read + Send> = Box::new(initial_resp);
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
        if shared.supports_ranges
            && !shared.is_ready_at(want)
            && (want != pos || eof)
        {
            match issue_range(&client, &url, want) {
                Ok(resp) => {
                    body = Box::new(resp);
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

        match body.read(&mut buf) {
            Ok(0) => {
                // EOF：流到达文件尾。仅当就绪区间连续覆盖到总长才算完成；
                // 存在空洞（前向 seek 跳过的区间）时转入空闲，等读取方触发回填。
                eof = true;
                let total = shared.total_len().unwrap_or(pos);
                shared.set_total(total);
                let _ = writer.set_len(total);
                if shared.covers(0, total) {
                    shared.complete.store(true, Ordering::SeqCst);
                    shared.wake_all();
                    return;
                }
                shared.wake_all();
            }
            Ok(n) => {
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
            Err(_) => {
                retries += 1;
                if retries >= MAX_RETRIES || !shared.supports_ranges {
                    shared.failed.store(true, Ordering::SeqCst);
                    shared.wake_all();
                    return;
                }
                std::thread::sleep(Duration::from_millis(500 * retries as u64));
                // Range 模式从当前断点重连
                match issue_range(&client, &url, pos) {
                    Ok(resp) => body = Box::new(resp),
                    Err(_) => continue,
                }
            }
        }
    }
}

fn issue_range(
    client: &reqwest::blocking::Client,
    url: &str,
    from: u64,
) -> Result<reqwest::blocking::Response, ()> {
    client
        .get(url)
        .header("Range", format!("bytes={from}-"))
        .timeout(Duration::from_secs(15))
        .send()
        .map_err(|_| ())
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
        let span_end = shared.ready.lock().unwrap().ready_upto(self.pos);
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
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek 到负位置",
            ));
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
            let guard = shared.ready.lock().unwrap();
            let (g, timeout) = shared
                .ready_cv
                .wait_timeout(guard, Duration::from_millis(100))
                .unwrap();
            drop(g);
            if timeout.timed_out() && Instant::now() >= deadline && !shared.is_ready_at(pos) {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "等待音频数据超时",
                ));
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
}
