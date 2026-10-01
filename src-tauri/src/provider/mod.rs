//! 音源数据模型与播放地址缓存（原 provider 适配层：四大音源的原生接口
//! 已整体删除，第三方取链由运行时安装的音源包承担（仓库不内置），
//! Rust 侧仅保留：统一数据模型（types）+ 播放地址内存缓存（url_cache）+
//! 引擎 → 前端取链桥（playurl_bridge，见模块根文档）。

pub mod types;
pub mod url_cache;

pub use types::{ProviderError, ProviderResult, Quality, SourceId, Track};
pub use url_cache::PlayUrlCache;
