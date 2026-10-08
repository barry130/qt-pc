/**
 * 导入歌单：解析分享链接/ID → 拉远端歌单详情校验 → 收藏进「我的歌单」。
 *
 * 与 qt-uniappx 的导入流程一致：导入 = 收藏在线歌单（只落元数据），
 * 曲目在点开歌单详情时再向音源取，不做整单拷贝。
 */
import type { Playlist, SourceId } from "@/types";
import * as ipc from "@/services/ipc";
import * as sourceApi from "@/source-scripts";

export interface PlaylistImportResult {
  /** 远端歌单详情（含名称/封面/播放量） */
  playlist: Playlist;
  /** true = 之前已收藏过，本次没有重复写入 */
  already: boolean;
}

/**
 * 导入歌单（四源：wyy / qq / kg / kw）。
 *
 * @param text 用户粘贴的分享链接、分享文案或歌单 ID
 * @param forced 识别不出平台时（纯数字 ID）手动指定的平台
 * @throws 输入无法识别 / 歌单不存在或取不到 / 落库失败
 */
export async function importPlaylist(
  text: string,
  forced?: SourceId,
): Promise<PlaylistImportResult> {
  // 2026-10-06：解析改走音源包的 parseSheet 入口（两端唯一权威实现），
  // 老包环境下 source-scripts 内部自动回退到 PC 本地那份
  const parsed = await sourceApi.parseSheetInput(text, forced);
  if (!parsed) {
    throw new Error("无法识别歌单链接或 ID，请检查输入或手动选择平台");
  }
  // 先取详情：既校验歌单存在，也拿到收藏要用的名称/封面/播放量
  const playlist = await sourceApi.getPlaylistDetail(parsed.platform, parsed.id);
  if (!playlist || !playlist.name) {
    throw new Error("该歌单不存在或暂时无法访问");
  }
  const already = await ipc
    .isPlaylistFavorited(parsed.platform, parsed.id)
    .catch(() => false);
  if (!already) {
    await ipc.favoritePlaylist(
      parsed.platform,
      parsed.id,
      playlist.name,
      playlist.picUrl,
      playlist.playCount,
    );
  }
  return { playlist, already };
}

// ---------- 导入歌曲（对齐 qt-uniappx 歌单导入向导的「导入歌曲」模式） ----------

/** 导入目标：新建我方歌单（名称缺省用远程歌单名）或选一个已有的 */
export type ImportSongsTarget =
  | { kind: "new"; name?: string }
  | { kind: "existing"; id: string; name: string };

export interface ImportSongsResult {
  /** 目标我方歌单 pid */
  targetId: string;
  targetName: string;
  /** 实际新加入的歌数（已在目标歌单里的自动跳过） */
  added: number;
  total: number;
}

/**
 * 导入歌曲（整单拷贝）：解析链接 → 拉全量曲目 → 全部加进目标我方歌单。
 *
 * 与 importPlaylist（收藏引用，只落元数据）的区别：这里把远程歌单的每首歌
 * 落进我方歌单并按 (sid, pid) 推云端（批量接口，断网自动补推），语义与
 * qt-uniappx player.importSongsToPlaylist 一致。
 *
 * @throws 输入无法识别 / 歌单不存在或没有可导入的歌曲 / 建单或落库失败
 */
export async function importPlaylistSongs(
  text: string,
  forced: SourceId | undefined,
  target: ImportSongsTarget,
): Promise<ImportSongsResult> {
  const parsed = await sourceApi.parseSheetInput(text, forced);
  if (!parsed) {
    throw new Error("无法识别歌单链接或 ID，请检查输入或手动选择平台");
  }
  const playlist = await sourceApi.getPlaylistDetail(parsed.platform, parsed.id);
  const tracks = playlist?.tracks ?? [];
  if (!playlist?.name || tracks.length === 0) {
    throw new Error("该歌单不存在或没有可导入的歌曲");
  }
  let targetId: string;
  let targetName: string;
  if (target.kind === "new") {
    // 名称留空 = 默认用远程歌单名（与移动端一致）
    targetName = (target.name ?? "").trim() || playlist.name;
    targetId = await ipc.createPlaylist(targetName);
  } else {
    targetId = target.id;
    targetName = target.name;
  }
  const added = await ipc.addTracksToPlaylist(targetId, tracks);
  return { targetId, targetName, added, total: tracks.length };
}
