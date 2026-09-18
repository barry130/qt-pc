/**
 * 封面补全（pic）动作 —— 蓝本 songCover（music-api.ts:3273）的忠实移植。
 *
 * 优先在原平台按「歌名 + 歌手」搜索取首个带封面的结果；
 * 找不到时兜底网易云（封面覆盖最全）。命中写内存缓存。
 * （蓝本的 local 分支不进脚本层：local 源由宿主内置实现处理。）
 */
import type { MusicInfo, RequestBuiltin, Source } from "../contract";
import { kg } from "../platforms/kg";
import { kw } from "../platforms/kw";
import { qq } from "../platforms/qq";
import { wyy } from "../platforms/wyy";
import { TtlCache } from "../platforms/utils";

const coverCache = new TtlCache(30 * 60 * 1000);

function platformModule(source: Source) {
  if (source === "qq") return qq;
  if (source === "kw") return kw;
  if (source === "kg") return kg;
  return wyy;
}

export async function songCover(
  request: RequestBuiltin,
  source: Source,
  song: MusicInfo,
): Promise<string> {
  if (song.picUrl.length > 0) return song.picUrl;
  const cacheKey = source + ":" + song.id + ":cover";
  const cached = coverCache.get(cacheKey);
  if (cached.length > 0) return cached;

  const keyword = song.name + (song.singer.length > 0 ? " " + song.singer : "");
  let cover = "";
  // 优先原平台搜索
  try {
    const results = await platformModule(source).search(request, keyword, 1, 8);
    for (const hit of results) {
      if (hit.picUrl.length > 0) {
        cover = hit.picUrl;
        break;
      }
    }
  } catch {
    // 原平台失败继续兜底
  }
  // 兜底：网易云
  if (cover.length === 0 && source !== "wyy") {
    try {
      const results = await wyy.search(request, keyword, 1, 8);
      for (const hit of results) {
        if (hit.picUrl.length > 0) {
          cover = hit.picUrl;
          break;
        }
      }
    } catch {
      // 兜底也失败返回空
    }
  }
  if (cover.length > 0) coverCache.set(cacheKey, cover);
  return cover;
}
