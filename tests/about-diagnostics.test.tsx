// @vitest-environment jsdom
/**
 * 「关于 → 诊断包」导出（§18 / B8）。
 *
 * 只验「点了之后按什么顺序做什么」：先打包 → 再选路径 → 选到了才写盘。
 * 用户取消时**一个字节都不落盘**是这条流程的关键约束（不能偷偷写文件）。
 * 打包内容（脱敏、日志尾部、zip 结构）由 Rust 侧 `diagnostics` 单测覆盖。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAppVersion: vi.fn(),
  getAppPaths: vi.fn(),
  buildDiagnostics: vi.fn(),
  pickSavePath: vi.fn(),
  saveBinaryFile: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/services/ipc", () => ({
  getAppVersion: mocks.getAppVersion,
  getAppPaths: mocks.getAppPaths,
  buildDiagnostics: mocks.buildDiagnostics,
  pickSavePath: mocks.pickSavePath,
  saveBinaryFile: mocks.saveBinaryFile,
}));

vi.mock("@/stores/toast", () => ({
  toast: vi.fn(),
  toastSuccess: mocks.toastSuccess,
  toastError: mocks.toastError,
}));

vi.mock("@/hooks/useUpdateCheck", () => ({ runCheck: vi.fn(async () => null) }));

import { AboutSection } from "@/components/settings/sections/AboutSection";

const BUNDLE = {
  fileName: "quietmusic-diagnostics-1700000000.zip",
  base64: "UEsDBAo=",
  files: 2,
  bytes: 2048,
};

describe("关于页诊断包", () => {
  beforeEach(() => {
    mocks.buildDiagnostics.mockReset();
    mocks.pickSavePath.mockReset();
    mocks.saveBinaryFile.mockReset();
    mocks.getAppVersion.mockResolvedValue({ versionName: "1.1.3", versionCode: 113 });
    mocks.getAppPaths.mockResolvedValue({
      portable: false,
      dataRoot: "C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\QuietMusic",
      cacheRoot: "C:\\\\cache",
      logsRoot: "C:\\\\logs",
    });
    mocks.buildDiagnostics.mockResolvedValue(BUNDLE);
    mocks.pickSavePath.mockResolvedValue("C:\\\\Users\\\\me\\\\Desktop\\\\diag.zip");
    mocks.saveBinaryFile.mockResolvedValue(undefined);
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
  });

  it("打包 → 选路径 → 写盘，并报出条目数与大小", async () => {
    render(<AboutSection />);
    expect(await screen.findByText("诊断包")).toBeTruthy();

    fireEvent.click(screen.getByText("导出诊断包"));
    await waitFor(() => expect(mocks.saveBinaryFile).toHaveBeenCalledTimes(1));

    expect(mocks.buildDiagnostics).toHaveBeenCalledTimes(1);
    // 默认名用后端给的文件名，过滤器声明 zip
    expect(mocks.pickSavePath).toHaveBeenCalledWith(BUNDLE.fileName, "保存诊断包", ["zip"]);
    expect(mocks.saveBinaryFile).toHaveBeenCalledWith(
      "C:\\\\Users\\\\me\\\\Desktop\\\\diag.zip",
      BUNDLE.base64,
    );
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(String(mocks.toastSuccess.mock.calls[0]?.[0])).toContain("2 个文件");
  });

  it("用户取消选路径：不写盘", async () => {
    mocks.pickSavePath.mockResolvedValue(null);
    render(<AboutSection />);
    expect(await screen.findByText("诊断包")).toBeTruthy();

    fireEvent.click(screen.getByText("导出诊断包"));
    await waitFor(() => expect(mocks.pickSavePath).toHaveBeenCalledTimes(1));
    expect(mocks.saveBinaryFile).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("打包失败：报错而不是静默", async () => {
    mocks.buildDiagnostics.mockRejectedValue(new Error("读日志失败"));
    render(<AboutSection />);
    expect(await screen.findByText("诊断包")).toBeTruthy();

    fireEvent.click(screen.getByText("导出诊断包"));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(String(mocks.toastError.mock.calls[0]?.[0])).toContain("导出失败");
    expect(mocks.saveBinaryFile).not.toHaveBeenCalled();
  });
});
