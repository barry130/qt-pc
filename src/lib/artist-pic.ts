import * as sourceApi from "@/source-scripts";
import { createPendingStringCache } from "@/lib/pending-cache";
import { compactText } from "@/lib/text";
import type { SourceId } from "@/types";

/**
 * 歌手名 → 歌手头像 URL（进程内缓存）。
 *
 * 为什么需要它：听歌报告的「常听歌手」只有歌手名（`ListenReportEntry` 的分组键就是
 * 名字），没有任何图片字段。移动端（qt-uniappx stores/listen-stats.ts 的
 * ensureArtistPic）的做法是拿名字去问音源：先 `artistSongs` 取第一页顺带的 picUrl，
 * 空了再 `searchArtists` 里找同名歌手。桌面端这里照同一口径实现，并同样只认
 * `http(s)` 开头的绝对地址 —— 包侧偶尔给相对路径，直接塞进 `<img>` 会 404。
 *
 * 缓存粒度是 `平台:名字`：同一个歌手在不同音源下的头像是各自的，不能串。
 * 失败也落缓存（空串），避免每次进报告页都对同一个查不到的歌手重发请求。
 * 缓存管理本体在 `@/lib/pending-cache`（与 artist-id.ts 共用，不再各写一份）。
 */

const CACHE_CAP = 64;

const cache = createPendingStringCache(CACHE_CAP);

function keyOf(platform: string, name: string): string {
  return `${platform}:${name}`;
}

/** 只接受绝对地址：`/static/x.png`、`//cdn/x.png`、空串都不算有效头像 */
export function isUsablePicUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * 解析歌手头像。拿不到返回空串，调用方回退首字占位。
 *
 * `platform` 传报告条目里的音源 id；`local` 直接返回空（本地曲目没有在线音源，
 * 名字也不保证是真实歌手）。
 */
export async function resolveArtistPic(platform: string, name: string): Promise<string> {
  const trimmed = name.trim();
  if (platform === "local" || trimmed.length === 0) return "";
  return cache.resolve(keyOf(platform, trimmed), async () => {
    const result = await sourceApi.getArtistSongs(platform as SourceId, trimmed, 1, 5);
    if (isUsablePicUrl(result.picUrl)) return result.picUrl;
    const artists = await sourceApi.searchArtists(platform as SourceId, trimmed, 1, 5);
    const want = compactText(trimmed);
    const exact = artists.find((a) => compactText(a.name) === want);
    const url = exact?.picUrl ?? "";
    return isUsablePicUrl(url) ? url : "";
  });
}

/** 已解析过的头像（同步）；没解析过返回 null */
export function peekArtistPic(platform: string, name: string): string | null {
  return cache.peek(keyOf(platform, name.trim()));
}

/** 清空缓存（设置页「列表结果」清理 / 测试用） */
export function clearArtistPicCache(): number {
  return cache.clear();
}
