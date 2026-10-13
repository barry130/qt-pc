/**
 * 官方网站地址（全站唯一来源）
 *
 * 「关于」与「音源包」里的用户协议、隐私政策、意见反馈、项目介绍与音源设置教程
 * 都指向官网，不在各组件里各自硬编码 URL。
 * 官网源码见 quietMusic-site 仓库，构建与托管在腾讯云 EdgeOne Pages。
 *
 * **为什么这里没有字面量**：官网域名是自有地址，公开仓库里不能出现。
 * 真值由 Rust 侧持有（`runtime_config::official_site_url`：运行期读
 * `app.config.local.json`，编译期取 `private_config.rs`），前端通过
 * `official_site_url` 命令取值。未配置时返回空串，调用方据此不渲染入口。
 *
 * 打开方式统一走 services/ipc.ts 的 openExternalUrl（交给系统默认浏览器）。
 */
import { invoke } from "@tauri-apps/api/core";

/** 取官网根地址；未配置（公开仓库形态 / 私有配置缺失）时返回空串 */
export async function getOfficialSiteUrl(): Promise<string> {
  try {
    const url = await invoke<string>("official_site_url");
    // 去掉尾部斜杠，避免与下面的路径拼成 `//agreement`
    return (url ?? "").trim().replace(/\/+$/, "");
  } catch {
    // 命令不可用（旧版后端 / 引擎窗口）时按"未配置"处理：入口不显示，
    // 而不是让设置页整块崩掉
    return "";
  }
}

/** 官网某个子路径；根地址为空时返回空串（调用方据此隐藏入口） */
export function officialSitePath(base: string, path: string): string {
  return base ? `${base}${path}` : "";
}

/** 意见反馈：官网的 GitHub / CNB 双渠道 Issue 与 PR 入口 */
export const OFFICIAL_FEEDBACK_PATH = "/feedback";

/** 用户协议 */
export const OFFICIAL_AGREEMENT_PATH = "/agreement";

/** 隐私政策 */
export const OFFICIAL_PRIVACY_PATH = "/privacy";

/** 如何设置音源（装包、换源、音质与故障速查） */
export const OFFICIAL_SOURCE_SETUP_PATH = "/source-setup";
