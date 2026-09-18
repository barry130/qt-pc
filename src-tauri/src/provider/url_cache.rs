//! 播放地址内存缓存（DESIGN §7.3）：键 `platform:trackId:quality`，10 分钟失效。
//! R1：只进进程内存，不写 SQLite。
//!
//! 前端脚本包解析出的地址经 `set_resolved_play_url` 写入本缓存，
//! 引擎播放/预取命中缓存直接使用。

use std::collections::HashMap;

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
}
