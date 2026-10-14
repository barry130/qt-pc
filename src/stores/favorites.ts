import { create } from "zustand";

/**
 * 收藏状态的「版本号」。
 *
 * 收藏的真值在 Rust（`liked_songs` / `liked_song_playlists`），这里**不缓存任何
 * 收藏数据**，只维护一个自增计数：任何一处成功收藏 / 取消收藏之后 `bump()`，
 * 所有挂着的 `useFavoriteFlags` 就会重新批量判定一次。
 *
 * 为什么需要它：收藏入口不止一个（播放条红心、列表行红心），而列表行的红心是
 * 批量查出来的。少了这个信号，就会出现「在播放条收藏了，回到列表那行还是空心」
 * —— 同一首歌在两个地方显示两种状态。`stores/dislikes.ts` 的 `version` 同理。
 */
interface FavoritesStore {
  /** 每次收藏态可能变化后自增：`useFavoriteFlags` 据此重新批量判定 */
  version: number;
  bump: () => void;
}

export const useFavoritesStore = create<FavoritesStore>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}));
