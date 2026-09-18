/**
 * 音源访问层统一入口（全量版）。
 *
 * 页面一律从这里调"第三方源"动作，不直接 import ipc 里的对应命令：
 * - 第三方源（wyy/qq/kw/kg）→ 当前**指定方案**（内置 script = 官方接口 +
 *   实测第三方线路聚合链；schemes/ 下自注册的 premium = 剩余线路）；
 *   方案内部自带换源与跨源兜底，方案之间不再排优先级；
 * - local 源 → 本地扫描单元，这些第三方动作不适用（ensureScript 直接报错）。
 *
 * 原生 Rust Provider 已整体删除，脚本层是唯一的第三方实现。
 * 取链（playUrl）特殊：播放由 Rust 引擎主导，脚本路径通过
 * resolvePlayUrl() 预解析 + set_resolved_play_url 回填引擎缓存接入；
 * 引擎未命中缓存时经 playurl_bridge 再问一次前端。
 */
import * as ipc from "@/services/ipc";
import type {
  Album,
  Artist,
  Chart,
  Lyric,
  Playlist,
  PlaylistCategory,
  Quality,
  SourceId,
  Track,
  Video,
} from "@/types";
import { allCharts, allHotWords, allLatestBatches, allSearchBatches, artistSongs, search } from "./actions/aggregate";
import { songCover } from "./actions/cover";
import { getLyric as getLyricAction } from "./actions/lyric";
import { recommendations } from "./actions/recommendations";
import type {
  ContractChart,
  MusicInfo,
  Source,
} from "./contract";
import { hostRequest } from "./host-request";
import { LOCAL_PLATFORM } from "./chain-config";
import { createSourceLayer, type SourceLayerDeps } from "./layer";
import { engineResolve } from "@/source-engine/client";

// 平台无关入口由 layer.ts 提供（bundle 核心不含宿主实现）；主窗口层注入
// hostRequest + Windows 平台，P1 引擎窗口用自建 request 另建一层
export { createSourceLayer, type SourceLayerDeps };
const mainLayer = createSourceLayer({ request: hostRequest, platform: LOCAL_PLATFORM });
import { kg } from "./platforms/kg";
import { kw } from "./platforms/kw";
import { qq } from "./platforms/qq";
import { wyy } from "./platforms/wyy";

// ---------- scheme 分发 ----------

/** 第三方动作仅脚本层承担；local 源由本地路径单独处理，走到这里说明调用有误 */
function ensureScript(source: SourceId): void {
  if (source === "local") throw new Error("local 源不支持该动作");
}

// ---------- 契约 ↔ App 模型映射 ----------

function toAppTrack(item: MusicInfo, platform: SourceId): Track {
  return {
    id: item.id,
    platform,
    title: item.name,
    singer: item.singer,
    album: item.album,
    picUrl: item.picUrl,
    duration: item.interval,
    musicId: item.musicId ?? null,
  };
}

function fromAppTrack(track: Track): MusicInfo {
  return {
    id: track.id,
    name: track.title,
    singer: track.singer,
    album: track.album,
    picUrl: track.picUrl,
    interval: track.duration,
    musicId: track.musicId,
  };
}

function toAppPlaylist(item: { id: string; platform: Source; name: string; picUrl: string; playCount: string; description?: string | null; tracks?: MusicInfo[] }, ): Playlist {
  const platform = item.platform as SourceId;
  return {
    id: item.id,
    platform,
    name: item.name,
    picUrl: item.picUrl,
    playCount: item.playCount,
    description: item.description ?? null,
    tracks: item.tracks?.map((t) => toAppTrack(t, platform)),
  };
}

function toAppChart(item: ContractChart): Chart {
  return {
    id: item.id,
    platform: item.platform as SourceId,
    name: item.name,
    picUrl: item.picUrl,
    description: item.description,
  };
}

function fromAppChart(chart: Chart): ContractChart {
  return {
    id: chart.id,
    platform: chart.platform as Source,
    name: chart.name,
    picUrl: chart.picUrl,
    description: chart.description,
  };
}

// ---------- 搜索 ----------

export async function searchMusic(
  keyword: string,
  source: SourceId,
  page: number,
  size: number,
): Promise<Track[]> {
  ensureScript(source);
  const list = await search(hostRequest, source as Source, keyword, page, size);
  return list.map((m) => toAppTrack(m, source));
}

export async function searchAllMusicSources(
  keyword: string,
  page: number,
  size: number,
): Promise<Track[]> {
  const batches = await allSearchBatches(hostRequest, keyword, page, size);
  const out: Track[] = [];
  for (const batch of batches) {
    for (const m of batch.list) out.push(toAppTrack(m, batch.source));
  }
  return out;
}

export async function searchPlaylists(
  source: SourceId,
  keyword: string,
  page: number,
  size: number,
): Promise<Playlist[]> {
  ensureScript(source);
  const platform = platformOf(source as Source);
  const list = await platform.playlistSearch(hostRequest, keyword, page, size);
  return list.map(toAppPlaylist);
}

export async function searchArtists(
  source: SourceId,
  keyword: string,
  page: number,
  size: number,
): Promise<Artist[]> {
  ensureScript(source);
  const list = await platformOf(source as Source).artistSearch(hostRequest, keyword, page, size);
  return list.map((item) => ({
    id: item.id,
    platform: source,
    name: item.name,
    picUrl: item.picUrl,
  }));
}

export async function searchAlbums(
  source: SourceId,
  keyword: string,
  page: number,
  size: number,
): Promise<Album[]> {
  ensureScript(source);
  const list = await platformOf(source as Source).albumSearch(hostRequest, keyword, page, size);
  return list.map((item) => ({
    id: item.id,
    platform: source,
    name: item.name,
    artist: item.artist,
    picUrl: item.picUrl,
  }));
}

/**
 * 专辑详情（蓝本 albumDetail :1758，四平台全量移植）：
 * 返回结构与歌单详情一致（Playlist + tracks），供 UI 以歌单详情形态打开专辑。
 */
export async function getAlbumDetail(
  source: SourceId,
  id: string,
): Promise<Playlist> {
  ensureScript(source);
  const detail = await platformOf(source as Source).albumDetail(hostRequest, id);
  return toAppPlaylist(detail);
}

export async function getArtistSongs(
  source: SourceId,
  name: string,
  page: number,
  size: number,
): Promise<Track[]> {
  ensureScript(source);
  const result = await artistSongs(hostRequest, source as Source, name, page, size);
  return result.songs.map((m) => toAppTrack(m, source));
}

// ---------- 取链（脚本预解析 + 回填引擎缓存） ----------

/**
 * 预解析播放地址（播放动作发起前调用）：
 * ① 音源引擎窗口（远程音源包，P1）——就绪才参与，超时/失败静默；
 * ② 主窗口**内置实现**回退（当前指定方案）——引擎不可用或空串时兜底。
 * 解析结果回填 Rust 引擎的 PlayUrl 缓存，引擎播放时命中缓存直接使用。
 * 方案内部自带多线路换源与跨源兜底；两路都空 = 本次取链失败（由引擎
 * 兜底/报错），不再横向切换其他方案（2026-09-18 起取消方案间优先级）。
 */
export async function resolvePlayUrl(
  track: Track,
  quality: Quality,
): Promise<string> {
  ensureScript(track.platform);
  const music = fromAppTrack(track);
  const source = track.platform as Source;
  // ① 远程音源包（引擎窗口）：任何失败静默回退，不影响可用性
  try {
    const engineUrl = await engineResolve(source, music, quality);
    if (engineUrl.length > 0) {
      await ipc.setResolvedPlayUrl(track, quality, engineUrl);
      return engineUrl;
    }
  } catch {
    // 引擎层已尽力，转内置
  }
  // ② 内置实现（编译进应用的脚本包）
  try {
    const url = await mainLayer.resolvePlayUrl(source, music, quality);
    if (url.length > 0) {
      await ipc.setResolvedPlayUrl(track, quality, url);
      return url;
    }
  } catch {
    // 方案内已尽力换源，仍失败则本次播放失败
  }
  return "";
}

// ---------- 歌词 / 封面 ----------

export async function getLyric(track: Track): Promise<Lyric> {
  ensureScript(track.platform);
  const result = await getLyricAction(hostRequest, track.platform as Source, fromAppTrack(track));
  return { lrc: result.lyric, translation: result.translation };
}

export async function getTrackCover(track: Track): Promise<string> {
  ensureScript(track.platform);
  return songCover(hostRequest, track.platform as Source, fromAppTrack(track));
}

// ---------- 歌单 ----------

export async function getPlaylistCategories(
  source: SourceId,
): Promise<PlaylistCategory[]> {
  ensureScript(source);
  const list = await platformOf(source as Source).playlistCategories(hostRequest);
  return list.map((item) => ({ id: item.id, name: item.name, group: item.group }));
}

/** 蓝本歌单详情一次取全量曲目（trackIds 批量），分页参数由 UI 侧消化 */
export async function getPlaylistDetail(
  source: SourceId,
  id: string,
  _page: number,
  _size: number,
): Promise<Playlist> {
  ensureScript(source);
  const detail = await platformOf(source as Source).playlistDetail(hostRequest, id);
  return toAppPlaylist(detail);
}

export async function getRecommendations(
  source: SourceId,
  category: string | null,
  page: number,
): Promise<Playlist[]> {
  ensureScript(source);
  const list = await recommendations(hostRequest, source as Source, category, page);
  return list.map(toAppPlaylist);
}

// ---------- 榜单 / 新歌 / 热词 ----------

export async function getCharts(source: SourceId): Promise<Chart[]> {
  ensureScript(source);
  const list = await platformOf(source as Source).charts(hostRequest);
  return list.map(toAppChart);
}

export async function getAllCharts(): Promise<Chart[]> {
  const list = await allCharts(hostRequest);
  return list.map(toAppChart);
}

/** 蓝本榜单详情一次取全量（最多 200 条），分页参数由 UI 侧消化 */
export async function getChartDetail(
  chart: Chart,
  _page: number,
  _size: number,
): Promise<Track[]> {
  ensureScript(chart.platform);
  const list = await platformOf(chart.platform as Source).chartDetail(hostRequest, fromAppChart(chart));
  return list.map((m) => toAppTrack(m, chart.platform));
}

export async function getLatestSongs(
  source: SourceId,
  limit: number,
  offset: number,
): Promise<Track[]> {
  ensureScript(source);
  const list = await platformOf(source as Source).latest(hostRequest, limit, offset);
  return list.map((m) => toAppTrack(m, source));
}

export async function getAllLatestSongs(
  limit: number,
  offset: number,
): Promise<Track[]> {
  const batches = await allLatestBatches(hostRequest, limit, offset);
  // 蓝本 allLatest 的交错合并：按索引轮流从四源取，凑满 limit
  const perSource = Math.ceil(limit / 4) + 1;
  const out: Track[] = [];
  for (let index = 0; index < perSource && out.length < limit; index++) {
    for (const batch of batches) {
      if (index < batch.list.length) out.push(toAppTrack(batch.list[index], batch.source));
      if (out.length >= limit) break;
    }
  }
  return out;
}

export async function getHotWords(source: SourceId): Promise<string[]> {
  ensureScript(source);
  return platformOf(source as Source).hotWords(hostRequest);
}

export async function getAllHotWords(): Promise<string[]> {
  return allHotWords(hostRequest);
}

// ---------- MV ----------

export async function getVideos(
  source: SourceId,
  page: number,
  size: number,
): Promise<Video[]> {
  ensureScript(source);
  const list = await platformOf(source as Source).videos(hostRequest, page, size);
  return list.map((item) => ({
    id: item.id,
    platform: source,
    name: item.name,
    picUrl: item.picUrl,
    singer: item.singer,
  }));
}

export async function getVideoUrl(
  source: SourceId,
  videoId: string,
  quality: string,
): Promise<string> {
  ensureScript(source);
  return platformOf(source as Source).videoUrl(hostRequest, videoId, quality);
}

// ---------- 平台模块路由 ----------

function platformOf(source: Source) {
  if (source === "qq") return qq;
  if (source === "kw") return kw;
  if (source === "kg") return kg;
  return wyy;
}
