/**
 * 全局 AI 模式：每日推荐与音乐助手共用一套。
 *
 * 2026-10-24 之前这个设置叫「推荐方式」，只有「每日推荐」页读它：
 * 音乐助手固定走 astral 的服务端会话，每日推荐却把「服务端 AI」降级成纯规则，
 * 用户原话是「这个需要完全支持音乐助手，每日推荐。选择哪个全局都得使用这个模式」。
 *
 * 三种模式对两个功能都是同一个意思：
 * - `rule`：不联网、不调模型。每日推荐按口味规则排；音乐助手按关键词规则选歌。
 * - `local`：调用「AI 设置」里配置的那套接口，只让模型在已搜好的候选里挑；
 *   模型挂了各自退回规则，不阻断结果。
 * - `server`：走登录后的 astral 音乐助手（服务端）。每日推荐用一次会话换回精选，
 *   音乐助手就是原来的会话式对话；没登录或调用失败时退回规则并说明原因。
 *
 * 存储键沿用 `dailyRecommend.mode`（`storageKeys.ts`）：改键要迁移老用户的设置，
 * 而这个键的语义从「每日推荐的推荐方式」变成「全局 AI 模式」是纯增量，不需要迁移。
 *
 * ---------------------------------------------------------------------------
 * 只有 `server` 是管理员专属（2026-10-24）
 * ---------------------------------------------------------------------------
 * 用户原话：「音乐助手不再需要管理员权限了，但是服务端 AI 需要管理员权限才展示和允许使用」。
 * 所以入口（侧边栏「助手」分组）对全部用户开放，而「服务端 AI」这个**模式**只在
 * 管理员（持有 `admin:qt:admin`，见 `stores/auth.ts` 的 `isAdmin`）的设置页里出现。
 * 与移动端 qt-uniappx 的 `isQtAdmin()` 同一口径：后端下发权限列表，前端据此隐藏。
 *
 * 前端隐藏只是「不让选」，不是安全边界：库里可能早就存过 `server`（老版本或换号登录），
 * 所以每个读到模式的地方都要用 `resolveAiMode()` 再收敛一次，执行层
 * （`lib/ai-server-picks.ts`）还会独立再判一次管理员 —— 后端仍按智能体权限码校验。
 */

import * as ipc from "@/services/ipc";
import { DAILY_RECOMMEND_MODE_KEY } from "@/lib/storageKeys";

/** 全局 AI 模式（三个值两处功能共用，顺序即设置页的展示顺序） */
export type AiEngineMode = "rule" | "local" | "server";

/** 设置页按钮文案 */
export const AI_MODE_LABEL: Record<AiEngineMode, string> = {
  rule: "纯规则",
  local: "本地模型精选",
  server: "服务端 AI",
};

/** 设置页每个模式的一句话说明（悬停 title 与行内提示共用） */
export const AI_MODE_HINT: Record<AiEngineMode, string> = {
  rule: "不联网、不调模型，永远可用",
  local: "调用下面配置的接口挑选候选；失败退回规则",
  server: "走登录后的 astral 服务端，需要登录",
};

/** 设置页按钮组的数据源（与 `AI_MODE_LABEL` 一一对应） */
export const AI_MODE_OPTIONS: { value: AiEngineMode; label: string }[] = [
  { value: "rule", label: AI_MODE_LABEL.rule },
  { value: "local", label: AI_MODE_LABEL.local },
  { value: "server", label: AI_MODE_LABEL.server },
];

/** 把库里读出来的字符串收敛成合法模式（未知值按规则处理，不报错） */
export function parseAiMode(raw: string | null | undefined): AiEngineMode {
  return raw === "local" || raw === "server" ? raw : "rule";
}

/**
 * 把「用户存下的模式」收敛成「当前账号实际能用的模式」。
 *
 * 只降级 `server`：非管理员即便库里存着服务端模式，也按纯规则跑 —— 否则会出现
 * 「设置里看不见服务端 AI、实际却在悄悄建 astral 会话」这种前后不一致。
 * `rule` / `local` 不看身份，原样返回。
 */
export function resolveAiMode(mode: AiEngineMode, canUseServer: boolean): AiEngineMode {
  return mode === "server" && !canUseServer ? "rule" : mode;
}

/**
 * 设置页「AI 模式」按钮组的数据源：非管理员过滤掉「服务端 AI」一项。
 *
 * 返回新数组（不原地改 `AI_MODE_OPTIONS`），调用方按 `canUseServer` 渲染即可。
 */
export function aiModeOptionsFor(canUseServer: boolean): { value: AiEngineMode; label: string }[] {
  return canUseServer ? [...AI_MODE_OPTIONS] : AI_MODE_OPTIONS.filter((option) => option.value !== "server");
}

/** 读全局 AI 模式（读失败按规则处理，不阻断页面） */
export async function readAiMode(): Promise<AiEngineMode> {
  try {
    return parseAiMode(await ipc.getSetting(DAILY_RECOMMEND_MODE_KEY));
  } catch {
    return "rule";
  }
}

/** 保存全局 AI 模式 */
export async function saveAiMode(mode: AiEngineMode): Promise<void> {
  await ipc.setSetting(DAILY_RECOMMEND_MODE_KEY, mode);
}
