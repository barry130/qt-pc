//! 系统托盘（DESIGN §14.1）：
//! 菜单 = 播放/暂停、上一首、下一首、显示桌面歌词、显示主窗口、退出。
//! 关闭主窗口默认最小化到托盘（§4 关闭行为），退出只能走托盘菜单。

use tauri::AppHandle;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, Wry};

use crate::lyric_window;
use crate::media::{dispatch_media_action, MediaAction};

/// 托盘菜单项 ID
const ID_PLAY_PAUSE: &str = "tray-play-pause";
const ID_PREVIOUS: &str = "tray-previous";
const ID_NEXT: &str = "tray-next";
const ID_DESKTOP_LYRIC: &str = "tray-desktop-lyric";
const ID_LOCK_LYRIC: &str = "tray-lock-lyric";
const ID_SHOW_MAIN: &str = "tray-show-main";
const ID_QUIT: &str = "tray-quit";

/// 桌面歌词是「勾选」菜单项，把它存进 app state：
/// 歌词也能从主窗口按钮或快捷键开关，托盘必须在弹出前按真实状态刷新勾选。
struct DesktopLyricItem(CheckMenuItem<Wry>);

/// 构建托盘菜单（§14.1 的固定结构 + §10.7 锁定/解锁歌词）。
/// 返回菜单本身和桌面歌词勾选框（后者要存进 app state 以便随时刷新）。
fn build_menu(app: &AppHandle) -> tauri::Result<(Menu<Wry>, CheckMenuItem<Wry>)> {
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
    // §10.7：锁定 = 鼠标穿透，解锁只能托盘/快捷键/主窗口——托盘是固定解锁入口。
    // 菜单只构建一次，文案固定，点击时按当前状态取反。
    let lock_lyric =
        MenuItem::with_id(app, ID_LOCK_LYRIC, "锁定 / 解锁桌面歌词", true, None::<&str>)?;
    let show_main = MenuItem::with_id(app, ID_SHOW_MAIN, "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "退出", true, None::<&str>)?;
    // MenuItem 与 CheckMenuItem 是不同类型，统一成 trait object 才能放进同一个菜单
    let items: [&dyn IsMenuItem<Wry>; 7] = [
        &play_pause,
        &previous,
        &next,
        &desktop_lyric,
        &lock_lyric,
        &show_main,
        &quit,
    ];
    let menu = Menu::with_items(app, &items)?;
    Ok((menu, desktop_lyric))
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

/// 显示并聚焦主窗口（托盘「显示主窗口」）
fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// 注册托盘。失败只记日志（个别环境无托栏），不影响主流程。
pub fn create_tray(app: &AppHandle) {
    let (menu, desktop_lyric) = match build_menu(app) {
        Ok(v) => v,
        Err(e) => {
            log::error!("[tray] 菜单构建失败: {e}");
            return;
        }
    };
    // 存进 state：菜单闭包拿不到这个变量，且歌词也能从主窗口/快捷键开关
    app.manage(DesktopLyricItem(desktop_lyric));

    let builder = TrayIconBuilder::with_id("lightlisten-tray")
        .tooltip("轻听")
        .menu(&menu)
        .show_menu_on_left_click(false)
        // 菜单弹出前刷新勾选：歌词状态可能已经被别处改过
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::Click { .. }) {
                sync_lyric_checked(tray.app_handle());
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
            }
            ID_SHOW_MAIN => show_main_window(app),
            ID_QUIT => {
                log::info!("[tray] 退出");
                app.exit(0);
            }
            _ => {}
        });
    let result = match app.default_window_icon() {
        Some(icon) => builder.icon(icon.clone()).build(app),
        None => builder.build(app),
    };
    if let Err(e) = result {
        log::error!("[tray] 托盘创建失败: {e}");
    }
}
