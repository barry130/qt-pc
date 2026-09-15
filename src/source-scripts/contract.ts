/**
 * 音源访问层契约（插件化方案 v3 · 试点版）
 *
 * 本目录是「共享音源脚本包」在 qt-pc 内的落位（未来抽出为 packages/music-sources，
 * 供 qt-uniappx 以 uts 编译直接复用同一份源码）。规则（方案 v3）：
 * - 这里只放"调第三方源"的逻辑：编排、请求参数拼装、响应解析、回退；
 * - 不写任何 HTTP 执行实现 —— 由宿主注入 request builtin
 *   （PC：invoke → Rust reqwest；uniappx 未来：包装 http.ts directRequest）；
 * - 不写加密实现 —— 加密模块（kg-md5 / kw-des / 酷我 Cookie）后续以"原样文件"
 *   搬入本包；当前试点未含，kw 平台仍走 Rust 通道。
 *
 * 本文件是两端"方法名/模型/出入参完全一致"的唯一真源：
 * uniappx 接入时直接 import 本文件，禁止两端各写一份。
 */

/** 平台：沿用两端现有取值（qt-pc SourceId / qt-uniappx Source 同源），零映射成本 */
export type Source = "wyy" | "qq" | "kw" | "kg";

/** 音质：两端现值同口径 */
export type Quality = "128" | "320" | "flac";

/** 曲目：qt-pc Track / qt-uniappx Song 的公共超集（两端各写少量字段映射） */
export interface MusicInfo {
  id: string;
  name: string;
  singer: string;
  album: string;
  picUrl: string;
  /** 秒（两端同口径） */
  interval: number;
  musicId?: string | null;
}

/** 歌单（契约模型；宿主侧各自映射到 App 内的 Playlist 类型） */
export interface ContractPlaylist {
  id: string;
  platform: Source;
  name: string;
  picUrl: string;
  playCount: string;
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
 * "rust"   = 宿主内置实现（迁移基线/兜底，A/B 对拍基准）
 * "script" = 共享脚本包
 */
export type SchemeId = "rust" | "script";
