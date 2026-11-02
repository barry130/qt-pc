import { defineFragment } from "@/lib/i18n-fragment";

/**
 * 设置 → 播放（输出设备、无缝播放、本地优先、倍速）。
 *
 * 键前缀 `settings.playback.`；中文与英文必须一一对齐（少一条 `tsc` 会报错）。
 */
export const messages = defineFragment({
  zh: {
    "settings.playback.outputDevice.title": "音频输出设备",
    "settings.playback.outputDevice.desc": "跟随系统可随设备切换；固定设备适合多路输出",
    "settings.playback.outputDevice.followSystem": "跟随系统默认",
    "settings.playback.gapless.title": "无缝播放",
    "settings.playback.gapless.desc": "提前加载下一首，缩短间隔",
    "settings.playback.localFirst.title": "本地优先播放",
    "settings.playback.localFirst.desc": "优先播放已下载与本地文件；关掉则始终在线",
    "settings.playback.speed.title": "默认倍速",
    "settings.playback.speed.desc": "当前 {speed}；立即生效并记忆",
  },
  en: {
    "settings.playback.outputDevice.title": "Audio output device",
    "settings.playback.outputDevice.desc":
      "Following the system switches devices automatically; pinning one suits multi-output setups",
    "settings.playback.outputDevice.followSystem": "Follow system default",
    "settings.playback.gapless.title": "Gapless playback",
    "settings.playback.gapless.desc": "Preloads the next track to shorten the gap",
    "settings.playback.localFirst.title": "Prefer local files",
    "settings.playback.localFirst.desc":
      "Play downloaded and local files first; turn off to always stream",
    "settings.playback.speed.title": "Default speed",
    "settings.playback.speed.desc": "Currently {speed}; applies immediately and is remembered",
  },
});
