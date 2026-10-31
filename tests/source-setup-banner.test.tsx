// @vitest-environment jsdom
// 设置 → 音源包 → 「如何设置音源」教程入口（用户 2026-10-31 要求提到页面最上面并用底色强调）：
// 1) 官网地址已配置时，整节最顶部渲染强调条（在「数据包」行之前）；
// 2) 未配置时整行不渲染，其余内容照常。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  registry: {
    sources: [] as { id: string; name: string; short: string; color: string }[],
    ensure: () => Promise.resolve(),
  },
  packs: [] as unknown[],
  offers: [] as unknown[],
  opened: [] as string[],
}));

vi.mock("@/services/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ipc")>();
  return {
    ...actual,
    getSetting: (key: string) => Promise.resolve(state.settings.get(key) ?? null),
    setSetting: (key: string, value: string) => {
      state.settings.set(key, value);
      return Promise.resolve();
    },
    getSourceState: () => Promise.resolve({ packs: state.packs, offers: state.offers }),
    discoverSourceUpdates: () => Promise.resolve([]),
    openExternalUrl: (url: string) => {
      state.opened.push(url);
      return Promise.resolve();
    },
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) =>
    cmd === "official_site_url"
      ? Promise.resolve(state.settings.get("__site") ?? "")
      : Promise.reject(new Error(cmd)),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => undefined),
}));

vi.mock("@/stores/sourceRegistry", () => ({
  useSourceRegistryStore: (selector: (s: typeof state.registry) => unknown) =>
    selector(state.registry),
  useSourceQualities: () => [],
}));

vi.mock("@/stores/source-update", () => ({
  useSourceUpdateStore: (selector: (s: { local: unknown; offers: unknown[]; busy: boolean }) => unknown) =>
    selector({ local: { packs: state.packs, offers: state.offers }, offers: state.offers, busy: false }),
}));

vi.mock("@/stores/toast", () => ({
  toast: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

import { SourcePackageSection } from "@/components/settings/sections/SourcePackageSection";

beforeEach(() => {
  state.settings.clear();
  state.opened.length = 0;
});

afterEach(cleanup);

describe("音源包设置页的教程入口", () => {
  it("官网地址已配置时，教程强调条渲染在最顶部（先于「数据包」行）", async () => {
    state.settings.set("__site", "https://quietmusic.canace.cn");
    const { container } = render(<SourcePackageSection />);
    await waitFor(() => expect(container.textContent).toContain("如何设置音源"));
    const text = container.textContent ?? "";
    expect(text.indexOf("如何设置音源")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("数据包")).toBeGreaterThan(text.indexOf("如何设置音源"));
    expect(text).toContain("查看教程");
    // 底色强调（bg-primary/8）与悬停加深（hover:bg-primary/12）
    const banner = [...container.querySelectorAll("a")].find((a) =>
      (a.textContent ?? "").includes("查看教程"),
    );
    expect(banner?.className).toContain("bg-primary/8");
    expect(banner?.className).toContain("hover:bg-primary/12");
  });

  it("未配置官网地址时不渲染教程入口，其余设置照常", () => {
    const { container } = render(<SourcePackageSection />);
    expect(container.textContent).not.toContain("如何设置音源");
    expect(container.textContent).toContain("数据包");
  });
});
