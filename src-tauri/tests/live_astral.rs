//! Astral 后端真实链路无头验证（更新 / 官方校验 / 加速节点 / 消息）。
//!
//! `#[ignore]`：依赖外网与后端可达，常规 `cargo test` 不跑。手动执行：
//! `cargo test --test live_astral -- --ignored --nocapture`
//!
//! 后端地址取自 `runtime_config::base_url()`（运行时 `app.config.local.json` >
//! 编译期 `private_config.rs`），所以跑之前先确保本机有私有配置，否则这里会连到
//! 本机联调地址、全部请求失败 —— 打印出的地址就是判断依据。

use quietmusic_lib::astral::{version_code, version_name, AstralClient};
use quietmusic_lib::runtime_config;

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
}

#[test]
fn live_update_check_version_and_messages() {
    let rt = runtime();
    rt.block_on(async {
        let base = runtime_config::base_url();
        println!(
            "[live] 后端地址 = {base}（私有配置来源：{}）",
            runtime_config::source_path()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "无，用的是编译期常量".to_string())
        );
        let client = AstralClient::new(base);
        println!(
            "[live] versionName={} versionCode={}",
            version_name(),
            version_code()
        );

        // /app/update?type=1103&version=<versionCode>（无 channel 入参）
        let update = client.app_update(version_code()).await;
        match update {
            Ok(data) => println!("[live] app/update = {data}"),
            Err(e) => {
                println!("[live] app/update 失败（后端未发布 PC 记录时返回 null 属正常）: {e}")
            }
        }

        // /app/version/check?type=1103&version=&versionName=：三者与后台一致才通过
        let check = client
            .check_official_version(version_code(), version_name())
            .await;
        match check {
            Ok(data) => println!("[live] version/check = {data}"),
            Err(e) => {
                println!("[live] version/check 未通过（本地 dev 版本号后台未登记属正常）: {e}")
            }
        }

        // /app/github/accels
        match client.github_accels().await {
            Ok(data) => println!("[live] github/accels = {data}"),
            Err(e) => println!("[live] github/accels 失败: {e}"),
        }

        // /app/message/active?versionCode=&channel=pc（公开接口）
        let msgs = client
            .active_messages(version_code())
            .await
            .expect("active messages 失败");
        println!("[live] active messages = {msgs}");

        // 匿名统计上报（单条 launcher 探活；后端只落库不校验 ut 枚举）
        let evt = serde_json::json!({
            "evt": "custom", "ts": 0, "deviceId": "pc-live-test",
            "ut": "app-windows", "appVersion": version_name(),
        });
        match client.report_stats(vec![evt]).await {
            Ok(()) => println!("[live] app/stat/report 成功"),
            Err(e) => println!("[live] app/stat/report 失败: {e}"),
        }

        // 需登录接口：无 satoken 时应得到明确错误而非 panic
        let center = client.message_center().await;
        match center {
            Ok(_) => println!("[live] message_center 意外成功（可能后端未鉴权）"),
            Err(e) => println!("[live] message_center 未登录被拒（预期）: {e}"),
        }
    });
}
