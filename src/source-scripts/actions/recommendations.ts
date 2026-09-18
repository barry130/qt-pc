/**
 * 推荐歌单（recommendations）动作 —— 蓝本 music-api.ts:606 的分发移植。
 * 四平台实现已按平台拆分到 platforms/ 模块（wyy/qq/kg 原先的试点内联实现
 * 已并入各平台模块），本文件只做路由。
 */
import type { ContractPlaylist, RequestBuiltin, Source } from "../contract";
import { kg } from "../platforms/kg";
import { kw } from "../platforms/kw";
import { qq } from "../platforms/qq";
import { wyy } from "../platforms/wyy";

export async function recommendations(
  request: RequestBuiltin,
  source: Source,
  category: string | null,
  page: number,
): Promise<ContractPlaylist[]> {
  const platform = source === "qq" ? qq : source === "kw" ? kw : source === "kg" ? kg : wyy;
  return platform.recommendations(request, category, page);
}
