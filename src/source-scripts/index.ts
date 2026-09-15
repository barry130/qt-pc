/**
 * 音源访问层统一入口（试点）。
 *
 * 页面一律从这里调"第三方源"动作，不直接 import ipc 里的对应命令：
 * scheme = "script" 且该动作/平台已迁移 → 共享脚本包；
 * 否则 → 原内置 Rust 通道（迁移期兜底与对拍基准）。
 *
 * 试点范围：仅 recommendations（首页推荐歌单）。后续动作按方案 v3
 * 逐个在此追加，追加齐全后 ipc 中对应封装降级为 rust 专用。
 */
import * as ipc from "@/services/ipc";
import type { Playlist, SourceId } from "@/types";
import { recommendations } from "./actions/recommendations";
import type { ContractPlaylist, Source } from "./contract";
import { hostRequest } from "./host-request";
import { getScheme } from "./scheme";

/** 已迁移到脚本包的平台（kw 依赖酷我 Cookie/Secret 模块，试点未含） */
const SCRIPT_SOURCES: ReadonlySet<SourceId> = new Set(["wyy", "qq", "kg"]);

export async function getRecommendations(
  source: SourceId,
  category: string | null,
  page: number,
): Promise<Playlist[]> {
  if (getScheme() === "script" && SCRIPT_SOURCES.has(source)) {
    const list = await recommendations(
      hostRequest,
      source as Source,
      category,
      page,
    );
    return list.map(toAppPlaylist);
  }
  return ipc.getRecommendations(source, category, page);
}

/** 契约歌单 → App 内 Playlist 模型（仅字段名差异） */
function toAppPlaylist(item: ContractPlaylist): Playlist {
  return {
    id: item.id,
    platform: item.platform,
    name: item.name,
    picUrl: item.picUrl,
    playCount: item.playCount,
    description: null,
  };
}
