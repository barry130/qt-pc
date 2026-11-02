// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Track } from "@/types";

/**
 * 文件夹监听（A3 / DESIGN R62）的前端部分：
 * 开关读写的落地，以及 `library-changed` 事件到达后列表自动重拉。
 */
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  getLocalTracks: vi.fn(async (): Promise<Track[]> => []),
  setLibraryWatch: vi.fn(async (_enabled: boolean) => undefined),
  getLibraryWatch: vi.fn(async () => true),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (name: string, handler: (event: { payload: unknown }) => void) => {
      mocks.handlers.set(name, handler);
      return vi.fn();
    },
  ),
}));

vi.mock("@/services/ipc", () => ({
  LOCAL_PLATFORM: "local",
  getLocalTracks: mocks.getLocalTracks,
  getScanDirs: vi.fn(async () => []),
  getMissingLocalTracks: vi.fn(async () => []),
  getLocalTrackFiles: vi.fn(async () => []),
  getScanMinDuration: vi.fn(async () => 60),
  getScanMinSize: vi.fn(async () => 1048576),
  getLibraryWatch: mocks.getLibraryWatch,
  setLibraryWatch: mocks.setLibraryWatch,
  deleteLocalTracks: vi.fn(async () => undefined),
  LIBRARY_SCAN_PROGRESS_EVENT: "library-scan-progress",
  LIBRARY_CHANGED_EVENT: "library-changed",
}));

import { LibraryPage } from "@/components/library/LibraryPage";

/** 展开扫描设置面板——监听开关就在面板里 */
function openScanSettings(): void {
  const toggle = screen
    .getAllByRole("button")
    .find((b) => b.textContent?.includes("扫描设置"));
  expect(toggle).toBeTruthy();
  fireEvent.click(toggle!);
}

beforeEach(() => {
  mocks.handlers.clear();
  mocks.getLocalTracks.mockClear();
  mocks.setLibraryWatch.mockClear();
  mocks.getLibraryWatch.mockReset();
  mocks.getLibraryWatch.mockResolvedValue(true);
});

describe("文件夹监听", () => {
  it("开关默认跟随后端状态，点击后落库", async () => {
    render(<LibraryPage />);
    await waitFor(() => expect(mocks.getLibraryWatch).toHaveBeenCalled());
    openScanSettings();

    const box = (await screen.findByLabelText(
      /扫描目录变动时自动更新曲库/,
    )) as HTMLInputElement;
    expect(box.checked).toBe(true);

    fireEvent.click(box);
    expect(mocks.setLibraryWatch).toHaveBeenCalledWith(false);
    await waitFor(() => expect(box.checked).toBe(false));
  });

  it("后端状态是关闭时，开关初始为关闭", async () => {
    mocks.getLibraryWatch.mockResolvedValue(false);
    render(<LibraryPage />);
    openScanSettings();
    const box = (await screen.findByLabelText(
      /扫描目录变动时自动更新曲库/,
    )) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(false));
  });

  it("收到 library-changed 且确有增删时重拉列表", async () => {
    render(<LibraryPage />);
    await waitFor(() => expect(mocks.handlers.has("library-changed")).toBe(true));
    await waitFor(() => expect(mocks.getLocalTracks).toHaveBeenCalledTimes(1));

    act(() => {
      mocks.handlers.get("library-changed")!({ payload: { added: 2, removed: 1 } });
    });
    await waitFor(() => expect(mocks.getLocalTracks).toHaveBeenCalledTimes(2));

    // 空批次（附件变化、被过滤的文件）不值得整页重拉
    act(() => {
      mocks.handlers.get("library-changed")!({ payload: { added: 0, removed: 0 } });
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.getLocalTracks).toHaveBeenCalledTimes(2);
  });

  it("开关写库失败时回滚并报错", async () => {
    mocks.setLibraryWatch.mockRejectedValue(new Error("库被锁住了"));
    render(<LibraryPage />);
    openScanSettings();
    const box = (await screen.findByLabelText(
      /扫描目录变动时自动更新曲库/,
    )) as HTMLInputElement;
    fireEvent.click(box);
    await screen.findByText(/库被锁住了/);
    expect(box.checked).toBe(true);
  });
});
