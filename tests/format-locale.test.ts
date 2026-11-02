// @vitest-environment jsdom
/**
 * 数值/日期本地化（B6 第二轮，DESIGN R84）。
 *
 * 中文界面用「万/亿」「N 分钟」「周X」，英文界面用「K/M/B」「N min」「Mon」。
 * 不依赖 Intl：同一台机器上 ICU 版本不同会给出不同写法，报告页与日志会对不上，
 * 所以这里直接断言我们自己拼出来的固定格式。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/ipc", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

import { formatPlayCount, formatDateTime } from "@/lib/format";
import { formatDayAxis, formatReportDate, formatReportDuration } from "@/lib/listen-report";
import { useLocaleStore } from "@/lib/i18n";

beforeEach(() => {
  useLocaleStore.getState().setLocale("zh-CN");
});

describe("播放量：万/亿 与 K/M/B", () => {
  it("中文：一万以下原样，往上走万、亿", () => {
    expect(formatPlayCount(999)).toBe("999");
    expect(formatPlayCount(9999)).toBe("9999");
    expect(formatPlayCount(23433)).toBe("2.3万");
    expect(formatPlayCount(234332)).toBe("23.4万");
    expect(formatPlayCount(1234567)).toBe("123万");
    expect(formatPlayCount(234332000)).toBe("2.3亿");
  });

  it("英文：千、百万、十亿", () => {
    useLocaleStore.getState().setLocale("en-US");
    expect(formatPlayCount(999)).toBe("999");
    expect(formatPlayCount(23433)).toBe("23.4K");
    expect(formatPlayCount(234332)).toBe("234K");
    expect(formatPlayCount(234332000)).toBe("234M");
    expect(formatPlayCount(2343320000)).toBe("2.3B");
  });

  it("字符串形态与空值照旧", () => {
    expect(formatPlayCount("234332")).toBe("23.4万");
    expect(formatPlayCount(null)).toBe("");
    expect(formatPlayCount(0)).toBe("");
    expect(formatPlayCount(-5)).toBe("");
  });
});

describe("时间点：中文 YYYY-MM-DD HH:mm，英文 Mon D, YYYY HH:mm", () => {
  // 2026-11-02 15:33 本地时间（不用 UTC，避免时区把断言搞乱）
  const at = new Date(2026, 10, 2, 15, 33).getTime();

  it("中文", () => {
    expect(formatDateTime(at)).toBe("2026-11-02 15:33");
    expect(formatReportDate(at)).toBe("2026-11-02 15:33");
  });

  it("英文", () => {
    useLocaleStore.getState().setLocale("en-US");
    expect(formatDateTime(at)).toBe("Nov 2, 2026 15:33");
    expect(formatReportDate(at)).toBe("Nov 2, 2026 15:33");
  });

  it("非法时间给破折号，不抛错", () => {
    expect(formatDateTime(Number.NaN)).toBe("—");
  });
});

describe("报告时长与趋势轴", () => {
  it("时长中英各一套", () => {
    expect(formatReportDuration(30_000)).toBe("不到 1 分钟");
    expect(formatReportDuration(5 * 60_000)).toBe("5 分钟");
    expect(formatReportDuration(2 * 3600_000 + 30 * 60_000)).toBe("2 小时 30 分");
    expect(formatReportDuration(2 * 3600_000)).toBe("2 小时");

    useLocaleStore.getState().setLocale("en-US");
    expect(formatReportDuration(30_000)).toBe("<1 min");
    expect(formatReportDuration(5 * 60_000)).toBe("5 min");
    expect(formatReportDuration(2 * 3600_000 + 30 * 60_000)).toBe("2 h 30 min");
    expect(formatReportDuration(2 * 3600_000)).toBe("2 h");
  });

  it("趋势轴：今天/昨天/周X 与 Today/Yesterday/Mon", () => {
    const today = "2026-11-02"; // 周一
    expect(formatDayAxis(today, today, 7)).toBe("今天");
    expect(formatDayAxis("2026-11-01", today, 7)).toBe("昨天");
    expect(formatDayAxis("2026-10-31", today, 7)).toBe("周六");
    expect(formatDayAxis("2026-10-12", today, 30)).toBe("10/12");

    useLocaleStore.getState().setLocale("en-US");
    expect(formatDayAxis(today, today, 7)).toBe("Today");
    expect(formatDayAxis("2026-11-01", today, 7)).toBe("Yesterday");
    expect(formatDayAxis("2026-10-31", today, 7)).toBe("Sat");
  });
});
