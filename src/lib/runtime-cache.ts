import * as ipc from "@/services/ipc";
import { clearChartDetailCache } from "@/lib/chart-detail";
import { clearArtistIdCache } from "@/lib/artist-id";
import { clearArtistPicCache } from "@/lib/artist-pic";
import { clearPagedAllJobs } from "@/lib/paged-all";
import {
  clearLyricCandidateCache,
  clearLocalOnlineMetaCache,
  clearPlaybackLyricCache,
} from "@/lib/localOnline";
import { clearSourceSwitchCache } from "@/lib/source-switch";
import { clearQualityCeilingCache } from "@/lib/quality-fallback";
import { clearPlayUrlLines } from "@/source-scripts/playurl-line";

/**
 * 设置页可选清理的进程内缓存类别。
 * 这些数据都能从音源包或当前页面重新取得，不包含 SQLite、下载文件或浏览器用户数据。
 */
export type RuntimeCacheKind =
  | "playUrl"
  | "sourceCandidates"
  | "lyricCandidates"
  | "chartDetails"
  | "pageResults";

/** 清理一个进程内缓存类别，返回实际清理的条目数。 */
export async function clearRuntimeCache(kind: RuntimeCacheKind): Promise<number> {
  switch (kind) {
    case "playUrl": {
      const result = await ipc.clearPlayUrlCache();
      // Rust 地址缓存与前端线路记忆是同一批取链结果的两份视图，要一起失效；
      // 档位上限记忆（quality-fallback）也属于取链结论，一并复位。
      return result.clearedCount + clearPlayUrlLines() + clearQualityCeilingCache();
    }
    case "sourceCandidates":
      return clearSourceSwitchCache();
    case "lyricCandidates":
      return clearLyricCandidateCache() + clearPlaybackLyricCache();
    case "chartDetails":
      return clearChartDetailCache();
    case "pageResults":
      return clearArtistIdCache() + clearArtistPicCache() + clearPagedAllJobs() + clearLocalOnlineMetaCache();
    default: {
      // 契约兜底：新增类别若忘了在这里接上，清理应当静默无事发生，
      // 而不是把「没接上」当成错误弹给用户。
      const exhaustive: never = kind;
      void exhaustive;
      return 0;
    }
  }
}
