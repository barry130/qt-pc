//! 媒体控制动作（DESIGN §14）：托盘菜单、全局快捷键、SMTC 共用同一套动作分发。
//! 动作直接作用于音频引擎，不经过前端（主窗口隐藏时依然可用）。

use tauri::AppHandle;
use tauri::Manager;

use crate::audio::engine::AudioCmd;
use crate::audio::state::PlaybackStatus;
use crate::AppState;

/// 播放控制动作集合（§14.1 托盘 / §14.2 快捷键的交集）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaAction {
    PlayPause,
    Previous,
    Next,
    VolumeUp,
    VolumeDown,
    Mute,
    /// 显示 / 隐藏桌面歌词窗口（窗口本体在桌面歌词单元落地，先广播事件）
    DesktopLyric,
    /// 锁定 / 解锁桌面歌词（锁定后不能拖动、工具条隐藏）
    LockLyric,
}

impl MediaAction {
    /// settings 表 "shortcuts" 键里的动作 ID
    pub fn id(self) -> &'static str {
        match self {
            MediaAction::PlayPause => "play_pause",
            MediaAction::Previous => "previous",
            MediaAction::Next => "next",
            MediaAction::VolumeUp => "volume_up",
            MediaAction::VolumeDown => "volume_down",
            MediaAction::Mute => "mute",
            MediaAction::DesktopLyric => "desktop_lyric",
            MediaAction::LockLyric => "lock_lyric",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "play_pause" => Some(MediaAction::PlayPause),
            "previous" => Some(MediaAction::Previous),
            "next" => Some(MediaAction::Next),
            "volume_up" => Some(MediaAction::VolumeUp),
            "volume_down" => Some(MediaAction::VolumeDown),
            "mute" => Some(MediaAction::Mute),
            "desktop_lyric" => Some(MediaAction::DesktopLyric),
            "lock_lyric" => Some(MediaAction::LockLyric),
            _ => None,
        }
    }
}

/// 播放 / 暂停切换：按引擎当前状态取反
fn toggle_play(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let playing = state.engine.snapshot().status == PlaybackStatus::Playing;
    state.engine.send(if playing {
        AudioCmd::Pause
    } else {
        AudioCmd::Play
    });
}

/// 音量步进（0.1），夹在 0..=1
fn step_volume(app: &AppHandle, delta: f32) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let next = (state.engine.snapshot().volume + delta).clamp(0.0, 1.0);
    state.engine.send(AudioCmd::SetVolume(next));
}

/// 托盘 / 快捷键 / SMTC 统一入口
pub fn dispatch_media_action(app: &AppHandle, action: MediaAction) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    match action {
        MediaAction::PlayPause => toggle_play(app),
        MediaAction::Previous => state.engine.send(AudioCmd::Previous),
        MediaAction::Next => state.engine.send(AudioCmd::Next),
        MediaAction::VolumeUp => step_volume(app, 0.1),
        MediaAction::VolumeDown => step_volume(app, -0.1),
        MediaAction::Mute => {
            let muted = state.engine.snapshot().muted;
            state.engine.send(AudioCmd::SetMuted(!muted));
        }
        MediaAction::DesktopLyric => {
            // 直接由 Rust 切换窗口（主窗口隐藏/最小化时依然可用，§10.7）
            crate::lyric_window::toggle(app);
        }
        MediaAction::LockLyric => {
            // 锁定 = 禁止拖动 + 隐藏工具条；锁定后这是最可靠的解锁入口之一
            // （另外两个是托盘勾选与设置页），所以它必须是全局快捷键。
            let locked = crate::lyric_window::get_state(app).locked;
            if let Err(e) = crate::lyric_window::set_locked(app, !locked) {
                log::error!("[media] 切换歌词锁定失败: {e}");
            }
        }
    }
}
