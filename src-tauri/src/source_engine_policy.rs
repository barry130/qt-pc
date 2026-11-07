//! 音源引擎页（`qtres://localhost/engine/index.html`）的 CSP、导航与新窗口策略。
//!
//! 这里只放纯函数/常量（std-only）：可以在真实 crate 之外直接用
//! `rustc --test` 验证，不依赖 Tauri 运行时。`tauri::Url` → [`NavigationTarget`]
//! 的适配放在 `source_window.rs`（只做真实 getter 读取）。

/// 引擎页文档路径（精确匹配，不做前缀/大小写放宽）。
pub const SOURCE_ENGINE_PATH: &str = "/engine/index.html";

/// 所有 frame 在 DocumentStart 需要屏蔽的 RTC/直连通道全局。
///
/// CSP 的 connect-src 约束不到 WebRTC 的 ICE/UDP 与 WebTransport 的直连；
/// 这些入口由注入脚本在页面脚本之前冻结（定义成 undefined 且不可写）。
pub const RTC_GLOBAL_NAMES: [&str; 8] = [
    "RTCPeerConnection",
    "webkitRTCPeerConnection",
    "mozRTCPeerConnection",
    "RTCDataChannel",
    "RTCIceGatherer",
    "RTCIceTransport",
    "RTCDtlsTransport",
    "WebTransport",
];

/// 导航目标的纯数据快照（与 `tauri::Url` 的 getter 一一对应）。
#[derive(Debug, Clone, Copy)]
pub struct NavigationTarget<'a> {
    pub scheme: &'a str,
    pub host: Option<&'a str>,
    pub port: Option<u16>,
    pub path: &'a str,
    pub username: &'a str,
    pub password: Option<&'a str>,
    pub query: Option<&'a str>,
}

/// `/engine/index.html` 响应的 CSP（只注入这一个响应，其他 qtres 页面不动）。
///
/// - `script-src` 需要 `'unsafe-inline'`（页面是内联 module）与 `'unsafe-eval'`
///   （已装 meta-bundle 的 `installPlayPack` 用 `new Function(code)` 求值播放包）；
/// - `connect-src` 只放行自身与 Tauri IPC 的真实传输：Windows/Android 走
///   `http(s)://ipc.localhost`，其他平台走 `ipc://localhost`。
pub fn engine_page_csp() -> &'static str {
    concat!(
        "default-src 'none'; ",
        "base-uri 'none'; ",
        "object-src 'none'; ",
        "frame-src 'none'; ",
        "child-src 'none'; ",
        "worker-src 'none'; ",
        "form-action 'none'; ",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'; ",
        "connect-src 'self' ipc://localhost http://ipc.localhost https://ipc.localhost"
    )
}

/// 引擎窗口是否允许导航到 `target`。
///
/// 只放行初始引擎页：桌面自定义协议（`qtres://localhost`）与 Windows/WebView2
/// 规范化后的 shim（`http(s)://qtres.localhost`）；路径精确匹配，端口与 userinfo
/// 一律拒绝，查询串只允许空或 `smoke=1`（手动排障）。
pub fn engine_navigation_allowed(target: &NavigationTarget<'_>) -> bool {
    if !target.username.is_empty() || target.password.is_some() {
        return false;
    }
    if target.port.is_some() {
        return false;
    }
    if target.path != SOURCE_ENGINE_PATH {
        return false;
    }
    if !matches!(target.query, None | Some("smoke=1")) {
        return false;
    }
    matches!(
        (target.scheme, target.host),
        ("qtres", Some("localhost"))
            | ("http", Some("qtres.localhost"))
            | ("https", Some("qtres.localhost"))
    )
}

/// fix-security 发布的全 frame RTC 边界资产（页面与 Native 共用同一份文件）。
///
/// 契约（task16）：自包含 IIFE、只处理 [`RTC_GLOBAL_NAMES`]、把入口定义成
/// `undefined` 且不可写/不可配置、已冻结则跳过（幂等）；单个入口不可替换时
/// 继续锁其余入口，并把失败名单以冻结、不可枚举的 `__qtRtcLockFailures`
/// 暴露给页面 fail-closed。不碰 fetch/XHR 等页面自己封装的传输入口。
pub const RTC_INIT_SCRIPT: &str = include_str!("source_engine_rtc_init.js");

/// 所有 frame 的 DocumentStart 注入脚本。
///
/// 直接返回共享资产 [`RTC_INIT_SCRIPT`]，保证 Rust 注入内容与页面测试的是
/// 同一份实现，避免两份脚本漂移。CSP 只能压低文档能力，WebRTC/WebTransport
/// 的直连由这里在页面脚本之前冻结，两者是纵深关系，不能互相替代。
pub fn frame_network_lock_script() -> &'static str {
    RTC_INIT_SCRIPT
}
