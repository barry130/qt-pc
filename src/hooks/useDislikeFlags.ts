import { useEffect, useState } from "react";
import type { Track } from "@/types";
import * as ipc from "@/services/ipc";

/**
 * 批量判定当前列表里哪些曲目已被屏蔽（`.cv-row` 行要淡化显示）。
 *
 * **不在这里自己算**：判定要经过 Rust 的 `normalize_key`（全角折叠、去标点、
 * 剥 `(Live)` 这类版本后缀）和歌手串拆分，前端重新实现一份迟早与后端漂移。
 * 所以无论列表多长，都只发一次 `check_disliked`，拿一个等长的布尔向量回来。
 *
 * 为什么按 `version` 而不是按 `tracks` 深比较刷新：判定结果只在**规则集合变化**
 * 时才可能变；`tracks` 每次分页/搜索都会换新引用，跟着它重查等于每次渲染都打 IPC。
 *
 * 失败降级为「全都没被屏蔽」：这是个纯装饰性的淡化标记，宁可漏标也不能让列表
 * 因为一次 IPC 失败整体不可用。
 */
export function useDislikeFlags(tracks: Track[], version: number): boolean[] {
  const [flags, setFlags] = useState<boolean[]>([]);

  useEffect(() => {
    if (tracks.length === 0) {
      setFlags([]);
      return;
    }
    let disposed = false;
    ipc
      .checkDisliked(tracks)
      .then((res) => {
        if (disposed) return;
        // 长度对不上时宁可全 false —— 错位的标记比没标记更糟
        const ok = Array.isArray(res) && res.length === tracks.length;
        setFlags(ok ? res : new Array<boolean>(tracks.length).fill(false));
      })
      .catch(() => {
        if (!disposed) setFlags(new Array<boolean>(tracks.length).fill(false));
      });
    return () => {
      disposed = true;
    };
    // version 参与依赖：规则增删后（哪怕 tracks 引用没变）必须重新判定
  }, [tracks, version]);

  return flags;
}
