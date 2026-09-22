/**
 * 导入歌单：解析分享链接/ID → 拉远端歌单详情校验 → 收藏进「我的歌单」。
 *
 * 与 qt-uniappx 的导入流程一致：导入 = 收藏在线歌单（只落元数据），
 * 曲目在点开歌单详情时再向音源取，不做整单拷贝。
 */
import type { Playlist, SourceId } from "@/types";
import * as ipc from "@/services/ipc";
import * as sourceApi from "@/source-scripts";
import { parsePlaylistInput } from "@/lib/playlist-link";

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
  const parsed = parsePlaylistInput(text, forced);
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
