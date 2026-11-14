// @vitest-environment jsdom
// 音源平台管理页（合三为一，2026-11-14）：聚合搜索白名单从设置行搬进每张
// 音源卡片的「参与聚合搜索」开关。本文件沿用原设置行测试的五条行为语义：
// 点一下立刻落库、不能把最后一个源关掉、全选写空值、按 id 还原勾选。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  registry: {
    sources: [
      { id: "wyy", name: "网易云音乐", short: "网易", color: "#f00" },
      { id: "qq", name: "QQ 音乐", short: "QQ", color: "#0f0" },
      { id: "kw", name: "酷我音乐", short: "酷我", color: "#00f" },
    ],
    get catalog() { return this.sources; },
    policy: null,
    generation: 0,
    profiles: {},
    ready: true,
    ensure: () => Promise.resolve(),
  },
  toast: vi.fn(),
}));

vi.mock("@/services/ipc", () => ({
  getSetting: (key: string) => Promise.resolve(state.settings.get(key) ?? null),
  setSetting: (key: string, value: string) => {
    state.settings.set(key, value);
    return Promise.resolve();
  },
}));

vi.mock("@/stores/sourceRegistry", () => ({
  useSourceRegistryStore: (selector: (s: typeof state.registry) => unknown) =>
    selector(state.registry),
  useSourceLabelFn: () => (id: string) => id,
  sourceQualityOptionsOf: () => [],
}));

vi.mock("@/stores/toast", () => ({
  toast: state.toast,
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/source-scripts", () => ({
  // 本文件不测登录行为，页面 mount 保活校验用的包装全给安全空实现
  authCheckUser: () => Promise.resolve({ ok: true, credential: null, user: null, refreshToken: null }),
  authImportCookie: () =>
    Promise.resolve({ ok: true, user: { id: "1", nickname: "张三", avatar: "", vip: false, vipLabel: "" } }),
  authQrCreate: () => Promise.reject(new Error("not used here")),
  authQrPoll: () => Promise.reject(new Error("not used here")),
  authSendSms: () => Promise.reject(new Error("not used here")),
  authLoginByPhone: () => Promise.reject(new Error("not used here")),
  authLoginByPassword: () => Promise.reject(new Error("not used here")),
  authSetCredential: () => Promise.resolve(),
  authClearCredential: () => Promise.resolve(),
}));

vi.mock("@/source-engine/client", () => ({
  engineInvoke: async () => ({ ready: true, message: "" }),
  onEnginePhaseChange: () => () => undefined,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => undefined,
}));

vi.mock("@/lib/quality", () => ({
  qualityOptionsFromRegistry: () => [],
}));

vi.mock("@/lib/source-quality", () => ({
  SOURCE_QUALITIES_CHANGED_EVENT: "source-qualities-changed",
  loadSourceQualities: async () => undefined,
  setSourcePlayQuality: async () => undefined,
  setSourceDownloadQuality: async () => undefined,
  sourcePlayQualityOf: () => "standard",
  sourceDownloadQualityOf: () => "standard",
}));

vi.mock("@/lib/source-web-login", () => ({
  runWebLoginFlow: async () => "cancelled",
}));

import { SourceAccountsPage } from "@/components/mine/SourceAccountsPage";
import { resetAggregateSourcesCache } from "@/lib/aggregate-sources";
import { AGGREGATE_SOURCES_KEY } from "@/lib/storageKeys";

/** 卡片默认全折叠：先「全部展开」再取「参与聚合搜索：XXX」开关 */
async function renderPageWithCardsExpanded(): Promise<void> {
  render(<SourceAccountsPage />);
  await screen.findByText("网易云音乐");
  fireEvent.click(screen.getByRole("button", { name: /全部展开/ }));
}

function aggregateSwitch(name: string): HTMLButtonElement {
  return screen.getByRole("switch", { name: `参与聚合搜索：${name}` }) as HTMLButtonElement;
}

beforeEach(() => {
  state.settings.clear();
  state.toast.mockClear();
  resetAggregateSourcesCache();
});

afterEach(cleanup);

describe("音源平台管理：参与聚合搜索开关（原设置行合三为一搬入卡片）", () => {
  it("没配置过时三个源的参与开关全开", async () => {
    await renderPageWithCardsExpanded();
    await waitFor(() => expect(aggregateSwitch("网易云音乐").getAttribute("aria-checked")).toBe("true"));
    expect(aggregateSwitch("QQ 音乐").getAttribute("aria-checked")).toBe("true");
    expect(aggregateSwitch("酷我音乐").getAttribute("aria-checked")).toBe("true");
  });

  it("关掉一个源立刻落库，写的是其余两个 id", async () => {
    await renderPageWithCardsExpanded();
    await waitFor(() => expect(aggregateSwitch("QQ 音乐").getAttribute("aria-checked")).toBe("true"));

    fireEvent.click(aggregateSwitch("QQ 音乐"));
    await waitFor(() => expect(aggregateSwitch("QQ 音乐").getAttribute("aria-checked")).toBe("false"));
    expect(JSON.parse(state.settings.get(AGGREGATE_SOURCES_KEY)!)).toEqual(["wyy", "kw"]);
  });

  it("最后一个源不允许关掉，提示且不改设置", async () => {
    state.settings.set(AGGREGATE_SOURCES_KEY, '["wyy"]');
    await renderPageWithCardsExpanded();
    await waitFor(() => expect(aggregateSwitch("网易云音乐").getAttribute("aria-checked")).toBe("true"));
    expect(aggregateSwitch("QQ 音乐").getAttribute("aria-checked")).toBe("false");
    expect(aggregateSwitch("酷我音乐").getAttribute("aria-checked")).toBe("false");

    fireEvent.click(aggregateSwitch("网易云音乐"));
    await waitFor(() => expect(state.toast).toHaveBeenCalled());
    expect(String(state.toast.mock.calls[0]?.[0])).toContain("聚合搜索至少要留一个音源");
    // 设置没被写坏
    expect(state.settings.get(AGGREGATE_SOURCES_KEY)).toBe('["wyy"]');
    expect(aggregateSwitch("网易云音乐").getAttribute("aria-checked")).toBe("true");
  });

  it("把关掉的源点回全部 → 写空值（= 默认：以后新增的音源自动参与）", async () => {
    state.settings.set(AGGREGATE_SOURCES_KEY, '["wyy"]');
    await renderPageWithCardsExpanded();
    await waitFor(() => expect(aggregateSwitch("网易云音乐").getAttribute("aria-checked")).toBe("true"));

    fireEvent.click(aggregateSwitch("QQ 音乐"));
    fireEvent.click(aggregateSwitch("酷我音乐"));
    await waitFor(() =>
      expect(aggregateSwitch("酷我音乐").getAttribute("aria-checked")).toBe("true"),
    );
    expect(state.settings.get(AGGREGATE_SOURCES_KEY)).toBe("");
  });

  it("已配置的勾选按 id 还原，顺序不影响", async () => {
    state.settings.set(AGGREGATE_SOURCES_KEY, '["kw","wyy"]');
    await renderPageWithCardsExpanded();
    await waitFor(() => expect(aggregateSwitch("网易云音乐").getAttribute("aria-checked")).toBe("true"));
    expect(aggregateSwitch("QQ 音乐").getAttribute("aria-checked")).toBe("false");
    expect(aggregateSwitch("酷我音乐").getAttribute("aria-checked")).toBe("true");
  });
});
