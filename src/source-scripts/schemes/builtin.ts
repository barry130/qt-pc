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
      // platform 透传：安卓（1101）跑同一份 bundle 时，行级 platforms 过滤按本机平台生效
      wyy: (request, song, quality, platform) =>
        resolvePlayUrlAction(request, "wyy", song, quality, platform),
      qq: (request, song, quality, platform) =>
        resolvePlayUrlAction(request, "qq", song, quality, platform),
      kw: (request, song, quality, platform) =>
        resolvePlayUrlAction(request, "kw", song, quality, platform),
      kg: (request, song, quality, platform) =>
        resolvePlayUrlAction(request, "kg", song, quality, platform),
    },
  },
];

export function getBuiltinScheme(id: string): SourceScheme | undefined {
  return BUILTIN_SCHEMES.find((scheme) => scheme.id === id);
}
