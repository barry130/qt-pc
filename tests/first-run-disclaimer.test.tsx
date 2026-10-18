// @vitest-environment jsdom
/**
 * 首次启动的免责声明 / 开源通知（DESIGN §5.5）。
 *
 * 守的是三条契约：
 * 1. 只在**安装后第一次启动**弹（settings.disclaimer.acceptedAt 有值就不再出现）；
 * 2. 「我知道了」要读满 3 秒才可点 —— 声明最怕的就是被顺手点掉；
 * 3. 官网地址来自私有配置，未配置时不给一个打不开的死链接。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(async (_key: string): Promise<string | null> => null),
  setSetting: vi.fn(async (_key: string, _value: string): Promise<void> => undefined),
  openExternalUrl: vi.fn(async (_url: string): Promise<void> => undefined),
  siteUrl: "https://example.com",
}));

vi.mock("@/services/ipc", () => mocks);
vi.mock("@/hooks/useOfficialSiteUrl", () => ({ useOfficialSiteUrl: () => mocks.siteUrl }));

import { FirstRunDisclaimer } from "@/components/common/FirstRunDisclaimer";
import { useDisclaimerStore } from "@/stores/disclaimer";

const KEY = "disclaimer.acceptedAt";

/** 每个用例从「还没读库」的初始态开始（inited 置回 false 让 init 真的再跑一次） */
function resetStore(): void {
  useDisclaimerStore.setState({ pending: null, reopened: false, inited: false });
  mocks.siteUrl = "https://example.com";
}

/** 确认按钮：倒计时里叫「请阅读（3s）」，读完叫「我知道了」 */
function confirmButton(container: HTMLElement): HTMLButtonElement {
  const btn = [...container.querySelectorAll("button")].find((b) =>
    /^(请阅读|我知道了)/.test((b.textContent ?? "").trim()),
  );
  expect(btn, "确认按钮应存在").toBeTruthy();
  return btn as HTMLButtonElement;
}

async function settle(): Promise<void> {
  await act(async () => {
    await useDisclaimerStore.getState().init();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("首次启动免责声明 / 开源通知", () => {
  it("没接受过就弹一次，按钮读满 3 秒才可点，确认后写入接受时刻", async () => {
    mocks.getSetting.mockResolvedValue(null);
    const { container } = render(<FirstRunDisclaimer />);
    await settle();

    expect(mocks.getSetting).toHaveBeenCalledWith(KEY);
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    // 三段正文都在
    expect(container.textContent).toContain("不得用于商业用途");
    expect(container.textContent).toContain("那不是本项目");

    const btn = confirmButton(container);
    expect(btn.disabled).toBe(true);
    expect((btn.textContent ?? "").trim()).toBe("请阅读（3s）");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect((confirmButton(container).textContent ?? "").trim()).toBe("我知道了");
    expect(confirmButton(container).disabled).toBe(false);

    act(() => {
      fireEvent.click(confirmButton(container));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.setSetting).toHaveBeenCalledWith(KEY, expect.any(String));
    // 写进去的应当是 ISO 时刻，不是随便一个 "1"
    const written = mocks.setSetting.mock.calls[0][1] as string;
    expect(Number.isNaN(Date.parse(written))).toBe(false);
  });

  it("接受过之后不再出现", async () => {
    mocks.getSetting.mockResolvedValue("2026-10-18T03:00:00.000Z");
    const { container } = render(<FirstRunDisclaimer />);
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("设置页「重新查看」能再打开一次，且要重新读满 3 秒、不改已记录的接受时刻", async () => {
    mocks.getSetting.mockResolvedValue("2026-10-18T03:00:00.000Z");
    const { container } = render(<FirstRunDisclaimer />);
    await settle();

    act(() => {
      useDisclaimerStore.getState().reopen();
    });
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(confirmButton(container).disabled).toBe(true);
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("官网地址未配置时只留纯文字，不给一个打不开的链接", async () => {
    mocks.getSetting.mockResolvedValue(null);
    mocks.siteUrl = "";
    const { container } = render(<FirstRunDisclaimer />);
    await settle();

    expect(container.textContent).toContain("见官网");
    // 没有可点的官网按钮
    expect(
      [...container.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("example")),
    ).toBe(false);
  });

  it("官网地址可点，走系统浏览器打开", async () => {
    mocks.getSetting.mockResolvedValue(null);
    const { container } = render(<FirstRunDisclaimer />);
    await settle();

    const link = [...container.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("example.com"),
    );
    expect(link).toBeTruthy();
    act(() => {
      fireEvent.click(link as HTMLButtonElement);
    });
    expect(mocks.openExternalUrl).toHaveBeenCalledWith("https://example.com");
  });
});