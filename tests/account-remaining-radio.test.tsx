// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Track } from "@/types";
import { RECOMMENDATION_SOURCE_KEY, SOURCE_AUTH_ACCOUNTS_KEY, SOURCE_AUTH_TOGGLES_KEY } from "@/lib/storageKeys";

// Approved real desktop seam: controls, account save, source facade, META auth,
// radio and player remain real. Only the separate engine and Native IPC reply.
const MG_COOKIE = "pacmtoken=SYNTHETIC_ONLY_DESKTOP_MIGU_TOKEN";
const KG_COOKIE = "token=SYNTHETIC_ONLY_DESKTOP_KG_TOKEN; userid=123456; kugou_dev=SYNTHETIC_ONLY_SAVED_DEVICE";
const boundary = vi.hoisted(() => ({
  settings: new Map<string, string>(), listeners: new Map<string, Array<(event: { payload: Record<string, unknown> }) => void>>(),
  requests: [] as Array<Record<string, unknown>>, commands: [] as Array<{ command: string; args: Record<string, unknown> }>,
  pages: [] as Array<Record<string, unknown>>, queue: [] as Track[], queueRevision: 7, ticket: 0, committed: new Set<number>(),
  authResult: { ok: true, user: { id: "123456789", nickname: "合成咪咕用户", avatar: "", vip: false, vipLabel: "" } } as Record<string, unknown>,
  authError: "", fmError: "", rejectSettingKey: "", deferredFm: null as Promise<Record<string, unknown>> | null,
  engineAuth: new Map<string, string>(), acceptQueue: true, acceptAppend: true,
  applyQueue: null as ((tracks: Track[], revision: number) => void) | null,
}));
function publish(payload: Record<string, unknown>): void {
  for (const listener of boundary.listeners.get("source-engine-response") ?? []) listener({ payload });
}
vi.mock("@tauri-apps/api/core", () => ({ invoke: async (command: string, args: Record<string, unknown> = {}) => {
  boundary.commands.push({ command, args });
  if (command === "get_setting") return boundary.settings.get(String(args.key)) ?? null;
  if (command === "set_setting") {
    if (args.key === boundary.rejectSettingKey) throw new Error("SYNTHETIC_ONLY_NATIVE_SETTING_WRITE_REJECTED");
    boundary.settings.set(String(args.key), String(args.value)); return;
  }
  if (command === "clear_play_url_cache" || command === "write_log") return 0;
  if (command === "list_my_playlists") return [];
  if (command === "source_state") return { activeMetaId: "owned-remaining-meta", packs: [{ id: "owned-remaining-meta", kind: "meta", versionCode: 1 }] };
  if (command === "begin_play_intent") {
    if (args.expectedRevision !== undefined && (args.expectedRevision !== boundary.queueRevision || (boundary.ticket > 0 && !boundary.committed.has(boundary.ticket)))) return null;
    return ++boundary.ticket;
  }
  if (command === "abandon_play_intent") { boundary.committed.add(Number(args.playIntent)); return; }
  if (command === "set_play_mode") return;
  if (command === "play_queue") {
    const applied = boundary.acceptQueue && args.playIntent === boundary.ticket && !boundary.committed.has(boundary.ticket) && (args.expectedRevision === undefined || args.expectedRevision === boundary.queueRevision);
    boundary.committed.add(Number(args.playIntent));
    if (applied) { boundary.queue = args.tracks as Track[]; boundary.applyQueue?.(boundary.queue, boundary.queueRevision); }
    return { applied, target: null, queueRevision: boundary.queueRevision };
  }
  if (command === "queue_append_if_current") {
    if (!boundary.acceptAppend || args.expectedRevision !== boundary.queueRevision) return { applied: false, queueRevision: boundary.queueRevision };
    boundary.queue = [...boundary.queue, ...args.tracks as Track[]]; boundary.queueRevision += 1;
    boundary.applyQueue?.(boundary.queue, boundary.queueRevision);
    return { applied: true, queueRevision: boundary.queueRevision };
  }
  if (command === "queue_release_if_current") {
    if (args.expectedRevision !== boundary.queueRevision) return { applied: false, queueRevision: boundary.queueRevision };
    boundary.queueRevision += 1; return { applied: true, queueRevision: boundary.queueRevision };
  }
  throw new Error("Unexpected owned remaining-FM IPC: " + command);
} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, listener: (event: { payload: Record<string, unknown> }) => void) => {
    const listeners = boundary.listeners.get(event) ?? []; listeners.push(listener); boundary.listeners.set(event, listeners);
    return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); };
  },
  emit: async () => undefined,
  emitTo: async (_label: string, event: string, request: Record<string, unknown>) => {
    if (event !== "source-engine-request") throw new Error("Unexpected owned remaining-FM event");
    boundary.requests.push(request);
    if (request.kind === "status") { publish({ requestId: request.requestId, phase: "ready", pack: null, meta: { id: "owned-remaining-meta", code: 1, revision: "19" } }); return; }
    if (request.kind === "resolve") { publish({ requestId: request.requestId, url: "", line: null, error: "", stalled: false }); return; }
    if (request.kind !== "invoke") throw new Error("Unexpected owned remaining-FM RPC kind");
    let result: Record<string, unknown>;
    const args = request.args as Record<string, unknown>;
    if (request.entry === "sourceRegistry") result = { sources: [
      { id: "wyy", name: "网易云音乐", short: "网易", color: "fixture", accountRecommendations: { daily: true, fm: true } },
      { id: "qq", name: "QQ音乐", short: "QQ", color: "fixture", accountRecommendations: { fm: true } },
      { id: "kg", name: "酷狗音乐", short: "酷狗", color: "fixture", auth: { methods: ["qrcode", "cookie"], domains: ["kugou.com"] }, accountRecommendations: { daily: true, fm: true } },
      { id: "kw", name: "酷我音乐", short: "酷我", color: "fixture" },
      { id: "bili", name: "哔哩哔哩", short: "B站", color: "fixture" },
      { id: "migu", name: "咪咕音乐", short: "咪咕", color: "fixture", auth: { methods: ["cookie"], domains: ["migu.cn", "musicapp.migu.cn"] }, accountRecommendations: { fm: true } },
    ], qualities: [] };
    else if (request.entry === "setAuth") { boundary.engineAuth.set(String(args.scope) + ":" + String(args.source), String(args.cookie)); result = { ok: true }; }
    else if (request.entry === "clearAuth") {
      const prefix = String(args.scope) + ":";
      if (args.source === undefined) {
        for (const key of boundary.engineAuth.keys()) if (key.startsWith(prefix)) boundary.engineAuth.delete(key);
      } else boundary.engineAuth.delete(prefix + String(args.source));
      result = { ok: true };
    }
    else if (request.entry === "authImportCookie") {
      if (boundary.authError) { publish({ requestId: request.requestId, error: boundary.authError }); return; }
      result = boundary.authResult;
    }
    else if (request.entry === "authUser") result = args.source === "kg"
      ? { ok: true, user: { id: "123456", nickname: "合成酷狗用户", avatar: "", vip: false, vipLabel: "" } }
      : boundary.authResult;
    else if (request.entry === "accountPlaylists") { publish({ requestId: request.requestId, error: "该音源暂不支持账户歌单读取" }); return; }
    else if (request.entry === "getSourceQualities") result = { mode: "platform", qualities: [], aliases: {} };
    else if (request.entry === "accountFmNext") {
      if (!boundary.engineAuth.has("meta:" + String(args.source))) throw new Error("Fixture engine FM before real desktop META propagation");
      if (boundary.fmError) { publish({ requestId: request.requestId, error: boundary.fmError }); return; }
      const deferred = boundary.deferredFm;
      boundary.deferredFm = null;
      const next = deferred ? await deferred : boundary.pages.shift();
      if (!next) throw new Error("Unexpected unbounded owned FM pull");
      result = next;
    } else throw new Error("Unexpected owned remaining-FM entry: " + String(request.entry));
    publish({ requestId: request.requestId, result: JSON.stringify(result) });
  },
}));
function page(source: "kg" | "migu", ids: string[]): Record<string, unknown> {
  return { source, kind: "fm", accountId: source === "kg" ? "123456" : "123456789", fetchedAt: Date.now(), exhausted: false,
    items: ids.map(id => ({ id, name: "Owned " + id, singer: "Fixture", album: "", picUrl: "", interval: 180, ...(source === "migu" ? { musicId: "copyright-" + id } : {}) })) };
}
beforeEach(() => {
  vi.resetModules();
  boundary.settings.clear(); boundary.listeners.clear(); boundary.requests.length = 0; boundary.commands.length = 0; boundary.pages = [];
  boundary.queue = []; boundary.queueRevision = 7; boundary.ticket = 0; boundary.committed.clear(); boundary.applyQueue = null;
  boundary.engineAuth.clear(); boundary.acceptQueue = true; boundary.acceptAppend = true;
  boundary.authError = ""; boundary.fmError = ""; boundary.rejectSettingKey = ""; boundary.deferredFm = null;
  boundary.authResult = { ok: true, user: { id: "123456789", nickname: "合成咪咕用户", avatar: "", vip: false, vipLabel: "" } };
  window.scrollTo = vi.fn();
  boundary.settings.set(SOURCE_AUTH_ACCOUNTS_KEY, JSON.stringify({ kg: { cookie: KG_COOKIE, savedAt: "2026-11-13T01:00:00.000Z",
    user: { id: "123456", nickname: "合成酷狗用户", avatar: "", vip: false, vipLabel: "" } } }));
  boundary.settings.set(SOURCE_AUTH_TOGGLES_KEY, JSON.stringify({ kg: { useMeta: true, usePlay: false } }));
  boundary.settings.set(RECOMMENDATION_SOURCE_KEY, JSON.stringify({ v: 1, daily: { origin: "app", sourceId: "" }, fm: { origin: "account", sourceId: "migu" } }));
});
afterEach(() => { vi.clearAllTimers(); });
async function mountAccountAndControls() {
  const { SourceAccountsPage } = await import("@/components/mine/SourceAccountsPage");
  const { RecommendationSourceControl } = await import("@/components/common/RecommendationSourceControl");
  const { RadioPage } = await import("@/components/mine/RadioPage");
  const { useSourceRegistryStore } = await import("@/stores/sourceRegistry");
  const { usePlayerStore } = await import("@/stores/player");
  const { useRadioStore } = await import("@/stores/radio");
  const { useRecommendationSourceStore } = await import("@/stores/recommendation-source");
  const auth = await import("@/lib/source-auth");
  const { getSourceRegistry } = await import("@/source-scripts");
  const registry = await getSourceRegistry();
  useSourceRegistryStore.setState({ ready: true, generation: 1, sources: registry!.sources, catalog: registry!.sources });
  boundary.applyQueue = tracks => usePlayerStore.getState().applyQueue({ tracks, index: 0 });
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({ getParentRoute: () => root, path: "/", component: () => <><SourceAccountsPage /><RecommendationSourceControl feature="daily" /><RadioPage /></> });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  render(<RouterProvider router={router} />);
  const fm = await screen.findByRole("combobox", { name: "私人 FM 平台" });
  // 2026-11-14 卡头多了拖拽把手 + 左侧包裹层：按钮祖先层数变了，
  // 改用卡片根上的 data-source-card 锚点定位（比祖先链稳）。
  const card = screen.getByRole("button", { name: /咪咕音乐 (未登录|已登录|凭据已过期)/ })
    .closest("[data-source-card]") as HTMLElement;
  return { fm, card, auth, usePlayerStore, useRadioStore, useRecommendationSourceStore };
}
async function importMiguCookie(card: HTMLElement): Promise<void> {
  fireEvent.click(within(card).getByRole("button", { name: "导入Cookie" }));
  const modal = await screen.findByRole("dialog", { name: "咪咕音乐 · 导入 Cookie" });
  fireEvent.change(within(modal).getByPlaceholderText("粘贴 Cookie…"), { target: { value: MG_COOKIE } });
  fireEvent.click(within(modal).getByRole("button", { name: "导入" }));
}

function saveSyntheticMiguFixture(): void {
  const accounts = JSON.parse(boundary.settings.get(SOURCE_AUTH_ACCOUNTS_KEY)!);
  boundary.settings.set(SOURCE_AUTH_ACCOUNTS_KEY, JSON.stringify({ ...accounts, migu: { cookie: MG_COOKIE, savedAt: "2026-11-13T02:00:00.000Z", user: { id: "123456789", nickname: "合成咪咕用户", avatar: "", vip: false, vipLabel: "" } } }));
  const toggles = JSON.parse(boundary.settings.get(SOURCE_AUTH_TOGGLES_KEY)!);
  boundary.settings.set(SOURCE_AUTH_TOGGLES_KEY, JSON.stringify({ ...toggles, migu: { useMeta: true, usePlay: false } }));
}
async function selectAndStart(source: "kg" | "migu", fm: HTMLElement, store: Awaited<ReturnType<typeof mountAccountAndControls>>["useRadioStore"]): Promise<void> {
  fireEvent.change(fm, { target: { value: source } });
  await screen.findByText(source === "kg" ? "账号：合成酷狗用户（123456）" : "账号：合成咪咕用户（123456789）");
  fireEvent.click(screen.getByRole("button", { name: "开始收听" }));
  await vi.waitFor(() => expect(store.getState().active).toBe(true));
}
function forbiddenFallbackCommands(): Array<{ command: string; args: Record<string, unknown> }> {
  return boundary.commands.filter(call => ["get_local_tracks", "get_ratings", "add_dislike_song", "queue_append"].includes(call.command));
}

describe("remaining FM at actual desktop account/save/control/store boundary", () => {
  it("新注册表露出酷狗/咪咕FM，咪咕Cookie真实导入保存并META注入后首批入队", async () => {
    const { fm, card, auth, useRadioStore, usePlayerStore, useRecommendationSourceStore } = await mountAccountAndControls();
    expect(within(fm).getAllByRole("option").map(option => option.textContent)).toEqual(["网易云音乐", "QQ音乐", "酷狗音乐", "咪咕音乐"]);
    expect((fm as HTMLSelectElement).value).toBe("migu");
    expect(await screen.findByText("请先登录该音源账号。")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "扫码登录" })).toBeNull();
    expect(await auth.readSourceAuthTogglesFor("kg")).toEqual({ useMeta: true, usePlay: false });
    await importMiguCookie(card);
    await screen.findByText("账号：合成咪咕用户（123456789）");
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const saved = JSON.parse(boundary.settings.get(SOURCE_AUTH_ACCOUNTS_KEY)!);
    expect(saved.migu).toMatchObject({ cookie: MG_COOKIE, user: { id: "123456789", nickname: "合成咪咕用户" } });
    expect(Number.isFinite(Date.parse(saved.migu.savedAt))).toBe(true);
    expect(saved.migu).not.toHaveProperty("extras");
    expect(saved.kg.cookie).toBe(KG_COOKIE);
    expect(boundary.engineAuth.get("meta:migu")).toBe(MG_COOKIE);
    expect(boundary.engineAuth.has("play:migu")).toBe(false);
    boundary.pages.push(page("migu", ["SyntheticB", "SyntheticA"]));
    fireEvent.click(screen.getByRole("button", { name: "开始收听" }));
    await vi.waitFor(() => expect(useRadioStore.getState().active).toBe(true));
    expect(useRadioStore.getState()).toMatchObject({ active: true, queueClaimed: true, origin: "account", receivedCount: 2, accountCursor: undefined, error: null });
    expect(usePlayerStore.getState().queue.map(track => [track.id, track.platform, track.musicId])).toEqual([["SyntheticB", "migu", "copyright-SyntheticB"], ["SyntheticA", "migu", "copyright-SyntheticA"]]);
    expect(boundary.requests.filter(request => request.entry === "accountFmNext").map(request => request.args)).toEqual([{ source: "migu", accountId: "123456789" }]);
    expect(JSON.parse(boundary.settings.get(SOURCE_AUTH_TOGGLES_KEY)!)).toEqual({ kg: { useMeta: true, usePlay: false }, migu: { useMeta: true, usePlay: false } });
    expect(useRecommendationSourceStore.getState().daily).toEqual({ origin: "app", sourceId: "" });
    expect(document.body.textContent).not.toContain("SYNTHETIC_ONLY_DESKTOP_");
    expect(forbiddenFallbackCommands()).toEqual([]);
  });

  it.each([{ ok: false, user: null }, { ok: true, user: null }])("failed Migu Cookie self check never saves or enables FM: %j", async result => {
    boundary.authResult = result;
    const previousAccounts = boundary.settings.get(SOURCE_AUTH_ACCOUNTS_KEY);
    const previousToggles = boundary.settings.get(SOURCE_AUTH_TOGGLES_KEY);
    const { card, useRadioStore } = await mountAccountAndControls();
    await importMiguCookie(card);
    await vi.waitFor(() => expect(boundary.requests.filter(request => request.entry === "authImportCookie")).toHaveLength(1));
    await vi.waitFor(() => expect((within(screen.getByRole("dialog")).getByRole("button", { name: "导入" }) as HTMLButtonElement).disabled).toBe(false));
    expect(boundary.settings.get(SOURCE_AUTH_ACCOUNTS_KEY)).toBe(previousAccounts);
    expect(boundary.settings.get(SOURCE_AUTH_TOGGLES_KEY)).toBe(previousToggles);
    expect(boundary.engineAuth.has("meta:migu")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "开始收听" }));
    await screen.findByRole("alert");
    expect(useRadioStore.getState()).toMatchObject({ active: false, receivedCount: 0 });
    expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toEqual([]);
    expect(boundary.commands.filter(call => call.command === "play_queue")).toEqual([]);
    expect(forbiddenFallbackCommands()).toEqual([]);
  });

  it("a static auth transport error preserves the old account and does not autosync or inject Migu", async () => {
    boundary.authError = "ACCOUNT_RECOMMENDATIONS_NETWORK: 登录网络请求失败";
    const previousAccounts = boundary.settings.get(SOURCE_AUTH_ACCOUNTS_KEY);
    const { card } = await mountAccountAndControls();
    await importMiguCookie(card);
    await vi.waitFor(() => expect((within(screen.getByRole("dialog")).getByRole("button", { name: "导入" }) as HTMLButtonElement).disabled).toBe(false));
    expect(boundary.settings.get(SOURCE_AUTH_ACCOUNTS_KEY)).toBe(previousAccounts);
    expect(boundary.engineAuth.has("meta:migu")).toBe(false);
    expect(boundary.requests.filter(request => request.entry === "accountPlaylists")).toEqual([]);
    expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toEqual([]);
  });

  it("a successful Migu Cookie self check cannot authorize FM when Native rejects account persistence", async () => {
    boundary.settings.set(SOURCE_AUTH_TOGGLES_KEY, JSON.stringify({ kg: { useMeta: true, usePlay: false }, migu: { useMeta: true, usePlay: false } }));
    const previousAccounts = boundary.settings.get(SOURCE_AUTH_ACCOUNTS_KEY);
    const previousToggles = boundary.settings.get(SOURCE_AUTH_TOGGLES_KEY);
    const { card, auth, useRadioStore } = await mountAccountAndControls();
    boundary.rejectSettingKey = SOURCE_AUTH_ACCOUNTS_KEY;
    await importMiguCookie(card);
    const dialog = screen.getByRole("dialog", { name: "咪咕音乐 · 导入 Cookie" });
    await vi.waitFor(() => expect((within(dialog).getByRole("button", { name: "导入" }) as HTMLButtonElement).disabled).toBe(false));
    expect(boundary.requests.filter(request => request.entry === "authImportCookie")).toHaveLength(1);
    expect(boundary.commands.filter(call => call.command === "set_setting" && call.args.key === SOURCE_AUTH_ACCOUNTS_KEY)).toHaveLength(1);
    expect(boundary.settings.get(SOURCE_AUTH_ACCOUNTS_KEY)).toBe(previousAccounts);
    expect(boundary.settings.get(SOURCE_AUTH_TOGGLES_KEY)).toBe(previousToggles);
    expect(boundary.requests.filter(request => request.entry === "accountPlaylists")).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    boundary.pages.push(page("migu", ["SyntheticUnpersisted"]));
    fireEvent.click(screen.getByRole("button", { name: "开始收听" }));
    await vi.waitFor(() => expect(useRadioStore.getState().loading).toBe(false));
    expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toEqual([]);
    expect(boundary.commands.filter(call => call.command === "play_queue")).toEqual([]);
    expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false, receivedCount: 0 });
    expect((await auth.readSourceAuthAccounts()).migu).toBeUndefined();
    expect(boundary.engineAuth.has("meta:migu")).toBe(false);
    expect(boundary.engineAuth.has("play:migu")).toBe(false);
    expect(forbiddenFallbackCommands()).toEqual([]);
  });

  it("a rejected actual META-enable switch write cannot authorize FM or borrow the retained PLAY login", async () => {
    saveSyntheticMiguFixture();
    boundary.settings.set(SOURCE_AUTH_TOGGLES_KEY, JSON.stringify({ kg: { useMeta: true, usePlay: false }, migu: { useMeta: false, usePlay: true } }));
    const previousToggles = boundary.settings.get(SOURCE_AUTH_TOGGLES_KEY);
    const { card, auth, useRadioStore } = await mountAccountAndControls();
    await act(async () => { await auth.ensureSourceAuthInjected(); });
    expect(boundary.engineAuth.get("play:migu")).toBe(MG_COOKIE);
    expect(boundary.engineAuth.has("meta:migu")).toBe(false);
    const heading = within(card).getByRole("button", { name: /咪咕音乐 (已登录|凭据已过期)/ });
    if (heading.getAttribute("aria-expanded") !== "true") fireEvent.click(heading);
    const dataRow = within(card).getByText("数据请求使用登录态").parentElement!.parentElement!;
    const metaSwitch = within(dataRow).getByRole("switch");
    expect(metaSwitch.getAttribute("aria-checked")).toBe("false");
    boundary.rejectSettingKey = SOURCE_AUTH_TOGGLES_KEY;
    fireEvent.click(metaSwitch);
    await vi.waitFor(() => expect(boundary.commands.filter(call => call.command === "set_setting" && call.args.key === SOURCE_AUTH_TOGGLES_KEY)).toHaveLength(1));
    await vi.waitFor(() => expect(metaSwitch.getAttribute("aria-checked")).toBe("false"));
    expect(boundary.settings.get(SOURCE_AUTH_TOGGLES_KEY)).toBe(previousToggles);
    boundary.pages.push(page("migu", ["SyntheticUnpersistedPermission"]));
    fireEvent.click(screen.getByRole("button", { name: "开始收听" }));
    await vi.waitFor(() => expect(useRadioStore.getState().loading).toBe(false));
    expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toEqual([]);
    expect(boundary.commands.filter(call => call.command === "play_queue")).toEqual([]);
    expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false, receivedCount: 0 });
    expect(await auth.readSourceAuthTogglesFor("migu")).toEqual({ useMeta: false, usePlay: true });
    expect(boundary.engineAuth.has("meta:migu")).toBe(false);
    expect(boundary.engineAuth.get("play:migu")).toBe(MG_COOKIE);
    expect(forbiddenFallbackCommands()).toEqual([]);
  });

  it("actual KG-to-Migu selection never borrows credentials; a pending KG batch cannot join the Migu queue", async () => {
    saveSyntheticMiguFixture();
    const { fm, auth, useRadioStore, usePlayerStore } = await mountAccountAndControls();
    await act(async () => { await auth.ensureSourceAuthInjected(); });
    expect(boundary.engineAuth.get("meta:kg")).toBe(KG_COOKIE);
    expect(boundary.engineAuth.get("meta:migu")).toBe(MG_COOKIE);
    boundary.pages.push(page("kg", ["SyntheticKGFirst"]));
    await selectAndStart("kg", fm, useRadioStore);
    let release!: (value: Record<string, unknown>) => void;
    boundary.deferredFm = new Promise(resolve => { release = resolve; });
    fireEvent.click(screen.getByRole("button", { name: "换一批" }));
    await vi.waitFor(() => expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toHaveLength(2));
    fireEvent.change(fm, { target: { value: "migu" } });
    await screen.findByText("账号：合成咪咕用户（123456789）");
    await act(async () => { release(page("kg", ["SyntheticKGLate"])); });
    await vi.waitFor(() => expect(useRadioStore.getState().loading).toBe(false));
    expect(useRadioStore.getState().active).toBe(false);
    expect(usePlayerStore.getState().queue.map(track => [track.id, track.platform])).toEqual([["SyntheticKGFirst", "kg"]]);
    expect(boundary.commands.filter(call => call.command === "queue_append_if_current")).toEqual([]);
    boundary.pages.push(page("migu", ["SyntheticMiguOnly"]));
    fireEvent.click(screen.getByRole("button", { name: "开始收听" }));
    await vi.waitFor(() => expect(useRadioStore.getState().active).toBe(true));
    expect(usePlayerStore.getState().queue.map(track => [track.id, track.platform])).toEqual([["SyntheticMiguOnly", "migu"]]);
    expect(boundary.requests.filter(request => request.entry === "accountFmNext").map(request => request.args)).toEqual([
      { source: "kg", accountId: "123456" }, { source: "kg", accountId: "123456" }, { source: "migu", accountId: "123456789" },
    ]);
    expect(boundary.engineAuth.get("meta:kg")).toBe(KG_COOKIE);
    expect(boundary.engineAuth.get("meta:migu")).toBe(MG_COOKIE);
    expect(boundary.engineAuth.has("play:kg")).toBe(false);
    expect(boundary.engineAuth.has("play:migu")).toBe(false);
    expect(forbiddenFallbackCommands()).toEqual([]);
  });

  it("the real facade clears only the named source, while omitted-source clear removes only the requested scope", async () => {
    saveSyntheticMiguFixture();
    const { auth } = await mountAccountAndControls();
    const facade = await import("@/source-scripts");
    await act(async () => { await auth.ensureSourceAuthInjected(); });
    await act(async () => {
      await facade.authSetCredential("play", "kg", KG_COOKIE);
      await facade.authSetCredential("play", "migu", MG_COOKIE);
      await facade.authClearCredential("meta", "kg");
    });
    expect(boundary.engineAuth.has("meta:kg")).toBe(false);
    expect(boundary.engineAuth.get("meta:migu")).toBe(MG_COOKIE);
    expect(boundary.engineAuth.get("play:kg")).toBe(KG_COOKIE);
    expect(boundary.engineAuth.get("play:migu")).toBe(MG_COOKIE);
    await act(async () => { await facade.authClearCredential("meta"); });
    expect([...boundary.engineAuth.entries()].sort()).toEqual([["play:kg", KG_COOKIE], ["play:migu", MG_COOKIE]]);
    await act(async () => { await facade.authClearCredential("play"); });
    expect([...boundary.engineAuth.entries()]).toEqual([]);
    expect(boundary.requests.filter(request => request.entry === "clearAuth").slice(-3).map(request => request.args)).toEqual([
      { scope: "meta", source: "kg" }, { scope: "meta" }, { scope: "play" },
    ]);
    expect(boundary.commands.filter(call => call.command === "play_queue")).toEqual([]);
    expect(forbiddenFallbackCommands()).toEqual([]);
  });

  for (const source of ["kg", "migu"] as const) {
    it(source + " actual PLAY-only toggle cannot authorize account FM or request music", async () => {
      saveSyntheticMiguFixture();
      const { fm, card, auth, useRadioStore } = await mountAccountAndControls();
      fireEvent.change(fm, { target: { value: source } });
      await screen.findByText(source === "kg" ? "账号：合成酷狗用户（123456）" : "账号：合成咪咕用户（123456789）");
      const selectedCard = source === "migu" ? card : screen.getByRole("button", { name: /酷狗音乐 (已登录|凭据已过期)/ })
        .closest("[data-source-card]") as HTMLElement;
      const heading = within(selectedCard).getByRole("button", { name: source === "migu" ? /咪咕音乐 (已登录|凭据已过期)/ : /酷狗音乐 (已登录|凭据已过期)/ });
      if (heading.getAttribute("aria-expanded") !== "true") fireEvent.click(heading);
      const dataRow = within(selectedCard).getByText("数据请求使用登录态").parentElement!.parentElement!;
      const playRow = within(selectedCard).getByText("播放请求使用登录态").parentElement!.parentElement!;
      fireEvent.click(within(dataRow).getByRole("switch"));
      await vi.waitFor(async () => expect(await auth.readSourceAuthTogglesFor(source)).toEqual({ useMeta: false, usePlay: false }));
      fireEvent.click(within(playRow).getByRole("switch"));
      await vi.waitFor(() => expect(boundary.engineAuth.has("play:" + source)).toBe(true));
      expect(await auth.readSourceAuthTogglesFor(source)).toEqual({ useMeta: false, usePlay: true });
      expect(boundary.engineAuth.has("meta:" + source)).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "开始收听" }));
      await screen.findByRole("alert");
      expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false, receivedCount: 0 });
      expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toEqual([]);
      expect(boundary.commands.filter(call => call.command === "play_queue")).toEqual([]);
      expect(forbiddenFallbackCommands()).toEqual([]);
    });

    it(source + " late FM result after stopping cannot append or restart an accepted queue", async () => {
      saveSyntheticMiguFixture();
      const { fm, useRadioStore, usePlayerStore } = await mountAccountAndControls();
      boundary.pages.push(page(source, ["SyntheticB", "SyntheticA"]));
      await selectAndStart(source, fm, useRadioStore);
      let release!: (value: Record<string, unknown>) => void;
      boundary.deferredFm = new Promise(resolve => { release = resolve; });
      fireEvent.click(screen.getByRole("button", { name: "换一批" }));
      await vi.waitFor(() => expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toHaveLength(2));
      fireEvent.click(screen.getByRole("button", { name: "停止 FM" }));
      expect(useRadioStore.getState().active).toBe(false);
      await act(async () => { release(page(source, ["SyntheticLate"])); });
      await vi.waitFor(() => expect(useRadioStore.getState().loading).toBe(false));
      expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false, receivedCount: 0, queueRevision: null });
      expect(usePlayerStore.getState().queue.map(track => track.id)).toEqual(["SyntheticB", "SyntheticA"]);
      expect(boundary.commands.filter(call => call.command === "queue_append_if_current")).toEqual([]);
      expect(forbiddenFallbackCommands()).toEqual([]);
    });

    it(source + " revoked META during refill drops the late result even though PLAY permission exists", async () => {
      saveSyntheticMiguFixture();
      const { fm, auth, useRadioStore, usePlayerStore } = await mountAccountAndControls();
      boundary.pages.push(page(source, ["SyntheticB", "SyntheticA"]));
      await selectAndStart(source, fm, useRadioStore);
      await act(async () => { await auth.setSourceAuthToggle(source, "play", true); });
      let release!: (value: Record<string, unknown>) => void;
      boundary.deferredFm = new Promise(resolve => { release = resolve; });
      fireEvent.click(screen.getByRole("button", { name: "换一批" }));
      await vi.waitFor(() => expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toHaveLength(2));
      await act(async () => { await auth.setSourceAuthToggle(source, "meta", false); release(page(source, ["SyntheticLate"])); });
      await vi.waitFor(() => expect(useRadioStore.getState().active).toBe(false));
      expect(boundary.engineAuth.has("meta:" + source)).toBe(false);
      expect(boundary.engineAuth.has("play:" + source)).toBe(true);
      expect(useRadioStore.getState()).toMatchObject({ receivedCount: 0, queueClaimed: false, accountCursor: undefined });
      expect(usePlayerStore.getState().queue.map(track => track.id)).toEqual(["SyntheticB", "SyntheticA"]);
      expect(boundary.commands.filter(call => call.command === "queue_append_if_current")).toEqual([]);
      expect(forbiddenFallbackCommands()).toEqual([]);
    });

    it(source + " replacement login with the same Cookie invalidates an outstanding FM session", async () => {
      saveSyntheticMiguFixture();
      const { fm, auth, useRadioStore, usePlayerStore } = await mountAccountAndControls();
      boundary.pages.push(page(source, ["SyntheticB", "SyntheticA"]));
      await selectAndStart(source, fm, useRadioStore);
      const oldSavedAt = JSON.parse(boundary.settings.get(SOURCE_AUTH_ACCOUNTS_KEY)!)[source].savedAt;
      let release!: (value: Record<string, unknown>) => void;
      boundary.deferredFm = new Promise(resolve => { release = resolve; });
      fireEvent.click(screen.getByRole("button", { name: "换一批" }));
      await vi.waitFor(() => expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toHaveLength(2));
      const user = { id: source === "kg" ? "123456" : "123456789", nickname: source === "kg" ? "合成酷狗用户" : "合成咪咕用户", avatar: "", vip: false, vipLabel: "" };
      await act(async () => { await auth.saveSourceAuthAccount(source, source === "kg" ? KG_COOKIE : MG_COOKIE, user); release(page(source, ["SyntheticLate"])); });
      await vi.waitFor(() => expect(useRadioStore.getState().active).toBe(false));
      expect(JSON.parse(boundary.settings.get(SOURCE_AUTH_ACCOUNTS_KEY)!)[source].savedAt).not.toBe(oldSavedAt);
      expect(useRadioStore.getState()).toMatchObject({ queueClaimed: false, receivedCount: 0, accountCursor: undefined });
      expect(usePlayerStore.getState().queue.map(track => track.id)).toEqual(["SyntheticB", "SyntheticA"]);
      expect(boundary.commands.filter(call => call.command === "queue_append_if_current")).toEqual([]);
      expect(forbiddenFallbackCommands()).toEqual([]);
    });

    it(source + " UI selection keeps platform order and refills only new tracks through accepted Native receipts", async () => {
      saveSyntheticMiguFixture();
      const { fm, useRadioStore, usePlayerStore, useRecommendationSourceStore } = await mountAccountAndControls();
      boundary.pages.push(page(source, ["SyntheticB", "SyntheticA", "SyntheticB"]));
      await selectAndStart(source, fm, useRadioStore);
      expect(usePlayerStore.getState().queue.map(track => [track.id, track.platform])).toEqual([["SyntheticB", source], ["SyntheticA", source]]);
      expect(useRadioStore.getState()).toMatchObject({ receivedCount: 2, queueRevision: 7, accountCursor: undefined });
      boundary.pages.push(page(source, ["SyntheticB", "SyntheticC", "SyntheticC"]));
      fireEvent.click(screen.getByRole("button", { name: "换一批" }));
      await vi.waitFor(() => expect(useRadioStore.getState().receivedCount).toBe(3));
      expect(usePlayerStore.getState().queue.map(track => track.id)).toEqual(["SyntheticB", "SyntheticA", "SyntheticC"]);
      expect(useRadioStore.getState()).toMatchObject({ active: true, queueClaimed: true, queueRevision: 8, accountCursor: undefined, exhausted: false });
      expect(boundary.requests.filter(request => request.entry === "accountFmNext").map(request => request.args)).toEqual([{ source, accountId: source === "kg" ? "123456" : "123456789" }, { source, accountId: source === "kg" ? "123456" : "123456789" }]);
      expect(boundary.commands.filter(call => call.command === "queue_append_if_current").map(call => (call.args.tracks as Track[]).map(track => track.id))).toEqual([["SyntheticC"]]);
      expect(useRecommendationSourceStore.getState().daily).toEqual({ origin: "app", sourceId: "" });
      expect(JSON.parse(boundary.settings.get(SOURCE_AUTH_TOGGLES_KEY)!)).toEqual({ kg: { useMeta: true, usePlay: false }, migu: { useMeta: true, usePlay: false } });
      expect(boundary.engineAuth.has("play:" + source)).toBe(false);
      expect(screen.queryByRole("button", { name: "不喜欢" })).toBeNull();
      expect(forbiddenFallbackCommands()).toEqual([]);
    });

    it(source + " empty and duplicate-only pulls stop after three attempts without committing probe state", async () => {
      saveSyntheticMiguFixture();
      const { fm, useRadioStore, usePlayerStore } = await mountAccountAndControls();
      boundary.pages.push(page(source, ["SyntheticB", "SyntheticA"]));
      await selectAndStart(source, fm, useRadioStore);
      const keys = [...useRadioStore.getState().usedKeys];
      boundary.pages.push(page(source, []), page(source, ["SyntheticB", "SyntheticA"]), page(source, []));
      fireEvent.click(screen.getByRole("button", { name: "换一批" }));
      await vi.waitFor(() => expect(useRadioStore.getState().exhausted).toBe(true));
      expect(useRadioStore.getState()).toMatchObject({ active: true, queueClaimed: true, queueRevision: 7, receivedCount: 2, accountCursor: undefined });
      expect([...useRadioStore.getState().usedKeys]).toEqual(keys);
      expect(usePlayerStore.getState().queue.map(track => track.id)).toEqual(["SyntheticB", "SyntheticA"]);
      expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toHaveLength(4);
      expect(boundary.commands.filter(call => call.command === "queue_append_if_current")).toEqual([]);
      expect(boundary.pages).toEqual([]);
      expect((screen.getByRole("button", { name: "换一批" }) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => { await useRadioStore.getState().refill(); });
      expect(boundary.requests.filter(request => request.entry === "accountFmNext")).toHaveLength(4);
      expect(forbiddenFallbackCommands()).toEqual([]);
    });

    it(source + " rejects Native first queue without claiming received songs or used keys", async () => {
      saveSyntheticMiguFixture(); boundary.acceptQueue = false;
      const { fm, useRadioStore, usePlayerStore } = await mountAccountAndControls();
      fireEvent.change(fm, { target: { value: source } });
      await screen.findByText(source === "kg" ? "账号：合成酷狗用户（123456）" : "账号：合成咪咕用户（123456789）");
      boundary.pages.push(page(source, ["SyntheticB", "SyntheticA"]));
      fireEvent.click(screen.getByRole("button", { name: "开始收听" }));
      await screen.findByRole("alert");
      expect(useRadioStore.getState()).toMatchObject({ active: false, queueClaimed: false, receivedCount: 0, queueRevision: null, accountCursor: undefined });
      expect(useRadioStore.getState().usedKeys.size).toBe(0);
      expect(usePlayerStore.getState().queue).toEqual([]);
      expect(boundary.commands.filter(call => call.command === "play_queue")).toHaveLength(1);
      expect(forbiddenFallbackCommands()).toEqual([]);
    });

    it(source + " rejected Native append stops FM and leaves the actual accepted queue unchanged", async () => {
      saveSyntheticMiguFixture();
      const { fm, useRadioStore, usePlayerStore } = await mountAccountAndControls();
      boundary.pages.push(page(source, ["SyntheticB", "SyntheticA"]));
      await selectAndStart(source, fm, useRadioStore);
      boundary.acceptAppend = false; boundary.pages.push(page(source, ["SyntheticC"]));
      fireEvent.click(screen.getByRole("button", { name: "换一批" }));
      await vi.waitFor(() => expect(useRadioStore.getState().active).toBe(false));
      expect(useRadioStore.getState()).toMatchObject({ queueClaimed: false, receivedCount: 0, queueRevision: null, accountCursor: undefined });
      expect(useRadioStore.getState().usedKeys.size).toBe(0);
      expect(usePlayerStore.getState().queue.map(track => track.id)).toEqual(["SyntheticB", "SyntheticA"]);
      expect(boundary.commands.filter(call => call.command === "queue_append_if_current")).toHaveLength(1);
      expect(boundary.queueRevision).toBe(7);
      expect(forbiddenFallbackCommands()).toEqual([]);
    });
  }
});
