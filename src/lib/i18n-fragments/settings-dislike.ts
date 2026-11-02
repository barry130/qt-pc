import { defineFragment } from "@/lib/i18n-fragment";

/**
 * 设置 → 不喜欢列表。
 *
 * 键前缀 `settings.dislike.`；中文与英文必须一一对齐（少一条 `tsc` 会报错）。
 * 「加载中…」借用 `common.loading`。
 */
export const messages = defineFragment({
  zh: {
    "settings.dislike.rules.title": "屏蔽规则",
    "settings.dislike.rules.description": "不再出现在列表与自动播放里；手动点播不受限",
    "settings.dislike.count": "{n} 条",
    "settings.dislike.clearConfirm": "确认清空全部？",
    "settings.dislike.clear": "清空",
    "settings.dislike.empty": "还没有屏蔽任何歌曲",
    "settings.dislike.kindTitle.singer": "这位歌手的所有歌都不会自动出现",
    "settings.dislike.kindTitle.song": "这首歌（含同名不同版本）不会自动出现",
    "settings.dislike.kind.singer": "歌手",
    "settings.dislike.kind.song": "歌曲",
    "settings.dislike.unbanAria": "取消屏蔽 {name}",
    "settings.dislike.unban": "取消屏蔽",
    "settings.dislike.clearHint": "不可恢复；切换分区会自动取消",
  },
  en: {
    "settings.dislike.rules.title": "Block rules",
    "settings.dislike.rules.description":
      "Hidden from lists and autoplay; playing a song manually still works",
    "settings.dislike.count": "{n} blocked",
    "settings.dislike.clearConfirm": "Clear everything?",
    "settings.dislike.clear": "Clear",
    "settings.dislike.empty": "No blocked songs yet",
    "settings.dislike.kindTitle.singer": "No song by this artist will appear automatically",
    "settings.dislike.kindTitle.song":
      "This song (including other versions with the same name) won't appear automatically",
    "settings.dislike.kind.singer": "Artist",
    "settings.dislike.kind.song": "Song",
    "settings.dislike.unbanAria": "Unblock {name}",
    "settings.dislike.unban": "Unblock",
    "settings.dislike.clearHint": "Can't be undone; switching sections cancels this",
  },
});
