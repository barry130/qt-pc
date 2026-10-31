// @vitest-environment jsdom
/**
 * 听歌热力图（`components/mine/ListenHeatmap` + `lib/listen-heatmap`）。
 *
 * 守的契约：
 * 1. 日历骨架：七行周一到周日，首列按第一天是星期几补空位，末列补满，
 *    总格数必须是 7 的整数倍（否则最后一周会被挤到上一行）；
 * 2. 色阶：没有播放是 0 档（`bg-secondary/70`），有播放的是 1～4 档；
 *    一天狂刷不会把其余天全压成同一档（阈值取四分位而不是按最大值等分）；
 * 3. 月份刻度：出现新月份才打标，间隔太近的跳过；
 * 4. 提示文案带日期与次数，零播放的天说「没有播放」而不是「不到 1 分钟」；
 * 5. 汇总只给一条 `role="img"` 的 aria 文案 —— 不能让 365 个格子各自朗读。
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ListenHeatmap } from "@/components/mine/ListenHeatmap";
import {
  buildListenHeatGrid,
  buildListenMonthGrid,
  heatCellDate,
  heatLevel,
  heatThresholds,
  weekdayIndex,
} from "@/lib/listen-heatmap";
import type { ListenDayPoint } from "@/types";

function day(y: number, m: number, d: number, playCount = 0): ListenDayPoint {
  return {
    day: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    playCount,
    totalPlayedMs: playCount * 3 * 60_000,
  };
}

/** 连续 n 天（从 start 起），playCount 由回调给 */
function series(start: Date, n: number, count: (index: number) => number): ListenDayPoint[] {
  return Array.from({ length: n }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    return day(date.getFullYear(), date.getMonth() + 1, date.getDate(), count(index));
  });
}

describe("weekdayIndex", () => {
  it("周一 = 0，周日 = 6", () => {
    expect(weekdayIndex(new Date(2026, 9, 26))).toBe(0); // 2026-10-26 是周一
    expect(weekdayIndex(new Date(2026, 10, 1))).toBe(6); // 2026-11-01 是周日
  });
});

describe("buildListenHeatGrid", () => {
  it("首列按第一天补空位、末列补满，总格数是 7 的倍数", () => {
    const points = series(new Date(2026, 9, 1), 10, () => 1); // 2026-10-01 周四
    const grid = buildListenHeatGrid(points);
    const total = grid.columns.reduce((sum, column) => sum + column.length, 0);
    expect(total % 7).toBe(0);
    for (const column of grid.columns) expect(column).toHaveLength(7);
    // 首列前 4 格是空位（周一～周四之前），第一个数据落在第 4 格
    expect(grid.columns[0]?.[3]?.day).toBe("2026-10-01");
    expect(grid.columns[0]?.[0]).toBeNull();
  });

  it("空数据给空网格", () => {
    expect(buildListenHeatGrid([])).toEqual({ columns: [], monthLabels: [] });
  });

  it("跨月时打月份刻度，且间隔太近的跳过", () => {
    const points = series(new Date(2026, 0, 1), 120, () => 2);
    const grid = buildListenHeatGrid(points);
    const labels = grid.monthLabels.map((item) => item.label);
    expect(labels[0]).toBe("1月");
    // 1～5 月各一个刻度，不会出现重复月份
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain("2月");
    expect(labels).toContain("4月");
  });
});

describe("heatThresholds / heatLevel", () => {
  it("没有播放的天是 0 档，有播放的落在 1～4 档", () => {
    const counts = [0, 0, 1, 2, 3, 4, 8, 20];
    const thresholds = heatThresholds(counts);
    expect(heatLevel(0, thresholds)).toBe(0);
    const levels = counts.filter((count) => count > 0).map((count) => heatLevel(count, thresholds));
    expect(Math.min(...levels)).toBe(1);
    expect(Math.max(...levels)).toBe(4);
  });

  it("一天狂刷不会把其余天压成同一档（阈值取四分位）", () => {
    const thresholds = heatThresholds([1, 1, 1, 1, 200]);
    expect(heatLevel(1, thresholds)).toBeLessThanOrEqual(2);
    expect(heatLevel(200, thresholds)).toBe(4);
  });

  it("全为 0 时阈值退化为 1/2/3，不抛错", () => {
    expect(heatThresholds([0, 0, 0])).toEqual([1, 2, 3]);
  });
});

describe("buildListenMonthGrid", () => {
  it("行 = 一周、列 = 周一到周日，行数等于周列布局的列数", () => {
    const month = series(new Date(2026, 9, 26), 30, () => 2);
    const grid = buildListenHeatGrid(month);
    const rows = buildListenMonthGrid(month);
    expect(rows.length).toBe(grid.columns.length);
    expect(rows.every((row) => row.length === 7)).toBe(true);
    rows.forEach((row, index) => {
      expect(row).toEqual(grid.columns[index]);
    });
  });

  it("首行按第一天是星期几补空位", () => {
    // 2026-10-01 是周四 → 首行前三格是窗口外的空位
    const rows = buildListenMonthGrid(series(new Date(2026, 9, 1), 7, () => 1));
    expect(rows[0]?.[0]).toBeNull();
    expect(rows[0]?.[2]).toBeNull();
    expect(rows[0]?.[3]?.day).toBe("2026-10-01");
  });

  it("空数据给空数组", () => {
    expect(buildListenMonthGrid([])).toEqual([]);
  });
});

describe("heatCellDate", () => {
  it("今天/昨天给相对说法，其余给 M月D日 周X", () => {
    expect(heatCellDate("2026-11-01", "2026-11-01")).toBe("今天");
    expect(heatCellDate("2026-10-31", "2026-11-01")).toBe("昨天");
    expect(heatCellDate("2026-10-26", "2026-11-01")).toBe("10月26日 周一");
  });
});

describe("ListenHeatmap", () => {
  const todayKey = "2026-11-01";
  const points = series(new Date(2025, 10, 1), 366, (index) => (index % 7 === 0 ? 6 : index % 3));

  it("渲染整年网格，格子数量是 7 的倍数，且有一格是今天", () => {
    const { container } = render(<ListenHeatmap points={points} todayKey={todayKey} />);
    const grid = container.querySelector('[role="img"]');
    expect(grid).not.toBeNull();
    expect(grid?.children.length).toBeGreaterThan(300);
    expect(grid?.children.length).toBe(Math.ceil(grid?.children.length ?? 0));
    expect((grid?.children.length ?? 0) % 7).toBe(0);
    const titles = Array.from(grid?.querySelectorAll("[title]") ?? []).map((el) => el.getAttribute("title") ?? "");
    expect(titles.some((title) => title.startsWith("今天"))).toBe(true);
    expect(titles.some((title) => title.endsWith("没有播放"))).toBe(true);
  });

  it("汇总只给一条 aria 文案，格子本身不朗读", () => {
    render(<ListenHeatmap points={points} todayKey={todayKey} />);
    const img = screen.getByRole("img");
    expect(img.getAttribute("aria-label")).toContain("共");
    expect(img.getAttribute("aria-label")).toContain("活跃");
    expect(img.querySelectorAll("[title]").length).toBeGreaterThan(0);
    // 格子不进无障碍树：没有独立的 button/status 角色
    expect(screen.queryAllByRole("status")).toHaveLength(0);
  });

  it("loading 且没有数据时给骨架，不画网格 aria", () => {
    const { container } = render(<ListenHeatmap points={[]} todayKey={todayKey} loading />);
    expect(container.querySelector('[role="img"]')).toBeNull();
    expect(container.querySelectorAll(".animate-pulse").length).toBe(53 * 7);
  });

  it("空数据（非 loading）时 aria 说明没有播放记录", () => {
    render(<ListenHeatmap points={[]} todayKey={todayKey} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("还没有播放记录");
  });

  it("短窗口走横向月历：七列表头是星期，格子按行排而不是按列排", () => {
    const month = series(new Date(2026, 9, 26), 30, () => 2);
    const { container } = render(<ListenHeatmap points={month} todayKey={todayKey} days={30} />);
    const head = Array.from(container.querySelectorAll(".text-center")).map((el) => el.textContent);
    expect(head).toEqual(["一", "二", "三", "四", "五", "六", "日"]);
    const grid = container.querySelector('[role="img"]');
    const cells = grid?.children.length ?? 0;
    expect(cells % 7).toBe(0);
    expect(cells).toBe(Math.ceil(30 / 7) * 7);
  });

  it("近一年仍走周列布局：没有星期表头行，格子数按列铺满", () => {
    const { container } = render(
      <ListenHeatmap points={points} todayKey={todayKey} days={365} />,
    );
    expect(container.querySelectorAll(".text-center")).toHaveLength(0);
    const grid = container.querySelector('[role="img"]');
    expect((grid?.children.length ?? 0) % 7).toBe(0);
    expect(grid?.children.length).toBeGreaterThan(300);
  });

  it("不传 days 时保持旧行为（周列布局），不误切月历", () => {
    const { container } = render(<ListenHeatmap points={points} todayKey={todayKey} />);
    expect(container.querySelectorAll(".text-center")).toHaveLength(0);
  });
});
