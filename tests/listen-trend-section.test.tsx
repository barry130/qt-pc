// @vitest-environment jsdom
/**
 * 听歌趋势区块换档时的「屏闪」（用户 m09915：点时间档 / 维度那两组 tag 会闪一下）。
 *
 * 成因是切档时把 report 置空：热力图与榜单整块被抽掉，卡片高度骤降，滚动容器把
 * 位置夹回、背景重排 —— 眼睛看到的就是闪一下。现在旧内容原地留着、压暗，顶部一条
 * 细进度条表示换档，新数据到达后原地替换。这组用例把这个行为锁住：
 * 换档期间列表不许消失、不许出现「还没有播放记录」的空态、`aria-busy` 要标出来。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ListenDayReport } from "@/types";

const mocks = vi.hoisted(() => ({ getListenDayReport: vi.fn() }));

vi.mock("@/services/ipc", () => mocks);
vi.mock("@/components/layout/keepAliveActive", () => ({ useKeepAliveActive: () => true }));
vi.mock("@/stores/sourceRegistry", () => ({
  useSourceLabelFn: () => (id: string) => id,
  useSourceColor: () => "#2563eb",
  useSourceShort: () => "QQ",
}));
vi.mock("@/lib/artist-pic", () => ({
  peekArtistPic: () => null,
  resolveArtistPic: async () => "",
}));

import { ListenTrendSection } from "@/components/mine/ListenTrendSection";

function makeReport(rowName: string): ListenDayReport {
  return {
    daily: [{ day: "2026-10-30", playCount: 3, totalPlayedMs: 600_000 }],
    activeDays: 1,
    totalPlays: 3,
    totalPlayedMs: 600_000,
    trackCount: 1,
    items: [
      {
        id: `${rowName}:1`,
        name: rowName,
        platform: "qq",
        playCount: 3,
        totalPlayedMs: 600_000,
        trackCount: 1,
        lastPlayedAt: 1_700_000_000_000,
        track: null,
      },
    ],
  };
}

function card(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[aria-busy], .rounded-2xl");
  if (el === null) throw new Error("没有找到趋势卡片");
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("听歌趋势 · 换档不闪", () => {
  it("首次加载完成后展示总量与榜单", async () => {
    mocks.getListenDayReport.mockResolvedValue(makeReport("第一次读到的歌"));
    render(<ListenTrendSection onOpenDetail={() => undefined} />);
    await screen.findByText("第一次读到的歌");
    expect(screen.getByText("近一年 · 常听歌曲")).toBeTruthy();
    expect(card(document.body).getAttribute("aria-busy")).toBeNull();
  });

  it("换时间档时旧榜单原地留着，不出现空态、卡片保持 aria-busy", async () => {
    let resolveSecond: (value: ListenDayReport) => void = () => undefined;
    mocks.getListenDayReport
      .mockResolvedValueOnce(makeReport("第一次读到的歌"))
      .mockImplementationOnce(
        () => new Promise<ListenDayReport>((resolve) => {
          resolveSecond = resolve;
        }),
      );
    const { container } = render(<ListenTrendSection onOpenDetail={() => undefined} />);
    await screen.findByText("第一次读到的歌");

    fireEvent.click(screen.getByRole("radio", { name: "近 30 天" }));

    await waitFor(() => expect(mocks.getListenDayReport).toHaveBeenCalledTimes(2));
    // 关键断言：旧内容还在，且没有掉进「这个范围内还没有播放记录」
    expect(screen.getByText("第一次读到的歌")).toBeTruthy();
    expect(screen.queryByText("这个范围内还没有播放记录。")).toBeNull();
    expect(card(container).getAttribute("aria-busy")).toBe("true");
    expect(card(container).className).toContain("opacity-70");

    resolveSecond(makeReport("换档之后读到的歌"));
    await screen.findByText("换档之后读到的歌");
    expect(screen.queryByText("第一次读到的歌")).toBeNull();
    expect(card(container).getAttribute("aria-busy")).toBeNull();
    expect(card(container).className).not.toContain("opacity-70");
  });

  it("换维度时同样保留旧内容", async () => {
    let resolveSecond: (value: ListenDayReport) => void = () => undefined;
    mocks.getListenDayReport
      .mockResolvedValueOnce(makeReport("第一次读到的歌"))
      .mockImplementationOnce(
        () => new Promise<ListenDayReport>((resolve) => {
          resolveSecond = resolve;
        }),
      );
    render(<ListenTrendSection onOpenDetail={() => undefined} />);
    await screen.findByText("第一次读到的歌");

    fireEvent.click(screen.getByRole("radio", { name: "歌手" }));

    await waitFor(() => expect(mocks.getListenDayReport).toHaveBeenCalledTimes(2));
    expect(screen.getByText("第一次读到的歌")).toBeTruthy();
    expect(screen.queryByText("这个范围内还没有播放记录。")).toBeNull();
    resolveSecond(makeReport("歌手的名字"));
    await screen.findByText("歌手的名字");
  });

  it("两组档位都是共享 Segmented 的 radiogroup 语义", async () => {
    mocks.getListenDayReport.mockResolvedValue(makeReport("第一次读到的歌"));
    render(<ListenTrendSection onOpenDetail={() => undefined} />);
    await screen.findByText("第一次读到的歌");

    expect(screen.getAllByRole("radiogroup")).toHaveLength(2);
    expect(screen.getByRole("radiogroup", { name: "统计时间范围" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "统计维度" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "近一年" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "近 7 天" }).getAttribute("aria-checked")).toBe("false");
  });

  it("读取失败时给出重试，点击后重新取数", async () => {
    mocks.getListenDayReport
      .mockRejectedValueOnce(new Error("db busy"))
      .mockResolvedValueOnce(makeReport("重试之后读到的歌"));
    render(<ListenTrendSection onOpenDetail={() => undefined} />);
    await screen.findByRole("alert");
    expect(screen.getByText(/趋势读取失败：db busy/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("重试之后读到的歌");
    expect(mocks.getListenDayReport).toHaveBeenCalledTimes(2);
  });
});
