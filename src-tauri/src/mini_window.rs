//! 迷你播放器窗口（第二波 P1，REQUIREMENTS §3.21.7.2 / DESIGN §4.3）：
//! - 无边框 + 透明圆角 + 置顶 + 不进任务栏的小窗，封面 / 歌名 / 基础控制
//! - 与主窗口互切：进入迷你隐藏主窗，返回 / Alt+F4 关闭迷你时唤回主窗
//! - 位置存 settings 表 "mini.window" 键（物理像素，与桌面歌词同一套持久化口径）；
//!   尺寸固定（440×92 逻辑），队列展开的高度切换由前端 setSize 驱动，不落库
//! - 恢复位置前校验落点在某个显示器可见区域内（§4.2 注意 4 同款防拖丢）

use serde::{Deserialize, Serialize};
use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl};

use crate::db::store::{get_setting, set_setting};
use crate::db::Database;
use crate::settings_keys::SETTING_MINI_WINDOW;
use crate::AppState;

pub const MINI_WINDOW_LABEL: &str = "mini";

/// 迷你条逻辑宽度；位置持久化用物理像素，默认位置按显示器缩放换算。
pub const MINI_WIDTH: f64 = 440.0;
/// 迷你条逻辑高度；展开队列时前端把窗口高度调到 MINI_EXPANDED_HEIGHT
pub const MINI_BAR_HEIGHT: f64 = 92.0;
pub const MINI_EXPANDED_HEIGHT: f64 = 340.0;

/// 靠主屏右下角默认位的边距（物理像素，给任务栏留量走经验值 64）
const DEFAULT_MARGIN: i32 = 24;
const TASKBAR_RESERVE: i32 = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MiniWindowState {
    visible: bool,
    x: i32,
    y: i32,
}

impl Default for MiniWindowState {
    fn default() -> Self {
        Self { visible: false, x: 120, y: 120 }
    }
}

fn load_state(db: Option<&Database>) -> MiniWindowState {
    let Some(db) = db else { return MiniWindowState::default() };
    let raw = match db.with(|c| get_setting(c, SETTING_MINI_WINDOW)) {
        Ok(Some(v)) => v,
        _ => return MiniWindowState::default(),
    };
    let mut state = match serde_json::from_str::<MiniWindowState>(&raw) {
        Ok(s) => s,
        Err(_) => return MiniWindowState::default(),
    };
    // 启动时一律当作不可见：上次退出若停在迷你模式，下次开机照常起主窗
    state.visible = false;
    state
}

fn save_state(db: Option<&Database>, state: &MiniWindowState) {
    if let Some(db) = db {
        if let Ok(json) = serde_json::to_string(state) {
            let _ = db.with(|c| set_setting(c, SETTING_MINI_WINDOW, &json));
        }
    }
}

/// 落点是否落在任一显示器可见区域内（与桌面歌词 §4.2 注意 4 同一判法：
/// 只要求窗口左上角附近一点在屏内，避免完全拖出后找不回窗口）
fn position_visible(app: &AppHandle, x: i32, y: i32) -> bool {
    for monitor in app.available_monitors().unwrap_or_default() {
        let PhysicalPosition { x: mx, y: my } = *monitor.position();
        let PhysicalSize { width, height } = *monitor.size();
        let probe_y = y + (height as i32 / 4).min(100);
        if x >= mx && x < mx + width as i32 && probe_y >= my && probe_y < my + height as i32 {
            return true;
        }
    }
    false
}

/// 主屏右下角默认位：先按缩放把窗口和边距转换为物理像素。
fn default_position(app: &AppHandle) -> (i32, i32) {
    if let Ok(Some(primary)) = app.primary_monitor() {
        let PhysicalPosition { x: mx, y: my } = *primary.position();
        let PhysicalSize { width, height } = *primary.size();
        let scale = primary.scale_factor();
        let x = mx + width as i32 - ((MINI_WIDTH + DEFAULT_MARGIN as f64) * scale).round() as i32;
        let y = my + height as i32 - ((MINI_EXPANDED_HEIGHT + TASKBAR_RESERVE as f64) * scale).round() as i32;
        return (x.max(mx), y.max(my));
    }
    (120, 120)
}

/// 动态创建迷你窗口（不进 tauri.conf.json）。已存在则直接返回句柄。
fn build_window(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    if let Some(win) = app.get_webview_window(MINI_WINDOW_LABEL) {
        return Ok(win);
    }
    WebviewWindowBuilder::new(
        app,
        MINI_WINDOW_LABEL,
        // 独立入口（2026-10-30）：迷你窗只要自己那一小块界面，
        // 不再复用主窗的 index.html 把整套启动代码拖进这个渲染进程。
        WebviewUrl::App("mini.html".into()),
    )
    .title("轻听迷你播放器")
    .inner_size(MINI_WIDTH, MINI_BAR_HEIGHT)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .resizable(false)
    .focused(true)
    .visible(false)
    // 与主窗共用同一套 WebView2 参数（tauri.conf.json 的 additionalBrowserArgs
    // 只作用于配置里声明的窗口，代码创建的小窗要自己再传一次）
    .additional_browser_args(crate::webview_mem::BROWSER_ARGS)
    .build()
}

/// 迷你模式是否处于激活态（托盘「迷你模式」勾选态的唯一判据）。
///
/// 退出迷你模式时窗口是 destroy 而不是 hide（见下方 hide），所以「窗口还在」
/// 就等于「迷你模式开着」。不看持久化状态：进程被强杀时那份 visible 会留下
/// 脏值，而启动时并不会自动恢复迷你模式（lib.rs 只恢复桌面歌词窗）。
pub fn is_active(app: &AppHandle) -> bool {
    app.get_webview_window(MINI_WINDOW_LABEL)
        .and_then(|win| win.is_visible().ok())
        .unwrap_or(false)
}

/// 显示迷你窗口并隐藏主窗（互切的一半）。返回应用后的可见性。
pub fn show(app: &AppHandle) -> Result<bool, String> {
    let state_guard = app.try_state::<AppState>();
    let db = state_guard.as_ref().and_then(|s| s.db.clone());
    let mut state = load_state(db.as_deref());

    if !position_visible(app, state.x, state.y) {
        let (x, y) = default_position(app);
        state.x = x;
        state.y = y;
    }

    let win = build_window(app).map_err(|e| format!("迷你窗口创建失败: {e}"))?;
    let _ = win.set_position(PhysicalPosition::new(state.x, state.y));
    win.show().map_err(|e| format!("显示迷你窗口失败: {e}"))?;
    let _ = win.set_always_on_top(true);
    let _ = win.set_focus();
    if let Some(main) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) {
        let was_visible = main.is_visible().unwrap_or(false);
        if let Err(e) = main.hide() {
            let _ = win.hide();
            return Err(format!("收起主窗口失败: {e}"));
        }
        if was_visible {
            let _ = app.emit("stat_window_hidden", ());
        }
    }
    state.visible = true;
    save_state(db.as_deref(), &state);
    let _ = app.emit("mini-window-changed", true);
    // 托盘「迷你模式」的勾选要跟着变（用户从播放条按钮或快捷键进来时也是这条路径）
    crate::tray::sync_mini_checked(app);
    Ok(true)
}

/// 关闭迷你窗口（**销毁**，不常驻）并唤回主窗。
///
/// 2026-10-30 资源优化：原来是 `hide()` 只隐藏不销毁（注释写的是「复用窗口，
/// 避免 CloseRequested 再次触发自身」），实测一个隐藏着的迷你窗仍占约
/// 150 MB 渲染进程内存。改用 `destroy()`：它不触发 CloseRequested（所以
/// 不会再被上面的分支接住），下次进迷你模式由 build_window 重建，代价约
/// 300ms，但不用迷你模式时这份内存直接还给系统。
pub fn hide(app: &AppHandle) -> Result<bool, String> {
    let state_guard = app.try_state::<AppState>();
    let db = state_guard.as_ref().and_then(|s| s.db.clone());
    let mut state = load_state(db.as_deref());
    if let Some(win) = app.get_webview_window(MINI_WINDOW_LABEL) {
        if let Ok(pos) = win.outer_position() {
            if position_visible(app, pos.x, pos.y) {
                state.x = pos.x;
                state.y = pos.y;
            }
        }
        // destroy 而不是 close：close 会再发一次 CloseRequested，而
        // lib.rs 的 on_window_event 正是用「收到关闭 → 调本函数」来兜底。
        win.destroy().map_err(|e| format!("收起迷你窗口失败: {e}"))?;
    }
    state.visible = false;
    save_state(db.as_deref(), &state);
    if let Some(main) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) {
        let was_visible = main.is_visible().unwrap_or(false);
        let _ = main.unminimize();
        main.show().map_err(|e| format!("显示主窗口失败: {e}"))?;
        let _ = main.set_focus();
        if !was_visible {
            let _ = app.emit("stat_window_shown", ());
        }
    }
    let _ = app.emit("mini-window-changed", false);
    crate::tray::sync_mini_checked(app);
    Ok(false)
}

/// 退出应用时也保存位置：用户可能一直停在迷你模式，没有经过 hide。
pub fn remember_position(app: &AppHandle) {
    let Some(win) = app.get_webview_window(MINI_WINDOW_LABEL) else { return };
    let Ok(pos) = win.outer_position() else { return };
    if !position_visible(app, pos.x, pos.y) { return; }
    let state_guard = app.try_state::<AppState>();
    let db = state_guard.as_ref().and_then(|s| s.db.clone());
    save_state(db.as_deref(), &MiniWindowState { visible: false, x: pos.x, y: pos.y });
}

/// 进入 / 退出迷你模式切换（播放条按钮与迷你窗「返回主窗」按钮共用入口）
pub fn toggle(app: &AppHandle) -> Result<bool, String> {
    let visible = app
        .get_webview_window(MINI_WINDOW_LABEL)
        .and_then(|win| win.is_visible().ok())
        .unwrap_or(false);
    if visible { hide(app) } else { show(app) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_json_roundtrip_camel_case() {
        let s = MiniWindowState { visible: true, x: -8, y: 240 };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"visible\":true"));
        assert!(json.contains("\"x\":-8"));
        // 坏数据回落默认（不 panic、不丢字段类型）
        assert!(serde_json::from_str::<MiniWindowState>("not json").is_err());
        let back: MiniWindowState = serde_json::from_str(&json).unwrap();
        assert_eq!(back.y, 240);
    }
}
