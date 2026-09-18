/**
 * 歌词（lyric）动作 —— 蓝本 lyrics()/lyricTranslation()（music-api.ts:3009/:3173）
 * 的组合移植。
 *
 * 原文：各平台原语（kg 原语内部按蓝本直接做网易云搜索兜底）；
 * 翻译：蓝本仅网易云有（tlyric），其余平台返回空串。
 * 蓝本的 local 分支不进脚本层（local 源由宿主处理）。
 */
import type { ContractLyric, MusicInfo, RequestBuiltin, Source } from "../contract";
import { kg } from "../platforms/kg";
import { kw } from "../platforms/kw";
import { qq } from "../platforms/qq";
import { wyy } from "../platforms/wyy";

export async function getLyric(
  request: RequestBuiltin,
  source: Source,
  song: MusicInfo,
): Promise<ContractLyric> {
  const platform = source === "qq" ? qq : source === "kw" ? kw : source === "kg" ? kg : wyy;
  // 原文按蓝本语义容错：失败返回空串而不是抛错（歌词缺失不应打断播放）
  const lyric = await platform.lyric(request, song).catch(() => "");
  const translation =
    source === "wyy"
      ? await wyy.lyricTranslation(request, song).catch(() => "")
      : "";
  return { lyric, translation };
}
