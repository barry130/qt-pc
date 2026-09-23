/**
 * 「优选聚合」(premium) 取链方案 —— 脚本包收敛后的剩余线路（2026-09-17）。
 *
 * 主力线路已全部并入内置脚本包（actions/play-url.ts：音质高→低、每档 ≤5 条、
 * 末级跨源）。这里只收脚本包每档 5 条上限放不下的剩余线路，同样按音质高→低
 * 排线，不做跨源（跨源由脚本包末级统一承担）：
 *
 * - kw：墨澜（聚合）→ 洛雪 v2-fix（实测仅 320k 可用，线路慢，排最后）；
 *       原中间一步「独家音源 v6（88.lxmusic.中国 中控）」已于 2026-09-23 摘除：
 *       该脚本初始化即失败（lx 未注册 request handler，36 格全败），中控域名
 *       88.lxmusic.xn--fiqs8s 实测 6s 超时，属脚本级失效、与平台无关；
 * - kg：酷狗官方接口（上游已失效，保留占位对齐蓝本，秒失败）；
 * - wyy / qq：无剩余线路（已全部并入脚本包），不声明 playUrl，
 *   换源顺序走到这里自动跳过。
 */
import type { MusicInfo, Quality, RequestBuiltin, Source } from "../../contract";
import { ChainBudget } from "../../budget";
import { kg } from "../../platforms/kg";
import { TtlCache } from "../../platforms/utils";
import { lxPlayUrl, luoxueHost, molanHost } from "../lx-host/sources";

const PLAY_URL_TTL_MS = 10 * 60 * 1000;
const urlCache = new TtlCache(PLAY_URL_TTL_MS);

type PremiumLine = {
  name: string;
  qualities: readonly Quality[];
  fetch: (request: RequestBuiltin, song: MusicInfo, quality: Quality) => Promise<string>;
};

/** 剩余线路表（音质高→低；测试锁定其组成） */
export const PREMIUM_LINES: Partial<Record<Source, PremiumLine[]>> = {
  kw: [
    {
      name: "墨澜",
      qualities: ["128", "320", "flac"],
      fetch: (request, song, quality) => lxPlayUrl(molanHost, request, "kw", song, quality),
    },
    {
      name: "洛雪 v2-fix",
      qualities: ["320"],
      fetch: (request, song, quality) => lxPlayUrl(luoxueHost, request, "kw", song, quality),
    },
  ],
  kg: [
    {
      name: "酷狗官方（上游失效占位）",
      qualities: ["128", "320", "flac"],
      fetch: (request, song, quality) => kg.musicUrlCore(request, song, quality),
    },
  ],
};

export async function resolvePlayUrlPremium(
  request: RequestBuiltin,
  source: Source,
  song: MusicInfo,
  quality: Quality,
): Promise<string> {
  return resolvePlayUrlPremiumWithBudget(request, source, song, quality, new ChainBudget());
}

/** 带预算的实现（budget.ts）：剩余线路也是第三方 LX 宿主，挂死时不能拖过引擎取链预算 */
export async function resolvePlayUrlPremiumWithBudget(
  request: RequestBuiltin,
  source: Source,
  song: MusicInfo,
  quality: Quality,
  budget: ChainBudget,
): Promise<string> {
  const cacheKey = "premium:" + source + ":" + song.id + ":" + quality;
  const cached = urlCache.get(cacheKey);
  if (cached.length > 0) return cached;

  const lines = (PREMIUM_LINES[source] ?? []).filter((line) => line.qualities.includes(quality));
  if (lines.length === 0) {
    throw new Error("premium 无该平台剩余线路（已并入脚本包）");
  }
  for (const line of lines) {
    if (budget.expired) break;
    const url = await budget.run(line.fetch(request, song, quality), "");
    if (url.length > 0) return settle(cacheKey, url);
  }
  throw new Error("该歌曲暂时无法播放");
}

function settle(cacheKey: string, url: string): string {
  urlCache.set(cacheKey, url);
  return url;
}
