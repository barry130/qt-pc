import * as sourceApi from "@/source-scripts";
import { createPendingStringCache } from "@/lib/pending-cache";
import { compactText } from "@/lib/text";
import type { SourceId } from "@/types";

/**
 * 歌手名 → 歌手真实 id（进程内缓存）。
 *
 * 为什么需要它：`Track` 只带 `singer` 名字、不带歌手 id，所以从列表里点歌手名、
 * 从播放条「歌手」按钮、从常听歌手进页时，URL 上都没有 `?id=`。包里拿不到 id
 * 就会**退回纯歌手名搜索**（aggregate.ts 的 artistSongs 兜底），那是把歌手名当
 * 关键词做全局搜索、无任何过滤 —— 第 1 页相关度最高，越往后越跑偏（翻唱、合作、
 * 同名歌手），用户看到的就是「后面那些都和歌手没关系」。
 *
 * 这里在宿主侧先按名字查一次歌手（searchArtists），拿到真 id 再交给取作品接口，
 * 让所有入口都对准。一次额外请求，且结果按 `platform:name` 缓存到退出，
 * 第二次进同一个歌手页连这次请求都省了。
 *
 * 缓存管理（在飞去重 / 同步可读 / 超容量逐出 / 失败也落空串）在
 * `@/lib/pending-cache` —— 与 artist-pic.ts 共用同一实现，不再各写一份。
 */

const CACHE_CAP = 64;

const cache = createPendingStringCache(CACHE_CAP);

function keyOf(platform: SourceId, name: string): string {
  return `${platform}:${name}`;
}

/**
 * 挑最像的那个歌手。
 *
 * 名字完全对上就用它（同名歌手有多条时不能随便取第一条）；
 * 对不上就取第一条 —— 搜索接口本身已按相关度排，比返回空让整页退回模糊搜索强。
 */
function pickBest(list: { id: string; name: string }[], name: string): string {
  const want = compactText(name);
  for (const a of list) {
    if (a.id.length > 0 && compactText(a.name) === want) return a.id;
  }
  for (const a of list) {
    if (a.id.length > 0) return a.id;
  }
  return "";
}

/**
 * 解析歌手 id。拿不到（接口没实现 / 风控 / 真没有）返回空串 ——
 * 调用方拿到空串就按老路走名字搜索，不会白屏。
 */
export async function resolveArtistId(platform: SourceId, name: string): Promise<string> {
  if (platform === "local" || name.length === 0) return "";
  return cache.resolve(keyOf(platform, name), async () => {
    const list = await sourceApi.searchArtists(platform, name, 1, 5);
    return pickBest(list, name);
  });
}

/** 已解析过的 id（同步）；没解析过返回 null */
export function peekArtistId(platform: SourceId, name: string): string | null {
  return cache.peek(keyOf(platform, name));
}

/** 清空缓存（测试用 / 设置页可选清理） */
export function clearArtistIdCache(): number {
  return cache.clear();
}
