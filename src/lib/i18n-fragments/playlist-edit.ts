import { defineFragment } from "@/lib/i18n-fragment";

/**
 * 歌单编辑（详情页 hero 的「更换封面」蒙层 + 编辑弹窗 + 我的歌单列表的换封面）。
 *
 * 键前缀 `playlist.edit.` / `playlist.detail.`；中文与英文必须一一对齐（少一条 `tsc` 会报错）。
 *
 * 为什么单独一片：这几个词条被「歌单详情页」和「我的歌单页」两处共用（换封面/云同步
 * 失败提示），放在哪一页的分片里都别扭；也避免两个页面各自维护一份同义文案。
 */
export const messages = defineFragment({
  zh: {
    // 歌单详情页 hero
    "playlist.detail.fallbackChart": "榜",
    "playlist.detail.fallbackPlaylist": "歌",
    // 编辑入口与弹窗
    "playlist.edit.changeCover": "更换封面",
    "playlist.edit.menu": "编辑歌单（名称 / 封面）",
    "playlist.edit.title": "编辑歌单",
    "playlist.edit.pickCover": "选择歌单封面",
    "playlist.edit.coverHint": "支持 JPG / PNG / WebP；登录后封面会同步到云端",
    "playlist.edit.restoreCover": "恢复默认封面",
    "playlist.edit.nameLabel": "歌单名称",
    "playlist.edit.nameEmpty": "歌单名不能为空",
    "playlist.edit.cancel": "取消",
    "playlist.edit.save": "保存",
    // 封面/改名的结果提示（云同步失败不阻塞本地，但要亮出原因）
    "playlist.edit.coverUpdatedCloudFailed": "封面已更新（本机），但同步云端失败：{error}",
    "playlist.edit.coverOffline": "未登录：封面只保存在本机，登录后更换才会同步云端",
    "playlist.edit.coverChangeFailed": "更换封面失败：{error}",
    "playlist.edit.coverRestoredCloudFailed": "本地已恢复默认封面，但云端清除失败：{error}",
    "playlist.edit.coverRestoreFailed": "恢复默认封面失败：{error}",
    "playlist.edit.saveFailed": "保存失败：{error}",
    "playlist.edit.unknownError": "未知错误",
  },
  en: {
    "playlist.detail.fallbackChart": "C",
    "playlist.detail.fallbackPlaylist": "S",
    "playlist.edit.changeCover": "Change cover",
    "playlist.edit.menu": "Edit playlist (name / cover)",
    "playlist.edit.title": "Edit playlist",
    "playlist.edit.pickCover": "Choose a playlist cover",
    "playlist.edit.coverHint": "JPG / PNG / WebP; covers sync to the cloud once signed in",
    "playlist.edit.restoreCover": "Restore default cover",
    "playlist.edit.nameLabel": "Playlist name",
    "playlist.edit.nameEmpty": "Playlist name can't be empty",
    "playlist.edit.cancel": "Cancel",
    "playlist.edit.save": "Save",
    "playlist.edit.coverUpdatedCloudFailed": "Cover updated locally, but cloud sync failed: {error}",
    "playlist.edit.coverOffline": "Not signed in: the cover stays on this device until you sign in",
    "playlist.edit.coverChangeFailed": "Failed to change the cover: {error}",
    "playlist.edit.coverRestoredCloudFailed":
      "Default cover restored locally, but clearing it in the cloud failed: {error}",
    "playlist.edit.coverRestoreFailed": "Failed to restore the default cover: {error}",
    "playlist.edit.saveFailed": "Failed to save: {error}",
    "playlist.edit.unknownError": "Unknown error",
  },
});
