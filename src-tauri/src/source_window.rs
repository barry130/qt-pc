//! 音源引擎窗口（音源包热更新方案 P1）：
//! 隐藏 webview，加载 qtres:// 引擎页（qtres.rs 内嵌 glue），页面里动态
//! import 远程音源包脚本并跑 `createSourceLayer`。主窗口经事件与之 RPC
//! （src/source-engine/client.ts），取链失败回退内置实现，不阻塞播放。
//!
//! - 与 lyric_window 同模式：动态创建、不进 tauri.conf.json、常驻不退出
//! - 音源包「立即应用」= 重建窗口（apply，带 ?smoke=1 触发真实冒烟）；
//!   平常启动 = 普通创建（只做编译级冒烟，离线启动不被网络抖动惩罚）

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const SOURCE_ENGINE_LABEL: &str = "source-engine";

/// 引擎页地址（Windows/WebView2 会把 qtres:// 规范化为 http://qtres.localhost/）。
/// `smoke=1`：加载远程包后追加一次真实取链冒烟（§2.4 第三层把关）。
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

/// 重载引擎窗口（音源包应用/回滚后调用）：导航到引擎页新地址（no-store
/// 保证脚本重新拉取），smoke 决定是否触发真实网络冒烟。
/// 用 navigate 而非 destroy+rebuild：销毁是异步的，立刻重建会撞
/// 「label already exists」竞态；导航无此问题。
pub fn recreate(app: &AppHandle, smoke: bool) -> Result<(), String> {
    match app.get_webview_window(SOURCE_ENGINE_LABEL) {
        Some(win) => win
            .navigate(engine_url(smoke))
            .map_err(|e| format!("重载音源引擎失败: {e}")),
        None => build(app, smoke)
            .map(|_| ())
            .map_err(|e| format!("创建音源引擎窗口失败: {e}")),
    }
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
