import { defineFragment } from "@/lib/i18n-fragment";

/**
 * 设置 → 播放条（按钮开关）。
 *
 * 键前缀 `settings.playerBar.`；中文与英文必须一一对齐（少一条 `tsc` 会报错）。
 * 按钮名 / 说明以 `lib/player-bar.ts` 的 id 为键：那边只声明默认中文，
 * 设置页按 id 到这里取当前语言的文案。
 */
export const messages = defineFragment({
  zh: {
    "settings.playerBar.hint":
      "除播放键外都能自由开关；除音量外最多展示 {max} 个，当前已选{selected}/{max}。",
    "settings.playerBar.loading": "正在读取播放条设置…",

    "settings.playerBar.buttons.playUrl.label": "播放链接",
    "settings.playerBar.buttons.playUrl.hint": "内部账号专用：查看当前歌曲的实际播放地址与取链线路",
    "settings.playerBar.buttons.speed.label": "播放倍速",
    "settings.playerBar.buttons.speed.hint": "倍速菜单（立即生效并记忆，所有歌曲通用）",
    "settings.playerBar.buttons.sleep.label": "睡眠定时",
    "settings.playerBar.buttons.sleep.hint": "定时停止播放（到点或播完当前曲目后停）",
    "settings.playerBar.buttons.collect.label": "收藏",
    "settings.playerBar.buttons.collect.hint": "收藏到本地歌单",
    "settings.playerBar.buttons.dislike.label": "不喜欢",
    "settings.playerBar.buttons.dislike.hint": "屏蔽当前歌曲 / 歌手（不再推荐）",
    "settings.playerBar.buttons.mode.label": "播放模式",
    "settings.playerBar.buttons.mode.hint": "列表循环 / 单曲循环 / 随机",
    "settings.playerBar.buttons.desktopLyric.label": "桌面歌词",
    "settings.playerBar.buttons.desktopLyric.hint": "桌面歌词窗口开关",
    "settings.playerBar.buttons.mini.label": "迷你模式",
    "settings.playerBar.buttons.mini.hint": "切到迷你播放器小窗（与主窗口互切）",
    "settings.playerBar.buttons.queue.label": "播放队列",
    "settings.playerBar.buttons.queue.hint": "展开 / 收起播放队列面板",
    "settings.playerBar.buttons.download.label": "下载",
    "settings.playerBar.buttons.download.hint": "下载当前歌曲（有曲目时才出现）",
    "settings.playerBar.buttons.quality.label": "音质",
    "settings.playerBar.buttons.quality.hint": "切换当前歌曲音质（本地音乐不显示）",
    "settings.playerBar.buttons.artist.label": "歌手",
    "settings.playerBar.buttons.artist.hint": "打开当前歌曲的歌手页（按歌手名搜作品）",
    "settings.playerBar.buttons.spectrum.label": "频谱",
    "settings.playerBar.buttons.spectrum.hint": "播放页频谱背景开关",
    "settings.playerBar.buttons.equalizer.label": "均衡器",
    "settings.playerBar.buttons.equalizer.hint": "打开均衡器 / 音效设置面板",
    "settings.playerBar.buttons.share.label": "分享",
    "settings.playerBar.buttons.share.hint": "复制歌曲信息（歌名 / 歌手 / 链接）",
    "settings.playerBar.buttons.source.label": "换源",
    "settings.playerBar.buttons.source.hint": "当前源不支持时，搜索其他音源的这首歌并切换",
    "settings.playerBar.buttons.volume.label": "音量",
    "settings.playerBar.buttons.volume.hint": "播放条最右侧的音量滑块",
  },
  en: {
    "settings.playerBar.hint":
      "All buttons except Play can be toggled; up to {max} are shown in addition to volume — {selected}/{max} selected.",
    "settings.playerBar.loading": "Reading player bar settings…",

    "settings.playerBar.buttons.playUrl.label": "Playback URL",
    "settings.playerBar.buttons.playUrl.hint":
      "Internal accounts only: view the current track's resolved playback URL and how it was resolved",
    "settings.playerBar.buttons.speed.label": "Playback speed",
    "settings.playerBar.buttons.speed.hint":
      "Speed menu (applies immediately, remembered, and shared by all tracks)",
    "settings.playerBar.buttons.sleep.label": "Sleep timer",
    "settings.playerBar.buttons.sleep.hint":
      "Stop playback on a timer (at the set time or after the current track)",
    "settings.playerBar.buttons.collect.label": "Favorite",
    "settings.playerBar.buttons.collect.hint": "Add to a local playlist",
    "settings.playerBar.buttons.dislike.label": "Dislike",
    "settings.playerBar.buttons.dislike.hint":
      "Hide the current track or artist from recommendations",
    "settings.playerBar.buttons.mode.label": "Play mode",
    "settings.playerBar.buttons.mode.hint": "Repeat all / repeat one / shuffle",
    "settings.playerBar.buttons.desktopLyric.label": "Desktop lyrics",
    "settings.playerBar.buttons.desktopLyric.hint": "Toggle the desktop lyrics window",
    "settings.playerBar.buttons.mini.label": "Mini player",
    "settings.playerBar.buttons.mini.hint":
      "Switch to the mini player window (toggles with the main window)",
    "settings.playerBar.buttons.queue.label": "Play queue",
    "settings.playerBar.buttons.queue.hint": "Expand or collapse the play queue panel",
    "settings.playerBar.buttons.download.label": "Download",
    "settings.playerBar.buttons.download.hint":
      "Download the current track (shown only when a track is playing)",
    "settings.playerBar.buttons.quality.label": "Audio quality",
    "settings.playerBar.buttons.quality.hint":
      "Change the current track's quality (hidden for local music)",
    "settings.playerBar.buttons.artist.label": "Artist",
    "settings.playerBar.buttons.artist.hint":
      "Open the current track's artist page (search their work by artist name)",
    "settings.playerBar.buttons.spectrum.label": "Spectrum",
    "settings.playerBar.buttons.spectrum.hint":
      "Toggle the spectrum background on the playing page",
    "settings.playerBar.buttons.equalizer.label": "Equalizer",
    "settings.playerBar.buttons.equalizer.hint": "Open the equalizer / sound settings panel",
    "settings.playerBar.buttons.share.label": "Share",
    "settings.playerBar.buttons.share.hint": "Copy track info (title / artist / link)",
    "settings.playerBar.buttons.source.label": "Switch source",
    "settings.playerBar.buttons.source.hint":
      "When the current source lacks this track, search other sources and switch",
    "settings.playerBar.buttons.volume.label": "Volume",
    "settings.playerBar.buttons.volume.hint":
      "The volume slider at the far right of the player bar",
  },
});
