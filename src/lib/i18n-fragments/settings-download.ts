import { defineFragment } from "@/lib/i18n-fragment";

/**
 * 设置 → 下载（目录、并发、命名、去重）。
 *
 * 键前缀 `settings.download.`；中文与英文必须一一对齐（少一条 `tsc` 会报错）。
 * 「更改位置」「恢复默认」借用 `common.changeLocation` / `common.restoreDefault`。
 */
export const messages = defineFragment({
  zh: {
    "settings.download.dir.title": "下载保存位置",
    "settings.download.dir.description": "默认在安装目录 Download；重名自动加序号",
    "settings.download.nameFormat.title": "下载文件名格式",
    "settings.download.nameFormat.description": "存盘文件名顺序；仅影响之后新开始的下载",
    "settings.download.nameFormat.artistFirst": "歌手 - 歌名",
    "settings.download.nameFormat.songFirst": "歌名 - 歌手",
    "settings.download.saveCover.title": "同时下载封面",
    "settings.download.saveCover.descriptionEmbed": "写进音频标签；不支持的格式存同目录图片",
    "settings.download.saveCover.descriptionSidecar": "存到歌曲旁边，文件名与歌曲相同",
    "settings.download.saveLyric.title": "同时下载歌词",
    "settings.download.saveLyric.descriptionEmbed":
      "写进音频标签（优先用已缓存的词）；不支持的格式存同名 .lrc",
    "settings.download.saveLyric.descriptionSidecar": "存为同名 .lrc（优先用已缓存的词）",
    "settings.download.storage.title": "下载存储方式",
    "settings.download.storage.description": "内嵌标签或存为独立文件；仅影响之后的任务",
    "settings.download.storage.embed": "音乐内嵌",
    "settings.download.storage.sidecar": "同目录文件",
    "settings.download.concurrency.title": "同时下载数",
    "settings.download.concurrency.description":
      "并发任务数，超出排队；建议 ≤3，过高易被限流",
    "settings.download.concurrency.ariaConfirm": "确认将同时下载数改为 {n}",
    "settings.download.concurrency.ariaSet": "同时下载数 {n}",
    "settings.download.concurrency.pendingLabel": "{n} 个？",
    "settings.download.concurrency.warning":
      "同时下载 {n} 个可能被音源判定为异常流量并临时封禁 IP，再点一次「{n} 个？」确认。",
  },
  en: {
    "settings.download.dir.title": "Download folder",
    "settings.download.dir.description":
      "Defaults to Download inside the install folder; duplicate names get a number suffix",
    "settings.download.nameFormat.title": "File name format",
    "settings.download.nameFormat.description":
      "Order of artist and title in saved file names; applies to new downloads only",
    "settings.download.nameFormat.artistFirst": "Artist - Title",
    "settings.download.nameFormat.songFirst": "Title - Artist",
    "settings.download.saveCover.title": "Also save cover art",
    "settings.download.saveCover.descriptionEmbed":
      "Embedded in the audio tags; unsupported formats get an image file alongside",
    "settings.download.saveCover.descriptionSidecar":
      "Saved next to the track, using the same file name",
    "settings.download.saveLyric.title": "Also save lyrics",
    "settings.download.saveLyric.descriptionEmbed":
      "Embedded in the audio tags (cached lyrics preferred); unsupported formats get a matching .lrc",
    "settings.download.saveLyric.descriptionSidecar":
      "Saved as a matching .lrc (cached lyrics preferred)",
    "settings.download.storage.title": "Storage method",
    "settings.download.storage.description":
      "Embed in the tags or save as separate files; applies to new downloads only",
    "settings.download.storage.embed": "Embedded in audio",
    "settings.download.storage.sidecar": "Separate files",
    "settings.download.concurrency.title": "Simultaneous downloads",
    "settings.download.concurrency.description":
      "Parallel downloads; extra tasks queue up. 3 or fewer recommended — higher counts may get rate-limited",
    "settings.download.concurrency.ariaConfirm": "Confirm raising simultaneous downloads to {n}",
    "settings.download.concurrency.ariaSet": "Simultaneous downloads: {n}",
    "settings.download.concurrency.pendingLabel": "{n}?",
    "settings.download.concurrency.warning":
      "Downloading {n} at once may be flagged as abnormal traffic and get your IP temporarily blocked. Click “{n}?” again to confirm.",
  },
});
