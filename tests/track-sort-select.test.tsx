// @vitest-environment jsdom
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TrackSortSelect } from "@/components/TrackSortSelect";
import { DEFAULT_TRACK_SORT } from "@/lib/track-sort";

/**
 * 排序控件的交互（用户 m00002 / m00029）。
 *
 * 口径是「两个弹窗」：上面选维度（按歌曲名 / 按专辑名 / 按歌手名），下面选方向
 * （正序 / 倒序），**默认两个都不勾选** —— 列表保持音源给的原始顺序，不显示
 * 「默认顺序」这种假选项。这几条守住：
 *   1. 初值 `none` → 两个触发按钮都显示占位（排序 / 方向），方向置灰不可点；
 *   2. 选维度 → `none` 之外的第一个编码（`album-asc`），方向随之解禁；
 *   3. 选方向 → 保留当前维度只换方向（`album-desc`）；
 *   4. 再点一次已选维度 → 回到 `none`（取消排序 = 默认不勾选）；
 *   5. 未知 / 老值 → 按未排序显示，不抛错。
 *
 * 组件是受控的（页面只存一个 `sortValue` 字符串），所以这里用一个小 Harness
 * 把 onChange 接回 value —— 与 6 个列表页 + DailyPage 的真实用法一致。
 */

function Harness({ initial = DEFAULT_TRACK_SORT }: { initial?: string }): React.JSX.Element {
  const [value, setValue] = useState(initial);
  return <TrackSortSelect value={value} onChange={setValue} />;
}

const fieldTrigger = (): HTMLElement => screen.getByRole("button", { name: "排序字段" });
const directionTrigger = (): HTMLElement => screen.getByRole("button", { name: "排序方向" });
const option = (name: string): HTMLElement => screen.getByRole("option", { name });

describe("TrackSortSelect（两个弹窗，默认都不勾选）", () => {
  it("初值 none：两个按钮都是占位文案，方向按钮置灰，没有展开的面板", () => {
    render(<Harness />);

    expect(fieldTrigger().textContent).toContain("排序");
    expect(directionTrigger().textContent).toContain("方向");
    expect((directionTrigger() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("选维度 → album-asc；方向随之解禁并显示正序", () => {
    render(<Harness />);

    fireEvent.click(fieldTrigger());
    expect(screen.getByRole("listbox", { name: "排序字段" })).toBeTruthy();
    fireEvent.click(option("按专辑名"));

    expect(fieldTrigger().textContent).toContain("按专辑名");
    expect(directionTrigger().textContent).toContain("正序");
    expect((directionTrigger() as HTMLButtonElement).disabled).toBe(false);
    // 面板点选后收起
    expect(screen.queryByRole("listbox")).toBeNull();
    // 再打开一次：已选维度带 aria-selected（勾选态）
    fireEvent.click(fieldTrigger());
    expect(screen.getByRole("option", { name: "按专辑名" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("选倒序 → 保留维度只换方向（album-desc）", () => {
    render(<Harness initial="album-asc" />);

    fireEvent.click(directionTrigger());
    expect(screen.getByRole("listbox", { name: "排序方向" })).toBeTruthy();
    fireEvent.click(option("倒序"));

    expect(fieldTrigger().textContent).toContain("按专辑名");
    expect(directionTrigger().textContent).toContain("倒序");
  });

  it("再点一次已选维度 → 回到 none（取消排序）", () => {
    render(<Harness initial="singer-desc" />);

    fireEvent.click(fieldTrigger());
    fireEvent.click(option("按歌手名"));

    expect(fieldTrigger().textContent).toContain("排序");
    expect(directionTrigger().textContent).toContain("方向");
    expect((directionTrigger() as HTMLButtonElement).disabled).toBe(true);
  });

  it("未知 / 老值按未排序显示，不抛错", () => {
    render(<TrackSortSelect value="bogus" onChange={() => {}} />);

    expect(fieldTrigger().textContent).toContain("排序");
    expect(directionTrigger().textContent).toContain("方向");
    expect((directionTrigger() as HTMLButtonElement).disabled).toBe(true);
  });

  it("无障碍名可被页面覆盖（label 默认「排序方式」）", () => {
    render(<Harness />);
    expect(screen.getByRole("group", { name: "排序方式" })).toBeTruthy();
  });
});
