import * as sourceApi from "@/source-scripts";
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
 */

const CACHE_CAP = 64;

/** 在飞的（含已完成的）解析 */
const pending = new Map<string, Promise<string>>();
/** 已落定的结果，同步可读（组件首帧就能拿到，不用等一次 await） */
const settled = new Map<string, string>();

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
  const key = keyOf(platform, trimmed);
  const hit = pending.get(key);
  if (hit !== undefined) return hit;

  const task = (async (): Promise<string> => {
    try {
      const result = await sourceApi.getArtistSongs(platform as SourceId, trimmed, 1, 5);
      if (isUsablePicUrl(result.picUrl)) {
        settled.set(key, result.picUrl);
        return result.picUrl;
      }
      const artists = await sourceApi.searchArtists(platform as SourceId, trimmed, 1, 5);
      const want = trimmed.toLowerCase().replace(/\s+/g, "");
      const exact = artists.find((a) => a.name.trim().toLowerCase().replace(/\s+/g, "") === want);
      const url = exact?.picUrl ?? "";
      const picked = isUsablePicUrl(url) ? url : "";
      settled.set(key, picked);
      return picked;
    } catch {
      settled.set(key, "");
      return "";
    }
  })();

  pending.set(key, task);
  trim();
  return task;
}

/** 已解析过的头像（同步）；没解析过返回 null */
export function peekArtistPic(platform: string, name: string): string | null {
  const value = settled.get(keyOf(platform, name.trim()));
  return value === undefined ? null : value;
}

/** 清空缓存（设置页「列表结果」清理 / 测试用） */
export function clearArtistPicCache(): number {
  const count = new Set([...pending.keys(), ...settled.keys()]).size;
  pending.clear();
  settled.clear();
  return count;
}

function trim(): void {
  while (pending.size > CACHE_CAP) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
    settled.delete(oldest);
  }
  while (settled.size > CACHE_CAP) {
    const oldest = settled.keys().next().value;
    if (oldest === undefined) break;
    settled.delete(oldest);
  }
}
