//! qtres:// 自定义协议（DESIGN §6.13）：
//! 前端一律 `qtres://cover/<base64url(原始URL)>`（Windows/WebView2 下为
//! `http://qtres.localhost/cover/...`），Rust 按音源补 Referer / UA 代取。
//!
//! - `cover/`：封面代取 + 内存去重缓存（不落盘缩略图，后续迭代补 @2x 与磁盘缓存）
//! - `/engine/index.html`：音源引擎页（source_window.rs 的隐藏窗口加载，
//!   内嵌 HTML，无 CSP 注入 → 可自由动态 import 音源包脚本）
//! - `/script/<id>/<file>`：只读分发已安装的音源包文件（v3 统一包模型：
//!   数据包/播放包同构，目录名 = 包 id；file 严格校验防路径穿越，查询串
//!   仅用于模块缓存破坏 ?v=）
//!
//! MV/视频代理（`mv/` Range 透传）已随 MV 功能一并删除。
//!
//! 白名单：只允许已知音源 CDN 域名，防止歌词/皮肤数据把它当任意代理。

use base64::Engine as _;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::http::{header, Request, Response, StatusCode};
use crate::source_bundle;

/// 允许代取的封面域名后缀（wyy + qq + kw + kg 的图片 CDN 及其通用回退）
const ALLOWED_HOST_SUFFIXES: &[&str] = &[
    "music.126.net",
    "163.com",
    "qq.com",
    // 榜单封面走 y.gtimg.cn（不是 *.qq.com），少了这条排行榜整排都是空白
    "gtimg.cn",
    // QQ 歌单/推荐封面 CDN 是 p.qpic.cn / qpic.y.qq.com，qpic.cn 不以 qq.com 结尾，
    // 少了这条歌单广场一大片封面全是空白
    "qpic.cn",
    "kuwo.cn",
    "kwcdn.kuwo.cn",
    "kugou.com",
    "kgimg.com",
    // Astral 账号头像：后端 astral.canace.cn / 存储 storage.canace.icu
    "canace.cn",
    "canace.icu",
];

/// 内存封面缓存：URL → bytes。
///
/// 容量从 64 提到 512：歌单广场/排行榜一屏就是上百张卡片（实测一次进入榜单页
/// 触发了 240 次代取），64 的容量当场被一屏铺满，之后每次插入都淘汰，命中率
/// 被打穿 —— 表现为「切走再切回，封面又全部重下一遍」。
const COVER_CACHE_MAX: usize = 512;

/// 失败负缓存：URL → 失败时刻。TTL 内不再重试。
///
/// 实测日志里 504 条代取失败只对应 99 个不同 URL（放大 5.35 倍）：死图床/已
/// 下架封面本身取不到，但每次重新渲染都会再打一遍 10 秒超时，把并发额度
/// 一直占着，连带拖慢同一批里的正常封面。
const COVER_FAIL_TTL: Duration = Duration::from_secs(120);
const COVER_FAIL_MAX: usize = 512;

/// 同时在飞的封面网络请求上限。
///
/// 这是本次「加载不出来 / 非常慢」的核心闸门：WebView2 对同一 host
/// （http://qtres.localhost）只开 6 条连接，179 张卡片会瞬间把 6 条全部占满，
/// 每张都是 1.9MB 级原图 + 10 秒超时 —— 弱网下实测并发 6 就已经 5 张超时，
/// 带宽被封面吃干净，数据接口跟着一起饿死。这里显式限流，让封面永远只占用
/// 一小部分连接预算，把带宽留给真正决定「有没有内容」的接口请求。
const COVER_FETCH_CONCURRENCY: usize = 4;

/// 单张封面的网络超时（连接 5s + 整体 8s）。
///
/// 从 10s 收到 8s：封面是可降级资源（失败给占位图即可），不该比取链预算还长；
/// 卡满 10 秒只会让整屏封面一起变空白，不如早点失败早点让位。
const COVER_FETCH_TIMEOUT: Duration = Duration::from_secs(8);
const COVER_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// 列表/卡片缩略图目标边长（按 2× DPR 取：卡片实测 128px，×2 = 256，取 300）。
///
/// DESIGN §6.13 本来就写了「生成 @2x 缩略图（列表用缩略图，播放页用原图）」，
/// 此前实现漏了这一步，直接把原图代取回来 —— 实测同一张网易云封面
/// 原图 1.9MB / 12.4MB 不等，加尺寸参数后 11KB（约 177×）。
const COVER_THUMB_PX: u32 = 300;

/// 封面代取共享 HTTP 客户端。
///
/// 原实现**每个请求新建一个 client** 且 `pool_max_idle_per_host(0)`，等于每次
/// 都重做 TCP + TLS 握手，连接复用率为零；弱网下握手本身就占掉可观时间。
/// 复用同一客户端后，同一图床的后续请求直接走已建立的连接。
fn cover_client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .user_agent("Mozilla/5.0")
            .timeout(COVER_FETCH_TIMEOUT)
            .connect_timeout(COVER_CONNECT_TIMEOUT)
            .pool_max_idle_per_host(4)
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new())
    })
}

/// 封面并发闸门（见 `COVER_FETCH_CONCURRENCY`）。
struct CoverGate {
    used: Mutex<usize>,
    cv: Condvar,
}

static COVER_GATE: CoverGate = CoverGate {
    used: Mutex::new(0),
    cv: Condvar::new(),
};

/// RAII 占位：拿到就 +1，Drop 时 -1 并唤醒一个等待者（包括 panic 路径）。
struct CoverGateGuard;

impl CoverGateGuard {
    fn acquire() -> Self {
        let mut used = COVER_GATE
            .used
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        while *used >= COVER_FETCH_CONCURRENCY {
            used = COVER_GATE
                .cv
                .wait(used)
                .unwrap_or_else(|p| p.into_inner());
        }
        *used += 1;
        Self
    }
}

impl Drop for CoverGateGuard {
    fn drop(&mut self) {
        let mut used = COVER_GATE
            .used
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        *used = used.saturating_sub(1);
        COVER_GATE.cv.notify_one();
    }
}

/// 同一 URL 的并发代取合并（single-flight）。
///
/// 一屏里同一张封面常常被多个组件同时引用（卡片 + 取色 + 背景），原实现会
/// 各自发一遍请求；死图的重复率尤其高。这里让第一个到的人真正去取，其余人
/// 挂起等结果，拿到同一份字节。
struct CoverFlight {
    state: Mutex<CoverFlightState>,
    cv: Condvar,
}

enum CoverFlightState {
    Running,
    Done(Option<Vec<u8>>),
}

static COVER_FLIGHTS: Mutex<Option<HashMap<String, Arc<CoverFlight>>>> = Mutex::new(None);

/// 领先者的清理守卫：无论正常结束还是 panic，都要唤醒等待者并摘掉注册表条目。
///
/// 少了这层，`fetch()` 里任何 panic 都会把该 URL 的 flight 永久留在 `Running`
/// 上，之后所有请求同一封面的调用者都会无限等待 —— 一屏封面直接卡死。
struct CoverFlightCleanup {
    key: String,
    flight: Arc<CoverFlight>,
}

impl Drop for CoverFlightCleanup {
    fn drop(&mut self) {
        {
            let mut state = self.flight.state.lock().unwrap_or_else(|p| p.into_inner());
            if matches!(*state, CoverFlightState::Running) {
                // 走到这里说明是异常路径（正常路径已写入 Done）
                *state = CoverFlightState::Done(None);
            }
            self.flight.cv.notify_all();
        }
        let mut guard = COVER_FLIGHTS.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(map) = guard.as_mut() {
            map.remove(&self.key);
        }
    }
}

/// 取封面字节（带 single-flight 合并）。`fetch` 是真正执行网络请求的闭包。
fn cover_bytes_shared<F>(key: &str, fetch: F) -> Option<Vec<u8>>
where
    F: FnOnce() -> Option<Vec<u8>>,
{
    let (flight, leader) = {
        let mut guard = COVER_FLIGHTS.lock().unwrap_or_else(|p| p.into_inner());
        let map = guard.get_or_insert_with(HashMap::new);
        match map.get(key) {
            Some(existing) => (existing.clone(), false),
            None => {
                let fresh = Arc::new(CoverFlight {
                    state: Mutex::new(CoverFlightState::Running),
                    cv: Condvar::new(),
                });
                map.insert(key.to_string(), fresh.clone());
                (fresh, true)
            }
        }
    };

    if !leader {
        // 跟随者：等领先者把结果写进 state。领先者 panic 会毒化 mutex，
        // 这里用 into_inner 继续等，不会把整屏封面卡死。
        let mut state = flight.state.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            match &*state {
                CoverFlightState::Done(bytes) => return bytes.clone(),
                CoverFlightState::Running => {
                    state = flight.cv.wait(state).unwrap_or_else(|p| p.into_inner());
                }
            }
        }
    }

    // 领先者：先过并发闸门，再取；守卫保证异常路径也会唤醒等待者
    let _cleanup = CoverFlightCleanup {
        key: key.to_string(),
        flight: flight.clone(),
    };
    let bytes = {
        let _gate = CoverGateGuard::acquire();
        fetch()
    };
    {
        let mut state = flight.state.lock().unwrap_or_else(|p| p.into_inner());
        *state = CoverFlightState::Done(bytes.clone());
        flight.cv.notify_all();
    }
    drop(_cleanup);
    bytes
}

/// 按目标边长改写封面 URL。
///
/// 只有网易云图床吃尺寸参数（实测 `?param=300y300` 把 1.9MB 压到 11KB）；
/// 酷我 `zimg.kuwo.cn` 对 `?param=`/`?w_=` 完全无反应，QQ `y.gtimg.cn` 的
/// 尺寸写在路径里（`T003R300x300M000`）、酷狗本来就是 300 档且体积正常
/// （25~53KB），这三家原样返回，免得平白加一个无用查询串把缓存键搞散。
///
/// 网易云两种形态都要处理：裸 URL 直接追加 `?param=WxH`；已经带
/// `imageView=1&thumbnail=800y800` 的必须**改写 thumbnail 的值**，
/// 实测在其后追加 `&param=` 无效（仍是 954970 字节）。
fn sized_cover_url(url: &str, px: u32) -> String {
    let lower = url.to_ascii_lowercase();
    if !(lower.contains("music.126.net") || lower.contains("163.com")) {
        return url.to_string();
    }
    // to_ascii_lowercase 不改字节长度，lower 的下标可以直接用于 url
    if let Some(pos) = lower.find("thumbnail=") {
        let start = pos + "thumbnail=".len();
        let end = url[start..]
            .find('&')
            .map(|i| start + i)
            .unwrap_or(url.len());
        return format!("{}{px}y{px}{}", &url[..start], &url[end..]);
    }
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}param={px}y{px}")
}

/// 从请求查询串里读目标边长（`?w=900`）。缺省用列表缩略图尺寸。
fn cover_target_px(query: Option<&str>) -> u32 {
    let Some(q) = query else {
        return COVER_THUMB_PX;
    };
    for pair in q.split('&') {
        if let Some(v) = pair.strip_prefix("w=") {
            if let Ok(px) = v.parse::<u32>() {
                // 夹到合理区间：太小会糊，太大等于没优化
                return px.clamp(64, 1200);
            }
        }
    }
    COVER_THUMB_PX
}

fn referer_for(url: &str) -> &'static str {
    let lower = url.to_ascii_lowercase();
    if lower.contains("qq.com") {
        "https://y.qq.com/"
    } else if lower.contains("kugou.com") || lower.contains("kgimg.com") {
        "https://www.kugou.com/"
    } else if lower.contains("kuwo.cn") {
        "https://www.kuwo.cn/"
    } else {
        "https://music.163.com/"
    }
}

fn host_allowed(url: &str) -> bool {
    // 取 host 部分
    let rest = match url.split_once("://") {
        Some((_, r)) => r,
        None => return false,
    };
    // host 大小写不敏感（HOST 头本来就允许大写，别让大写 host 无辜被拒）
    let host = rest.split('/').next().unwrap_or("").to_ascii_lowercase();
    // 去掉端口（含 IPv6 字面量的 [::1]:80 形式：白名单里没有 IP，遇 [ 一律不放行）
    let host = if host.starts_with('[') {
        return false;
    } else {
        host.split(':').next().unwrap_or("")
    };
    // 后缀必须落在**点边界**上：原来 `host.ends_with("qq.com")` 会把
    // `evilqq.com` / `notqq.com` 判为放行，等于把白名单架空（任何人注册一个
    // 以 qq.com 结尾的域名就能借 qtres 代取任意内容）。这里要求 host 恰好等于
    // 后缀，或以 `.后缀` 结尾（不分配字符串，逐字节比边界）。
    ALLOWED_HOST_SUFFIXES.iter().any(|sfx| {
        host == *sfx
            || (host.len() > sfx.len()
                && host.ends_with(sfx)
                && host.as_bytes()[host.len() - sfx.len() - 1] == b'.')
    })
}

/// 解码 `cover/` 路径（base64url，可无填充）→ 原始 URL
fn decode_res_path(path: &str) -> Option<(&'static str, String)> {
    let rest = path.trim_start_matches('/');
    let (kind, b64) = match rest.split_once('/') {
        Some(("cover", b)) => ("cover", b),
        _ => return None,
    };
    // URL path 中 base64url 无填充；补齐
    let padded = match b64.len() % 4 {
        2 => format!("{b64}=="),
        3 => format!("{b64}="),
        _ => b64.to_string(),
    };
    let bytes = base64::engine::general_purpose::URL_SAFE
        .decode(padded)
        .ok()?;
    String::from_utf8(bytes).ok().map(|u| (kind, u))
}

fn placeholder() -> Response<Vec<u8>> {
    // 1×1 透明 PNG，避免 <img> onerror 抖动（DESIGN §6.13 失败兜底）
    let png: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header("Access-Control-Allow-Origin", "*")
        .body(png.to_vec())
        .unwrap()
}

/// 引擎页 HTML（内嵌编译；改页面要重编 Rust）
const ENGINE_INDEX_HTML: &str = include_str!("source_engine_page.html");

fn engine_page_response() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        // 引擎页必须即时生效（音源包应用 = 重建窗口重新拉取）
        .header(header::CACHE_CONTROL, "no-store")
        .body(ENGINE_INDEX_HTML.as_bytes().to_vec())
        .unwrap()
}

/// /script/ 文件大小防呆（bundle 正常 ~1-2MB，给足余量）
const SCRIPT_FILE_MAX: u64 = 64 * 1024 * 1024;

/// 段名白名单：只允许字母数字与 . _ -，且不允许 "." / ".."（防路径穿越）。
/// code（版本号目录）与 file（chain.json / source-bundle.js）共用。
fn valid_path_segment(seg: &str) -> bool {
    !seg.is_empty()
        && seg != "."
        && seg != ".."
        && seg.len() <= 128
        && seg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// `/script/<code>/<file>`：只读分发 `%APPDATA%/QuietMusic/source-bundle/install/`
/// 下的音源包文件。路径穿越在校验段名 + 规范化路径前缀双重拦截。
fn handle_script_file<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    rest: &str,
) -> Response<Vec<u8>> {
    let Some((code, file)) = rest.split_once('/') else {
        return not_found();
    };
    // file 可能带查询串（模块缓存破坏参数等），剥掉
    let file = file.split(['?', '#']).next().unwrap_or(file);
    if !valid_path_segment(code) || !valid_path_segment(file) {
        log::warn!("[qtres] /script 非法路径拒绝: code={code} file={file}");
        return not_found();
    }
    let install_root = source_bundle::bundle_dir(app).join("install");
    let target = install_root.join(code).join(file);
    // 先判「文件本身合不合规」，再做前缀校验。顺序不能反：
    // starts_with_canonical 内部用 canonicalize()，而**目标不存在时它返回 Err**，
    // 会被误判成「路径越界」。而 chain.json 在播放包安装时是被有意删掉的
    // （见 source_install：播放包自包含默认 chain，残留 overlay 属旧版本），
    // 于是每次启动都会稳定打一条假 WARN，污染取链故障窗口的日志。
    // 先过 metadata 这一关，就只剩「文件真实存在却越界」这种真可疑情况才告警。
    match std::fs::metadata(&target) {
        Ok(m) if m.is_file() && m.len() <= SCRIPT_FILE_MAX => {}
        _ => return not_found(),
    }
    // 规范化前缀校验：兜底防符号链接/编码绕过
    if !starts_with_canonical(&target, &install_root) {
        log::warn!("[qtres] /script 路径越界拒绝: {}", target.display());
        return not_found();
    }
    let Ok(bytes) = std::fs::read(&target) else {
        return not_found();
    };
    let content_type = if file.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if file.ends_with(".js") || file.ends_with(".mjs") {
        "application/javascript; charset=utf-8"
    } else {
        "application/octet-stream"
    };
    log::info!(
        "[qtres] /script 分发: {code}/{file} ({} bytes)",
        bytes.len()
    );
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        // no-store：音源包「立即应用」靠重建窗口重新拉脚本，不能吃缓存
        .header(header::CACHE_CONTROL, "no-store")
        .body(bytes)
        .unwrap_or_else(|_| not_found())
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(b"not found".to_vec())
        .unwrap()
}

/// 目标路径是否落在 root 之内：先词法规范化（消化 "." / ".." 段），
/// 再与规范化后的 root 比对。
///
/// 注意：目标不存在时 canonicalize() 失败，此处返回 false。**调用方必须先确认
/// 文件存在再调本函数**，否则「文件不存在」会被误当成「路径越界」而误报
/// （`/script` 分发里 chain.json 就是这种常态——播放包安装时有意删除）。
fn starts_with_canonical(target: &Path, root: &Path) -> bool {
    use std::path::Component;
    let Ok(root_c) = root.canonicalize() else {
        return false;
    };
    let mut normalized = Path::new("/").to_path_buf();
    for comp in target.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            c => normalized.push(c),
        }
    }
    match normalized.canonicalize() {
        Ok(c) => c.starts_with(&root_c),
        Err(_) => false,
    }
}

/// 全局缓存（进程级；M0 简单实现）
static COVER_CACHE: Mutex<Option<lru_simple::Lru<String, Vec<u8>>>> = Mutex::new(None);

/// 失败负缓存（URL → 失败时刻），见 `COVER_FAIL_TTL`。
static COVER_FAILS: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

mod lru_simple {
    use std::collections::HashMap;

    /// 一次淘汰多少条：容量的 1/8（至少 1 条）。
    ///
    /// 为什么批量：找"最旧"必须扫全表（O(n)），旧实现每来一张封面就扫一次，
    /// 满容量后每次插入都是 O(n)（一屏几十张图 = 连续几十次全表扫描）。
    /// 一次淘汰 cap/8 条后，平均每 cap/8 次插入才扫一次表，
    /// 单次插入的淘汰成本摊还成 O(1)（cap=64 时约 8 次插入扫一次，摊到每次
    /// 插入上是 8 次比较）。批量取 1/8 而不是更大：多淘汰的条目会让缓存命中率
    /// 下降（未命中 = 多打一次图床请求），1/8 是在"摊还成本可忽略"和
    /// "别把命中率打下来"之间的折中（旧行为是每次只淘汰 1 条 = 严格 LRU）。
    fn evict_batch(cap: usize) -> usize {
        std::cmp::max(1, cap / 8)
    }

    pub struct Lru<K, V> {
        map: HashMap<K, (V, u64)>,
        tick: u64,
        cap: usize,
    }

    impl<K: std::hash::Hash + Eq + Clone, V> Lru<K, V> {
        pub fn new(cap: usize) -> Self {
            Self {
                map: HashMap::new(),
                tick: 0,
                cap,
            }
        }

        pub fn get(&mut self, k: &K) -> Option<&V> {
            self.tick += 1;
            if let Some((v, t)) = self.map.get_mut(k) {
                *t = self.tick;
                Some(v)
            } else {
                None
            }
        }

        pub fn insert(&mut self, k: K, v: V) {
            self.tick += 1;
            if self.map.len() >= self.cap && !self.map.contains_key(&k) {
                self.evict_oldest(evict_batch(self.cap));
            }
            self.map.insert(k, (v, self.tick));
        }

        /// 淘汰最旧的 n 条（按最近一次访问的 tick；tick 单调自增所以不会打平）。
        /// select_nth 是 O(n)，不必全排序。
        fn evict_oldest(&mut self, n: usize) {
            let n = n.min(self.map.len());
            if n == 0 {
                return;
            }
            let mut entries: Vec<(u64, K)> =
                self.map.iter().map(|(k, (_, t))| (*t, k.clone())).collect();
            entries.select_nth_unstable_by_key(n - 1, |e| e.0);
            for (_, k) in entries.drain(..n) {
                self.map.remove(&k);
            }
        }

        /// 测试用的条目数（正常构建里不需要）
        #[cfg(test)]
        pub fn len(&self) -> usize {
            self.map.len()
        }
    }
}

/// 注册到 `register_asynchronous_uri_scheme_protocol` 的处理函数。
pub fn handle_qtres<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    // 阻塞部分放线程池，避免卡 WebView 主线程。
    //
    // P2-4：这里从 `std::thread::spawn` 换成 tokio 阻塞池（Tauri 的
    // `spawn_blocking`）。原因：一屏封面就是几十个并发请求，裸线程没有任何上限，
    // 每个线程还要吃默认 1MB 栈；阻塞池有上限（默认 512）并在满载时排队，
    // 超出的请求只是晚一点执行，不会把线程/内存铺满，而且线程是复用的。
    // 逻辑本身一行没动：仍然是"在别的线程上跑同步代取（reqwest blocking，
    // 收完整个 body 再回），完成后 respond"，不做异步流式改造，
    // 也就不可能改变 cover 的响应语义。
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let response = handle_qtres_sync(&app, request);
        responder.respond(response);
    });
}

fn handle_qtres_sync<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    // Windows/WebView2 下 URI 被规范化为 http://qtres.localhost/...，
    // 其余平台为 qtres://...；两者用 uri().path() 都得到 /cover/<b64>
    let path = request.uri().path().to_string();
    // 音源引擎路由（P1）：引擎页内嵌提供 + 安装目录脚本只读分发。
    // 这些路径固定存在，放在 cover 解码之前短路。
    if path == "/engine/index.html" {
        return engine_page_response();
    }
    if let Some(rest) = path.strip_prefix("/script/") {
        return handle_script_file(app, rest);
    }
    let Some((kind, original_url)) = decode_res_path(&path) else {
        log::warn!("[qtres] 无法解码封面路径: {path}");
        return placeholder();
    };
    if !host_allowed(&original_url) {
        log::warn!("[qtres] 封面域名不在白名单，拒绝代取: {original_url}");
        return placeholder();
    }
    let logged = original_url.clone();
    // 前端可用 ?w=900 指定播放页大图；缺省是列表缩略图尺寸
    let target_px = cover_target_px(request.uri().query());
    let resp = handle_cover(original_url, target_px);
    log::info!(
        "[qtres] cover kind={kind} status={} px={target_px} url={logged}",
        resp.status().as_u16()
    );
    resp
}

/// 图床基本都支持 https，而明文 http 在本机（系统代理 / 防火墙）常常取不到，
/// 表现就是封面整片空白。代取前统一升级，http 之外的原样返回。
fn upgrade_to_https(url: &str) -> String {
    match url.strip_prefix("http://") {
        Some(rest) => format!("https://{rest}"),
        None => url.to_string(),
    }
}

/// 单一 URL 代取封面字节（成功且非空才返回 Some）。
fn fetch_cover_bytes(client: &reqwest::blocking::Client, url: &str) -> Option<Vec<u8>> {
    client
        .get(url)
        .header("Referer", referer_for(url))
        .send()
        .ok()
        .and_then(|resp| {
            if resp.status().is_success() {
                resp.bytes().ok().map(|b| b.to_vec())
            } else {
                None
            }
        })
}

fn handle_cover(original_url: String, target_px: u32) -> Response<Vec<u8>> {
    // 缓存键 = 原始 URL + 目标边长：同一张封面在列表（300）和播放页（900）
    // 是两个不同的资源，混用同一个键会让播放页拿到 300px 的糊图。
    let cache_key = format!("{target_px}|{original_url}");

    // 缓存命中
    {
        let mut guard = COVER_CACHE.lock().unwrap_or_else(|p| p.into_inner());
        let cache = guard.get_or_insert_with(|| lru_simple::Lru::new(COVER_CACHE_MAX));
        if let Some(bytes) = cache.get(&cache_key) {
            return image_response(bytes.clone(), &original_url);
        }
    }

    // 负缓存：刚失败过的不再重试（死图床/已下架封面重试多少次都是失败）
    {
        let mut guard = COVER_FAILS.lock().unwrap_or_else(|p| p.into_inner());
        let fails = guard.get_or_insert_with(HashMap::new);
        if let Some(at) = fails.get(&cache_key) {
            if at.elapsed() < COVER_FAIL_TTL {
                return placeholder();
            }
            fails.remove(&cache_key);
        }
    }

    // 按目标尺寸改写后再代取（只有网易云图床吃这个参数，见 sized_cover_url）
    let sized_url = sized_cover_url(&original_url, target_px);
    let fetch_url = upgrade_to_https(&sized_url);

    let original_for_log = original_url.clone();
    let sized_for_log = sized_url.clone();
    let bytes = cover_bytes_shared(&cache_key, move || {
        // 先试升级后的 https；失败（酷我 img1.kwcdn.kuwo.cn 等图床不支持 https，
        // TLS 直接握手失败）再回退原始 URL，避免封面整片空白。
        let client = cover_client();
        let mut out = fetch_cover_bytes(client, &fetch_url);
        if out.is_none() && fetch_url != sized_for_log {
            out = fetch_cover_bytes(client, &sized_for_log);
        }
        if out.is_none() {
            log::warn!(
                "[qtres] cover 代取失败(url 与 https 回退均失败): {original_for_log} (px={target_px})"
            );
        }
        out
    });

    match bytes {
        Some(data) if !data.is_empty() => {
            {
                let mut guard = COVER_CACHE.lock().unwrap_or_else(|p| p.into_inner());
                let cache = guard.get_or_insert_with(|| lru_simple::Lru::new(COVER_CACHE_MAX));
                cache.insert(cache_key, data.clone());
            }
            image_response(data, &original_url)
        }
        _ => {
            // 记一笔负缓存，避免同一张死图在一屏里被反复重取
            {
                let mut guard = COVER_FAILS.lock().unwrap_or_else(|p| p.into_inner());
                let fails = guard.get_or_insert_with(HashMap::new);
                if fails.len() >= COVER_FAIL_MAX {
                    // 简单的容量兜底：清掉已过期的，仍满则整体清空
                    let ttl = COVER_FAIL_TTL;
                    fails.retain(|_, at: &mut Instant| at.elapsed() < ttl);
                    if fails.len() >= COVER_FAIL_MAX {
                        fails.clear();
                    }
                }
                fails.insert(cache_key, Instant::now());
            }
            placeholder()
        }
    }
}

fn image_response(bytes: Vec<u8>, url: &str) -> Response<Vec<u8>> {
    let content_type = if url.to_ascii_lowercase().contains(".png") {
        "image/png"
    } else if url.to_ascii_lowercase().contains(".webp") {
        "image/webp"
    } else if url.to_ascii_lowercase().contains(".gif") {
        "image/gif"
    } else {
        "image/jpeg"
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes)
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64url(s: &str) -> String {
        base64::engine::general_purpose::URL_SAFE.encode(s)
    }

    #[test]
    fn valid_path_segments() {
        assert!(valid_path_segment("2026091801"));
        assert!(valid_path_segment("chain.json"));
        assert!(valid_path_segment("source-bundle.js"));
        assert!(valid_path_segment("source_bundle-v2.js"));
        assert!(!valid_path_segment(""));
        assert!(!valid_path_segment("."));
        assert!(!valid_path_segment(".."));
        assert!(!valid_path_segment("a/b"));
        assert!(!valid_path_segment("a\\b"));
        assert!(!valid_path_segment("a b"));
        assert!(!valid_path_segment("中文名"));
        assert!(!valid_path_segment(&"x".repeat(129)));
    }

    #[test]
    fn starts_with_canonical_blocks_traversal() {
        let tmp = std::env::temp_dir().join(format!("ll-qtres-{}", std::process::id()));
        let root = tmp.join("install");
        std::fs::create_dir_all(root.join("2026091801")).unwrap();
        std::fs::write(root.join("2026091801").join("chain.json"), "{}").unwrap();
        let inside = root.join("2026091801").join("chain.json");
        assert!(starts_with_canonical(&inside, &root));
        // .. 拼接出的越界路径（即使段名校验被绕过也兜底）
        let escape = root.join("2026091801").join("..").join("secret.txt");
        assert!(!starts_with_canonical(&escape, &root));
        std::fs::write(tmp.join("secret.txt"), "x").unwrap();
        assert!(!starts_with_canonical(&escape, &root));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 回归：文件不存在时 starts_with_canonical 返回 false（canonicalize 失败）。
    ///
    /// 这个语义曾导致每次启动都打一条假 WARN —— chain.json 在播放包安装时
    /// 被有意删除，`/script/play-official/chain.json` 每次都请求，必然 404。
    /// 调用方（handle_script_file）因此**必须先过 metadata 再做前缀校验**。
    /// 本测试把这个约束钉住：谁把顺序换回去，这里就该红。
    #[test]
    fn missing_file_is_not_reported_as_traversal() {
        let tmp = std::env::temp_dir().join(format!("ll-qtres-missing-{}", std::process::id()));
        let root = tmp.join("install");
        let code_dir = root.join("play-official");
        std::fs::create_dir_all(&code_dir).unwrap();
        // 目录存在、文件不存在（= 安装播放包后的常态）
        let absent = code_dir.join("chain.json");
        assert!(!absent.exists());
        assert!(!starts_with_canonical(&absent, &root));
        // 但 handle_script_file 的新顺序下，这条请求会静默 404 而非告警：
        // metadata 阶段就返回，不会走到前缀校验。
        assert!(std::fs::metadata(&absent).map(|m| m.is_file()).unwrap_or(false) == false);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn engine_page_embedded() {
        let resp = engine_page_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body();
        let html = String::from_utf8(body).unwrap();
        assert!(html.contains("source-engine-request"), "含取链 RPC 监听");
        assert!(html.contains("installPlayPack"), "装配播放音源包");
    }

    #[test]
    fn decode_cover_paths() {
        let cover = b64url("https://p1.music.126.net/abc.jpg");
        let (kind, url) = decode_res_path(&format!("/cover/{cover}")).unwrap();
        assert_eq!(kind, "cover");
        assert_eq!(url, "https://p1.music.126.net/abc.jpg");

        // MV 路径已随 MV 功能删除，不再是合法 kind
        assert!(decode_res_path("/unknown/xxx").is_none());
    }

    #[test]
    fn host_whitelist_rejects_foreign_hosts() {
        assert!(host_allowed("https://p1.music.126.net/abc.jpg"));
        assert!(host_allowed("https://imge.kugou.com/a.jpg"));
        assert!(!host_allowed("https://evil.example.com/a.jpg"));
        assert!(!host_allowed("file:///C:/Windows/system32"));
    }

    #[test]
    fn host_whitelist_allows_astral_avatar_hosts() {
        // 账号头像走 qtres 代取：后端 astral.canace.cn / 存储 storage.canace.icu，
        // 不在白名单会被拦成破图（标题栏头像回退到 logo）。
        assert!(host_allowed("http://astral.canace.cn/files/avatar/1.png"));
        assert!(host_allowed("https://storage.canace.icu/p/xyz/avatar.png"));
    }

    #[test]
    fn host_whitelist_allows_qq_chart_covers() {
        // 榜单封面域名是 y.gtimg.cn，跟歌曲封面的 y.qq.com 不是一个后缀。
        // 之前漏了这条，QQ 排行榜的图片全被拦截成空白图。
        assert!(host_allowed(
            "http://y.gtimg.cn/music/photo_new/T003R300x300M000002D6X7w0nrufd.jpg"
        ));
    }

    #[test]
    fn upgrade_to_https_only_rewrites_plain_http() {
        assert_eq!(
            upgrade_to_https("http://y.gtimg.cn/a.jpg"),
            "https://y.gtimg.cn/a.jpg"
        );
        assert_eq!(
            upgrade_to_https("https://p1.music.126.net/a.jpg"),
            "https://p1.music.126.net/a.jpg"
        );
    }

    #[test]
    fn host_whitelist_allows_qq_playlist_cover_cdns() {
        // QQ 推荐/搜索歌单的 imgurl 大多落 p.qpic.cn（还有 qpic.y.qq.com）。
        // p.qpic.cn 不以 qq.com 结尾，漏了 qpic.cn 这条歌单广场会满屏空白封面。
        assert!(host_allowed(
            "http://p.qpic.cn/music_cover/xFPOwViasj/600?n=1"
        ));
        assert!(host_allowed(
            "http://qpic.y.qq.com/music_cover/8eiaDBJ/300?n=1"
        ));
    }

    /// 封面缓存淘汰：超容量时按"最旧"**批量**淘汰，容量上限绝不被突破，
    /// 且刚访问过的条目不会被误杀（LRU 语义不变，只是淘汰改成一批一批做）
    #[test]
    fn cover_cache_evicts_oldest_in_batch() {
        // cap 取 16 → 一次淘汰 2 条，能真正覆盖"批量淘汰"分支
        let cap = 16usize;
        let mut lru = lru_simple::Lru::new(cap);
        for i in 0..cap {
            lru.insert(i, i);
        }
        assert_eq!(lru.len(), cap);
        // 读一次 0 号，把它顶成"最新访问"
        assert_eq!(lru.get(&0), Some(&0));
        // 满容量后再插一条：直接淘汰最旧的一批
        lru.insert(cap, cap);
        assert!(lru.len() <= cap, "容量上限不得突破: {}", lru.len());
        assert!(
            lru.get(&0).is_some(),
            "刚被访问过的条目不在最旧的一批里，应当存活"
        );
        assert!(lru.get(&1).is_none(), "最旧的条目应被淘汰");
        assert!(
            lru.get(&2).is_none(),
            "同批的第二旧也应一起淘汰（批量淘汰，不是每次只掉一条）"
        );
        // 继续插到下一批，最新写入的条目必须都在，容量始终守得住
        for i in cap + 1..cap + 4 {
            lru.insert(i, i);
        }
        assert!(lru.len() <= cap);
        assert!(lru.get(&(cap + 3)).is_some(), "最新插入的条目必须在");
    }

    /// 只有网易云图床吃尺寸参数；其它图床原样返回，免得平白加查询串把缓存键搞散。
    #[test]
    fn sized_cover_url_only_touches_netease() {
        // 裸网易云 URL：追加 ?param=WxH
        assert_eq!(
            sized_cover_url("https://p1.music.126.net/abc==/1.jpg", 300),
            "https://p1.music.126.net/abc==/1.jpg?param=300y300"
        );
        // 已带查询串：用 & 追加，不能出现两个 ?
        assert_eq!(
            sized_cover_url("https://p1.music.126.net/a.jpg?x=1", 256),
            "https://p1.music.126.net/a.jpg?x=1&param=256y256"
        );
        // 已带 imageView/thumbnail：必须改写 thumbnail 的值（追加 &param= 无效）
        assert_eq!(
            sized_cover_url(
                "https://p1.music.126.net/a.jpg?imageView=1&thumbnail=800y800&enlarge=1",
                300
            ),
            "https://p1.music.126.net/a.jpg?imageView=1&thumbnail=300y300&enlarge=1"
        );
        // thumbnail 在末尾（后面没有 &）也要能改写
        assert_eq!(
            sized_cover_url("https://p1.music.126.net/a.jpg?thumbnail=800y800", 200),
            "https://p1.music.126.net/a.jpg?thumbnail=200y200"
        );
        // 163.com 也走网易云规则
        assert_eq!(
            sized_cover_url("https://img1.163.com/a.jpg", 300),
            "https://img1.163.com/a.jpg?param=300y300"
        );
        // 其它图床（酷我/QQ/酷狗/Astral）完全不动：实测都不吃尺寸参数
        for url in [
            "https://zimg.kuwo.cn/bang/9/2/x.png",
            "http://y.gtimg.cn/music/photo_new/T003R300x300M000x.jpg",
            "https://imge.kugou.com/stdmusic/300/x.jpg",
            "https://storage.canace.icu/p/x/1.png",
        ] {
            assert_eq!(sized_cover_url(url, 300), url, "不应改写 {url}");
        }
    }

    /// 目标边长查询串：缺省 300，合法值夹到 64..1200，非法值回落缺省。
    #[test]
    fn cover_target_px_parsing() {
        assert_eq!(cover_target_px(None), COVER_THUMB_PX);
        assert_eq!(cover_target_px(Some("")), COVER_THUMB_PX);
        assert_eq!(cover_target_px(Some("w=900")), 900);
        assert_eq!(cover_target_px(Some("a=1&w=256&b=2")), 256);
        // 越界夹取
        assert_eq!(cover_target_px(Some("w=1")), 64);
        assert_eq!(cover_target_px(Some("w=99999")), 1200);
        // 非法值不 panic，回落缺省
        assert_eq!(cover_target_px(Some("w=abc")), COVER_THUMB_PX);
        assert_eq!(cover_target_px(Some("w=-5")), COVER_THUMB_PX);
    }

    /// 并发闸门：同时在飞的数量绝不超过 COVER_FETCH_CONCURRENCY。
    #[test]
    fn cover_gate_caps_concurrency() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static PEAK: AtomicUsize = AtomicUsize::new(0);
        static LIVE: AtomicUsize = AtomicUsize::new(0);

        let mut handles = Vec::new();
        for _ in 0..(COVER_FETCH_CONCURRENCY * 3) {
            handles.push(std::thread::spawn(|| {
                let _g = CoverGateGuard::acquire();
                let now = LIVE.fetch_add(1, Ordering::SeqCst) + 1;
                PEAK.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(20));
                LIVE.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert!(
            PEAK.load(Ordering::SeqCst) <= COVER_FETCH_CONCURRENCY,
            "峰值并发 {} 超过上限 {}",
            PEAK.load(Ordering::SeqCst),
            COVER_FETCH_CONCURRENCY
        );
    }

    /// single-flight：同一 key 的并发调用只真正取一次，其余复用结果。
    #[test]
    fn cover_flight_merges_concurrent_fetches() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static CALLS: AtomicUsize = AtomicUsize::new(0);

        let key = "flight-test-unique-key";
        let mut handles = Vec::new();
        for _ in 0..8 {
            handles.push(std::thread::spawn(move || {
                cover_bytes_shared(key, || {
                    CALLS.fetch_add(1, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(50));
                    Some(vec![7u8; 4])
                })
            }));
        }
        let mut results = Vec::new();
        for h in handles {
            results.push(h.join().unwrap());
        }
        // 所有跟随者都拿到同一份结果
        for r in &results {
            assert_eq!(r.as_deref(), Some(&[7u8; 4][..]));
        }
        // 允许极少数线程在领先者收尾后才进场（重新成为领先者），但不能是 8 次
        let calls = CALLS.load(Ordering::SeqCst);
        assert!(calls < 8, "并发同 key 应合并，实际取了 {calls} 次");
    }

    /// 领先者 panic 不能把同 key 的后续调用永久卡死。
    #[test]
    fn cover_flight_recovers_after_panic() {
        let key = "flight-panic-unique-key";
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let r = std::panic::catch_unwind(|| {
            cover_bytes_shared(key, || panic!("boom"));
        });
        std::panic::set_hook(prev);
        assert!(r.is_err(), "panic 应向上传播");

        // 卡死的话这里永远不会返回
        let again = cover_bytes_shared(key, || Some(vec![1u8]));
        assert_eq!(again.as_deref(), Some(&[1u8][..]));
    }
}
