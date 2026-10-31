// 歌词高亮色的对比度闸门（用户 2026-10-30：金黄色封面 + 浅色主题下「正在播放的
// 歌词看不清」）。extractCoverAccent 恒输出 hsl(h, 72%, 50%)，黄/青这类高亮度色相
// 压在近白底上只有 ~1.8:1；readableOnBackdrop 负责只改明度把对比度拉到 5:1，
// 色相必须原样保留（用户认的是「这首歌的颜色」）。
import { describe, expect, it } from "vitest";
import {
  DARK_BACKDROP,
  LIGHT_BACKDROP,
  contrastRatio,
  mixRgb,
  parseCssColor,
  readableOnBackdrop,
  relativeLuminance,
} from "@/lib/skins";

describe("对比度基础量", () => {
  it("黑白 21:1，同色 1:1", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 0);
    expect(contrastRatio([12, 34, 56], [12, 34, 56])).toBeCloseTo(1, 5);
  });

  it("相对亮度按 WCAG 权重，纯绿高于纯蓝", () => {
    expect(relativeLuminance([0, 255, 0])).toBeGreaterThan(relativeLuminance([0, 0, 255]));
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
  });

  it("mixRgb 按权重插值", () => {
    expect(mixRgb([255, 0, 0], [0, 0, 255], 0)).toEqual([0, 0, 255]);
    expect(mixRgb([255, 0, 0], [0, 0, 255], 1)).toEqual([255, 0, 0]);
    expect(mixRgb([255, 0, 0], [0, 0, 255], 0.5)).toEqual([128, 0, 128]);
  });
});

describe("parseCssColor", () => {
  it("支持 #rgb / #rrggbb / rgb() / rgba()", () => {
    expect(parseCssColor("#fff")).toEqual([255, 255, 255]);
    expect(parseCssColor("#0f0f23")).toEqual([15, 15, 35]);
    expect(parseCssColor("rgb(18, 52, 86)")).toEqual([18, 52, 86]);
    expect(parseCssColor("rgba(18, 52, 86, 0.5)")).toEqual([18, 52, 86]);
  });

  it("非法值返回 null（不抛）", () => {
    expect(parseCssColor("不是颜色")).toBeNull();
  });
});

describe("readableOnBackdrop", () => {
  it("金黄色封面在浅色主题上：原色不到 3:1，校正后 ≥5:1 且色相不变", () => {
    const raw = "hsl(50, 72%, 50%)";
    // 原色 #dbbd24 在近白底上只有 ~1.9:1 —— 这就是用户截图里几乎看不见的那行
    expect(contrastRatio(hslFromString(raw), LIGHT_BACKDROP)).toBeLessThan(3);

    const fixed = readableOnBackdrop(raw, LIGHT_BACKDROP);
    expect(fixed).not.toBeNull();
    // 只动明度：色相 50、饱和度 72% 原样保留
    expect(fixed!.startsWith("hsl(50, 72%, ")).toBe(true);
    const fixedRgb = hslFromString(fixed!);
    expect(contrastRatio(fixedRgb, LIGHT_BACKDROP)).toBeGreaterThanOrEqual(5);
  });

  it("深蓝封面在深色主题上被提亮到达标", () => {
    const raw = "hsl(240, 72%, 50%)";
    expect(contrastRatio(hslFromString(raw), DARK_BACKDROP)).toBeLessThan(3);
    const fixed = readableOnBackdrop(raw, DARK_BACKDROP);
    expect(fixed!.startsWith("hsl(240, 72%, ")).toBe(true);
    expect(contrastRatio(hslFromString(fixed!), DARK_BACKDROP)).toBeGreaterThanOrEqual(5);
    // 提亮而不是压暗
    expect(hslLightness(fixed!)).toBeGreaterThan(50);
  });

  it("本来够对比度的颜色原样返回（不无谓改观感）", () => {
    expect(readableOnBackdrop("hsl(260, 72%, 40%)", LIGHT_BACKDROP)).toBe("hsl(260, 72%, 40%)");
  });

  it("同一封面在两种底色上给出不同明度、同一色相", () => {
    // 正红 L50：白底 4.2:1、深底 4.5:1，两边都不够 → 一个压暗、一个提亮
    const light = readableOnBackdrop("hsl(0, 72%, 50%)", LIGHT_BACKDROP)!;
    const dark = readableOnBackdrop("hsl(0, 72%, 50%)", DARK_BACKDROP)!;
    expect(hslLightness(light)).toBeLessThan(50);
    expect(hslLightness(dark)).toBeGreaterThan(50);
    expect(light.startsWith("hsl(0, 72%, ")).toBe(true);
    expect(dark.startsWith("hsl(0, 72%, ")).toBe(true);
    expect(contrastRatio(hslFromString(light), LIGHT_BACKDROP)).toBeGreaterThanOrEqual(5);
    expect(contrastRatio(hslFromString(dark), DARK_BACKDROP)).toBeGreaterThanOrEqual(5);
  });

  it("非 hsl() 输入返回 null，调用方回退主题主色", () => {
    expect(readableOnBackdrop("oklch(0.7 0.2 50)", LIGHT_BACKDROP)).toBeNull();
    expect(readableOnBackdrop("rgb(1, 2, 3)", LIGHT_BACKDROP)).toBeNull();
  });
});

/** 测试内用的 hsl → rgb（与实现同口径，避免依赖内部私有函数） */
function hslFromString(value: string): [number, number, number] {
  const m = value.match(/^hsl\(([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\)$/);
  if (!m) throw new Error(`不是 hsl 串: ${value}`);
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m2 = l - c / 2;
  const seg =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [
    Math.round((seg[0] + m2) * 255),
    Math.round((seg[1] + m2) * 255),
    Math.round((seg[2] + m2) * 255),
  ];
}

function hslLightness(value: string): number {
  return Number(value.match(/,\s*([\d.]+)%\)$/)![1]);
}
