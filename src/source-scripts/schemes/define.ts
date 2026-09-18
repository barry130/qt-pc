/**
 * 音源方案自注册协议。
 *
 * 新增歌源 = 在 schemes/ 下任意子目录写一个 scheme.ts：
 *
 *   import { defineScheme } from "../define";
 *   export default defineScheme({
 *     id: "my-source",
 *     name: "我的音源",
 *     // 按平台写任意多个取链接口；只写网易云一个也行：
 *     playUrl: {
 *       wyy(request, song, quality) { ... 返回可播 URL，失败 throw },
 *     },
 *   });
 *
 * 未写出的平台 = 该源不支持 → 播放器按「换源顺序」自动到其他已注册源取链；
 * 全部源都取不到时最后仍回落 Rust 引擎（现状行为）。
 * registry.ts 用 import.meta.glob 自动发现所有 scheme.ts，
 * 无需改枚举/校验/路由/UI 任何其它文件。
 */
import type { MusicInfo, Quality, RequestBuiltin, Source } from "../contract";

/** 单平台取链接口：返回可播 URL；失败直接 throw（返回空串也按失败计）。 */
export type PlayUrlResolver = (
  request: RequestBuiltin,
  song: MusicInfo,
  quality: Quality,
) => string | Promise<string>;

export interface SourceScheme {
  /** 方案 id（唯一；进入 localStorage 的 lightlisten.source-scheme） */
  id: string;
  /** 设置页显示名 */
  name: string;
  description?: string;
  /**
   * 取链接口（按平台可写任意多个）：
   * - 对象形式：键 = 平台（wyy/qq/kw/kg），只写想接管的平台；
   * - 函数形式：一键接管全部四平台。
   * 未覆盖的平台由系统按「换源顺序」到其他源补位。
   */
  playUrl?: PlayUrlResolver | Partial<Record<Source, PlayUrlResolver>>;
}

export function defineScheme(scheme: SourceScheme): SourceScheme {
  return scheme;
}
