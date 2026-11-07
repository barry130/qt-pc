// C01 内层长链路回归：分页 / apply / 游标写入之间也要核对同步代次。
// 只在外层阶段之间核对是不够的 —— 旧账号已经发出的分页请求在换号后才返回时，
// 仍会把旧数据 apply 进新账号的本地库。
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
import { LIKE_OWNER_KEY, pullLikes, useAuthStore } from "@/stores/auth";
import { useFavoritesStore } from "@/stores/favorites";
import type { AuthSession } from "@/types";

const ipcMock = vi.mocked(ipc);

function validSession(): AuthSession {
  return { persistence: "secure", expiresAt: Date.now() + 3_600_000 };
}

/** 多次微任务让 `void syncLikesWithReconcile()` 这类后台链路走到底 */
async function drain(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

function seqWrites(): unknown[][] {
  return ipcMock.setSetting.mock.calls.filter(([key]) => key === "like.sync.seq");
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ session: null, profile: null, loading: false, error: null });
  useFavoritesStore.setState({ version: 0 });
  ipcMock.astralSession.mockResolvedValue(null);
  ipcMock.astralLogin.mockResolvedValue(validSession());
  ipcMock.astralMe.mockResolvedValue(null);
  ipcMock.getSetting.mockImplementation((key: string) =>
    Promise.resolve(key === LIKE_OWNER_KEY ? "account-A" : "1"),
  );
  ipcMock.setSetting.mockResolvedValue(undefined);
  ipcMock.likeClearLocal.mockResolvedValue(0);
  ipcMock.likeResetSync.mockResolvedValue(undefined);
  ipcMock.likeFlushPending.mockResolvedValue(0);
  ipcMock.likePull.mockResolvedValue({ changes: [], maxSeq: 0 });
  ipcMock.likePullAll.mockResolvedValue({ songs: [], playlists: [], maxSeq: 0 });
  ipcMock.likeApply.mockResolvedValue(0);
  ipcMock.likeReconcile.mockResolvedValue(0);
});

describe("C01 内层长链路：换号后旧分页不得落库", () => {
  it("增量 pull 在途时换号：旧 changes 不 apply、不写游标", async () => {
    let resolveStale!: (v: { changes: unknown[]; maxSeq: number }) => void;
    const stalePull = new Promise<{ changes: unknown[]; maxSeq: number }>((resolve) => {
      resolveStale = resolve;
    });
    ipcMock.astralSession.mockResolvedValue(validSession());
    ipcMock.astralMe.mockResolvedValue({ id: "account-A" });
    ipcMock.likePull.mockReturnValueOnce(stalePull as Promise<ipc.LikePullResult>);

    await useAuthStore.getState().init();
    await drain();
    expect(ipcMock.likePull).toHaveBeenCalledTimes(1);

    // 旧账号的 pull 还挂在网络上时换号：B 的同步完整跑一遍
    await useAuthStore.getState().logout();
    ipcMock.astralMe.mockResolvedValue({ id: "account-B" });
    await useAuthStore.getState().login("account-B", "synthetic");
    await drain();
    expect(ipcMock.likePull).toHaveBeenCalledTimes(2);
    expect(ipcMock.likeApply).not.toHaveBeenCalled();
    expect(seqWrites()).toHaveLength(1); // 只来自 B 的同步

    // 旧请求现在才回来：带着 A 的私藏变更
    resolveStale({
      changes: [{ type: "song", sid: "private-song-A", name: "A 的私藏" }],
      maxSeq: 5,
    });
    await drain();

    expect(ipcMock.likeApply).not.toHaveBeenCalled();
    expect(seqWrites()).toHaveLength(1); // 旧链路没有补写游标
    expect(ipcMock.likePull).toHaveBeenCalledTimes(2);
  });

  it("全量导入第一页在途时换号：不 apply、不继续翻页、不写游标", async () => {
    let resolveStalePage!: (v: {
      songs: unknown[];
      playlists: unknown[];
      maxSeq: number;
    }) => void;
    const stalePage = new Promise<{
      songs: unknown[];
      playlists: unknown[];
      maxSeq: number;
    }>((resolve) => {
      resolveStalePage = resolve;
    });
    ipcMock.astralSession.mockResolvedValue(validSession());
    ipcMock.astralMe.mockResolvedValue({ id: "account-A" });
    // 模拟「从没做过全量」：第一次必须走 likePullAll 分页
    ipcMock.getSetting.mockImplementation((key: string) =>
      Promise.resolve(key === LIKE_OWNER_KEY ? "account-A" : key === "like.imported" ? null : "1"),
    );
    ipcMock.likePullAll.mockReturnValueOnce(stalePage);

    await useAuthStore.getState().init();
    await drain();
    expect(ipcMock.likePullAll).toHaveBeenCalledTimes(1);

    await useAuthStore.getState().logout();
    ipcMock.astralMe.mockResolvedValue({ id: "account-B" });
    await useAuthStore.getState().login("account-B", "synthetic");
    await drain();
    // B 自己的全量导入：空页一次收尾
    const callsBeforeStale = ipcMock.likePullAll.mock.calls.length;
    expect(callsBeforeStale).toBe(2);
    expect(ipcMock.likeApply).not.toHaveBeenCalled();

    resolveStalePage({ songs: [{ sid: "private-song-A" }], playlists: [], maxSeq: 7 });
    await drain();

    expect(ipcMock.likeApply).not.toHaveBeenCalled();
    expect(seqWrites()).toHaveLength(0);
    // 旧链路没有翻第二页
    expect(ipcMock.likePullAll).toHaveBeenCalledTimes(callsBeforeStale);
  });

  it("未可信时独立 pullLikes() 一个云端请求都不发", async () => {
    // 上一用例结束时处于已登录可信态：先登出回到「身份未确认」
    await useAuthStore.getState().logout();
    await drain();
    ipcMock.getSetting.mockClear();
    ipcMock.likePull.mockClear();
    ipcMock.likePullAll.mockClear();
    ipcMock.likeApply.mockClear();
    ipcMock.setSetting.mockClear();

    await pullLikes();
    await drain();

    // 独立拉取同样是云同步：未可信时连读设置都不该发生
    expect(ipcMock.getSetting).not.toHaveBeenCalled();
    expect(ipcMock.likePull).not.toHaveBeenCalled();
    expect(ipcMock.likePullAll).not.toHaveBeenCalled();
    expect(ipcMock.likeApply).not.toHaveBeenCalled();
    expect(ipcMock.setSetting).not.toHaveBeenCalled();
    // 离线本地收藏列表不依赖云端 pull：不抛错、也不触发界面版本刷新
    expect(useFavoritesStore.getState().version).toBe(0);
  });

  it("可信登录后独立 pullLikes() 照常拉云端", async () => {
    ipcMock.astralMe.mockResolvedValue({ id: "account-A" });
    ipcMock.getSetting.mockImplementation((key: string) =>
      Promise.resolve(key === LIKE_OWNER_KEY ? "account-A" : "1"),
    );
    await useAuthStore.getState().login("account-A", "synthetic");
    await drain();
    ipcMock.likePull.mockClear();
    ipcMock.likeApply.mockClear();
    ipcMock.setSetting.mockClear();
    ipcMock.likePull
      .mockResolvedValueOnce({
        changes: [
          {
            type: "song",
            id: "s1",
            platform: "qq",
            name: "收藏",
            singer: "",
            album: "",
            hash: "",
            picUrl: "",
            deleted: false,
            updatedSeq: 3,
          },
        ],
        maxSeq: 3,
      })
      .mockResolvedValue({ changes: [], maxSeq: 3 });

    await pullLikes();

    expect(ipcMock.likeApply).toHaveBeenCalledTimes(1);
    expect(seqWrites()).toHaveLength(1);
  });
});
