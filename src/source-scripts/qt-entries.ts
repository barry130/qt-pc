/**
 * 宿主入口注册（`globalThis.__qtEntries`）—— 安卓 QuickJS / iOS JavaScriptCore 的 bundle 消费形态。
 *
 * 同一份 source-bundle.js 两端共用，但消费形态不同：
 * - PC：引擎页动态 import，取 `createSourceLayer` 等**命名导出**；
 * - 安卓：qt-js-engine 把 bundle 当**模块脚本**编译执行（compileModule），只认
 *   `globalThis.__qtEntries` 这套**全局注册**（契约见 qt-uniappx 的
 *   services/source-engine.uts 与插件 README）。
 *
 * 因此 bundle 顶层必须补上这段注册——两种形态共存于一份产物，互不干扰：
 * PC 引擎页没有 `__qtHost` 全局，导入本 bundle 不产生任何副作用。
 *
 * 入参/出参一律 JSON 文本：引擎边界只走字符串（《QuickJS 音源引擎方案》§2.6）。
 * HTTP 能力由 prelude 注入的 `__qtHost.request` 提供，与 PC 的 Rust
 * builtin_request 同一契约（响应头小写、响应体先试 JSON 解析、失败原样字符串）。
 *
 * 入口全集（2026-09-19 起）：音源数据接口整体下沉到 bundle——安卓端 music-api
 * 不再保留任何平台实现，搜索/歌单/专辑/歌手/榜单/歌词/封面/热词/MV 全部经
 * `invoke(入口名, [argsJson])` 调这里。入口是**增量**的（hostApiVersion 仍为 1）：
 * 老客户端只调 getPlayUrl/verifyPlayable，新入口对它是死代码。
 */
import {
  PLATFORMS,
  defaultChainConfig,
  parseChainConfig,
  type ChainConfig,
  type PlatformId,
} from "./chain-config";
import { setChainConfigCache } from "./chain-store";
import type {
  ContractArtist,
  ContractChart,
  ContractPlaylist,
  ContractPlaylistCategory,
  ContractPlaylistDetail,
  ContractVideo,
  MusicInfo,
  Quality,
  RequestBuiltin,
  Source,
} from "./contract";
import { consumeLastMissTrace } from "./actions/play-url";
import {
  allCharts,
  allHotWords,
  allLatestBatches,
  allSearchBatches,
  artistSongs,
  search,
} from "./actions/aggregate";
import { songCover } from "./actions/cover";
import { getLyric } from "./actions/lyric";
import { recommendations } from "./actions/recommendations";
import { createSourceLayer } from "./layer";
import { kg } from "./platforms/kg";
import { kw } from "./platforms/kw";
import { qq } from "./platforms/qq";
import { wyy } from "./platforms/wyy";

/** prelude 注入的宿主能力（qt-uniappx/uni_modules/qt-js-engine/utssdk/app-android/prelude.uts） */
export interface QtHost {
  /** 与 PC 的 Rust builtin_request 同契约（响应头小写、body 已尝试 JSON 解析） */
  request: RequestBuiltin;
  log?: (message: string) => void;
  /** 宿主平台号（1101 安卓 / 1102 iOS）；缺省按安卓 */
  platform?: number;
}

/** getPlayUrl 入参：qt-uniappx 侧由 Song 映射（source-engine.uts） */
export interface QtGetPlayUrlArgs {
  /** 源 id：wyy / qq / kw / kg */
  platform: string;
  id: string;
  name: string;
  singer: string;
  album?: string;
  quality: string;
  /** 秒 */
  duration?: number;
}

/** 与 manifest 和插件契约同号（source-engine.uts 的 HOST_API_VERSION） */
const HOST_API_VERSION = 1;

/** 链路线路总数（bundleInfo / loadChain 的诊断字段） */
function countLines(config: ChainConfig): number {
  let n = 0;
  for (const lines of Object.values(config.chains)) n += lines.length;
  return n;
}

/** 源 id → 平台模块（四平台方法名一致，见 platforms/*.ts） */
function platformOf(source: Source) {
  if (source === "qq") return qq;
  if (source === "kw") return kw;
  if (source === "kg") return kg;
  return wyy;
}

/** 入口入参里的歌曲（歌词/封面用；字段与契约 MusicInfo 同构，缺省补空） */
interface QtSongArgs {
  id?: string;
  name?: string;
  singer?: string;
  album?: string;
  picUrl?: string;
  /** 秒 */
  interval?: number;
  musicId?: string | null;
}

function songOf(args: QtSongArgs): MusicInfo {
  return {
    id: String(args.id == null ? "" : args.id),
    name: String(args.name == null ? "" : args.name),
    singer: String(args.singer == null ? "" : args.singer),
    album: args.album == null ? "" : String(args.album),
    picUrl: args.picUrl == null ? "" : String(args.picUrl),
    interval: Number(args.interval == null ? 0 : args.interval),
    musicId: args.musicId == null ? null : String(args.musicId),
  };
}

/**
 * 注册宿主入口（幂等：重复注册覆盖为新层）。
 *
 * `loadChain` 装载的链既喂给执行器（layer / play-url 都从 chain-store 缓存读配置），
 * 也供 bundleInfo 展示——引擎每次重建（stop → start → loadBundle）都会重新执行
 * bundle 顶层，因此不需要处理跨包的残留状态。
 */
export function registerQtEntries(host: QtHost): void {
  const platform = (
    typeof host.platform === "number" ? host.platform : PLATFORMS.ANDROID
  ) as PlatformId;
  let activeChain: ChainConfig = defaultChainConfig();
  const layer = createSourceLayer({ request: host.request, platform });
  const req: RequestBuiltin = host.request;

  const entries = {
    /** 诊断信息：bundle 没有独立版本号（版本由 release 承载），这里报链修订号 */
    bundleInfo(): string {
      return JSON.stringify({
        name: "source-bundle",
        version: "chain." + activeChain.chainRevision,
        chainRevision: activeChain.chainRevision,
        platforms: [platform],
        hostApiVersion: HOST_API_VERSION,
      });
    },

    /** 装载 chain.json：三层把关的第①层（JSON 能解析 + schema 校验），非法直接抛 */
    loadChain(chainJson: string): string {
      const parsed = parseChainConfig(JSON.parse(chainJson));
      activeChain = parsed;
      setChainConfigCache(parsed);
      return JSON.stringify({ ok: true, lines: countLines(parsed) });
    },

    /** 取链：失败抛错（引擎侧 catch 后回退内置取链，用户无感） */
    async getPlayUrl(args: QtGetPlayUrlArgs): Promise<string> {
      const source = String(args.platform) as Source;
      const quality = String(args.quality) as Quality;
      const song: MusicInfo = {
        id: String(args.id),
        name: String(args.name),
        singer: String(args.singer),
        album: args.album == null ? "" : String(args.album),
        picUrl: "",
        interval: Number(args.duration == null ? 0 : args.duration),
      };
      const url = await layer.resolvePlayUrl(source, song, quality);
      if (url.length === 0) {
        // 追踪随错误上抛：安卓端 console 不落盘（AAR 未 setConsole），引擎应答
        // 的 error 文本是唯一的诊断通道；PC 侧同样受益（一行看清每条线路死因）
        // 用和取链一致的 cacheKey 取追踪，避免拿到别的并发请求残留的 trace
        const trace = consumeLastMissTrace(source + ":" + song.id + ":" + quality);
        throw new Error(trace.length > 0 ? `未取到播放地址（${trace}）` : "未取到播放地址");
      }
      return JSON.stringify({ url, source, quality });
    },

    /** 冒烟自检的 Range 预检：判定口径与 PC 的 verifyPlayable 一致 */
    async verifyPlayable(args: { url?: string }): Promise<string> {
      const url = String(args.url == null ? "" : args.url);
      if (url.length === 0) return JSON.stringify({ ok: false, status: 0, length: 0 });
      try {
        const res = await host.request(url, {
          method: "GET",
          headers: { Range: "bytes=0-1" },
          timeoutMs: 5000,
        });
        const status = Number(res.statusCode);
        const headers = res.headers ?? {};
        const length = Number(headers["content-length"] ?? 0) || 0;
        // 403/416：Range 不被支持 ≠ 不可播（与 PC 同口径）
        if (status === 403 || status === 416) {
          return JSON.stringify({ ok: true, status, length });
        }
        const contentType = String(headers["content-type"] ?? "");
        const ok = status >= 200 && status < 400 && !/json|html|text\/plain/i.test(contentType);
        return JSON.stringify({ ok, status, length });
      } catch {
        return JSON.stringify({ ok: false, status: 0, length: 0 });
      }
    },

    // ==================== 音源数据接口（安卓端 music-api 全部走这里） ====================

    /** 单源搜索歌曲 */
    async search(args: { source?: string; keyword?: string; page?: number; size?: number }): Promise<string> {
      const list = await search(
        req,
        String(args.source) as Source,
        String(args.keyword == null ? "" : args.keyword),
        Number(args.page == null ? 1 : args.page),
        Number(args.size == null ? 30 : args.size),
      );
      return JSON.stringify({ list });
    },

    /** 四源聚合搜索：按平台分批返回 [{source, list}]（单源失败跳过） */
    async searchAll(args: { keyword?: string; page?: number; size?: number }): Promise<string> {
      const batches = await allSearchBatches(
        req,
        String(args.keyword == null ? "" : args.keyword),
        Number(args.page == null ? 1 : args.page),
        Number(args.size == null ? 30 : args.size),
      );
      return JSON.stringify({ batches });
    },

    /** 歌单搜索 */
    async searchPlaylists(args: { source?: string; keyword?: string; page?: number; size?: number }): Promise<string> {
      const list: ContractPlaylist[] = await platformOf(String(args.source) as Source).playlistSearch(
        req,
        String(args.keyword == null ? "" : args.keyword),
        Number(args.page == null ? 1 : args.page),
        Number(args.size == null ? 30 : args.size),
      );
      return JSON.stringify({ list });
    },

    /** 歌手搜索 */
    async searchArtists(args: { source?: string; keyword?: string; page?: number; size?: number }): Promise<string> {
      const list: ContractArtist[] = await platformOf(String(args.source) as Source).artistSearch(
        req,
        String(args.keyword == null ? "" : args.keyword),
        Number(args.page == null ? 1 : args.page),
        Number(args.size == null ? 30 : args.size),
      );
      return JSON.stringify({ list });
    },

    /** 专辑搜索 */
    async searchAlbums(args: { source?: string; keyword?: string; page?: number; size?: number }): Promise<string> {
      const list = await platformOf(String(args.source) as Source).albumSearch(
        req,
        String(args.keyword == null ? "" : args.keyword),
        Number(args.page == null ? 1 : args.page),
        Number(args.size == null ? 30 : args.size),
      );
      return JSON.stringify({ list });
    },

    /** 专辑详情（结构与歌单详情一致） */
    async albumDetail(args: { source?: string; id?: string }): Promise<string> {
      const detail: ContractPlaylistDetail = await platformOf(String(args.source) as Source).albumDetail(
        req,
        String(args.id == null ? "" : args.id),
      );
      return JSON.stringify({ detail });
    },

    /**
     * 歌手歌曲（第一页附头像 picUrl）
     */
    async artistSongs(args: { source?: string; name?: string; page?: number; size?: number }): Promise<string> {
      const result = await artistSongs(
        req,
        String(args.source) as Source,
        String(args.name == null ? "" : args.name),
        Number(args.page == null ? 1 : args.page),
        Number(args.size == null ? 30 : args.size),
      );
      return JSON.stringify(result);
    },

    /** 歌单广场分类 */
    async playlistCategories(args: { source?: string }): Promise<string> {
      const list: ContractPlaylistCategory[] = await platformOf(String(args.source) as Source).playlistCategories(req);
      return JSON.stringify({ list });
    },

    /** 歌单详情（含曲目） */
    async playlistDetail(args: { source?: string; id?: string }): Promise<string> {
      const detail: ContractPlaylistDetail = await platformOf(String(args.source) as Source).playlistDetail(
        req,
        String(args.id == null ? "" : args.id),
      );
      return JSON.stringify({ detail });
    },

    /** 推荐歌单（category 为空时取默认） */
    async recommendations(args: { source?: string; category?: string | null; page?: number }): Promise<string> {
      const list: ContractPlaylist[] = await recommendations(
        req,
        String(args.source) as Source,
        args.category == null ? null : String(args.category),
        Number(args.page == null ? 1 : args.page),
      );
      return JSON.stringify({ list });
    },

    /** 单源榜单列表 */
    async charts(args: { source?: string }): Promise<string> {
      const list: ContractChart[] = await platformOf(String(args.source) as Source).charts(req);
      return JSON.stringify({ list });
    },

    /** 四源榜单合并（Chart 自带 platform，单源失败跳过） */
    async allCharts(_args: Record<string, never>): Promise<string> {
      const list = await allCharts(req);
      return JSON.stringify({ list });
    },

    /** 榜单详情（一次取全量） */
    async chartDetail(args: { source?: string; chart?: ContractChart }): Promise<string> {
      const chart = args.chart as ContractChart;
      const list: MusicInfo[] = await platformOf(String(args.source) as Source).chartDetail(req, chart);
      return JSON.stringify({ list });
    },

    /** 单源最新歌曲 */
    async latest(args: { source?: string; limit?: number; offset?: number }): Promise<string> {
      const list: MusicInfo[] = await platformOf(String(args.source) as Source).latest(
        req,
        Number(args.limit == null ? 30 : args.limit),
        Number(args.offset == null ? 0 : args.offset),
      );
      return JSON.stringify({ list });
    },

    /** 四源最新歌曲交错合并（凑满 limit；wyy/kg 带分页 offset） */
    async allLatest(args: { limit?: number; offset?: number }): Promise<string> {
      const limit = Number(args.limit == null ? 30 : args.limit);
      const offset = Number(args.offset == null ? 0 : args.offset);
      const batches = await allLatestBatches(req, limit, offset);
      const perSource = Math.ceil(limit / 4) + 1;
      const list: MusicInfo[] = [];
      for (let index = 0; index < perSource && list.length < limit; index++) {
        for (const batch of batches) {
          if (index < batch.list.length) list.push(batch.list[index]);
          if (list.length >= limit) break;
        }
      }
      return JSON.stringify({ list });
    },

    /** 单源热词 */
    async hotWords(args: { source?: string }): Promise<string> {
      const list: string[] = await platformOf(String(args.source) as Source).hotWords(req);
      return JSON.stringify({ list });
    },

    /** 四源热词合并（封顶 30 条） */
    async allHotWords(_args: Record<string, never>): Promise<string> {
      const list = await allHotWords(req);
      return JSON.stringify({ list });
    },

    /** 单源 MV 列表 */
    async videos(args: { source?: string; page?: number; size?: number }): Promise<string> {
      const list: ContractVideo[] = await platformOf(String(args.source) as Source).videos(
        req,
        Number(args.page == null ? 1 : args.page),
        Number(args.size == null ? 30 : args.size),
      );
      return JSON.stringify({ list });
    },

    /** MV 播放地址 */
    async videoUrl(args: { source?: string; videoId?: string; quality?: string }): Promise<string> {
      const url = await platformOf(String(args.source) as Source).videoUrl(
        req,
        String(args.videoId == null ? "" : args.videoId),
        String(args.quality == null ? "auto" : args.quality),
      );
      return JSON.stringify({ url });
    },

    /** 歌词（原文 + 翻译） */
    async lyric(args: { source?: string; song?: QtSongArgs }): Promise<string> {
      const result = await getLyric(req, String(args.source) as Source, songOf(args.song as QtSongArgs));
      return JSON.stringify(result);
    },

    /** 封面：优先平台接口，失败兜底搜索（返回 {url}，空串 = 未取到） */
    async cover(args: { source?: string; song?: QtSongArgs }): Promise<string> {
      const url = await songCover(req, String(args.source) as Source, songOf(args.song as QtSongArgs));
      return JSON.stringify({ url });
    },
  };

  (globalThis as unknown as { __qtEntries: typeof entries }).__qtEntries = entries;
}
