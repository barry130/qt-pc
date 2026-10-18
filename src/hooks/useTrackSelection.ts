import { useCallback, useEffect, useRef } from "react";
import type { Track } from "@/types";
import {
  legacyTrackSelectionKey,
  selectTrackRange,
  trackSelectionKey,
  type TrackSelection,
} from "@/lib/track-selection";

type Modifiers = { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean };

/** 在可见列表上维护锚点；兼容仅接收 onToggle 的旧页面。 */
export function useTrackSelection(tracks: Track[], selection: TrackSelection | undefined) {
  const keyOf = selection?.keyOf ?? (selection?.onChange ? trackSelectionKey : legacyTrackSelectionKey);
  const anchor = useRef<string | null>(null);
  const hadSelection = useRef(false);
  const latest = useRef({ tracks, selection, keyOf });
  useEffect(() => {
    latest.current = { tracks, selection, keyOf };
    if (
      !selection ||
      (hadSelection.current && selection.ids.size === 0) ||
      !tracks.some((track) => keyOf(track) === anchor.current)
    ) {
      anchor.current = null;
    }
    hadSelection.current = (selection?.ids.size ?? 0) > 0;
  }, [tracks, selection, keyOf]);

  const commit = useCallback((next: Set<string>): void => {
    const current = latest.current.selection;
    if (!current) return;
    if (current.onChange) {
      current.onChange(next);
    } else {
      // 旧接口无法一次设置范围，按差集调用；不触碰未变化的选择。
      for (const key of current.ids) if (!next.has(key)) current.onToggle(key);
      for (const key of next) if (!current.ids.has(key)) current.onToggle(key);
    }
  }, []);

  /** 返回 true 代表处理了选择，调用方必须停止播放。 */
  const select = useCallback((index: number, modifiers: Modifiers, toggle: boolean | "anchor" = false): boolean => {
    const { tracks: visible, selection: current, keyOf: getKey } = latest.current;
    const track = visible[index];
    if (!current || !track) return false;
    const key = getKey(track);
    if (toggle === "anchor") {
      if (anchor.current === null) anchor.current = key;
      return true;
    }
    if (modifiers.shiftKey) {
      const keys = visible.map(getKey);
      const hasAnchor = anchor.current !== null && keys.includes(anchor.current);
      const next = selectTrackRange(keys, current.ids, anchor.current, key, modifiers.ctrlKey || modifiers.metaKey);
      if (!hasAnchor) anchor.current = key;
      commit(next);
      return true;
    }
    anchor.current = key;
    if (toggle || modifiers.ctrlKey || modifiers.metaKey) {
      const next = new Set(current.ids);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      commit(next);
      return true;
    }
    return false;
  }, [commit]);

  const selectAll = useCallback((): void => {
    const { tracks: visible, keyOf: getKey } = latest.current;
    commit(new Set(visible.map(getKey)));
  }, [commit]);
  const clear = useCallback((): void => {
    anchor.current = null;
    commit(new Set());
  }, [commit]);

  return { keyOf, select, selectAll, clear };
}
