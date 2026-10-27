/**
 * 账户歌单同步（2026-10-26 需求）：登录音源账户后拉取该账户在平台侧的收藏
 * 歌单，与本地已收藏的在线歌单（我的歌单里 platform 匹配的部分）diff，
 * 缺失项引导用户勾选收藏；登录成功后默认自动触发（用户 2026-10-27 定稿：
 * 不再提供「登录后同步歌单」开关，登录即对比，嫌吵可在弹窗里直接关掉）。
 *
 * 数据链路：平台侧清单走数据包 v18 契约 accountPlaylists（source-scripts
 * 包装层，旧包缺入口抛「数据包版本过旧」提示）；本地侧只读
 * ipc.listMyPlaylists（本地自建歌单 platform 是 LOCAL_PLATFORM，天然被
 * 平台过滤排除）；收藏动作走 ipc.favoritePlaylist——幂等的元数据写入，
 * 顺序逐个执行不做并发轰炸。
 */
import * as ipc from "@/services/ipc";
import { accountPlaylists, type SourceAccountPlaylist } from "@/source-scripts";

/** 平台侧与本地收藏的差集预览：missing 保持平台返回顺序；total = 平台侧歌单总数 */
export interface AccountSyncPreview {
  missing: SourceAccountPlaylist[];
  total: number;
}

/**
 * 预览同步差集：平台侧 accountPlaylists(source) 与本地已收藏在线歌单
 * （platform 与该源匹配的 pid 集合）diff，missing = 平台侧有、本地没有的。
 * 包未实现（旧包）/未登录/网络错误原样抛错，调用方决定展示方式。
 */
export async function accountSyncPreview(source: string): Promise<AccountSyncPreview> {
  const [remote, mine] = await Promise.all([accountPlaylists(source), ipc.listMyPlaylists()]);
  const localIds = new Set(mine.filter((p) => p.platform === source).map((p) => p.pid));
  const missing = remote.filter((p) => !localIds.has(p.id));
  return { missing, total: remote.length };
}

/** 收藏执行结果：collected = 新收藏数；skipped = 执行时发现本地已有（预览与
 *  点击之间可能被别处收藏过）而跳过数；failed = 单个失败数（不中断整体）。 */
export interface CollectAccountPlaylistsResult {
  collected: number;
  skipped: number;
  failed: number;
}

/**
 * 把勾选的平台侧歌单逐个收藏进本地：先查一遍本地收藏态（已在 → 跳过），
 * 再 favoritePlaylist（trackCount 转 playCount 字符串落库）。顺序执行；
 * 单个失败只计数不中断，最后由调用方按 failed>0 决定提示。
 */
export async function collectAccountPlaylists(
  source: string,
  picks: SourceAccountPlaylist[],
): Promise<CollectAccountPlaylistsResult> {
  let collected = 0;
  let skipped = 0;
  let failed = 0;
  for (const pick of picks) {
    try {
      const already = await ipc.isPlaylistFavorited(source, pick.id).catch(() => false);
      if (already) {
        skipped += 1;
        continue;
      }
      await ipc.favoritePlaylist(
        source,
        pick.id,
        pick.name,
        pick.picUrl,
        pick.trackCount === undefined ? undefined : String(pick.trackCount),
      );
      collected += 1;
    } catch (err) {
      failed += 1;
      console.warn(`[source-playlist-sync] 收藏歌单失败（${source} #${pick.id} ${pick.name}）`, err);
    }
  }
  return { collected, skipped, failed };
}

/**
 * 登录成功后的自动同步决策：返回缺失清单（空数组 = 平台侧没有要补的）。
 * 用户 2026-10-27 定稿后这里没有任何开关门控——登录成功就对比，
 * 弹窗由调用方决定开不开。预览失败（包旧/未实现/网络）原样上抛——
 * 页面统一 console.warn 静默，不打扰登录成功的反馈。
 */
export async function autoSyncMissingAfterLogin(
  source: string,
): Promise<SourceAccountPlaylist[]> {
  return (await accountSyncPreview(source)).missing;
}
