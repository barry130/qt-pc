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
import { engineInvoke, engineResolve, engineSnapshot, INVOKE_TIMEOUT_MS } from "@/source-engine/client";
import { rememberPlayUrlLine, rememberPlayUrlMiss } from "./playurl-line";
// 包内 parseSheet 入口不可用（老包 / 引擎未就绪）时的本地回退实现
import { parsePlaylistInput as localParsePlaylistInput } from "@/lib/playlist-link";
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
    // 默认超时单源于 client.ts 的 INVOKE_TIMEOUT_MS：此前这里重复定义
    // 20_000 字面量，client 调整时这里会静默漂移
    payload = await engineInvoke(entry, args, timeoutMs ?? INVOKE_TIMEOUT_MS);
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

/** 聚合搜索的分批结果：单源一批，platform 已归属到每首曲目。
 *  source 不含 "local"（bundle 里的 searchAll 只搜在线源），展示名走注册表。 */
export interface SearchSourceBatch {
  source: Exclude<SourceId, "local">;
  tracks: Track[];
}

/**
 * 聚合搜索（保留分批结构）：搜索页「聚合」模式按源分组展示用。
 * 与单源 search 同一个 bundle 入口，只是打多源 ——
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
 * 搜索类接口的每页条数上限 —— **由音源包声明，宿主不再持有清单**。
 *
 * 上游对超限请求的处理方式完全不同，必须按音源取真实上限，「满页 = 还有下一页」
 * 的推断才成立（否则详情页会少一大截或一页不返回）。历史上这张表写死在宿主：
 *   kw 100 / qq 50 / kg 30 / wyy 100（2026-09-22 实测：qq n≥100 返回 0 条、
 *   kg pagesize 恒截成 30、wyy limit=200 返回 0 条）。
 * 2026-10 全开放改造后，上限搬到包侧 platforms/*.ts 的 `searchPageMax` 自述，
 * 经 `sourceRegistry` 入口下发；新增音源只需在包里声明，宿主自动跟随。
 *
 * 未声明（旧版数据包 / 引擎未就绪）时按 DEFAULT_SEARCH_PAGE_MAX 兜底；
 * 本地源不走网络接口，同样取兜底值。
 */
export const DEFAULT_SEARCH_PAGE_MAX = 50;

/** 注册表快照：getSourceRegistry 成功后写入，供同步读取每源能力自述（clamp 用）。
 *  取失败时**保留上一次**——引擎重启窗口期沿用旧值比退回兜底更接近真实上限。 */
let registrySnapshot: SourceRegistry | null = null;

/** 该音源的每页条数上限（包侧声明 → 快照读取；未声明走兜底） */
export function searchPageMaxOf(source: SourceId): number {
  if (source === "local") return DEFAULT_SEARCH_PAGE_MAX;
  const declared = registrySnapshot?.sources.find((s) => s.id === source)?.searchPageMax;
  return typeof declared === "number" && Number.isFinite(declared) && declared > 0
    ? Math.floor(declared)
    : DEFAULT_SEARCH_PAGE_MAX;
}

/** 该音源的 latest() 是否透传 offset（包侧声明 → 快照读取；未声明按不透传） */
export function latestUsesOffsetOf(source: SourceId): boolean {
  return registrySnapshot?.sources.find((s) => s.id === source)?.latestUsesOffset === true;
}

/** 把调用方要的每页条数收敛到该音源的真实上限 */
export function clampSearchPageSize(source: SourceId, size: number): number {
  const max = searchPageMaxOf(source);
  return size > max ? max : size;
}

/**
 * 歌手歌曲（分页，每页由调用方给 size）。
 *
 * 2026-10-06：`artistId` 是歌手真实 id，给了包里就走**按 id 取作品**（wyy/kw/kg/qq 各有
 * 端点，见各平台 artistWorks），不再把同名歌手的歌混进来；不给/取不到才退回歌手名搜索
 * —— 退回判断在包内做，宿主只要把 id 透传就行。
 * 第一页顺带返回歌手头像 picUrl（包内只查第一页）。
 * 调用方必须翻页 —— 只取第一页会永远只有一页的量（曾写死 50 首）；
 * 且必须用 `searchPageMaxOf` 给出的每页上限，传超限值会静默截断甚至返回空。
 */
export async function getArtistSongs(
  source: SourceId,
  name: string,
  page: number,
  size: number,
  artistId = "",
): Promise<{ songs: Track[]; picUrl: string; hasMore: boolean }> {
  ensureScript(source);
  const payload = await callArtistSongsPayload(source, name, page, size, artistId);
  const songs = Array.isArray(payload.songs) ? payload.songs : [];
  return {
    songs: songs.map((m) => toAppTrack(m, source)),
    picUrl: typeof payload.picUrl === "string" ? payload.picUrl : "",
    hasMore: hasMoreOf(payload, songs.length),
  };
}

/** artistSongs 的原始应答（PC 侧只有 getArtistSongs 一处消费者，抽出来只为可读） */
async function callArtistSongsPayload(
  source: SourceId,
  name: string,
  page: number,
  size: number,
  artistId: string,
): Promise<{ songs?: MusicInfo[]; picUrl?: string; hasMore?: boolean }> {
  type Payload = { songs?: MusicInfo[]; picUrl?: string; hasMore?: boolean };
  return sourceCall<Payload>(
    "artistSongs",
    { source, name, page, size: clampSearchPageSize(source, size), id: artistId },
    (p) => p as Payload,
  );
}

/**
 * 本页之后是否还有。
 *
 * 2026-10-07：数据包开始给权威 `hasMore`（走真 id 时就是平台模块算出的 isEnd）——
 * 歌手作品是「按名搜一批、再按 singer.mid 过滤出本人」的**过滤型**列表，逐页条数
 * 天然不齐（实测 QQ 周杰伦 100/90/96/93/77/70/61/52/37/23），按「本页条数 < pageSize」
 * 推断会在真正到底之前收尾（正是「pc 768 首 / 移动 998 首」的成因）。
 *
 * 包没给（旧包 / 旧宿主契约）时退回「本页非空 = 还有」：多翻一页问到空页为止，
 * 比按页大小猜更安全 —— 空页判据在六个音源上都验过，翻过尾页只会回空数组、不抛错。
 */
function hasMoreOf(payload: { hasMore?: boolean }, songCount: number): boolean {
  if (typeof payload.hasMore === "boolean") return payload.hasMore;
  return songCount > 0;
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
  return (await resolvePlayUrlDetailed(track, quality)).url;
}

/**
 * 预解析播放地址，**带失败分级**（2026-10-03 弱网修复）。
 *
 * `stalled = true` 表示本次失败是环境问题（弱网 / 引擎页未就绪 / 应答超时），
 * 而非「这个音源确实给不出这首歌的地址」。引擎侧据此不把曲目拉黑、
 * 不计入连续失败熔断——弱网下 5 首超时就关掉自动切歌，正是用户反馈的
 * 「网络质量差一点就疯狂不可用」。
 *
 * `referer` 随地址一并回填：宿主（播放 range_reader / 下载 download.rs）拿
 * 这个地址去 CDN 取字节时要带的头，由音源包按源声明下发（B 站部分 CDN 节点
 * 无 Referer 直接 403）。空串 = 不发。
 *
 * `size` / `actualQuality` 是 2026-10-06 加的「取链诚实性」字段：包侧在 Range
 * 预检里顺手量了文件总长，并把请求档按实测码率重标（只降不升）。宿主此前只
 * 知道「请求的是 flac」，于是下载把 320k 的文件命名成 `.flac` —— 虚标。
 * `size = null` / `actualQuality = ""` 表示这次没测出来，调用方按未知处理。
 */
export async function resolvePlayUrlDetailed(
  track: Track,
  quality: Quality,
): Promise<{ url: string; stalled: boolean; referer: string; size: number | null; actualQuality: string }> {
  let stalled = true;
  try {
    ensureScript(track.platform);
  } catch {
    // local 源不走脚本取链：是明确的用法错误（内容问题），不算环境问题
    return { url: "", stalled: false, referer: "", size: null, actualQuality: "" };
  }
  const source = track.platform as Source;
  try {
    const resolved = await engineResolve(source, fromAppTrack(track), quality);
    if (resolved.url.length > 0) {
      // 命中线路与地址一起记（管理端「当前播放地址」要显示走的是哪条源）：
      // 地址被引擎缓存复用，线路必须跟着地址走，不能只看最后一次取链
      rememberPlayUrlLine(track, quality, resolved.line);
      // 回填时连 Referer 一起写进引擎缓存：缓存里的地址后续由播放/下载直接
      // 取字节，没有头就等于把能播的地址变成 403（见 EngineResolved.referer）
      await ipc.setResolvedPlayUrl(
        track,
        quality,
        resolved.url,
        resolved.referer,
        resolved.size,
        resolved.actualQuality,
      );
      return {
        url: resolved.url,
        stalled: false,
        referer: resolved.referer,
        size: resolved.size,
        actualQuality: resolved.actualQuality,
      };
    }
    // 失败死因（逐线路 trace）也记下来：面板显示「上次取链死因」，
    // 否则「取不到地址」在 PC 上完全不可诊断（2026-09-24 kg 不换源即此类）
    rememberPlayUrlMiss(track, quality, resolved.error);
    maybeEmitPlayPackMissing(resolved.error);
    stalled = resolved.stalled;
  } catch (e) {
    // 引擎层已尽力（多线路换源 + 跨源兜底）：本次播放失败
    const msg = e instanceof Error ? e.message : String(e);
    rememberPlayUrlMiss(track, quality, msg);
    maybeEmitPlayPackMissing(msg);
    stalled = true;
  }
  return { url: "", stalled, referer: "", size: null, actualQuality: "" };
}

// ---------- 歌词 / 封面 ----------

export async function getLyric(track: Track): Promise<Lyric> {
  ensureScript(track.platform);
  // 2026-10-06：逐字与罗马音是可选面——老包只回 lyric/translation 时两个新字段
  // 是 undefined，落下来就是空串，播放页照旧按整行高亮渲染。
  const result = await sourceCall<{
    lyric: string;
    translation: string;
    wordByWord?: string;
    romanization?: string;
  }>(
    "lyric",
    { source: track.platform, song: fromAppTrack(track) },
    (p) => p as { lyric: string; translation: string; wordByWord?: string; romanization?: string },
  );
  return {
    lrc: result.lyric,
    translation: result.translation,
    wordByWord: result.wordByWord ?? "",
    romanization: result.romanization ?? "",
  };
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

/**
 * 歌单分享链接 / 裸 ID 解析（2026-10-06，报告 §4 第 11 项）。
 *
 * 解析的权威实现已下沉到音源包（`qt-sources/src/actions/sheet-import.ts`，
 * 入口 `parseSheet`）——此前 PC 的 lib/playlist-link.ts 与安卓
 * services/music-api.ts 各写一份且已漂移（安卓缺 kg 原生 ID、缺显式 id 提取、
 * 缺 .html 还原）。本函数优先调包内入口，拿不到（老包 26 入口、引擎未就绪、
 * 调用失败）就地回退到 PC 本地那份，保证老包环境下行为完全不变。
 *
 * **只解析、不发请求**：拿到 {platform,id} 后由调用方复用 getPlaylistDetail。
 */
export async function parseSheetInput(
  text: string,
  fallback?: SourceId,
): Promise<{ platform: SourceId; id: string } | null> {
  const local = localParsePlaylistInput(text, fallback);
  try {
    const parsed = await sourceCall<{ platform?: string; id?: string } | null>(
      "parseSheet",
      { text, source: fallback ?? "" },
      (p) => (p === null ? null : (p as { platform?: string; id?: string })),
      // 纯解析不该占满默认 20s 引擎超时；包没就绪时尽早回本地实现
      3_000,
    );
    if (
      parsed &&
      typeof parsed.platform === "string" &&
      typeof parsed.id === "string" &&
      parsed.platform.length > 0 &&
      parsed.id.length > 0
    ) {
      return { platform: parsed.platform as SourceId, id: parsed.id };
    }
    // 包侧明确说「无法识别」：尊重包的判断（它是权威），不再用本地兜底覆盖，
    // 否则包侧修好的边界（如 ?chain= 短链）会被旧逻辑重新判成错的平台。
    if (parsed === null) return null;
  } catch {
    // 引擎不可用 / 入口不存在（老包）→ 走本地实现
  }
  return local;
}

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
  sort: string = "",
): Promise<Playlist[]> {
  ensureScript(source);
  const list = await sourceCall<Parameters<typeof toAppPlaylist>[0][]>(
    "recommendations",
    // sort（v5 契约）：包侧 playlistSorts 声明的 id 原样透传（wyy → order=、
    // kg → t=）；空串/不支持排序的源 = 各平台默认
    { source, category, page, sort },
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

/**
 * 全源聚合榜单。**宿主 PC 端已不再使用**（排行榜页与发现页都改为按音源取，
 * 见 ChartsPage / DiscoverPage），保留是因为它是数据包对外契约的一部分
 * （allCharts 入口，其它宿主/安卓端仍在用）。
 */
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
    const registry = await sourceCall<SourceRegistry>("sourceRegistry", {}, (p) => {
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
    // 能力自述（每页上限 / 是否透传 offset）靠这份快照同步读取：
    // clampSearchPageSize / latestUsesOffsetOf 是同步 API，不能 await。
    if (registry !== null) registrySnapshot = registry;
    return registry;
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
  // 交错合并在宿主侧做（与蓝本同口径：只有自述支持翻页的源才透传 offset，
  // 单源失败跳过）。源清单与「谁支持翻页」都来自数据包注册表。
  const registry = await getSourceRegistry();
  const sources: SourceId[] = (registry?.sources ?? [])
    .map((s) => s.id)
    .filter((id) => id !== "local");
  if (sources.length === 0) return [];
  const perSource = Math.ceil(limit / sources.length) + 1;
  const batches = await Promise.all(
    sources.map(async (source) => {
      // 早期写死 `source === "wyy" || source === "kg"`；现在读包侧自述
      // （platforms/*.ts 的 latestUsesOffset），新增源在包里声明即可。
      const pageOffset = latestUsesOffsetOf(source) ? offset : 0;
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

// ---------- MV ----------
// MV/视频接口已随双音源包架构移除（播放包不再产出 videoUrl，客户端全链路删除）。

