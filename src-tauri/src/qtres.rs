//! qtres:// 自定义协议（DESIGN §6.13）：
//! 前端一律 `qtres://cover/<base64url(原始URL)>`（Windows/WebView2 下为
//! `http://qtres.localhost/cover/...`），Rust 按音源补 Referer / UA 代取。
//!
//! - `cover/`：封面代取 + 内存去重缓存（不落盘缩略图，后续迭代补 @2x 与磁盘缓存）
//! - `mv/`：MV/视频 Range 透传——把 `<video>` 的 Range 头原样转发给上游，
//!   回传上游状态（200/206）与 Content-Range / Content-Length / Accept-Ranges，
//!   否则 video 无法拖动进度。视频不缓存。
//! - `/engine/index.html`：音源引擎页（source_window.rs 的隐藏窗口加载，
//!   内嵌 HTML，无 CSP 注入 → 可自由动态 import 音源包脚本）
//! - `/script/<code>/<file>`：只读分发已安装音源包文件（source-bundle/install/
//!   目录；code/file 严格校验防路径穿越）
//! - `/builtin/<file>`：内嵌内置音源包（编译期打进二进制；引擎页在未安装
//!   远程包 / 远程包加载失败时加载，保证开箱可用）
//!
//! 白名单：只允许已知音源 CDN 域名，防止歌词/皮肤数据把它当任意代理。

use base64::Engine as _;
use std::path::Path;
use std::sync::Mutex;
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

/// 引擎页 HTML（内嵌编译；改页面要重编 Rust）
const ENGINE_INDEX_HTML: &str = include_str!("source_engine_page.html");

/// 内置音源包（音源包热更新 P2 补充）：随应用编译进二进制的 bundle，
/// 引擎页在未安装远程包 / 远程包加载失败时加载，保证开箱可用。
/// 产物由 `npm run sync:builtin` 从 dist-sources 同步（勿手改）；
/// version.json 的 code/name 单源于前端 BUILTIN_SOURCE_VERSION。
const BUILTIN_BUNDLE_JS: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/builtin-sources/source-bundle.js"
));
const BUILTIN_CHAIN_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/builtin-sources/chain.json"
));
const BUILTIN_VERSION_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/builtin-sources/version.json"
));

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
fn handle_script_file<R: tauri::Runtime>(app: &tauri::AppHandle<R>, rest: &str) -> Response<Vec<u8>> {
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
    // 规范化前缀校验：兜底防符号链接/编码绕过
    if !starts_with_canonical(&target, &install_root) {
        log::warn!("[qtres] /script 规范化校验失败: {}", target.display());
        return not_found();
    }
    match std::fs::metadata(&target) {
        Ok(m) if m.is_file() && m.len() <= SCRIPT_FILE_MAX => {}
        _ => return not_found(),
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
    log::info!("[qtres] /script 分发: {code}/{file} ({} bytes)", bytes.len());
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        // no-store：音源包「立即应用」靠重建窗口重新拉脚本，不能吃缓存
        .header(header::CACHE_CONTROL, "no-store")
        .body(bytes)
        .unwrap_or_else(|_| not_found())
}

/// `/builtin/<file>`：内嵌内置音源包分发。文件名白名单逐一匹配，
/// 不落盘、无路径拼接，天然无穿越面。
fn handle_builtin_file(rest: &str) -> Response<Vec<u8>> {
    let file = rest.split(['?', '#']).next().unwrap_or(rest);
    let (body, content_type): (&[u8], &str) = match file {
        "source-bundle.js" => (BUILTIN_BUNDLE_JS, "application/javascript; charset=utf-8"),
        "chain.json" => (BUILTIN_CHAIN_JSON.as_bytes(), "application/json; charset=utf-8"),
        "version.json" => (BUILTIN_VERSION_JSON.as_bytes(), "application/json; charset=utf-8"),
        _ => return not_found(),
    };
    // 与 /script 分发同款日志：排查「引擎到底在用哪个包」全靠它
    log::info!("[qtres] /builtin 分发: {file} ({} bytes)", body.len());
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        // no-store：内置包随应用升级而变，且「立即应用」靠重建窗口重拉
        .header(header::CACHE_CONTROL, "no-store")
        .body(body.to_vec())
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
/// 再与规范化后的 root 比对。目标不存在（canonicalize 失败）返回 false——
/// 调用方（/script 分发）对不存在一律 not found，无需区分。
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
    ctx: tauri::UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    // 阻塞部分放独立线程，避免卡 WebView 主线程
    let app = ctx.app_handle().clone();
    std::thread::spawn(move || {
        let response = handle_qtres_sync(&app, request);
        responder.respond(response);
    });
}

fn handle_qtres_sync<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    // Windows/WebView2 下 URI 被规范化为 http://qtres.localhost/...，
    // 其余平台为 qtres://...；两者用 uri().path() 都得到 /cover|mv/<b64>
    let path = request.uri().path().to_string();
    // 音源引擎路由（P1）：引擎页内嵌提供 + 安装目录脚本只读分发。
    // 这些路径固定存在，放在 cover/mv 解码之前短路。
    if path == "/engine/index.html" {
        return engine_page_response();
    }
    if let Some(rest) = path.strip_prefix("/script/") {
        return handle_script_file(app, rest);
    }
    if let Some(rest) = path.strip_prefix("/builtin/") {
        return handle_builtin_file(rest);
    }
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
        .pool_max_idle_per_host(0)
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
        .pool_max_idle_per_host(0)
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

    #[test]
    fn engine_page_embedded() {
        let resp = engine_page_response();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body();
        let html = String::from_utf8(body).unwrap();
        assert!(html.contains("source-engine-request"), "含取链 RPC 监听");
        assert!(html.contains("createSourceLayer"), "调用 bundle 入口");
    }

    #[test]
    fn builtin_files_embedded() {
        // bundle 非空且含关键导出；版本与链配置可达
        let resp = handle_builtin_file("source-bundle.js");
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body();
        assert!(body.len() > 100 * 1024, "bundle 体积异常: {}", body.len());
        let js = String::from_utf8(body).unwrap();
        assert!(js.contains("createSourceLayer"));

        let chain = handle_builtin_file("chain.json");
        assert_eq!(chain.status(), StatusCode::OK);
        let chain_json: serde_json::Value =
            serde_json::from_slice(&chain.into_body()).unwrap();
        assert!(chain_json.get("chains").is_some());

        let version = handle_builtin_file("version.json");
        assert_eq!(version.status(), StatusCode::OK);
        let ver: serde_json::Value = serde_json::from_slice(&version.into_body()).unwrap();
        assert!(ver.get("code").and_then(|c| c.as_u64()).unwrap_or(0) > 20_260_000_00);

        assert_eq!(handle_builtin_file("evil.js").status(), StatusCode::NOT_FOUND);
        assert_eq!(
            handle_builtin_file("../secret.txt").status(),
            StatusCode::NOT_FOUND
        );
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
