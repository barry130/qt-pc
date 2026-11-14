import { create } from "zustand";
import * as ipc from "@/services/ipc";
import { messages as generalMessages } from "@/lib/i18n-fragments/settings-general";
import { messages as playbackMessages } from "@/lib/i18n-fragments/settings-playback";
import { messages as playerBarMessages } from "@/lib/i18n-fragments/settings-player-bar";
import { messages as soundMessages } from "@/lib/i18n-fragments/settings-sound";
import { messages as networkMessages } from "@/lib/i18n-fragments/settings-network";
import { messages as downloadMessages } from "@/lib/i18n-fragments/settings-download";
import { messages as dislikeMessages } from "@/lib/i18n-fragments/settings-dislike";
import { messages as shortcutMessages } from "@/lib/i18n-fragments/settings-shortcut";
import { messages as aboutMessages } from "@/lib/i18n-fragments/settings-about";
import { messages as desktopLyricMessages } from "@/lib/i18n-fragments/settings-desktop-lyric";
import { messages as scrobbleMessages } from "@/lib/i18n-fragments/settings-scrobble";
import { messages as aiMessages } from "@/lib/i18n-fragments/settings-ai";
import { messages as sourcePackageMessages } from "@/lib/i18n-fragments/settings-source-package";
import { messages as playlistEditMessages } from "@/lib/i18n-fragments/playlist-edit";

/**
 * 界面语言（B6）：先落一套「界面框架」翻译，正文内容（歌名、歌单名、简介）不译。
 *
 * 设计取舍：
 * - **不引 i18next / react-intl**：本项目的翻译需求只有「界面词条 + 少量插值」，
 *   引一套运行时又多一份要跟着版本走的依赖；键值表 + 一个 `t()` 足够，
 *   而且键是字符串常量，漏键在 `tsc` 里就能被 `MessageKey` 类型挡下来。
 * - **不会出现中英混排的「半截」**：没翻的键回退中文（`FALLBACK`），
 *   因为中文是原文、英文缺键时英文用户看到中文总比看到 `player.play` 强。
 * - **切换即时生效**：locale 放在 zustand store 里，用 `useT()` 的组件会重渲染；
 *   同时写进后端设置（`ui.locale`），下次启动 `loadLocale()` 读回来。
 */

export type Locale = "zh-CN" | "en-US";

export const LOCALE_SETTING_KEY = "ui.locale";
export const DEFAULT_LOCALE: Locale = "zh-CN";

/** 词条表：键在下面 `zhCN` 里定义，`enUS` 必须一一对齐（缺键由 fallback 兜住） */
const zhCN = {
  "nav.home": "首页",
  "nav.dailyRecommend": "每日推荐",
  "nav.dailyNew": "每日新歌",
  "nav.playlists": "歌单广场",
  "nav.charts": "排行榜",
  "nav.myPlaylists": "我的歌单",
  "nav.sourceAccounts": "音源平台管理",
  "nav.radio": "私人 FM",
  "nav.podcast": "播客",
  "nav.library": "本地音乐",
  "nav.downloads": "下载管理",
  "nav.history": "最近播放",
  "nav.stats": "听歌报告",
  "nav.assistant": "音乐助手",
  "player.play": "播放",
  "player.pause": "暂停",
  "player.prev": "上一首",
  "player.next": "下一首",
  "player.mute": "静音",
  "player.unmute": "取消静音",
  "player.volume": "音量",
  "player.collect": "收藏到歌单",
  "player.openPlaying": "打开播放页",
  "player.backFromPlaying": "返回之前页面",
  "window.minimize": "最小化",
  "window.maximize": "最大化",
  "window.restore": "还原",
  "window.close": "关闭",
  "settings.language": "界面语言",
  "settings.languageHint": "只切换界面词条；歌名、歌单名等正文内容保持原样。",
  "locale.zh": "中文",
  "locale.en": "English",
  // 第二轮（R84）：侧边栏分组、设置页页签、播放队列面板、通用按钮
  "sidebar.group.online": "在线 · {source}",
  "sidebar.group.onlineUnavailable": "在线 · 不可用",
  "sidebar.group.mine": "我的",
  "sidebar.group.assistant": "助手",
  "sidebar.expand": "展开侧边栏",
  "sidebar.collapse": "折叠侧边栏",
  "settings.title": "设置",
  "settings.titleWithSection": "设置 · {section}",
  "settings.section.general": "通用",
  "settings.section.desktopLyric": "桌面歌词",
  "settings.section.playback": "播放",
  "settings.section.playerBar": "播放条",
  "settings.section.sound": "音效",
  "settings.section.download": "下载",
  "settings.section.network": "网络",
  "settings.section.scrobble": "听歌上报",
  "settings.section.ai": "AI 与模型",
  "settings.section.dislike": "不喜欢列表",
  "settings.section.sourcePackage": "音源包",
  "settings.section.shortcut": "快捷键",
  "settings.section.about": "关于",
  "queue.title": "播放队列（{count}）",
  "queue.empty": "队列为空",
  "queue.nowPlaying": "正在播放",
  "queue.playNext": "下一首播放",
  "queue.remove": "从队列移除",
  "queue.clear": "清空队列",
  "queue.clearAfter": "清空后续",
  "queue.close": "关闭队列",
  "queue.locate": "定位当前播放",
  "queue.batch": "批量管理",
  "queue.exitBatch": "退出批量管理",
  "queue.selected": "已选 {n} / {total}",
  "queue.selectAll": "全选",
  "queue.selectNone": "全不选",
  "queue.deleteSelected": "删除已选（{n}）",
  "queue.deleting": "删除中…",
  "common.confirm": "确定",
  "common.cancel": "取消",
  "common.save": "保存",
  "common.close": "关闭",
  "common.retry": "重试",
  "common.search": "搜索",
  "common.loading": "加载中…",
  "common.today": "今天",
  "common.yesterday": "昨天",
  "common.notDeveloped": "「{hint}」还没开发",
  "common.comingSoon": "将在后续里程碑交付",
  "common.changeLocation": "更改位置",
  "common.restoreDefault": "恢复默认",
  "appearance.mode.light": "浅色",
  "appearance.mode.dark": "深色",
  "appearance.mode.system": "跟随系统",
  "appearance.mode": "亮暗模式",
  "appearance.modeHint": "深色、浅色或跟随系统",
  "appearance.fontScale": "字体缩放",
  "appearance.fontScaleHint": "当前 {percent}%（85%–125%）",
  "appearance.reduceMotion": "减弱动效",
  "appearance.reduceMotionHint": "关闭过渡与动画",
  "appearance.followCover": "跟随封面取色",
  "appearance.followCoverHint": "按封面调整界面主色",
  "appearance.skins": "皮肤",
  "appearance.skinsFollowCover": "跟随封面取色中，皮肤不生效",
  "appearance.skinsHint": "选择主题配色",
  "appearance.customColor": "自定义主色",
  "appearance.custom": "自定义",
  "appearance.bgImage": "背景图片",
  "appearance.bgImageHint": "覆盖内容区、侧边栏与标题栏（最大 5MB）",
  "appearance.bgClear": "清除",
  "appearance.bgPreview": "背景预览",
  "appearance.bgPick": "点击选择图片",
  "appearance.bgFormats": "支持 JPG / PNG / WebP",
  "appearance.bgTooLarge": "图片过大，请选择 5MB 以内的图片",
} as const;

/** 基础词条（界面框架）的键，定义在下面的 `zhCN` / `enUS` 里 */
export type BaseMessageKey = keyof typeof zhCN;

/**
 * 设置页各分节的词条键（B6 第二轮续，R85）。
 *
 * 为什么分片：设置页 13 个分节、六百多条文案，全塞进本文件会变成一个谁都不愿意
 * 多看一眼的巨型文件，也让「两个人同时翻不同分节」变成改同一个文件的冲突。
 * 分片见 `lib/i18n-fragments/settings-*.ts`，这里只做类型串联与运行时合并。
 */
type FragmentMessageKey =
  | keyof (typeof generalMessages)["zh"]
  | keyof (typeof playbackMessages)["zh"]
  | keyof (typeof playerBarMessages)["zh"]
  | keyof (typeof soundMessages)["zh"]
  | keyof (typeof networkMessages)["zh"]
  | keyof (typeof downloadMessages)["zh"]
  | keyof (typeof dislikeMessages)["zh"]
  | keyof (typeof shortcutMessages)["zh"]
  | keyof (typeof aboutMessages)["zh"]
  | keyof (typeof desktopLyricMessages)["zh"]
  | keyof (typeof scrobbleMessages)["zh"]
  | keyof (typeof aiMessages)["zh"]
  | keyof (typeof sourcePackageMessages)["zh"]
  | keyof (typeof playlistEditMessages)["zh"]
;

export type MessageKey = BaseMessageKey | FragmentMessageKey;

/** 全部词条键（测试用来断言两份字典都覆盖到；运行时不必用） */
const enUS: Record<BaseMessageKey, string> = {
  "nav.home": "Home",
  "nav.dailyRecommend": "Daily Mix",
  "nav.dailyNew": "New Releases",
  "nav.playlists": "Playlists",
  "nav.charts": "Charts",
  "nav.myPlaylists": "My Playlists",
  "nav.sourceAccounts": "Source Platforms",
  "nav.radio": "Personal FM",
  "nav.podcast": "Podcasts",
  "nav.library": "Local Music",
  "nav.downloads": "Downloads",
  "nav.history": "Recently Played",
  "nav.stats": "Listening Report",
  "nav.assistant": "Music Assistant",
  "player.play": "Play",
  "player.pause": "Pause",
  "player.prev": "Previous",
  "player.next": "Next",
  "player.mute": "Mute",
  "player.unmute": "Unmute",
  "player.volume": "Volume",
  "player.collect": "Add to playlist",
  "player.openPlaying": "Open now playing",
  "player.backFromPlaying": "Back",
  "window.minimize": "Minimize",
  "window.maximize": "Maximize",
  "window.restore": "Restore",
  "window.close": "Close",
  "settings.language": "Language",
  "settings.languageHint":
    "Switches interface wording only; titles, playlist names and other content stay as-is.",
  "locale.zh": "中文",
  "locale.en": "English",
  "sidebar.group.online": "Online · {source}",
  "sidebar.group.onlineUnavailable": "Online · Unavailable",
  "sidebar.group.mine": "Mine",
  "sidebar.group.assistant": "Assistant",
  "sidebar.expand": "Expand sidebar",
  "sidebar.collapse": "Collapse sidebar",
  "settings.title": "Settings",
  "settings.titleWithSection": "Settings · {section}",
  "settings.section.general": "General",
  "settings.section.desktopLyric": "Desktop Lyrics",
  "settings.section.playback": "Playback",
  "settings.section.playerBar": "Player Bar",
  "settings.section.sound": "Sound",
  "settings.section.download": "Downloads",
  "settings.section.network": "Network",
  "settings.section.scrobble": "Scrobbling",
  "settings.section.ai": "AI & Models",
  "settings.section.dislike": "Disliked",
  "settings.section.sourcePackage": "Source Packs",
  "settings.section.shortcut": "Shortcuts",
  "settings.section.about": "About",
  "queue.title": "Queue ({count})",
  "queue.empty": "Queue is empty",
  "queue.nowPlaying": "Now playing",
  "queue.playNext": "Play next",
  "queue.remove": "Remove from queue",
  "queue.clear": "Clear queue",
  "queue.clearAfter": "Clear upcoming",
  "queue.close": "Close queue",
  "queue.locate": "Jump to current track",
  "queue.batch": "Batch edit",
  "queue.exitBatch": "Exit batch edit",
  "queue.selected": "{n} of {total} selected",
  "queue.selectAll": "Select all",
  "queue.selectNone": "Clear selection",
  "queue.deleteSelected": "Delete selected ({n})",
  "queue.deleting": "Deleting…",
  "common.confirm": "Confirm",
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.close": "Close",
  "common.retry": "Retry",
  "common.search": "Search",
  "common.loading": "Loading…",
  "common.today": "Today",
  "common.yesterday": "Yesterday",
  "common.notDeveloped": "{hint} isn't built yet",
  "common.comingSoon": "Coming in a later milestone",
  "common.changeLocation": "Change location",
  "common.restoreDefault": "Restore default",
  "appearance.mode.light": "Light",
  "appearance.mode.dark": "Dark",
  "appearance.mode.system": "Follow system",
  "appearance.mode": "Appearance",
  "appearance.modeHint": "Dark, light, or follow the system",
  "appearance.fontScale": "Font scale",
  "appearance.fontScaleHint": "Currently {percent}% (85%–125%)",
  "appearance.reduceMotion": "Reduce motion",
  "appearance.reduceMotionHint": "Turn off transitions and animations",
  "appearance.followCover": "Tint from cover art",
  "appearance.followCoverHint": "Pick the interface accent from the playing cover",
  "appearance.skins": "Skins",
  "appearance.skinsFollowCover": "Following cover colors, skins are inactive",
  "appearance.skinsHint": "Choose a theme palette",
  "appearance.customColor": "Custom accent color",
  "appearance.custom": "Custom",
  "appearance.bgImage": "Background image",
  "appearance.bgImageHint": "Covers the content area, sidebar and title bar (max 5 MB)",
  "appearance.bgClear": "Clear",
  "appearance.bgPreview": "Background preview",
  "appearance.bgPick": "Click to choose an image",
  "appearance.bgFormats": "JPG / PNG / WebP supported",
  "appearance.bgTooLarge": "Image is too large; please choose one under 5 MB",
};

const FRAGMENTS = [
  generalMessages,
  playbackMessages,
  playerBarMessages,
  soundMessages,
  networkMessages,
  downloadMessages,
  dislikeMessages,
  shortcutMessages,
  aboutMessages,
  desktopLyricMessages,
  scrobbleMessages,
  aiMessages,
  sourcePackageMessages,
  playlistEditMessages,
] as const;

const zhAll: Record<string, string> = Object.assign({}, zhCN, ...FRAGMENTS.map((f) => f.zh));
const enAll: Record<string, string> = Object.assign({}, enUS, ...FRAGMENTS.map((f) => f.en));

export const MESSAGE_KEYS = Object.keys(zhAll) as MessageKey[];

const DICTIONARIES: Record<Locale, Record<string, string>> = {
  "zh-CN": zhAll,
  "en-US": enAll,
};

type LocaleStore = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
};

export const useLocaleStore = create<LocaleStore>((set) => ({
  locale: DEFAULT_LOCALE,
  setLocale: (locale) => set({ locale }),
}));

export function normalizeLocale(raw: string | null | undefined): Locale {
  return raw === "en-US" || raw === "en" ? "en-US" : DEFAULT_LOCALE;
}

/**
 * 取词条。插值用 `{name}` 占位，例如 `t("player.volume")`。
 * 不传 locale 时用当前 store 里的语言（组件外调用也生效）。
 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const locale = useLocaleStore.getState().locale;
  const template = DICTIONARIES[locale][key] ?? zhAll[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** 组件里用这个：语言变了会跟着重渲染 */
export function useT(): typeof t {
  // 订阅 locale 只为了让组件在切换语言时重跑；t() 自己从 store 取
  useLocaleStore((s) => s.locale);
  return t;
}

/** 启动时读一次已存的语言（失败按中文，不打扰用户） */
export async function loadLocale(): Promise<Locale> {
  try {
    const raw = await ipc.getSetting(LOCALE_SETTING_KEY);
    const locale = normalizeLocale(raw);
    useLocaleStore.getState().setLocale(locale);
    return locale;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** 切换并落地：先改内存（界面立即变），再写设置（失败只是下次启动回到旧语言） */
export async function changeLocale(locale: Locale): Promise<void> {
  useLocaleStore.getState().setLocale(locale);
  try {
    await ipc.setSetting(LOCALE_SETTING_KEY, locale);
  } catch {
    // 设置写失败不回滚界面：用户眼前看到的就是他刚选的
  }
}
