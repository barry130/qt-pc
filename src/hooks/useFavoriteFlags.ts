import { useEffect, useState } from "react";
import type { Track } from "@/types";
import * as ipc from "@/services/ipc";

/**
 * 批量判定当前列表里哪些曲目已被收藏（行尾红心要显示实心高亮）。
 *
 * 与 `useDislikeFlags` 同形：无论列表多长都只发一次 `check_favorite_flags`，
 * 拿一个等长的布尔向量回来 —— 逐行调 `is_favorite` 会把 IPC 通道打满。
 *
 * 为什么按 `version` 而不是按 `tracks` 深比较刷新：收藏态只在**用户真的收藏 /
 * 取消收藏**之后才可能变，而那正是 `useFavoritesStore.bump()` 的时刻；
 * `tracks` 每次分页 / 搜索都会换新引用，跟着它重查等于每次渲染都打 IPC。
 *
 * 失败降级为「全都没收藏」：宁可红心显示空心，也不能让整张列表因为一次
 * IPC 失败不可用。
 */
export function useFavoriteFlags(tracks: Track[], version: number): boolean[] {
  const [flags, setFlags] = useState<boolean[]>([]);

  useEffect(() => {
    if (tracks.length === 0) {
      setFlags([]);
      return;
    }
    let disposed = false;
    ipc
      .checkFavoriteFlags(tracks)
      .then((res) => {
        if (disposed) return;
        // 长度对不上时宁可全 false —— 错位的红心比没有红心更糟
        const ok = Array.isArray(res) && res.length === tracks.length;
        setFlags(ok ? res : new Array<boolean>(tracks.length).fill(false));
      })
      .catch(() => {
        if (!disposed) setFlags(new Array<boolean>(tracks.length).fill(false));
      });
    return () => {
      disposed = true;
    };
    // version 参与依赖：任何入口收藏后（哪怕 tracks 引用没变）都要重新判定
  }, [tracks, version]);

  return flags;
}
