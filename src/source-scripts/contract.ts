/**
 * 音源访问层契约（插件化方案 v3 · 全量版）
 *
 * 本目录是「共享音源脚本包」在 qt-pc 内的落位（未来抽出为 packages/music-sources，
 * 供 qt-uniappx 以 uts 编译直接复用同一份源码）。规则（方案 v3）：
 * - 这里只放"调第三方源"的逻辑：编排、请求参数拼装、响应解析、回退；
 * - 不写任何 HTTP 执行实现 —— 由宿主注入 request builtin
 *   （PC：invoke → Rust reqwest；uniappx 未来：包装 http.ts directRequest）；
 * - 加密模块以"原样文件"搬入本包（kg-md5 / kw-des / kw 鉴权）。
 *
 * 本文件是两端"方法名/模型/出入参完全一致"的唯一真源：
 * uniappx 接入时直接 import 本文件，禁止两端各写一份。
 */

/** 平台：沿用两端现有取值（qt-pc SourceId / qt-uniappx Source 同源），零映射成本 */
export type Source = "wyy" | "qq" | "kw" | "kg";

/** 音质：两端现值同口径（"128"/"320"/"flac"） */
export type Quality = "128" | "320" | "flac";

/** 曲目：qt-pc Track / qt-uniappx Song 的公共超集（两端各写少量字段映射） */
export interface MusicInfo {
  id: string;
  name: string;
  singer: string;
  album: string;
  picUrl: string;
  /** 秒（两端同口径；蓝本字段名 duration） */
  interval: number;
  musicId?: string | null;
}

/** 歌单（广场卡片；契约模型） */
export interface ContractPlaylist {
  id: string;
  platform: Source;
  name: string;
  picUrl: string;
  playCount: string;
}

/** 歌单详情（含曲目；蓝本 playlist() 返回结构） */
export interface ContractPlaylistDetail extends ContractPlaylist {
  description: string | null;
  tracks: MusicInfo[];
}

/** 歌单广场分类 */
export interface ContractPlaylistCategory {
  id: string;
  name: string;
  group: string | null;
}

/** 歌手 */
export interface ContractArtist {
  id: string;
  platform: Source;
  name: string;
  picUrl: string;
  /**
   * 首字母（A-Z / #）。音源给了才填（qq 的 Findex），用于客户端分组；
   * 拿不到就不填，不要在这里猜拼音。
   */
  initial?: string;
}

/**
 * 歌手列表一页（artistList 返回）。
 *
 * 四个音源的「歌手列表」能力差异很大，用 `initialSupported` 如实告诉 UI：
 * - kw   ：artistList 支持 prefix 按首字母筛选 → true
 * - wyy  ：artist/list 只有 initial=0（热门）有数据，字母档恒空 → false
 * - qq   ：v8.fcg 列表忽略字母参数，但每条带 Findex → false（条目带 initial 供分组）
 * - kg   ：singer/list 只有语言/性别维度 → false
 * 不支持时实现必须**忽略** initial 并返回热门列表，不能报错。
 */
export interface ContractArtistPage {
  list: ContractArtist[];
  /** 该音源是否支持服务端按首字母筛选 */
  initialSupported: boolean;
  /** 是否还有下一页（按总数或音源自带的 more 标志判断） */
  hasMore: boolean;
}

/** 专辑 */
export interface ContractAlbum {
  id: string;
  platform: Source;
  name: string;
  artist: string;
  picUrl: string;
}

/** 榜单 */
export interface ContractChart {
  id: string;
  platform: Source;
  name: string;
  picUrl: string;
  description: string | null;
}

/** MV / 视频 */
export interface ContractVideo {
  id: string;
  platform: Source;
  name: string;
  picUrl: string;
  singer: string;
}

/** 歌词（原文 + 翻译；qt-pc Lyric 同构） */
export interface ContractLyric {
  lyric: string;
  translation: string;
}

// ---------- 宿主内置方法（注入；本期仅 request 一类） ----------

export interface SourceRequestOptions {
  method?: "GET" | "POST";
  /** 按平台伪造 Referer/UA 等（蓝本 makeHeaders 的头由脚本侧拼装） */
  headers?: Record<string, string>;
  body?: string;
  /** 默认 15000ms */
  timeoutMs?: number;
}

export interface SourceResponse {
  statusCode: number;
  /** header 名统一小写；酷我 Cookie 流程依赖 Set-Cookie 透传 */
  headers: Record<string, string>;
  /**
   * 宿主直接尝试按 JSON 解析响应体，失败则原样字符串。
   * 注意不能依赖 content-type 判断：上游普遍回 text/plain、x-javascript
   * 甚至 text/html 却携带 JSON 体（试点实测三平台皆如此，蓝本 http.ts
   * 的 directRequest 同样是无视 content-type 直接解析）。
   */
  body: unknown;
}

export type RequestBuiltin = (
  url: string,
  options?: SourceRequestOptions,
) => Promise<SourceResponse>;

// ---------- 取链方案 ----------

/**
 * "script" = 内置脚本包（默认方案：官方接口 + 全部实测第三方线路的聚合链，
 *            音质高→低、每档 ≤5 条、末级跨源，见 actions/play-url.ts）；
 * 其余 id  = drop-in 方案（schemes/ 下的 scheme.ts 自注册，见 registry.ts），
 *            目前仅 "premium"（优选聚合：脚本包每档 5 条上限放不下的剩余
 *            线路——kw=墨澜 → 独家 v6 → 洛雪，kg=酷狗官方占位；音质高→低、
 *            不跨源）。历史插件（world260809/裤佬/溯音/gdstudio/lx-host 插件
 *            群等）已于 2026-09-17 去重并整体并入脚本包，见
 *            schemes/lx-host/ 与《音源全量复测报告》。
 *
 * 原生 Rust Provider 已整体删除（历史存值 "rust" 读取时归一为 "script"），
 * 第三方音源接口只由脚本层承担。
 *
 * 新增歌源 = schemes/ 下写一个 scheme.ts，无需改任何枚举/校验/路由/UI。
 */
export type BuiltinSchemeId = "script";
export type SchemeId = BuiltinSchemeId | (string & {});
