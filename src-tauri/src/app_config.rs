//! 由 `scripts/sync-config.mjs` 从仓库根的 `app.config.json` 生成 —— **不要手改**。
//!
//! 重新生成：改完 `app.config.json` 跑 `pnpm config:sync`。
//! 校验：`pnpm config:check`，以及本文件末尾的单测（逐项比对 JSON）。
//!
//! 其它 Rust 模块请从这里取值（`astral.rs` 已把对外常量转指到本模块），
//! 不要在别处重新写一遍字面量。

/// 安装包名 / 进程名 / 开始菜单名
pub const PRODUCT_NAME: &str = "QuietMusic";
/// 界面展示名（窗口标题、快捷方式名）
pub const PRODUCT_DISPLAY_NAME: &str = "轻听";
/// 应用唯一 ID（注册表路径与数据目录由它派生，发布后不可改）
pub const IDENTIFIER: &str = "com.qt.quietmusic";

/// 对外版本名（安装包 / 关于页 / 升级接口）
pub const VERSION_NAME: &str = "1.1.2";
/// 升级接口比对用的版本号（后端按平台 type 下发的 version 参数）
pub const VERSION_CODE: i64 = 112;

/// 宿主契约版本（音源包与本机的接口版本，两端同步抬高）
pub const HOST_API_VERSION: i64 = 1;

/// 本地联调后端
pub const DEV_BASE_URL: &str = "http://localhost:27000/api/v1/";
/// 线上后端
pub const PROD_BASE_URL: &str = "https://astral.canace.cn/api/v1/";
/// 当前生效的后端地址：由 app.config.json 的 `backend.active` 决定（prod）
pub const DEFAULT_BASE_URL: &str = PROD_BASE_URL;

/// 更新接口的平台号，按编译目标三选一
/// （1103 = Windows / 1104 = Linux / 1105 = macOS）
#[cfg(target_os = "windows")]
pub const UPDATE_TYPE: &str = "1103";
#[cfg(target_os = "linux")]
pub const UPDATE_TYPE: &str = "1104";
#[cfg(target_os = "macos")]
pub const UPDATE_TYPE: &str = "1105";

/// 平台号（数值形态），与 UPDATE_TYPE 同源，供 JSON 请求体 / URL 查询参数使用。
/// 音源包 manifest 与装载上报走这个值：绝不能另写字面量，否则三平台会漂移。
#[cfg(target_os = "windows")]
pub const PLATFORM_CODE: i64 = 1103;
#[cfg(target_os = "linux")]
pub const PLATFORM_CODE: i64 = 1104;
#[cfg(target_os = "macos")]
pub const PLATFORM_CODE: i64 = 1105;

/// 本机 CPU 架构（升级接口 arch 参数，服务端按它挑同版本下的对应安装包）。
/// 取值必须与后端 qt_app_update_artifact.arch 一致（小写）：
/// Windows 出 x64 / x86 / arm64 三份包，macOS 出 x64 / arm64 两份，
/// 拿错架构的安装包会在 MD5 / 大小校验阶段直接失败。
/// 与 UPDATE_TYPE 一样按编译目标取值，不在别处另写字面量。
#[cfg(target_arch = "x86_64")]
pub const ARCH: &str = "x64";
#[cfg(target_arch = "x86")]
pub const ARCH: &str = "x86";
#[cfg(target_arch = "aarch64")]
pub const ARCH: &str = "arm64";

#[cfg(test)]
mod tests {
    //! 一致性护栏：本文件必须与 app.config.json 逐项相等。
    //! 有人绕过同步脚本手改这里（或改了 JSON 忘了跑同步）时，单测直接失败。
    use serde_json::Value;

    const RAW: &str = include_str!("../../app.config.json");

    fn cfg() -> Value {
        serde_json::from_str(RAW).expect("app.config.json 不是合法 JSON")
    }

    fn s(v: &Value) -> &str {
        v.as_str().expect("期望字符串")
    }

    #[test]
    fn matches_app_config_json() {
        let c = cfg();
        assert_eq!(s(&c["product"]["name"]), super::PRODUCT_NAME);
        assert_eq!(s(&c["product"]["displayName"]), super::PRODUCT_DISPLAY_NAME);
        assert_eq!(s(&c["product"]["identifier"]), super::IDENTIFIER);
        assert_eq!(s(&c["version"]["name"]), super::VERSION_NAME);
        assert_eq!(c["version"]["code"].as_i64().unwrap(), super::VERSION_CODE);
        assert_eq!(
            c["sourcePack"]["hostApiVersion"].as_i64().unwrap(),
            super::HOST_API_VERSION
        );
        assert_eq!(s(&c["backend"]["dev"]), super::DEV_BASE_URL);
        assert_eq!(s(&c["backend"]["prod"]), super::PROD_BASE_URL);
        // UPDATE_TYPE 按编译目标三选一：断言当前目标对应的 JSON 值与常量相等
        let platform_key = if cfg!(target_os = "windows") {
            "windows"
        } else if cfg!(target_os = "linux") {
            "linux"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            panic!("不支持的目标平台：UPDATE_TYPE 未定义");
        };
        assert_eq!(
            c["platform"][platform_key].as_i64().unwrap().to_string(),
            super::UPDATE_TYPE,
            "UPDATE_TYPE 必须等于 platform.{platform_key}（JSON 里是数字，Rust 侧是字符串）"
        );
        assert_eq!(
            c["platform"][platform_key].as_i64().unwrap(),
            super::PLATFORM_CODE,
            "PLATFORM_CODE 必须等于 platform.{platform_key}"
        );
        assert_eq!(
            super::UPDATE_TYPE.parse::<i64>().unwrap(),
            super::PLATFORM_CODE,
            "UPDATE_TYPE 与 PLATFORM_CODE 必须同源（一个字符串一个数值）"
        );
    }

    /// 当前生效的后端必须是 app.config.json 里 active 指定的那一个
    #[test]
    fn default_base_url_follows_active() {
        let c = cfg();
        let want = match s(&c["backend"]["active"]) {
            "dev" => super::DEV_BASE_URL,
            "prod" => super::PROD_BASE_URL,
            other => panic!("backend.active 只能是 dev / prod，当前 {other}"),
        };
        assert_eq!(super::DEFAULT_BASE_URL, want);
    }

    /// 版本名与版本号必须自洽（1.0.7 ↔ 107）：只改一个是最容易犯的错
    #[test]
    fn version_code_matches_name() {
        let c = cfg();
        let name = s(&c["version"]["name"]);
        let mut it = name.split('.');
        let code = it.next().unwrap().parse::<i64>().unwrap() * 100
            + it.next().unwrap().parse::<i64>().unwrap() * 10
            + it.next().unwrap().parse::<i64>().unwrap();
        assert_eq!(
            code,
            super::VERSION_CODE,
            "version.name 与 version.code 不一致：{name} 应为 {code}"
        );
    }

    /// Cargo.toml 的版本（env! 取到）必须与配置一致 —— 防止有人只改了 Cargo.toml
    #[test]
    fn cargo_version_matches_config() {
        let c = cfg();
        assert_eq!(env!("CARGO_PKG_VERSION"), s(&c["version"]["name"]));
    }
}
