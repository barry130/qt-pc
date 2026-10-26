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
  AudioProgram,
  Chart,
  Lyric,
  Playlist,
  PlaylistCategory,
  Quality,
  SourceId,
  SourceOfficialQuality,
  SourceQualityProfile,
  SourceRegistry,
  Track,
} from "@/types";
import type {
  ContractChart,
  ContractAudioProgram,
  ContractAudioProgramDetail,
  ContractPlaylistCategory,
  MusicInfo,
  Source,
} from "@/source-scripts/qt-contract/contract";
import { engineInvoke, engineResolve, engineSnapshot, INVOKE_TIMEOUT_MS } from "@/source-engine/client";
import { rememberPlayUrlLine, rememberPlayUrlMiss } from "./playurl-line";
// 包内 parseSheet 入口不可用（老包 / 引擎未就绪）时的本地回退实现
import { parsePlaylistInput as localParsePlaylistInput } from "@/lib/playlist-link";

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
    throw new Error(`音源包调用失败：${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
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
    contentType: item.contentType,
  };
}

function fromAppChart(chart: Chart): ContractChart {
  return {
    id: chart.id,
    platform: chart.platform as Source,
    name: chart.name,
    picUrl: chart.picUrl,
    description: chart.description,
    contentType: chart.contentType,
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
 * 「聚合搜索只用哪几个音源」的入参归一化：空数组/undefined 都当「没限制」。
 *
 * 包侧（META_REVISION 6 起的 searchAll/searchMany）拿到 `sources` 会在**发请求前**
 * 就只查这几个源；老数据包忽略这个字段，所以门面收到应答后还要再过一遍
 * `pickBatches`（见下）——两处过滤是幂等的，宁可重复一次也别让用户关掉的源漏进来。
 */
function aggregateFilter(sources?: readonly string[]): string[] | undefined {
  return sources && sources.length > 0 ? [...sources] : undefined;
}

/** 按选中音源过滤批次（老数据包兜底；新包已经过滤过，这里是幂等的） */
function pickBatches<T extends { source: string }>(
  batches: T[],
  sources?: readonly string[],
): T[] {
  if (!sources || sources.length === 0) return batches;
  const allow = new Set(sources);
  return batches.filter((batch) => allow.has(batch.source));
}

/**
 * 聚合搜索（保留分批结构）：搜索页「聚合」模式按源分组展示用。
 * 与单源 search 同一个 bundle 入口，只是打多源 ——
 * UI 需要知道每条结果来自哪个源来分组/打标。
 *
 * `sources` = 用户勾选的聚合音源（`readAggregateSources()`；null/缺省 = 全部）。
 */
export async function searchAllBatches(
  keyword: string,
  page: number,
  size: number,
  sources?: readonly string[],
): Promise<SearchSourceBatch[]> {
  const filter = aggregateFilter(sources);
  const batches = await sourceCall<{ source: Source; list: MusicInfo[] }[]>(
    "searchAll",
    filter ? { keyword, page, size, sources: filter } : { keyword, page, size },
    (p) => p.batches as { source: Source; list: MusicInfo[] }[] | undefined,
  );
  return pickBatches(
    batches.map((batch) => ({
      source: batch.source as Exclude<SourceId, "local">,
      tracks: batch.list.map((m) =>
        toAppTrack(m, batch.source as Exclude<SourceId, "local">),
      ),
    })),
    filter,
  );
}

// ---------- 多关键词聚合搜索 ----------

/** 多关键词聚合搜索的选项 */
export interface AggregateSearchOptions {
  /** 关键词之间的并发（数据包侧 worker 池；缺省 3，包侧 clamp 1..8） */
  concurrency?: number;
  /** 整批预算（毫秒）：超预算时数据包返回已搜到的部分并置 `truncated` */
  budgetMs?: number;
  /** 只用这几个音源（缺省/空 = 全部；包侧过滤 + 门面兜底，见 `aggregateFilter`） */
  sources?: readonly string[];
}

/** 单个关键词的聚合结果（分批结构与 `searchAllBatches` 一致） */
export interface AggregateKeywordGroup {
  keyword: string;
  /** 该词是否调用成功（词内四源全灭也算成功，只是空列表） */
  ok: boolean;
  batches: SearchSourceBatch[];
}

export interface AggregateSearchResult {
  groups: AggregateKeywordGroup[];
  /** 是否因预算用尽没搜完 */
  truncated: boolean;
}

/** 数据包 `searchMany` 应答里单个关键词的原始形状（契约字段可能缺省，映射时兜住） */
interface RawKeywordGroup {
  keyword: string;
  ok?: boolean;
  batches?: { source: Source; list: MusicInfo[] }[];
}

/** 数据包 `searchMany` 应答的原始形状 */
interface RawSearchManyPayload {
  groups: RawKeywordGroup[];
  truncated?: boolean;
}

/**
 * 关键词归一化：与数据包 `batch-search.ts` 同规则（折叠空白 + 小写去重、
 * 保留首次出现的原文、最多 32 个），保证 `groups` 与传进来的关键词一一对齐。
 */
function normalizeKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keywords) {
    const keyword = String(raw ?? "").trim().replace(/\s+/g, " ");
    if (keyword.length === 0) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
    if (out.length >= 32) break;
  }
  return out;
}

/** 数据包缺入口（旧包）与「引擎未就绪」「接口执行失败」区分开：只有前者能换成「该更新包了」 */
function isMissingEntryError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return text.includes("缺少") || text.includes("入口不存在");
}

/**
 * 老数据包缺入口时的统一提示。
 *
 * 2026-10-24 起「多源聚合」一律住数据包（DESIGN §1.2 架构原则）：宿主不再保留
 * 逐源扇出 + 本地合并的兜底实现 —— 那份逻辑和包内是同一套规则，两处各写一份
 * 必然漂移（包修了去重/排序，app 还是旧的），所以缺入口时只提示升级，不静默
 * 降级成「少几个源」的结果让用户以为是搜索没结果。
 */
function packOutdated(entry: string, requires: string): Error {
  return new Error(
    `数据包版本过旧：当前数据包缺少 ${entry} 入口（需要 ${requires} 及以上）。` +
      "请到「设置 → 音源包」更新数据包后重试",
  );
}

/**
 * 多关键词聚合搜索：一次进去搜 N 个词，每个词内四源并发。
 *
 * 为什么把「扇出」放进数据包：
 * - 并发上限、单源超时、逐词失败隔离都是**音源层**的事，各端（PC / 安卓 /
 *   以后的 APP）各写一份必然漂移；包内一份实现，换包即升级；
 * - N 个关键词不再需要 N 次跨窗口 invoke（也不需要宿主自己排队）。
 *
 * 兼容：老数据包没有该入口时抛 `packOutdated`（提示更新数据包），不再退回
 * app 侧扇出 —— 与 `searchMergedPage` / `getAllLatestSongs` 同一口径。
 */
export async function searchManyBatches(
  keywords: string[],
  page: number,
  size: number,
  options: AggregateSearchOptions = {},
): Promise<AggregateSearchResult> {
  const list = normalizeKeywords(keywords);
  if (list.length === 0) return { groups: [], truncated: false };
  const filter = aggregateFilter(options.sources);
  let payload: RawSearchManyPayload;
  try {
    payload = await sourceCall<RawSearchManyPayload>(
      "searchMany",
      filter
        ? {
            keywords: list,
            page,
            size,
            concurrency: options.concurrency,
            budgetMs: options.budgetMs,
            sources: filter,
          }
        : {
            keywords: list,
            page,
            size,
            concurrency: options.concurrency,
            budgetMs: options.budgetMs,
          },
      (p) =>
        Array.isArray(p.groups)
          ? { groups: p.groups as RawKeywordGroup[], truncated: p.truncated as boolean | undefined }
          : undefined,
    );
  } catch (err) {
    if (!isMissingEntryError(err)) throw err;
    throw packOutdated("searchMany", "数据包 2026.10.22.1（META_REVISION 6）");
  }
  const groups: AggregateKeywordGroup[] = payload.groups.map((group) => ({
    keyword: String(group.keyword ?? ""),
    // 缺 `ok` 的应答按成功处理：老实现可能不带这个字段，无结果 ≠ 失败
    ok: group.ok !== false,
    batches: pickBatches(
      (group.batches ?? []).map((batch) => {
        const source = batch.source as Exclude<SourceId, "local">;
        return { source, tracks: (batch.list ?? []).map((m) => toAppTrack(m, source)) };
      }),
      filter,
    ),
  }));
  return { groups, truncated: payload.truncated === true };
}

// ---------- 合并去重的聚合搜索（数据包 searchMerged） ----------

/** 合并版聚合搜索的选项 */
export interface MergedSearchOptions {
  /** 只用这几个音源（缺省 / 空 = 全部；包侧发请求前过滤 + 门面兜底，见 `aggregateFilter`） */
  sources?: readonly string[];
  /** 当前音源 id：同一首歌在多个源都有时，优先保留它的版本（播放更顺） */
  preferSource?: string;
}

/** 数据包 `searchMerged` 应答的原始形状：每条都带「它来自哪个源」 */
interface RawSearchMergedPayload {
  list: { source: Source; song: MusicInfo }[];
  /** 这一页里是否有**任一源**返回了满页（分页收尾的唯一依据，见 `searchMergedPage`） */
  full?: boolean;
}

/** 合并版聚合搜索的一页 */
export interface MergedSearchPage {
  /** 合并去重、按相关性排序后的曲目 */
  tracks: Track[];
  /** 「可能还有下一页」：本页是否有任一源满页 */
  full: boolean;
}

/**
 * 聚合搜索（**合并去重后的单列表**）：搜索页「聚合」模式用。
 *
 * 为什么合并放进数据包（META_REVISION 7）：这和 `searchMany` 是同一个判断 ——
 * 「多源结果怎么合、重复怎么判、哪条更合适」属**音源层**的知识（各平台的标题写法、
 * 版本后缀、元数据完整度都在包那边最清楚），放在 app 里就等于每个端各写一份，
 * 换个端/换个人维护就开始漂移。包内一次调用直接给「一条像样的结果」，宿主只渲染。
 *
 * 为什么要连 `full` 一起回：合并去重后条数必然少于各源之和，宿主拿 `tracks.length`
 * 比 `size` 会永远判成「到底了」，后面的歌就再也翻不出来；而各源原始条数只有包侧
 * 知道。
 *
 * 兼容：旧数据包没有该入口时抛 `packOutdated`（提示更新数据包）。2026-10-24 删掉了
 * 原先「app 侧 `searchAllBatches` + `mergeAggregateTracks` 本地合并」的兜底 ——
 * 那份合并规则和包内必须保持一致，留着只会漂移（见 DESIGN §1.2）。
 */
export async function searchMergedPage(
  keyword: string,
  page: number,
  size: number,
  options: MergedSearchOptions = {},
): Promise<MergedSearchPage> {
  const trimmed = String(keyword ?? "").trim();
  if (trimmed.length === 0) return { tracks: [], full: false };
  const filter = aggregateFilter(options.sources);
  let payload: RawSearchMergedPayload;
  try {
    payload = await sourceCall<RawSearchMergedPayload>(
      "searchMerged",
      filter
        ? { keyword: trimmed, page, size, sources: filter, preferSource: options.preferSource }
        : { keyword: trimmed, page, size, preferSource: options.preferSource },
      (p) =>
        Array.isArray(p.list)
          ? { list: p.list as RawSearchMergedPayload["list"], full: p.full === true }
          : undefined,
    );
  } catch (err) {
    if (!isMissingEntryError(err)) throw err;
    throw packOutdated("searchMerged", "数据包 2026.10.22.1（META_REVISION 7）");
  }
  const allow = filter ? new Set<string>(filter) : null;
  // 门面再按勾选集过滤一遍：旧包忽略 `sources` 时这里是唯一保证（幂等）
  const tracks = payload.list
    .filter((item) => item !== null && typeof item === "object" && item.song)
    .filter((item) => allow === null || allow.has(String(item.source)))
    .map((item) => toAppTrack(item.song, item.source as Exclude<SourceId, "local">));
  return { tracks, full: payload.full === true };
}

/** 搜索歌单（按源） */
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
  // 提前返回的两条路径都直接带字面量返回；落到末尾 return 的路径上，
  // try / catch 两路都会先赋值（resolved.stalled / true），声明处无需初始化。
  let stalled: boolean;
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
      // officialNote = 官方前置线路的尝试结论（非空 = 官方没走成，落了第三方）
      rememberPlayUrlLine(track, quality, resolved.line, resolved.officialNote);
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

export async function getAudioChartPrograms(chart: Chart): Promise<AudioProgram[]> {
  ensureScript(chart.platform);
  const list = await sourceCall<ContractAudioProgram[]>(
    "audioChartPrograms",
    { source: chart.platform, chart: fromAppChart(chart) },
    (p) => p.list as ContractAudioProgram[] | undefined,
  );
  return list.map((item) => ({
    id: item.id,
    platform: item.platform as SourceId,
    name: item.name,
    artist: item.artist,
    picUrl: item.picUrl,
    description: item.description ?? null,
    chapterCount: item.chapterCount ?? 0,
  }));
}

export async function getAudioProgramDetail(
  platform: SourceId,
  id: string,
  page: number,
  size: number,
): Promise<{ program: AudioProgram; tracks: Track[]; hasMore: boolean }> {
  ensureScript(platform);
  const detail = await sourceCall<ContractAudioProgramDetail>(
    "audioProgramDetail",
    { source: platform, id, page, size },
    (p) => p.detail as ContractAudioProgramDetail | undefined,
  );
  const program: AudioProgram = {
    id: detail.id,
    platform: detail.platform as SourceId,
    name: detail.name,
    artist: detail.artist,
    picUrl: detail.picUrl,
    description: detail.description ?? null,
    chapterCount: detail.chapterCount ?? 0,
  };
  return {
    program,
    tracks: (detail.tracks ?? []).map((m) => toAppTrack(m, platform)),
    hasMore: detail.hasMore === true,
  };
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

/** 数据包 `allLatest` 应答：v8 起每条曲目自带 platform（交错合并已在包内完成） */
interface RawAllLatestPayload {
  list: (MusicInfo & { platform?: Source })[];
}

/**
 * 聚合「最新音乐」：一次调用拿全部音源的最新歌（包内并发、单源超时、交错合并）。
 *
 * 为什么必须住包内（2026-10-24 起，DESIGN §1.2）：最新流的合并节奏、单源超时、
 * 「哪些源支持翻页」都是音源层的知识；放在宿主就等于 PC / 安卓各写一份。以前的
 * 实现（逐源调 `latest` + 宿主交错）之所以存在，是因为包 `allLatest` 回的是裸
 * `MusicInfo`、多源混批后无法归属 `platform`（取链依赖它）。数据包 v8 起每条都
 * 带 `platform`，宿主只做「映射 + 截断」。
 *
 * 兼容：旧包缺 `allLatest` 入口或回执不带 `platform` 时抛 `packOutdated`，提示
 * 更新数据包；不再退回宿主逐源扇出。调用方（每日推荐的 latest 路）自己 catch
 * 降级，不让整单失败。
 */
export async function getAllLatestSongs(limit: number, offset: number): Promise<Track[]> {
  let payload: RawAllLatestPayload;
  try {
    payload = await sourceCall<RawAllLatestPayload>(
      "allLatest",
      { limit, offset },
      (p) => (Array.isArray(p.list) ? { list: p.list as RawAllLatestPayload["list"] } : undefined),
    );
  } catch (err) {
    if (!isMissingEntryError(err)) throw err;
    throw packOutdated("allLatest", "数据包 2026.10.22.2（META_REVISION 8）");
  }
  const out: Track[] = [];
  for (const item of payload.list) {
    if (out.length >= limit) break;
    const platform = item.platform;
    if (platform === undefined || platform === "local") continue;
    out.push(toAppTrack(item, platform));
  }
  // 旧包（REV 7）入口在、但条目不带 platform：不能猜源，否则取链会串平台
  if (out.length === 0 && payload.list.length > 0) {
    throw packOutdated("allLatest（带 platform 的版本）", "数据包 2026.10.22.2（META_REVISION 8）");
  }
  return out;
}

/**
 * 聚合热搜：一次调用拿全部音源热词的合并列表（包内并发、去重、封顶 30 条）。
 *
 * 取代按源的 `hotWords`：落地页的「热门搜索」不再跟随当前音源，换音源不重拉。
 * `sources` = 用户勾选的聚合音源（`readAggregateSources()`；null/缺省 = 全部），
 * 与 searchAll/searchMany/searchMerged 共用同一份勾选 —— 聚合热词与聚合搜索
 * 是同一个「聚合」概念，不各存一份（包侧 allHotWords 的 sources 语义见
 * meta-entries：发请求前过滤，未选中的源连请求都不发）。
 */
export async function getAllHotWords(sources?: readonly string[]): Promise<string[]> {
  const filter = aggregateFilter(sources);
  return sourceCall<string[]>(
    "allHotWords",
    filter ? { sources: filter } : {},
    (p) => p.list as string[] | undefined,
  );
}

// ---------- 音源账号登录（v9 数据包：官方扫码 + 两面凭据注入） ----------

/** 已登录账号的用户展示信息（数据包 authUser/authQrPoll 下发） */
export interface SourceAuthUser {
  id: string;
  nickname: string;
  avatar: string;
  vip: boolean;
  vipLabel: string;
}

/** 扫码会话：image 是包内渲染的 PNG data URI，<img> 直接显示 */
export interface SourceQrSession {
  key: string;
  image: string;
  expiresInSec: number;
}

/** 扫码轮询状态机（confirmed 时带凭据与账号信息，其余状态只有 status；
 *  v17 起 bili 扫码确认会随 credential 下发 refresh_token——官方 cookie
 *  刷新协议的凭据副键，调用方落库时并入 extras 持久化） */
export type SourceQrPoll =
  | { status: "waiting" | "scanned" | "expired" }
  | { status: "confirmed"; cookie: string; user: SourceAuthUser; refreshToken?: string };

/** 凭据注入的面：meta = 数据请求（搜索/歌词等），play = 播放/取链请求 */
export type SourceAuthScope = "meta" | "play";

/** v9 入口的缺包提示（与 searchMany/searchMerged 同口径） */
function packOutdatedV9(entry: string): Error {
  return packOutdated(entry, "数据包 2026.10.24.1（META_REVISION 9）");
}

/** 包侧下发的 user 对象 → 展示模型（字段缺失按空值兜底；完全不是对象返回 null） */
function normalizeAuthUser(raw: unknown): SourceAuthUser | null {
  if (raw === null || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  if (typeof u.nickname !== "string") return null;
  return {
    id: typeof u.id === "string" || typeof u.id === "number" ? String(u.id) : "",
    nickname: u.nickname,
    avatar: typeof u.avatar === "string" ? u.avatar : "",
    vip: u.vip === true,
    vipLabel: typeof u.vipLabel === "string" ? u.vipLabel : "",
  };
}

/** 包装 v9 入口调用：缺入口（旧包）换成「该更新包了」，其余错误原样抛 */
async function authCall<T>(entry: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isMissingEntryError(err)) throw err;
    throw packOutdatedV9(entry);
  }
}

/** v12 入口的缺包提示（getSourceQualities：生效音质档位清单判定收拢进包内） */
function packOutdatedV12(entry: string): Error {
  return packOutdated(entry, "数据包 2026.10.24.17（META_REVISION 12）");
}

/**
 * 某源当前生效的音质档位清单（v12）：登录态 → 官方清单的判定、会员档过滤、
 * 旧档名别名表全部由数据包决定（它持有播放面凭据与 officialQualities 自述），
 * 宿主只把账号会员档作为数据传入。官方清单未生效时 mode="platform"、
 * qualities 为空，调用方回落注册表普通子集。旧包缺入口 → 提示更新数据包。
 */
export async function fetchSourceQualityProfile(
  source: SourceId,
  vip?: string | null,
): Promise<SourceQualityProfile> {
  try {
    return await sourceCall<SourceQualityProfile>(
      "getSourceQualities",
      { source, ...(vip ? { vip } : {}) },
      (p) => {
        if (p.mode !== "official" && p.mode !== "platform") return undefined;
        const qualities: SourceOfficialQuality[] = Array.isArray(p.qualities)
          ? (p.qualities as Record<string, unknown>[])
              .filter(
                (q): q is { id: string; name: string; min?: unknown } =>
                  q !== null && typeof q === "object" &&
                  typeof q.id === "string" && q.id.length > 0 && typeof q.name === "string",
              )
              .map((q) => ({
                id: q.id,
                name: q.name,
                min: q.min === "vip" || q.min === "svip" ? q.min : "none",
              }))
          : [];
        const aliases: Record<string, string> = {};
        if (p.aliases !== null && typeof p.aliases === "object" && !Array.isArray(p.aliases)) {
          for (const [from, to] of Object.entries(p.aliases as Record<string, unknown>)) {
            if (typeof from !== "string" || typeof to !== "string") continue;
            if (!/^[A-Za-z0-9_-]{1,24}$/.test(from) || !/^[A-Za-z0-9_-]{1,24}$/.test(to)) continue;
            aliases[from] = to;
          }
        }
        return { mode: p.mode, qualities, aliases };
      },
    );
  } catch (err) {
    if (!isMissingEntryError(err)) throw err;
    throw packOutdatedV12("getSourceQualities");
  }
}

/** 创建扫码会话（登录动作直连官方端点，不经凭据包装器） */
export async function authQrCreate(source: SourceId): Promise<SourceQrSession> {
  return authCall("authQrCreate", () =>
    sourceCall<SourceQrSession>(
      "authQrCreate",
      { source },
      (p) => {
        if (typeof p.key !== "string" || p.key.length === 0) return undefined;
        if (typeof p.image !== "string" || !p.image.startsWith("data:image/png;base64,")) {
          return undefined;
        }
        return { key: p.key, image: p.image, expiresInSec: Number(p.expiresInSec) || 180 };
      },
    ),
  );
}

/** 扫码轮询（宿主 2s 一次；confirmed 后由调用方落存储并注入） */
export async function authQrPoll(source: SourceId, key: string): Promise<SourceQrPoll> {
  return authCall("authQrPoll", async () => {
    const raw = await sourceCall<{ status?: string; credential?: { cookie?: unknown; refresh_token?: unknown }; user?: Record<string, unknown> }>(
      "authQrPoll",
      { source, key },
      (p) => (typeof p.status === "string" ? p : undefined),
    );
    if (raw.status !== "confirmed") {
      if (raw.status === "waiting" || raw.status === "scanned" || raw.status === "expired") {
        return { status: raw.status };
      }
      // 未知状态按过期处理（宿主引导重新生成二维码）
      return { status: "expired" };
    }
    const cookie = typeof raw.credential?.cookie === "string" ? raw.credential.cookie : "";
    const refreshToken =
      typeof raw.credential?.refresh_token === "string" && raw.credential.refresh_token.length > 0
        ? raw.credential.refresh_token
        : undefined;
    const user = normalizeAuthUser(raw.user);
    if (cookie.length === 0 || user === null) {
      return { status: "expired" };
    }
    return { status: "confirmed", cookie, user, ...(refreshToken !== undefined ? { refreshToken } : {}) };
  });
}

/** 导入 Cookie：先经官方登录态接口校验，ok=false 表示 Cookie 无效（不落存储） */
export async function authImportCookie(
  source: SourceId,
  cookie: string,
): Promise<{ ok: boolean; user: SourceAuthUser | null }> {
  return authCall("authImportCookie", () =>
    sourceCall<{ ok: boolean; user: SourceAuthUser | null }>(
      "authImportCookie",
      { source, cookie },
      (p) => (typeof p.ok === "boolean" ? { ok: p.ok, user: normalizeAuthUser(p.user) } : undefined),
    ),
  );
}

/** 用 Cookie 查登录态（启动时验证已存凭据是否仍有效）。
 * credential 非空 = 包侧已用 refresh_key 轮换出新 cookie（QQ 短期
 * musickey 保活），调用方必须持久化新 cookie（saveSourceAuthAccount）。
 * extras 是账号记录随登录保存的凭据副键（如 bili 的 refresh_token），
 * 原样透传给包入口供 refreshCredential 使用；credential 里随行下发的
 * refresh_token 提取为 refreshToken，调用方落库时一并持久化。 */
export async function authCheckUser(
  source: SourceId,
  cookie: string,
  extras?: Record<string, string>,
): Promise<{
  ok: boolean;
  user: SourceAuthUser | null;
  credential: string | null;
  refreshToken?: string;
}> {
  return authCall("authUser", () =>
    sourceCall<{
      ok: boolean;
      user: SourceAuthUser | null;
      credential: string | null;
      refreshToken?: string;
    }>(
      "authUser",
      extras === undefined ? { source, cookie } : { source, cookie, extras },
      (p) => {
        if (typeof p.ok !== "boolean") return undefined;
        const credentialCookie = p.credential;
        const credential =
          credentialCookie != null &&
          typeof credentialCookie === "object" &&
          typeof (credentialCookie as { cookie?: unknown }).cookie === "string" &&
          (credentialCookie as { cookie: string }).cookie.length > 0
            ? (credentialCookie as { cookie: string }).cookie
            : null;
        const refreshToken =
          credentialCookie != null &&
          typeof credentialCookie === "object" &&
          typeof (credentialCookie as { refresh_token?: unknown }).refresh_token === "string" &&
          (credentialCookie as { refresh_token: string }).refresh_token.length > 0
            ? (credentialCookie as { refresh_token: string }).refresh_token
            : undefined;
        return {
          ok: p.ok,
          user: normalizeAuthUser(p.user),
          credential,
          ...(refreshToken !== undefined ? { refreshToken } : {}),
        };
      },
    ),
  );
}

/** 短信验证码挑战（v14，酷我）：key 是一次性凭据，authLoginByPhone 原样带回 */
export interface SourceSmsChallenge {
  key: string;
  message: string;
}

/** v13 入口的缺包提示（authSendSms/authLoginByPhone/authLoginByPassword） */
function packOutdatedV13(entry: string): Error {
  return packOutdated(entry, "数据包 2026.10.24.19（META_REVISION 13）");
}

/** 发送短信验证码（登录动作直连官方端点，不经凭据包装器） */
export async function authSendSms(
  source: SourceId,
  phone: string,
): Promise<SourceSmsChallenge> {
  try {
    return await sourceCall<SourceSmsChallenge>(
      "authSendSms",
      { source, phone },
      (p) =>
        typeof p.key === "string" && p.key.length > 0
          ? { key: p.key, message: typeof p.message === "string" ? p.message : "" }
          : undefined,
    );
  } catch (err) {
    if (!isMissingEntryError(err)) throw err;
    throw packOutdatedV13("authSendSms");
  }
}

/** 短信验证码登录（与扫码 confirmed 同形状：落存储后按开关 setAuth 灌入） */
export async function authLoginByPhone(
  source: SourceId,
  key: string,
  code: string,
): Promise<{ cookie: string; user: SourceAuthUser }> {
  const result = await authCall("authLoginByPhone", () =>
    sourceCall<{ credential?: { cookie?: unknown }; user?: Record<string, unknown> }>(
      "authLoginByPhone",
      { source, key, code },
      (p) => (p.credential !== null && typeof p.credential === "object" ? p : undefined),
    ),
  );
  const cookie = typeof result.credential?.cookie === "string" ? result.credential.cookie : "";
  const user = normalizeAuthUser(result.user);
  if (cookie.length === 0 || user === null) {
    throw new Error("短信登录失败：数据包应答缺凭据");
  }
  return { cookie, user };
}

/** 账号密码登录（v14，酷我官方客户端形制） */
export async function authLoginByPassword(
  source: SourceId,
  account: string,
  password: string,
): Promise<{ cookie: string; user: SourceAuthUser }> {
  const result = await authCall("authLoginByPassword", () =>
    sourceCall<{ credential?: { cookie?: unknown }; user?: Record<string, unknown> }>(
      "authLoginByPassword",
      { source, account, password },
      (p) => (p.credential !== null && typeof p.credential === "object" ? p : undefined),
    ),
  );
  const cookie = typeof result.credential?.cookie === "string" ? result.credential.cookie : "";
  const user = normalizeAuthUser(result.user);
  if (cookie.length === 0 || user === null) {
    throw new Error("密码登录失败：数据包应答缺凭据");
  }
  return { cookie, user };
}

/**
 * 灌入/清除登录态（数据包引擎的内存工作副本）。持久真源在设置库
 * （lib/source-auth.ts），这里只是把「当前该不该用」投给数据包：
 * 引擎每次重装数据包后由 ensureSourceAuthInjected 重灌。
 */
export async function authSetCredential(
  scope: SourceAuthScope,
  source: SourceId,
  cookie: string,
): Promise<void> {
  await authCall("setAuth", () =>
    sourceCall<{ ok: boolean }>("setAuth", { scope, source, cookie }, (p) =>
      p.ok === true ? { ok: true } : undefined,
    ),
  );
}

/** 清除登录态：source 缺省 = 清整个面（对应「关掉该面开关」） */
export async function authClearCredential(scope: SourceAuthScope, source?: SourceId): Promise<void> {
  await authCall("clearAuth", () =>
    sourceCall<{ ok: boolean }>(
      "clearAuth",
      source === undefined ? { scope } : { scope, source },
      (p) => (p.ok === true ? { ok: true } : undefined),
    ),
  );
}

// ---------- MV ----------
// MV/视频接口已随双音源包架构移除（播放包不再产出 videoUrl，客户端全链路删除）。

