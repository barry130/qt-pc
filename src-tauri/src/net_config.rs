//! 全局网络配置：代理（跟随系统 / 直连 / 自定义）与单源请求超时。
//!
//! 第二波「网络代理与单源超时」的后端核心。音源脚本 builtin_request、
//! 封面代取 qtres、下载分段、音频流 engine / range_reader，以及 Astral API、
//! 直传与更新下载，构建 HTTP 客户端时都经过 [`configure`] /
//! [`configure_blocking`]（REQUIREMENTS §3.21.8 验收标准）。
//!
//! ## 生效时机
//! reqwest 的 `Client` 在构建期固化代理，运行期改不了，因此：
//! - 常驻客户端用 [`shared_async_client`] / [`shared_blocking_client`] 的
//!   「代际缓存」持有：配置每次变更 `generation` +1，取用时发现失配就在
//!   锁外重建（`Client` 本体是 Arc 句柄，clone 廉价）。
//! - 一次性客户端（下载的分段尝试每次新建）直接构建，天然吃到最新配置。
//! - 正在播的这首不断流：配置从**下一首 / 下一次请求**开始生效。
//!
//! ## 代理语义（reqwest 0.13 + `system-proxy` 特性）
//! - `system`（默认）：不挂任何显式代理，reqwest 自动跟随系统代理
//!   （Windows 读 WinINET 注册表项）。
//! - `none`：`no_proxy()` 显式全禁（含系统代理）。
//! - `custom`：`Proxy::all(url)`，协议支持 http / https / socks5 / socks5h
//!   （h = 连 DNS 解析也交给代理）。挂上任何显式代理后 reqwest 不再叠加
//!   系统代理。注意：代理地址**不套用** net_guard 的公网校验 —— 公司内网
//!   代理与本机代理（Clash 默认 127.0.0.1:7890）都是正当配置。
//!
//! ## 单源超时
//! 音源脚本未显式指定 `timeoutMs` 时 `builtin_request` 的兜底超时，默认
//! 10s，可调 2s–60s；脚本显式传值仍然优先（脚本侧更懂自己的接口要多快）。
//!
//! ## 键与契约
//! 设置键见 [`SETTING_PROXY_MODE`] 等常量（前端对应 src/lib/storageKeys.ts
//! 的同名常量，跨端一致性由 tests/settings-keys-contract.test.ts 守护）。
//! 各键常量收在本模块而非 settings_keys.rs，遵循「模块自有的键常量保持在
//! 原模块」的既有约定（同 cache.rs 的 SETTING_CACHE_DIR）。

use std::sync::{OnceLock, RwLock};

use crate::db::store::{get_setting, set_setting};

/// 代理模式（settings 表字符串值）
pub const SETTING_PROXY_MODE: &str = "network.proxyMode";
/// 自定义代理地址（http/https/socks5/socks5h URL）
pub const SETTING_PROXY_URL: &str = "network.proxyUrl";
/// 单源请求默认超时（毫秒，存字符串）
pub const SETTING_SOURCE_TIMEOUT_MS: &str = "network.sourceTimeoutMs";

/// 代理模式：跟随系统（默认）
pub const PROXY_MODE_SYSTEM: &str = "system";
/// 代理模式：全部直连
pub const PROXY_MODE_NONE: &str = "none";
/// 代理模式：自定义代理地址
pub const PROXY_MODE_CUSTOM: &str = "custom";

/// 单源请求默认超时（毫秒）——分析文档口径：可调、默认 10s
pub const DEFAULT_SOURCE_TIMEOUT_MS: u64 = 10_000;
/// 下限：更短的值没有可用性，只会把慢源全部判死
pub const MIN_SOURCE_TIMEOUT_MS: u64 = 2_000;
/// 上限：对齐 builtin_request 旧行为（15s）的量级，防误输超长
pub const MAX_SOURCE_TIMEOUT_MS: u64 = 60_000;

/// 允许的代理协议（socks5h = 域名解析也走代理，防 DNS 污染场景的正解）
const ALLOWED_PROXY_SCHEMES: [&str; 4] = ["http", "https", "socks5", "socks5h"];

/// 网络配置快照。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetConfig {
    /// [`PROXY_MODE_SYSTEM`] / [`PROXY_MODE_NONE`] / [`PROXY_MODE_CUSTOM`]
    pub proxy_mode: String,
    /// 自定义代理地址（仅 custom 模式有意义；其余模式保留用户上次填的值）
    pub proxy_url: String,
    /// 单源请求默认超时（毫秒，已钳制到上下限内）
    pub source_timeout_ms: u64,
}

impl Default for NetConfig {
    fn default() -> Self {
        Self {
            proxy_mode: PROXY_MODE_SYSTEM.to_string(),
            proxy_url: String::new(),
            source_timeout_ms: DEFAULT_SOURCE_TIMEOUT_MS,
        }
    }
}

/// 校验自定义代理地址：协议受限、主机必填、允许携带用户名密码（代理鉴权
/// 是正当需求）。返回规范化（去首尾空白）后的地址。
///
/// 刻意不做 net_guard 的公网校验，理由见模块注释。
pub fn validate_proxy_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("代理地址不能为空".to_string());
    }
    let url = tauri::Url::parse(raw).map_err(|_| format!("代理地址无法解析：{raw}"))?;
    let scheme = url.scheme();
    if !ALLOWED_PROXY_SCHEMES.contains(&scheme) {
        return Err(format!(
            "代理协议只支持 http / https / socks5 / socks5h（当前 {scheme}）"
        ));
    }
    if url.host_str().unwrap_or_default().is_empty() {
        return Err("代理地址缺少主机名".to_string());
    }
    Ok(raw.to_string())
}

/// 解析设置表为配置（键缺失 / 值损坏时静默回退默认，网络配置坏了不该
/// 拦住应用启动）。
pub fn load(conn: &rusqlite::Connection) -> NetConfig {
    let mode = get_setting(conn, SETTING_PROXY_MODE)
        .ok()
        .flatten()
        .unwrap_or_default();
    let proxy_mode = match mode.as_str() {
        PROXY_MODE_NONE | PROXY_MODE_CUSTOM => mode,
        _ => PROXY_MODE_SYSTEM.to_string(),
    };
    // 存进去的地址在 apply 时已校验过；这里再过一遍是防手工改库
    let proxy_url = get_setting(conn, SETTING_PROXY_URL)
        .ok()
        .flatten()
        .unwrap_or_default();
    let proxy_url = if proxy_mode == PROXY_MODE_CUSTOM {
        validate_proxy_url(&proxy_url).unwrap_or_default()
    } else {
        proxy_url
    };
    let timeout_raw = get_setting(conn, SETTING_SOURCE_TIMEOUT_MS)
        .ok()
        .flatten();
    let source_timeout_ms = match timeout_raw
        .as_deref()
        .and_then(|v| v.parse::<u64>().ok())
    {
        Some(v) => v.clamp(MIN_SOURCE_TIMEOUT_MS, MAX_SOURCE_TIMEOUT_MS),
        None => DEFAULT_SOURCE_TIMEOUT_MS,
    };
    NetConfig {
        proxy_mode,
        proxy_url,
        source_timeout_ms,
    }
}

/// 校验 + 落库 + 更新全局（设置页 `set_net_config` 的核心实现）。
/// 返回规范化后的生效配置。
pub fn apply(conn: &rusqlite::Connection, cfg: NetConfig) -> Result<NetConfig, String> {
    apply_to(conn, cfg, state())
}

// 测试使用独立状态，避免代理配置污染并行执行的本机 HTTP 测试。
fn apply_to(
    conn: &rusqlite::Connection,
    cfg: NetConfig,
    target: &RwLock<NetState>,
) -> Result<NetConfig, String> {
    let proxy_mode = match cfg.proxy_mode.as_str() {
        PROXY_MODE_NONE => PROXY_MODE_NONE.to_string(),
        PROXY_MODE_CUSTOM => PROXY_MODE_CUSTOM.to_string(),
        _ => PROXY_MODE_SYSTEM.to_string(),
    };
    // 直连/系统模式下地址也照存：用户切回来时上次填的还在
    let proxy_url = if proxy_mode == PROXY_MODE_CUSTOM {
        validate_proxy_url(&cfg.proxy_url)?
    } else {
        cfg.proxy_url.trim().to_string()
    };
    let source_timeout_ms = cfg
        .source_timeout_ms
        .clamp(MIN_SOURCE_TIMEOUT_MS, MAX_SOURCE_TIMEOUT_MS);
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    set_setting(&tx, SETTING_PROXY_MODE, &proxy_mode).map_err(|e| e.to_string())?;
    set_setting(&tx, SETTING_PROXY_URL, &proxy_url).map_err(|e| e.to_string())?;
    set_setting(&tx, SETTING_SOURCE_TIMEOUT_MS, &source_timeout_ms.to_string())
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    let clean = NetConfig {
        proxy_mode,
        proxy_url,
        source_timeout_ms,
    };
    update_state(target, clean.clone());
    Ok(clean)
}

// ---------- 进程内全局状态（代际缓存） ----------

struct NetState {
    generation: u64,
    config: NetConfig,
}

static NET_STATE: OnceLock<RwLock<NetState>> = OnceLock::new();

/// 初始代际从 1 起（0 留给「从未构建过」的静态客户端缓存元组）。
const GEN_INIT: u64 = 1;

fn state() -> &'static RwLock<NetState> {
    NET_STATE.get_or_init(|| {
        RwLock::new(NetState {
            generation: GEN_INIT,
            config: NetConfig::default(),
        })
    })
}

/// 当前配置快照（全局未初始化时 = 默认配置，即跟随系统 + 10s）。
pub fn current() -> NetConfig {
    state().read().unwrap().config.clone()
}

/// 当前代际：常驻客户端以「记录的代际 ≠ 当前代际」判定需要重建。
pub fn generation() -> u64 {
    state().read().unwrap().generation
}

/// 更新全局并 bump 代际（apply 落库成功后 / 启动装载时调用）。
fn store_global(config: NetConfig) {
    update_state(state(), config);
}

fn update_state(target: &RwLock<NetState>, config: NetConfig) {
    let mut s = target.write().unwrap();
    s.generation = s.generation.wrapping_add(1).max(GEN_INIT);
    s.config = config;
}

/// 启动装载（lib.rs setup 调用，必须赶在任何 HTTP 客户端首次构建前）：
/// 把设置表里的配置装进全局。总是 bump 代际，任何提前建好的客户端
/// 都会因此按新配置重建一次。
pub fn init_from_db(conn: &rusqlite::Connection) {
    store_global(load(conn));
}

/// 单源请求默认超时（毫秒）——builtin_request 兜底值。
pub fn source_timeout_ms() -> u64 {
    current().source_timeout_ms
}

// ---------- 应用到 reqwest builder（async 与 blocking 各一份） ----------

macro_rules! apply_proxy {
    ($builder:expr, $cfg:expr) => {{
        let cfg: &NetConfig = $cfg;
        match cfg.proxy_mode.as_str() {
            PROXY_MODE_NONE => $builder.no_proxy(),
            PROXY_MODE_CUSTOM if !cfg.proxy_url.is_empty() => {
                match reqwest::Proxy::all(&cfg.proxy_url) {
                    Ok(p) => $builder.proxy(p),
                    Err(e) => {
                        // apply/load 已保证合法，这里是双保险：坏地址宁可
                        // 跟随系统也不要把客户端构建失败
                        log::warn!("[net] 代理地址无法应用（{e}），回退跟随系统");
                        $builder
                    }
                }
            }
            // system：什么都不加，reqwest 的 system-proxy 特性自动跟随；
            // custom 但无地址（手工改库出坏数据）同样回退跟随系统
            _ => $builder,
        }
    }};
}

/// 把**当前**配置应用到异步客户端 builder。
pub fn configure(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    configure_with(builder, &current())
}

/// 把指定配置应用到异步客户端 builder（`test_net_config` 用表单值试连，
/// 不动全局状态时用它）。
pub fn configure_with(
    builder: reqwest::ClientBuilder,
    cfg: &NetConfig,
) -> reqwest::ClientBuilder {
    apply_proxy!(builder, cfg)
}

/// 把**当前**配置应用到 blocking 客户端 builder。
pub fn configure_blocking(
    builder: reqwest::blocking::ClientBuilder,
) -> reqwest::blocking::ClientBuilder {
    configure_blocking_with(builder, &current())
}

/// 把指定配置应用到 blocking 客户端 builder。
pub fn configure_blocking_with(
    builder: reqwest::blocking::ClientBuilder,
    cfg: &NetConfig,
) -> reqwest::blocking::ClientBuilder {
    apply_proxy!(builder, cfg)
}

/// 带代际的常驻异步客户端缓存：配置变更后按需重建。
///
/// `cache` 传调用点自己的 `&'static OnceLock<RwLock<(u64, reqwest::Client)>>`
/// （builder 的超时 / UA / 连接池等站点私有设置全部留在 `build` 闭包里，
/// 本函数只管「何时重建」）。重建在锁外进行，不持写锁做网络层初始化；
/// 写回时双检防止并发下重复重建。首次初始化并发竞争的输家直接放弃
/// 自己刚建的那份、用赢家的（同代际同配置，等价；只浪费一次构建）。
/// 返回的是 Arc 句柄 clone，调用方按值持有即可。
pub fn shared_async_client(
    cache: &'static OnceLock<RwLock<(u64, reqwest::Client)>>,
    build: impl FnOnce() -> reqwest::Client,
) -> reqwest::Client {
    let cur = generation();
    if let Some(guard) = cache.get() {
        {
            // 快路径：代际一致直接 clone，不碰 build
            let g = guard.read().unwrap();
            if g.0 == cur {
                return g.1.clone();
            }
        }
        // 失配：锁外重建，再拿写锁双检交换
        let fresh = build();
        let mut w = guard.write().unwrap();
        if w.0 != cur {
            *w = (cur, fresh);
        }
        return w.1.clone();
    }
    // 首次初始化：build 后抢注册权，输家用赢家那份
    let fresh = build();
    let _ = cache.set(RwLock::new((cur, fresh)));
    let guard = cache.get().unwrap();
    let g = guard.read().unwrap();
    g.1.clone()
}

/// [`shared_async_client`] 的 blocking 版。
pub fn shared_blocking_client(
    cache: &'static OnceLock<RwLock<(u64, reqwest::blocking::Client)>>,
    build: impl FnOnce() -> reqwest::blocking::Client,
) -> reqwest::blocking::Client {
    let cur = generation();
    if let Some(guard) = cache.get() {
        {
            let g = guard.read().unwrap();
            if g.0 == cur {
                return g.1.clone();
            }
        }
        let fresh = build();
        let mut w = guard.write().unwrap();
        if w.0 != cur {
            *w = (cur, fresh);
        }
        return w.1.clone();
    }
    let fresh = build();
    let _ = cache.set(RwLock::new((cur, fresh)));
    let guard = cache.get().unwrap();
    let g = guard.read().unwrap();
    g.1.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 只建 settings 最小表的连接：load() 对读失败键一律回退默认，
    /// 所以不必跑完整迁移。
    fn conn() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute(
            "CREATE TABLE settings (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL,
                 updated_at INTEGER NOT NULL
             )",
            [],
        )
        .unwrap();
        c
    }

    #[test]
    fn default_when_keys_missing_or_read_fails() {
        // 空库（连表都没有）：全部回退默认
        let empty = rusqlite::Connection::open_in_memory().unwrap();
        let cfg = load(&empty);
        assert_eq!(cfg, NetConfig::default());
        assert_eq!(cfg.proxy_mode, PROXY_MODE_SYSTEM);
        assert_eq!(cfg.source_timeout_ms, DEFAULT_SOURCE_TIMEOUT_MS);
    }

    #[test]
    fn timeout_is_clamped_and_bad_value_falls_back() {
        let c = conn();
        set_setting(&c, SETTING_SOURCE_TIMEOUT_MS, "500").unwrap();
        assert_eq!(load(&c).source_timeout_ms, MIN_SOURCE_TIMEOUT_MS);
        set_setting(&c, SETTING_SOURCE_TIMEOUT_MS, "999999").unwrap();
        assert_eq!(load(&c).source_timeout_ms, MAX_SOURCE_TIMEOUT_MS);
        set_setting(&c, SETTING_SOURCE_TIMEOUT_MS, "abc").unwrap();
        assert_eq!(load(&c).source_timeout_ms, DEFAULT_SOURCE_TIMEOUT_MS);
    }

    #[test]
    fn unknown_mode_falls_back_to_system() {
        let c = conn();
        set_setting(&c, SETTING_PROXY_MODE, "something-else").unwrap();
        assert_eq!(load(&c).proxy_mode, PROXY_MODE_SYSTEM);
    }

    #[test]
    fn validate_proxy_url_rules() {
        // 合法：本机 / 内网代理 / 带端口 / socks5h / 带凭据都放行
        assert!(validate_proxy_url("http://127.0.0.1:7890").is_ok());
        assert!(validate_proxy_url("socks5://192.168.1.9:1080").is_ok());
        assert!(validate_proxy_url("socks5h://proxy.lan:1080").is_ok());
        assert!(validate_proxy_url("http://user:pass@10.0.0.2:3128").is_ok());
        // 非法：协议、缺主机、空串、纯垃圾
        assert!(validate_proxy_url("ftp://127.0.0.1:21").is_err());
        assert!(validate_proxy_url("http://").is_err());
        assert!(validate_proxy_url("").is_err());
        assert!(validate_proxy_url("not a url").is_err());
        // 首尾空白会被裁掉
        assert_eq!(
            validate_proxy_url("  http://127.0.0.1:7890  ").unwrap(),
            "http://127.0.0.1:7890"
        );
    }

    #[test]
    fn apply_persists_validates_and_bumps_generation() {
        let c = conn();
        let isolated = RwLock::new(NetState {
            generation: GEN_INIT,
            config: NetConfig::default(),
        });
        let before = isolated.read().unwrap().generation;
        // custom + 非法地址 → 拒绝，生效状态不动
        let bad = apply_to(
            &c,
            NetConfig {
                proxy_mode: PROXY_MODE_CUSTOM.into(),
                proxy_url: "ftp://x".into(),
                source_timeout_ms: 5_000,
            },
            &isolated,
        );
        assert!(bad.is_err());
        assert_eq!(isolated.read().unwrap().generation, before);
        // 合法配置 → 落库 + 生效 + 代际 +1
        let ok = apply_to(
            &c,
            NetConfig {
                proxy_mode: PROXY_MODE_CUSTOM.into(),
                proxy_url: " socks5://127.0.0.1:1080 ".into(),
                source_timeout_ms: 30_000,
            },
            &isolated,
        )
        .unwrap();
        assert_eq!(ok.proxy_url, "socks5://127.0.0.1:1080");
        assert_eq!(isolated.read().unwrap().generation, before + 1);
        assert_eq!(isolated.read().unwrap().config, ok);
        // 重新 load 能读回（超时钳制后的值）
        let reloaded = load(&c);
        assert_eq!(reloaded.proxy_mode, PROXY_MODE_CUSTOM);
        assert_eq!(reloaded.proxy_url, "socks5://127.0.0.1:1080");
        assert_eq!(reloaded.source_timeout_ms, 30_000);
    }
}
