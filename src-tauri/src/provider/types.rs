//! 音源统一数据模型（DESIGN §6.6 / §7.2）
//!
//! 全部 `rename_all = "camelCase"`，与前端 TS 类型一一对应，不做手工字段映射。

use serde::{Deserialize, Serialize};

/// 保留音源 id：**本地曲目**。
///
/// 这是宿主唯一硬编码的音源值，代表「本地文件」这条宿主能力而不是在线音源：
/// `Track.id` 即音频文件绝对路径（DESIGN §13），不参与在线取链。
pub const LOCAL_SOURCE: &str = "local";

/// 音源 id。
///
/// **宿主不持有在线音源清单**（音源包全面开放）：有哪些在线音源、各自的线路、
/// 音质档位，全部由音源包声明，宿主只把 id 当不透明字符串透传（取链、缓存键、
/// 落库、云端收藏同步）。
///
/// 此前这里是 `enum { Wyy, Qq, Kw, Kg, Local }`，于是音源包里新增一个平台后：
/// · 16+ 个带 `Track` 参数的 IPC 命令整条 invoke 因反序列化失败而报错；
/// · `track_from_row` 把该平台的曲目从所有列表里**静默丢掉**。
/// 两者都不会有任何编译期提示。
///
/// 唯一保留的硬编码值是 [`LOCAL_SOURCE`]。合法性的判据也只剩一条：这个字符串
/// 能不能安全参与 `platform:原始id` 主键 —— 非空、且不含 `:`（否则
/// `db_track_id` / `split_db_track_id` 会把主键拆错）。`parse` 返回 `None`
/// 的语义因此从「不在白名单」变成「拿它当 id 用会出事」。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SourceId(String);

impl SourceId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// 平台字符串 → `SourceId`（`Display` / serde 表示的逆运算）。
    ///
    /// 全库唯一的字符串解析口径：`track_from_row`、收藏变更落库、启动对账都用它。
    /// 只做「能不能当主键」的检查，不查任何音源清单。
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        if s.is_empty() || s.contains(':') {
            return None;
        }
        Some(Self(s.to_string()))
    }

    /// 是否本地曲目（宿主硬编码的保留值）。
    pub fn is_local(&self) -> bool {
        self.0 == LOCAL_SOURCE
    }

    /// 本地曲目 id。
    pub fn local() -> Self {
        Self(LOCAL_SOURCE.to_string())
    }
}

impl std::fmt::Display for SourceId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// 宿主兜底音质：音源包没声明、或历史设置读不出来时用它。
///
/// 档位本身同样由音源包声明（`Qualities`），宿主不持有 `128 / 320 / flac`
/// 这份清单，也不做白名单校验。
pub const DEFAULT_QUALITY: &str = "320";

/// 音质档位（`"128"` / `"320"` / `"flac"` / 音源包声明的任意档位）。
///
/// 与 [`SourceId`] 同理：这是不透明字符串，宿主不认识某个档位也必须能透传
/// （取链、缓存键、下载任务、settings 持久化）。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Quality(String);

impl Quality {
    pub fn new(q: impl Into<String>) -> Self {
        Self(q.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// 档位字符串 → `Quality`。只拒绝空串（当缓存键/设置值用会出事）。
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.trim();
        if s.is_empty() {
            return None;
        }
        Some(Self(s.to_string()))
    }
}

impl Default for Quality {
    fn default() -> Self {
        Self(DEFAULT_QUALITY.to_string())
    }
}

impl std::fmt::Display for Quality {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// 统一 Track 模型。`platform` 字段名与 Astral 收藏接口 / 移动端保持一致。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub platform: SourceId,
    pub title: String,
    pub singer: String,
    pub album: String,
    pub pic_url: String,
    /// 秒（移动端同口径）
    #[serde(default)]
    pub duration: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub music_id: Option<String>,
}

/// Provider 错误分类（DESIGN §6.4 / §6.10）：serde tag=kind 供前端区分展示。
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProviderError {
    #[error("网络请求失败: {message}")]
    Network { message: String },
    #[error("请求超时")]
    Timeout { after_ms: u64 },
    #[error("响应格式异常: {message}")]
    Decode { message: String },
    #[error("音源限流或风控")]
    RateLimited,
    #[error("该能力不支持")]
    Unsupported,
    #[error("无可用播放地址")]
    NoPlayableUrl,
    #[error("无结果")]
    Empty,
    /// 取链链路**等待超时**（前端应答 / 引擎窗口 / 打开流都没在预算内答完）。
    ///
    /// 与 `NoPlayableUrl` 必须分开（2026-10-03 弱网修复）：后者是「音源确实
    /// 给不出地址」，是内容问题；本变体是「网络慢/引擎卡」，等一会儿可能就好。
    /// 早期实现两者都报 `NoPlayableUrl`，于是弱网时每首都被记成「歌坏了」——
    /// 连续 5 首打满熔断把自动切歌关掉，弱网反而变成永久不可用。
    #[error("网络较慢，取链超时")]
    ResolveStalled,
}

impl ProviderError {
    /// 本次失败是否**不该记为「这首歌坏了」**。
    ///
    /// 判据：等待链路超时（弱网/引擎卡）属于环境问题，重试有意义；
    /// 内容问题（无地址/无结果/不支持/风控）是这首歌在这个音源的宿命。
    /// 引擎据此决定要不要计入连续失败熔断与 `failed_tracks` 拉黑名单。
    pub fn is_stalled(&self) -> bool {
        matches!(self, ProviderError::ResolveStalled)
    }
}

pub type ProviderResult<T> = Result<T, ProviderError>;

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归：`local` 必须是可解析平台。
    /// 历史缺陷：收藏变更落库与启动对账把 `local` 当未知平台整条跳过，
    /// 导致手机端收藏的本地歌永远进不了 PC 的收藏表。
    #[test]
    fn parse_accepts_local() {
        assert_eq!(SourceId::parse("local"), Some(SourceId::local()));
        assert!(SourceId::parse("local").expect("local 可解析").is_local());
    }

    /// 回归（音源包全面开放）：音源包里声明的**任意**平台 id 都要能解析。
    /// 历史缺陷：这里是四个字面量的白名单，于是新音源在 16+ 个 IPC 命令上
    /// 反序列化失败、曲目还会被 `track_from_row` 静默丢弃。
    #[test]
    fn parse_accepts_any_pack_source() {
        for id in [
            "wyy",
            "qq",
            "kw",
            "kg",
            "netease",
            "ximalaya",
            "my-new-source",
        ] {
            assert_eq!(SourceId::parse(id), Some(SourceId::new(id)), "{id}");
        }
    }

    /// 保留值 `local` 是唯一硬编码值，但大小写不再由宿主归一化：
    /// 认不认「Local」是音源包的事，宿主原样透传。
    #[test]
    fn parse_preserves_case() {
        assert_eq!(SourceId::parse("Local"), Some(SourceId::new("Local")));
        assert!(!SourceId::parse("Local").expect("可解析").is_local());
    }

    /// 仍然拒绝的是「拿它当 id 用会出事」的字符串：空串，以及会拆坏
    /// `platform:原始id` 主键的冒号。
    #[test]
    fn parse_rejects_unusable_id() {
        assert_eq!(SourceId::parse(""), None);
        assert_eq!(SourceId::parse("   "), None);
        assert_eq!(SourceId::parse("a:b"), None);
    }

    /// parse 与 Display 必须互为逆运算（否则落库键与回读解析会错位）。
    #[test]
    fn parse_round_trips_display() {
        for id in ["wyy", "qq", "kw", "kg", "local", "ximalaya", "my-new-source"] {
            let parsed = SourceId::parse(id).expect(id);
            assert_eq!(parsed.to_string(), id);
            assert_eq!(SourceId::parse(&parsed.to_string()), Some(parsed));
        }
    }

    /// 回归：新音源的 `Track` 必须能过 IPC 的 serde 边界（前端 → Rust）。
    /// 这正是此前「新增音源要改宿主」的根因所在。
    #[test]
    fn track_with_new_source_round_trips() {
        let track = Track {
            id: "42".into(),
            platform: SourceId::new("ximalaya"),
            title: "t".into(),
            singer: "s".into(),
            album: "a".into(),
            pic_url: String::new(),
            duration: 1.0,
            music_id: None,
        };
        let json = serde_json::to_value(&track).expect("序列化");
        assert_eq!(json["platform"], "ximalaya");
        let back: Track = serde_json::from_value(json).expect("反序列化");
        assert_eq!(back.platform, SourceId::new("ximalaya"));
    }

    /// 音质同理：音源包声明的新档位必须能透传，且默认值仍是 320。
    #[test]
    fn quality_round_trips_unknown_tier() {
        assert_eq!(Quality::default(), Quality::new(DEFAULT_QUALITY));
        assert_eq!(Quality::parse("hifi"), Some(Quality::new("hifi")));
        assert_eq!(Quality::parse(""), None);
        let json = serde_json::to_value(Quality::new("hifi")).expect("序列化");
        assert_eq!(json, "hifi");
        assert_eq!(
            serde_json::from_value::<Quality>(json).expect("反序列化"),
            Quality::new("hifi")
        );
    }
}
