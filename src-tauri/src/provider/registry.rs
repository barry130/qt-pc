//! Provider 注册表：`HashMap<SourceId, Arc<dyn MusicProvider>>` 运行时分发。
//!
//! 四大音源（wyy / qq / kw / kg）全部注册；各 Provider 的能力位见各自模块头注释。

use std::collections::HashMap;
use std::sync::Arc;

use super::kg::KgProvider;
use super::kw::KwProvider;
use super::qq::QqProvider;
use super::types::{ProviderError, ProviderResult, SourceId};
use super::wyy::WyyProvider;
use super::{MusicProvider, ProviderCapabilities};

pub struct ProviderRegistry {
    providers: HashMap<SourceId, Arc<dyn MusicProvider>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        let mut providers: HashMap<SourceId, Arc<dyn MusicProvider>> = HashMap::new();
        providers.insert(SourceId::Wyy, Arc::new(WyyProvider::new()));
        providers.insert(SourceId::Qq, Arc::new(QqProvider::new()));
        providers.insert(SourceId::Kw, Arc::new(KwProvider::new()));
        providers.insert(SourceId::Kg, Arc::new(KgProvider::new()));
        Self { providers }
    }

    pub fn get(&self, id: SourceId) -> ProviderResult<Arc<dyn MusicProvider>> {
        self.providers
            .get(&id)
            .cloned()
            .ok_or(ProviderError::Unsupported)
    }

    /// 前端能力位汇总（search/lyric/play_url 每源都有；其余能力后续单元打开）
    pub fn capabilities(&self, id: SourceId) -> ProviderCapabilities {
        self.get(id)
            .map(|p| p.capabilities())
            .unwrap_or(ProviderCapabilities::none())
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// 播放地址内存缓存（DESIGN §7.3）：键 `platform:trackId:quality`，10 分钟失效。
/// R1：只进进程内存，不写 SQLite。
pub struct PlayUrlCache {
    inner: std::sync::Mutex<HashMap<String, CachedUrl>>,
    ttl_ms: u64,
}

struct CachedUrl {
    url: String,
    fetched_at: u64,
}

const PLAY_URL_TTL_MS: u64 = 10 * 60 * 1000;

impl PlayUrlCache {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(HashMap::new()),
            ttl_ms: PLAY_URL_TTL_MS,
        }
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    pub fn cache_key(platform: &str, track_id: &str, quality: &str) -> String {
        format!("{platform}:{track_id}:{quality}")
    }

    /// 命中返回 `(url, fetched_at)`；缓存条目自身的时间戳原样返回，不得刷新为当前时间。
    pub fn get(&self, key: &str) -> Option<(String, u64)> {
        let mut map = self.inner.lock().ok()?;
        match map.get(key) {
            Some(c) if Self::now_ms() - c.fetched_at <= self.ttl_ms => {
                Some((c.url.clone(), c.fetched_at))
            }
            Some(_) => {
                map.remove(key); // 过期即清除
                None
            }
            None => None,
        }
    }

    pub fn set(&self, key: String, url: String) {
        if let Ok(mut map) = self.inner.lock() {
            map.insert(
                key,
                CachedUrl {
                    url,
                    fetched_at: Self::now_ms(),
                },
            );
        }
    }

    /// 播放失败时作废缓存
    pub fn invalidate(&self, key: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.remove(key);
        }
    }
}

impl Default for PlayUrlCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn play_url_cache_roundtrip() {
        let cache = PlayUrlCache::new();
        let key = PlayUrlCache::cache_key("wyy", "123", "320");
        assert!(cache.get(&key).is_none());
        cache.set(key.clone(), "https://example.com/a.mp3".into());
        let (url, _at) = cache.get(&key).expect("should hit");
        assert_eq!(url, "https://example.com/a.mp3");
        cache.invalidate(&key);
        assert!(cache.get(&key).is_none());
    }

    #[test]
    fn registry_has_all_four_sources() {
        let reg = ProviderRegistry::new();
        for id in [SourceId::Wyy, SourceId::Qq, SourceId::Kw, SourceId::Kg] {
            let p = reg.get(id).expect("should register");
            assert_eq!(p.id(), id);
            let caps = p.capabilities();
            assert!(caps.search_song && caps.play_url && caps.lyric);
        }
        // 本地源未注册（由本地扫描单元提供）
        assert!(matches!(
            reg.get(SourceId::Local),
            Err(ProviderError::Unsupported)
        ));
    }
}
