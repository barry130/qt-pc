// @vitest-environment jsdom
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Track } from "@/types";
import { DailyPage } from "@/components/discovery/DailyPage";

/**
 * 每日新歌（/daily）接排序后的行为（用户 m00002 / m00029）。
 *
 * 页面本身只做一件事：把「当前已加载的 songs」按两个弹窗选出的条件重排，
 * 然后**列表、播放全部、批量条都用同一份排序后的数组** —— 用户看到什么顺序，
 * 点「播放全部」就按什么顺序播，勾选与批量操作也作用在同一份集合上。
 *
 * 数据层（usePagedList / 音源 / store）与本页无关，整段替身，只喂两首歌；
 * 排序控件用真实组件（交互在 tests/track-sort-select.test.tsx 已覆盖），
 * 这里只验证它接进页面后排序结果一路传到底。
 */

const playQueue = vi.fn<(tracks: Track[], index: number) => Promise<void>>(async () => {});
const ensureRegistry = vi.fn(async () => {});

const songs: Track[] = [
  { id: "1", platform: "wyy", title: "B 歌", singer: "甲", album: "专辑乙", picUrl: "", duration: 200 },
  { id: "2", platform: "wyy", title: "A 歌", singer: "乙", album: "专辑甲", picUrl: "", duration: 180 },
];

vi.mock("@/source-scripts", () => ({
  getLatestSongs: vi.fn(async () => []),
}));

vi.mock("@/stores/musicSource", () => ({
  useMusicSourceStore: (selector: (state: { activeSourceId: string }) => unknown) =>
    selector({ activeSourceId: "wyy" }),
}));

vi.mock("@/stores/player", () => ({
  usePlayerStore: (selector: (state: { playQueue: typeof playQueue }) => unknown) =>
    selector({ playQueue }),
}));

vi.mock("@/stores/sourceRegistry", () => ({
  useLatestUsesOffset: () => true,
  useSourceLabel: () => "网易云音乐",
  useSourceRegistryStore: (
    selector: (state: { ensure: typeof ensureRegistry; generation: number }) => unknown,
  ) => selector({ ensure: ensureRegistry, generation: 1 }),
}));

vi.mock("@/hooks/usePagedList", () => ({
  usePagedList: () => ({
    items: songs,
    loading: false,
    loadingMore: false,
    error: null,
    hasMore: false,
    // 一次性加载完毕（用户 m05614）：页面靠它决定底部还要不要挂进度条
    finished: true,
    sentinelRef: { current: null },
    reload: vi.fn(),
  }),
}));

// 纯工具：本页只关心「全选 / 批量」拿到的是哪份列表，勾选收窄逻辑另有测试。
vi.mock("@/lib/lrc", () => ({ qtresCoverUrl: (url: string) => url }));
vi.mock("@/lib/track-selection", () => ({
  retainTrackSelection: (_tracks: Track[], prev: Set<string>) => prev,
  trackSelectionKey: "wyy",
}));

// 列表 / 批量条都退化成可读的标题串：断言它们的 `tracks` 就是排序后的顺序。
vi.mock("@/components/discovery/TrackList", () => ({
  TrackList: ({ tracks }: { tracks: Track[] }) => (
    <div data-testid="track-list" data-titles={tracks.map((track) => track.title).join(",")} />
  ),
}));
vi.mock("@/components/discovery/BatchBar", () => ({
  BatchBar: ({ tracks }: { tracks: Track[] }) => (
    <div data-testid="batch-bar" data-titles={tracks.map((track) => track.title).join(",")} />
  ),
}));

vi.mock("@/components/discovery/Skeletons", () => ({
  ErrorRetry: () => <div data-testid="error" />,
  TrackRowsSkeleton: () => <div data-testid="skeleton" />,
  // 取全量期间底部只挂这条进度提示，收尾后返回 null —— 本文件不关心它
  ListLoadProgress: () => null,
}));

vi.mock("@/components/common/IconButton", () => ({
  IconButton: ({
    label,
    onClick,
    children,
  }: {
    label: string;
    onClick?: () => void;
    children?: ReactNode;
  }) => (
    <button type="button" aria-label={label} onClick={onClick}>
      {children}
    </button>
  ),
}));

const listTitles = (): string | null =>
  screen.getByTestId("track-list").getAttribute("data-titles");
const batchTitles = (): string | null =>
  screen.getByTestId("batch-bar").getAttribute("data-titles");

function pickField(label: string): void {
  fireEvent.click(screen.getByRole("button", { name: "排序字段" }));
  fireEvent.click(screen.getByRole("option", { name: label }));
}

describe("每日新歌排序", () => {
  beforeEach(() => {
    playQueue.mockClear();
  });

  it("默认不排序：列表 / 批量条保持音源原始顺序，播放全部也按原始顺序", () => {
    render(<DailyPage />);

    expect(listTitles()).toBe("B 歌,A 歌");
    expect(batchTitles()).toBe("B 歌,A 歌");

    fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
    expect(playQueue).toHaveBeenCalledWith(songs, 0);
  });

  it("按歌曲名正序：列表、批量条、播放全部都换成排序后的顺序", () => {
    render(<DailyPage />);

    pickField("按歌曲名");

    expect(listTitles()).toBe("A 歌,B 歌");
    expect(batchTitles()).toBe("A 歌,B 歌");

    fireEvent.click(screen.getByRole("button", { name: "播放全部" }));
    const played = playQueue.mock.calls[0]?.[0] as Track[];
    expect(played.map((track) => track.title)).toEqual(["A 歌", "B 歌"]);
  });

  it("按歌曲名倒序：方向弹窗换成倒序后整页跟着翻转", () => {
    render(<DailyPage />);

    pickField("按歌曲名");
    fireEvent.click(screen.getByRole("button", { name: "排序方向" }));
    fireEvent.click(screen.getByRole("option", { name: "倒序" }));

    expect(listTitles()).toBe("B 歌,A 歌");
    expect(batchTitles()).toBe("B 歌,A 歌");
    // 界面上的勾选态也要跟着走
    expect(screen.getByRole("button", { name: "排序方向" }).textContent).toContain("倒序");
  });
});
