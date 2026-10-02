/**
 * 音源访问层统一入口（双音源包架构）。
 *
 * 页面一律从这里调"在线源"动作，不直接 import ipc 里的对应命令。
 * 在线能力拆成两个包，都由引擎窗口装载：
 * - **数据包**（meta-bundle.js，低风险）：搜索/歌单/榜单/歌词/封面，不内置，
 *   用户在「设置 → 音源包」安装（官方 manifest 或直链），未装 = 数据面下线；
 * - **播放包**（play-bundle.js，高风险）：取链线路，同样不内置，用户在
 *   「设置 → 音源包」自行安装（官方 manifest 或直链），可多包共存。
 * 应用侧只保留 astral 后端与引擎两条网络通道——平台官方接口、聚合线路等
 * URL 只允许出现在音源包构建产物里（qt-sources，scripts/build-sources.mjs）。
 *
 * - local 源 → 本地扫描单元，在线动作不适用（ensureScript 直接报错）；
 * - 引擎未就绪/调用失败 → 抛出带原因的统一错误（engineError）；
 * - 取链（playUrl）特殊：播放由 Rust 引擎主导，脚本路径通过
 *   resolvePlayUrl() 预解析 + set_resolved_play_url 回填引擎缓存接入；
 *   引擎未命中缓存时经 playurl_bridge 再问一次前端。失败返回空串；
 *   缺播放包时派发 qt-play-pack-missing 事件（PlayPackPrompt 弹安装引导）。
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
  SourceRegistry,
  Track,
} from "@/types";
import type {
  ContractChart,
  ContractPlaylistCategory,
  MusicInfo,
  Source,
} from "@/source-scripts/qt-contract/contract";
import { engineInvoke, engineResolve, engineSnapshot } from "@/source-engine/client";
import { rememberPlayUrlLine, rememberPlayUrlMiss } from "./playurl-line";
import { PER_SOURCE_TIMEOUT_MS, withTimeoutMs } from "@/source-scripts/qt-contract/timeout";

// ---------- 引擎调用 ----------

/** 引擎（数据包）不可用时抛的错：按引擎生命周期给出可操作的原因 */
function engineError(entry: string): Error {
  const snap = engineSnapshot();
  switch (snap.phase) {
    case null:
    case "booting":
      return new Error(`音源引擎正在启动，请稍后再试（${entry}）`);
    case "error":
      return new Error(
        `音源引擎加载失败${snap.detail ? "：" + snap.detail : ""}，请重启应用或升级到最新版本`,
      );
    default:
      return new Error(`音源接口调用失败或超时（${entry}）`);
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

export function toAppTrack(item: MusicInfo, platform: SourceId): Track {
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
  const batches = await searchAllBatches(keyword, page, size);
  return batches.flatMap((b) => b.tracks);
}

/** 聚合搜索的分批结果：单源一批，platform 已归属到每首曲目。
 *  source 不含 "local"（bundle 里的 searchAll 只搜在线源），展示名走注册表。 */
export interface SearchSourceBatch {
  source: Exclude<SourceId, "local">;
  tracks: Track[];
}

/**
 * 聚合搜索（保留分批结构）：搜索页「聚合」模式按源分组展示用。
 * 与 searchAllMusicSources 同一个 bundle 入口，只是不做拍平合并 ——
 * UI 需要知道每条结果来自哪个源来分组/打标。
 */
export async function searchAllBatches(
  keyword: string,
  page: number,
  size: number,
): Promise<SearchSourceBatch[]> {
  const batches = await sourceCall<{ source: Source; list: MusicInfo[] }[]>(
    "searchAll",
    { keyword, page, size },
    (p) => p.batches as { source: Source; list: MusicInfo[] }[] | undefined,
  );
  return batches.map((batch) => ({
    source: batch.source as Exclude<SourceId, "local">,
    tracks: batch.list.map((m) =>
      toAppTrack(m, batch.source as Exclude<SourceId, "local">),
    ),
  }));
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
 * 搜索类接口的每页条数上限（2026-09-22 实测）。
 *
 * 上游对超限请求的处理方式完全不同，必须按音源取真实上限，
 * 「满页 = 还有下一页」的推断才成立（否则详情页会少一大截或一页不返回）：
 * - kw ：rn 无 100 上限（50/100/200 都给满）
 * - qq ：n=50 正常，n≥100 **返回 0 条**（接口当参数错误，不是空结果）
 * - kg ：pagesize 恒被截成 30（要 50/100/200 都只给 30）
 * - wyy：limit=100 正常，limit=200 **返回 0 条**
 *
 * 本地源（local）不走这些网络接口，取 50 兜底。
 */
export const SEARCH_PAGE_MAX: Record<SourceId, number> = {
  kw: 100,
  qq: 50,
  kg: 30,
  wyy: 100,
  local: 50,
};

/** 把调用方要的每页条数收敛到该音源的真实上限 */
export function clampSearchPageSize(source: SourceId, size: number): number {
  const max = SEARCH_PAGE_MAX[source];
  return max != null && size > max ? max : size;
}

/**
 * 歌手歌曲（分页，每页由调用方给 size）。
 *
 * 音源侧没有「按歌手 id 取歌」的免费接口，包里是**按歌手名搜索**；
 * 第一页顺带返回歌手头像 picUrl（包内只查第一页）。
 * 调用方必须翻页 —— 只取第一页会永远只有一页的量（曾写死 50 首）；
 * 且必须用 `SEARCH_PAGE_MAX` 里的每页上限，传超限值会静默截断甚至返回空。
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
    { source, name, page, size: clampSearchPageSize(source, size) },
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
 * 数据包取链入口的「未装播放包」错误标记。
 * 与 qt-sources meta-entries.ts 的 PLAY_PACK_MISSING_MESSAGE 前缀保持一致：
 * 引擎页 resolve 失败时把错误文本带回来，这里据此弹安装引导。
 */
export const PLAY_PACK_MISSING_MARKER = "未安装播放音源包";

/** 取链失败原因若为缺播放包 → 派发全局事件（PlayPackPrompt 弹安装引导） */
function maybeEmitPlayPackMissing(errText: string): void {
  if (errText.includes(PLAY_PACK_MISSING_MARKER)) {
    window.dispatchEvent(new CustomEvent("qt-play-pack-missing"));
  }
}

/**
 * 预解析播放地址（播放动作发起前调用）：
 * 只走音源引擎窗口——数据包/播放包都按本地安装状态装配，就绪才参与，
 * 超时/失败静默。解析结果回填 Rust 引擎的 PlayUrl 缓存，引擎播放时命中
 * 缓存直接使用。包内自带多线路换源与跨源兜底；返回空串 = 本次取链失败
 * （由引擎兜底/报错）。
 */
export async function resolvePlayUrl(
  track: Track,
  quality: Quality,
): Promise<string> {
  ensureScript(track.platform);
  const source = track.platform as Source;
  try {
    const resolved = await engineResolve(source, fromAppTrack(track), quality);
    if (resolved.url.length > 0) {
      // 命中线路与地址一起记（管理端「当前播放地址」要显示走的是哪条源）：
      // 地址被引擎缓存复用，线路必须跟着地址走，不能只看最后一次取链
      rememberPlayUrlLine(track, quality, resolved.line);
      await ipc.setResolvedPlayUrl(track, quality, resolved.url);
      return resolved.url;
    }
    // 失败死因（逐线路 trace）也记下来：面板显示「上次取链死因」，
    // 否则「取不到地址」在 PC 上完全不可诊断（2026-09-24 kg 不换源即此类）
    rememberPlayUrlMiss(track, quality, resolved.error);
    maybeEmitPlayPackMissing(resolved.error);
  } catch (e) {
    // 引擎层已尽力（多线路换源 + 跨源兜底）：本次播放失败
    const msg = e instanceof Error ? e.message : String(e);
    rememberPlayUrlMiss(track, quality, msg);
    maybeEmitPlayPackMissing(msg);
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

// ---------- 注册表 ----------

/**
 * 数据包声明的音源/音质清单（`__qtEntries.sourceRegistry`）。
 * 音源 id/名称/色值与音质档位的**唯一真源**在 qt-sources 的 registry.ts，
 * 宿主 UI 的选项列表一律从这里取。引擎未就绪 / 旧版数据包无该入口 /
 * 返回结构不符 → null（调用方按空清单处理，本地音乐不受影响）。
 */
export async function getSourceRegistry(): Promise<SourceRegistry | null> {
  try {
    return await sourceCall<SourceRegistry>("sourceRegistry", {}, (p) => {
      const sources = p.sources;
      const qualities = p.qualities;
      if (!Array.isArray(sources) || !Array.isArray(qualities)) return undefined;
      const srcOk = sources.every(
        (s) =>
          s && typeof s === "object" &&
          typeof (s as RegistryLike).id === "string" &&
          typeof (s as RegistryLike).name === "string",
      );
      const qOk = qualities.every(
        (q) =>
          q && typeof q === "object" &&
          typeof (q as RegistryLike).id === "string" &&
          typeof (q as RegistryLike).name === "string",
      );
      if (!srcOk || !qOk || sources.length === 0) return undefined;
      return { sources: sources as SourceRegistry["sources"], qualities: qualities as SourceRegistry["qualities"] };
    });
  } catch {
    // 引擎启动中 / 入口不存在（旧版数据包）：不算错误，交给上层重试
    return null;
  }
}

/** getSourceRegistry 里做形状校验用的最小结构 */
interface RegistryLike {
  id: unknown;
  name: unknown;
}

export async function getAllLatestSongs(
  limit: number,
  offset: number,
): Promise<Track[]> {
  // 不走 bundle 的 allLatest 入口：它返回的 MusicInfo 不带 platform，多源混批后
  // 无法归属（取链依赖 platform），安卓端同样绕过它。这里逐源调 latest 入口，
  // 交错合并在宿主侧做（与蓝本同口径：wyy/kg 带 offset，单源失败跳过）。
  // 源清单来自数据包注册表——包里少了谁，这里就少拉谁。
  const registry = await getSourceRegistry();
  const sources: SourceId[] = (registry?.sources ?? [])
    .map((s) => s.id)
    .filter((id) => id !== "local");
  if (sources.length === 0) return [];
  const perSource = Math.ceil(limit / sources.length) + 1;
  const batches = await Promise.all(
    sources.map(async (source) => {
      const pageOffset = source === "wyy" || source === "kg" ? offset : 0;
      try {
        return {
          source,
          // 单项超时：一个平台挂死不该让"最新音乐"整块等到客户端 20s 上限。
          // 超时按"该源本次失败"处理（空列表），其余三源的结果照常交错展示。
          list: await withTimeoutMs(
            getLatestSongs(source, perSource, pageOffset),
            PER_SOURCE_TIMEOUT_MS,
            `${source} 最新`,
          ),
        };
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
// MV/视频接口已随双音源包架构移除（播放包不再产出 videoUrl，客户端全链路删除）。

