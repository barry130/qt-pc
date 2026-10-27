// @vitest-environment jsdom
// 设置 → 音源包 → 聚合搜索音源：勾选状态要一眼看得懂、点一下立刻落库，
// 且不能把最后一个源关掉（关掉 = 聚合搜索永远空结果）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  registry: {
    sources: [
      { id: "wyy", name: "网易云音乐", short: "网易", color: "#f00" },
      { id: "qq", name: "QQ 音乐", short: "QQ", color: "#0f0" },
      { id: "kw", name: "酷我音乐", short: "酷我", color: "#00f" },
    ],
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
  useSourceQualities: () => [],
}));

vi.mock("@/stores/toast", () => ({
  toast: state.toast,
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

import { AggregateSourcesRow } from "@/components/settings/sections/SourcePackageSection";
import { resetAggregateSourcesCache } from "@/lib/aggregate-sources";
import { AGGREGATE_SOURCES_KEY } from "@/lib/storageKeys";

function switches(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')];
}

beforeEach(() => {
  state.settings.clear();
  state.toast.mockClear();
  resetAggregateSourcesCache();
});

afterEach(cleanup);

describe("聚合搜索音源设置行", () => {
  it("没配置过时三个源全开，描述里显示「已选 3/3」", async () => {
    const { container } = render(<AggregateSourcesRow />);
    await waitFor(() => expect(container.textContent).toContain("已选 3/3"));
    expect(switches(container).map((el) => el.getAttribute("aria-checked"))).toEqual([
      "true",
      "true",
      "true",
    ]);
    expect(container.textContent).toContain("网易云音乐");
    expect(container.textContent).toContain("酷我音乐");
  });

  it("关掉一个源立刻落库，写的是其余两个 id", async () => {
    const { container } = render(<AggregateSourcesRow />);
    await waitFor(() => expect(container.textContent).toContain("已选 3/3"));
    fireEvent.click(switches(container)[1]!); // 关掉 QQ
    await waitFor(() => expect(container.textContent).toContain("已选 2/3"));
    expect(JSON.parse(state.settings.get(AGGREGATE_SOURCES_KEY)!)).toEqual(["wyy", "kw"]);
    expect(switches(container)[1]?.getAttribute("aria-checked")).toBe("false");
  });

  it("最后一个源不允许关掉，提示且不改设置", async () => {
    state.settings.set(AGGREGATE_SOURCES_KEY, '["wyy"]');
    const { container } = render(<AggregateSourcesRow />);
    await waitFor(() => expect(container.textContent).toContain("已选 1/3"));
    fireEvent.click(switches(container)[0]!);
    await waitFor(() => expect(state.toast).toHaveBeenCalled());
    expect(String(state.toast.mock.calls[0]?.[0])).toContain("至少留一个音源");
    // 设置没被写坏
    expect(state.settings.get(AGGREGATE_SOURCES_KEY)).toBe('["wyy"]');
    expect(switches(container)[0]?.getAttribute("aria-checked")).toBe("true");
  });

  it("把关掉的源点回全部 → 写空值（= 默认：以后新增的音源自动参与）", async () => {
    state.settings.set(AGGREGATE_SOURCES_KEY, '["wyy"]');
    const { container } = render(<AggregateSourcesRow />);
    await waitFor(() => expect(container.textContent).toContain("已选 1/3"));
    fireEvent.click(switches(container)[1]!);
    fireEvent.click(switches(container)[2]!);
    await waitFor(() => expect(container.textContent).toContain("已选 3/3"));
    expect(state.settings.get(AGGREGATE_SOURCES_KEY)).toBe("");
  });

  it("已配置的勾选按 id 还原，顺序不影响", async () => {
    state.settings.set(AGGREGATE_SOURCES_KEY, '["kw","wyy"]');
    const { container } = render(<AggregateSourcesRow />);
    await waitFor(() => expect(container.textContent).toContain("已选 2/3"));
    expect(switches(container).map((el) => el.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "true",
    ]);
  });
});
