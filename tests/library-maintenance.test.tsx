// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DuplicateProgress, DuplicateReport, OrganizePreview } from "@/services/ipc";
const mocks = vi.hoisted(() => ({
  listen: vi.fn(), findLibraryDuplicates: vi.fn(), cancelLibraryDuplicateScan: vi.fn(),
  pickFolder: vi.fn(), previewLibraryOrganization: vi.fn(), revealLocalTrack: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@/services/ipc", () => ({ ...mocks, LIBRARY_DUPLICATE_PROGRESS_EVENT: "library-duplicate-progress" }));
import LibraryMaintenance from "@/components/library/LibraryMaintenance";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const empty: DuplicateReport = { scannedFiles: 2, hashedFiles: 0, groups: [], issues: [], cancelled: false };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.listen.mockResolvedValue(vi.fn());
  mocks.findLibraryDuplicates.mockResolvedValue(empty);
  mocks.cancelLibraryDuplicateScan.mockResolvedValue(true);
  mocks.revealLocalTrack.mockResolvedValue(undefined);
});
describe("本地曲库维护", () => {
  it("先订阅后检测，只读展示重复分组并可定位文件", async () => {
    const off = vi.fn();
    mocks.listen.mockResolvedValue(off);
    mocks.findLibraryDuplicates.mockResolvedValue({ ...empty, hashedFiles: 2, groups: [{ sha256: "hash", fileSize: 2048, files: [{ path: "C:\\a.flac", trackCount: 2 }, { path: "D:\\b.flac", trackCount: 1 }] }] });
    render(<LibraryMaintenance />);
    fireEvent.click(screen.getByRole("button", { name: "开始检测" }));
    await screen.findByText(/发现 1 组重复文件/);
    expect(mocks.listen.mock.invocationCallOrder[0]).toBeLessThan(mocks.findLibraryDuplicates.mock.invocationCallOrder[0]);
    expect(screen.getByText(/C:\\a.flac（2 首共用）/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "在文件夹中显示" })[0]);
    expect(mocks.revealLocalTrack).toHaveBeenCalledWith("C:\\a.flac");
    expect(off).toHaveBeenCalledTimes(1);
  });
  it("取消早于订阅完成时，不启动后台扫描并释放迟到的监听器", async () => {
    const subscription = deferred<() => void>(); const off = vi.fn();
    mocks.listen.mockReturnValue(subscription.promise);
    render(<LibraryMaintenance />);
    fireEvent.click(screen.getByRole("button", { name: "开始检测" }));
    fireEvent.click(screen.getByRole("button", { name: "取消检测" }));
    await act(async () => subscription.resolve(off));
    expect(mocks.findLibraryDuplicates).not.toHaveBeenCalled();
    expect(off).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/检测已取消/)).toBeTruthy();
  });
  it("按 scanId 过滤进度，取消任务并展示部分结果", async () => {
    const result = deferred<DuplicateReport>();
    let event!: (event: { payload: DuplicateProgress }) => void;
    mocks.listen.mockImplementation(async (_name, handler) => { event = handler; return vi.fn(); });
    mocks.findLibraryDuplicates.mockReturnValue(result.promise);
    render(<LibraryMaintenance />);
    fireEvent.click(screen.getByRole("button", { name: "开始检测" }));
    await waitFor(() => expect(mocks.findLibraryDuplicates).toHaveBeenCalled());
    const id = mocks.findLibraryDuplicates.mock.calls[0][0] as string;
    act(() => event({ payload: { scanId: "other", checked: 99, total: 99, current: "wrong" } }));
    expect(screen.queryByText(/99 \/ 99/)).toBeNull();
    act(() => event({ payload: { scanId: id, checked: 1, total: 2, current: "a" } }));
    expect(screen.getByText(/1 \/ 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消检测" }));
    expect(mocks.cancelLibraryDuplicateScan).toHaveBeenCalledWith(id);
    await act(async () => result.resolve({ ...empty, cancelled: true }));
    expect(screen.getByText(/检测已取消/)).toBeTruthy();
  });
  it("面板关闭时取消检测，异步监听返回后不留下订阅", async () => {
    const subscription = deferred<() => void>(); const off = vi.fn();
    mocks.listen.mockReturnValue(subscription.promise);
    const { unmount } = render(<LibraryMaintenance />);
    fireEvent.click(screen.getByRole("button", { name: "开始检测" }));
    unmount();
    expect(mocks.cancelLibraryDuplicateScan).toHaveBeenCalled();
    await act(async () => subscription.resolve(off));
    expect(off).toHaveBeenCalledTimes(1);
    expect(mocks.findLibraryDuplicates).not.toHaveBeenCalled();
  });
  it("卸载先于后台注册时，在迟到进度中重试取消并最终释放订阅", async () => {
    const result = deferred<DuplicateReport>(); const off = vi.fn();
    let event!: (event: { payload: DuplicateProgress }) => void;
    mocks.listen.mockImplementation(async (_name, handler) => { event = handler; return off; });
    mocks.findLibraryDuplicates.mockReturnValue(result.promise);
    mocks.cancelLibraryDuplicateScan.mockResolvedValueOnce(false).mockResolvedValue(true);
    const { unmount } = render(<LibraryMaintenance />);
    fireEvent.click(screen.getByRole("button", { name: "开始检测" }));
    await waitFor(() => expect(mocks.findLibraryDuplicates).toHaveBeenCalled());
    const id = mocks.findLibraryDuplicates.mock.calls[0][0] as string;
    unmount();
    expect(mocks.cancelLibraryDuplicateScan).toHaveBeenCalledTimes(1);
    act(() => event({ payload: { scanId: id, checked: 0, total: 0, current: "" } }));
    expect(mocks.cancelLibraryDuplicateScan).toHaveBeenCalledTimes(2);
    expect(mocks.cancelLibraryDuplicateScan).toHaveBeenLastCalledWith(id);
    await act(async () => result.resolve({ ...empty, cancelled: true }));
    expect(off).toHaveBeenCalledTimes(1);
  });
  it("选择目录后展示整理目标和阻塞原因，取消目录选择不调用预览", async () => {
    const preview: OrganizePreview = { ready: 0, unchanged: 0, blocked: 1, entries: [{ source: "C:\\a.flac", target: "D:\\歌手\\专辑\\a.flac", trackCount: 2, status: "blocked", message: "CUE 整轨保留原位置" }] };
    mocks.pickFolder.mockResolvedValueOnce(null).mockResolvedValueOnce("D:\\");
    mocks.previewLibraryOrganization.mockResolvedValue(preview);
    render(<LibraryMaintenance />);
    fireEvent.click(screen.getByRole("tab", { name: "整理预览" }));
    fireEvent.click(screen.getByRole("button", { name: "选择目标文件夹并预览" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "选择目标文件夹并预览" }).hasAttribute("disabled")).toBe(false));
    expect(mocks.previewLibraryOrganization).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "选择目标文件夹并预览" }));
    await screen.findByText("CUE 整轨保留原位置");
    expect(mocks.previewLibraryOrganization).toHaveBeenCalledWith("D:\\");
    expect(screen.getByText(/建议位置：D:/)).toBeTruthy();
    expect(screen.getByText(/预览不会移动文件或修改曲库/)).toBeTruthy();
  });
  it("后台失败后显示错误并允许重试", async () => {
    mocks.findLibraryDuplicates.mockRejectedValueOnce(new Error("读取目录失败"));
    render(<LibraryMaintenance />);
    fireEvent.click(screen.getByRole("button", { name: "开始检测" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "读取目录失败");
    fireEvent.click(screen.getByRole("button", { name: "开始检测" }));
    await screen.findByText("未发现内容完全相同的重复文件。");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
