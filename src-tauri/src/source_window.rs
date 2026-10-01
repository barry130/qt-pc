//! 音源引擎窗口（双音源包架构）：
//! 隐藏 webview，加载 qtres:// 引擎页（qtres.rs 内嵌 glue），页面里先 import
//! 内置 meta-bundle.js（数据接口），再按本地状态装配播放音源包。主窗口经事件
//! 与之 RPC（src/source-engine/client.ts），取链失败回退本地播放，不阻塞。
//!
//! - 与 lyric_window 同模式：动态创建、不进 tauri.conf.json、常驻不退出
//! - 换播放包 = Rust 广播 `source-pack-changed` → 引擎页在同一上下文里
//!   installPlayPack 热切换，**不再重建/重载本窗口**（?smoke=1 仅手动排障用）

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
