//! 运行期私有配置（自有域名 / 生产后端 / 官网地址）。
//!
//! 为什么需要这一层，而不是只用编译期常量
//! ------------------------------------
//! 仓库是公开的：`app.config.json` 与 `app_config.rs` 里**不能出现自有域名**。
//! 于是真值分成两条路进来：
//!
//! 1. **编译期**：`app.config.local.json`（被 .gitignore 忽略）经
//!    `scripts/sync-config.mjs` 编译成 `src/private_config.rs` 的常量；
//! 2. **运行期**：本模块在启动时按下面的顺序找一个同名的
//!    `app.config.local.json`，找到就用它的值覆盖上一步的常量。
//!
//! 两条路都要，是因为它们解决的不是同一个问题：编译期那条让"发布包里带着
//! 真实地址"（用户机器上没有配置文件也能用），运行期那条让"运维改地址不用重新
//! 发版、测试可以直接指向本地服务"。
//!
//! 查找顺序（先命中先用）
//! --------------------
//! 1. 环境变量 `QT_CONFIG_FILE` 指向的文件（显式指定，调试用）；
//! 2. **exe 所在目录**的 `app.config.local.json` —— 便携 / 绿色部署、
//!    以及安装目录就放在 exe 旁边的正常安装；
//! 3. `%APPDATA%/QuietMusic/app.config.local.json`（数据目录，见 `app_paths`）；
//! 4. 当前工作目录的 `app.config.local.json` —— **最后兜底**。
//!    刻意排最后：工作目录不可靠（开发时是 `src-tauri/`，从快捷方式启动时是
//!    "起始位置"里填的任意目录），最容易被别的东西带偏。
//!
//! 所有值都缓存一次（`OnceLock`）：日志、网络、UI 必须看到同一份配置，
//! 不允许 A 处读到了文件、B 处没读到。
//!
//! 缺失时的行为
//! ------------
//! 缺配置**不 panic**（开发机、CI、裸 `cargo test` 都属于"没有私有配置"）：
//! - [`base_url`]：编译期默认值为空时回落到本机联调地址 `app_config::DEV_BASE_URL`，
//!   并打一条 ERROR 日志把后果说清楚（在线能力不可用，而不是"网络有问题"）；
//! - [`own_domain_suffixes`]：空 = **没有任何自有域名**，明文 http 下载一律被拒
//!   —— 这是收紧，缺配置时正是想要的方向。

use std::path::PathBuf;
use std::sync::OnceLock;

use crate::private_config;

/// 私有配置文件名（仓库根、exe 目录、数据目录里都叫这个名字）
pub const FILE_NAME: &str = "app.config.local.json";

/// 显式指定配置文件路径的环境变量
pub const ENV_CONFIG_FILE: &str = "QT_CONFIG_FILE";

/// 当前编译形态是否该读私有配置（`backend.active == "prod"`）。
///
/// 单独抽成函数是为了**能测**：`ACTIVE_BACKEND` 是编译期常量，
/// `cfg!(test)` 下永远是 `"prod"`，dev 分支否则一行都覆盖不到。
///
/// 只有 `prod` 才读：`dev` 是"联调"形态，就该只连本机，本机上那份
/// `app.config.local.json` 是给生产形态用的，不该在开发时被偷偷读走 ——
/// 否则"我明明改成 dev 了却还是连到线上"会变成一个没有线索的怪现象。
pub(crate) fn private_config_applies(active: &str) -> bool {
    active == "prod"
}

/// 一份私有配置（字段全部可选，缺省 = 用编译期常量 / 内置默认值）
#[derive(Debug, Default, Clone)]
pub struct LocalConfig {
    /// 生产后端地址（形如 `https://<自有域名>/api/v1/`）
    pub backend_base_url: String,
    /// 官网地址（关于页的教程 / 协议 / 隐私 / 反馈入口）
    pub official_site_url: String,
    /// 自有域名后缀（明文 http 放行的唯一依据）
    pub own_domains: Vec<String>,
    /// 配置文件实际来源（None = 没找到任何文件，全用编译期常量）
    pub source: Option<PathBuf>,
}

static LOCAL: OnceLock<LocalConfig> = OnceLock::new();

/// 本次运行实际使用的私有配置（首次调用时加载并缓存）。
pub fn local() -> &'static LocalConfig {
    LOCAL.get_or_init(load)
}

/// 配置文件路径（供启动日志 / 设置页展示；没找到时为 None）。
pub fn source_path() -> Option<&'static std::path::Path> {
    local().source.as_deref()
}

/// 生产后端地址：文件 > 编译期常量。**两者都空时**回落到本机联调地址并告警。
///
/// 返回 `&'static str` 是因为所有来源都是 `'static`（`OnceLock` 里的 String
/// 借用周期与进程同长），调用方 `AstralClient::new(base_url: &str)` 不用改签名。
pub fn base_url() -> &'static str {
    static RESOLVED: OnceLock<&'static str> = OnceLock::new();
    RESOLVED.get_or_init(|| resolve_base_url(crate::app_config::ACTIVE_BACKEND, local()))
}

/// [`base_url`] 的本体（与 `OnceLock` 解耦，好让 `dev` 分支也能被测到）
fn resolve_base_url(active: &str, cfg: &'static LocalConfig) -> &'static str {
    if !private_config_applies(active) {
        log::info!(
            "[config] backend.active={active}，使用本机联调地址 {}（不读 {FILE_NAME}）",
            crate::app_config::DEV_BASE_URL
        );
        return crate::app_config::DEV_BASE_URL;
    }
    if !cfg.backend_base_url.is_empty() {
        log::info!(
            "[config] 后端地址取自运行时配置 {}",
            cfg.source
                .as_deref()
                .map(|p| p.display().to_string())
                .unwrap_or_default()
        );
        return cfg.backend_base_url.as_str();
    }
    if !private_config::BACKEND_BASE_URL.is_empty() {
        return private_config::BACKEND_BASE_URL;
    }
    log::error!(
        "[config] 没有可用的生产后端地址（既没有 {FILE_NAME}，编译期 BACKEND_BASE_URL 也是空的）：\
         本次回落到本机联调地址 {} —— 在线试听 / 登录 / 云同步都会失败。\
         修法：复制 {FILE_NAME}.example 为 {FILE_NAME} 填上真实地址，或用 {ENV_CONFIG_FILE} 指定路径。",
        crate::app_config::DEV_BASE_URL
    );
    crate::app_config::DEV_BASE_URL
}

/// 官网地址（空串 = 未配置，设置页不显示官网入口）。
pub fn official_site_url() -> &'static str {
    static RESOLVED: OnceLock<&'static str> = OnceLock::new();
    RESOLVED.get_or_init(|| {
        let cfg = local();
        if !cfg.official_site_url.is_empty() {
            return cfg.official_site_url.as_str();
        }
        private_config::OFFICIAL_SITE_URL
    })
}

/// 自有域名后缀（已规范化：小写、去前导点、去空项、去重）。
///
/// 来源优先级：环境变量 `QT_OWN_DOMAINS`（逗号分隔）> 运行时文件 > 编译期常量。
/// 环境变量排最前是为了让测试与调试能在一台机器上模拟"有 / 没有自有域名"两种情况。
pub fn own_domain_suffixes() -> &'static [String] {
    static RESOLVED: OnceLock<Vec<String>> = OnceLock::new();
    RESOLVED.get_or_init(|| {
        if let Ok(raw) = std::env::var(private_config::OWN_DOMAINS_ENV) {
            if !raw.trim().is_empty() {
                return normalize_all(raw.split(','));
            }
        }
        let cfg = local();
        if !cfg.own_domains.is_empty() {
            return normalize_all(cfg.own_domains.iter().map(String::as_str));
        }
        normalize_all(private_config::OWN_DOMAINS.iter().copied())
    })
}

/// 主机是否属于自有域名（`example.com` 或 `*.example.com`）。
///
/// 必须用 `== 后缀` 或 `ends_with(".后缀")` 两条判断，**不能**只写 `ends_with(后缀)`：
/// 那样 `example.com.evil.com` 也会被判成自家域名，明文下载的白名单就漏了。
///
/// 列表为空时永远返回 false（没有任何自有域名 ⇒ 不放行任何明文下载）。
pub fn host_is_own(host: &str) -> bool {
    #[cfg(test)]
    if let Some(list) = test_override() {
        return matches_any(&list, host);
    }
    matches_any(own_domain_suffixes(), host)
}

/// 后缀匹配本体（唯一实现，测试与生产走同一条路径）
fn matches_any(suffixes: &[String], host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    if h.is_empty() {
        return false;
    }
    suffixes
        .iter()
        .any(|suffix| !suffix.is_empty() && (h == *suffix || h.ends_with(&format!(".{suffix}"))))
}

// 测试期显式指定自有域名列表。
//
// 为什么用**线程局部**而不是全局：
// - 改环境变量不行 —— `own_domain_suffixes()` 是 `OnceLock` 缓存的，改环境变量只在
//   第一次读之前有效，测试结果会变成"看哪个测试先跑"；
// - 用全局 `Mutex` 也不行 —— `cargo test` 默认多线程并行跑用例，一个用例把列表
//   设成空、另一个正在断言"自家域名放行"，就会互相踩。
//
// 线程局部正好对应 libtest 的模型（每个用例一个线程），用例之间天然隔离，
// 也不用 `unsafe` 写环境变量。
#[cfg(test)]
thread_local! {
    static TEST_OVERRIDE: std::cell::RefCell<Option<Vec<String>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn test_override() -> Option<Vec<String>> {
    TEST_OVERRIDE.with(|cell| cell.borrow().clone())
}

/// 测试用：把自有域名列表钉成给定值（传空切片 = "没有任何自有域名"）。
///
/// 与生产共用 [`matches_any`]，所以测的是真实匹配逻辑，不是另一份拷贝。
#[cfg(test)]
pub fn set_own_domains_for_test(list: &[&str]) {
    let normalized = normalize_all(list.iter().copied());
    TEST_OVERRIDE.with(|cell| *cell.borrow_mut() = Some(normalized));
}

/// 归一化单个域名后缀：小写、去掉前导点与两端空白。
fn normalize_suffix(raw: &str) -> String {
    raw.trim().trim_start_matches('.').to_ascii_lowercase()
}

/// 归一化一批后缀并去重（保序）。
fn normalize_all<'a, I: Iterator<Item = &'a str>>(raw: I) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in raw {
        let s = normalize_suffix(item);
        if !s.is_empty() && !out.contains(&s) {
            out.push(s);
        }
    }
    out
}

/// 加载私有配置：按 [`FILE_NAME`] 文档里的顺序找第一个存在的文件。
///
/// `backend.active == "dev"` 时**根本不找文件**（返回默认值 = 全用编译期常量）：
/// 联调就该只连本机，开发机上那份 `app.config.local.json` 是给生产形态用的，
/// 在开发时被偷偷读走会让"我明明改成 dev 了却还是连到线上"变成没有线索的怪现象。
///
/// 解析失败（坏 JSON）**不静默忽略**：那是人写错了，静默会让"改了配置没生效"
/// 变成一个没有线索的怪现象，所以打 ERROR 并退回编译期常量。
fn load() -> LocalConfig {
    if !private_config_applies(crate::app_config::ACTIVE_BACKEND) {
        log::debug!(
            "[config] backend.active={}，本次不读取 {FILE_NAME}",
            crate::app_config::ACTIVE_BACKEND
        );
        return LocalConfig::default();
    }
    let Some(path) = find_file() else {
        return LocalConfig::default();
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            log::error!("[config] 读取 {} 失败: {e}", path.display());
            return LocalConfig::default();
        }
    };
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            log::error!(
                "[config] {} 不是合法 JSON（{e}），本次按「没有私有配置」处理",
                path.display()
            );
            return LocalConfig::default();
        }
    };
    log::info!("[config] 已加载运行时私有配置 {}", path.display());
    LocalConfig {
        backend_base_url: str_field(&value, "backendBaseUrl"),
        official_site_url: str_field(&value, "officialSiteUrl"),
        own_domains: value
            .get("ownDomains")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(normalize_suffix)
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
        source: Some(path),
    }
}

/// 取字符串字段（缺省 / 类型不对都当空串，绝不 panic）
fn str_field(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// 按文档顺序找配置文件，返回第一个存在的。
fn find_file() -> Option<PathBuf> {
    candidates().into_iter().find(|p| p.is_file())
}

/// 候选路径（顺序即优先级，见模块文档）
fn candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(explicit) = std::env::var_os(ENV_CONFIG_FILE) {
        if !explicit.is_empty() {
            out.push(PathBuf::from(explicit));
        }
    }
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from))
    {
        out.push(dir.join(FILE_NAME));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        out.push(
            PathBuf::from(appdata)
                .join(crate::app_paths::DIR_NAME)
                .join(FILE_NAME),
        );
    }
    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join(FILE_NAME));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用的自有域名（**合成名**，真实域名绝不进仓库）。
    ///
    /// 用 `.example` 保留域：`example.com` / `cdn.example.com` 永远不会是真实主机。
    const OWN: &[&str] = &["example.com", "cdn.example.com"];

    /// 归一化：去前导点 / 去空白 / 小写 / 去重 / 丢空项
    #[test]
    fn suffix_normalization() {
        let got = normalize_all(
            [".Example.COM", " example.com ", "cdn.example.com", "", "  "].into_iter(),
        );
        assert_eq!(got, vec!["example.com", "cdn.example.com"]);
    }

    /// 后缀陷阱：`example.com.evil.com` 不是自家域名（只 `ends_with(".x")` 会误判）
    #[test]
    fn host_match_is_not_a_suffix_trap() {
        set_own_domains_for_test(OWN);
        assert!(host_is_own("example.com"));
        assert!(host_is_own("a.b.example.com"));
        assert!(host_is_own("EXAMPLE.COM."));
        assert!(!host_is_own("evil-example.com"));
        assert!(!host_is_own("example.com.evil.com"));
        assert!(!host_is_own(""));
    }

    /// 缺配置时的默认形态：没有任何自有域名 ⇒ 一律不放行（收紧，不是放松）
    #[test]
    fn empty_suffix_list_matches_nothing() {
        set_own_domains_for_test(&[]);
        for host in ["example.com", "a.example.com", "localhost", "127.0.0.1"] {
            assert!(!host_is_own(host), "{host} 在空后缀列表下不应被判为自有域名");
        }
        assert!(normalize_all([""].into_iter()).is_empty());
    }

    /// 归一化后的列表也走同一套匹配（前导点 / 大小写不该影响结果）
    #[test]
    fn normalized_input_still_matches() {
        set_own_domains_for_test(&[".Example.COM", " cdn.example.com "]);
        assert!(host_is_own("a.example.com"));
        assert!(host_is_own("cdn.example.com"));
        // 注意 `other.example.com` **是** `example.com` 的子域，属于自有域名；
        // 这里要验的是"列表外的域名不放行"，所以用真正无关的主机。
        assert!(!host_is_own("example.org"));
        assert!(!host_is_own("evil-example.com"));
    }

    /// 只有 `prod` 形态才读私有配置；其它值（含大小写写错）一律按"不读"处理。
    ///
    /// 这条是防回归的：曾经写成 `if ACTIVE_BACKEND == "dev"` 的取反，
    /// 于是 `active` 被写成别的值（比如 `"Prod"`）时会**悄悄读走**私有配置。
    #[test]
    fn private_config_applies_only_for_prod() {
        assert!(private_config_applies("prod"));
        assert!(!private_config_applies("dev"));
        assert!(!private_config_applies(""));
        assert!(!private_config_applies("Prod"));
        assert!(!private_config_applies("production"));
    }

    /// `dev` 形态下后端地址必须是本机联调地址，且**不碰**私有配置。
    #[test]
    fn dev_backend_ignores_private_config() {
        assert_eq!(
            resolve_base_url("dev", local()),
            crate::app_config::DEV_BASE_URL
        );
    }

    /// `prod` 形态下的取值优先级：运行时文件 > 编译期常量 > 本机联调地址。
    ///
    /// 这里只断言"至少不是空串"：三种来源都可能生效（取决于本机有没有
    /// `app.config.local.json`、发布构建有没有注入），断言具体值会让
    /// 这条用例在开发机和发布机上表现不同。
    #[test]
    fn prod_backend_never_resolves_to_empty() {
        let got = resolve_base_url("prod", local());
        assert!(!got.is_empty(), "prod 形态不该解析出空地址");
    }
}
