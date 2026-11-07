import { create } from "zustand";
import { getSetting, setSetting } from "@/services/ipc";
import { DEFAULT_PLAYING_BACKGROUND, parsePlayingBackground, type PlayingBackgroundPreference } from "@/lib/playing-background";

export const PLAYING_STYLE_KEY = "playing.style";
export const PLAYING_BACKGROUND_KEY = "playing.background";
export const PLAYING_STYLES = [
  { id: "classic", label: "经典唱片", description: "旋转唱片与滚动歌词" },
  { id: "rhythm", label: "歌词律动", description: "大字歌词随节奏起伏" },
  { id: "gallery", label: "专辑画廊", description: "方形封面与留白歌词" },
  { id: "focus", label: "纯净歌词", description: "三行歌词，安静听歌" },
] as const;
export type PlayingStyle = (typeof PLAYING_STYLES)[number]["id"];

interface PlayingStyleStore {
  style: PlayingStyle;
  loaded: boolean;
  saveError: boolean;
  background: PlayingBackgroundPreference;
  backgroundLoaded: boolean;
  backgroundSaveError: boolean;
  load: () => Promise<void>;
  select: (style: PlayingStyle) => Promise<void>;
  selectBackground: (background: PlayingBackgroundPreference) => Promise<void>;
  retrySave: () => Promise<void>;
}

let loading: Promise<void> | null = null;
let writes: Promise<void> = Promise.resolve();
let revision = 0;
let backgroundRevision = 0;

/** 风格独立存入 settings；切换仅改变呈现，不触碰播放状态与队列。 */
export const usePlayingStyleStore = create<PlayingStyleStore>((set, get) => ({
  style: "classic",
  loaded: false,
  saveError: false,
  background: DEFAULT_PLAYING_BACKGROUND,
  backgroundLoaded: false,
  backgroundSaveError: false,
  load: () => {
    if (get().loaded && get().backgroundLoaded) return Promise.resolve();
    if (loading) return loading;
    const startedAt = revision;
    const backgroundStartedAt = backgroundRevision;
    const readStyle = get().loaded ? Promise.resolve() : getSetting(PLAYING_STYLE_KEY).then((saved) => {
      // 初次读取期间已手动切换：晚到的旧值不能覆盖选择。
      if (startedAt !== revision) return;
      set({ style: PLAYING_STYLES.find((item) => item.id === saved)?.id ?? "classic", loaded: true });
    }).catch(() => {
      // 读取失败不写默认值；下次进入播放页可以再试。
    });
    const readBackground = get().backgroundLoaded ? Promise.resolve() : getSetting(PLAYING_BACKGROUND_KEY).then((saved) => {
      // 布局与背景各自判代次：读取布局期间改背景，仍应恢复已存的布局。
      if (backgroundStartedAt !== backgroundRevision) return;
      set({ background: parsePlayingBackground(saved), backgroundLoaded: true });
    }).catch(() => {});
    loading = Promise.all([readStyle, readBackground]).then(() => {}).finally(() => { loading = null; });
    return loading;
  },
  select: (style) => {
    const selectedAt = ++revision;
    set({ style, loaded: true, saveError: false });
    // 串行写入，快速来回切换时仍以最后一次选择为准。
    writes = writes.then(async () => {
      try {
        await setSetting(PLAYING_STYLE_KEY, style);
        if (selectedAt === revision) set({ saveError: false });
      } catch {
        if (selectedAt === revision) set({ saveError: true });
      }
    });
    return writes;
  },
  selectBackground: (background) => {
    const selectedAt = ++backgroundRevision;
    set({ background, backgroundLoaded: true, backgroundSaveError: false });
    writes = writes.then(async () => {
      try {
        await setSetting(PLAYING_BACKGROUND_KEY, JSON.stringify(background));
        if (selectedAt === backgroundRevision) set({ backgroundSaveError: false });
      } catch {
        if (selectedAt === backgroundRevision) set({ backgroundSaveError: true });
      }
    });
    return writes;
  },
  retrySave: async () => {
    const { saveError, backgroundSaveError, style, background } = get();
    await Promise.all([
      saveError ? get().select(style) : undefined,
      backgroundSaveError ? get().selectBackground(background) : undefined,
    ]);
  },
}));
