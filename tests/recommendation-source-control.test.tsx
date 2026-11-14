// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";

const boundary = vi.hoisted(() => ({ settings: new Map<string, string>(), authWait: null as Promise<void> | null, authStarted: false }));
// Only the native settings/event transport and separate source-engine window are fixtures.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === "get_setting") return boundary.settings.get(String(args.key)) ?? null;
    if (command === "set_setting") { boundary.settings.set(String(args.key), String(args.value)); return; }
    if (command === "clear_play_url_cache") return 0;
    throw new Error(`Unexpected native fixture command: ${command}`);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => undefined, emit: async () => undefined }));
vi.mock("@/source-engine/client", () => ({
  INVOKE_TIMEOUT_MS: 20_000,
  onEnginePhaseChange: () => () => undefined,
  engineSnapshot: () => ({ phase: "ready", code: null, detail: null }),
  engineResolve: async () => ({ url: "", line: null, error: "", stalled: false }),
  engineInvoke: async (entry: string) => {
    if (entry === "setAuth") { boundary.authStarted = true; await boundary.authWait; return { ok: true }; }
    if (entry === "clearAuth") return { ok: true };
    if (entry === "getSourceQualities") return { mode: "platform", qualities: [], aliases: {} };
    throw new Error(`Unexpected source-engine fixture entry: ${entry}`);
  },
}));

import { RecommendationSourceControl } from "@/components/common/RecommendationSourceControl";
import { RadioPage } from "@/components/mine/RadioPage";
import { useRadioStore } from "@/stores/radio";
import { useRecommendationSourceStore } from "@/stores/recommendation-source";
import { useSourceRegistryStore } from "@/stores/sourceRegistry";
import { removeSourceAuthAccount, resetSourceAuthCaches } from "@/lib/source-auth";
import { DAILY_RECOMMEND_MODE_KEY, RECOMMENDATION_SOURCE_KEY, SOURCE_AUTH_ACCOUNTS_KEY, SOURCE_AUTH_TOGGLES_KEY } from "@/lib/storageKeys";

async function renderControls(initialPath = "/") {
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({ getParentRoute: () => root, path: "/", component: () => <>
    <RecommendationSourceControl feature="daily" />
    <RecommendationSourceControl feature="fm" />
  </> });
  const radio = createRoute({ getParentRoute: () => root, path: "/radio", component: RadioPage });
  const accounts = createRoute({ getParentRoute: () => root, path: "/source-accounts", component: () => <p>Fixture account settings</p> });
  const settings = createRoute({ getParentRoute: () => root, path: "/settings/$section", component: () => <p>Fixture package settings</p> });
  const router = createRouter({ routeTree: root.addChildren([page, radio, accounts, settings]), history: createMemoryHistory({ initialEntries: [initialPath] }) });
  render(<RouterProvider router={router} />);
  await screen.findByRole("radiogroup", { name: initialPath === "/radio" ? "私人 FM 来源" : "每日推荐来源" });
  return router;
}

beforeEach(() => {
  boundary.settings.clear(); boundary.authWait = null; boundary.authStarted = false;
  window.scrollTo = vi.fn();
  resetSourceAuthCaches();
  useRecommendationSourceStore.setState({ daily: { origin: "app", sourceId: "" }, fm: { origin: "app", sourceId: "" }, loaded: false, dailyRevision: 0, fmRevision: 0 });
  useSourceRegistryStore.setState({ ready: true, generation: 1, sources: [
    { id: "wyy", name: "网易云音乐", short: "网易", color: "fixture", accountRecommendations: { daily: true, fm: true } },
    { id: "kg", name: "酷狗音乐", short: "酷狗", color: "fixture", accountRecommendations: { daily: true, fm: false } },
    { id: "qq", name: "QQ音乐", short: "QQ", color: "fixture", accountRecommendations: { daily: false, fm: false } },
  ] });
});

describe("independent recommendation source controls", () => {
  it("integrates the real FM source control while hiding application taste and local ranking claims in account mode", async () => {
    useRadioStore.setState(useRadioStore.getInitialState());
    await useRecommendationSourceStore.getState().setSelection("fm", { origin: "account", sourceId: "wyy" });
    await renderControls("/radio");
    expect(screen.queryByRole("radiogroup", { name: "推荐口味" })).toBeNull();
    expect(screen.getByText("按平台返回的顺序收听，不使用本地口味排序。" )).toBeTruthy();
    expect(document.body.textContent).not.toContain("同一位歌手一轮最多");
    expect(document.body.textContent).not.toContain("把更多目录加进曲库");
    expect(screen.getByRole("button", { name: "开始收听" })).toBeTruthy();
    expect(useRecommendationSourceStore.getState().daily.origin).toBe("app");
  });
  it("clears the selected account label after logout and directs the user to log in without falling back to app", async () => {
    boundary.settings.set(SOURCE_AUTH_ACCOUNTS_KEY, JSON.stringify({ wyy: {
      cookie: "owned-static-fixture-not-real", savedAt: "2026-11-09T00:00:00.000Z",
      user: { id: "42", nickname: "Owned listener", avatar: "", vip: false, vipLabel: "" },
    } }));
    boundary.settings.set(SOURCE_AUTH_TOGGLES_KEY, JSON.stringify({ wyy: { useMeta: true, usePlay: false } }));
    await useRecommendationSourceStore.getState().setSelection("daily", { origin: "account", sourceId: "wyy" });
    await renderControls();
    expect(await screen.findByText("账号：Owned listener（42）")).toBeTruthy();
    await act(async () => { await removeSourceAuthAccount("wyy"); });
    expect(screen.queryByText("账号：Owned listener（42）")).toBeNull();
    expect((await screen.findByRole("alert")).textContent).toContain("登录");
    expect(useRecommendationSourceStore.getState().daily).toEqual({ origin: "account", sourceId: "wyy" });
  });
  it("shows only the non-secret current account label after metadata injection is acknowledged", async () => {
    boundary.settings.set(SOURCE_AUTH_ACCOUNTS_KEY, JSON.stringify({ wyy: {
      cookie: "owned-static-fixture-not-real", savedAt: "2026-11-09T00:00:00.000Z",
      user: { id: "42", nickname: "Owned listener", avatar: "", vip: false, vipLabel: "" },
    } }));
    boundary.settings.set(SOURCE_AUTH_TOGGLES_KEY, JSON.stringify({ wyy: { useMeta: true, usePlay: false } }));
    let release!: () => void;
    boundary.authWait = new Promise<void>((resolve) => { release = resolve; });
    await useRecommendationSourceStore.getState().setSelection("daily", { origin: "account", sourceId: "wyy" });
    await renderControls();
    await vi.waitFor(() => expect(boundary.authStarted).toBe(true));
    expect(screen.queryByText(/Owned listener/)).toBeNull();
    release();
    expect(await screen.findByText("账号：Owned listener（42）")).toBeTruthy();
    expect(document.body.textContent).not.toContain("owned-static-fixture-not-real");
  });
  it.each(["missing", "meta-disabled"])("gives an explicit account-settings CTA for %s without enabling metadata or playback permission", async (problem) => {
    if (problem === "meta-disabled") boundary.settings.set(SOURCE_AUTH_ACCOUNTS_KEY, JSON.stringify({ wyy: {
      cookie: "owned-static-fixture-not-real", savedAt: "2026-11-09T00:00:00.000Z",
      user: { id: "42", nickname: "Owned listener", avatar: "", vip: false, vipLabel: "" },
    } }));
    const toggles = JSON.stringify({ wyy: { useMeta: false, usePlay: false } });
    boundary.settings.set(SOURCE_AUTH_TOGGLES_KEY, toggles);
    await useRecommendationSourceStore.getState().setSelection("daily", { origin: "account", sourceId: "wyy" });
    const router = await renderControls();
    const daily = screen.getByRole("region", { name: "每日推荐来源设置" });
    expect((await within(daily).findByRole("alert")).textContent).toContain(problem === "missing" ? "登录" : "数据");
    expect(boundary.settings.get(SOURCE_AUTH_TOGGLES_KEY)).toBe(toggles);
    expect(useRecommendationSourceStore.getState().daily).toEqual({ origin: "account", sourceId: "wyy" });
    fireEvent.click(within(daily).getByRole("button", { name: "管理音源平台" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/source-accounts"));
  });
  it.each(["kg", "wyy"])("keeps saved unsupported %s FM visibly selected instead of silently normalizing to app or another source", async (sourceId) => {
    if (sourceId === "wyy") {
      // Older packs omit the capability entirely; absence is not permission to guess support.
      useSourceRegistryStore.setState({ sources: useSourceRegistryStore.getState().sources.map((source) => source.id === "wyy" ? { ...source, accountRecommendations: undefined } : source) });
    }
    boundary.settings.set(RECOMMENDATION_SOURCE_KEY, JSON.stringify({ daily: { origin: "app", sourceId: "" }, fm: { origin: "account", sourceId } }));
    const router = await renderControls();
    const fm = screen.getByRole("radiogroup", { name: "私人 FM 来源" });
    expect(within(fm).getByRole("radio", { name: "平台账号" }).getAttribute("aria-checked")).toBe("true");
    const select = screen.getByRole("combobox", { name: "私人 FM 平台" }) as HTMLSelectElement;
    expect(select.value).toBe(sourceId);
    expect(within(select).getByRole("option", { name: /当前音源包不支持/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("不支持");
    expect(useRecommendationSourceStore.getState().fm).toEqual({ origin: "account", sourceId });
    fireEvent.click(screen.getByRole("button", { name: "音源包设置" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/settings/source-package"));
  });
  it("offers only declared account capabilities: NetEase daily/FM and Kugou daily, not QQ or Kugou FM", async () => {
    await useRecommendationSourceStore.getState().setSelection("daily", { origin: "account", sourceId: "wyy" });
    await useRecommendationSourceStore.getState().setSelection("fm", { origin: "account", sourceId: "wyy" });
    await renderControls();
    const daily = screen.getByRole("combobox", { name: "每日推荐平台" });
    const fm = screen.getByRole("combobox", { name: "私人 FM 平台" });
    expect(within(daily).getAllByRole("option").map((option) => option.textContent)).toEqual(["网易云音乐", "酷狗音乐"]);
    expect(within(fm).getAllByRole("option").map((option) => option.textContent)).toEqual(["网易云音乐"]);
  });
  it("defaults both features to application recommendations and switching daily leaves FM and shared AI settings unchanged", async () => {
    boundary.settings.set(DAILY_RECOMMEND_MODE_KEY, "local");
    await renderControls();
    const daily = screen.getByRole("radiogroup", { name: "每日推荐来源" });
    const fm = screen.getByRole("radiogroup", { name: "私人 FM 来源" });
    expect(within(daily).getByRole("radio", { name: "应用推荐" }).getAttribute("aria-checked")).toBe("true");
    expect(within(fm).getByRole("radio", { name: "应用推荐" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(within(daily).getByRole("radio", { name: "平台账号" }));
    await vi.waitFor(() => expect(JSON.parse(boundary.settings.get(RECOMMENDATION_SOURCE_KEY) ?? "{}").daily).toEqual({ origin: "account", sourceId: "wyy" }));
    expect(useRecommendationSourceStore.getState().fm).toEqual({ origin: "app", sourceId: "" });
    expect(within(fm).getByRole("radio", { name: "应用推荐" }).getAttribute("aria-checked")).toBe("true");
    expect(boundary.settings.get(DAILY_RECOMMEND_MODE_KEY)).toBe("local");
  });
});
