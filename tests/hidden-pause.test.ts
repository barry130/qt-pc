// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 锁住 2026-10-30 的第二轮资源优化：窗口不可见时要真的收手。
 *
 * 三端（主窗 / 桌面歌词窗 / 迷你窗）共用 `installHiddenPause`，它做两件事：
 * 1. 切 `html.qt-window-hidden` —— index.css 那条规则暂停全部 CSS 动画与过渡
 *    （唱片旋转、频谱条、淡入淡出都停在这个 class 上）；
 * 2. 通知 Rust 把 WebView2 内存档位降到 Low（隐藏时降档、恢复可见回 Normal）。
 *
 * 为什么值得一条测试：两件事都**没有可见效果**，谁哪天顺手删掉「省不了多少」
 * 的那行，后台内存与 CPU 会静悄悄涨回去，肉眼和现有测试都发现不了。
 */

const setWebviewMemoryLow = vi.fn((_low: boolean) => Promise.resolve());

vi.mock("@/services/ipc", () => ({
  setWebviewMemoryLow: (low: boolean) => setWebviewMemoryLow(low),
  writeLog: () => Promise.resolve(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));

let hidden = false;

function setHidden(next: boolean): void {
  hidden = next;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("窗口隐藏时的降级（资源优化）", () => {
  beforeEach(() => {
    setWebviewMemoryLow.mockClear();
    setHidden(false);
    document.documentElement.classList.remove("qt-window-hidden");
  });

  it("隐藏时挂上 qt-window-hidden 并降档，恢复可见后摘掉并回到 Normal", async () => {
    const { installHiddenPause } = await import("@/entries/boot");
    installHiddenPause();

    // 安装时按当前状态先同步一次（可见 → 显式 Normal，避免沿用上一次的档位）
    expect(document.documentElement.classList.contains("qt-window-hidden")).toBe(false);
    expect(setWebviewMemoryLow).toHaveBeenCalledWith(false);

    setHidden(true);
    expect(document.documentElement.classList.contains("qt-window-hidden")).toBe(true);
    expect(setWebviewMemoryLow).toHaveBeenLastCalledWith(true);

    setHidden(false);
    expect(document.documentElement.classList.contains("qt-window-hidden")).toBe(false);
    expect(setWebviewMemoryLow).toHaveBeenLastCalledWith(false);
  });

  it("同一状态重复触发只做一次 IPC（visibilitychange 会连发多次）", async () => {
    const { installHiddenPause } = await import("@/entries/boot");
    installHiddenPause();
    setWebviewMemoryLow.mockClear();

    setHidden(true);
    setHidden(true);
    setHidden(true);

    expect(setWebviewMemoryLow).toHaveBeenCalledTimes(1);
    expect(setWebviewMemoryLow).toHaveBeenCalledWith(true);
  });
});
