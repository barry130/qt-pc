// @vitest-environment jsdom
/**
 * 「关于 → 数据目录」行（§8.2 便携模式）。
 *
 * 只验两件事：普通安装显示数据根、便携模式额外给「便携」标记并换成便携文案。
 * 真正的路径解析在 Rust 侧（app_paths 单测覆盖），这里只是展示层。
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAppVersion: vi.fn(),
  getAppPaths: vi.fn(),
}));

vi.mock("@/services/ipc", () => ({
  getAppVersion: mocks.getAppVersion,
  getAppPaths: mocks.getAppPaths,
}));

// 这两个只被点击路径用到，但模块级 import 会求值，给个空实现更省事
vi.mock("@/hooks/useUpdateCheck", () => ({ runCheck: vi.fn(async () => null) }));

import { AboutSection } from "@/components/settings/sections/AboutSection";

describe("关于页数据目录", () => {
  beforeEach(() => {
    mocks.getAppVersion.mockResolvedValue({ versionName: "1.1.3", versionCode: 113 });
  });

  it("普通安装：显示数据根，不带便携标记", async () => {
    mocks.getAppPaths.mockResolvedValue({
      portable: false,
      dataRoot: "C:\\Users\\me\\AppData\\Roaming\\QuietMusic",
      cacheRoot: "C:\\Program Files\\QuietMusic\\cache",
      logsRoot: "C:\\Program Files\\QuietMusic\\logs",
    });
    render(<AboutSection />);
    expect(await screen.findByText("C:\\Users\\me\\AppData\\Roaming\\QuietMusic")).toBeTruthy();
    expect(screen.queryByText("便携")).toBeNull();
    expect(screen.getByText("曲库、音源包、缓存与日志的本地落点")).toBeTruthy();
  });

  it("便携模式：给出便携标记与可拷走说明", async () => {
    mocks.getAppPaths.mockResolvedValue({
      portable: true,
      dataRoot: "E:\\Portable\\QuietMusic",
      cacheRoot: "E:\\Portable\\QuietMusic\\cache",
      logsRoot: "E:\\Portable\\QuietMusic\\logs",
    });
    render(<AboutSection />);
    expect(await screen.findByText("E:\\Portable\\QuietMusic")).toBeTruthy();
    expect(screen.getByText("便携")).toBeTruthy();
    expect(
      screen.getByText(
        "便携模式：曲库、音源包、缓存与日志都在程序旁边，整个文件夹拷到新机器即可继续用",
      ),
    ).toBeTruthy();
  });

  it("取不到路径时只留省略号，不炸页面", async () => {
    mocks.getAppPaths.mockRejectedValue(new Error("命令不存在"));
    render(<AboutSection />);
    // 版本行照常渲染，说明整块没崩
    expect(await screen.findByText("1.1.3 (versionCode 113)")).toBeTruthy();
    expect(screen.getByText("…")).toBeTruthy();
  });
});
