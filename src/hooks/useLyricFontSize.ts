import { useCallback, useEffect, useRef, useState } from "react";

import { getSetting, setSetting } from "@/services/ipc";

/**
 * 播放页歌词字号（px，指当前行/高亮行的大小）。
 *
 * ## 为什么需要
 * 歌词正文此前写死 `text-xl`（20px）高亮行 + `text-base`（16px）非高亮行：
 * 1080P 全屏嫌小、小窗口嫌大，用户无处可调。桌面歌词窗口早就有自己的
 * 字号（`lyric.window` 的 `fontSize`，还有滚轮快捷键），主播放页却没有 ——
 * 两处体验不一致。
 *
 * ## 存在哪
 * SQLite settings 表的 `lyric.fontSize`（走通用的 `get_setting` / `set_setting`，
 * 不需要后端加命令）。全局生效，不按曲目保存 —— 这是「看得清」的偏好，
 * 不是每首歌的时间轴校正（那种才按曲目存，见 `useLyricOffset`）。
 *
 * ## 为什么不用 localStorage
 * 与 `stores/appearance.ts` 同一条约定：外观类偏好唯一持久化位置是 settings 表，
 * 避免内存/库两份状态对不上。**也不写 html 的 font-size**（那是外观的
 * `fontScale`，全局缩放），这里只影响歌词块。
 *
 * ## 比例
 * 非高亮行 = 高亮的 0.8、译文 0.7、罗马音 0.6 —— 与改造前 20/16/14/12 的
 * 实际比例一致，调大调小只等比缩放，不会把译文撑得比正文还大。
 */
export const LYRIC_FONT_SIZE_KEY = "lyric.fontSize";
/** 默认 20px = 原 `text-xl`，保持改造前后的默认观感一致 */
export const LYRIC_FONT_SIZE_DEFAULT = 20;
export const LYRIC_FONT_SIZE_MIN = 14;
export const LYRIC_FONT_SIZE_MAX = 40;
/** 点一下 A− / A+ 的步长；滑杆也用这个步长，取值永远落在偶数上 */
export const LYRIC_FONT_SIZE_STEP = 2;

export const LYRIC_ACTIVE_RATIO = 1;
export const LYRIC_INACTIVE_RATIO = 0.8;
export const LYRIC_TRANSLATION_RATIO = 0.7;
export const LYRIC_ROMANIZATION_RATIO = 0.6;

export interface LyricFontSize {
  /** 当前字号（px）；未读到时是默认值 */
  px: number;
  /** 是否已从库里读到真实值。false 时不要回写，免得用默认值覆盖用户设置 */
  loaded: boolean;
  setPx: (px: number) => void;
  /** 相对增减（会被 clamp 到 MIN..MAX） */
  bump: (delta: number) => void;
  reset: () => void;
}

export function clampLyricFontSize(px: number): number {
  if (!Number.isFinite(px)) return LYRIC_FONT_SIZE_DEFAULT;
  // 取整到步长，滑杆/按钮/快捷键三个入口落到的值才会完全一致
  const stepped = Math.round(px / LYRIC_FONT_SIZE_STEP) * LYRIC_FONT_SIZE_STEP;
  return Math.min(LYRIC_FONT_SIZE_MAX, Math.max(LYRIC_FONT_SIZE_MIN, stepped));
}

/**
 * 写库去抖：拖滑杆时每个 change 都落库会把 SQLite 写爆，
 * 而且中间值毫无意义（与 `useLyricOffset` 的 draft/commit 同一个理由，
 * 只是这里没有「提交」按钮，所以改成 200ms 静默后写最后一次）。
 */
const WRITE_DEBOUNCE_MS = 200;
let pendingPx: number | null = null;
let writeTimer: number | null = null;

function scheduleWrite(px: number): void {
  pendingPx = px;
  // 每次改动都把计时器往后推（标准 debounce）：连续拖滑杆只在松手后写一次。
  // 不写成「第一个改动起算 200ms 后写」的节流，那样拖到一半写的还是中间值。
  if (writeTimer !== null) window.clearTimeout(writeTimer);
  writeTimer = window.setTimeout(() => {
    writeTimer = null;
    const value = pendingPx;
    pendingPx = null;
    if (value === null) return;
    void setSetting(LYRIC_FONT_SIZE_KEY, String(value)).catch(() => {
      // 库不可用（迁移中/只读）时保持界面生效即可，下次改动会重试 ——
      // 字号不是数据，丢一次写入不值得弹错误条打断听歌
    });
  }, WRITE_DEBOUNCE_MS);
}

export function useLyricFontSize(): LyricFontSize {
  const [px, setPxState] = useState<number>(LYRIC_FONT_SIZE_DEFAULT);
  const [loaded, setLoaded] = useState<boolean>(false);
  // 读到真实值之前，用户先点了 A+：读回结果不能把用户刚选的值盖掉
  const touchedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    void getSetting(LYRIC_FONT_SIZE_KEY)
      .then((raw) => {
        if (!alive) return;
        const parsed = raw === null || raw === "" ? NaN : Number(raw);
        if (!touchedRef.current) {
          setPxState(Number.isFinite(parsed) ? clampLyricFontSize(parsed) : LYRIC_FONT_SIZE_DEFAULT);
        }
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const setPx = useCallback((next: number) => {
    touchedRef.current = true;
    const clamped = clampLyricFontSize(next);
    setPxState(clamped);
    scheduleWrite(clamped);
  }, []);

  const bump = useCallback(
    (delta: number) => {
      // 用当前值算，不能依赖渲染闭包（连点时闭包里的 px 是旧的，会原地踏步）
      setPxState((current) => {
        const clamped = clampLyricFontSize(current + delta);
        touchedRef.current = true;
        scheduleWrite(clamped);
        return clamped;
      });
    },
    [],
  );

  const reset = useCallback(() => setPx(LYRIC_FONT_SIZE_DEFAULT), [setPx]);

  return { px, loaded, setPx, bump, reset };
}
