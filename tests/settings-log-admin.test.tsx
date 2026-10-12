// @vitest-environment jsdom
/**
 * 设置页「通用」的日志区：qt_admin 才看得到级别 / 单文件上限 / 保留份数三行，
 * 目录行（诊断日志、缓存位置）对所有人可见。
 *
 * 这里守的是「前端显隐」这条契约（后端不设权限，与 download.dir 同一口径）：
 * 一旦 admin 判断挪错位置，非管理员会直接看到并改到全局日志级别 —— 而日志级别
 * 是排障口径，不该被普通用户随手调成 error 把线索全丢掉。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => {
  const cfg = {
    dir: "E:\\QuietMusic\\logs",
    enabled: true,
    level: "warn",
    fileMb: 10,
    backups: 5,
    defaultLevel: "warn",
    minFileMb: 1,
    maxFileMb: 512,
    minBackups: 1,
    maxBackups: 50,
  };
  return {
    cfg,
    autostartState: vi.fn(async () => false),
    setAutostart: vi.fn(async () => undefined),
    audioCacheStats: vi.fn(async () => ({ totalBytes: 0, fileCount: 0, webBytes: 0 })),
    clearAudioCache: vi.fn(async () => ({ freedBytes: 0, failedCount: 0 })),
    clearWebCache: vi.fn(async () => ({ freedBytes: 0, failedCount: 0 })),
    setAudioCacheLimit: vi.fn(async () => undefined),
    getLogConfig: vi.fn(async () => cfg),
    setLogConfig: vi.fn(async (patch: Record<string, unknown>) => ({ ...cfg, ...patch })),
    chooseLogDir: vi.fn(async () => null),
    resetLogDir: vi.fn(async () => cfg.dir),
    revealLogs: vi.fn(async () => undefined),
    getCacheDir: vi.fn(async () => "E:\\QuietMusic\\cache"),
    chooseCacheDir: vi.fn(async () => null),
    resetCacheDir: vi.fn(async () => "E:\\QuietMusic\\cache"),
    getSetting: vi.fn(async () => "512"),
    // SettingsPage 改级别后会同步前端过滤（@/lib/logger → writeLog）
    writeLog: vi.fn(async () => undefined),
  };
});

vi.mock("@/services/ipc", () => mocks);
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("@tauri-apps/api/window", () => ({ getAllWindows: vi.fn(async () => []) }));

import { SettingsPage } from "@/components/SettingsPage";
import { useAuthStore } from "@/stores/auth";

const ADMIN = { roles: ["qt_admin"], permissions: ["user:like:view"] };
const PLAIN = { roles: ["APP_USER"], permissions: ["user:like:view"] };

/** 挂载「通用」分节，并等到日志配置读完（目录行回显出来） */
async function renderGeneral(profile: Record<string, unknown>): Promise<HTMLElement> {
  useAuthStore.setState({ profile });
  const { container } = render(<SettingsPage section="general" />);
  await waitFor(() => expect(container.textContent).toContain("E:\\QuietMusic\\logs"));
  return container;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const el = [...container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  expect(el, `按钮「${text}」应存在`).toBeTruthy();
  return el as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ profile: null });
});

describe("设置页 · 通用 · 日志区", () => {
  it("qt_admin：三行日志配置齐全，且回显当前生效值", async () => {
    const c = await renderGeneral(ADMIN);
    expect(c.textContent).toContain("日志级别");
    expect(c.textContent).toContain("日志文件大小");
    expect(c.textContent).toContain("日志保留份数");
    // 区间提示来自后端快照：写死会在改常量时静默失联
    expect(c.textContent).toContain("1–512 MB");
    expect(c.textContent).toContain("1–50 个");
    // 当前级别 warn → 「警告」高亮
    expect(buttonByText(c, "警告").className).toContain("bg-primary");
  });

  it("非 qt_admin：三行日志配置一个都不渲染，目录行仍在", async () => {
    const c = await renderGeneral(PLAIN);
    expect(c.textContent).not.toContain("日志级别");
    expect(c.textContent).not.toContain("日志文件大小");
    expect(c.textContent).not.toContain("日志保留份数");
    // 换目录 / 清理缓存是所有人都能用的
    expect(c.textContent).toContain("诊断日志");
    expect(c.textContent).toContain("缓存位置");
    // 两个数字输入框（单文件上限 / 保留份数）也不该出现
    const nums = [...c.querySelectorAll('input[type="number"]')];
    expect(nums.some((i) => i.getAttribute("max") === "512")).toBe(false);
    expect(nums.some((i) => i.getAttribute("max") === "50")).toBe(false);
  });

  it("qt_admin 改级别：下发补丁并立即回显新档", async () => {
    const c = await renderGeneral(ADMIN);
    fireEvent.click(buttonByText(c, "调试"));
    await waitFor(() => expect(mocks.setLogConfig).toHaveBeenCalledWith({ level: "debug" }));
    await waitFor(() => expect(buttonByText(c, "调试").className).toContain("bg-primary"));
  });
});
