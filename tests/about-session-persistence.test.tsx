// @vitest-environment jsdom
/**
 * 「关于 → 登录状态未持久化」（S03 / task-9）。
 *
 * 系统安全仓库不可用时，后端只能把会话放在内存里：重启应用就要重新登录。
 * 「关于」页必须在会话处于 memory-only 时明确提示，secure 或未登录时不出现，
 * 否则正常用户会以为登录会莫名其妙失效。
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@/types";

const mocks = vi.hoisted(() => ({
  getAppVersion: vi.fn(),
  getAppPaths: vi.fn(),
  session: null as AuthSession | null,
  reopen: vi.fn(async () => true),
  setUpdate: vi.fn(),
}));

vi.mock("@/services/ipc", () => ({
  getAppVersion: mocks.getAppVersion,
  getAppPaths: mocks.getAppPaths,
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: (selector: (state: { session: AuthSession | null }) => unknown) =>
    selector({ session: mocks.session }),
}));

vi.mock("@/stores/disclaimer", () => ({
  useDisclaimerStore: (selector: (state: { reopen: typeof mocks.reopen }) => unknown) =>
    selector({ reopen: mocks.reopen }),
}));

vi.mock("@/stores/update", () => ({
  useUpdateStore: (selector: (state: { setUpdate: typeof mocks.setUpdate }) => unknown) =>
    selector({ setUpdate: mocks.setUpdate }),
}));

import { AboutSection } from "@/components/settings/sections/AboutSection";

describe("关于页登录持久化提示", () => {
  beforeEach(() => {
    mocks.getAppVersion.mockResolvedValue({ versionName: "1.1.3", versionCode: 113 });
    mocks.getAppPaths.mockResolvedValue({
      portable: false,
      dataRoot: "/data",
      cacheRoot: "/cache",
      logsRoot: "/logs",
    });
  });

  it("会话是 memory-only 时提示重启后需要重新登录", async () => {
    mocks.session = { persistence: "memory-only", expiresAt: Date.now() + 3_600_000 };
    render(<AboutSection />);

    expect(await screen.findByText("登录状态未持久化")).toBeTruthy();
    expect(screen.getByText("仅本次运行")).toBeTruthy();
    expect(
      screen.getByText(
        "系统安全存储不可用，登录只在本次进程内有效，重启应用后需要重新登录。",
      ),
    ).toBeTruthy();
  });

  it("会话已安全持久化时不显示这条提示", async () => {
    mocks.session = { persistence: "secure", expiresAt: Date.now() + 3_600_000 };
    render(<AboutSection />);

    expect(await screen.findByText("当前版本")).toBeTruthy();
    expect(screen.queryByText("登录状态未持久化")).toBeNull();
    expect(screen.queryByText("仅本次运行")).toBeNull();
  });

  it("未登录时也不显示这条提示", async () => {
    mocks.session = null;
    render(<AboutSection />);

    expect(await screen.findByText("当前版本")).toBeTruthy();
    expect(screen.queryByText("登录状态未持久化")).toBeNull();
  });
});
