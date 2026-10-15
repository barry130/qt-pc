/**
 * 下载完成后补写歌词 sidecar（`<音频文件名>.lrc`）。
 *
 * Rust 侧在下载成功时就地落一份本地缓存词（`download.rs` 的 `save_download_extras`），
 * 但「下载当时库里还没有词」的新歌不会有 `.lrc`。这里盯全局下载列表：任务从
 * 非完成态翻到「已完成」的那一次，取一遍词（`getPlaybackLyric` 自带缓存与落库），
 * 有词就经 `write_download_lyric` 写到歌曲旁边。
 *
 * 取词 / 写盘失败一律静默跳过：sidecar 是锦上添花，不该弹错误打扰用户。
 *
 * 首轮快照只记录状态、不回填：启动时列表里已有一批 done 任务，多为历史任务
 * （有的连文件都不在了），挨个取词是纯浪费，还会瞬间打一堆源站请求。
 */
import { getPlaybackLyric } from "@/lib/localOnline";
import { getDownloadSaveLyric, writeDownloadLyric } from "@/services/ipc";
import type { DownloadTask } from "@/types";

/** 上一轮看到的任务状态（id → status）。翻到 done 的那一次才补词。 */
const lastStatus = new Map<string, DownloadTask["status"]>();
/** 是否已记过第一轮快照（第一轮不回填，见文件头说明） */
let primed = false;
/** 补词队列：串行执行，多个任务同时完成也不对源站瞬间并发取词 */
let queue: Promise<void> = Promise.resolve();

/** 单个任务的补词（开关每次都读：设置中途被关掉，剩下的就不再跑） */
async function backfillLyricSidecar(task: DownloadTask): Promise<void> {
  if (!(await getDownloadSaveLyric())) return;
  const lyric = await getPlaybackLyric(task.track, null);
  // 纯音乐 / 源站没词：lrc 为空，不落文件（与 Rust 侧 save_download_extras 同口径）
  if (lyric.lrc.trim().length > 0) {
    await writeDownloadLyric(task.id, lyric.lrc);
  }
}

/**
 * 每次下载列表刷新后调用（AppShell 订阅 useDownloadsStore）：记录本轮状态，
 * 把「刚翻到已完成」的任务排进补词队列。同步返回，不阻塞刷新。
 */
export function syncDownloadLyricSidecars(tasks: DownloadTask[]): void {
  const justDone: DownloadTask[] = [];
  for (const t of tasks) {
    const prev = lastStatus.get(t.id);
    lastStatus.set(t.id, t.status);
    // 任务从列表消失（删除）时状态留在 map 里没关系：id 不会复用
    if (primed && prev !== undefined && prev !== "done" && t.status === "done") {
      justDone.push(t);
    }
  }
  primed = true;
  for (const t of justDone) {
    queue = queue
      .then(() => backfillLyricSidecar(t))
      .catch(() => undefined); // 单个失败不断链，也不打扰用户
  }
}
