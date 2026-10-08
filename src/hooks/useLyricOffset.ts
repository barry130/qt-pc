import { useCallback, useEffect, useRef, useState } from "react";

import { getLyricOffset, onLyricOffsetChanged, setLyricOffset } from "@/services/ipc";
import type { Track } from "@/types";

/**
 * 逐曲目歌词偏移（毫秒）。
 *
 * ## 为什么需要
 * 同一首歌在不同音源上的歌词时间轴常常差半秒到几秒（尤其换源兜底后：播放的是
 * A 源的音频、词是 B 源的），用户没有任何校正手段。lx-music-desktop 有同类设置
 * （`lyric_settings.offest` 一带），qt 此前 `lyric_settings.offset_ms` 列建好了但
 * 全库零读写 —— 表是死的。这里把读写两端都接上。
 *
 * ## 方向约定（全项目统一，改之前先看这里）
 * `offsetMs > 0` = 歌词**延后**出现。判定一律 `findActiveIndex(lines, position - offsetMs)`：
 * 想让歌词晚 500ms 出现，就得拿「播放进度 - 500ms」去查表，所以存的是 +500。
 * 反过来，点击第 N 行跳转要 `seekTo(line.timeMs + offsetMs)`。
 *
 * ## 谁在用
 * 播放页与桌面歌词窗口是两个独立 WebView（独立 JS 上下文、各持一份 store），
 * 所以两边都各自调这个 hook 去库里读，不共享内存状态。
 * 跨窗口同步靠 `lyric-offset-changed` 事件：写入方 `setLyricOffset` 落库后广播，
 * 两边订阅到就即时改自己的状态（2026-10-06：此前只在切歌时重读，导致在播放页
 * 改完偏移、桌面歌词仍停在旧值）。
 */
export const MAX_LYRIC_OFFSET_MS = 10_000;

/** 与 Rust `db::store::db_track_id()` 同口径：`platform:原始id` */
export function lyricTrackId(track: Track): string {
  return `${track.platform}:${track.id}`;
}

export interface LyricOffset {
  /** 已落库（或本次已提交）的偏移值，毫秒 */
  offsetMs: number;
  /** 拖动中的临时值；未拖动时等于 offsetMs */
  draftMs: number;
  setDraftMs: (ms: number) => void;
  /** 把 draftMs 提交到库里 */
  commit: () => void;
  /** 归零（= 提交 0） */
  reset: () => void;
  /** 相对当前值增减（步长毫秒），立即提交 */
  nudge: (deltaMs: number) => void;
}

function clamp(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(-MAX_LYRIC_OFFSET_MS, Math.min(MAX_LYRIC_OFFSET_MS, Math.round(ms)));
}

export function useLyricOffset(track: Track | null | undefined): LyricOffset {
  const trackId = track ? lyricTrackId(track) : "";
  const [offsetMs, setOffsetMs] = useState(0);
  const [draftMs, setDraftState] = useState(0);
  // 提交用的最新曲目键：切歌后再收到旧的异步读结果不得覆盖（防竞态）
  const keyRef = useRef(trackId);
  keyRef.current = trackId;

  useEffect(() => {
    if (trackId.length === 0) {
      setOffsetMs(0);
      setDraftState(0);
      return;
    }
    let stale = false;
    void (async () => {
      try {
        const ms = await getLyricOffset(trackId);
        if (stale) return;
        const v = clamp(ms);
        setOffsetMs(v);
        setDraftState(v);
      } catch {
        /* 读不到就当 0：偏移是锦上添花，读失败不该影响显示歌词 */
      }
    })();
    return () => {
      stale = true;
    };
  }, [trackId]);

  // 跨窗口同步：任一边改完偏移都会广播，这里收到就即时对齐。
  // 只在值真的不同时才 setState —— 自己刚写出去的那一份会原样广播回来，
  // 不比较的话会在拖动中途把 draft 打回去。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onLyricOffsetChanged((payload) => {
      if (disposed) return;
      if (payload.trackId.length === 0 || payload.trackId !== keyRef.current) return;
      const v = clamp(payload.offsetMs);
      setOffsetMs((cur) => (cur === v ? cur : v));
      setDraftState((cur) => (cur === v ? cur : v));
    })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const setDraftMs = useCallback((ms: number) => {
    setDraftState(clamp(ms));
  }, []);

  const commit = useCallback(() => {
    if (trackId.length === 0) return;
    setDraftState((cur) => {
      const v = clamp(cur);
      setOffsetMs(v);
      void setLyricOffset(trackId, v).catch(() => {
        /* 写失败不回滚界面：用户看到的偏移仍然是刚拖到的位置，下次进歌重读即可 */
      });
      return v;
    });
  }, [trackId]);

  const reset = useCallback(() => {
    if (trackId.length === 0) return;
    setOffsetMs(0);
    setDraftState(0);
    void setLyricOffset(trackId, 0).catch(() => undefined);
  }, [trackId]);

  const nudge = useCallback(
    (deltaMs: number) => {
      if (trackId.length === 0) return;
      setDraftState((cur) => {
        const v = clamp(cur + deltaMs);
        setOffsetMs(v);
        void setLyricOffset(trackId, v).catch(() => undefined);
        return v;
      });
    },
    [trackId],
  );

  return { offsetMs, draftMs, setDraftMs, commit, reset, nudge };
}
