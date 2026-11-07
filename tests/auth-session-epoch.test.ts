// C01 宿主会话 epoch + C13 封面字段语义回归。
//
// 一条收藏同步链路只取一次宿主 epoch，之后每个收藏 IPC（flush / pull / pullAll /
// apply / reconcile / 游标与归属写入）都带上它：宿主据此丢弃换号前发出的迟到请求。
// 宿主拒绝时：前端代次已经变了就静默收手；代次没变才按普通失败写 lastError。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/ipc", () => ({
  astralSession: vi.fn(),
  astralLogin: vi.fn(),
  astralMe: vi.fn(),
  astralLogout: vi.fn(async () => undefined),
  getSetting: vi.fn(),
  setSetting: vi.fn(async () => undefined),
  likeSessionEpoch: vi.fn(async () => 7),
  likeClearLocal: vi.fn(async () => 0),
  likeResetSync: vi.fn(async () => undefined),
  likeFlushPending: vi.fn(async () => 0),
  likePull: vi.fn(async () => ({ changes: [], maxSeq: 0 })),
  likePullAll: vi.fn(async () => ({ songs: [], playlists: [], maxSeq: 0 })),
  likeApply: vi.fn(async () => 0),
  likeReconcile: vi.fn(async () => 0),
}));

import * as ipc from "@/services/ipc";
import { LIKE_OWNER_KEY, pullLikes, useAuthStore } from "@/stores/auth";
import { useFavoritesStore } from "@/stores/favorites";
import type { AuthSession } from "@/types";

const ipcMock = vi.mocked(ipc);

function validSession(): AuthSession {
  return { persistence: "secure", expiresAt: Date.now() + 3_600_000 };
}

/** 多次微任务让 `void syncLikesWithReconcile()` 这类后台链路走到底 */
async function drain(): Promise<void> {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

function lastErrorWrites(): string[] {
  return ipcMock.setSetting.mock.calls
    .filter(([key]) => key === "like.lastError")
    .map(([, value]) => String(value));
}

async function loginAs(id: string): Promise<void> {
  ipcMock.astralMe.mockResolvedValue({ id });
  await useAuthStore.getState().login("tester", "pw");
  await drain();
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ session: null, profile: null, loading: false, error: null });
  useFavoritesStore.setState({ version: 0 });
  ipcMock.astralSession.mockResolvedValue(null);
  ipcMock.astralLogin.mockResolvedValue(validSession());
  ipcMock.astralMe.mockResolvedValue(null);
  ipcMock.getSetting.mockImplementation((key: string) => {
    if (key === LIKE_OWNER_KEY) return Promise.resolve("account-A");
    if (key === "like.sync.seq") return Promise.resolve("0");
    return Promise.resolve("1");
  });
  ipcMock.setSetting.mockResolvedValue(undefined);
  ipcMock.likeSessionEpoch.mockResolvedValue(7);
  ipcMock.likeClearLocal.mockResolvedValue(0);
  ipcMock.likeFlushPending.mockResolvedValue(0);
  ipcMock.likePull.mockResolvedValue({ changes: [], maxSeq: 0 });
  ipcMock.likePullAll.mockResolvedValue({ songs: [], playlists: [], maxSeq: 0 });
  ipcMock.likeApply.mockResolvedValue(0);
  ipcMock.likeReconcile.mockResolvedValue(0);
});

describe("C01 宿主会话 epoch", () => {
  it("一次同步链只取一次 epoch，每个收藏 IPC 都带上同一个值", async () => {
    await loginAs("account-A");

    // 登录阶段取一次，整条同步链复用 7，不逐请求重取
    expect(ipcMock.likeSessionEpoch).toHaveBeenCalledTimes(1);
    expect(ipcMock.likeFlushPending).toHaveBeenCalledWith(7);
    expect(ipcMock.likePull).toHaveBeenCalledWith(0, 7);
    expect(ipcMock.likeReconcile).toHaveBeenCalledWith(7);
  });

  it("全量导入的分页 / apply / 游标写入同样带 epoch", async () => {
    ipcMock.getSetting.mockImplementation((key: string) =>
      Promise.resolve(key === LIKE_OWNER_KEY ? "account-A" : key === "like.imported" ? "0" : "1"),
    );
    ipcMock.likePullAll.mockResolvedValueOnce({
      songs: [{ sid: "s1", platform: "qq", name: "歌", singer: "s", album: "", hash: "" }],
      playlists: [{ pid: "p1", platform: "qq", name: "歌单" }],
      maxSeq: 5,
    });

    await loginAs("account-A");

    expect(ipcMock.likePullAll).toHaveBeenCalledWith(1, 200, 7);
    const applies = ipcMock.likeApply.mock.calls;
    // 先歌单后歌曲，两次 apply 都带 epoch
    expect(applies.length).toBe(2);
    expect(applies[0]?.[1]).toBe(7);
    expect(applies[1]?.[1]).toBe(7);
    expect(ipcMock.setSetting).toHaveBeenCalledWith("like.imported", "1", 7);
    expect(ipcMock.setSetting).toHaveBeenCalledWith("like.sync.seq", "5", 7);
  });

  it("独立 pullLikes() 也现场捕获一次可信 epoch", async () => {
    await loginAs("account-A");
    ipcMock.likePull.mockClear();
    ipcMock.likeSessionEpoch.mockClear();

    await pullLikes();

    expect(ipcMock.likeSessionEpoch).toHaveBeenCalledTimes(1);
    expect(ipcMock.likePull).toHaveBeenCalledWith(0, 7);
  });

  it("宿主 epoch 查询失败：fail-closed，本轮不云同步 / 不写 owner / 不写游标", async () => {
    ipcMock.likeSessionEpoch.mockRejectedValue(new Error("command not found"));

    await loginAs("account-A");

    // 不启动同步链：flush / pull / pullAll / apply / reconcile 一个都不发
    expect(ipcMock.likeFlushPending).not.toHaveBeenCalled();
    expect(ipcMock.likePull).not.toHaveBeenCalled();
    expect(ipcMock.likePullAll).not.toHaveBeenCalled();
    expect(ipcMock.likeApply).not.toHaveBeenCalled();
    expect(ipcMock.likeReconcile).not.toHaveBeenCalled();
    // 归属检查也不做：不清本地库、不写 owner（保持原归属）
    expect(ipcMock.likeClearLocal).not.toHaveBeenCalled();
    expect(ipcMock.setSetting.mock.calls.filter(([key]) => key === LIKE_OWNER_KEY)).toEqual([]);
    // 游标 / 全量导入标记同样一个都不写
    expect(
      ipcMock.setSetting.mock.calls.filter(
        ([key]) => key === "like.sync.seq" || key === "like.imported",
      ),
    ).toEqual([]);
    // 但要给当前代次留一条可排查的线索
    expect(lastErrorWrites().some((msg) => msg.includes("无法确认登录会话代次"))).toBe(true);
  });

  it("可信登录后独立 pullLikes() 取不到 epoch：同样 fail-closed，不拉云端", async () => {
    await loginAs("account-A");
    ipcMock.likePull.mockClear();
    ipcMock.setSetting.mockClear();
    ipcMock.likeSessionEpoch.mockRejectedValue(new Error("command not found"));

    await pullLikes();

    expect(ipcMock.likePull).not.toHaveBeenCalled();
    expect(ipcMock.setSetting.mock.calls.filter(([key]) => key === "like.sync.seq")).toEqual([]);
    expect(lastErrorWrites().some((msg) => msg.includes("无法确认登录会话代次"))).toBe(true);
  });

  it("宿主拒绝但本地代次没变：按普通失败写 lastError，不继续推进", async () => {
    await loginAs("account-A");
    ipcMock.likePull.mockClear();
    ipcMock.likeReconcile.mockClear();
    ipcMock.setSetting.mockClear();

    ipcMock.likePull.mockRejectedValue(new Error("登录会话已变化，请重新同步"));
    await loginAs("account-A");

    expect(ipcMock.likeReconcile).not.toHaveBeenCalled();
    expect(lastErrorWrites().some((msg) => msg.includes("登录会话已变化"))).toBe(true);
  });

  it("宿主拒绝但本地已经换号：安静退出，不把旧会话错误写进新会话", async () => {
    let rejectStale!: (err: unknown) => void;
    ipcMock.likePull.mockReturnValueOnce(
      new Promise<ipc.LikePullResult>((_resolve, reject) => {
        rejectStale = reject;
      }),
    );
    ipcMock.astralSession.mockResolvedValue(validSession());
    ipcMock.astralMe.mockResolvedValue({ id: "account-A" });
    await useAuthStore.getState().init();
    await drain();

    await useAuthStore.getState().logout();
    await loginAs("account-B");
    ipcMock.setSetting.mockClear();

    rejectStale(new Error("登录会话已变化，请重新同步"));
    await drain();

    expect(lastErrorWrites()).toEqual([]);
  });
});

describe("C13 全量导入的封面字段", () => {
  it("缺失 / null 封面省略 picUrl（保留原封面），空串才清空", async () => {
    ipcMock.getSetting.mockImplementation((key: string) =>
      Promise.resolve(key === LIKE_OWNER_KEY ? "account-A" : key === "like.imported" ? "0" : "1"),
    );
    ipcMock.likePullAll.mockResolvedValueOnce({
      songs: [{ sid: "s1", platform: "qq", name: "歌", singer: "s", album: "", hash: "", picUrl: null }],
      playlists: [
        { pid: "p1", platform: "qq", name: "没给封面" },
        { pid: "p2", platform: "qq", name: "明确空封面", picUrl: "" },
        { pid: "p3", platform: "qq", name: "有封面", picUrl: "https://cdn.example/p.jpg" },
      ],
      maxSeq: 5,
    });

    await loginAs("account-A");

    const playlistsPayload = ipcMock.likeApply.mock.calls[0]?.[0] as ipc.LikeChange[];
    const byId = new Map(playlistsPayload.map((c) => [c.id, c]));
    expect("picUrl" in (byId.get("p1") as ipc.LikeChange)).toBe(false);
    expect(byId.get("p2")?.picUrl).toBe("");
    expect(byId.get("p3")?.picUrl).toBe("https://cdn.example/p.jpg");

    const songsPayload = ipcMock.likeApply.mock.calls[1]?.[0] as ipc.LikeChange[];
    expect("picUrl" in (songsPayload[0] as ipc.LikeChange)).toBe(false);
  });
});
