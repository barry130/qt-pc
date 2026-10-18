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
     clearPlayUrlCache: vi.fn(async () => ({ clearedCount: 0 })),
    clearListenStats: vi.fn(async () => 3),
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
    getFileAssociationState: vi.fn(async () => ({
      supported: true, registered: false, extensions: ["mp3", "flac", "wav", "ogg", "m4a"], defaultExtensions: [],
    })),
    pickBackupFile: vi.fn(async () => "E:\\backup.db"),
    importBackup: vi.fn(async () => ({ mode: "merge", rows: 2, tracks: 1, playlists: 1, history: 0, safetyCopy: null })),
    listDislikes: vi.fn(async () => []),
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
import { useFavoritesStore } from "@/stores/favorites";
import { useDislikesStore } from "@/stores/dislikes";

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
  useFavoritesStore.setState({ version: 0 });
  useDislikesStore.setState({ version: 0, songRuleIds: { "qq:a": 9 }, singerRuleIds: { Singer: [10] } });
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

  it("恢复备份成功后刷新标记版本并清除旧规则 id，即使规则重载失败", async () => {
    mocks.listDislikes.mockRejectedValueOnce(new Error("db busy"));
    const c = await renderGeneral(PLAIN);
    fireEvent.click(buttonByText(c, "从备份导入"));
    await waitFor(() => expect(c.textContent).toContain("合并导入"));
    fireEvent.click(buttonByText(c, "合并导入"));
    await waitFor(() => expect(mocks.importBackup).toHaveBeenCalledWith("E:\\backup.db", "merge"));
    await waitFor(() => expect(useFavoritesStore.getState().version).toBe(1));
    expect(useDislikesStore.getState().version).toBe(2);
    expect(useDislikesStore.getState().songRuleIds).toEqual({});
    expect(useDislikesStore.getState().singerRuleIds).toEqual({});
    expect(mocks.listDislikes).toHaveBeenCalledTimes(1);
  });

  it("恢复失败不清除当前标记与规则引用", async () => {
    mocks.importBackup.mockRejectedValueOnce(new Error("invalid backup"));
    const c = await renderGeneral(PLAIN);
    fireEvent.click(buttonByText(c, "从备份导入"));
    await waitFor(() => expect(c.textContent).toContain("合并导入"));
    fireEvent.click(buttonByText(c, "合并导入"));
    await waitFor(() => expect(c.textContent).toContain("invalid backup"));
    expect(useFavoritesStore.getState().version).toBe(0);
    expect(useDislikesStore.getState().version).toBe(0);
    expect(useDislikesStore.getState().songRuleIds).toEqual({ "qq:a": 9 });
    expect(mocks.listDislikes).not.toHaveBeenCalled();
  });

  it("默认勾选可再生缓存，并保留下载、登录和设置不在清理选项中", async () => {
    const c = await renderGeneral(PLAIN);
    expect(c.textContent).toContain("播放地址");
    expect(c.textContent).toContain("换源候选");
    expect(c.textContent).toContain("歌词候选");
    expect(c.textContent).toContain("榜单详情");
    expect(c.textContent).toContain("不删除下载、登录、设置");

    const checks = [...c.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    expect(checks.length).toBeGreaterThanOrEqual(7);
    expect(checks.every((input) => input.checked)).toBe(true);

    fireEvent.click(buttonByText(c, "清理"));
    await waitFor(() => expect(mocks.clearAudioCache).toHaveBeenCalledTimes(1));
    expect(mocks.clearWebCache).toHaveBeenCalledTimes(1);
    expect(mocks.clearPlayUrlCache).toHaveBeenCalledTimes(1);
  });

  it("qt_admin 改级别：下发补丁并立即回显新档", async () => {
    const c = await renderGeneral(ADMIN);
    fireEvent.click(buttonByText(c, "调试"));
    await waitFor(() => expect(mocks.setLogConfig).toHaveBeenCalledWith({ level: "debug" }));
    await waitFor(() => expect(buttonByText(c, "调试").className).toContain("bg-primary"));
  });

  it("清除听歌统计：第一击只武装，第二击才真删", async () => {
    const c = await renderGeneral(PLAIN);
    // 统计不可再生（累计时长、趋势删了就没了），一击不该生效
    fireEvent.click(buttonByText(c, "清除"));
    expect(mocks.clearListenStats).not.toHaveBeenCalled();
    expect(c.textContent).toContain("再点一次确认清除");

    fireEvent.click(buttonByText(c, "再点一次确认清除"));
    await waitFor(() => expect(mocks.clearListenStats).toHaveBeenCalledTimes(1));
  });

  it("清理缓存不会连带清掉听歌统计", async () => {
    const c = await renderGeneral(PLAIN);
    fireEvent.click(buttonByText(c, "清理"));
    await waitFor(() => expect(mocks.clearAudioCache).toHaveBeenCalledTimes(1));
    // 「清理缓存」默认全选、一键执行，听歌统计必须留在它外面
    expect(mocks.clearListenStats).not.toHaveBeenCalled();
  });
});
