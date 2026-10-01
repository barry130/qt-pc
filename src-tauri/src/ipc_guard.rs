//! 应用命令的调用来源授权（IPC 边界的最后一道闸）。
//!
//! ## 为什么需要它
//!
//! 音源引擎窗口（label = `source-engine`，见 [`crate::source_window`]）会把
//! **第三方播放音源包求值进自己的 JS 运行环境**执行（引擎页先 import 内置
//! `/meta-bundle.js`，再由其 `installPlayPack` 用 new Function 执行
//! `/script/<包目录>/play-bundle.js` 全文）。该窗口与主窗口共用同一张
//! 命令注册表，而 Tauri 的 ACL 只对**插件命令**生效：应用自身命令要走 ACL，
//! 必须存在 app ACL 清单（本项目没有 `permissions/` 目录），并且窗口来源要
//! 被判为「非本地」——而 Windows 下 `qtres://` 页面会被规范化成
//! `http://qtres.localhost/`，Tauri 视其为本地来源。三个条件叠加的结果是：
//! **一个音源包脚本可以直接 invoke("run_update_installer") 启动任意 exe**。
//!
//! ## 做法：默认拒绝
//!
//! 在 `invoke_handler` 外面包一层检查：
//! - 带 `:` 的命令（`plugin:event|listen` 这类插件/核心命令）原样放行，
//!   它们由 Tauri 的 capabilities + ACL 判定（引擎窗口的 capability 只给了
//!   `core:default` 与 `core:event:default`，本来就很紧）；
//! - 其余（应用自身）命令：**只有受限窗口受限**，它仅能调用
//!   [`ENGINE_ALLOWED_COMMANDS`]，其余一律拒绝；`main` / `lyrics` 等自家窗口
//!   的现有行为**完全不变**。
//!
//! 选默认拒绝而不是给危险命令逐个加参数，是因为前者能覆盖**将来新增的命令**：
//! 忘了登记白名单的后果是「引擎调不到」，而不是「悄悄多开一个后门」。

use tauri::ipc::Invoke;
use tauri::Runtime;

use crate::source_window::SOURCE_ENGINE_LABEL;

/// 受限窗口：会把第三方脚本 import 进自己 JS 环境的音源引擎窗口。
pub(crate) const RESTRICTED_WINDOW: &str = SOURCE_ENGINE_LABEL;

/// 受限窗口允许调用的应用命令 —— 即引擎页 `source_engine_page.html` 实际用到的全集。
///
/// 改动引擎页时如果新增了 invoke 目标，必须同步登记到这里，否则该调用会在
/// 运行期被拒绝（日志里会打印 `[ipc] 拒绝来自窗口 …`）。
pub(crate) const ENGINE_ALLOWED_COMMANDS: &[&str] = &[
    // 音源脚本唯一的网络出口（内部已做协议/内网校验）
    "builtin_request",
    // 读当前包状态（packs/activeId/activeMetaId；装配哪个包由它决定）
    "source_state",
    // 读本地 chain.json 覆盖层（调链用；无覆盖层时播放包用内置默认链）
    "source_chain_overlay",
    // 装配成功后回填真实包名/版本（设置页展示）
    "source_pack_describe",
    // 装配+冒烟全链路通过（更新现场收摊，见 source_install.rs）
    "source_pack_verified",
    // 装配/冒烟失败上报（更新现场自动回滚 .prev，手动装的包保留）
    "source_pack_load_failed",
    // meta 槽装载成功上报（数据包更新现场收摊）
    "source_meta_loaded",
    // meta 槽装载失败上报（回滚/回退内置基线）
    "source_meta_load_failed",
    // 上报取链结果（官方播放包健康度统计）
    "source_report",
];

/// 该窗口是否允许调用该命令。
///
/// - 插件/核心命令（含 `:`）→ 放行，交给 Tauri 的 ACL 判定；
/// - 非受限窗口 → 放行（保持原有行为）；
/// - 受限窗口 → 仅白名单。
pub(crate) fn is_allowed(label: &str, command: &str) -> bool {
    if command.contains(':') {
        return true;
    }
    if label != RESTRICTED_WINDOW {
        return true;
    }
    ENGINE_ALLOWED_COMMANDS.contains(&command)
}

/// 把 `tauri::generate_handler!` 包成带授权的 handler。
pub(crate) fn guarded<R, F>(handler: F) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static
where
    R: Runtime,
    F: Fn(Invoke<R>) -> bool + Send + Sync + 'static,
{
    move |invoke: Invoke<R>| {
        let command = invoke.message.command().to_owned();
        let label = invoke.message.webview_ref().label().to_owned();
        if !is_allowed(&label, &command) {
            log::warn!("[ipc] 拒绝来自窗口 {label} 的命令 {command}");
            invoke.resolver.reject(format!(
                "命令 {command} 不允许从窗口 {label} 调用"
            ));
            return true;
        }
        handler(invoke)
    }
}

#[cfg(test)]
mod tests {
    use super::{is_allowed, ENGINE_ALLOWED_COMMANDS, RESTRICTED_WINDOW};

    #[test]
    fn engine_window_is_denied_by_default() {
        // 引擎窗口能碰到的"本机执行/数据破坏"类命令，必须全部被拒
        for cmd in [
            "run_update_installer",
            "download_update_file",
            "run_update_browser",
            "delete_local_tracks",
            "delete_downloads",
            "choose_download_dir",
            "astral_upload_avatar",
            "set_setting",
            "save_shortcuts",
            "source_install",
            "source_install_from_url",
            "source_install_from_text",
            "source_install_local_file",
            "source_discover_updates",
            "source_apply_update",
            "source_activate_pack",
            "source_uninstall_pack",
        ] {
            assert!(
                !is_allowed(RESTRICTED_WINDOW, cmd),
                "{cmd} 不应允许引擎窗口调用"
            );
        }
    }

    #[test]
    fn engine_window_keeps_its_own_commands() {
        for cmd in ENGINE_ALLOWED_COMMANDS {
            assert!(is_allowed(RESTRICTED_WINDOW, cmd), "{cmd} 是引擎页要用的");
        }
    }

    #[test]
    fn plugin_commands_go_to_tauri_acl() {
        // 事件是引擎页与主窗口 RPC 的命脉，必须原样放行
        assert!(is_allowed(
            RESTRICTED_WINDOW,
            "plugin:event|listen"
        ));
        assert!(is_allowed(RESTRICTED_WINDOW, "plugin:event|emit_to"));
        assert!(is_allowed(RESTRICTED_WINDOW, "core:window|hide"));
    }

    #[test]
    fn other_windows_are_untouched() {
        // 主窗口/歌词窗口行为不变：任何应用命令都照旧可用
        for cmd in [
            "run_update_installer",
            "builtin_request",
            "delete_local_tracks",
            "set_setting",
        ] {
            assert!(is_allowed("main", cmd), "main 窗口的 {cmd} 不应受影响");
            assert!(is_allowed("lyrics", cmd), "lyrics 窗口的 {cmd} 不应受影响");
        }
    }
}