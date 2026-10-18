// @vitest-environment jsdom
/**
 * 首页「为你整理」的出场门槛。
 *
 * 五类合辑各有各的门槛（新用户没在深夜听过歌、旧歌不满 30 天、收藏还没归进现存
 * 歌单……），早先要求五类全齐才展示，结果这一区长期不出现。这里锁定新规则：
 * 凑够两类就展示，只出一类不渲染，取数失败也不占推荐位。
 */
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listLocalMixes: vi.fn() }));

vi.mock("@/services/ipc", () => ({ listLocalMixes: mocks.listLocalMixes }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

import { LocalMixSection } from "@/components/mine/LocalMixSection";

const ALL_KEYS = ["recent", "most_played", "favorite_picks", "late_night", "nostalgic"];

function mix(key: string): {
  key: string;
  title: string;
  subtitle: string;
  coverUrls: string[];
} {
  return { key, title: key, subtitle: key + " 的副标题", coverUrls: [] };
}

function sectionOf(container: HTMLElement): Element | null {
  return container.querySelector('section[aria-label="为你整理"]');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("为你整理 · 出场门槛", () => {
  it("五类全齐时展示全部卡片", async () => {
    mocks.listLocalMixes.mockResolvedValue(ALL_KEYS.map(mix));
    const { container } = render(<LocalMixSection />);
    await waitFor(() => expect(sectionOf(container)).not.toBeNull());
    expect(container.textContent).toContain("favorite_picks");
    expect(container.textContent).toContain("nostalgic");
  });

  it("只凑够两类也展示（不再要求五类全齐）", async () => {
    mocks.listLocalMixes.mockResolvedValue([mix("recent"), mix("late_night")]);
    const { container } = render(<LocalMixSection />);
    await waitFor(() => expect(sectionOf(container)).not.toBeNull());
    expect(container.textContent).toContain("recent");
    expect(container.textContent).toContain("late_night");
  });

  it("只有一类时整区不渲染", async () => {
    mocks.listLocalMixes.mockResolvedValue([mix("recent")]);
    const { container } = render(<LocalMixSection />);
    await act(async () => { await mocks.listLocalMixes.mock.results[0]?.value; });
    expect(sectionOf(container)).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  it("取数失败时整区不渲染，也不抛错", async () => {
    mocks.listLocalMixes.mockRejectedValue(new Error("数据库不可用"));
    const { container } = render(<LocalMixSection />);
    await act(async () => { await Promise.resolve(); });
    expect(sectionOf(container)).toBeNull();
  });
});
