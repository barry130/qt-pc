/**
 * 「优选聚合」(premium) 方案 —— drop-in 注册入口。
 *
 * 本方案只承载脚本包之外的剩余线路（线路组成见 ./play-url.ts），按音质
 * 高→低排线、不做跨源。本文件按 defineScheme 协议把各平台入口注册进
 * registry（import.meta.glob 自动发现），未声明平台自动跳过。
 */
import { defineScheme } from "../define";
import { resolvePlayUrlPremium } from "./play-url";

export default defineScheme({
  id: "premium",
  name: "优选聚合",
  description: "脚本包之外的剩余线路，自动换源（不跨源）",
  playUrl: {
    kw: (request, song, quality) => resolvePlayUrlPremium(request, "kw", song, quality),
    kg: (request, song, quality) => resolvePlayUrlPremium(request, "kg", song, quality),
  },
});
