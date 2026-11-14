//! 应用命令的调用来源授权（IPC 边界的最后一道闸）。
//!
//! ## 为什么需要它
//!
//! 音源引擎窗口（label = `source-engine`，见 [`crate::source_window`]）会把
//! **第三方播放音源包求值进自己的 JS 运行环境**执行（引擎页先 import 已安装
//! 数据包的 `/script/<id>/meta-bundle.js`，再由其 `installPlayPack` 用
//! new Function 执行播放包全文）。该窗口与主窗口共用同一张
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
//! - 其余（应用自身）命令：引擎仅能调用 [`ENGINE_ALLOWED_COMMANDS`]，
//!   歌词窗口另有独立播放/歌词白名单，二者对未登记的命令默认拒绝；
//!   `main` 等其他自家窗口保持现有行为。
//!
//! 选默认拒绝而不是给危险命令逐个加参数，是因为前者能覆盖**将来新增的命令**：
//! 忘了登记白名单的后果是「引擎调不到」，而不是「悄悄多开一个后门」。

use tauri::ipc::Invoke;
use tauri::Runtime;

use crate::lyric_window::LYRIC_WINDOW_LABEL;
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
    // 平台总开关的专用只读面；不开放任意 get_setting 或策略写入。
    "source_policy_get",
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
    // meta 槽装载失败上报（回滚更新现场/清空数据槽）
    "source_meta_load_failed",
    // 上报取链结果（官方播放包健康度统计）
    "source_report",
    // 包内诊断日志（QtHost.log → 本地文件日志；不上报）
    "source_engine_log",
];

/// 独立歌词窗口仅保留真实 entry / hook / 播放与歌词加载链所需命令。
/// 不复用引擎白名单：例如 builtin_request / 包安装不是歌词窗口的职责。
const LYRICS_ALLOWED_COMMANDS: &[&str] = &[
    "write_log",
    "set_webview_memory_low",
    "get_playback_state",
    "get_queue",
    "next",
    "previous",
    "pause",
    "resume",
    "get_desktop_lyric_state",
    "hide_desktop_lyric",
    "set_desktop_lyric_locked",
    "set_desktop_lyric_style",
    "set_desktop_lyric_bounds",
    "open_lyric_settings",
    "get_lyric_offset",
    "set_lyric_offset",
    "get_lyric",
    "read_local_lyric",
    "save_lyric",
    "resolve_local_file",
    // registry ensure → migrateStaleQualities 的既有音质运行时同步路径。
    "set_source_qualities",
    // 音源账户/品质的前端业务；敏感原生命名空间由通用设置 helper 另行拒绝。
    "get_setting",
    "set_setting",
];

/// 插件/核心命令交给 Tauri ACL；引擎与歌词窗口各自默认拒绝其他应用命令。
pub(crate) fn is_allowed(label: &str, command: &str) -> bool {
    if command.contains(':') {
        return true;
    }
    match label {
        RESTRICTED_WINDOW => ENGINE_ALLOWED_COMMANDS.contains(&command),
        LYRIC_WINDOW_LABEL => LYRICS_ALLOWED_COMMANDS.contains(&command),
        _ => true,
    }
}

/// Gate both generic get_setting and set_setting before touching the database.
/// Native-owned namespaces have dedicated, redacted IPC APIs instead.
pub(crate) fn authorize_generic_setting(key: &str) -> Result<(), String> {
    let key = key.trim().to_ascii_lowercase();
    if ["ai", "astral", "scrobble", "credentials", "native"]
        .iter()
        .any(|namespace| key == *namespace || key.starts_with(&format!("{namespace}.")))
    {
        return Err("该设置属于原生敏感命名空间，请使用专用接口".into());
    }
    // sourceAuth.accounts is deliberately owned by the frontend auth business.
    Ok(())
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
            invoke
                .resolver
                .reject(format!("命令 {command} 不允许从窗口 {label} 调用"));
            return true;
        }
        handler(invoke)
    }
}

#[cfg(test)]
mod tests {
    use super::{authorize_generic_setting, is_allowed, ENGINE_ALLOWED_COMMANDS, RESTRICTED_WINDOW};

    #[test]
    fn generic_settings_reject_native_namespaces_but_keep_frontend_source_accounts() {
        for key in [
            "ai.profiles", "ai.apiKey", "ai.activeProfile", "ai.futureCredential", "ai",
            "astral.session", "astral.futureCredential", "astral",
            "scrobble.lastfm.apiSecret", "scrobble.listenbrainz.token",
            "credentials.astral", "native.credentials", " AI.PROFILES ",
        ] {
            assert!(authorize_generic_setting(key).is_err(), "generic settings exposed native namespace {key}");
        }
        for key in [
            "sourceAuth.accounts", "sourceAuth.toggles", "sourceAuth.useMeta", "sourceAuth.usePlay",
            "appearance", "lyric.window", "quality", "like.sync.seq", "dailyRecommend.mode",
            "aiTheme", "astralux.preference", "scrobbleNotes",
        ] {
            assert!(authorize_generic_setting(key).is_ok(), "designed frontend setting {key} must remain available");
        }
    }

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
        assert!(is_allowed(RESTRICTED_WINDOW, "plugin:event|listen"));
        assert!(is_allowed(RESTRICTED_WINDOW, "plugin:event|emit_to"));
        assert!(is_allowed(RESTRICTED_WINDOW, "core:window|hide"));
    }

    #[test]
    fn lyrics_window_denies_unrelated_native_capabilities() {
        for command in [
            "run_update_installer", "download_update_file", "delete_local_tracks",
            "delete_downloads", "source_install", "source_uninstall_pack", "builtin_request",
            "astral_login", "astral_upload_avatar", "ai_chat", "diagnostics_export",
            "future_native_command", "source_pack_load_failed",
        ] {
            assert!(!is_allowed("lyrics", command), "lyrics exposed {command}");
        }
    }

    #[test]
    fn lyrics_window_keeps_entry_playback_drag_style_and_lyric_loading_commands() {
        // Commands exercised by entries/lyric.tsx + boot.ts, LyricWindow,
        // useLyricOffset and localOnline/sourceRegistry. Not derived from the allowlist.
        for command in [
            "write_log", "set_webview_memory_low", "get_playback_state", "get_queue",
            "next", "previous", "pause", "resume", "get_desktop_lyric_state",
            "hide_desktop_lyric", "set_desktop_lyric_locked", "set_desktop_lyric_style",
            "set_desktop_lyric_bounds", "open_lyric_settings", "get_lyric_offset",
            "set_lyric_offset", "get_lyric", "read_local_lyric", "save_lyric",
            "resolve_local_file", "get_setting", "set_setting", "set_source_qualities",
            "plugin:event|listen", "plugin:event|emit_to", "core:window|start_dragging",
            "core:window|set_size", "core:window|outer_position",
        ] {
            assert!(is_allowed("lyrics", command), "lyrics lost required command {command}");
        }
    }

    #[test]
    fn other_windows_are_untouched() {
        // 主窗口/迷你播放器行为不变；歌词窗口已单独限定其真实命令链。
        for cmd in [
            "run_update_installer",
            "builtin_request",
            "delete_local_tracks",
            "set_setting",
        ] {
            assert!(is_allowed("main", cmd), "main 窗口的 {cmd} 不应受影响");
            assert!(is_allowed("mini", cmd), "mini 窗口的 {cmd} 不应受影响");
        }
    }
}
