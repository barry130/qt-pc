/**
 * 歌手页歌曲（artistSongs）与四源聚合动作 —— 蓝本组合逻辑移植。
 *
 * - artistSongs    : music-api.ts:1634（search + 第一页时 searchArtists 取头像）
 * - allSearchBatches : music-api.ts:1176 allSearch（四源顺序，单源失败跳过）
 * - allLatestBatches : music-api.ts:871 allLatest（perSource = ceil(limit/4)+1，
 *                     wyy/kg 带分页 offset，qq/kw 恒取第一页；交错合并在调用方做）
 * - allCharts      : music-api.ts:859（四源顺序合并，单源失败跳过；Chart 自带 platform）
 * - allHotWords    : music-api.ts:1081（合并封顶 30 条）
 *
 * 聚合搜索按平台**分批**返回（{ source, list }）：契约 MusicInfo 不携带 platform
 * （蓝本 Song 有），映射回 App Track 时由调用方按批标注，避免跨平台混批后丢失归属。
 */
import type {
  ContractArtistPage,
  ContractChart,
  MusicInfo,
  RequestBuiltin,
  Source,
} from "../contract";
import { kg } from "../platforms/kg";
import { kw } from "../platforms/kw";
import { qq } from "../platforms/qq";
import { wyy } from "../platforms/wyy";

export const ALL_SOURCES: Source[] = ["wyy", "qq", "kw", "kg"];

function platformModule(source: Source) {
  if (source === "qq") return qq;
  if (source === "kw") return kw;
  if (source === "kg") return kg;
  return wyy;
}

export async function search(
  request: RequestBuiltin,
  source: Source,
  keyword: string,
  page: number,
  size: number,
): Promise<MusicInfo[]> {
  return platformModule(source).search(request, keyword, page, size);
}

/** 蓝本 artistSongs：返回一页歌曲；仅第一页额外查头像 */
export async function artistSongs(
  request: RequestBuiltin,
  source: Source,
  name: string,
  page: number,
  size: number,
): Promise<{ picUrl: string; songs: MusicInfo[] }> {
  const songs = await platformModule(source).search(request, name, page, size);
  let picUrl = "";
  if (page <= 1) {
    try {
      const artists = await platformModule(source).artistSearch(request, name, 1, 1);
      if (artists.length > 0) picUrl = artists[0].picUrl;
    } catch {
      // 头像获取失败不阻断歌曲列表
    }
  }
  return { picUrl, songs };
}

/**
 * 歌手列表（热门 / 按首字母）。
 *
 * 各平台能力差异见 ContractArtistPage：不支持字母筛选的实现会忽略 initial，
 * 因此这里不做能力判断，直接把 initialSupported 透传给 UI。
 */
export async function artistList(
  request: RequestBuiltin,
  source: Source,
  initial: string,
  page: number,
  size: number,
): Promise<ContractArtistPage> {
  return platformModule(source).artistList(request, initial, page, size);
}

/** 蓝本 allSearch：四源顺序（单源失败跳过），按平台分批返回 */
export async function allSearchBatches(
  request: RequestBuiltin,
  keyword: string,
  page: number,
  size: number,
): Promise<{ source: Source; list: MusicInfo[] }[]> {
  const batches: { source: Source; list: MusicInfo[] }[] = [];
  for (const s of ALL_SOURCES) {
    try {
      const songs = await platformModule(s).search(request, keyword, page, size);
      batches.push({ source: s, list: songs });
    } catch {
      // 单源失败跳过（蓝本同款容错）
    }
  }
  return batches;
}

/**
 * 蓝本 allLatest 的取数部分：perSource = ceil(limit/4)+1，
 * wyy/kg 带分页 offset，qq/kw 恒取第一页。交错合并由调用方完成。
 */
export async function allLatestBatches(
  request: RequestBuiltin,
  limit: number,
  offset: number,
): Promise<{ source: Source; list: MusicInfo[] }[]> {
  const perSource = Math.ceil(limit / 4) + 1;
  const batches: { source: Source; list: MusicInfo[] }[] = [];
  for (const s of ALL_SOURCES) {
    const pageOffset = s === "wyy" || s === "kg" ? offset : 0;
    try {
      batches.push({
        source: s,
        list: await platformModule(s).latest(request, perSource, pageOffset),
      });
    } catch {
      batches.push({ source: s, list: [] });
    }
  }
  return batches;
}

/** 蓝本 allCharts：四源顺序合并（Chart 自带 platform），单源失败跳过 */
export async function allCharts(request: RequestBuiltin): Promise<ContractChart[]> {
  const all: ContractChart[] = [];
  for (const s of ALL_SOURCES) {
    try {
      const charts = await platformModule(s).charts(request);
      for (const chart of charts) all.push(chart);
    } catch {
      // 单源失败跳过
    }
  }
  return all;
}

/** 蓝本 allHotWords：四源合并，封顶 30 条 */
export async function allHotWords(request: RequestBuiltin): Promise<string[]> {
  const merged: string[] = [];
  for (const s of ALL_SOURCES) {
    try {
      const words = await platformModule(s).hotWords(request);
      for (const w of words) {
        if (merged.length >= 30) return merged;
        merged.push(w);
      }
    } catch {
      // 单源失败跳过
    }
  }
  return merged;
}
