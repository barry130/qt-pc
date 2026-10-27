// 账户歌单同步（2026-10-26 需求；2026-10-27 定稿去掉「登录后同步歌单」开关，
// 同日再改版为「全量清单 + 已收藏标记 + 可取消收藏」）：
// 1) accountSyncPreview 的语义——rows = 平台侧全部歌单（保持平台顺序、逐行标
//    favorited，只与「同平台」本地收藏比对；网易同 pid / 本地自建都算未收藏），
//    missing 仍保留给登录后自动触发；
// 2) collectAccountPlaylists 的计数语义——collected/skipped/failed，单个失败
//    不中断整体，已收藏跳过（预检失败视为未收藏继续）；
// 2b) uncollectAccountPlaylists 的计数语义——removed/skipped/failed（2026-10-27
//    取消收藏需求，只动本地收藏关系）；
// 3) autoSyncMissingAfterLogin 的语义——登录即拉差集、无任何开关门控；包旧
//    错误原样上抛（页面 console.warn 静默）；
// 4) SourcePlaylistSyncDialog 组件——全部歌单渲染（已收藏带标记）、默认勾选已
//    收藏项、应用更改同时处理收藏与取消收藏、空/错误态、failed>0 的 toastError；
// 5) SourceAccountsPage——登录成功且 missing>0 自动弹窗；平台侧无缺失不弹；
//    卡片默认全部折叠（右上角「全部折叠/展开」一键切、标题行单卡切）、
//    「登录后同步歌单」开关行已移除、数据请求行带「只有启用时才能同步歌单」
//    备注、两面开关缺省 = 数据面开 / 播放面关（2026-10-27 用户定稿）。
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
  /** ipc.unfavoritePlaylist 调用记录（2026-10-27 取消收藏需求） */
  unfavoriteCalls: [] as Array<{ platform: string; id: string; name: string; picUrl?: string }>,
  /** 指定 id 的 favoritePlaylist 抛错（模拟单个写入失败） */
  favoriteReject: new Map<string, string>(),
  /** 指定 id 的 unfavoritePlaylist 抛错 */
  unfavoriteReject: new Map<string, string>(),
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
  const snapshot = { sources, ensure, profiles: {}, ready: true };
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
  unfavoritePlaylist: (platform: string, id: string, name: string, picUrl?: string) => {
    const hit = ipcState.unfavoriteReject.get(id);
    if (hit !== undefined) return Promise.reject(new Error(hit));
    ipcState.unfavoriteCalls.push({ platform, id, name, picUrl });
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
  uncollectAccountPlaylists,
} from "@/lib/source-playlist-sync";
import {
  parseSourceAuthToggles,
  resetSourceAuthCaches,
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
  ipcState.unfavoriteCalls.length = 0;
  ipcState.favoriteReject.clear();
  ipcState.unfavoriteReject.clear();
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

describe("accountSyncPreview（平台侧全量清单 + 本地收藏态）", () => {
  it("rows 返回平台侧全部歌单并标 favorited，missing 只留未收藏、保持平台顺序", async () => {
    scriptsState.playlists = [
      remoteRow({ id: "a1", name: "已收藏" }),
      remoteRow({ id: "a2", name: "网易有同 pid 不算已收藏" }),
      remoteRow({ id: "a3", name: "本地自建不算已收藏", owned: true }),
      remoteRow({ id: "a4", name: "缺失" }),
    ];
    ipcState.mine = [mineRow("a1", "bili"), mineRow("a2", "netease"), mineRow("a3", "local")];

    const r = await accountSyncPreview("bili");

    expect(r.total).toBe(4);
    // 2026-10-27：弹窗要显示全部歌单（含已收藏），不再只给缺失项
    expect(r.rows.map((row) => row.playlist.id)).toEqual(["a1", "a2", "a3", "a4"]);
    expect(r.rows.map((row) => row.favorited)).toEqual([true, false, false, false]);
    expect(r.missing.map((p) => p.id)).toEqual(["a2", "a3", "a4"]);
  });

  it("全部已收藏 → rows 全带 favorited、missing 为空、total 保留", async () => {
    scriptsState.playlists = [remoteRow({ id: "a1", name: "一" }), remoteRow({ id: "a2", name: "二" })];
    ipcState.mine = [mineRow("a1", "bili"), mineRow("a2", "bili")];

    const r = await accountSyncPreview("bili");

    expect(r.total).toBe(2);
    expect(r.rows.map((row) => row.favorited)).toEqual([true, true]);
    expect(r.missing).toEqual([]);
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

describe("uncollectAccountPlaylists（取消收藏执行计数）", () => {
  it("逐个取消收藏并传对参数（只动本地，不碰平台侧）", async () => {
    ipcState.favorited.set("bili#r1", true);
    ipcState.favorited.set("bili#r2", true);

    const r = await uncollectAccountPlaylists("bili", [
      remoteRow({ id: "r1", name: "歌单一", picUrl: "http://img/1.jpg" }),
      remoteRow({ id: "r2", name: "歌单二" }),
    ]);

    expect(r).toEqual({ removed: 2, skipped: 0, failed: 0 });
    expect(ipcState.unfavoriteCalls).toEqual([
      { platform: "bili", id: "r1", name: "歌单一", picUrl: "http://img/1.jpg" },
      { platform: "bili", id: "r2", name: "歌单二", picUrl: undefined },
    ]);
  });

  it("本地本来就没有 → skipped 计数且不写库", async () => {
    const r = await uncollectAccountPlaylists("bili", [remoteRow({ id: "r1", name: "没收藏" })]);

    expect(r).toEqual({ removed: 0, skipped: 1, failed: 0 });
    expect(ipcState.unfavoriteCalls).toEqual([]);
  });

  it("预检失败按已收藏继续尝试（unfavorite 幂等）", async () => {
    ipcState.precheckFail.add("r1");

    const r = await uncollectAccountPlaylists("bili", [remoteRow({ id: "r1", name: "预检炸" })]);

    expect(r).toEqual({ removed: 1, skipped: 0, failed: 0 });
    expect(ipcState.unfavoriteCalls.map((c) => c.id)).toEqual(["r1"]);
  });

  it("单个失败只计 failed 不中断整体", async () => {
    ipcState.favorited.set("bili#r1", true);
    ipcState.favorited.set("bili#r2", true);
    ipcState.favorited.set("bili#r3", true);
    ipcState.unfavoriteReject.set("r2", "删除失败");

    const r = await uncollectAccountPlaylists("bili", [
      remoteRow({ id: "r1", name: "一" }),
      remoteRow({ id: "r2", name: "二" }),
      remoteRow({ id: "r3", name: "三" }),
    ]);

    expect(r).toEqual({ removed: 2, skipped: 0, failed: 1 });
    expect(ipcState.unfavoriteCalls.map((c) => c.id)).toEqual(["r1", "r3"]);
  });
});

describe("autoSyncMissingAfterLogin（登录后自动同步）", () => {
  it("无任何开关门控：库里残留 syncPlaylists=false 也照样拉差集", async () => {
    ipcState.store.set(
      SOURCE_AUTH_TOGGLES_KEY,
      JSON.stringify({ bili: { useMeta: true, usePlay: true, syncPlaylists: false } }),
    );
    scriptsState.playlists = [remoteRow({ id: "a2", name: "缺失" })];
    ipcState.mine = [];

    const r = await autoSyncMissingAfterLogin("bili");

    expect(r.map((p) => p.id)).toEqual(["a2"]);
    expect(scriptsState.calls).toEqual(["bili"]);
  });

  it("缺省无记录 → 拉差集并返回缺失清单", async () => {
    scriptsState.playlists = [remoteRow({ id: "a1", name: "已收藏" }), remoteRow({ id: "a2", name: "缺失" })];
    ipcState.mine = [mineRow("a1", "bili")];

    const r = await autoSyncMissingAfterLogin("bili");

    expect(r.map((p) => p.id)).toEqual(["a2"]);
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

describe("source-auth：旧记录里的 syncPlaylists 键", () => {
  it("parse 不再收该键（旧记录读进来只剩两面开关，记录向后兼容）", () => {
    const parsed = parseSourceAuthToggles(
      JSON.stringify({ bili: { useMeta: true, usePlay: false, syncPlaylists: false } }),
    );
    expect(parsed.bili).toEqual({ useMeta: true, usePlay: false });

    const badValue = parseSourceAuthToggles(
      JSON.stringify({ bili: { useMeta: true, usePlay: false, syncPlaylists: "yes" } }),
    );
    expect(badValue.bili).toEqual({ useMeta: true, usePlay: false });
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

  it("列出平台侧全部歌单：已收藏的带「已收藏」标记且默认勾上", async () => {
    scriptsState.playlists = [
      remoteRow({ id: "p1", name: "已收藏歌单" }),
      remoteRow({ id: "p2", name: "待收藏歌单", picUrl: "http://img/p2.jpg", trackCount: 5 }),
    ];
    ipcState.mine = [mineRow("p1", "bili")];
    renderDialog();

    // 2026-10-27：已收藏的不再从列表里消失，而是带标记展示
    expect(await screen.findByText("已收藏歌单")).toBeTruthy();
    expect(screen.getByText("待收藏歌单")).toBeTruthy();
    expect(screen.getByText("已收藏")).toBeTruthy();
    expect(screen.getByText("全选（平台侧 2 个，已收藏 1 个）")).toBeTruthy();
    // 只有未收藏的那条需要动作 → 更改数 1
    expect(screen.getByText("应用更改（1）")).toBeTruthy();
  });

  it("勾选缺失项 → 收藏调用参数（trackCount 转 playCount 字符串）", async () => {
    scriptsState.playlists = [
      remoteRow({ id: "p1", name: "已收藏歌单" }),
      remoteRow({ id: "p2", name: "待收藏歌单", picUrl: "http://img/p2.jpg", trackCount: 5 }),
    ];
    ipcState.mine = [mineRow("p1", "bili")];
    const { onClose, onDone } = renderDialog();

    fireEvent.click(await screen.findByText("应用更改（1）"));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onDone).toHaveBeenCalled();
    expect(toastState.toast).toHaveBeenCalledWith("已收藏 1 个歌单");
    expect(ipcState.favoriteCalls).toEqual([
      { platform: "bili", id: "p2", name: "待收藏歌单", picUrl: "http://img/p2.jpg", playCount: "5" },
    ]);
    expect(ipcState.unfavoriteCalls).toEqual([]);
  });

  it("取消勾选已收藏项 → 调用 unfavoritePlaylist（本地取消收藏）", async () => {
    scriptsState.playlists = [remoteRow({ id: "p1", name: "已收藏歌单" })];
    ipcState.mine = [mineRow("p1", "bili")];
    ipcState.favorited.set("bili#p1", true);
    const { onClose } = renderDialog();

    await screen.findByText("已收藏歌单");
    // 排序：第 0 个是全选，第 1 个是行勾选（初始已勾上）
    const rowBox = screen.getAllByRole("checkbox")[1] as HTMLInputElement;
    expect(rowBox.checked).toBe(true);
    fireEvent.click(rowBox);

    fireEvent.click(screen.getByText("应用更改（1）"));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ipcState.unfavoriteCalls).toEqual([
      { platform: "bili", id: "p1", name: "已收藏歌单", picUrl: undefined },
    ]);
    expect(ipcState.favoriteCalls).toEqual([]);
    expect(toastState.toast).toHaveBeenCalledWith("已取消收藏 1 个歌单");
  });

  it("同时收藏 + 取消收藏 → 一次提交两边的差异", async () => {
    scriptsState.playlists = [
      remoteRow({ id: "keep", name: "保留的已收藏" }),
      remoteRow({ id: "new", name: "要新收藏" }),
      remoteRow({ id: "drop", name: "要取消收藏" }),
    ];
    ipcState.mine = [mineRow("keep", "bili"), mineRow("drop", "bili")];
    ipcState.favorited.set("bili#keep", true);
    ipcState.favorited.set("bili#drop", true);
    const { onClose } = renderDialog();

    await screen.findByText("要取消收藏");
    // 默认全勾（= 平台侧全同步进本地）；行序 = keep(1) / new(2) / drop(3)
    // 只把 drop 取消勾选 → 这一次提交里同时有「收藏 new」和「取消收藏 drop」
    fireEvent.click(screen.getAllByRole("checkbox")[3]);

    fireEvent.click(screen.getByText("应用更改（2）"));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ipcState.favoriteCalls.map((c) => c.id)).toEqual(["new"]);
    expect(ipcState.unfavoriteCalls.map((c) => c.id)).toEqual(["drop"]);
    expect(toastState.toast).toHaveBeenCalledWith("已收藏 1 个，已取消收藏 1 个歌单");
  });

  it("平台侧全部已收藏且全勾选 → 没有改动、按钮禁用", async () => {
    scriptsState.playlists = [remoteRow({ id: "p1", name: "唯一歌单" })];
    ipcState.mine = [mineRow("p1", "bili")];
    renderDialog();

    await screen.findByText("唯一歌单");
    const btn = screen.getByText("应用更改（0）") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("平台侧没有歌单 → 空态文案、无应用按钮", async () => {
    scriptsState.playlists = [];
    renderDialog();

    expect(await screen.findByText("平台侧没有歌单")).toBeTruthy();
    expect(screen.queryByText(/应用更改/)).toBeNull();
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

    fireEvent.click(await screen.findByText("应用更改（2）"));

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

  it("平台侧有缺失 → 登录成功自动打开同步弹窗（无需任何开关）", async () => {
    scriptsState.playlists = [remoteRow({ id: "p1", name: "我的最爱", trackCount: 9 })];

    render(<SourceAccountsPage />);
    await screen.findByText("B站");
    await loginViaCookie();

    // 弹窗标题 + 缺失行出现 = 自动触发成功（登录 toast 先行）
    await waitFor(() => expect(toastState.toast).toHaveBeenCalledWith("已导入B站登录：张三"));
    expect(await screen.findByText("我的最爱")).toBeTruthy();
    expect(screen.getByText("B站 · 同步歌单")).toBeTruthy();
  });

  it("平台侧无缺失 → 拉了差集但不弹窗", async () => {
    scriptsState.playlists = [];

    render(<SourceAccountsPage />);
    await screen.findByText("B站");
    await loginViaCookie();

    await waitFor(() => expect(toastState.toast).toHaveBeenCalledWith("已导入B站登录：张三"));
    // 排空异步：自动触发链已走完、差集拉过、但没有可补的歌单
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scriptsState.calls).toEqual(["bili"]);
    expect(screen.queryByText("B站 · 同步歌单")).toBeNull();
  });
});

describe("SourceAccountsPage：卡片折叠与开关行", () => {
  it("默认全部折叠：下面的开关/音质行都不可见，右上角是「全部展开」", async () => {
    render(<SourceAccountsPage />);
    await screen.findByText("B站");

    expect(screen.queryByText("数据请求使用登录态")).toBeNull();
    expect(screen.queryByText("播放请求使用登录态")).toBeNull();
    expect(screen.queryByText("播放音质")).toBeNull();
    expect(screen.getByRole("button", { name: /B站/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: /全部展开/ })).toBeTruthy();
  });

  it("右上角「全部展开 / 全部折叠」一键统一切换", async () => {
    render(<SourceAccountsPage />);
    await screen.findByText("B站");

    fireEvent.click(screen.getByRole("button", { name: /全部展开/ }));
    expect(screen.getByText("数据请求使用登录态")).toBeTruthy();
    expect(screen.getByText("播放请求使用登录态")).toBeTruthy();
    expect(screen.getByText("播放音质")).toBeTruthy();
    expect(screen.getByRole("button", { name: /B站/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /全部折叠/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /全部折叠/ }));
    expect(screen.queryByText("数据请求使用登录态")).toBeNull();
    expect(screen.queryByText("播放音质")).toBeNull();
    expect(screen.getByRole("button", { name: /全部展开/ })).toBeTruthy();
  });

  it("点标题行单独展开，再点收起；登录按钮始终不受影响", async () => {
    render(<SourceAccountsPage />);
    await screen.findByText("B站");

    fireEvent.click(screen.getByRole("button", { name: /B站/ }));
    expect(screen.getByText("数据请求使用登录态")).toBeTruthy();
    expect(screen.getByRole("button", { name: /B站/ }).getAttribute("aria-expanded")).toBe("true");
    // 标题行右侧的登录工具条不参与折叠
    expect(screen.getByText("导入Cookie")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /B站/ }));
    expect(screen.queryByText("数据请求使用登录态")).toBeNull();
    expect(screen.getByText("导入Cookie")).toBeTruthy();
  });

  it("未登录的源也按缺省展示数据开/播放关，但开关不可点", async () => {
    render(<SourceAccountsPage />);
    await screen.findByText("B站");
    fireEvent.click(screen.getByRole("button", { name: /全部展开/ }));

    // 开关顺序跟行顺序一致：数据请求在前、播放请求在后
    const switches = screen.getAllByRole("switch");
    expect(switches.length).toBeGreaterThanOrEqual(2);
    expect(switches[0].getAttribute("aria-checked")).toBe("true");
    expect(switches[1].getAttribute("aria-checked")).toBe("false");
    // 没账号时开关仍禁用（缺省值只是展示口径，注入要等登录）
    expect(switches[0].hasAttribute("disabled")).toBe(true);
    expect(switches[1].hasAttribute("disabled")).toBe(true);
  });

  it("已登录的源按缺省展示：数据请求使用登录态=开、播放请求使用登录态=关", async () => {
    scriptsState.playlists = [];
    render(<SourceAccountsPage />);
    await screen.findByText("B站");
    fireEvent.click(await screen.findByText("导入Cookie"));
    fireEvent.change(screen.getByPlaceholderText("粘贴 Cookie…"), { target: { value: "SESSDATA=abc" } });
    fireEvent.click(screen.getByText("导入"));
    await waitFor(() => expect(toastState.toast).toHaveBeenCalledWith("已导入B站登录：张三"));

    fireEvent.click(screen.getByRole("button", { name: /全部展开/ }));
    await waitFor(() =>
      expect(screen.getAllByRole("switch")[0].getAttribute("aria-checked")).toBe("true"),
    );
    expect(screen.getAllByRole("switch")[1].getAttribute("aria-checked")).toBe("false");
  });

  it("不再渲染「登录后同步歌单」开关行（默认开启）", async () => {
    render(<SourceAccountsPage />);
    await screen.findByText("B站");
    fireEvent.click(screen.getByRole("button", { name: /全部展开/ }));

    expect(screen.queryByText("登录后同步歌单")).toBeNull();
  });

  it("数据请求使用登录态带「只有启用时才能同步歌单」备注", async () => {
    render(<SourceAccountsPage />);
    await screen.findByText("B站");
    fireEvent.click(screen.getByRole("button", { name: /全部展开/ }));

    expect(screen.getByText(/只有启用时才能同步歌单/)).toBeTruthy();
  });
});

describe("SourceAccountsPage：注册表外的残留账号", () => {
  /** 库里存一个注册表已不再声明的源（模拟换包/包下掉后留下的凭据） */
  function seedOrphanAccount(): void {
    ipcState.store.set(
      SOURCE_AUTH_ACCOUNTS_KEY,
      JSON.stringify({
        netease: {
          cookie: "n-cookie",
          user: { id: "9", nickname: "老用户", avatar: "", vip: false, vipLabel: "" },
          savedAt: "2026-10-24T00:00:00.000Z",
        },
      }),
    );
  }

  it("补一张残留卡：名字是原始 id + 标「音源包已卸载」，登录入口消失但保留退出", async () => {
    seedOrphanAccount();
    render(<SourceAccountsPage />);

    // 注册表只有 bili，netease 只能靠残留卡出现（名字就是原始 id）
    expect(await screen.findByText("netease")).toBeTruthy();
    expect(screen.getByText("音源包已卸载")).toBeTruthy();
    // 残留卡只给展示与退出（包都没了，登录入口一条都不给）
    expect(screen.getByText("退出")).toBeTruthy();
    // 唯一的登录入口属于注册表里的 bili 卡，残留卡不出登录按钮
    expect(screen.getAllByText("导入Cookie")).toHaveLength(1);
  });

  it("注册表还没取到时不误标「已卸载」，改说「未就绪」", async () => {
    seedOrphanAccount();
    registryState.snapshot.ready = false;
    try {
      render(<SourceAccountsPage />);

      expect(await screen.findByText("netease")).toBeTruthy();
      expect(screen.getByText("音源包未就绪")).toBeTruthy();
      expect(screen.queryByText("音源包已卸载")).toBeNull();
    } finally {
      registryState.snapshot.ready = true;
    }
  });
});
