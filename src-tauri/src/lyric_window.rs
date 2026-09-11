//! 桌面歌词窗口管理（DESIGN §4.2 / §10）：
//! - 首次开启时动态创建（不进 tauri.conf.json），透明 + 置顶 + 不进任务栏
//! - 状态存 settings 表 "lyric.window" 键（§10 位置与样式不与主窗口混存）
//! - 锁定 = 鼠标穿透（set_ignore_cursor_events），解锁只能托盘/快捷键/主窗口
//! - 恢复位置前校验落点在某个显示器可见区域内（§4.2 注意 4）

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl};

use crate::db::store::{get_setting, set_setting};
use crate::db::Database;
use crate::AppState;

pub const LYRIC_WINDOW_LABEL: &str = "lyrics";

/// 桌面歌词窗口状态（§4.2 配置结构；存 settings 表 lyric.window 键）。
/// 手写 Default + serde(default)：旧存档缺字段时自动回落 §4.2 默认值。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LyricWindowState {
    pub visible: bool,
    pub locked: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub font_size: u32,
    pub font_weight: u32,
    pub opacity: f64,
    pub background_opacity: f64,
    pub stroke: bool,
    pub shadow: bool,
    pub gradient: [String; 2],
    /// single / two-lines
    pub line_mode: String,
}

impl Default for LyricWindowState {
    fn default() -> Self {
        Self {
            visible: false,
            locked: false,
            x: 120,
            y: 940,
            width: 900,
            height: 140,
            font_size: 24,
            font_weight: 700,
            opacity: 0.9,
            background_opacity: 0.0,
            stroke: false,
            shadow: true,
            gradient: ["#5b8cff".to_string(), "#b18cff".to_string()],
            line_mode: "two-lines".to_string(),
        }
    }
}

/// 从 settings 表读状态；无存档 / 解析失败返回默认
fn load_state(db: Option<&Database>) -> LyricWindowState {
    let Some(db) = db else {
        return LyricWindowState::default();
    };
    let saved = db.with(|c| get_setting(c, "lyric.window"));
    match saved {
        Ok(Some(json)) => serde_json::from_str(&json).unwrap_or_default(),
        _ => LyricWindowState::default(),
    }
}

fn save_state(db: Option<&Database>, state: &LyricWindowState) {
    if let Some(db) = db {
        if let Ok(json) = serde_json::to_string(state) {
            let _ = db.with(|c| set_setting(c, "lyric.window", &json));
        }
    }
}

/// 广播状态到 main + lyrics（§11.8 lyric-window-changed）
fn emit_state(app: &AppHandle, state: &LyricWindowState) {
    let _ = app.emit("lyric-window-changed", state);
}

/// 落点是否落在任一显示器可见区域内（§4.2 注意 4：多显示器 x/y 可能为负）
fn position_visible(app: &AppHandle, x: i32, y: i32) -> bool {
    for monitor in app.available_monitors().unwrap_or_default() {
        let PhysicalPosition { x: mx, y: my } = *monitor.position();
        let PhysicalSize { width, height } = *monitor.size();
        // 只要求标题点（左上角 + 1/4 高）在屏内，避免完全拖出后找不回窗口
        let probe_y = y + (height as i32 / 4).min(100);
        if x >= mx && x < mx + width as i32 && probe_y >= my && probe_y < my + height as i32 {
            return true;
        }
    }
    false
}

/// 动态创建歌词窗口（§4.2 参数）。已存在则直接返回句柄。
fn build_window(app: &AppHandle, state: &LyricWindowState) -> tauri::Result<tauri::WebviewWindow> {
    if let Some(win) = app.get_webview_window(LYRIC_WINDOW_LABEL) {
        return Ok(win);
    }
    WebviewWindowBuilder::new(app, LYRIC_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
        .title("轻听桌面歌词")
        .position(state.x as f64, state.y as f64)
        .inner_size(state.width as f64, state.height as f64)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(true)
        .focused(false)
        .visible(false)
        .build()
}

/// 显示歌词窗口（首次创建），返回应用后的状态
pub fn show(app: &AppHandle) -> Result<LyricWindowState, String> {
    let state = app.try_state::<AppState>();
    let db = state.as_ref().and_then(|s| s.db.clone());
    let mut state = load_state(db.as_deref());

    if !position_visible(app, state.x, state.y) {
        // 找不回位置：回主屏底部默认位
        if let Ok(Some(primary)) = app.primary_monitor() {
            let PhysicalSize { width, height } = *primary.size();
            state.x = ((width as i32) - state.width as i32) / 2;
            state.y = (height as i32) - state.height as i32 - 120;
        }
    }

    let win = build_window(app, &state).map_err(|e| format!("歌词窗口创建失败: {e}"))?;
    let _ = win.set_position(PhysicalPosition::new(state.x, state.y));
    let _ = win.set_size(PhysicalSize::new(state.width, state.height));
    let _ = win.set_ignore_cursor_events(state.locked);
    let _ = win.show();
    state.visible = true;
    save_state(db.as_deref(), &state);
    emit_state(app, &state);
    Ok(state)
}

/// 隐藏歌词窗口（保留进程与状态）
pub fn hide(app: &AppHandle) -> Result<LyricWindowState, String> {
    let state_guard = app.try_state::<AppState>();
    let db = state_guard.as_ref().and_then(|s| s.db.clone());
    let mut state = load_state(db.as_deref());
    if let Some(win) = app.get_webview_window(LYRIC_WINDOW_LABEL) {
        // 关窗前读回当前位置（用户拖过）
        if let Ok(pos) = win.outer_position() {
            if position_visible(app, pos.x, pos.y) {
                state.x = pos.x;
                state.y = pos.y;
            }
        }
        let _ = win.close();
    }
    state.visible = false;
    save_state(db.as_deref(), &state);
    emit_state(app, &state);
    Ok(state)
}

/// 显示 / 隐藏切换（托盘菜单与 Ctrl+Alt+L 的入口）
pub fn toggle(app: &AppHandle) {
    let state_guard = app.try_state::<AppState>();
    let db = state_guard.as_ref().and_then(|s| s.db.clone());
    let visible = load_state(db.as_deref()).visible;
    let result = if visible { hide(app) } else { show(app) };
    if let Err(e) = result {
        log::error!("[lyric-window] {e}");
    }
}

/// 锁定 / 解锁（§10.7 Ctrl+Alt+K；锁定 = 鼠标穿透）
pub fn set_locked(app: &AppHandle, locked: bool) -> Result<LyricWindowState, String> {
    let state_guard = app.try_state::<AppState>();
    let db = state_guard.as_ref().and_then(|s| s.db.clone());
    let mut state = load_state(db.as_deref());
    if let Some(win) = app.get_webview_window(LYRIC_WINDOW_LABEL) {
        let _ = win.set_ignore_cursor_events(locked);
    }
    state.locked = locked;
    save_state(db.as_deref(), &state);
    emit_state(app, &state);
    Ok(state)
}

/// 样式补丁（字号 / 描边 / 单双行 / 渐变等，字段级合并）
pub fn set_style(app: &AppHandle, patch: Value) -> Result<LyricWindowState, String> {
    let state_guard = app.try_state::<AppState>();
    let db = state_guard.as_ref().and_then(|s| s.db.clone());
    let mut state = load_state(db.as_deref());
    if let Some(obj) = patch.as_object() {
        if let Some(v) = obj.get("fontSize").and_then(Value::as_u64) {
            state.font_size = v.clamp(12, 96) as u32;
        }
        if let Some(v) = obj.get("fontWeight").and_then(Value::as_u64) {
            state.font_weight = v.clamp(300, 900) as u32;
        }
        if let Some(v) = obj.get("opacity").and_then(Value::as_f64) {
            state.opacity = v.clamp(0.2, 1.0);
        }
        if let Some(v) = obj.get("backgroundOpacity").and_then(Value::as_f64) {
            state.background_opacity = v.clamp(0.0, 1.0);
        }
        if let Some(v) = obj.get("stroke").and_then(Value::as_bool) {
            state.stroke = v;
        }
        if let Some(v) = obj.get("shadow").and_then(Value::as_bool) {
            state.shadow = v;
        }
        if let Some(v) = obj.get("lineMode").and_then(Value::as_str) {
            if v == "single" || v == "two-lines" {
                state.line_mode = v.to_string();
            }
        }
        if let Some(arr) = obj.get("gradient").and_then(Value::as_array) {
            let colors: Vec<String> = arr
                .iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect();
            if colors.len() == 2 {
                state.gradient = [colors[0].clone(), colors[1].clone()];
            }
        }
    }
    save_state(db.as_deref(), &state);
    emit_state(app, &state);
    Ok(state)
}

/// 写回位置与尺寸（前端拖动 / 缩放后调用；越界位置拒绝）
pub fn set_bounds(
    app: &AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<LyricWindowState, String> {
    let state_guard = app.try_state::<AppState>();
    let db = state_guard.as_ref().and_then(|s| s.db.clone());
    let mut state = load_state(db.as_deref());
    if !position_visible(app, x, y) {
        return Err("位置超出可见区域".to_string());
    }
    state.x = x;
    state.y = y;
    state.width = width.clamp(300, 4000);
    state.height = height.clamp(60, 600);
    save_state(db.as_deref(), &state);
    emit_state(app, &state);
    Ok(state)
}

pub fn reset(app: &AppHandle) -> Result<LyricWindowState, String> {
    let state_guard = app.try_state::<AppState>();
    let db = state_guard.as_ref().and_then(|s| s.db.clone());
    let visible = load_state(db.as_deref()).visible;
    let state = LyricWindowState {
        visible,
        ..LyricWindowState::default()
    };
    save_state(db.as_deref(), &state);
    emit_state(app, &state);
    Ok(state)
}

pub fn get_state(app: &AppHandle) -> LyricWindowState {
    let state_guard = app.try_state::<AppState>();
    let db = state_guard.as_ref().and_then(|s| s.db.clone());
    load_state(db.as_deref())
}
