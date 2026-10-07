//! 桌面歌词窗口管理（DESIGN §4.2 / §10）：
//! - 首次开启时动态创建（不进 tauri.conf.json），透明 + 置顶 + 不进任务栏
//! - 状态存 settings 表 "lyric.window" 键（§10 位置与样式不与主窗口混存）
//! - 锁定 = 禁止拖动 + 鼠标穿透（set_ignore_cursor_events）：锁定时窗口对
//!   鼠标完全透明，解锁走主窗口 / 托盘 / Ctrl+Alt+K
//! - 恢复位置前校验落点在某个显示器可见区域内（§4.2 注意 4）

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl};

#[cfg(target_os = "windows")]
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, FindWindowW, GetMessageW, IsWindowVisible, SetWindowLongPtrW, SetWindowPos,
    TranslateMessage, EVENT_SYSTEM_FOREGROUND, GWLP_HWNDPARENT, HWND_TOPMOST, MSG, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, WINEVENT_OUTOFCONTEXT,
};

use crate::db::store::{get_setting, set_setting};
use crate::db::Database;
use crate::AppState;

/// 在 Windows 上直接把歌词窗口放入系统 TOPMOST 层。
/// Tauri 的 set_always_on_top 在无焦点透明窗口贴近任务栏时可能只维持进程内层级，
/// 其他应用激活后仍会覆盖窗口，因此这里使用 Win32 SetWindowPos 强制系统级置顶。
#[cfg(target_os = "windows")]
fn force_windows_topmost(win: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = win
        .hwnd()
        .map_err(|e| format!("获取歌词窗口句柄失败: {e}"))?;
    unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
        .map_err(|e| format!("设置歌词窗口系统级置顶失败: {e}"))?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn attach_lyric_to_taskbar(win: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = win
        .hwnd()
        .map_err(|e| format!("获取歌词窗口句柄失败: {e}"))?;
    let taskbar = unsafe { FindWindowW(windows::core::w!("Shell_TrayWnd"), None) }
        .map_err(|e| format!("查找 Windows 任务栏窗口失败: {e}"))?;
    if taskbar.0.is_null() {
        return Err("未找到 Windows 任务栏窗口".to_string());
    }
    unsafe {
        // windows 0.62 在 32 位下把 SetWindowLongPtrW re-export 成 SetWindowLongW，
        // 参数是 i32 而非 isize；用 `as _` 让编译器按目标指针宽度推断（x64/arm64 推成
        // isize，i686 推成 i32），否则 i686 交叉编译报 E0308。
        SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, taskbar.0 as _);
    }
    force_windows_topmost(win)
}

#[cfg(not(target_os = "windows"))]
fn force_windows_topmost(_win: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn attach_lyric_to_taskbar(_win: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}

/// 将歌词窗口重新放到 TOPMOST 组最前端，不激活窗口、不改变位置和大小。
#[cfg(target_os = "windows")]
fn restore_lyric_topmost(raw_hwnd: usize) {
    let hwnd = windows::Win32::Foundation::HWND(raw_hwnd as *mut core::ffi::c_void);
    if unsafe { IsWindowVisible(hwnd) }.as_bool() {
        let _ = unsafe {
            SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
        };
    }
}

/// Windows 会在 EVENT_SYSTEM_FOREGROUND 发出后继续调整 Shell_TrayWnd 的 Z-order。
/// 因此先立即恢复一次，再做几次短延迟重试，覆盖 Explorer 的异步重排窗口。
/// 代次计数用于让连续切换应用时的旧重试任务尽快退出，避免相互竞争。
#[cfg(target_os = "windows")]
unsafe extern "system" fn foreground_changed(
    _hook: HWINEVENTHOOK,
    event: u32,
    _foreground: windows::Win32::Foundation::HWND,
    _object_id: i32,
    _child_id: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    if event != EVENT_SYSTEM_FOREGROUND {
        return;
    }
    let Some(raw_hwnd) = LYRIC_HWND.get().copied() else {
        return;
    };

    restore_lyric_topmost(raw_hwnd);
    let generation = TOPMOST_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let _ = std::thread::Builder::new()
        .name("lyric-topmost-retry".to_string())
        .spawn(move || {
            for delay_ms in [16_u64, 40, 90, 180] {
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                if TOPMOST_GENERATION.load(std::sync::atomic::Ordering::SeqCst) != generation {
                    return;
                }
                restore_lyric_topmost(raw_hwnd);
            }
        });
}

#[cfg(target_os = "windows")]
static LYRIC_HWND: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
#[cfg(target_os = "windows")]
static TOPMOST_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(target_os = "windows")]
fn start_topmost_guard(app: AppHandle) {
    if let Some(win) = app.get_webview_window(LYRIC_WINDOW_LABEL) {
        if let Ok(hwnd) = win.hwnd() {
            let _ = LYRIC_HWND.set(hwnd.0 as usize);
        }
    }

    let _ = std::thread::Builder::new()
        .name("lyric-topmost-guard".to_string())
        .spawn(move || unsafe {
            let hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                Some(foreground_changed),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            if hook.0.is_null() {
                log::error!("[lyric-window] 注册前台窗口变化监听失败");
                return;
            }

            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            let _ = UnhookWinEvent(hook);
        });
}

#[cfg(not(target_os = "windows"))]
fn start_topmost_guard(_app: AppHandle) {}

pub const LYRIC_WINDOW_LABEL: &str = "lyrics";

/// 桌面歌词窗口状态（§4.2 配置结构；存 settings 表 lyric.window 键）。
/// 手写 Default + serde(default)：旧存档缺字段时自动回落 §4.2 默认值
/// （旧存档里多余的 click_through 字段会被 serde 直接忽略）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LyricWindowState {
    pub visible: bool,
    /// 锁定 = 禁止拖动 + 鼠标穿透（锁定时窗口对鼠标透明，
    /// 解锁走主窗口 / 托盘 / Ctrl+Alt+K）
    pub locked: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// 置顶开关（总在最前 / 不置顶）
    pub always_on_top: bool,
    /// 字体家族，空串 = 跟随系统默认
    pub font_family: String,
    pub font_size: u32,
    pub font_weight: u32,
    /// 字间距（px）
    pub letter_spacing: f64,
    /// 行间距（倍数，1.0–2.5）
    pub line_gap: f64,
    /// 当前行高亮渐变色（两端）
    pub gradient: [String; 2],
    /// 非当前行文字颜色（css 颜色串）
    pub inactive_color: String,
    pub opacity: f64,
    pub stroke: bool,
    /// 描边宽度（px），stroke 为 false 时忽略
    pub stroke_width: f64,
    pub shadow: bool,
    /// none / mask（半透明蒙版）/ solid（纯色）
    pub background_mode: String,
    /// 纯色模式的背景色（css 颜色串）
    pub background_color: String,
    pub background_opacity: f64,
    /// 窗口圆角（px，0 = 直角）
    pub border_radius: u32,
    /// left / center / right
    pub align: String,
    /// single / two-lines / three-lines
    pub line_mode: String,
}

impl Default for LyricWindowState {
    fn default() -> Self {
        Self {
            visible: false,
            locked: false,
            x: 120,
            y: 940,
            // 520：默认不再太宽，长行歌词才有空间触发横向滚动（见 MarqueeLine.tsx）
            width: 520,
            // 180 = 顶部工具条占位(44) + 三行歌词（当前行 24px 行距 1.35）的舒适高度
            height: 180,
            always_on_top: true,
            font_family: String::new(),
            font_size: 24,
            font_weight: 700,
            letter_spacing: 0.0,
            line_gap: 1.35,
            gradient: ["#5b8cff".to_string(), "#b18cff".to_string()],
            inactive_color: "rgba(255,255,255,0.65)".to_string(),
            opacity: 0.9,
            stroke: false,
            stroke_width: 1.0,
            shadow: true,
            background_mode: "none".to_string(),
            background_color: "#000000".to_string(),
            background_opacity: 0.0,
            border_radius: 12,
            align: "center".to_string(),
            line_mode: "two-lines".to_string(),
        }
    }
}

/// 从 settings 表读状态；无存档 / 解析失败返回默认。
/// 旧存档高度 140 是「工具条独立占位」改版前的默认值，装不下三行 + 工具条，升级到 180。
fn load_state(db: Option<&Database>) -> LyricWindowState {
    let Some(db) = db else {
        return LyricWindowState::default();
    };
    let saved = db.with(|c| get_setting(c, "lyric.window"));
    let mut state = match saved {
        Ok(Some(json)) => serde_json::from_str::<LyricWindowState>(&json).unwrap_or_default(),
        _ => LyricWindowState::default(),
    };
    if state.height == 140 {
        state.height = 180;
    }
    state
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
    WebviewWindowBuilder::new(
        app,
        LYRIC_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
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
    // 每个进程只启动一个置顶维护线程，避免反复隐藏/显示歌词时创建多个守护线程。
    static TOPMOST_GUARD_STARTED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    TOPMOST_GUARD_STARTED.get_or_init(|| start_topmost_guard(app.clone()));

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
    // 先显示，再重新应用置顶状态。Windows 在隐藏窗口 show 后可能重新计算 Z-order，
    // 若只在 show 前设置 TOPMOST，切换到其他应用时歌词窗口可能被普通窗口盖住。
    let _ = win.show();
    let _ = win.set_always_on_top(state.always_on_top);
    if state.always_on_top {
        if let Err(e) = attach_lyric_to_taskbar(&win) {
            log::warn!("[lyric-window] {e}");
        }
    }
    // 锁定即穿透：窗口恢复显示时按锁定态应用鼠标穿透
    let _ = win.set_ignore_cursor_events(state.locked);
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

/// 锁定 / 解锁（§10.7 Ctrl+Alt+K）。锁定 = 禁止拖动 + 鼠标穿透
///（锁定时整个窗口对鼠标透明，解锁从这里回不来，要走主窗口/托盘/快捷键）。
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

/// css 颜色串基本校验：#hex / rgb()/rgba()/hsl() / 具名色，长度封顶
fn valid_color(v: &str) -> bool {
    let v = v.trim();
    !v.is_empty()
        && v.len() <= 64
        && (v.starts_with('#') || v.contains('(') || v.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// 样式补丁（字段级合并；置顶即时应用到窗口；穿透跟随锁定，不再单独设）
pub fn set_style(app: &AppHandle, patch: Value) -> Result<LyricWindowState, String> {
    let state_guard = app.try_state::<AppState>();
    let db = state_guard.as_ref().and_then(|s| s.db.clone());
    let mut state = load_state(db.as_deref());
    let mut apply_always_on_top: Option<bool> = None;
    if let Some(obj) = patch.as_object() {
        if let Some(v) = obj.get("fontSize").and_then(Value::as_u64) {
            state.font_size = v.clamp(12, 96) as u32;
        }
        if let Some(v) = obj.get("fontWeight").and_then(Value::as_u64) {
            state.font_weight = v.clamp(300, 900) as u32;
        }
        if let Some(v) = obj.get("fontFamily").and_then(Value::as_str) {
            let name = v.trim();
            if name.chars().count() <= 64 {
                state.font_family = name.to_string();
            }
        }
        if let Some(v) = obj.get("letterSpacing").and_then(Value::as_f64) {
            state.letter_spacing = v.clamp(0.0, 20.0);
        }
        if let Some(v) = obj.get("lineGap").and_then(Value::as_f64) {
            state.line_gap = v.clamp(1.0, 2.5);
        }
        if let Some(v) = obj.get("inactiveColor").and_then(Value::as_str) {
            if valid_color(v) {
                state.inactive_color = v.trim().to_string();
            }
        }
        if let Some(v) = obj.get("strokeWidth").and_then(Value::as_f64) {
            state.stroke_width = v.clamp(0.5, 4.0);
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
        if let Some(v) = obj.get("alwaysOnTop").and_then(Value::as_bool) {
            state.always_on_top = v;
            apply_always_on_top = Some(v);
        }
        if let Some(v) = obj.get("backgroundMode").and_then(Value::as_str) {
            if matches!(v, "none" | "mask" | "solid") {
                state.background_mode = v.to_string();
            }
        }
        if let Some(v) = obj.get("backgroundColor").and_then(Value::as_str) {
            if valid_color(v) {
                state.background_color = v.trim().to_string();
            }
        }
        if let Some(v) = obj.get("borderRadius").and_then(Value::as_u64) {
            state.border_radius = v.clamp(0, 40) as u32;
        }
        if let Some(v) = obj.get("align").and_then(Value::as_str) {
            if matches!(v, "left" | "center" | "right") {
                state.align = v.to_string();
            }
        }
        if let Some(v) = obj.get("lineMode").and_then(Value::as_str) {
            if matches!(v, "single" | "two-lines" | "three-lines") {
                state.line_mode = v.to_string();
            }
        }
        if let Some(arr) = obj.get("gradient").and_then(Value::as_array) {
            let colors: Vec<String> = arr
                .iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect();
            if colors.len() == 2 && valid_color(&colors[0]) && valid_color(&colors[1]) {
                state.gradient = [colors[0].clone(), colors[1].clone()];
            }
        }
    }
    if let Some(win) = app.get_webview_window(LYRIC_WINDOW_LABEL) {
        if let Some(v) = apply_always_on_top {
            let _ = win.set_always_on_top(v);
            if v {
                if let Err(e) = attach_lyric_to_taskbar(&win) {
                    log::warn!("[lyric-window] {e}");
                }
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
    let width = width.clamp(480, 1280);
    let height = height.clamp(100, 600);
    state.x = x;
    state.y = y;
    state.width = width;
    state.height = height;
    // 立即把位置 / 尺寸应用到实时窗口：设置页滑块与歌词工具条调宽度也要即时生效，
    // 而不是只写存档等下次 show 才应用。尺寸变化时不要重复 set_position：
    // Windows/Tauri 在重设窗口位置与尺寸的组合操作中可能产生明显的横向跳动；
    // 位置本身没有变化时只调整尺寸即可保持左边缘稳定。
    if let Some(win) = app.get_webview_window(LYRIC_WINDOW_LABEL) {
        if let Ok(pos) = win.outer_position() {
            if pos.x != x || pos.y != y {
                let _ = win.set_position(PhysicalPosition::new(x, y));
            }
        }
        if let Ok(size) = win.outer_size() {
            if size.width != width || size.height != height {
                let _ = win.set_size(PhysicalSize::new(width, height));
            }
        }
    }
    save_state(db.as_deref(), &state);
    emit_state(app, &state);
    Ok(state)
}

/// 一键复位歌词位置：保留样式，把窗口放回主屏底部居中（拖丢时找回）
pub fn reset(app: &AppHandle) -> Result<LyricWindowState, String> {
    let state_guard = app.try_state::<AppState>();
    let db = state_guard.as_ref().and_then(|s| s.db.clone());
    let mut state = load_state(db.as_deref());
    if let Ok(Some(primary)) = app.primary_monitor() {
        let PhysicalSize { width, height } = *primary.size();
        state.x = ((width as i32) - state.width as i32) / 2;
        state.y = (height as i32) - state.height as i32 - 120;
    }
    if let Some(win) = app.get_webview_window(LYRIC_WINDOW_LABEL) {
        let _ = win.set_position(PhysicalPosition::new(state.x, state.y));
        let _ = win.set_size(PhysicalSize::new(state.width, state.height));
    }
    save_state(db.as_deref(), &state);
    emit_state(app, &state);
    Ok(state)
}

/// 从歌词窗口工具条打开主窗口的「设置 · 桌面歌词」页：
/// 唤起主窗口并发事件，由主窗口前端负责导航
pub fn open_main_settings(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    let _ = app.emit_to("main", "lyric-open-settings", ());
}

pub fn get_state(app: &AppHandle) -> LyricWindowState {
    let state_guard = app.try_state::<AppState>();
    let db = state_guard.as_ref().and_then(|s| s.db.clone());
    load_state(db.as_deref())
}

#[cfg(test)]
mod tests {
    use super::valid_color;

    #[test]
    fn valid_color_accepts_css_colors() {
        assert!(valid_color("#5b8cff"));
        assert!(valid_color("rgba(255,255,255,0.65)"));
        assert!(valid_color("rgb(0 0 0)"));
        assert!(valid_color("white"));
    }

    #[test]
    fn valid_color_rejects_garbage() {
        assert!(!valid_color(""));
        assert!(!valid_color("   "));
        // 超长串（可能是粘贴进来的非法负载）拒收
        assert!(!valid_color(&"x".repeat(65)));
    }
}
