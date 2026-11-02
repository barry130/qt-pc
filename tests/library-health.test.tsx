// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HealthKind, HealthTrack, LibraryHealthReport } from "@/services/ipc";
const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  findLibraryDuplicates: vi.fn(),
  cancelLibraryDuplicateScan: vi.fn(),
  pickFolder: vi.fn(),
  previewLibraryOrganization: vi.fn(),
  revealLocalTrack: vi.fn(),
  applyLibraryOrganization: vi.fn(),
  undoLibraryOrganization: vi.fn(),
  libraryOrganizeUndoState: vi.fn(),
  scanLibraryHealth: vi.fn(),
  ignoreLibraryHealth: vi.fn(),
  restoreLibraryHealthIgnored: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@/services/ipc", () => ({ ...mocks, LIBRARY_DUPLICATE_PROGRESS_EVENT: "library-duplicate-progress" }));
import LibraryMaintenance from "@/components/library/LibraryMaintenance";

function track(id: string, title: string, detail: string): HealthTrack {
  return {
    id,
    title,
    singer: "歌手",
    album: "专辑",
    path: `D:/m/${id}.flac`,
    durationMs: 1_000,
    detail,
  };
}

function kind(name: HealthKind["kind"], items: HealthTrack[], truncated = false): HealthKind {
  return { kind: name, total: truncated ? 501 : items.length, truncated, items };
}

function report(overrides: Partial<LibraryHealthReport> = {}): LibraryHealthReport {
  return {
    missing: kind("missing", [track("a", "丢了", "文件已不在原路径")]),
    silent: kind("silent", [track("b", "老歌", "加入 42 天从未播放")]),
    long: kind("long", [track("c", "整轨", "时长 42:00，可能是整轨未分割")]),
    ignored: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listen.mockResolvedValue(vi.fn());
  mocks.libraryOrganizeUndoState.mockResolvedValue(null);
  mocks.revealLocalTrack.mockResolvedValue(undefined);
  mocks.scanLibraryHealth.mockResolvedValue(report());
  mocks.ignoreLibraryHealth.mockResolvedValue(1);
  mocks.restoreLibraryHealthIgnored.mockResolvedValue(2);
});

describe("库体检（B11）", () => {
  it("开始体检后按三类列出条数与原因", async () => {
    render(<LibraryMaintenance />);
    fireEvent.click(screen.getByRole("tab", { name: "库体检" }));
    fireEvent.click(screen.getByRole("button", { name: "开始体检" }));
    await screen.findByText(/文件丢失 · 共 1 项/);
    expect(screen.getByText(/零播放 · 共 1 项/)).toBeTruthy();
    expect(screen.getByText(/超长未分轨 · 共 1 项/)).toBeTruthy();
    expect(screen.getByText(/文件已不在原路径/)).toBeTruthy();
    expect(screen.getByText(/加入 42 天从未播放/)).toBeTruthy();
    expect(mocks.scanLibraryHealth).toHaveBeenCalledTimes(1);
  });

  it("单条忽略只上报该曲目并重新体检", async () => {
    render(<LibraryMaintenance />);
    fireEvent.click(screen.getByRole("tab", { name: "库体检" }));
    fireEvent.click(screen.getByRole("button", { name: "开始体检" }));
    await screen.findByText(/文件丢失 · 共 1 项/);
    fireEvent.click(screen.getAllByRole("button", { name: "忽略" })[0]);
    await waitFor(() => expect(mocks.ignoreLibraryHealth).toHaveBeenCalledWith("missing", ["a"]));
    await waitFor(() => expect(mocks.scanLibraryHealth).toHaveBeenCalledTimes(2));
  });

  it("组级忽略把整组 id 一起交出去", async () => {
    mocks.scanLibraryHealth.mockResolvedValue(report({
      silent: kind("silent", [track("b1", "甲", "加入 40 天从未播放"), track("b2", "乙", "加入 90 天从未播放")]),
    }));
    render(<LibraryMaintenance />);
    fireEvent.click(screen.getByRole("tab", { name: "库体检" }));
    fireEvent.click(screen.getByRole("button", { name: "开始体检" }));
    await screen.findByText(/零播放 · 共 2 项/);
    fireEvent.click(screen.getAllByRole("button", { name: "全部忽略" })[1]);
    await waitFor(() => expect(mocks.ignoreLibraryHealth).toHaveBeenCalledWith("silent", ["b1", "b2"]));
  });

  it("有忽略记录时可以一次恢复", async () => {
    mocks.scanLibraryHealth.mockResolvedValue(report({ ignored: 3 }));
    render(<LibraryMaintenance />);
    fireEvent.click(screen.getByRole("tab", { name: "库体检" }));
    fireEvent.click(screen.getByRole("button", { name: "开始体检" }));
    fireEvent.click(await screen.findByRole("button", { name: "恢复忽略（3）" }));
    await waitFor(() => expect(mocks.restoreLibraryHealthIgnored).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.scanLibraryHealth).toHaveBeenCalledTimes(2));
  });

  it("三类都空时给干净结论，且不渲染空分组", async () => {
    mocks.scanLibraryHealth.mockResolvedValue(report({
      missing: kind("missing", []),
      silent: kind("silent", []),
      long: kind("long", []),
    }));
    render(<LibraryMaintenance />);
    fireEvent.click(screen.getByRole("tab", { name: "库体检" }));
    fireEvent.click(screen.getByRole("button", { name: "开始体检" }));
    await screen.findByText("没发现问题，曲库挺干净。");
    expect(screen.queryByRole("button", { name: "全部忽略" })).toBeNull();
  });

  it("超过上限时明确说是截断结果", async () => {
    mocks.scanLibraryHealth.mockResolvedValue(report({
      long: kind("long", [track("c", "整轨", "时长 42:00，可能是整轨未分割")], true),
    }));
    render(<LibraryMaintenance />);
    fireEvent.click(screen.getByRole("tab", { name: "库体检" }));
    fireEvent.click(screen.getByRole("button", { name: "开始体检" }));
    await screen.findByText(/超长未分轨 · 共 501 项（只列出前 500 项）/);
  });
});
