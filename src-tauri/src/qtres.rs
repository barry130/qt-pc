//! qtres:// 自定义协议（DESIGN §6.13）：
//! 前端一律 `qtres://cover/<base64url(原始URL)>`（Windows/WebView2 下为
//! `http://qtres.localhost/cover/...`），Rust 按音源补 Referer / UA 代取。
//!
//! - `cover/`：封面代取 + 内存去重缓存（不落盘缩略图，后续迭代补 @2x 与磁盘缓存）
//! - `mv/`：MV/视频 Range 透传——把 `<video>` 的 Range 头原样转发给上游，
//!   回传上游状态（200/206）与 Content-Range / Content-Length / Accept-Ranges，
//!   否则 video 无法拖动进度。视频不缓存。
//!
//! 白名单：只允许已知音源 CDN 域名，防止歌词/皮肤数据把它当任意代理。

use base64::Engine as _;
use std::sync::Mutex;
use tauri::http::{header, Request, Response, StatusCode};

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
    "gdstudio.xyz",
];

/// 内存封面缓存：URL → bytes。M0 用简单 HashMap + 上限淘汰。
const COVER_CACHE_MAX: usize = 64;

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
    let host = rest.split('/').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    ALLOWED_HOST_SUFFIXES
        .iter()
        .any(|sfx| host == *sfx || host.ends_with(sfx))
}

/// 解码 `cover/` 或 `mv/` 路径（base64url，可无填充）→ 原始 URL
fn decode_res_path(path: &str) -> Option<(&'static str, String)> {
    let rest = path.trim_start_matches('/');
    let (kind, b64) = match rest.split_once('/') {
        Some(("cover", b)) => ("cover", b),
        Some(("mv", b)) => ("mv", b),
        _ => return None,
    };
    // URL path 中 base64url 无填充；补齐
    let padded = match b64.len() % 4 {
        2 => format!("{b64}=="),
        3 => format!("{b64}="),
        _ => b64.to_string(),
    };
    let bytes = base64::engine::general_purpose::URL_SAFE.decode(padded).ok()?;
    String::from_utf8(bytes).ok().map(|u| (kind, u))
}

fn placeholder() -> Response<Vec<u8>> {
    // 1×1 透明 PNG，避免 <img> onerror 抖动（DESIGN §6.13 失败兜底）
    let png: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00,
        0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header("Access-Control-Allow-Origin", "*")
        .body(png.to_vec())
        .unwrap()
}

/// 全局缓存（进程级；M0 简单实现）
static COVER_CACHE: Mutex<Option<lru_simple::Lru<String, Vec<u8>>>> = Mutex::new(None);

mod lru_simple {
    use std::collections::HashMap;

    pub struct Lru<K, V> {
        map: HashMap<K, (V, u64)>,
        tick: u64,
        cap: usize,
    }

    impl<K: std::hash::Hash + Eq + Clone, V> Lru<K, V> {
        pub fn new(cap: usize) -> Self {
            Self { map: HashMap::new(), tick: 0, cap }
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
                if let Some(oldest) = self
                    .map
                    .iter()
                    .min_by_key(|(_, (_, t))| *t)
                    .map(|(k, _)| k.clone())
                {
                    self.map.remove(&oldest);
                }
            }
            self.map.insert(k, (v, self.tick));
        }
    }
}

/// 注册到 `register_asynchronous_uri_scheme_protocol` 的处理函数。
pub fn handle_qtres<R: tauri::Runtime>(
    _ctx: tauri::UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    // 阻塞部分放独立线程，避免卡 WebView 主线程
    std::thread::spawn(move || {
        let response = handle_qtres_sync(request);
        responder.respond(response);
    });
}

fn handle_qtres_sync(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    // Windows/WebView2 下 URI 被规范化为 http://qtres.localhost/...，
    // 其余平台为 qtres://...；两者用 uri().path() 都得到 /cover|mv/<b64>
    let path = request.uri().path().to_string();
    let Some((kind, original_url)) = decode_res_path(&path) else {
        log::warn!("[qtres] 无法解码封面路径: {path}");
        return placeholder();
    };
    if !host_allowed(&original_url) {
        log::warn!("[qtres] 封面域名不在白名单，拒绝代取: {original_url}");
        return placeholder();
    }
    if kind == "mv" {
        return handle_mv(request, &original_url);
    }
    let logged = original_url.clone();
    let resp = handle_cover(original_url);
    log::info!("[qtres] cover kind={kind} status={} url={logged}",
        resp.status().as_u16());
    resp
}

/// MV / 视频 Range 透传（§6.13）：转发 Range 头，回传上游 200/206 与相应头。
fn handle_mv(request: Request<Vec<u8>>, url: &str) -> Response<Vec<u8>> {
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let client = match reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0")
        // 视频分块较大；连接/响应 20s 足够，避免假死占线程
        .timeout(std::time::Duration::from_secs(60))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(_) => return placeholder(),
    };
    let mut req = client.get(url).header("Referer", referer_for(url));
    if let Some(r) = &range {
        req = req.header(header::RANGE, r);
    }
    let resp = match req.send() {
        Ok(r) => r,
        Err(_) => return placeholder(),
    };
    let status = match StatusCode::from_u16(resp.status().as_u16()) {
        Ok(s) => s,
        Err(_) => return placeholder(),
    };
    if !status.is_success() {
        return placeholder();
    }
    let mut builder = Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header(header::ACCEPT_RANGES, "bytes");
    let content_type = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("video/mp4")
        .to_string();
    builder = builder.header(header::CONTENT_TYPE, content_type);
    for key in [header::CONTENT_RANGE, header::CONTENT_LENGTH] {
        if let Some(v) = resp.headers().get(&key).and_then(|v| v.to_str().ok()) {
            builder = builder.header(key.clone(), v);
        }
    }
    match resp.bytes() {
        Ok(body) => builder.body(body.to_vec()).unwrap_or_else(|_| placeholder()),
        Err(_) => placeholder(),
    }
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
fn fetch_cover_bytes(
    client: &reqwest::blocking::Client,
    url: &str,
) -> Option<Vec<u8>> {
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

fn handle_cover(original_url: String) -> Response<Vec<u8>> {
    // 缓存命中
    {
        let mut guard = COVER_CACHE.lock().unwrap();
        let cache = guard.get_or_insert_with(|| lru_simple::Lru::new(COVER_CACHE_MAX));
        if let Some(bytes) = cache.get(&original_url) {
            return image_response(bytes.clone(), &original_url);
        }
    }

    // 代取：按域名补 Referer / UA
    let fetch_url = upgrade_to_https(&original_url);
    let client = match reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0")
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(_) => return placeholder(),
    };
    // 先试升级后的 https；失败（酷我 img1.kwcdn.kuwo.cn 等图床不支持 https，
    // TLS 直接握手失败）再回退原始 URL，避免封面整片空白。
    let mut bytes = fetch_cover_bytes(&client, &fetch_url);
    if bytes.is_none() && fetch_url != original_url {
        bytes = fetch_cover_bytes(&client, &original_url);
        if bytes.is_none() {
            log::warn!("[qtres] cover 代取失败(url 与 https 回退均失败): {original_url}");
        }
    }

    match bytes {
        Some(data) if !data.is_empty() => {
            let url_for_cache = original_url.clone();
            {
                let mut guard = COVER_CACHE.lock().unwrap();
                let cache = guard.get_or_insert_with(|| lru_simple::Lru::new(COVER_CACHE_MAX));
                cache.insert(url_for_cache, data.clone());
            }
            image_response(data, &original_url)
        }
        _ => placeholder(),
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
    fn decode_cover_and_mv_paths() {
        let cover = b64url("https://p1.music.126.net/abc.jpg");
        let (kind, url) = decode_res_path(&format!("/cover/{cover}")).unwrap();
        assert_eq!(kind, "cover");
        assert_eq!(url, "https://p1.music.126.net/abc.jpg");

        let mv = b64url("http://media.kuwo.cn/a.mp4");
        let (kind, url) = decode_res_path(&format!("/mv/{mv}")).unwrap();
        assert_eq!(kind, "mv");
        assert_eq!(url, "http://media.kuwo.cn/a.mp4");

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
        assert!(host_allowed("http://p.qpic.cn/music_cover/xFPOwViasj/600?n=1"));
        assert!(host_allowed(
            "http://qpic.y.qq.com/music_cover/8eiaDBJ/300?n=1"
        ));
    }
}
