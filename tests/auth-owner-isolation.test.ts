// C01 回归：换号时收藏同步必须等「身份可信 + 本地隔离成功」之后才能开始；
// 身份拿不到 / 清库失败时保持原 owner 并暂停同步，否则新账号的 session
// 会把上一账号未确认的本地歌单当成自己的推上去。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/ipc", () => ({
  astralSession: vi.fn(),
  astralLogin: vi.fn(),
  astralMe: vi.fn(),
  astralLogout: vi.fn(async () => undefined),
  getSetting: vi.fn(),
  setSetting: vi.fn(async () => undefined),
  likeClearLocal: vi.fn(async () => 0),
  likeSessionEpoch: vi.fn(async () => 1),
  likeResetSync: vi.fn(async () => undefined),
  likeFlushPending: vi.fn(async () => 0),
  likePull: vi.fn(async () => ({ changes: [], maxSeq: 0 })),
  likePullAll: vi.fn(async () => ({ songs: [], playlists: [], maxSeq: 0 })),
  likeApply: vi.fn(async () => 0),
  likeReconcile: vi.fn(async () => 0),
}));

import * as ipc from "@/services/ipc";
import { LIKE_OWNER_KEY, useAuthStore } from "@/stores/auth";
import type { AuthSession } from "@/types";

const ipcMock = vi.mocked(ipc);

function validSession(): AuthSession {
  return { persistence: "secure", expiresAt: Date.now() + 3_600_000 };
}

/** 多次微任务让 `void syncLikesWithReconcile()` 这类后台链路走到底 */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function settings(owner: string | null) {
  return (key: string): Promise<string | null> =>
    Promise.resolve(key === LIKE_OWNER_KEY ? owner : "1");
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ session: null, profile: null, loading: false, error: null });
  ipcMock.astralSession.mockResolvedValue(null);
  ipcMock.astralLogin.mockResolvedValue(validSession());
  ipcMock.astralMe.mockResolvedValue(null);
  ipcMock.getSetting.mockImplementation(settings("account-A"));
  ipcMock.setSetting.mockResolvedValue(undefined);
  ipcMock.likeClearLocal.mockResolvedValue(0);
  ipcMock.likeResetSync.mockResolvedValue(undefined);
  ipcMock.likeFlushPending.mockResolvedValue(0);
  ipcMock.likePull.mockResolvedValue({ changes: [], maxSeq: 0 });
  ipcMock.likePullAll.mockResolvedValue({ songs: [], playlists: [], maxSeq: 0 });
  ipcMock.likeApply.mockResolvedValue(0);
  ipcMock.likeReconcile.mockResolvedValue(0);
});

describe("C01 换号隔离失败时暂停收藏同步", () => {
  it("登录成功但 /me 拿不到身份：不改归属、不 flush/pull/reconcile", async () => {
    ipcMock.astralMe.mockRejectedValue(new Error("synthetic /me failure"));

    await useAuthStore.getState().login("account-B", "synthetic");
    await drain();

    expect(ipcMock.astralLogin).toHaveBeenCalled();
    expect(ipcMock.likeClearLocal).not.toHaveBeenCalled();
    expect(
      ipcMock.setSetting.mock.calls.filter(
        ([key, value]) => key === LIKE_OWNER_KEY && value === "account-B",
      ),
    ).toEqual([]);
    expect(ipcMock.likeFlushPending).not.toHaveBeenCalled();
    expect(ipcMock.likePull).not.toHaveBeenCalled();
    expect(ipcMock.likeReconcile).not.toHaveBeenCalled();
  });

  it("/me 已确认 B 但 owner 延迟读取失败：保留 A 数据并暂停同步，读取恢复后才换归属", async () => {
    const local = {
      owner: "account-A",
      data: ["A-song", "A-playlist"],
      pending: ["A-pending-change"],
    };
    const effects: string[] = [];
    let rejectOwner!: (error: Error) => void;
    const ownerLookup = new Promise<string | null>((_resolve, reject) => {
      rejectOwner = reject;
    });
    ipcMock.astralMe.mockResolvedValue({ id: "account-B" });
    ipcMock.getSetting.mockImplementation((key) =>
      key === LIKE_OWNER_KEY ? ownerLookup : Promise.resolve("1"),
    );
    ipcMock.setSetting.mockImplementation(async (key, value) => {
      if (key === LIKE_OWNER_KEY) {
        effects.push(`owner:${value}`);
        local.owner = value;
      }
    });
    ipcMock.likeClearLocal.mockImplementation(async () => {
      effects.push(`clear:${local.owner}`);
      local.data.length = 0;
      local.pending.length = 0;
      return 2;
    });
    ipcMock.likeFlushPending.mockImplementation(async () => {
      effects.push(`flush:${local.owner}`);
      const count = local.pending.length;
      local.pending.length = 0;
      return count;
    });

    const login = useAuthStore.getState().login("account-B", "synthetic");
    await drain();
    expect(useAuthStore.getState().profile).toEqual({ id: "account-B" });
    expect(ipcMock.getSetting).toHaveBeenCalledWith(LIKE_OWNER_KEY);
    expect(effects).toEqual([]);

    rejectOwner(new Error("synthetic deferred owner lookup failure"));
    await login;
    await drain();

    expect(local.owner).toBe("account-A");
    expect(local.data).toEqual(["A-song", "A-playlist"]);
    expect(local.pending).toEqual(["A-pending-change"]);
    expect(ipcMock.likeClearLocal).not.toHaveBeenCalled();
    expect(ipcMock.setSetting.mock.calls.filter(([key]) => key === LIKE_OWNER_KEY)).toEqual([]);
    expect(ipcMock.likeFlushPending).not.toHaveBeenCalled();
    expect(ipcMock.likePull).not.toHaveBeenCalled();
    expect(ipcMock.likePullAll).not.toHaveBeenCalled();
    expect(ipcMock.likeApply).not.toHaveBeenCalled();
    expect(ipcMock.likeReconcile).not.toHaveBeenCalled();

    ipcMock.getSetting.mockImplementation((key) =>
      Promise.resolve(key === LIKE_OWNER_KEY ? local.owner : "1"),
    );
    await useAuthStore.getState().login("account-B", "synthetic");
    await drain();

    expect(effects.slice(0, 2)).toEqual(["clear:account-A", "owner:account-B"]);
    expect(ipcMock.likeClearLocal).toHaveBeenCalledWith(1);
    expect(ipcMock.setSetting).toHaveBeenCalledWith(LIKE_OWNER_KEY, "account-B", 1);
    expect(local.owner).toBe("account-B");
    expect(local.data).toEqual([]);
    expect(local.pending).toEqual([]);
    expect(ipcMock.likeFlushPending).toHaveBeenCalled();
    expect(ipcMock.likePull).toHaveBeenCalled();
    expect(ipcMock.likeReconcile).toHaveBeenCalled();
  });

  it("合法 owner=null 的首次登录：不清库，记录 B 归属并启动同步", async () => {
    ipcMock.astralMe.mockResolvedValue({ id: "account-B" });
    ipcMock.getSetting.mockImplementation(settings(null));

    await useAuthStore.getState().login("account-B", "synthetic");
    await drain();

    expect(useAuthStore.getState().profile).toEqual({ id: "account-B" });
    expect(ipcMock.getSetting).toHaveBeenCalledWith(LIKE_OWNER_KEY);
    expect(ipcMock.likeClearLocal).not.toHaveBeenCalled();
    expect(ipcMock.setSetting).toHaveBeenCalledWith(LIKE_OWNER_KEY, "account-B", 1);
    expect(ipcMock.likeFlushPending).toHaveBeenCalled();
    expect(ipcMock.likePull).toHaveBeenCalled();
    expect(ipcMock.likeReconcile).toHaveBeenCalled();
  });

  it("清理 A 的本地数据失败：保持 owner=account-A、不启动同步", async () => {
    ipcMock.astralMe.mockResolvedValue({ id: "account-B" });
    ipcMock.likeClearLocal.mockRejectedValue(new Error("synthetic sqlite failure"));

    await useAuthStore.getState().login("account-B", "synthetic");
    await drain();

    expect(ipcMock.likeClearLocal).toHaveBeenCalled();
    expect(
      ipcMock.setSetting.mock.calls.filter(
        ([key, value]) => key === LIKE_OWNER_KEY && value === "account-B",
      ),
    ).toEqual([]);
    expect(ipcMock.likeFlushPending).not.toHaveBeenCalled();
    expect(ipcMock.likePull).not.toHaveBeenCalled();
    expect(ipcMock.likeReconcile).not.toHaveBeenCalled();
  });

  it("切号时上一账号在途的同步不会继续 pull/reconcile", async () => {
    let resolveStale!: (n: number) => void;
    const staleFlush = new Promise<number>((resolve) => {
      resolveStale = resolve;
    });
    ipcMock.astralSession.mockResolvedValue(validSession());
    ipcMock.astralMe.mockResolvedValue({ id: "account-A" });
    // init 的同步卡在 flush 上，模拟「旧账号同步还在途中」
    ipcMock.likeFlushPending.mockReturnValueOnce(staleFlush);

    await useAuthStore.getState().init();
    await drain();
    expect(ipcMock.likeFlushPending).toHaveBeenCalledTimes(1);

    await useAuthStore.getState().logout();
    ipcMock.astralMe.mockResolvedValue({ id: "account-B" });
    await useAuthStore.getState().login("account-B", "synthetic");
    await drain();

    // B 自己的一次同步（flush → pull → reconcile）
    expect(ipcMock.likeFlushPending).toHaveBeenCalledTimes(3);
    expect(ipcMock.likePull).toHaveBeenCalledTimes(1);
    expect(ipcMock.likeReconcile).toHaveBeenCalledTimes(1);

    // 旧同步的 flush 现在才返回：必须凭代次收手，不能再拉/对账一次
    resolveStale(0);
    await drain();
    expect(ipcMock.likePull).toHaveBeenCalledTimes(1);
    expect(ipcMock.likeReconcile).toHaveBeenCalledTimes(1);
  });
});
