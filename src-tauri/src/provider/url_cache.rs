//! 播放地址内存缓存（DESIGN §7.3）：键 `platform:trackId:quality`，10 分钟失效。
//! R1：只进进程内存，不写 SQLite。
//!
//! 前端脚本包解析出的地址经 `set_resolved_play_url` 写入本缓存，
//! 引擎播放/预取命中缓存直接使用。
//!
//! P2-5：旧实现只有"get 命中时惰性过期"，没有容量上限、也没有全量清扫 ——
//! 长时间挂机 + 频繁换歌（每首歌都会按 音质 档缓存一条，跨源重取还会覆盖）
//! 时表只涨不落。这里补上容量上限 + 按批清扫，超容量按"最旧"淘汰。

use std::collections::HashMap;

/// 单条缓存条目上限。
///
/// 为什么是 512：一条 = key（约 40 字节）+ URL（约 200 字节）+ 结构体本身，
/// 512 条合计也在百 KB 量级；而 10 分钟 TTL 下正常听歌的取链量最多个位数到
/// 几十条（按音质分档也就 ×3），512 已经比正常水位高一到两个数量级，
/// 只用来挡住"长时间挂机 + 疯狂换歌 + 反复跨源重取"这种病态场景。
const PLAY_URL_MAX_ENTRIES: usize = 512;

/// 每多少次 `set` 顺带做一次全量清扫。
///
/// 为什么是 64：全量清扫是 O(n)（n ≤ 512），逐次清扫会把 `set` 从 O(1) 变成
/// O(n)；每 64 次插入清一次，清扫成本摊到 64 次插入上（摊还 O(n/64) ≈ O(1)），
/// 代价是过期项最多多占 64 次插入的时间 —— 相对 10 分钟 TTL 完全可以忽略。
const SWEEP_EVERY_INSERTS: u32 = 64;

const PLAY_URL_TTL_MS: u64 = 10 * 60 * 1000;

pub struct PlayUrlCache {
    inner: std::sync::Mutex<CacheInner>,
    ttl_ms: u64,
    max_entries: usize,
}

struct CacheInner {
    map: HashMap<String, CachedUrl>,
    /// 自上次全量清扫以来的插入次数（摊还清扫的计数器）
    inserts_since_sweep: u32,
    /// 单调自增的插入序号。
    /// 为什么要它：同一毫秒内批量写入时 `fetched_at` 会打平，"淘汰最旧"
    /// 就失去了确定次序（也会被系统时间回拨影响）；插入序号是唯一的，
    /// 同刻按它兜底，淘汰结果稳定可测。
    next_seq: u64,
}

struct CachedUrl {
    url: String,
    /// 宿主取这个地址时要带的 Referer（音源包按源声明；空串 = 不发）。
    ///
    /// 为什么头也要进缓存：地址进了缓存之后，播放（range_reader）与下载
    /// （download.rs）是**自己**向 CDN 取字节的，不再经过取链链路，拿不到
    /// 声明它的那一侧。B 站实测部分 CDN 节点无 Referer 直接 403 text/html，
    /// 于是会出现"取链成功、播放失败"。
    referer: String,
    /// Range 预检实测的文件总字节数（None = 上游没回 Content-Range，未知）。
    ///
    /// 为什么它也要进缓存：下载要按真实体积报进度，且 actual_quality 是
    /// 由「体积 ÷ 时长」算出来的，缓存命中时不能重新测一次（那要多发一次
    /// Range 请求，还是打在 CDN 上）。
    size: Option<u64>,
    /// 按实测码率重标后的档位（包侧 snapQualityToMeasured，**只降不升**；
    /// 空串 = 未重标 = 请求档就是实测档）。
    ///
    /// 为什么它要进缓存：下载命名用的是「这一条缓存里的档位」。以前用请求档，
    /// 于是请求 flac 拿到 320k 时文件名写成 `.flac` —— 虚标。
    actual_quality: String,
    fetched_at: u64,
    /// 插入序号（越小越旧，仅用于同刻打平时的稳定排序）
    seq: u64,
}

/// 一次取链的结果：地址 + 取字节要带的头 + 实测体积 + 实测档位。
///
/// `size = None` / `actual_quality` 空串 = 这次没测出来（引擎页比宿主旧、
/// 或上游没回 Content-Range），调用方一律按"未知"处理，不得据此判失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPlayUrl {
    pub url: String,
    pub referer: String,
    pub size: Option<u64>,
    pub actual_quality: String,
    /// 写入缓存的时刻；缓存命中时是**原写入时刻**，不得刷新为当前时间
    pub fetched_at: u64,
}

impl PlayUrlCache {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(CacheInner {
                map: HashMap::new(),
                inserts_since_sweep: 0,
                next_seq: 0,
            }),
            ttl_ms: PLAY_URL_TTL_MS,
            max_entries: PLAY_URL_MAX_ENTRIES,
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

    /// 命中返回整条结果（含 referer / 实测体积 / 实测档位）；缓存条目自身的
    /// 时间戳原样返回，不得刷新为当前时间。
    ///
    /// 用 `saturating_sub` 而不是裸减法：`now_ms` 来自 `SystemTime`（不是单调钟），
    /// 系统时间被 NTP 或用户往回调时 `now < fetched_at`，裸减法在 debug 构建里
    /// 会 panic（panic 会毒化 Mutex，之后整个缓存静默失效）、release 构建里会回绕成
    /// 巨大值把条目误判过期。饱和后语义是"未来的时间戳 = 新鲜"，与 sweep 里的
    /// 过期判定（`now.saturating_sub(..) <= ttl`）完全一致，正常时间走向下逐字不变。
    pub fn get(&self, key: &str) -> Option<ResolvedPlayUrl> {
        let mut inner = self.inner.lock().ok()?;
        match inner.map.get(key) {
            Some(c) if Self::now_ms().saturating_sub(c.fetched_at) <= self.ttl_ms => {
                Some(ResolvedPlayUrl {
                    url: c.url.clone(),
                    referer: c.referer.clone(),
                    size: c.size,
                    actual_quality: c.actual_quality.clone(),
                    fetched_at: c.fetched_at,
                })
            }
            Some(_) => {
                inner.map.remove(key); // 过期即清除
                None
            }
            None => None,
        }
    }

    /// 写入一条取链结果。`size = None` / `actual_quality` 空串表示这次没测出来。
    pub fn set(&self, key: String, resolved: ResolvedPlayUrl) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let now = Self::now_ms();
        inner.next_seq = inner.next_seq.wrapping_add(1);
        let seq = inner.next_seq;
        inner.map.insert(
            key,
            CachedUrl {
                url: resolved.url,
                referer: resolved.referer,
                size: resolved.size,
                actual_quality: resolved.actual_quality,
                fetched_at: now,
                seq,
            },
        );
        inner.inserts_since_sweep = inner.inserts_since_sweep.saturating_add(1);
        // 触发条件：攒够一批（摊还清扫）或已经超容量（必须立刻压回去）
        if inner.inserts_since_sweep >= SWEEP_EVERY_INSERTS || inner.map.len() > self.max_entries {
            inner.inserts_since_sweep = 0;
            self.sweep(&mut inner, now);
        }
    }

    /// 全量清扫：先删过期项；仍超容量再按"最旧"（fetched_at，同刻用 seq 兜底）
    /// 淘汰到上限。只在 `set` 的批量触发点调用，理由见 `SWEEP_EVERY_INSERTS`。
    fn sweep(&self, inner: &mut CacheInner, now: u64) {
        let ttl = self.ttl_ms;
        inner
            .map
            .retain(|_, c| now.saturating_sub(c.fetched_at) <= ttl);
        if inner.map.len() <= self.max_entries {
            return;
        }
        let mut entries: Vec<(u64, u64, String)> = inner
            .map
            .iter()
            .map(|(k, c)| (c.fetched_at, c.seq, k.clone()))
            .collect();
        let drop_count = entries.len() - self.max_entries;
        // select_nth 是 O(n)：不必给全表排序，只要把最旧的 drop_count 条挪到前面
        entries.select_nth_unstable_by_key(drop_count - 1, |e| (e.0, e.1));
        for (_, _, key) in entries.drain(..drop_count) {
            inner.map.remove(&key);
        }
    }

    /// 播放失败时作废缓存
    pub fn invalidate(&self, key: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.map.remove(key);
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

    /// 只关心 url/referer 的用例用这个构造，其余字段按"没测出来"填。
    fn hit(url: &str, referer: &str) -> ResolvedPlayUrl {
        ResolvedPlayUrl {
            url: url.into(),
            referer: referer.into(),
            size: None,
            actual_quality: String::new(),
            fetched_at: 0,
        }
    }

    #[test]
    fn play_url_cache_roundtrip() {
        let cache = PlayUrlCache::new();
        let key = PlayUrlCache::cache_key("wyy", "123", "320");
        assert!(cache.get(&key).is_none());
        cache.set(
            key.clone(),
            hit("https://example.com/a.mp3", "https://www.bilibili.com/"),
        );
        let got = cache.get(&key).expect("should hit");
        assert_eq!(got.url, "https://example.com/a.mp3");
        assert_eq!(got.referer, "https://www.bilibili.com/");
        cache.invalidate(&key);
        assert!(cache.get(&key).is_none());
    }

    /// 实测体积与实测档位必须跟着地址一起进缓存：下载靠它们决定命名与进度
    #[test]
    fn measured_size_and_actual_quality_roundtrip() {
        let cache = PlayUrlCache::new();
        cache.set(
            "k".into(),
            ResolvedPlayUrl {
                url: "https://example.com/a.mp3".into(),
                referer: String::new(),
                size: Some(9_812_345),
                actual_quality: "320".into(),
                fetched_at: 0,
            },
        );
        let got = cache.get("k").expect("should hit");
        assert_eq!(got.size, Some(9_812_345));
        assert_eq!(got.actual_quality, "320");
    }

    /// 未声明 Referer 的源：缓存里就是空串，宿主据此不发这个头
    #[test]
    fn referer_defaults_to_empty_and_roundtrips() {
        let cache = PlayUrlCache::new();
        cache.set("k".into(), hit("https://example.com/a.mp3", ""));
        let got = cache.get("k").expect("should hit");
        assert!(got.referer.is_empty(), "未声明的源读出来必须是空串");
    }

    /// 过期项要真的从表里被清掉（不只是 get 时惰性删），否则挂机久了表只涨不落
    #[test]
    fn expired_entries_are_swept_in_batch() {
        let cache = PlayUrlCache::new();
        cache.set("stale".into(), hit("https://example.com/old.mp3", ""));
        // 直接把这条的时间戳改成 1970（同模块可访问私有字段），避免 sleep 拖慢测试
        {
            let mut inner = cache.inner.lock().unwrap();
            inner.map.get_mut("stale").unwrap().fetched_at = 0;
        }
        // 攒满一批插入 → 触发全量清扫
        for i in 0..SWEEP_EVERY_INSERTS {
            cache.set(format!("fresh-{i}"), hit("https://example.com/new.mp3", ""));
        }
        let inner = cache.inner.lock().unwrap();
        assert!(
            !inner.map.contains_key("stale"),
            "过期项应被批量清扫掉（物理删除）"
        );
        assert_eq!(
            inner.map.len(),
            SWEEP_EVERY_INSERTS as usize,
            "未过期的条目一条都不能少"
        );
        drop(inner);
        assert!(cache.get("stale").is_none());
    }

    /// 超容量按"最旧"淘汰，且表永远不会涨过上限
    #[test]
    fn over_capacity_evicts_oldest() {
        let cache = PlayUrlCache::new();
        let total = PLAY_URL_MAX_ENTRIES + 8;
        for i in 0..total {
            cache.set(
                format!("k{i:04}"),
                hit(&format!("https://example.com/{i}.mp3"), ""),
            );
        }
        let inner = cache.inner.lock().unwrap();
        assert!(
            inner.map.len() <= PLAY_URL_MAX_ENTRIES,
            "条目数 {} 超过上限 {PLAY_URL_MAX_ENTRIES}",
            inner.map.len()
        );
        assert!(!inner.map.contains_key("k0000"), "最旧的一条应被淘汰");
        assert!(
            inner.map.contains_key(&format!("k{:04}", total - 1)),
            "最新写入的一条必须保留"
        );
    }

    /// 命中过的条目不改写时间戳语义：get 返回的是写入时刻，不是当前时刻
    #[test]
    fn get_returns_original_fetched_at() {
        let cache = PlayUrlCache::new();
        cache.set("k".into(), hit("https://example.com/a.mp3", ""));
        let at = cache.get("k").expect("should hit").fetched_at;
        assert!(at > 0 && at <= PlayUrlCache::now_ms());
        let again = cache.get("k").expect("should hit").fetched_at;
        assert_eq!(at, again, "读到的时间戳必须原样返回，不得刷新");
    }
}
