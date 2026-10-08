import * as sourceApi from "@/source-scripts";
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
 */

const CACHE_CAP = 64;

/** 在飞的（含已完成的）解析：`平台:名字` → Promise；同一歌手并发进页只查一次 */
const pending = new Map<string, Promise<string>>();
/** 已落定的结果，同步可读（测试与调试用） */
const settled = new Map<string, string>();

function keyOf(platform: SourceId, name: string): string {
  return `${platform}:${name}`;
}

/** 名字归一：比对该忽略大小写与空白（上游偶尔带全角空格/多余空格） */
function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * 挑最像的那个歌手。
 *
 * 名字完全对上就用它（同名歌手有多条时不能随便取第一条）；
 * 对不上就取第一条 —— 搜索接口本身已按相关度排，比返回空让整页退回模糊搜索强。
 */
function pickBest(list: { id: string; name: string }[], name: string): string {
  const want = normalize(name);
  for (const a of list) {
    if (a.id.length > 0 && normalize(a.name) === want) return a.id;
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
  const key = keyOf(platform, name);
  const hit = pending.get(key);
  if (hit !== undefined) return hit;

  const task = (async (): Promise<string> => {
    try {
      const list = await sourceApi.searchArtists(platform, name, 1, 5);
      const id = pickBest(list, name);
      settled.set(key, id);
      return id;
    } catch {
      // 查不到歌手就按老路走：不能因为一次查询失败让歌手页空掉
      settled.set(key, "");
      return "";
    }
  })();

  pending.set(key, task);
  trim();
  return task;
}

/** 已解析过的 id（同步）；没解析过返回 null */
export function peekArtistId(platform: SourceId, name: string): string | null {
  const v = settled.get(keyOf(platform, name));
  return v === undefined ? null : v;
}

/** 清空缓存（测试用） */
export function clearArtistIdCache(): void {
  pending.clear();
  settled.clear();
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
