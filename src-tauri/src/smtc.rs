//! Windows 系统媒体控制（SMTC）与硬件媒体键。
//!
//! 把当前曲目 / 播放状态投到系统媒体面板（Win+G、锁屏、音量浮层），
//! 并接收键盘媒体键、蓝牙耳机按键、系统面板的播放 / 暂停 / 上下曲。
//!
//! 线程模型：`MediaControls` 持有 COM 对象、非 Send，只能在创建它的线程使用，
//! 因此这里开一条专属线程持有它，主链路通过无界 channel 投递状态更新；
//! 事件回调只做一件事 —— 往音频引擎发命令。
//!
//! 非 Windows 平台整体降级为空实现（`init` 返回 None，调用方无分支）。

use std::time::Duration;

/// 推送给系统媒体面板的指令。
#[derive(Debug, Clone)]
pub enum SmtcCommand {
    Metadata {
        title: String,
        artist: String,
        album: String,
        cover: Option<String>,
    },
    Playback {
        playing: bool,
        paused: bool,
        position_ms: u64,
    },
}

/// 状态投递句柄（可克隆，放进引擎线程随时使用）。
#[derive(Clone)]
pub struct SmtcHandle {
    tx: tokio::sync::mpsc::UnboundedSender<SmtcCommand>,
}

impl SmtcHandle {
    pub fn send(&self, cmd: SmtcCommand) {
        // 系统面板线程已退出时静默丢弃：媒体控制属于旁路能力，绝不影响播放
        let _ = self.tx.send(cmd);
    }
}

/// 由播放快照推导一次系统媒体面板更新（元数据 + 播放状态）。
pub fn sync(handle: &Option<SmtcHandle>, st: &crate::audio::state::PlaybackStateSnapshot) {
    let Some(h) = handle else {
        return;
    };
    use crate::audio::state::PlaybackStatus as S;

    if let Some(t) = &st.track {
        h.send(SmtcCommand::Metadata {
            title: t.title.clone(),
            artist: t.singer.clone(),
            album: t.album.clone(),
            // 只有 http(s) 封面系统面板才取得到；qtres:// 是自定义协议，交给它只会失败
            cover: if t.pic_url.starts_with("http") {
                Some(t.pic_url.clone())
            } else {
                None
            },
        });
    }

    let (playing, paused) = match st.status {
        S::Playing | S::Buffering | S::Loading => (true, false),
        S::Paused => (false, true),
        _ => (false, false),
    };
    h.send(SmtcCommand::Playback {
        playing,
        paused,
        position_ms: st.position_ms,
    });
}

/// 初始化系统媒体控制。返回 None 表示不可用（非 Windows / 初始化失败），
/// 调用方无需处理，功能整体静默降级。
#[cfg(target_os = "windows")]
pub fn init(
    hwnd: isize,
    app: tauri::AppHandle,
    engine: crate::audio::engine::AudioEngine,
) -> Option<SmtcHandle> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<SmtcCommand>();
    let spawned = std::thread::Builder::new()
        .name("smtc".into())
        .spawn(move || {
            // WinRT 激活工厂要求线程先初始化 COM（MTA 即可）
            unsafe {
                co_initialize_mta();
            }

            let mut controls = match souvlaki::MediaControls::new(souvlaki::PlatformConfig {
                display_name: "轻听",
                dbus_name: "com.qt.lightlisten",
                hwnd: Some(hwnd as *mut std::ffi::c_void),
            }) {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("[smtc] 初始化失败，系统媒体面板不可用: {e}");
                    return;
                }
            };

            let engine_for_events = engine.clone();
            let app_for_events = app.clone();
            if let Err(e) = controls.attach(move |event| {
                handle_event(&engine_for_events, &app_for_events, event);
            }) {
                log::warn!("[smtc] 注册媒体键回调失败: {e}");
                return;
            }
            log::info!("[smtc] 系统媒体控制已启用");

            let mut last_meta: Option<(String, String, String)> = None;
            while let Some(cmd) = rx.blocking_recv() {
                apply(&mut controls, cmd, &mut last_meta);
            }
        });

    match spawned {
        Ok(_) => Some(SmtcHandle { tx }),
        Err(e) => {
            log::warn!("[smtc] 线程创建失败: {e}");
            None
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn init(
    _hwnd: isize,
    _app: tauri::AppHandle,
    _engine: crate::audio::engine::AudioEngine,
) -> Option<SmtcHandle> {
    None
}

#[cfg(target_os = "windows")]
fn apply(
    controls: &mut souvlaki::MediaControls,
    cmd: SmtcCommand,
    last_meta: &mut Option<(String, String, String)>,
) {
    use souvlaki::{MediaMetadata, MediaPlayback, MediaPosition};

    match cmd {
        SmtcCommand::Metadata {
            title,
            artist,
            album,
            cover,
        } => {
            // 元数据没变就不重复下发，省掉系统面板的无谓刷新
            let key = (title.clone(), artist.clone(), album.clone());
            if last_meta.as_ref() == Some(&key) {
                return;
            }
            *last_meta = Some(key);
            if let Err(e) = controls.set_metadata(MediaMetadata {
                title: Some(&title),
                artist: Some(&artist),
                album: Some(&album),
                cover_url: cover.as_deref(),
                duration: None,
            }) {
                log::debug!("[smtc] 更新元数据失败: {e}");
            }
        }
        SmtcCommand::Playback {
            playing,
            paused,
            position_ms,
        } => {
            let progress = Some(MediaPosition(Duration::from_millis(position_ms)));
            let playback = if playing {
                MediaPlayback::Playing { progress }
            } else if paused {
                MediaPlayback::Paused { progress }
            } else {
                MediaPlayback::Stopped
            };
            if let Err(e) = controls.set_playback(playback) {
                log::debug!("[smtc] 更新播放状态失败: {e}");
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn handle_event(
    engine: &crate::audio::engine::AudioEngine,
    app: &tauri::AppHandle,
    event: souvlaki::MediaControlEvent,
) {
    use crate::audio::engine::AudioCmd;
    use crate::audio::state::PlaybackStatus;
    use souvlaki::MediaControlEvent as E;

    /// 快进 / 快退步长（未指定秒数时）
    const STEP_MS: u64 = 10_000;

    match event {
        E::Play => engine.send(AudioCmd::Play),
        E::Pause => engine.send(AudioCmd::Pause),
        E::Toggle => {
            let playing = engine.snapshot().status == PlaybackStatus::Playing;
            engine.send(if playing { AudioCmd::Pause } else { AudioCmd::Play });
        }
        E::Next => engine.send(AudioCmd::Next),
        E::Previous => engine.send(AudioCmd::Previous),
        E::Stop => engine.send(AudioCmd::Stop),
        E::Seek(dir) => seek_by(engine, dir, STEP_MS),
        E::SeekBy(dir, d) => seek_by(engine, dir, d.as_millis() as u64),
        E::SetPosition(pos) => engine.send(AudioCmd::Seek(pos.0.as_millis() as u64)),
        E::Raise => {
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
        // 音量 / 打开链接 / 退出系统面板不属于播放器职责，忽略
        _ => {}
    }
}

/// 相对当前位置快进 / 快退，结果夹在 0..时长之间。
#[cfg(target_os = "windows")]
fn seek_by(
    engine: &crate::audio::engine::AudioEngine,
    dir: souvlaki::SeekDirection,
    delta_ms: u64,
) {
    use crate::audio::engine::AudioCmd;
    use souvlaki::SeekDirection;

    let snap = engine.snapshot();
    let base = snap.position_ms as i128;
    let delta = delta_ms as i128;
    let target = match dir {
        SeekDirection::Forward => base + delta,
        SeekDirection::Backward => base - delta,
    };
    let max = if snap.duration_ms > 0 {
        snap.duration_ms as i128
    } else {
        i128::MAX
    };
    engine.send(AudioCmd::Seek(target.clamp(0, max) as u64));
}

/// COM 初始化（MTA）。失败（已是别的模式）不影响后续调用。
#[cfg(target_os = "windows")]
unsafe fn co_initialize_mta() {
    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(reserved: *const std::ffi::c_void, co_init: u32) -> i32;
    }
    // COINIT_MULTITHREADED = 0x0；返回值可能是 S_FALSE / RPC_E_CHANGED_MODE，均无需处理
    let _ = CoInitializeEx(std::ptr::null(), 0);
}
