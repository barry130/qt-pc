//! 系统托盘（DESIGN §14.1）：
//! 菜单 = 播放/暂停、上一首、下一首、显示桌面歌词、显示主窗口、退出。
//! 关闭主窗口默认最小化到托盘（§4 关闭行为），退出只能走托盘菜单。

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;
use tauri::{Emitter, Manager, Wry};

use crate::lyric_window;
use crate::media::{dispatch_media_action, MediaAction};

/// 托盘菜单项 ID
const ID_PLAY_PAUSE: &str = "tray-play-pause";
const ID_PREVIOUS: &str = "tray-previous";
const ID_NEXT: &str = "tray-next";
const ID_DESKTOP_LYRIC: &str = "tray-desktop-lyric";
const ID_LOCK_LYRIC: &str = "tray-lock-lyric";
const ID_MINI: &str = "tray-mini";
const ID_SHOW_MAIN: &str = "tray-show-main";
const ID_QUIT: &str = "tray-quit";

/// 桌面歌词是「勾选」菜单项，把它存进 app state：
/// 歌词也能从主窗口按钮或快捷键开关，托盘必须在弹出前按真实状态刷新勾选。
struct DesktopLyricItem(CheckMenuItem<Wry>);
/// 「锁定歌词」同样是勾选项：锁定状态在工具条/设置页/快捷键都可能被改
struct LockLyricItem(CheckMenuItem<Wry>);

/// 构建托盘菜单（§14.1 的固定结构 + §10.7 锁定/解锁歌词）。
/// 返回菜单本身和两个勾选框（要存进 app state 以便随时刷新）。
fn build_menu(
    app: &AppHandle,
) -> tauri::Result<(Menu<Wry>, CheckMenuItem<Wry>, CheckMenuItem<Wry>)> {
    let play_pause = MenuItem::with_id(app, ID_PLAY_PAUSE, "播放 / 暂停", true, None::<&str>)?;
    let previous = MenuItem::with_id(app, ID_PREVIOUS, "上一首", true, None::<&str>)?;
    let next = MenuItem::with_id(app, ID_NEXT, "下一首", true, None::<&str>)?;
    // 勾选框：初始状态取当前歌词窗口是否可见
    let desktop_lyric = CheckMenuItem::with_id(
        app,
        ID_DESKTOP_LYRIC,
        "显示桌面歌词",
        true,
        lyric_window::get_state(app).visible,
        None::<&str>,
    )?;
    // §10.7：锁定 = 禁止拖动 + 鼠标穿透（锁定时窗口对鼠标透明，解锁只能走这里/主窗口/快捷键）。
    // 菜单只构建一次，点击时按当前状态取反并回写勾选。
    let lock_lyric = CheckMenuItem::with_id(
        app,
        ID_LOCK_LYRIC,
        "锁定桌面歌词",
        true,
        lyric_window::get_state(app).locked,
        None::<&str>,
    )?;
    let show_main = MenuItem::with_id(app, ID_SHOW_MAIN, "显示主窗口", true, None::<&str>)?;
    // 迷你模式（§3.21.7.2）：托盘是主窗收起时唯一的总入口，这里必须留着——
    // 用迷你窗期间主窗是隐藏状态，没有托盘菜单就只能在迷你窗里点回主窗。
    let mini = MenuItem::with_id(app, ID_MINI, "迷你模式", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "退出", true, None::<&str>)?;
    // MenuItem 与 CheckMenuItem 是不同类型，统一成 trait object 才能放进同一个菜单
    let items: [&dyn IsMenuItem<Wry>; 8] = [
        &play_pause,
        &previous,
        &next,
        &desktop_lyric,
        &lock_lyric,
        &show_main,
        &mini,
        &quit,
    ];
    let menu = Menu::with_items(app, &items)?;
    Ok((menu, desktop_lyric, lock_lyric))
}

/// 按真实状态刷新「显示桌面歌词」的勾选
fn sync_lyric_checked(app: &AppHandle) {
    let Some(item) = app.try_state::<DesktopLyricItem>() else {
        return;
    };
    let visible = lyric_window::get_state(app).visible;
    if let Err(e) = item.0.set_checked(visible) {
        log::warn!("[tray] 刷新歌词勾选失败: {e}");
    }
}

/// 按真实状态刷新「锁定桌面歌词」的勾选
fn sync_lock_checked(app: &AppHandle) {
    let Some(item) = app.try_state::<LockLyricItem>() else {
        return;
    };
    let locked = lyric_window::get_state(app).locked;
    if let Err(e) = item.0.set_checked(locked) {
        log::warn!("[tray] 刷新锁定勾选失败: {e}");
    }
}

/// 显示并聚焦主窗口（托盘左键单击 / 菜单「显示主窗口」）
fn show_main_window(app: &AppHandle) {
    if app.get_webview_window(crate::mini_window::MINI_WINDOW_LABEL).is_some() {
        if let Err(e) = crate::mini_window::hide(app) {
            log::warn!("[tray] 返回主窗口失败: {e}");
        }
        return;
    }
    if let Some(win) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) {
        // 只有「本来不可见」才算一轮新的 show：左键可以连点，若每次都发事件，
        // 前端停留计时会被反复重置，统计出的时长永远接近 0。
        let was_visible = win.is_visible().unwrap_or(true);
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        if !was_visible {
            // 统计：窗口重新可见 → 前端记一轮新的 show（开始停留计时）
            let _ = app.emit("stat_window_shown", ());
        }
    }
}

/// 注册托盘。
/// 返回值 = 托盘是否可用：失败（Linux GNOME 无托盘扩展、无 StatusNotifier
/// 宿主、菜单/图标构建失败等）时返回 false，调用方（lib.rs）需把主窗口的
/// 关闭语义从「收进托盘」改成「直接退出」——没有托盘时藏窗口等于杀不掉。
/// Windows/macOS 下托盘始终可用，实际走不到 false 分支。
pub fn create_tray(app: &AppHandle) -> bool {
    let (menu, desktop_lyric, lock_lyric) = match build_menu(app) {
        Ok(v) => v,
        Err(e) => {
            log::error!("[tray] 菜单构建失败: {e}");
            return false;
        }
    };
    // 存进 state：菜单闭包拿不到这个变量，且歌词也能从主窗口/快捷键开关
    app.manage(DesktopLyricItem(desktop_lyric));
    app.manage(LockLyricItem(lock_lyric));

    let builder = TrayIconBuilder::with_id("quietmusic-tray")
        .tooltip("轻听")
        .menu(&menu)
        .show_menu_on_left_click(false)
        // 菜单弹出前刷新勾选：两个状态都可能已经被别处改过。
        // 左键单击 = 显示主窗口（Windows 用户直觉：点托盘图标就把窗口叫回来），
        // 菜单只在右键弹（show_menu_on_left_click(false)）；双击是两次单击的
        // 自然叠加，不额外处理。只在按键抬起时响应，避免按下/抬起各触发一次。
        .on_tray_icon_event(|tray, event| {
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    log::debug!("[tray] 左键单击 → 显示主窗口");
                    show_main_window(tray.app_handle());
                }
                TrayIconEvent::Click { .. } => {
                    sync_lyric_checked(tray.app_handle());
                    sync_lock_checked(tray.app_handle());
                }
                _ => {}
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            ID_PLAY_PAUSE => dispatch_media_action(app, MediaAction::PlayPause),
            ID_PREVIOUS => dispatch_media_action(app, MediaAction::Previous),
            ID_NEXT => dispatch_media_action(app, MediaAction::Next),
            ID_DESKTOP_LYRIC => {
                lyric_window::toggle(app);
                sync_lyric_checked(app);
            }
            ID_LOCK_LYRIC => {
                let locked = lyric_window::get_state(app).locked;
                if let Err(e) = lyric_window::set_locked(app, !locked) {
                    log::error!("[tray] 锁定切换失败: {e}");
                }
                sync_lock_checked(app);
            }
            ID_SHOW_MAIN => show_main_window(app),
            ID_MINI => {
                // 与播放条按钮同一条命令：进迷你收主窗、退迷你唤回主窗
                if let Err(e) = crate::mini_window::toggle(app) {
                    log::error!("[tray] 迷你模式切换失败: {e}");
                }
            }
            ID_QUIT => {
                log::info!("[tray] 退出");
                // 统计：先给前端一个 hide 事件的机会（结算停留时长 + 冲队列，
                // 冲不出去的队列前端会持久化、下次启动补报），再延时退出
                let _ = app.emit("stat_window_hidden", ());
                let handle = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(800));
                    handle.exit(0);
                });
            }
            _ => {}
        });
    let result = match app.default_window_icon() {
        Some(icon) => builder.icon(icon.clone()).build(app),
        None => builder.build(app),
    };
    match result {
        Ok(_) => true,
        Err(e) => {
            log::error!("[tray] 托盘创建失败: {e}");
            false
        }
    }
}
