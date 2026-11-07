// 登录态生命周期的代次回归（task-9）：
//
// 每个 action 里都有多个 await（读会话 / 取宿主 epoch / 确认身份 / 改资料 / 登出）。
// 用户可以在任意两个 await 之间重新登录，于是「旧链路晚到的结果」必须整条作废：
// 不能覆盖新账号的 session/profile、不能把旧错误写进新会话、不能在新身份下发
// 登出/清库请求，也不能清掉新账号的本地会话。
//
// 这里的断言只看 public store + mock IPC（Rust 侧的 session_epoch 由 Lead/security
// 负责），重点覆盖「不是只在 final profile 之后检查」的每个中间等待点。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/ipc", () => ({
  astralSession: vi.fn(async () => null),
  astralLogin: vi.fn(),
  astralRegister: vi.fn(),
  astralMe: vi.fn(async () => ({ id: "account-1", nickname: "轻听用户" })),
  astralLogout: vi.fn(async () => {}),
  astralUpdateProfile: vi.fn(async () => ({})),
  getSetting: vi.fn(async () => "1"),
  setSetting: vi.fn(async () => {}),
  likeClearLocal: vi.fn(async () => 0),
  likeSessionEpoch: vi.fn(async () => 7),
  likeResetSync: vi.fn(async () => {}),
  likePull: vi.fn(async () => ({ changes: [], maxSeq: 0 })),
  likePullAll: vi.fn(async () => ({ songs: [], playlists: [], maxSeq: 0 })),
  likeApply: vi.fn(async () => {}),
  likeFlushPending: vi.fn(async () => 0),
  likeReconcile: vi.fn(async () => 0),
  writeLog: vi.fn(async () => {}),
}));

import * as ipc from "@/services/ipc";
import { useAuthStore } from "@/stores/auth";
import type { AuthSession } from "@/types";

const ipcMock = vi.mocked(ipc);

/** 可手动放行的 Promise：模拟「旧链路还在半路上」 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让 fire-and-forget 的收藏同步链路跑完（全部 mock 都是立即 resolve 的微任务） */
async function drain(times = 100): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function validSession(): AuthSession {
  return { persistence: "secure", expiresAt: Date.now() + 3_600_000 };
}

async function loginAs(id: string): Promise<void> {
  ipcMock.astralLogin.mockResolvedValue(validSession());
  ipcMock.astralMe.mockResolvedValue({ id, nickname: id });
  await useAuthStore.getState().login(id, "pw");
  await drain();
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ session: null, profile: null, loading: false, error: null });
  ipcMock.astralSession.mockResolvedValue(null);
  ipcMock.astralMe.mockResolvedValue({ id: "account-1", nickname: "轻听用户" });
  ipcMock.likeSessionEpoch.mockResolvedValue(7);
  ipcMock.getSetting.mockResolvedValue("1");
});

describe("init 与后发登录的竞态", () => {
  it("旧的 init 晚到读会话，不得覆盖新登录的 B", async () => {
    const late = deferred<AuthSession | null>();
    ipcMock.astralSession.mockReturnValueOnce(late.promise);

    const initPromise = useAuthStore.getState().init();
    await drain();
    await loginAs("account-B");

    late.resolve(validSession());
    await initPromise;

    expect(useAuthStore.getState().session).not.toBeNull();
    expect(useAuthStore.getState().profile?.id).toBe("account-B");
    expect(ipcMock.astralLogout).not.toHaveBeenCalled();
  });

  it("旧的 init 晚到读到空会话，不得清掉新登录的 B", async () => {
    const late = deferred<AuthSession | null>();
    ipcMock.astralSession.mockReturnValueOnce(late.promise);

    const initPromise = useAuthStore.getState().init();
    await drain();
    await loginAs("account-B");

    late.resolve(null);
    await initPromise;

    expect(useAuthStore.getState().session).not.toBeNull();
    expect(useAuthStore.getState().profile?.id).toBe("account-B");
  });

  it("旧的 init 身份确认失败（离线），不得清掉新会话的 profile / 写 error", async () => {
    ipcMock.astralSession.mockResolvedValueOnce(validSession());
    const lateMe = deferred<Record<string, unknown> | null>();
    ipcMock.astralMe.mockReturnValueOnce(lateMe.promise);

    const initPromise = useAuthStore.getState().init();
    await drain();
    await loginAs("account-B");

    lateMe.reject(new Error("network down"));
    await initPromise;

    expect(useAuthStore.getState().profile?.id).toBe("account-B");
    expect(useAuthStore.getState().error).toBeNull();
  });
});

describe("login / register 的晚到结果", () => {
  it("旧 login 晚到的失败，不得把错误写进新会话", async () => {
    const stale = deferred<AuthSession>();
    ipcMock.astralLogin.mockReturnValueOnce(stale.promise);

    const staleLogin = useAuthStore.getState().login("account-A", "pw");
    await drain();
    await loginAs("account-B");

    stale.reject(new Error("旧账号密码错误"));
    await expect(staleLogin).resolves.toBeUndefined();

    expect(useAuthStore.getState().error).toBeNull();
    expect(useAuthStore.getState().loading).toBe(false);
    expect(useAuthStore.getState().profile?.id).toBe("account-B");
  });

  it("旧 register 晚到的失败，不得把 loading / error 写进新会话", async () => {
    const stale = deferred<AuthSession>();
    ipcMock.astralRegister.mockReturnValueOnce(stale.promise);

    const staleRegister = useAuthStore
      .getState()
      .register("account-A", "pw", "pw", undefined, undefined);
    await drain();
    await loginAs("account-B");

    stale.reject(new Error("用户名已被占用"));
    await expect(staleRegister).resolves.toBeUndefined();

    expect(useAuthStore.getState().error).toBeNull();
    expect(useAuthStore.getState().loading).toBe(false);
    expect(useAuthStore.getState().profile?.id).toBe("account-B");
  });

  it("login 用同一宿主 epoch 确认身份", async () => {
    await loginAs("account-B");
    expect(ipcMock.astralMe).toHaveBeenCalledWith(7);
  });

  it("init 恢复会话也用宿主 epoch 确认身份", async () => {
    ipcMock.astralSession.mockResolvedValue(validSession());
    await useAuthStore.getState().init();
    await drain();
    expect(ipcMock.astralMe).toHaveBeenCalledWith(7);
  });

  it("login 取不到 epoch：会话落地但 profile 留空，且不云同步", async () => {
    ipcMock.likeSessionEpoch.mockRejectedValueOnce(new Error("epoch down"));
    ipcMock.astralLogin.mockResolvedValue(validSession());

    await useAuthStore.getState().login("account-B", "pw");
    await drain();

    expect(useAuthStore.getState().session).not.toBeNull();
    expect(useAuthStore.getState().profile).toBeNull();
    expect(useAuthStore.getState().loading).toBe(false);
    expect(ipcMock.astralMe).not.toHaveBeenCalled();
    expect(ipcMock.likeFlushPending).not.toHaveBeenCalled();
    expect(ipcMock.likePull).not.toHaveBeenCalled();
  });

  it("init 取不到 epoch：保留本地会话，但不确认身份、不云同步", async () => {
    ipcMock.astralSession.mockResolvedValue(validSession());
    ipcMock.likeSessionEpoch.mockRejectedValueOnce(new Error("epoch down"));

    await useAuthStore.getState().init();
    await drain();

    expect(useAuthStore.getState().session).not.toBeNull();
    expect(useAuthStore.getState().profile).toBeNull();
    expect(ipcMock.astralMe).not.toHaveBeenCalled();
    expect(ipcMock.likeFlushPending).not.toHaveBeenCalled();
  });
});

describe("logout 的代次与 epoch", () => {
  it("logout 把 epoch 传给补推 / 重置 / 登出，且重置在登出之前", async () => {
    await loginAs("account-B");
    ipcMock.likeFlushPending.mockClear();
    ipcMock.likeResetSync.mockClear();
    ipcMock.astralLogout.mockClear();

    await useAuthStore.getState().logout();

    expect(ipcMock.likeFlushPending).toHaveBeenCalledWith(7);
    expect(ipcMock.likeResetSync).toHaveBeenCalledWith(7);
    expect(ipcMock.astralLogout).toHaveBeenCalledWith(7);
    expect(ipcMock.likeResetSync.mock.invocationCallOrder[0]).toBeLessThan(
      ipcMock.astralLogout.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(useAuthStore.getState().session).toBeNull();
  });

  it("logout 补推在途时重新登录：旧 logout 不得登出 / 重置 / 清新会话", async () => {
    await loginAs("account-B");
    const flush = deferred<number>();
    ipcMock.likeFlushPending.mockReturnValueOnce(flush.promise);
    ipcMock.likeResetSync.mockClear();
    ipcMock.astralLogout.mockClear();

    const staleLogout = useAuthStore.getState().logout();
    await drain();
    await loginAs("account-C");

    flush.resolve(0);
    await staleLogout;

    expect(ipcMock.likeResetSync).not.toHaveBeenCalled();
    expect(ipcMock.astralLogout).not.toHaveBeenCalled();
    expect(useAuthStore.getState().session).not.toBeNull();
    expect(useAuthStore.getState().profile?.id).toBe("account-C");
  });

  it("logout 的 astralLogout 晚到时重新登录：不得清新会话", async () => {
    await loginAs("account-B");
    const logoutAck = deferred<void>();
    ipcMock.astralLogout.mockReturnValueOnce(logoutAck.promise);

    const staleLogout = useAuthStore.getState().logout();
    await drain();
    await loginAs("account-C");

    logoutAck.resolve();
    await staleLogout;

    expect(useAuthStore.getState().session).not.toBeNull();
    expect(useAuthStore.getState().profile?.id).toBe("account-C");
  });
});

describe("updateProfile 的代次与 epoch", () => {
  const patch = { nickname: "新昵称", email: "a@b.c", avatar: "" };

  it("固定 epoch 调 astral_update_profile", async () => {
    await loginAs("account-B");
    ipcMock.astralUpdateProfile.mockClear();

    await useAuthStore.getState().updateProfile(patch);

    expect(ipcMock.astralUpdateProfile).toHaveBeenCalledWith(patch, 7);
  });

  it("改资料成功晚到时重新登录：旧结果不得 kickout / 清新会话", async () => {
    await loginAs("account-B");
    const late = deferred<unknown>();
    ipcMock.astralUpdateProfile.mockReturnValueOnce(late.promise);

    const staleUpdate = useAuthStore.getState().updateProfile(patch);
    await drain();
    await loginAs("account-C");

    ipcMock.astralLogout.mockClear();
    ipcMock.likeResetSync.mockClear();
    late.resolve({});
    await staleUpdate;

    expect(ipcMock.astralLogout).not.toHaveBeenCalled();
    expect(ipcMock.likeResetSync).not.toHaveBeenCalled();
    expect(useAuthStore.getState().session).not.toBeNull();
    expect(useAuthStore.getState().profile?.id).toBe("account-C");
  });

  it("改资料失败晚到时重新登录：旧错误不得写进新会话", async () => {
    await loginAs("account-B");
    const late = deferred<unknown>();
    ipcMock.astralUpdateProfile.mockReturnValueOnce(late.promise);

    const staleUpdate = useAuthStore.getState().updateProfile(patch);
    await drain();
    await loginAs("account-C");

    late.reject(new Error("邮箱格式不对"));
    await expect(staleUpdate).resolves.toBeUndefined();

    expect(useAuthStore.getState().error).toBeNull();
    expect(useAuthStore.getState().loading).toBe(false);
    expect(useAuthStore.getState().profile?.id).toBe("account-C");
  });
});

describe("logout 取不到宿主 epoch 的 fail-closed（task-10）", () => {
  it("保留当前会话，不派发补推 / 重置 / 登出，给可重试错误", async () => {
    await loginAs("account-A");
    ipcMock.likeSessionEpoch.mockRejectedValueOnce(new Error("epoch down"));
    ipcMock.likeFlushPending.mockClear();
    ipcMock.likeResetSync.mockClear();
    ipcMock.astralLogout.mockClear();

    await useAuthStore.getState().logout();
    await drain();

    expect(ipcMock.likeFlushPending).not.toHaveBeenCalled();
    expect(ipcMock.likeResetSync).not.toHaveBeenCalled();
    expect(ipcMock.astralLogout).not.toHaveBeenCalled();
    expect(useAuthStore.getState().session).not.toBeNull();
    expect(useAuthStore.getState().profile?.id).toBe("account-A");
    expect(useAuthStore.getState().loading).toBe(false);
    expect(useAuthStore.getState().error).toContain("无法确认登录会话代次");
  });

  it("epoch 查询在途时已登录 B：旧失败不得把错误写进 B，也不得清 B", async () => {
    await loginAs("account-A");
    const epochQuery = deferred<number>();
    ipcMock.likeSessionEpoch.mockReturnValueOnce(epochQuery.promise);
    ipcMock.likeResetSync.mockClear();
    ipcMock.astralLogout.mockClear();

    const staleLogout = useAuthStore.getState().logout();
    await drain();
    await loginAs("account-B");

    epochQuery.reject(new Error("epoch down"));
    await staleLogout;
    await drain();

    expect(ipcMock.likeResetSync).not.toHaveBeenCalled();
    expect(ipcMock.astralLogout).not.toHaveBeenCalled();
    expect(useAuthStore.getState().session).not.toBeNull();
    expect(useAuthStore.getState().profile?.id).toBe("account-B");
    expect(useAuthStore.getState().error).toBeNull();
    expect(useAuthStore.getState().loading).toBe(false);
  });

  it("epoch 恢复后可以重试退出，并按原会话 epoch 绑定派发", async () => {
    await loginAs("account-A");
    ipcMock.likeSessionEpoch.mockRejectedValueOnce(new Error("epoch down"));
    await useAuthStore.getState().logout();
    await drain();
    expect(useAuthStore.getState().session).not.toBeNull();

    ipcMock.likeFlushPending.mockClear();
    ipcMock.likeResetSync.mockClear();
    ipcMock.astralLogout.mockClear();
    await useAuthStore.getState().logout();
    await drain();

    expect(ipcMock.likeFlushPending).toHaveBeenCalledWith(7);
    expect(ipcMock.likeResetSync).toHaveBeenCalledWith(7);
    expect(ipcMock.astralLogout).toHaveBeenCalledWith(7);
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().error).toBeNull();
  });
});
