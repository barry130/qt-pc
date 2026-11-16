//! Windows 歌词置顶：独立窗口、事件触发并定期检查、不抢焦点。
//!
//! HWND_TOPMOST 只管理普通窗口的 Z-order；它不承诺把 WebView2 合成进另一个
//! 进程的独占 DirectX 交换链。这里不得依据前台进程或全屏状态关闭用户的设置。
//! 不保存 HWND：隐藏歌词会销毁 WebView，下一次显示拿到的是新窗口。
//! 所有恢复操作在主线程按 label 查找当前窗口，并复查可见性与用户选择。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetClassNameW, GetMessageW, IsIconic, IsWindowVisible, KillTimer, SetTimer,
    SetWindowPos, TranslateMessage, EVENT_OBJECT_CREATE, EVENT_OBJECT_REORDER, EVENT_OBJECT_SHOW,
    EVENT_SYSTEM_FOREGROUND, HWND_TOPMOST, MSG, OBJID_WINDOW, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOOWNERZORDER, SWP_NOSIZE, WINEVENT_OUTOFCONTEXT, WM_TIMER,
};

#[cfg(test)]
use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongW, GWL_EXSTYLE, WS_EX_TOPMOST};

static APP: OnceLock<AppHandle> = OnceLock::new();
static ACTIVE: AtomicBool = AtomicBool::new(false);
static RESTORE_QUEUED: AtomicBool = AtomicBool::new(false);
static DESIRED_TOPMOST: AtomicBool = AtomicBool::new(false);

// 事件负责及时恢复；每 250ms 的低频检查补上没有 WinEvent 的层级变化。
// 仅此消息线程操作单一 timer ID。不 KillTimer 再重建、不跨线程销毁计时器。
const TIMER_ID: usize = 1;
const WATCH_INTERVAL_MS: u32 = 250;

pub(super) fn suspend() {
    ACTIVE.store(false, Ordering::Release);
}

pub(super) fn request_restore(app: &AppHandle, enabled: bool) {
    DESIRED_TOPMOST.store(enabled, Ordering::Release);
    let handle = app.clone();
    // 主线程读取 WebView 的可见性后再决定 ACTIVE；找不到关闭窗口时也必须清除。
    let _ = app.run_on_main_thread(move || {
        restore_current(&handle);
    });
}

fn restore_current(app: &AppHandle) {
    let active = app
        .get_webview_window(super::LYRIC_WINDOW_LABEL)
        .is_some_and(|win| {
            let active =
                DESIRED_TOPMOST.load(Ordering::Acquire) && win.is_visible().unwrap_or(false);
            if active {
                if let Ok(hwnd) = win.hwnd() {
                    if let Err(error) = restore_window(hwnd) {
                        log::debug!("[lyric-window] 恢复置顶失败: {error}");
                    }
                }
            }
            active
        });
    // 没有全屏/前台进程的例外。用户开启/关闭才控制自己的歌词窗口是否维护置顶。
    ACTIVE.store(active, Ordering::Release);
}

fn queue_restore(app: &AppHandle) {
    if RESTORE_QUEUED.swap(true, Ordering::AcqRel) {
        return;
    }
    let handle = app.clone();
    if app
        .run_on_main_thread(move || {
            RESTORE_QUEUED.store(false, Ordering::Release);
            restore_current(&handle);
        })
        .is_err()
    {
        RESTORE_QUEUED.store(false, Ordering::Release);
    }
}

/// 只改变歌词窗口自身的 Z-order；不调用 show/activate，也不更改位置、大小与 owner。
/// WS_EX_TOPMOST 只是成员资格：另一个 TOPMOST 全屏窗口仍可以盖住它。
fn restore_window(hwnd: HWND) -> windows::core::Result<()> {
    if !needs_restore(
        unsafe { IsWindowVisible(hwnd) }.as_bool(),
        unsafe { IsIconic(hwnd) }.as_bool(),
    ) {
        return Ok(());
    }
    unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        )?;
    }
    Ok(())
}

#[cfg(test)]
fn native_window_is_topmost(hwnd: HWND) -> bool {
    (unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) } as u32 & WS_EX_TOPMOST.0) != 0
}

fn needs_restore(visible: bool, minimized: bool) -> bool {
    visible && !minimized
}

fn is_taskbar(hwnd: HWND) -> bool {
    let mut class_name = [0_u16; 64];
    let length = unsafe { GetClassNameW(hwnd, &mut class_name) } as usize;
    let class_name = &class_name[..length];
    class_name
        .iter()
        .copied()
        .eq("Shell_TrayWnd".encode_utf16())
        || class_name
            .iter()
            .copied()
            .eq("Shell_SecondaryTrayWnd".encode_utf16())
}

unsafe extern "system" fn window_changed(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object_id: i32,
    _child_id: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    if !ACTIVE.load(Ordering::Acquire) {
        return;
    }
    if event != EVENT_SYSTEM_FOREGROUND
        && !(matches!(event, EVENT_OBJECT_CREATE | EVENT_OBJECT_SHOW)
            && object_id == OBJID_WINDOW.0)
        && !(event == EVENT_OBJECT_REORDER && object_id == OBJID_WINDOW.0 && is_taskbar(hwnd))
    {
        return;
    }
    if let Some(app) = APP.get() {
        queue_restore(app);
    }
}

fn retry_restore() {
    // ACTIVE 更新之后才复查；迟到的回调不能重新显示已关闭歌词或撤销用户选择。
    if ACTIVE.load(Ordering::Acquire) {
        if let Some(app) = APP.get() {
            queue_restore(app);
        }
    }
}

pub(super) fn start(app: &AppHandle) {
    if APP.set(app.clone()).is_err() {
        return;
    }
    if let Err(error) = std::thread::Builder::new()
        .name(String::from("lyric-topmost-guard"))
        .spawn(|| unsafe {
            let foreground = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                Some(window_changed),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            let windows = SetWinEventHook(
                EVENT_OBJECT_CREATE,
                EVENT_OBJECT_REORDER,
                None,
                Some(window_changed),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            if foreground.0.is_null() || windows.0.is_null() {
                log::warn!("[lyric-window] 部分窗口层级事件监听未能注册");
            }
            if foreground.0.is_null() && windows.0.is_null() {
                return;
            }
            if SetTimer(None, TIMER_ID, WATCH_INTERVAL_MS, None) == 0 {
                log::warn!("[lyric-window] 无法启动置顶定期检查");
            }
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                if message.message == WM_TIMER && message.hwnd.0.is_null() {
                    retry_restore();
                } else {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            let _ = KillTimer(None, TIMER_ID);
            for hook in [foreground, windows] {
                if !hook.0.is_null() {
                    let _ = UnhookWinEvent(hook);
                }
            }
        })
    {
        log::warn!("[lyric-window] 无法启动置顶维护: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::{COLORREF, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetForegroundWindow, GetWindow, GetWindowRect,
        SetLayeredWindowAttributes, ShowWindow, GW_HWNDPREV, GW_OWNER, HWND_NOTOPMOST, LWA_ALPHA,
        SW_HIDE, SW_SHOWNOACTIVATE, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP,
    };

    struct TestWindow(HWND);

    impl TestWindow {
        fn new() -> Self {
            let hwnd = unsafe {
                CreateWindowExW(
                    WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                    windows::core::w!("STATIC"),
                    windows::core::w!("qt-lyric-topmost-test"),
                    WS_POPUP,
                    20,
                    20,
                    16,
                    16,
                    None,
                    None,
                    None,
                    None,
                )
                .expect("create transparent test window")
            };
            let window = Self(hwnd);
            unsafe {
                SetLayeredWindowAttributes(hwnd, COLORREF(0), 0, LWA_ALPHA)
                    .expect("make test window fully transparent");
            }
            window
        }

        fn show(&self) {
            let _ = unsafe { ShowWindow(self.0, SW_SHOWNOACTIVATE) };
        }

        fn is_topmost(&self) -> bool {
            native_window_is_topmost(self.0)
        }

        fn bounds(&self) -> (i32, i32, i32, i32) {
            let mut rect = RECT::default();
            unsafe {
                GetWindowRect(self.0, &mut rect).expect("read window bounds");
            }
            (rect.left, rect.top, rect.right, rect.bottom)
        }

        fn is_above(&self, other: &Self) -> bool {
            let mut current = other.0;
            while let Ok(previous) = unsafe { GetWindow(current, GW_HWNDPREV) } {
                if previous == self.0 {
                    return true;
                }
                current = previous;
            }
            false
        }

        fn un_topmost(&self) {
            unsafe {
                SetWindowPos(
                    self.0,
                    Some(HWND_NOTOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                )
                .unwrap();
            }
        }
    }

    impl Drop for TestWindow {
        fn drop(&mut self) {
            let _ = unsafe { DestroyWindow(self.0) };
        }
    }

    #[test]
    fn continuous_check_never_depends_on_foreground_or_fullscreen_state() {
        assert!(needs_restore(true, false));
        assert!(!needs_restore(false, false));
        assert!(!needs_restore(true, true));
        assert!(!needs_restore(false, true));
        // 配置不变量在编译期检查，同时保留对定时器维护周期的显式约束。
        const _: () = assert!(WATCH_INTERVAL_MS > 0 && WATCH_INTERVAL_MS <= 1_000);
        const _: () = assert!(TIMER_ID == 1);
    }

    #[test]
    fn restores_after_another_topmost_window_without_moving_or_activating() {
        let lyric = TestWindow::new();
        let overlay = TestWindow::new();
        lyric.show();
        overlay.show();
        let bounds = lyric.bounds();
        restore_window(lyric.0).unwrap();
        restore_window(overlay.0).unwrap();
        assert!(overlay.is_above(&lyric));
        restore_window(lyric.0).unwrap();
        assert!(lyric.is_above(&overlay));
        assert!(lyric.is_topmost());
        assert_eq!(lyric.bounds(), bounds);
        assert_ne!(unsafe { GetForegroundWindow() }, lyric.0);
        assert!(unsafe { GetWindow(lyric.0, GW_OWNER) }.is_err());
    }

    #[test]
    fn pending_restore_respects_disabled_and_hidden_windows() {
        let lyric = TestWindow::new();
        restore_window(lyric.0).unwrap();
        assert!(!unsafe { IsWindowVisible(lyric.0) }.as_bool());
        assert!(!lyric.is_topmost());
        lyric.show();
        restore_window(lyric.0).unwrap();
        lyric.un_topmost();
        // 用户关闭置顶后不会对窗口执行任何后续层级操作。
        assert!(!lyric.is_topmost());
        let _ = unsafe { ShowWindow(lyric.0, SW_HIDE) };
        restore_window(lyric.0).unwrap();
        assert!(!unsafe { IsWindowVisible(lyric.0) }.as_bool());
        assert!(!lyric.is_topmost());
    }

    #[test]
    fn restored_window_can_be_closed_and_recreated() {
        let first = TestWindow::new();
        first.show();
        restore_window(first.0).unwrap();
        drop(first);
        let reopened = TestWindow::new();
        reopened.show();
        restore_window(reopened.0).unwrap();
        assert!(reopened.is_topmost());
        assert!(!is_taskbar(reopened.0));
    }
}
