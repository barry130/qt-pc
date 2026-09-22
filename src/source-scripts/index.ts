/**
 * 音源访问层统一入口（纯音源包版）。
 *
 * 页面一律从这里调"第三方源"动作，不直接 import ipc 里的对应命令。
 * 应用**不再内置**第三方音源实现：wyy/qq/kw/kg 的一切数据接口与取链都由
 * 引擎窗口加载的音源包（source-bundle.js，含全部第三方线路地址）承担，
 * 应用侧只保留 astral 后端与音源包两条网络通道——平台官方接口、聚合线路
 * 等 URL 只允许出现在音源包构建产物里（scripts/build-sources.mjs）。
 *
 * - local 源 → 本地扫描单元，第三方动作不适用（ensureScript 直接报错）；
 * - 音源包未安装/未就绪/调用失败 → 抛出带原因的统一错误（engineError）；
 * - 取链（playUrl）特殊：播放由 Rust 引擎主导，脚本路径通过
 *   resolvePlayUrl() 预解析 + set_resolved_play_url 回填引擎缓存接入；
 *   引擎未命中缓存时经 playurl_bridge 再问一次前端。失败返回空串。
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
import type {
  ContractChart,
  ContractPlaylistCategory,
  MusicInfo,
  Source,
} from "./contract";
import { engineInvoke, engineResolve, engineSnapshot } from "@/source-engine/client";

// ---------- 引擎调用 ----------

/** 音源包不可用时抛的错：按引擎生命周期给出可操作的原因 */
function engineError(entry: string): Error {
  const snap = engineSnapshot();
  switch (snap.phase) {
    case null:
    case "booting":
      return new Error(`音源包正在启动，请稍后再试（${entry}）`);
    case "builtin":
      // 引擎页已不再上报 builtin（无包时加载应用内嵌内置包，成功即 ready）；
      // 该值仅为兼容老宿主/异常态保留
      return new Error("音源包引擎未就绪（内置包未加载），请重启应用再试");
    case "error":
      return new Error(
        `音源包加载失败${snap.detail ? "：" + snap.detail : ""}，请到「设置 → 音源包」重新安装`,
      );
    default:
      return new Error(`音源包接口调用失败或超时（${entry}）`);
  }
}

/**
 * 音源数据接口统一调用：全部经引擎窗口转给音源包入口（__qtEntries）。
 * 引擎不可用 / 入口报错 / 超时 / 返回结构不符 → 抛 engineError 类错误。
 *
 * @param entry bundle 入口名（qt-entries.ts 的 __qtEntries 键）
 * @param args 入口参数（JSON 可序列化）
 * @param pick 从入口返回的 payload 里取本次结果；缺失/类型不符按失败处理
 */
async function sourceCall<T>(
  entry: string,
  args: Record<string, unknown>,
  pick: (payload: Record<string, unknown>) => T | undefined,
  timeoutMs?: number,
): Promise<T> {
  let payload: Record<string, unknown> | null;
  try {
    payload = await engineInvoke(entry, args, timeoutMs ?? 20_000);
  } catch (err) {
    // bundle 明确报错（入口不存在 / 入口内部失败）：带出原文，便于定位与提示更新
    throw new Error(`音源包调用失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (payload === null) throw engineError(entry);
  const picked = pick(payload);
  if (picked === undefined || picked === null) {
    throw new Error(`音源包返回结构不符（${entry}）`);
  }
  return picked;
}

// ---------- scheme 分发 ----------

/** local 源由本地路径单独处理，走到这里说明调用有误 */
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
  const list = await sourceCall<MusicInfo[]>(
    "search",
    { source, keyword, page, size },
    (p) => p.list as MusicInfo[] | undefined,
  );
  return list.map((m) => toAppTrack(m, source));
}

export async function searchAllMusicSources(
  keyword: string,
  page: number,
  size: number,
): Promise<Track[]> {
  const batches = await sourceCall<{ source: Source; list: MusicInfo[] }[]>(
    "searchAll",
    { keyword, page, size },
    (p) => p.batches as { source: Source; list: MusicInfo[] }[] | undefined,
  );
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
  const list = await sourceCall<Parameters<typeof toAppPlaylist>[0][]>(
    "searchPlaylists",
    { source, keyword, page, size },
    (p) => p.list as Parameters<typeof toAppPlaylist>[0][] | undefined,
  );
  return list.map(toAppPlaylist);
}

export async function searchArtists(
  source: SourceId,
  keyword: string,
  page: number,
  size: number,
): Promise<Artist[]> {
  ensureScript(source);
  const list = await sourceCall<{ id: string; name: string; picUrl: string }[]>(
    "searchArtists",
    { source, keyword, page, size },
    (p) => p.list as { id: string; name: string; picUrl: string }[] | undefined,
  );
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
  const list = await sourceCall<{ id: string; name: string; artist: string; picUrl: string }[]>(
    "searchAlbums",
    { source, keyword, page, size },
    (p) => p.list as { id: string; name: string; artist: string; picUrl: string }[] | undefined,
  );
  return list.map((item) => ({
    id: item.id,
    platform: source,
    name: item.name,
    artist: item.artist,
    picUrl: item.picUrl,
  }));
}

/**
 * 歌手列表（热门 / 按首字母）。
 *
 * `initial` 传空串表示热门；不支持字母筛选的音源会忽略它并返回热门列表，
 * 能力由返回里的 `initialSupported` 如实告知 —— UI 据此决定字母栏是否可点。
 */
export async function getArtistList(
  source: SourceId,
  initial: string,
  page: number,
  size: number,
): Promise<{ list: Artist[]; initialSupported: boolean; hasMore: boolean }> {
  ensureScript(source);
  const payload = await sourceCall<{
    list?: { id: string; name: string; picUrl: string; initial?: string }[];
    initialSupported?: boolean;
    hasMore?: boolean;
  }>("artistList", { source, initial, page, size }, (p) => p as {
    list?: { id: string; name: string; picUrl: string; initial?: string }[];
    initialSupported?: boolean;
    hasMore?: boolean;
  });
  const list = Array.isArray(payload.list) ? payload.list : [];
  return {
    list: list.map((item) => ({
      id: item.id,
      platform: source,
      name: item.name,
      picUrl: item.picUrl,
      initial: typeof item.initial === "string" ? item.initial : undefined,
    })),
    initialSupported: payload.initialSupported === true,
    hasMore: payload.hasMore === true,
  };
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
  const detail = await sourceCall<Parameters<typeof toAppPlaylist>[0]>(
    "albumDetail",
    { source, id },
    (p) => p.detail as Parameters<typeof toAppPlaylist>[0] | undefined,
  );
  return toAppPlaylist(detail);
}

/**
 * 歌手歌曲（分页，每页由调用方给 size）。
 *
 * 音源侧没有「按歌手 id 取歌」的免费接口，包里是**按歌手名搜索**；
 * 第一页顺带返回歌手头像 picUrl（包内只查第一页）。
 * 调用方必须翻页 —— 只取第一页会永远只有一页的量（曾写死 50 首）。
 */
export async function getArtistSongs(
  source: SourceId,
  name: string,
  page: number,
  size: number,
): Promise<{ songs: Track[]; picUrl: string }> {
  ensureScript(source);
  const payload = await sourceCall<{ songs?: MusicInfo[]; picUrl?: string }>(
    "artistSongs",
    { source, name, page, size },
    (p) => p as { songs?: MusicInfo[]; picUrl?: string },
  );
  const songs = Array.isArray(payload.songs) ? payload.songs : [];
  return {
    songs: songs.map((m) => toAppTrack(m, source)),
    picUrl: typeof payload.picUrl === "string" ? payload.picUrl : "",
  };
}

// ---------- 取链（脚本预解析 + 回填引擎缓存） ----------

/**
 * 预解析播放地址（播放动作发起前调用）：
 * 只走音源引擎窗口（远程音源包）——就绪才参与，超时/失败静默。
 * 解析结果回填 Rust 引擎的 PlayUrl 缓存，引擎播放时命中缓存直接使用。
 * 包内自带多线路换源与跨源兜底；返回空串 = 本次取链失败（由引擎兜底/报错）。
 */
export async function resolvePlayUrl(
  track: Track,
  quality: Quality,
): Promise<string> {
  ensureScript(track.platform);
  const source = track.platform as Source;
  try {
    const engineUrl = await engineResolve(source, fromAppTrack(track), quality);
    if (engineUrl.length > 0) {
      await ipc.setResolvedPlayUrl(track, quality, engineUrl);
      return engineUrl;
    }
  } catch {
    // 引擎层已尽力（多线路换源 + 跨源兜底）：本次播放失败
  }
  return "";
}

// ---------- 歌词 / 封面 ----------

export async function getLyric(track: Track): Promise<Lyric> {
  ensureScript(track.platform);
  const result = await sourceCall<{ lyric: string; translation: string }>(
    "lyric",
    { source: track.platform, song: fromAppTrack(track) },
    (p) => p as { lyric: string; translation: string },
  );
  return { lrc: result.lyric, translation: result.translation };
}

export async function getTrackCover(track: Track): Promise<string> {
  ensureScript(track.platform);
  return sourceCall<string>(
    "cover",
    { source: track.platform, song: fromAppTrack(track) },
    (p) => (typeof p.url === "string" ? p.url : undefined),
  );
}

// ---------- 歌单 ----------

export async function getPlaylistCategories(
  source: SourceId,
): Promise<PlaylistCategory[]> {
  ensureScript(source);
  const list = await sourceCall<ContractPlaylistCategory[]>(
    "playlistCategories",
    { source },
    (p) => p.list as ContractPlaylistCategory[] | undefined,
  );
  return list.map((item) => ({ id: item.id, name: item.name, group: item.group }));
}

/**
 * 歌单详情。**一次取全量曲目**（蓝本按 trackIds 批量取），包内不暴露分页，
 * 因此没有 page/size 参数：UI 侧不需要翻页，也不该以为有 100 首上限。
 */
export async function getPlaylistDetail(
  source: SourceId,
  id: string,
): Promise<Playlist> {
  ensureScript(source);
  const detail = await sourceCall<Parameters<typeof toAppPlaylist>[0]>(
    "playlistDetail",
    { source, id },
    (p) => p.detail as Parameters<typeof toAppPlaylist>[0] | undefined,
  );
  return toAppPlaylist(detail);
}

export async function getRecommendations(
  source: SourceId,
  category: string | null,
  page: number,
): Promise<Playlist[]> {
  ensureScript(source);
  const list = await sourceCall<Parameters<typeof toAppPlaylist>[0][]>(
    "recommendations",
    { source, category, page },
    (p) => p.list as Parameters<typeof toAppPlaylist>[0][] | undefined,
  );
  return list.map(toAppPlaylist);
}

// ---------- 榜单 / 新歌 / 热词 ----------

export async function getCharts(source: SourceId): Promise<Chart[]> {
  ensureScript(source);
  const list = await sourceCall<ContractChart[]>(
    "charts",
    { source },
    (p) => p.list as ContractChart[] | undefined,
  );
  return list.map(toAppChart);
}

export async function getAllCharts(): Promise<Chart[]> {
  const list = await sourceCall<ContractChart[]>(
    "allCharts",
    {},
    (p) => p.list as ContractChart[] | undefined,
  );
  return list.map(toAppChart);
}

/**
 * 榜单详情。**一次取全量**（包内最多 200 条），没有 page/size 参数：
 * 榜单本身有上限，UI 侧不需要翻页。
 */
export async function getChartDetail(chart: Chart): Promise<Track[]> {
  ensureScript(chart.platform);
  const list = await sourceCall<MusicInfo[]>(
    "chartDetail",
    { source: chart.platform, chart: fromAppChart(chart) },
    (p) => p.list as MusicInfo[] | undefined,
  );
  return list.map((m) => toAppTrack(m, chart.platform));
}

export async function getLatestSongs(
  source: SourceId,
  limit: number,
  offset: number,
): Promise<Track[]> {
  ensureScript(source);
  const list = await sourceCall<MusicInfo[]>(
    "latest",
    { source, limit, offset },
    (p) => p.list as MusicInfo[] | undefined,
  );
  return list.map((m) => toAppTrack(m, source));
}

export async function getAllLatestSongs(
  limit: number,
  offset: number,
): Promise<Track[]> {
  // 不走 bundle 的 allLatest 入口：它返回的 MusicInfo 不带 platform，四源混批后
  // 无法归属（取链依赖 platform），安卓端同样绕过它。这里逐源调 latest 入口，
  // 交错合并在宿主侧做（与蓝本同口径：wyy/kg 带 offset，单源失败跳过）。
  const perSource = Math.ceil(limit / 4) + 1;
  const sources: SourceId[] = ["wyy", "qq", "kw", "kg"];
  const batches = await Promise.all(
    sources.map(async (source) => {
      const pageOffset = source === "wyy" || source === "kg" ? offset : 0;
      try {
        return { source, list: await getLatestSongs(source, perSource, pageOffset) };
      } catch {
        return { source, list: [] as Track[] };
      }
    }),
  );
  const out: Track[] = [];
  for (let index = 0; index < perSource && out.length < limit; index++) {
    for (const batch of batches) {
      if (index < batch.list.length) out.push(batch.list[index]);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export async function getHotWords(source: SourceId): Promise<string[]> {
  ensureScript(source);
  return sourceCall<string[]>(
    "hotWords",
    { source },
    (p) => p.list as string[] | undefined,
  );
}

export async function getAllHotWords(): Promise<string[]> {
  return sourceCall<string[]>(
    "allHotWords",
    {},
    (p) => p.list as string[] | undefined,
  );
}

// ---------- MV ----------

export async function getVideos(
  source: SourceId,
  page: number,
  size: number,
): Promise<Video[]> {
  ensureScript(source);
  const list = await sourceCall<{ id: string; name: string; picUrl: string; singer: string }[]>(
    "videos",
    { source, page, size },
    (p) => p.list as { id: string; name: string; picUrl: string; singer: string }[] | undefined,
  );
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
  return sourceCall<string>(
    "videoUrl",
    { source, videoId, quality },
    (p) => (typeof p.url === "string" ? p.url : undefined),
  );
}
