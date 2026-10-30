//! 音源账号网页登录（宿主侧，v17 契约 auth.webLogin）：
//!
//! 数据包在 `auth.webLogin` 里声明官方登录页地址与 Cookie 标记
//! （{url, cookieMarkers, note?, captureUrls?}）。宿主用独立
//! [`WEB_LOGIN_LABEL`] 窗口打开官方登录页，用户在窗口内走官方方式
//! （QQ/微信/手机号…）登录；前端（src/lib/source-web-login.ts）轮询
//! [`source_web_login_capture`] 逐 URL 读 Cookie，合并后命中 marker 就走
//! 现有 authImportCookie 校验并 saveSourceAuthAccount 入库，最后关窗。
//! 用户手动关窗由 capture 返回 `closed=true` 明确告知前端（不能只回空列表：
//! 页面加载期本来就可能是空 Cookie，前端无法区分）。
//!
//! 为什么读 Cookie 必须走 Rust：窗口内是官方页面的 httpOnly/secure Cookie，
//! JS 读不到，只能用 `WebviewWindow::cookies_for_url`（含 httpOnly/secure）。
//!
//! Windows 死锁警告：tauri 2.12.1 官方文档明确 —— 在同步 command 或事件回调
//! 里调用 cookies_for_url 会死锁（WebView2 要求非 UI 线程调用，wry#583），
//! 所以下面三个命令**全部是 async command**（跑在异步线程池，不占主线程）。

use std::sync::mpsc;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 登录窗口 label（前端只经命令间接操作，不感知该值）
pub const WEB_LOGIN_LABEL: &str = "qt-source-web-login";

/// 打开（或重建）音源登录窗口：
/// 已存在先 destroy 再建，保证每次都从登录页首帧开始（不带上一轮会话残留）。
#[tauri::command]
pub async fn source_web_login_open(app: AppHandle, url: String) -> Result<(), String> {
    // 旧窗口先销毁（destroy 不触发 CloseRequested，不会被拦截）
    if let Some(win) = app.get_webview_window(WEB_LOGIN_LABEL) {
        let _ = win.destroy();
    }
    let login_url = tauri::Url::parse(&url).map_err(|e| format!("网页登录地址无效 {url}: {e}"))?;

    // 建窗必须在主线程（Tauri 2 约束）。async command 跑在异步线程池，
    // 用 run_on_main_thread 排队建窗，mpsc 把结果带回来。
    let handle = app.clone();
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(build_login_window(&handle, login_url));
    })
    .map_err(|e| format!("调度主线程建窗失败: {e}"))?;
    rx.recv()
        .map_err(|_| "主线程建窗结果通道关闭".to_string())?
}

/// [`source_web_login_capture`] 的返回：`closed=true` 表示登录窗口已不存在
/// （用户手动关闭），前端据此立即结束本轮（cancelled），不再空转到超时。
#[derive(serde::Serialize)]
pub struct WebLoginCapture {
    pub closed: bool,
    /// 逐 URL 拼好的 Cookie 字符串（closed=true 时为空）
    pub chunks: Vec<String>,
}

/// 逐 URL 读取登录窗口的 Cookie（含 httpOnly/secure）：每个 URL 把命中的
/// Cookie 拼成 `name=value; name2=v2` 字符串，空串（无 Cookie/解析失败）过滤。
/// 窗口不存在（用户已关）→ `closed=true`，前端判定为「已取消」。
#[tauri::command]
pub async fn source_web_login_capture(
    app: AppHandle,
    urls: Vec<String>,
) -> Result<WebLoginCapture, String> {
    let Some(win) = app.get_webview_window(WEB_LOGIN_LABEL) else {
        return Ok(WebLoginCapture { closed: true, chunks: Vec::new() });
    };
    let mut chunks = Vec::new();
    for raw in urls {
        // 单个 URL 解析失败只跳过该条，不拖垮整批
        let Ok(url) = tauri::Url::parse(&raw) else {
            log::warn!("[web-login] capture 跳过无效 URL: {raw}");
            continue;
        };
        match win.cookies_for_url(url) {
            Ok(cookies) => {
                let joined = cookies
                    .iter()
                    .map(|c| format!("{}={}", c.name(), c.value()))
                    .collect::<Vec<_>>()
                    .join("; ");
                if !joined.is_empty() {
                    chunks.push(joined);
                }
            }
            Err(e) => log::warn!("[web-login] capture 读取 Cookie 失败 {raw}: {e}"),
        }
    }
    Ok(WebLoginCapture { closed: false, chunks })
}

/// 关闭并销毁登录窗口（校验成功/超时/取消后调用；不存在则忽略）。
#[tauri::command]
pub async fn source_web_login_close(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(WEB_LOGIN_LABEL) {
        win.destroy().map_err(|e| format!("关闭登录窗口失败: {e}"))?;
    }
    Ok(())
}

/// 诊断用（已脱敏）：只回报捕获到的 Cookie **名称**，不写盘、不回传任何值。
///
/// 2026-10-29 改：旧实现把整条 Cookie 原文（含平台会话凭据）写进
/// `%TEMP%/qt-weblogin-debug.txt` 且从不清理 —— 相当于把可复用的登录态明文
/// 长期留在磁盘上（安全评审 P0）。诊断需要的是「缺了哪几个键」，
/// 名称足够定位问题，值一律不出进程。
#[tauri::command]
pub async fn source_web_login_diagnose_names(cookie: String) -> Result<Vec<String>, String> {
    let mut names: Vec<String> = cookie
        .split(';')
        .filter_map(|pair| pair.split('=').next())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}

/// 建登录窗（只在主线程调用）：约 480×640、居中、可缩放的常规窗口。
fn build_login_window(app: &AppHandle, url: tauri::Url) -> Result<(), String> {
    WebviewWindowBuilder::new(app, WEB_LOGIN_LABEL, WebviewUrl::External(url))
        .title("登录音源账号")
        .inner_size(480.0, 640.0)
        .center()
        .resizable(true)
        .build()
        .map_err(|e| format!("登录窗口创建失败: {e}"))?;
    Ok(())
}
