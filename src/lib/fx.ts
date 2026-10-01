/**
 * 音效前端常量（均衡器频段 / 预设），数值口径与 Rust audio::fx 一致：
 * 十段 ISO 一倍频程、增益 ±12dB、前置放大 ±12dB。
 */

/** 十段均衡器中心频率（Hz） */
export const EQ_BANDS: number[] = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** 单段增益 / 前置放大的夹紧范围（dB），与引擎侧一致 */
export const EQ_GAIN_LIMIT_DB = 12;

/** 频段标签：1000 以上用 kHz 显示，滑条下方更省空间 */
export function eqBandLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
}

/** 预设：十段增益（dB）。参考主流播放器常见曲线微调，非逐条照抄 */
export const EQ_PRESETS: { name: string; gains: number[] }[] = [
  { name: "平直", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: "流行", gains: [-1, 1, 3, 4, 3, 1, -1, -1, -1, -1] },
  { name: "摇滚", gains: [5, 4, 1, -2, -3, -2, 1, 3, 4, 5] },
  { name: "古典", gains: [0, 0, 0, 0, 0, 0, -3, -3, -3, -5] },
  { name: "爵士", gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  { name: "人声", gains: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1] },
  { name: "低音增强", gains: [6, 5, 4, 2, 1, 0, 0, 0, 0, 0] },
  { name: "电子", gains: [5, 4, 1, 0, -2, 1, 1, 0, 2, 3] },
];

/** 倍速档位（播放条菜单与设置页默认倍速共用） */
export const SPEED_OPTIONS = [0.75, 1.0, 1.25, 1.5, 2.0];

/** 倍速显示：1 → 1.0×，0.75 → 0.75×，1.5 → 1.5× */
export function speedLabel(speed: number): string {
  const s = speed.toFixed(2).replace(/0+$/, "").replace(/\.$/, ".0");
  return `${s}×`;
}

/** 淡入淡出时长档位（ms） */
export const FADE_DURATION_OPTIONS = [150, 300, 500] as const;
