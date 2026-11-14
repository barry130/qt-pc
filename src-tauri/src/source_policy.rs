//! Device-owned platform policy. The engine can read only this setting, never arbitrary keys.
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

pub const SETTING_KEY: &str = "source.platformPolicy.v1";
pub const CHANGED_EVENT: &str = "source-policy-changed";
pub fn is_policy_error(message: &str) -> bool {
    message.contains("音乐源") && (message.contains("设置") || message.contains("关闭"))
        || message.contains("平台总开关")
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct SourcePolicy {
    pub version: u8,
    pub enabled: Option<Vec<String>>,
    pub order: Vec<String>,
}

impl Default for SourcePolicy {
    fn default() -> Self {
        Self { version: 1, enabled: None, order: Vec::new() }
    }
}

impl SourcePolicy {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 { return Err("不支持的音乐源设置版本".into()); }
        for ids in [self.enabled.as_deref().unwrap_or(&[]), self.order.as_slice()] {
            if ids.len() > 128 { return Err("音乐源设置过长".into()); }
            let mut seen = std::collections::HashSet::new();
            for id in ids {
                if id.is_empty() || id.len() > 32 || id == "local"
                    || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
                    || !seen.insert(id)
                {
                    return Err("音乐源设置包含无效或重复的平台".into());
                }
            }
        }
        Ok(())
    }
}

#[tauri::command(rename = "source_policy_get")]
pub async fn cmd_source_policy_get(state: State<'_, crate::AppState>) -> Result<SourcePolicy, String> {
    let db = state.db.clone().ok_or("数据库不可用")?;
    tauri::async_runtime::spawn_blocking(move || {
        let raw = db.with(|conn| crate::db::store::get_setting(conn, SETTING_KEY))?;
        let policy = match raw.filter(|raw| !raw.trim().is_empty()) {
            Some(raw) => serde_json::from_str::<SourcePolicy>(&raw).map_err(|_| "音乐源设置无法读取")?,
            None => SourcePolicy::default(),
        };
        policy.validate()?;
        Ok(policy)
    }).await.map_err(|e| format!("读取音乐源设置失败：{e}"))?
}

#[tauri::command(rename = "source_policy_set")]
pub async fn cmd_source_policy_set(
    app: tauri::AppHandle,
    state: State<'_, crate::AppState>,
    policy: SourcePolicy,
) -> Result<(), String> {
    policy.validate()?;
    let db = state.db.clone().ok_or("数据库不可用")?;
    let text = serde_json::to_string(&policy).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        db.with(|conn| crate::db::store::set_setting(conn, SETTING_KEY, &text))
    }).await.map_err(|e| format!("保存音乐源设置失败：{e}"))??;
    // Bump the native generation too: a late frontend resolve cannot refill the old URL.
    state.url_cache.clear();
    state.engine.send(crate::audio::engine::AudioCmd::SourcePolicyChanged);
    app.emit(CHANGED_EVENT, ()).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_is_distinct_from_unconfigured() {
        let empty = SourcePolicy { enabled: Some(vec![]), ..Default::default() };
        assert_ne!(empty, SourcePolicy::default());
        assert_eq!(serde_json::to_string(&empty).unwrap(), r#"{"version":1,"enabled":[],"order":[]}"#);
    }
    #[test]
    fn unknown_platforms_survive_package_changes() {
        assert!(SourcePolicy { enabled: Some(vec!["new_platform".into()]), order: vec!["absent".into()], ..Default::default() }.validate().is_ok());
    }
    #[test]
    fn rejects_invalid_version_ids_and_duplicates() {
        assert!(SourcePolicy { version: 2, ..Default::default() }.validate().is_err());
        for ids in [vec!["local"], vec!["../qq"], vec!["qq", "qq"], vec![""]] {
            assert!(SourcePolicy { enabled: Some(ids.into_iter().map(String::from).collect()), ..Default::default() }.validate().is_err());
        }
    }
}
