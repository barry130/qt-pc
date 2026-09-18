/**
 * 内置基线方案（不走 drop-in 自动发现）：
 * "script" = 脚本包——官方接口移植 + 全部实测第三方线路的聚合取链链
 * （线路组成与排序见 actions/play-url.ts）。
 * 原生 Rust Provider 已整体删除，脚本包是唯一的内置方案。
 */
import { resolvePlayUrl as resolvePlayUrlAction } from "../actions/play-url";
import type { SourceScheme } from "./define";

export const BUILTIN_SCHEMES: SourceScheme[] = [
  {
    id: "script",
    name: "脚本包",
    description: "官方接口 + 第三方线路聚合，自动换源与跨源兜底",
    playUrl: {
      wyy: (request, song, quality) => resolvePlayUrlAction(request, "wyy", song, quality),
      qq: (request, song, quality) => resolvePlayUrlAction(request, "qq", song, quality),
      kw: (request, song, quality) => resolvePlayUrlAction(request, "kw", song, quality),
      kg: (request, song, quality) => resolvePlayUrlAction(request, "kg", song, quality),
    },
  },
];

export function getBuiltinScheme(id: string): SourceScheme | undefined {
  return BUILTIN_SCHEMES.find((scheme) => scheme.id === id);
}
