/**
 * 账户歌单同步（2026-10-26 需求；2026-10-27 改为「全量清单 + 已收藏标记 + 可取消
 * 收藏」）：登录音源账户后拉取该账户在平台侧的**全部**收藏歌单，逐行标注本地
 * 是否已收藏，用户可勾选未收藏的收进来、也可把已收藏的取消掉（只动本地收藏关系，
 * 不影响平台侧）；登录成功后默认自动触发（用户 2026-10-27 定稿：不再提供
 * 「登录后同步歌单」开关，登录即对比，嫌吵可在弹窗里直接关掉）。
 *
 * 数据链路：平台侧清单走数据包 v18 契约 accountPlaylists（source-scripts
 * 包装层，旧包缺入口抛「数据包版本过旧」提示）；本地侧只读
 * ipc.listMyPlaylists（本地自建歌单 platform 是 LOCAL_PLATFORM，天然被
 * 平台过滤排除）；收藏/取消收藏走 ipc.favoritePlaylist / ipc.unfavoritePlaylist
 * ——幂等的元数据写入，顺序逐个执行不做并发轰炸。
 *
 * **数据面登录态前置检查（2026-10-27 用户报「已经登录了，点击同步歌单报错」）**：
 * 宿主只在该源「数据请求使用登录态」开启时才把凭据灌进数据包 meta 面，关着时
 * 包侧一定回「未登录」——用户明明在账号页看到「已登录」，错误文案因此极容易
 * 被理解成「登录失效」。这里在读包之前先看本地库：有账号但数据面开关关着 →
 * 抛 {@link AccountSyncNeedsMetaLoginError}，UI 据此给「一键开启后重试」，
 * 不再把误导性的包侧文案直接摊给用户。
 */
import * as ipc from "@/services/ipc";
import {
  readSourceAuthAccounts,
  readSourceAuthTogglesFor,
} from "@/lib/source-auth";
import { accountPlaylists, type SourceAccountPlaylist } from "@/source-scripts";

/** 平台侧一行：歌单本体 + 本地「我的歌单」里是否已收藏（同平台同 pid） */
export interface AccountSyncRow {
  playlist: SourceAccountPlaylist;
  favorited: boolean;
}

/**
 * 平台侧全量清单与本地收藏态：rows 是**平台侧全部歌单**（保持平台返回顺序，
 * 每行带 favorited），missing = 其中本地还没收藏的（登录后自动提示用）。
 * 2026-10-27 需求：弹窗要展示「全部歌单 + 已收藏标记 + 可取消收藏」，
 * 早先的「只返回缺失项」语义由 missing 字段保留给自动触发逻辑。
 */
export interface AccountSyncPreview {
  rows: AccountSyncRow[];
  missing: SourceAccountPlaylist[];
  total: number;
}

/**
 * 同步前置检查没过的可识别错误：**已登录**（库里该源有账号）但「数据请求使用
 * 登录态」是关的。包侧只会看到「没凭据」→ 报「未登录」，对用户是误导；
 * 调用方据此展示「开启并同步」的一键入口，而不是原样抛包侧文案。
 * 继承 Error 并带稳定 `name`，跨模块/测试里都能用 {@link isAccountSyncNeedsMetaLoginError} 判型。
 */
export class AccountSyncNeedsMetaLoginError extends Error {
  readonly source: string;

  constructor(source: string) {
    super("账户歌单同步需要「数据请求使用登录态」开启：该源已登录，但数据面登录态当前是关闭的");
    this.name = "AccountSyncNeedsMetaLoginError";
    this.source = source;
  }
}

export function isAccountSyncNeedsMetaLoginError(
  err: unknown,
): err is AccountSyncNeedsMetaLoginError {
  return err instanceof AccountSyncNeedsMetaLoginError;
}

/** 同步前置检查：本地库有该源账号、但数据面开关关着 → 抛可识别错误。
 *  没有账号时不拦（由包侧给「未登录」，那是真的没登录）。 */
export async function assertAccountSyncMetaLogin(source: string): Promise<void> {
  const [accounts, toggles] = await Promise.all([
    readSourceAuthAccounts(),
    readSourceAuthTogglesFor(source),
  ]);
  if (accounts[source] !== undefined && !toggles.useMeta) {
    throw new AccountSyncNeedsMetaLoginError(source);
  }
}

/**
 * 预览：平台侧 accountPlaylists(source) 与本地已收藏在线歌单（platform 与该源
 * 匹配的 pid 集合）对比，逐行标注 favorited。
 * 包未实现（旧包）/未登录/网络错误原样抛错，调用方决定展示方式；唯一的例外是
 * 「库里有账号但数据面开关关着」——先抛 {@link AccountSyncNeedsMetaLoginError}，
 * 不让包侧的「未登录」误导用户。
 */
export async function accountSyncPreview(source: string): Promise<AccountSyncPreview> {
  await assertAccountSyncMetaLogin(source);
  const [remote, mine] = await Promise.all([accountPlaylists(source), ipc.listMyPlaylists()]);
  const localIds = new Set(mine.filter((p) => p.platform === source).map((p) => p.pid));
  const rows: AccountSyncRow[] = remote.map((playlist) => ({
    playlist,
    favorited: localIds.has(playlist.id),
  }));
  const missing = rows.filter((row) => !row.favorited).map((row) => row.playlist);
  return { rows, missing, total: remote.length };
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
 * 取消收藏结果：removed = 实际移除数；skipped = 执行时发现本地本来就没有；
 * failed = 单个失败数（不中断整体）。
 */
export interface UncollectAccountPlaylistsResult {
  removed: number;
  skipped: number;
  failed: number;
}

/**
 * 把勾选的平台侧歌单逐个从本地「我的歌单」移除（2026-10-27 需求：已收藏的要能
 * 取消收藏）。预检失败按「已收藏」继续尝试移除——unfavorite 对不存在项是幂等
 * 空操作，宁可多试一次也别因为预检抖动静默不动。顺序执行，单个失败只计数。
 *
 * 只动本地收藏关系，**不会**去平台侧取消收藏（用户原话：取消的是本地收藏）。
 */
export async function uncollectAccountPlaylists(
  source: string,
  picks: SourceAccountPlaylist[],
): Promise<UncollectAccountPlaylistsResult> {
  let removed = 0;
  let skipped = 0;
  let failed = 0;
  for (const pick of picks) {
    try {
      const favorited = await ipc.isPlaylistFavorited(source, pick.id).catch(() => true);
      if (!favorited) {
        skipped += 1;
        continue;
      }
      await ipc.unfavoritePlaylist(source, pick.id, pick.name, pick.picUrl);
      removed += 1;
    } catch (err) {
      failed += 1;
      console.warn(
        `[source-playlist-sync] 取消收藏歌单失败（${source} #${pick.id} ${pick.name}）`,
        err,
      );
    }
  }
  return { removed, skipped, failed };
}

/**
 * 登录成功后的自动同步决策：返回缺失清单（空数组 = 平台侧没有要补的）。
 * 用户 2026-10-27 定稿后这里没有任何开关门控——登录成功就对比，
 * 弹窗由调用方决定开不开。预览失败（包旧/未实现/网络）原样上抛——
 * 页面统一 console.warn 静默，不打扰登录成功的反馈。
 *
 * 例外：有账号但数据面登录态关着（{@link AccountSyncNeedsMetaLoginError}）
 * 属于「用户显式关掉的开关」，登录成功不弹窗打扰，等用户自己点「同步歌单」
 * 时再给可操作提示——所以这里静默吞掉、返回空清单。
 */
export async function autoSyncMissingAfterLogin(
  source: string,
): Promise<SourceAccountPlaylist[]> {
  try {
    return (await accountSyncPreview(source)).missing;
  } catch (err) {
    if (isAccountSyncNeedsMetaLoginError(err)) return [];
    throw err;
  }
}
