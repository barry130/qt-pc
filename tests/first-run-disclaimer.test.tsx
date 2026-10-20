// @vitest-environment jsdom
/**
 * 首次启动的免责声明 / 开源通知（DESIGN §5.6）。
 *
 * 守的是这几条契约：
 * 1. **文案与读秒都由后端下发**，代码里不留硬编码正文（改条款不用发版）；
 * 2. 只在**安装后第一次启动**弹；条款版本号变了要重新确认一次；
 * 3. 「我知道了」要读满后端给的秒数才可点 —— 声明最怕的就是被顺手点掉；
 * 4. 后端没下发声明就**不弹**，不给一份可能已经过期的本地兜底文案；
 * 5. 通用公告弹窗必须排除这份声明，否则两个弹窗会叠着弹。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(async (_key: string): Promise<string | null> => null),
  setSetting: vi.fn(async (_key: string, _value: string): Promise<void> => undefined),
  openExternalUrl: vi.fn(async (_url: string): Promise<void> => undefined),
  astralActiveMessages: vi.fn(async (): Promise<unknown> => []),
  astralMessageCenter: vi.fn(async (): Promise<unknown> => []),
  astralUnreadCount: vi.fn(async (): Promise<number> => 0),
  astralAckMessages: vi.fn(async (_ids: number[]): Promise<void> => undefined),
}));

vi.mock("@/services/ipc", () => mocks);

import { FirstRunDisclaimer } from "@/components/common/FirstRunDisclaimer";
import { QtNoticeDialog } from "@/components/notice/qt-NoticeDialog";
import { disclaimerVisible, pickDisclaimer, useDisclaimerStore } from "@/stores/disclaimer";

const KEY = "disclaimer.acceptedAt";

/** 后端下发的一条声明公告（形状与 /app/message/active 的元素一致） */
function noticePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9001,
    display: 1,
    title: "使用前请先阅读",
    content: "<p>仅供个人学习与自用，<strong>不得用于商业用途</strong>。</p><p>那不是本项目。</p>",
    readSeconds: 3,
    termsVersion: "2026.10",
    url: "https://example.com/agreement",
    createTime: "2026-10-20 10:00:00",
    isTop: 0,
    ...over,
  };
}

/** 每个用例从「还没读库」的初始态开始（inited 置回 false 让 init 真的再跑一次） */
function resetStore(): void {
  useDisclaimerStore.setState({ pending: null, reopened: false, inited: false, notice: null });
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
  mocks.astralActiveMessages.mockResolvedValue([noticePayload()]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("首次启动免责声明 / 开源通知", () => {
  it("文案来自后端，没接受过就弹，读满读秒才能确认，确认后写入版本号", async () => {
    mocks.getSetting.mockResolvedValue(null);
    const { container } = render(<FirstRunDisclaimer />);
    await settle();

    expect(mocks.astralActiveMessages).toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    // 后端下发的正文（含富文本标签渲染结果），不是代码里的硬编码
    expect(container.textContent).toContain("不得用于商业用途");
    expect(container.textContent).toContain("那不是本项目");
    expect(container.textContent).toContain("使用前请先阅读");

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
    // 落库的是 {termsVersion, acceptedAt}：光有时间戳无法判断「条款改没改」
    const written = JSON.parse(mocks.setSetting.mock.calls[0][1] as string);
    expect(written.termsVersion).toBe("2026.10");
    expect(Number.isNaN(Date.parse(written.acceptedAt))).toBe(false);
  });

  it("读秒时长由后端给：0 秒时确认键立即可点", async () => {
    mocks.getSetting.mockResolvedValue(null);
    mocks.astralActiveMessages.mockResolvedValue([noticePayload({ readSeconds: 0 })]);
    const { container } = render(<FirstRunDisclaimer />);
    await settle();

    const btn = confirmButton(container);
    expect(btn.disabled).toBe(false);
    expect((btn.textContent ?? "").trim()).toBe("我知道了");
  });

  it("同版本已接受过就不再出现", async () => {
    mocks.getSetting.mockResolvedValue(
      JSON.stringify({ termsVersion: "2026.10", acceptedAt: "2026-10-18T03:00:00.000Z" }),
    );
    const { container } = render(<FirstRunDisclaimer />);
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("条款版本号变了要重新确认一次", async () => {
    mocks.getSetting.mockResolvedValue(
      JSON.stringify({ termsVersion: "2025.01", acceptedAt: "2026-01-01T00:00:00.000Z" }),
    );
    const { container } = render(<FirstRunDisclaimer />);
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it("升级前写入的裸 ISO 记录当作已接受，不因新增版本号机制打扰老用户", async () => {
    mocks.getSetting.mockResolvedValue("2026-10-18T03:00:00.000Z");
    const { container } = render(<FirstRunDisclaimer />);
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("后端没下发声明就不弹，不用本地硬编码兜底", async () => {
    mocks.getSetting.mockResolvedValue(null);
    mocks.astralActiveMessages.mockResolvedValue([]);
    const { container } = render(<FirstRunDisclaimer />);
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(useDisclaimerStore.getState().pending).toBe(false);
  });

  it("接口挂了按不弹处理，不把人卡在弹窗前", async () => {
    mocks.getSetting.mockResolvedValue(null);
    mocks.astralActiveMessages.mockRejectedValue(new Error("network down"));
    const { container } = render(<FirstRunDisclaimer />);
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("设置页「重新查看」能再打开一次，要重新读秒且不改已记录的接受时刻", async () => {
    mocks.getSetting.mockResolvedValue(
      JSON.stringify({ termsVersion: "2026.10", acceptedAt: "2026-10-18T03:00:00.000Z" }),
    );
    const { container } = render(<FirstRunDisclaimer />);
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    let shown = false;
    await act(async () => {
      shown = await useDisclaimerStore.getState().reopen();
    });
    expect(shown).toBe(true);
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(confirmButton(container).disabled).toBe(true);
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("「重新查看」时后端仍没有声明，要返回 false 让设置页提示，而不是静默无反应", async () => {
    mocks.getSetting.mockResolvedValue(null);
    mocks.astralActiveMessages.mockResolvedValue([]);
    render(<FirstRunDisclaimer />);
    await settle();

    let shown = true;
    await act(async () => {
      shown = await useDisclaimerStore.getState().reopen();
    });
    expect(shown).toBe(false);
  });

  it("声明里的链接走系统浏览器，且只认 http(s)", async () => {
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
    expect(mocks.openExternalUrl).toHaveBeenCalledWith("https://example.com/agreement");
  });

  it("通用公告弹窗要排除免责声明，否则两个弹窗叠着弹", async () => {
    mocks.astralActiveMessages.mockResolvedValue([
      noticePayload({ id: 9001, title: "使用前请先阅读" }),
      { id: 9002, display: 1, title: "新版本上线", content: "1.1.3 已发布", createTime: "2026-10-20 11:00:00" },
    ]);
    const { container } = render(<QtNoticeDialog />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("新版本上线");
    expect(container.textContent).not.toContain("使用前请先阅读");
  });
});

describe("pickDisclaimer", () => {
  it("只认「开屏位 + 条款版本号非空」那条，置顶优先", () => {
    const picked = pickDisclaimer([
      { id: 1, display: 1, title: "普通开屏公告", content: "x" },
      { id: 2, display: 4, title: "消息中心里的声明", termsVersion: "v1" },
      { id: 3, display: 1, title: "旧声明", termsVersion: "v1", createTime: "2026-01-01 00:00:00" },
      { id: 4, display: 1, title: "置顶声明", termsVersion: "v2", isTop: 1, createTime: "2026-01-02 00:00:00" },
    ]);
    expect(picked?.id).toBe(4);
    expect(picked?.termsVersion).toBe("v2");
  });

  it("没有声明时返回 null", () => {
    expect(pickDisclaimer([{ id: 1, display: 1, title: "普通公告" }])).toBeNull();
    expect(pickDisclaimer(null)).toBeNull();
    expect(pickDisclaimer(undefined)).toBeNull();
  });

  it("读秒时长被夹在 0..60：弹窗没有关闭键，超长读秒等于把用户锁住", () => {
    // 后台表单 max=60 已拦，但绕过表单直接调 API / 手改库仍能写大值
    expect(pickDisclaimer([noticePayload({ readSeconds: 600 })] as unknown[])?.readSeconds).toBe(60);
    expect(pickDisclaimer([noticePayload({ readSeconds: -5 })] as unknown[])?.readSeconds).toBe(0);
    // 字段缺失 / 不是数字 / 是字符串数字，都按 0 处理（不读秒，保证可点）
    expect(pickDisclaimer([noticePayload({ readSeconds: undefined })] as unknown[])?.readSeconds).toBe(0);
    expect(pickDisclaimer([noticePayload({ readSeconds: "abc" })] as unknown[])?.readSeconds).toBe(0);
    expect(pickDisclaimer([noticePayload({ readSeconds: "5" })] as unknown[])?.readSeconds).toBe(5);
    expect(pickDisclaimer([noticePayload({ readSeconds: 3 })] as unknown[])?.readSeconds).toBe(3);
  });
});

describe("disclaimerVisible", () => {
  const notice = { id: 1, title: "t", content: "c", readSeconds: 3, termsVersion: "v1", url: "" };

  it("没拉到声明时一律不显示，哪怕 pending 为 true", () => {
    // 这条守的是「弹空壳」：后端没下发 / 接口挂了时 pending 仍可能是 true
    expect(disclaimerVisible({ pending: true, reopened: false, notice: null })).toBe(false);
    expect(disclaimerVisible({ pending: false, reopened: true, notice: null })).toBe(false);
  });

  it("pending 未读库（null）时不显示，避免闪一下", () => {
    expect(disclaimerVisible({ pending: null, reopened: false, notice })).toBe(false);
  });

  it("该弹的两种情形：首次需要展示 / 设置页主动重看", () => {
    expect(disclaimerVisible({ pending: true, reopened: false, notice })).toBe(true);
    expect(disclaimerVisible({ pending: false, reopened: true, notice })).toBe(true);
  });
});
