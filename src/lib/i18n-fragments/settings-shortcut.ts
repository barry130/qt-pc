import { defineFragment } from "@/lib/i18n-fragment";

/**
 * 设置 → 快捷键。
 *
 * 键前缀 `settings.shortcut.`；中文与英文必须一一对齐（少一条 `tsc` 会报错）。
 * 「上一首」「下一首」「静音」复用基础词条 `player.prev` / `player.next` / `player.mute`；
 * 「加载中…」「恢复默认」复用 `common.loading` / `common.restoreDefault`。
 * 按键字符串（Ctrl / Space 等）不译。
 */
export const messages = defineFragment({
  zh: {
    "settings.shortcut.playPause": "播放 / 暂停",
    "settings.shortcut.volumeUp": "音量加",
    "settings.shortcut.volumeDown": "音量减",
    "settings.shortcut.desktopLyric": "桌面歌词开关",
    "settings.shortcut.lockLyric": "锁定 / 解锁桌面歌词",
    "settings.shortcut.listening": "按下新的快捷键组合（Esc 取消）…",
    "settings.shortcut.conflict":
      "该快捷键已被其它程序占用，当前无效；请点右侧输入框改绑一个组合。",
    "settings.shortcut.pressNew": "按下新组合…",
    "settings.shortcut.ariaLabel": "{name} 快捷键",
    "settings.shortcut.revert": "还原",
    "settings.shortcut.saving": "保存中…",
    "settings.shortcut.save": "保存并生效",
  },
  en: {
    "settings.shortcut.playPause": "Play / Pause",
    "settings.shortcut.volumeUp": "Volume up",
    "settings.shortcut.volumeDown": "Volume down",
    "settings.shortcut.desktopLyric": "Toggle desktop lyrics",
    "settings.shortcut.lockLyric": "Lock / unlock desktop lyrics",
    "settings.shortcut.listening": "Press a new key combination (Esc to cancel)…",
    "settings.shortcut.conflict":
      "Another app is already using this shortcut, so it won't work. Click the field on the right to bind another combination.",
    "settings.shortcut.pressNew": "Press keys…",
    "settings.shortcut.ariaLabel": "{name} shortcut",
    "settings.shortcut.revert": "Revert",
    "settings.shortcut.saving": "Saving…",
    "settings.shortcut.save": "Save and apply",
  },
});
