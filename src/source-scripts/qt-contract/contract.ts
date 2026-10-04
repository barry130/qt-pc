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

/**
 * 平台 id。**在线音源是开放字符串**：清单由数据包注册表声明
 * （qt-sources/src/registry.ts 的 SOURCES），宿主不持有任何白名单——
 * 新增/下线一个平台只改音源包，两端宿主无需发版。
 *
 * 唯一保留值是 `local`（本地曲库）：它不走任何在线接口，由宿主硬编码实现，
 * 且**绝不允许出现在音源包注册表里**（包侧 platformModuleOf 对它返回 null）。
 */
export type Source = string;

/** 本地曲库的保留源 id（宿主硬编码；与 Rust 的 provider::types::LOCAL_SOURCE 同值） */
export const LOCAL_SOURCE = "local";

/**
 * 音质档位 id。同样是开放字符串：档位清单由音源包注册表声明
 * （qt-sources/src/registry.ts 的 QUALITIES），宿主只做形状校验。
 * 想在包里新增一档（如 "hires"）只需在包内加一行，两端宿主菜单自动出现。
 */
export type Quality = string;

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
 * "script" = 内置脚本包（默认方案：官方接口 + 聚合链，音质高→低、每档
 *            ≤5 条、末级跨源，见 actions/play-url.ts）；
 * 其余 id  = drop-in 方案（schemes/ 下的 scheme.ts 自注册，见 registry.ts），
 *            目前仅 "premium"（优选聚合：脚本包每档 5 条上限放不下的剩余
 *            线路；音质高→低、不跨源）。历史第三方插件已于 2026-09-17
 *            去重并整体并入脚本包。
 *
 * 原生 Rust Provider 已整体删除（历史存值 "rust" 读取时归一为 "script"），
 * 第三方音源接口只由脚本层承担。
 *
 * 新增歌源 = schemes/ 下写一个 scheme.ts，无需改任何枚举/校验/路由/UI。
 */
export type BuiltinSchemeId = "script";
export type SchemeId = BuiltinSchemeId | (string & {});
