//! 音源引擎窗口（双音源包架构，均在线安装、不再内置基线）：
//! 隐藏 webview，加载 qtres:// 引擎页（qtres.rs 内嵌 glue），页面里按本地
//! 状态装载生效数据包（meta-bundle.js，数据接口），再装配播放音源包。
//! 未装数据包 = 数据面下线（页面进 ready 态，数据接口按「未安装」口径报错；
//! 主窗口首页全屏引导安装）。主窗口经事件与之 RPC
//! （src/source-engine/client.ts），取链失败回退本地播放，不阻塞。
//!
//! - 与 lyric_window 同模式：动态创建、不进 tauri.conf.json、常驻不退出
//! - 换播放包 = Rust 广播 `source-pack-changed` → 引擎页在同一上下文里
//!   installPlayPack 热切换，**不再重建/重载本窗口**（?smoke=1 仅手动排障用）

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const SOURCE_ENGINE_LABEL: &str = "source-engine";

/// 引擎页地址（Windows/WebView2 会把 qtres:// 规范化为 http://qtres.localhost/）。
/// `smoke=1`：装配播放包后追加一次真实取链冒烟（仅手动排障用；换包热切换
/// 时引擎页自己就会带冒烟）。
pub(crate) fn engine_url(smoke: bool) -> tauri::Url {
    let url = if smoke {
        "qtres://localhost/engine/index.html?smoke=1"
    } else {
        "qtres://localhost/engine/index.html"
    };
    tauri::Url::parse(url).expect("engine url")
}

/// 导航策略适配：只把真实 `Url` getter 传给纯策略。
///
/// 策略本身（[`crate::source_engine_policy::engine_navigation_allowed`]）是
/// std-only 的，可在真实 crate 之外用 `rustc --test` 验证；这里不做任何
/// 路径/前缀 DIY，全部取 `url` crate 解析后的真实字段。
fn engine_navigation_allowed_url(url: &tauri::Url) -> bool {
    crate::source_engine_policy::engine_navigation_allowed(
        &crate::source_engine_policy::NavigationTarget {
            scheme: url.scheme(),
            host: url.host_str(),
            port: url.port(),
            path: url.path(),
            username: url.username(),
            password: url.password(),
            query: url.query(),
        },
    )
}

fn build(app: &AppHandle, smoke: bool) -> tauri::Result<tauri::WebviewWindow> {
    WebviewWindowBuilder::new(
        app,
        SOURCE_ENGINE_LABEL,
        WebviewUrl::CustomProtocol(engine_url(smoke)),
    )
    .title("轻听音源引擎")
    .inner_size(360.0, 240.0)
    .visible(false)
    .decorations(false)
    .skip_taskbar(true)
    .focused(false)
    .shadow(false)
    // S04：把内嵌 webview 的网络面锁死到初始引擎页——
    // - 导航只放行引擎页本身（qtres://localhost 或 Windows shim），其他
    //   origin/路由/端口/userinfo 一律拒绝；新窗口一律拒绝；
    // - 所有 frame 在 DocumentStart 冻结 RTC/WebTransport 全局（CSP 管不到的
    //   直连旁路）；脚本是 fix-security 发布的共享资产，幂等、可重复注入，
    //   失败名单以 __qtRtcLockFailures 暴露给页面 fail-closed。
    .on_navigation(engine_navigation_allowed_url)
    .on_new_window(|_url, _features| NewWindowResponse::Deny)
    .initialization_script_for_all_frames(crate::source_engine_policy::frame_network_lock_script())
    // 必须与主窗/小窗用同一套 WebView2 参数：同一 user data 目录下的多个
    // WebView2 环境参数不一致时，**后创建的那个直接失败**（2026-10-30 实测：
    // 只给主窗加参数，引擎窗创建报 HRESULT(0x8007139F)「没有注册类」，
    // 在线取链整体不可用）。新增窗口时别漏这一行。
    .additional_browser_args(crate::webview_mem::BROWSER_ARGS)
    .build()
}

/// 创建引擎窗口（已存在则原样返回）
pub fn create(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    if let Some(win) = app.get_webview_window(SOURCE_ENGINE_LABEL) {
        return Ok(win);
    }
    build(app, false)
}

#[cfg(test)]
mod tests {
    use super::engine_url;

    #[test]
    fn engine_url_paths() {
        assert_eq!(
            engine_url(false).path(),
            "/engine/index.html",
            "路径不带 smoke=1"
        );
        assert_eq!(engine_url(true).path(), "/engine/index.html");
        assert_eq!(
            engine_url(true).query(),
            Some("smoke=1"),
            "真实冒烟由查询串触发"
        );
        assert_eq!(engine_url(false).scheme(), "qtres");
    }
}
