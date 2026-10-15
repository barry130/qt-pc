//! 全局快捷键（DESIGN §14.2）。
//! 默认值：播放/暂停 Ctrl+Alt+P、上一首 Ctrl+Alt+Left、下一首 Ctrl+Alt+Right、
//! 音量加 Ctrl+Alt+Up、音量减 Ctrl+Alt+Down、静音 Ctrl+Alt+M、桌面歌词 Ctrl+Alt+L、
//! 锁定/解锁桌面歌词 Ctrl+Alt+K。
//! 搜索 Ctrl+F 不注册全局（应用内焦点由前端处理，见修订约束）。
//!
//! 自定义值存 settings 表 "shortcuts" 键：`{ 动作ID: { key: 加速键, enabled: bool } }`。
//! 空串 key = 该动作未设置（保持默认）；enabled=false = 禁用（不注册、不触发）。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_global_shortcut::ShortcutState;

use crate::db::Database;
use crate::media::{dispatch_media_action, MediaAction};

/// settings 里单个动作的自定义项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutConfig {
    /// 自定义加速键；空串 = 未设置，用默认值
    #[serde(default)]
    pub key: String,
    /// 是否启用（false = 不注册全局快捷键）
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// §14.2 默认表（不含搜索 Ctrl+F）
pub fn default_shortcuts() -> Vec<(MediaAction, &'static str)> {
    vec![
        (MediaAction::PlayPause, "Ctrl+Alt+P"),
        (MediaAction::Previous, "Ctrl+Alt+Left"),
        (MediaAction::Next, "Ctrl+Alt+Right"),
        (MediaAction::VolumeUp, "Ctrl+Alt+Up"),
        (MediaAction::VolumeDown, "Ctrl+Alt+Down"),
        (MediaAction::Mute, "Ctrl+Alt+M"),
        (MediaAction::DesktopLyric, "Ctrl+Alt+L"),
        // 锁定后不能拖动、工具条也隐藏，必须有键盘入口才能解锁（§10.7）
        (MediaAction::LockLyric, "Ctrl+Alt+K"),
    ]
}

/// 快捷键生效表：动作 → (加速键, 是否启用)
pub type Keymap = Vec<(MediaAction, String, bool)>;

/// 前端展示/提交用的单条快捷键（list_shortcuts 返回、save_shortcuts 回执）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutEntry {
    /// 动作 ID（play_pause / next / …）
    pub id: String,
    /// 生效加速键（自定义或默认）
    pub accelerator: String,
    /// 是否启用
    pub enabled: bool,
    /// 上一次注册是否失败（被别的程序占用）。
    /// 只记日志的话用户永远不知道「这个键在我这儿根本没用」——
    /// 表现是"按了没反应"，会被当成播放器的 bug。设置页据此提示改键。
    pub conflict: bool,
}

/// 从 settings 表读自定义快捷键，与默认表合并。
/// 数据库不可用 / 解析失败时退回默认值（全部启用）。
pub fn load_shortcuts(db: Option<&Database>) -> Keymap {
    let mut result: Keymap = default_shortcuts()
        .into_iter()
        .map(|(a, s)| (a, s.to_string(), true))
        .collect();
    let Some(db) = db else {
        return result;
    };
    let saved =
        db.with(|c| crate::db::store::get_setting(c, crate::settings_keys::SETTING_SHORTCUTS));
    let Ok(Some(json)) = saved else {
        return result;
    };
    let Ok(map) = serde_json::from_str::<HashMap<String, ShortcutConfig>>(&json) else {
        log::warn!("[shortcuts] 自定义快捷键解析失败，使用默认值");
        return result;
    };
    for (action, accel, enabled) in result.iter_mut() {
        let Some(cfg) = map.get(action.id()) else {
            continue;
        };
        // 空串 key = 未设置，保持默认加速键
        if !cfg.key.is_empty() {
            *accel = cfg.key.clone();
        }
        *enabled = cfg.enabled;
    }
    result
}

/// 保存整份自定义表（前端设置页提交的完整快照），返回保存后的生效表。
pub fn save_shortcuts(db: &Database, map: &serde_json::Value) -> Result<Keymap, String> {
    // 先校验能反序列化，避免把垃圾写进库
    serde_json::from_value::<HashMap<String, ShortcutConfig>>(map.clone())
        .map_err(|e| format!("快捷键配置格式错误: {e}"))?;
    db.with(|c| {
        crate::db::store::set_setting(c, crate::settings_keys::SETTING_SHORTCUTS, &map.to_string())
    })
        .map_err(|e| e.to_string())?;
    Ok(load_shortcuts(Some(db)))
}

/// 注册失败的加速键（被其它程序占用）。`register_shortcuts` 每次全量重注册前
/// 清空、逐个登记，`list_shortcuts` 读它把「这个键其实没生效」告诉设置页。
static CONFLICTS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// 某加速键当前是否处于「注册失败」状态
pub fn is_conflicted(accelerator: &str) -> bool {
    CONFLICTS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .any(|a| a == accelerator)
}

/// 注册全部全局快捷键（只注册 enabled 的项）。
/// 单个注册失败只记日志（常见于与其它应用冲突），不阻断。
pub fn register_shortcuts(app: &AppHandle, shortcuts: &Keymap) {
    let gs = app.global_shortcut();
    // 全量重注册：先清空上一轮的冲突记录，否则改键成功后旧键仍被标红
    CONFLICTS.lock().unwrap_or_else(|p| p.into_inner()).clear();
    for (action, accelerator, enabled) in shortcuts {
        if !enabled {
            log::info!(
                "[shortcuts] {accelerator}（{}）已禁用，跳过注册",
                action.id()
            );
            continue;
        }
        let action = *action;
        let ok = gs.on_shortcut(accelerator.as_str(), move |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                dispatch_media_action(app, action);
            }
        });
        if let Err(e) = ok {
            // Windows 上这就是 RegisterHotKey 的 1409（ERROR_HOTKEY_ALREADY_REGISTERED）：
            // 键被别的程序（输入法、截图工具、QQ 等）抢走了。除了记日志，
            // 还要登记下来让设置页能提示「该键无效，请改键」。
            log::warn!("[shortcuts] 注册 {accelerator} 失败（可能与其它应用冲突）: {e}");
            CONFLICTS
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(accelerator.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_cover_all_actions_and_exclude_ctrl_f() {
        let defaults = default_shortcuts();
        assert_eq!(
            defaults.len(),
            8,
            "§14.2 默认表 8 项（搜索 Ctrl+F 不注册全局）"
        );
        for (_, accel) in &defaults {
            assert!(!accel.contains('F'), "不得注册 Ctrl+F: {accel}");
        }
        for (action, _) in &defaults {
            assert_eq!(MediaAction::from_id(action.id()), Some(*action));
        }
    }

    #[test]
    fn custom_overrides_merge_with_defaults() {
        let dir = std::env::temp_dir().join(format!(
            "quietmusic-sc-{}-{}",
            std::process::id(),
            fastrand::u64(..)
        ));
        let db = Database::open(&dir.join("music.db")).expect("open test db");
        db.with(|c| {
            crate::db::store::set_setting(
                c,
                "shortcuts",
                r#"{"play_pause":{"key":"Ctrl+Alt+K","enabled":true},
                    "desktop_lyric":{"key":"","enabled":false},
                    "mute":{"key":"Ctrl+Alt+M","enabled":false}}"#,
            )
        })
        .unwrap();

        let loaded = load_shortcuts(Some(&db));
        let get = |id: &str| {
            loaded
                .iter()
                .find(|(a, _, _)| a.id() == id)
                .map(|(_, s, e)| (s.clone(), *e))
                .unwrap()
        };
        // 自定义覆盖默认值
        assert_eq!(get("play_pause"), ("Ctrl+Alt+K".into(), true));
        // enabled=false 生效（key 为空回落默认加速键）
        assert_eq!(get("desktop_lyric"), ("Ctrl+Alt+L".into(), false));
        // 禁用 + 未覆盖 key
        assert_eq!(get("mute"), ("Ctrl+Alt+M".into(), false));
        // 未提及的动作保持默认启用
        assert_eq!(get("next"), ("Ctrl+Alt+Right".into(), true));
    }

    #[test]
    fn save_validates_and_reloads() {
        let dir = std::env::temp_dir().join(format!(
            "quietmusic-sv-{}-{}",
            std::process::id(),
            fastrand::u64(..)
        ));
        let db = Database::open(&dir.join("music.db")).expect("open test db");

        let map = serde_json::json!({
            "next": { "key": "Ctrl+Shift+N", "enabled": true },
            "mute": { "key": "", "enabled": false }
        });
        let loaded = save_shortcuts(&db, &map).expect("save");
        let get = |id: &str| {
            loaded
                .iter()
                .find(|(a, _, _)| a.id() == id)
                .map(|(_, s, e)| (s.clone(), *e))
                .unwrap()
        };
        assert_eq!(get("next"), ("Ctrl+Shift+N".into(), true));
        assert_eq!(get("mute"), ("Ctrl+Alt+M".into(), false));

        // 垃圾数据被拒绝
        let bad = serde_json::json!({ "next": { "key": 123 } });
        assert!(save_shortcuts(&db, &bad).is_err(), "格式错误必须报错");
    }
}
