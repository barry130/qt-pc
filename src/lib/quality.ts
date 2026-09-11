import type { Quality } from "@/types";

/**
 * 三档音质（取值与 Rust `Quality` 的 serde 表示一致：128 / 320 / flac）。
 *
 * 两个入口，语义不同（REQUIREMENTS：设置管默认，播放条管当前这首）：
 * - 设置页「默认播放音质 / 默认下载音质」→ 写 settings，长期有效；
 * - 播放条上的音质菜单 → 只对当前这首生效，换歌回到默认。
 */
export const QUALITY_OPTIONS: {
  value: Quality;
  label: string;
  short: string;
}[] = [
  { value: "128", label: "标准", short: "128K" },
  { value: "320", label: "高品", short: "320K" },
  { value: "flac", label: "无损", short: "FLAC" },
];

/** 播放条上的紧凑标签（空间有限，只显示 320K / FLAC 这种） */
export function qualityShort(q: Quality): string {
  return QUALITY_OPTIONS.find((o) => o.value === q)?.short ?? q;
}

export function isQuality(v: unknown): v is Quality {
  return v === "128" || v === "320" || v === "flac";
}
