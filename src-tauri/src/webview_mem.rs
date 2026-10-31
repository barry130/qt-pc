//! WebView2 侧的资源调参（2026-10-30 资源优化，用户 m06536）。
//!
//! 一个应用里主窗、桌面歌词窗、迷你窗、音源引擎窗各占一个完整 Chromium
//! 渲染进程，四者加起来是内存与 GPU 占用的主体。这里只管两件**进程级**的事，
//! 页面内部怎么省（rAF 收敛、小窗独立入口页、毛玻璃降级）都在前端那侧：
//!
//! 1. [`BROWSER_ARGS`]：三个窗口共用的启动参数（V8 老生代上限、磁盘缓存上限）。
//!    `tauri.conf.json` 的 `additionalBrowserArgs` 只作用于配置里声明的窗口，
//!    代码创建的小窗走 `.additional_browser_args()` 再传一次，两处必须同源。
//! 2. [`set_low`]：窗口隐藏时把 WebView2 的内存档位降到 Low，可见后回 Normal。
//!
//! 注意 `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection` 是
//! Tauri 自己的默认值：一旦显式传 `additionalBrowserArgs`，Tauri 就不再补这
//! 三个开关，必须手写回来，否则 WebView2 会冒出「打开 PDF / SmartScreen」
//! 之类的原生 UI 与额外进程。

/// 三个窗口共用的 WebView2 启动参数。
///
/// * `--js-flags=--max-old-space-size=768`：V8 老生代上限。默认按物理内存算，
///   本机可到 4GB；这个应用的状态全在 SQLite 与 Rust 侧，渲染进程里只有 React
///   状态与列表数据，768MB 足够，超了应该报 OOM 而不是把整机拖慢。
/// * `--disk-cache-size=52428800`：WebView2 磁盘缓存上限 50MB。封面、切图、
///   脚本 bundle 都走 qtres 自定义协议不落这份缓存，留 50MB 给样式与脚本绰绰有余。
pub const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
     --js-flags=--max-old-space-size=768 --disk-cache-size=52428800";

/// 把 `win` 的 WebView2 内存档位设为 Low（`low = true`）或 Normal。
///
/// 失败全部静默：`with_webview` 在窗口正在销毁的竞态里会返回 Err；老运行时
/// （WebView2 Runtime < 1.0.2210）没有 `ICoreWebView2_19`，cast 也会失败。
/// 档位只是顺手省几十 MB，不该让前端看到错误。
#[cfg(windows)]
pub fn set_low(win: &tauri::WebviewWindow, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows::core::Interface;

    let level = if low {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    };
    let _ = win.with_webview(move |pw| {
        let controller = pw.controller();
        // controller 拿不到 CoreWebView2 就是窗口还没初始化完，直接放弃
        let core = match unsafe { controller.CoreWebView2() } {
            Ok(core) => core,
            Err(_) => return,
        };
        if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
            unsafe {
                let _ = core19.SetMemoryUsageTargetLevel(level);
            }
        }
    });
}

/// 非 Windows 平台没有 WebView2，保持空实现（调用点不用 cfg）。
#[cfg(not(windows))]
pub fn set_low(_win: &tauri::WebviewWindow, _low: bool) {}
