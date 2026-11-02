// @vitest-environment jsdom
/**
 * 「通用 → 链接唤起」（§4.13 / B4）。
 *
 * 展示层只验三件事：状态回显（示例链接 + 已注册提示）、两个按钮各调哪个命令、
 * 非 Windows（supported=false）整行不渲染。真正的注册表读写与链接解析在 Rust 侧，
 * 由 `uri_scheme` 的单元测试覆盖。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUriSchemeState: vi.fn(),
  registerUriScheme: vi.fn(),
  unregisterUriScheme: vi.fn(),
}));

vi.mock("@/services/ipc", () => ({
  getUriSchemeState: mocks.getUriSchemeState,
  registerUriScheme: mocks.registerUriScheme,
  unregisterUriScheme: mocks.unregisterUriScheme,
}));

import { UriSchemeSetting } from "@/components/settings/sections/GeneralSection";

const EXAMPLE = "quietmusic://play?path=D%3A%5CMusic%5Csong.flac";

describe("链接唤起设置", () => {
  beforeEach(() => {
    mocks.getUriSchemeState.mockReset();
    mocks.registerUriScheme.mockReset();
    mocks.unregisterUriScheme.mockReset();
    mocks.getUriSchemeState.mockResolvedValue({
      supported: true,
      registered: false,
      example: EXAMPLE,
    });
  });

  it("未注册：显示示例链接，点「注册链接」调注册命令并回显已注册", async () => {
    mocks.registerUriScheme.mockResolvedValue({
      supported: true,
      registered: true,
      example: EXAMPLE,
    });
    render(<UriSchemeSetting />);
    expect(await screen.findByText(EXAMPLE)).toBeTruthy();
    expect(screen.queryByText("当前已注册，链接可直接打开")).toBeNull();

    fireEvent.click(screen.getByText("注册链接"));
    await waitFor(() => expect(mocks.registerUriScheme).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("当前已注册，链接可直接打开")).toBeTruthy();
  });

  it("已注册：点「取消注册」调取消命令", async () => {
    mocks.getUriSchemeState.mockResolvedValue({
      supported: true,
      registered: true,
      example: EXAMPLE,
    });
    mocks.unregisterUriScheme.mockResolvedValue({
      supported: true,
      registered: false,
      example: EXAMPLE,
    });
    render(<UriSchemeSetting />);
    expect(await screen.findByText("当前已注册，链接可直接打开")).toBeTruthy();

    fireEvent.click(screen.getByText("取消注册"));
    await waitFor(() => expect(mocks.unregisterUriScheme).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("当前已注册，链接可直接打开")).toBeNull());
  });

  it("非 Windows：整块不渲染", async () => {
    mocks.getUriSchemeState.mockResolvedValue({
      supported: false,
      registered: false,
      example: EXAMPLE,
    });
    const { container } = render(<UriSchemeSetting />);
    await waitFor(() => expect(container.textContent).toBe(""));
    expect(screen.queryByText("链接唤起")).toBeNull();
  });

  it("注册失败：把错误显示出来，状态保持不变", async () => {
    mocks.registerUriScheme.mockRejectedValue(new Error("注册表写入被拒绝"));
    render(<UriSchemeSetting />);
    expect(await screen.findByText(EXAMPLE)).toBeTruthy();

    fireEvent.click(screen.getByText("注册链接"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBeTruthy();
    expect(screen.queryByText("当前已注册，链接可直接打开")).toBeNull();
  });
});
