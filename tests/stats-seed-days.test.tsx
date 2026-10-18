// @vitest-environment jsdom
/**
 * 听歌报告页的「存量补齐」时序。
 *
 * 升级前的播放只有 `play_stats` 的累计值，没有按天明细；报告页要先把存量归到今天
 * （`seed_listen_days`），再读概览与趋势。若两者并发，日榜与「活跃天数」会先按空表
 * 渲染一帧（活跃天数 0 天、趋势全空），看着像数据丢了。
 *
 * 这里用空概览（totalPlays = 0）渲染——走到空状态就不会牵连趋势卡、歌手头像等
 * 子组件，断言能只盯住这几个命令的顺序。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    seedListenDays: vi.fn(async () => {
      calls.push("seed");
      return 1;
    }),
    getPlayOverview: vi.fn(async () => {
      calls.push("overview");
      return {
        totalPlays: 0,
        totalMs: 0,
        trackCount: 0,
        finishedPlays: 0,
        lastPlayedAt: null,
        activeDays: 0,
      };
    }),
    getTopTracks: vi.fn(async () => {
      calls.push("topTracks");
      return [];
    }),
    getListenReport: vi.fn(async () => {
      calls.push("report");
      return { items: [], total: 0 };
    }),
  };
});

vi.mock("@/services/ipc", () => mocks);
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

import { StatsPage } from "@/components/mine/StatsPage";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls.length = 0;
});

describe("听歌报告页 · 存量补齐", () => {
  it("先补齐按天明细再读报告，顺序不能颠倒", async () => {
    render(<StatsPage />);
    await waitFor(() => expect(mocks.getPlayOverview).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.getTopTracks).toHaveBeenCalledTimes(1));
    expect(mocks.calls).toEqual(["seed", "overview", "topTracks", "report", "report"]);
  });

  it("补齐失败照样把报告读出来（累计值仍在库里，只是趋势可能为空）", async () => {
    mocks.seedListenDays.mockRejectedValueOnce(new Error("db busy"));
    render(<StatsPage />);
    await waitFor(() => expect(mocks.getPlayOverview).toHaveBeenCalledTimes(1));
    expect(mocks.calls).toContain("overview");
  });
});
