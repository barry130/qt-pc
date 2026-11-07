//! Windows 歌词置顶：独立窗口、按事件恢复、不抢焦点。
//!
//! 不保存 HWND：隐藏歌词会销毁 WebView，下一次显示拿到的是新窗口。
//! 所有恢复操作都在主线程执行时按 label 查找当前窗口，并重新检查置顶开关。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetClassNameW, GetMessageW, IsIconic, IsWindowVisible, KillTimer, SetTimer,
    SetWindowPos, TranslateMessage, EVENT_OBJECT_REORDER, EVENT_SYSTEM_FOREGROUND, HWND_TOPMOST,
    MSG, OBJID_WINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE,
    WINEVENT_OUTOFCONTEXT, WM_TIMER,
};

static APP: OnceLock<AppHandle> = OnceLock::new();
static ACTIVE: AtomicBool = AtomicBool::new(false);
static RESTORE_QUEUED: AtomicBool = AtomicBool::new(false);

// 只在前台/任务栏变化后重试约一秒；不用常驻轮询或每次事件新建线程。
const RETRY_INTERVAL_MS: u32 = 80;
const RETRY_COUNT: u8 = 12;
thread_local! {
    static RETRY: std::cell::Cell<(usize, u8)> = const { std::cell::Cell::new((0, 0)) };
}

pub(super) fn suspend() {
    ACTIVE.store(false, Ordering::Release);
}

pub(super) fn request_restore(app: &AppHandle) {
    // 显示/样式命令之后必须单独排队，不能被更早的事件恢复合并掉。
    // 否则旧回调在 show/启用置顶前执行，ACTIVE 会一直停在 false。
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || restore_current(&handle));
}

fn restore_current(app: &AppHandle) {
    let Some(win) = app.get_webview_window(super::LYRIC_WINDOW_LABEL) else {
        suspend();
        return;
    };
    let enabled = win.is_always_on_top().unwrap_or(false);
    let visible = win.is_visible().unwrap_or(false);
    ACTIVE.store(enabled && visible, Ordering::Release);
    if let Ok(hwnd) = win.hwnd() {
        if let Err(error) = restore_window(hwnd, enabled) {
            log::debug!("[lyric-window] 恢复置顶失败: {error}");
        }
    }
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

/// 不使用 SWP_SHOWWINDOW，迟到的事件不能重新显示用户已经关闭/隐藏的歌词。
fn restore_window(hwnd: HWND, enabled: bool) -> windows::core::Result<()> {
    if enabled && unsafe { IsWindowVisible(hwnd) }.as_bool() && !unsafe { IsIconic(hwnd) }.as_bool()
    {
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
    }
    Ok(())
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
    // 不响应歌词自己的 reorder，否则 SetWindowPos 会不断触发自身。
    if event != EVENT_SYSTEM_FOREGROUND
        && !(event == EVENT_OBJECT_REORDER && object_id == OBJID_WINDOW.0 && is_taskbar(hwnd))
    {
        return;
    }
    if let Some(app) = APP.get() {
        queue_restore(app);
        RETRY.with(|retry| {
            let (timer, _) = retry.get();
            let timer = if timer == 0 {
                unsafe { SetTimer(None, 0, RETRY_INTERVAL_MS, None) }
            } else {
                timer
            };
            retry.set((timer, RETRY_COUNT));
        });
    }
}

fn retry_restore(timer_id: usize) {
    RETRY.with(|retry| {
        let (timer, remaining) = retry.get();
        if timer == 0 || timer != timer_id {
            return;
        }
        if !ACTIVE.load(Ordering::Acquire) || remaining <= 1 {
            let _ = unsafe { KillTimer(None, timer) };
            retry.set((0, 0));
        } else {
            retry.set((timer, remaining - 1));
        }
        if ACTIVE.load(Ordering::Acquire) {
            if let Some(app) = APP.get() {
                queue_restore(app);
            }
        }
    });
}

/// 首次窗口成功创建后启动；后续重建只需 request_restore，无旧句柄残留。
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
            let taskbar = SetWinEventHook(
                EVENT_OBJECT_REORDER,
                EVENT_OBJECT_REORDER,
                None,
                Some(window_changed),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            if foreground.0.is_null() || taskbar.0.is_null() {
                log::warn!("[lyric-window] 部分窗口层级事件监听未能注册");
            }
            if foreground.0.is_null() && taskbar.0.is_null() {
                return;
            }
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                if message.message == WM_TIMER && message.hwnd.0.is_null() {
                    retry_restore(message.wParam.0);
                } else {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            RETRY.with(|retry| {
                let (timer, _) = retry.replace((0, 0));
                if timer != 0 {
                    let _ = KillTimer(None, timer);
                }
            });
            for hook in [foreground, taskbar] {
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
        CreateWindowExW, DestroyWindow, GetForegroundWindow, GetWindow, GetWindowLongW,
        GetWindowRect, SetLayeredWindowAttributes, ShowWindow, GWL_EXSTYLE, GW_HWNDPREV, GW_OWNER,
        HWND_NOTOPMOST, LWA_ALPHA, SW_HIDE, SW_SHOWNOACTIVATE, WS_EX_LAYERED, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    };

    // 完全透明且不激活的独立窗口，只验证 Win32 行为，不操作真实歌词/任务栏。
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
            unsafe { GetWindowLongW(self.0, GWL_EXSTYLE) as u32 & WS_EX_TOPMOST.0 != 0 }
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
    }

    impl Drop for TestWindow {
        fn drop(&mut self) {
            let _ = unsafe { DestroyWindow(self.0) };
        }
    }

    #[test]
    fn restores_after_another_topmost_window_without_moving_or_activating() {
        let lyric = TestWindow::new();
        let overlay = TestWindow::new();
        lyric.show();
        overlay.show();
        let bounds = lyric.bounds();
        restore_window(lyric.0, true).unwrap();
        restore_window(overlay.0, true).unwrap();
        assert!(overlay.is_above(&lyric));

        restore_window(lyric.0, true).unwrap();
        assert!(lyric.is_above(&overlay));
        assert!(lyric.is_topmost());
        assert_eq!(lyric.bounds(), bounds);
        assert_ne!(unsafe { GetForegroundWindow() }, lyric.0);
        assert!(unsafe { GetWindow(lyric.0, GW_OWNER) }.is_err());
    }

    #[test]
    fn pending_restore_respects_disabled_and_hidden_windows() {
        let lyric = TestWindow::new();
        // A callback arriving after hide must not show the window or promote it.
        restore_window(lyric.0, true).unwrap();
        assert!(!unsafe { IsWindowVisible(lyric.0) }.as_bool());
        assert!(!lyric.is_topmost());

        lyric.show();
        restore_window(lyric.0, true).unwrap();
        unsafe {
            SetWindowPos(
                lyric.0,
                Some(HWND_NOTOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
            .unwrap();
        }
        restore_window(lyric.0, false).unwrap();
        assert!(!lyric.is_topmost());
        let _ = unsafe { ShowWindow(lyric.0, SW_HIDE) };
        restore_window(lyric.0, true).unwrap();
        assert!(!unsafe { IsWindowVisible(lyric.0) }.as_bool());
        assert!(!lyric.is_topmost());
    }

    #[test]
    fn restored_window_can_be_closed_and_recreated() {
        let first = TestWindow::new();
        first.show();
        restore_window(first.0, true).unwrap();
        drop(first);

        let reopened = TestWindow::new();
        reopened.show();
        restore_window(reopened.0, true).unwrap();
        assert!(reopened.is_topmost());
        assert!(!is_taskbar(reopened.0));
    }
}
