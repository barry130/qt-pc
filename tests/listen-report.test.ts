import { describe, expect, it } from "vitest";
import { formatDayAxis, formatReportDate, formatReportDuration, listenDayKey, reportSourceLabel } from "@/lib/listen-report";

/** 用本地时间构造时间戳：测试机器在哪个时区，期望值都跟着走。 */
const localTime = (year: number, month: number, date: number, hour = 12): number =>
  new Date(year, month - 1, date, hour, 0, 0, 0).getTime();

describe("listenDayKey", () => {
  it("按本地自然日拼 key，不受 UTC 影响", () => {
    // 东八区凌晨 0-8 点若用 toISOString() 会退到前一天，这里必须仍是当天。
    expect(listenDayKey(localTime(2026, 3, 9, 0))).toBe("2026-03-09");
    expect(listenDayKey(localTime(2026, 3, 9, 7))).toBe("2026-03-09");
    expect(listenDayKey(localTime(2026, 3, 9, 23))).toBe("2026-03-09");
  });

  it("跨日边界只差一毫秒也要换 key", () => {
    const endOfDay = new Date(2026, 2, 9, 23, 59, 59, 999).getTime();
    expect(listenDayKey(endOfDay)).toBe("2026-03-09");
    expect(listenDayKey(endOfDay + 1)).toBe("2026-03-10");
  });

  it("月日补零", () => {
    expect(listenDayKey(localTime(2026, 1, 5))).toBe("2026-01-05");
  });

  it("非法时间返回空串而不是崩溃", () => {
    expect(listenDayKey(Number.NaN)).toBe("");
    expect(listenDayKey(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("formatDayAxis", () => {
  const today = "2026-03-09";

  it("1 天窗口只有一个「今天」", () => {
    expect(formatDayAxis(today, today, 1)).toBe("今天");
    // 1 天窗口里不该出现别的日子，但即便传进来也不该崩。
    expect(formatDayAxis("2026-03-08", today, 1)).toBe("今天");
  });

  it("7 天窗口用星期几，今天昨天优先", () => {
    expect(formatDayAxis("2026-03-09", today, 7)).toBe("今天");
    expect(formatDayAxis("2026-03-08", today, 7)).toBe("昨天");
    // 2026-03-06 是星期五。
    expect(formatDayAxis("2026-03-06", today, 7)).toBe("周五");
  });

  it("30 天窗口回到 M/D", () => {
    expect(formatDayAxis("2026-02-14", today, 30)).toBe("2/14");
    // 昨天的判定与窗口无关，30 天窗口里也仍然写「昨天」。
    expect(formatDayAxis("2026-03-08", today, 30)).toBe("昨天");
  });

  it("跨月跨年的昨天靠 Date 进位，不手算月末天数", () => {
    expect(formatDayAxis("2026-02-28", "2026-03-01", 7)).toBe("昨天");
    expect(formatDayAxis("2026-12-31", "2027-01-01", 7)).toBe("昨天");
  });

  it("无法解析的 key 原样返回", () => {
    expect(formatDayAxis("", today, 30)).toBe("");
    expect(formatDayAxis("garbage", today, 30)).toBe("garbage");
    expect(formatDayAxis("2026-03", today, 30)).toBe("2026-03");
  });
});

describe("formatReportDuration", () => {
  it("不足 1 分钟与分钟级", () => {
    expect(formatReportDuration(0)).toBe("不到 1 分钟");
    expect(formatReportDuration(59_999)).toBe("不到 1 分钟");
    expect(formatReportDuration(60_000)).toBe("1 分钟");
    expect(formatReportDuration(59 * 60_000)).toBe("59 分钟");
  });

  it("小时级按余数决定是否带分钟", () => {
    expect(formatReportDuration(60 * 60_000)).toBe("1 小时");
    expect(formatReportDuration(90 * 60_000)).toBe("1 小时 30 分");
  });

  it("负数与小数向下取整，不出现负时长", () => {
    expect(formatReportDuration(-5000)).toBe("不到 1 分钟");
    expect(formatReportDuration(119_999)).toBe("1 分钟");
  });
});

describe("formatReportDate", () => {
  it("按本地时间补零成 YYYY-MM-DD HH:mm", () => {
    expect(formatReportDate(localTime(2026, 3, 9, 8))).toBe("2026-03-09 08:00");
  });

  it("非法时间给破折号", () => {
    expect(formatReportDate(Number.NaN)).toBe("—");
  });
});

describe("reportSourceLabel", () => {
  const label = (id: string): string => (id === "wyy" ? "网易云" : "未知");

  it("已知音源用注册表里的名字", () => {
    expect(reportSourceLabel(label, "wyy")).toBe("网易云");
  });

  it("未知音源带上 id，方便排查是哪个平台的数据", () => {
    expect(reportSourceLabel(label, "kg")).toBe("未知音源（kg）");
  });
});
