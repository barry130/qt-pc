// 账户歌单同步（2026-10-26 需求）：
// 1) accountSyncPreview 的 diff 语义——missing 保持平台返回顺序、只与「同平台」
//    本地收藏 diff（网易同 pid / 本地自建都算缺失）；
// 2) collectAccountPlaylists 的计数语义——collected/skipped/failed，单个失败
//    不中断整体，已收藏跳过（预检失败视为未收藏继续）；
// 3) autoSyncMissingAfterLogin 的开关语义——「登录后同步歌单」缺省开、关着
//    返回 null 且不拉平台数据；包旧错误原样上抛（页面 console.warn 静默）；
// 4) SourcePlaylistSyncDialog 组件——missing 渲染、收藏调用参数、空/错误态、
//    failed>0 的 toastError；
// 5) SourceAccountsPage 登录成功自动触发——默认开且 missing>0 自动弹窗；
//    syncPlaylists=false 不自动弹。
//
// 环境用 jsdom（页面/弹窗用例需要）；lib 用例在 jsdom 下跑纯逻辑无碍。
// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ipcState = vi.hoisted(() => ({
  store: new Map<string, string>(),
  /** ipc.listMyPlaylists 的应答（MyPlaylistSummary 的运行时最小形状） */
  mine: [] as Array<Record<string, unknown>>,
  /** ipc.isPlaylistFavorited 的应答（key = `${platform}#${id}`） */
  favorited: new Map<string, boolean>(),
  /** ipc.favoritePlaylist 调用记录（push 顺序 = 执行顺序） */
  favoriteCalls: [] as Array<{ platform: string; id: string; name: string; picUrl?: string; playCount?: string }>,
  /** 指定 id 的 favoritePlaylist 抛错（模拟单个写入失败） */
  favoriteReject: new Map<string, string>(),
  /** 指定 id 的 isPlaylistFavorited 抛错（预检失败兜底用例） */
  precheckFail: new Set<string>(),
}));

const scriptsState = vi.hoisted(() => ({
  /** accountPlaylists 的应答（SourceAccountPlaylist 运行时形状） */
  playlists: [] as SourceAccountPlaylist[],
  /** 非空 = accountPlaylists 抛该错误（模拟包旧/未登录） */
  error: null as string | null,
  calls: [] as string[],
}));

const toastState = vi.hoisted(() => ({
  toast: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

const registryState = vi.hoisted(() => {
  const ensure = async (): Promise<void> => undefined;
  const sources = [{ id: "bili", name: "B站", auth: { methods: ["cookie"] } }] as Array<
    Record<string, unknown>
  >;
  // 稳定快照：页面 effect 依赖 registryProfiles，引用每次变化会导致无限重渲染
  const snapshot = { sources, ensure, profiles: {} };
  return { ensure, sources, snapshot };
});

vi.mock("@/services/ipc", () => ({
  getSetting: (key: string) => Promise.resolve(ipcState.store.get(key) ?? null),
  setSetting: (key: string, value: string) => {
    ipcState.store.set(key, value);
    return Promise.resolve();
  },
  SOURCE_META_CHANGED_EVENT: "source-meta-changed",
  SOURCE_PACK_CHANGED_EVENT: "source-pack-changed",
  LOCAL_PLATFORM: "local",
  listMyPlaylists: () => Promise.resolve(ipcState.mine),
  isPlaylistFavorited: (platform: string, id: string) => {
    if (ipcState.precheckFail.has(id)) return Promise.reject(new Error("precheck boom"));
    return Promise.resolve(ipcState.favorited.get(`${platform}#${id}`) ?? false);
  },
  favoritePlaylist: (platform: string, id: string, name: string, picUrl?: string, playCount?: string) => {
    const hit = ipcState.favoriteReject.get(id);
    if (hit !== undefined) return Promise.reject(new Error(hit));
    ipcState.favoriteCalls.push({ platform, id, name, picUrl, playCount });
    return Promise.resolve();
  },
}));

vi.mock("@/source-scripts", () => ({
  accountPlaylists: (source: string) => {
    scriptsState.calls.push(source);
    if (scriptsState.error !== null) return Promise.reject(new Error(scriptsState.error));
    return Promise.resolve(scriptsState.playlists);
  },
  // 页面 mount 保活校验与 source-auth 的注入面用到的其余包装（本文件不测其行为）
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
  onEnginePhaseChange: () => () => undefined,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => undefined,
}));

vi.mock("@/stores/toast", () => ({
  toast: toastState.toast,
  toastSuccess: toastState.toastSuccess,
  toastError: toastState.toastError,
  toastUndo: vi.fn(),
}));

vi.mock("@/stores/sourceRegistry", () => ({
  useSourceRegistryStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector(registryState.snapshot),
  useSourceLabelFn: () => (id: string) => id,
  sourceQualityOptionsOf: () => [],
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

import {
  accountSyncPreview,
  autoSyncMissingAfterLogin,
  collectAccountPlaylists,
} from "@/lib/source-playlist-sync";
import {
  parseSourceAuthToggles,
  readSourceAuthSyncPlaylistsFor,
  resetSourceAuthCaches,
  saveSourceAuthSyncPlaylists,
} from "@/lib/source-auth";
import { SOURCE_AUTH_ACCOUNTS_KEY, SOURCE_AUTH_TOGGLES_KEY } from "@/lib/storageKeys";
import { SourcePlaylistSyncDialog } from "@/components/mine/SourcePlaylistSyncDialog";
import { SourceAccountsPage } from "@/components/mine/SourceAccountsPage";
import type { SourceAccountPlaylist } from "@/source-scripts";

const PACK_OUTDATED_MSG =
  "数据包版本过旧：当前数据包缺少 accountPlaylists 入口（需要 数据包 2026.10.26.3（META_REVISION 14））。请到「设置 → 音源包」更新数据包后重试";

function mineRow(pid: string, platform: string): Record<string, unknown> {
  return {
    id: `local-${platform}-${pid}`,
    pid,
    name: `本地收藏 ${pid}`,
    platform,
    picUrl: "",
    trackCount: 3,
    createdAt: 1,
    updatedAt: 1,
    isLocal: platform === "local",
  };
}

function remoteRow(overrides: Partial<SourceAccountPlaylist> & { id: string; name: string }): SourceAccountPlaylist {
  return { owned: false, ...overrides };
}

beforeEach(() => {
  ipcState.store.clear();
  ipcState.mine.length = 0;
  ipcState.favorited.clear();
  ipcState.favoriteCalls.length = 0;
  ipcState.favoriteReject.clear();
  ipcState.precheckFail.clear();
  scriptsState.playlists.length = 0;
  scriptsState.error = null;
  scriptsState.calls.length = 0;
  toastState.toast.mockClear();
  toastState.toastSuccess.mockClear();
  toastState.toastError.mockClear();
  resetSourceAuthCaches();
});

afterEach(() => cleanup());

describe("accountSyncPreview（平台侧 vs 本地已收藏 diff）", () => {
  it("missing 保持平台返回顺序，且只与同平台的本地收藏 diff", async () => {
    scriptsState.playlists = [
      remoteRow({ id: "a1", name: "已收藏" }),
      remoteRow({ id: "a2", name: "网易有同 pid 不算已收藏" }),
      remoteRow({ id: "a3", name: "本地自建不算已收藏", owned: true }),
      remoteRow({ id: "a4", name: "缺失" }),
    ];
    ipcState.mine = [mineRow("a1", "bili"), mineRow("a2", "netease"), mineRow("a3", "local")];

    const r = await accountSyncPreview("bili");

    expect(r.total).toBe(4);
    expect(r.missing.map((p) => p.id)).toEqual(["a2", "a3", "a4"]);
  });

  it("全部已收藏 → missing 为空、total 保留", async () => {
    scriptsState.playlists = [remoteRow({ id: "a1", name: "一" }), remoteRow({ id: "a2", name: "二" })];
    ipcState.mine = [mineRow("a1", "bili"), mineRow("a2", "bili")];

    const r = await accountSyncPreview("bili");

    expect(r).toEqual({ missing: [], total: 2 });
  });

  it("包旧错误原样上抛（不改写文案）", async () => {
    scriptsState.error = PACK_OUTDATED_MSG;

    const err = await accountSyncPreview("bili").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(PACK_OUTDATED_MSG);
  });
});

describe("collectAccountPlaylists（收藏执行计数）", () => {
  it("逐个收藏并传对参数：trackCount 转 playCount 字符串，缺省传 undefined", async () => {
    const picks = [
      remoteRow({ id: "p1", name: "歌单一", picUrl: "http://img/1.jpg", trackCount: 12 }),
      remoteRow({ id: "p2", name: "歌单二", owned: true }),
    ];

    const r = await collectAccountPlaylists("bili", picks);

    expect(r).toEqual({ collected: 2, skipped: 0, failed: 0 });
    expect(ipcState.favoriteCalls).toEqual([
      { platform: "bili", id: "p1", name: "歌单一", picUrl: "http://img/1.jpg", playCount: "12" },
      { platform: "bili", id: "p2", name: "歌单二", picUrl: undefined, playCount: undefined },
    ]);
  });

  it("执行时发现本地已收藏 → skipped 计数且不再写收藏", async () => {
    ipcState.favorited.set("bili#p1", true);

    const r = await collectAccountPlaylists("bili", [remoteRow({ id: "p1", name: "已在" })]);

    expect(r).toEqual({ collected: 0, skipped: 1, failed: 0 });
    expect(ipcState.favoriteCalls).toEqual([]);
  });

  it("预检失败按未收藏继续（不中断）", async () => {
    ipcState.precheckFail.add("p1");

    const r = await collectAccountPlaylists("bili", [remoteRow({ id: "p1", name: "预检炸" })]);

    expect(r).toEqual({ collected: 1, skipped: 0, failed: 0 });
    expect(ipcState.favoriteCalls.map((c) => c.id)).toEqual(["p1"]);
  });

  it("单个失败只计 failed 不中断整体，其余照常收藏", async () => {
    ipcState.favoriteReject.set("p2", "写入失败");

    const r = await collectAccountPlaylists("bili", [
      remoteRow({ id: "p1", name: "一" }),
      remoteRow({ id: "p2", name: "二" }),
      remoteRow({ id: "p3", name: "三" }),
    ]);

    expect(r).toEqual({ collected: 2, skipped: 0, failed: 1 });
    expect(ipcState.favoriteCalls.map((c) => c.id)).toEqual(["p1", "p3"]);
  });
});

describe("autoSyncMissingAfterLogin（登录后自动同步决策）", () => {
  it("开关关（syncPlaylists=false）→ 返回 null 且不拉平台数据", async () => {
    ipcState.store.set(
      SOURCE_AUTH_TOGGLES_KEY,
      JSON.stringify({ bili: { useMeta: true, usePlay: true, syncPlaylists: false } }),
    );

    const r = await autoSyncMissingAfterLogin("bili");

    expect(r).toBeNull();
    expect(scriptsState.calls).toEqual([]);
  });

  it("缺省开（无记录）→ 拉差集并返回缺失清单", async () => {
    scriptsState.playlists = [remoteRow({ id: "a1", name: "已收藏" }), remoteRow({ id: "a2", name: "缺失" })];
    ipcState.mine = [mineRow("a1", "bili")];

    const r = await autoSyncMissingAfterLogin("bili");

    expect(r).not.toBeNull();
    expect(r?.map((p) => p.id)).toEqual(["a2"]);
    expect(scriptsState.calls).toEqual(["bili"]);
  });

  it("预览失败原样上抛（由页面 console.warn 静默）", async () => {
    scriptsState.error = PACK_OUTDATED_MSG;

    const err = await autoSyncMissingAfterLogin("bili").then(
      () => null,
      (e: unknown) => e,
    );

    expect((err as Error).message).toBe(PACK_OUTDATED_MSG);
  });
});

describe("source-auth：syncPlaylists 开关持久化", () => {
  it("parse 只收 boolean，坏值/缺省不写键（记录向后兼容）", () => {
    const dropped = parseSourceAuthToggles(
      JSON.stringify({ bili: { useMeta: true, usePlay: false, syncPlaylists: "yes" } }),
    );
    expect(dropped.bili).toEqual({ useMeta: true, usePlay: false });

    const kept = parseSourceAuthToggles(
      JSON.stringify({ bili: { useMeta: true, usePlay: false, syncPlaylists: false } }),
    );
    expect(kept.bili?.syncPlaylists).toBe(false);
  });

  it("readSourceAuthSyncPlaylistsFor 缺省 = true", async () => {
    await expect(readSourceAuthSyncPlaylistsFor("bili")).resolves.toBe(true);
  });

  it("saveSourceAuthSyncPlaylists 物化进 per-source 表并可读回", async () => {
    ipcState.store.set(
      SOURCE_AUTH_ACCOUNTS_KEY,
      JSON.stringify({
        bili: { cookie: "c", user: { nickname: "张三" }, savedAt: "2026-10-26T00:00:00.000Z" },
      }),
    );

    await saveSourceAuthSyncPlaylists("bili", false);
    await expect(readSourceAuthSyncPlaylistsFor("bili")).resolves.toBe(false);
    const stored = JSON.parse(ipcState.store.get(SOURCE_AUTH_TOGGLES_KEY) ?? "{}") as Record<
      string,
      { useMeta: boolean; usePlay: boolean; syncPlaylists?: boolean }
    >;
    expect(stored.bili).toEqual({ useMeta: true, usePlay: true, syncPlaylists: false });

    await saveSourceAuthSyncPlaylists("bili", true);
    await expect(readSourceAuthSyncPlaylistsFor("bili")).resolves.toBe(true);
  });
});

describe("SourcePlaylistSyncDialog（同步弹窗组件）", () => {
  function renderDialog(): { onClose: ReturnType<typeof vi.fn>; onDone: ReturnType<typeof vi.fn> } {
    const onClose = vi.fn();
    const onDone = vi.fn();
    render(
      <SourcePlaylistSyncDialog source="bili" sourceName="B站" onClose={onClose} onDone={onDone} />,
    );
    return { onClose, onDone };
  }

  it("渲染缺失清单（已收藏的不列）+ 默认全选 + 收藏调用参数", async () => {
    scriptsState.playlists = [
      remoteRow({ id: "p1", name: "已收藏歌单" }),
      remoteRow({ id: "p2", name: "待收藏歌单", picUrl: "http://img/p2.jpg", trackCount: 5 }),
    ];
    ipcState.mine = [mineRow("p1", "bili")];
    const { onClose, onDone } = renderDialog();

    expect(await screen.findByText("待收藏歌单")).toBeTruthy();
    expect(screen.queryByText("已收藏歌单")).toBeNull();
    expect(screen.getByText("收藏所选（1）")).toBeTruthy();

    fireEvent.click(screen.getByText("收藏所选（1）"));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onDone).toHaveBeenCalled();
    expect(toastState.toast).toHaveBeenCalledWith("已收藏 1 个歌单");
    expect(ipcState.favoriteCalls).toEqual([
      { platform: "bili", id: "p2", name: "待收藏歌单", picUrl: "http://img/p2.jpg", playCount: "5" },
    ]);
  });

  it("取消勾选 → 计数归零且按钮禁用", async () => {
    scriptsState.playlists = [remoteRow({ id: "p1", name: "唯一缺失" })];
    renderDialog();

    await screen.findByText("唯一缺失");
    // checkbox：第 0 个是全选，第 1 个是行选择
    fireEvent.click(screen.getAllByRole("checkbox")[1]);

    const btn = screen.getByText("收藏所选（0）") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("平台侧没有歌单 → 空态文案、无收藏按钮", async () => {
    scriptsState.playlists = [];
    renderDialog();

    expect(await screen.findByText("平台侧没有歌单")).toBeTruthy();
    expect(screen.queryByText(/收藏所选/)).toBeNull();
  });

  it("包旧/未登录错误文案原样展示", async () => {
    scriptsState.error = PACK_OUTDATED_MSG;
    renderDialog();

    expect(await screen.findByText(PACK_OUTDATED_MSG)).toBeTruthy();
  });

  it("failed>0 → toastError 提示部分失败", async () => {
    scriptsState.playlists = [remoteRow({ id: "p1", name: "一" }), remoteRow({ id: "p2", name: "二" })];
    ipcState.favoriteReject.set("p1", "写入失败");
    const { onClose } = renderDialog();

    fireEvent.click(await screen.findByText("收藏所选（2）"));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toastState.toastError).toHaveBeenCalledWith("已收藏 1 个歌单，1 个失败，可稍后重开同步重试");
  });
});

describe("SourceAccountsPage：登录成功自动触发同步", () => {
  async function loginViaCookie(): Promise<void> {
    fireEvent.click(await screen.findByText("导入Cookie"));
    fireEvent.change(screen.getByPlaceholderText("粘贴 Cookie…"), { target: { value: "SESSDATA=abc" } });
    fireEvent.click(screen.getByText("导入"));
  }

  it("默认开且平台侧有缺失 → 登录成功自动打开同步弹窗", async () => {
    scriptsState.playlists = [remoteRow({ id: "p1", name: "我的最爱", trackCount: 9 })];

    render(<SourceAccountsPage />);
    await screen.findByText("B站");
    await loginViaCookie();

    // 弹窗标题 + 缺失行出现 = 自动触发成功（登录 toast 先行）
    await waitFor(() => expect(toastState.toast).toHaveBeenCalledWith("已导入B站登录：张三"));
    expect(await screen.findByText("我的最爱")).toBeTruthy();
    expect(screen.getByText("B站 · 同步歌单")).toBeTruthy();
  });

  it("syncPlaylists=false → 登录成功不拉平台数据、不弹窗", async () => {
    ipcState.store.set(
      SOURCE_AUTH_TOGGLES_KEY,
      JSON.stringify({ bili: { useMeta: true, usePlay: true, syncPlaylists: false } }),
    );

    render(<SourceAccountsPage />);
    await screen.findByText("B站");
    await loginViaCookie();

    await waitFor(() => expect(toastState.toast).toHaveBeenCalledWith("已导入B站登录：张三"));
    // 排空异步：自动触发链已走完仍未拉平台数据
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scriptsState.calls).toEqual([]);
    expect(screen.queryByText("我的最爱")).toBeNull();
  });
});
