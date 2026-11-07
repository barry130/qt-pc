// 同一个 Vite 模块可能先带 ?t= 时间戳加载，再被懒加载页面以原地址加载。
// 两次执行共享 hot.data，却有独立的模块作用域；必须仍然共用账号状态及会话代次。
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import * as zustand from "zustand";
import { beforeEach, describe, expect, it, vi } from "vitest";

type AuthModule = typeof import("@/stores/auth");
type HotData = { data?: Record<string, unknown> };

const source = readFileSync(new URL("../src/stores/auth.ts", import.meta.url), "utf8");
const compiled = transformSync(source, {
  loader: "ts",
  format: "cjs",
  define: { "import.meta.hot": "__hot" },
}).code;

const session = { persistence: "secure" as const, expiresAt: Date.now() + 3_600_000 };
const profile = { id: "account-a", avatar: "https://cdn.example/old.png" };
const ipc = {
  astralSession: vi.fn(async () => session),
  astralLogin: vi.fn(async () => session),
  astralMe: vi.fn(async (): Promise<Record<string, unknown>> => profile),
  astralLogout: vi.fn(async () => {}),
  likeSessionEpoch: vi.fn(async () => 1),
  getSetting: vi.fn(async (key: string) => key === "like.sync.owner" ? "account-a" : "1"),
  setSetting: vi.fn(async () => {}),
  likeClearLocal: vi.fn(async () => {}),
  likeResetSync: vi.fn(async () => {}),
  likeFlushPending: vi.fn(async () => {}),
  likePull: vi.fn(async () => ({ changes: [], maxSeq: 0 })),
  likeReconcile: vi.fn(async () => {}),
};

/** 执行真实 auth 源码两次，保留 Vite 的同一份 hot.data，不复用模块缓存。 */
function loadAuth(hot?: HotData): AuthModule {
  const module = { exports: {} };
  const dependencies: Record<string, unknown> = {
    zustand,
    "@/services/ipc": ipc,
    "@/lib/utils": { errMsg: String },
    "@/lib/logger": { log: { warn: vi.fn(), debug: vi.fn() } },
    "@/stores/favorites": { useFavoritesStore: { getState: () => ({ bump: vi.fn() }) } },
  };
  const requireDependency = (name: string): unknown => {
    if (!(name in dependencies)) throw new Error(`未模拟的模块：${name}`);
    return dependencies[name];
  };
  new Function("require", "module", "exports", "__hot", compiled)(
    requireDependency, module, module.exports, hot,
  );
  return module.exports as AuthModule;
}

beforeEach(() => vi.clearAllMocks());

describe("账号状态在热更新与懒加载之间保持唯一", () => {
  it("旧标题栏的订阅能收到新页面的头像更新", () => {
    const hot = { data: {} };
    const titleBarModule = loadAuth(hot);
    titleBarModule.useAuthStore.setState({ session, profile });
    const onChange = vi.fn();
    const unsubscribe = titleBarModule.useAuthStore.subscribe(onChange);

    const editModule = loadAuth(hot);
    expect(editModule.useAuthStore).toBe(titleBarModule.useAuthStore);
    expect(editModule.useAuthStore.getState().session).toBe(session);
    onChange.mockClear();
    editModule.useAuthStore.getState().setLocalAvatar("https://cdn.example/new.png");

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(titleBarModule.avatarUrl(titleBarModule.useAuthStore.getState().profile))
      .toBe("https://cdn.example/new.png");
    expect(loadAuth(hot).useAuthStore.getState().profile?.avatar)
      .toBe("https://cdn.example/new.png");
    unsubscribe();
  });

  it("热更新前的迟到资料不能覆盖热更新后登录的新账号", async () => {
    const hot = { data: {} };
    const before = loadAuth(hot);
    let finishMe!: (value: Record<string, unknown>) => void;
    ipc.astralMe.mockImplementationOnce(() => new Promise((resolve) => { finishMe = resolve; }));
    const pendingInit = before.useAuthStore.getState().init();
    await vi.waitFor(() => expect(ipc.astralMe).toHaveBeenCalledTimes(1));

    const after = loadAuth(hot);
    ipc.astralMe.mockResolvedValueOnce({ id: "account-b", avatar: "https://cdn.example/b.png" });
    await after.useAuthStore.getState().login("account-b", "test-password");
    finishMe(profile);
    await pendingInit;

    expect(before.useAuthStore.getState().profile?.id).toBe("account-b");
    expect(after.useAuthStore.getState().profile?.id).toBe("account-b");
  });

  it("重复加载模块不会丢失已验证的收藏同步状态", async () => {
    const hot = { data: {} };
    const before = loadAuth(hot);
    await before.useAuthStore.getState().login("account-a", "test-password");
    await vi.waitFor(() => expect(ipc.likeReconcile).toHaveBeenCalledTimes(1));
    ipc.likePull.mockClear();

    const after = loadAuth(hot);
    await after.pullLikes();
    expect(ipc.likePull).toHaveBeenCalledTimes(1);
  });

  it("没有 HMR 时不在全局保存账号状态", () => {
    const first = loadAuth();
    first.useAuthStore.setState({ session, profile });
    const separateWindow = loadAuth();
    expect(separateWindow.useAuthStore).not.toBe(first.useAuthStore);
    expect(separateWindow.useAuthStore.getState().session).toBeNull();
  });

  it("执行器只提供 hot 占位时仍可加载账号模块", () => {
    const auth = loadAuth({});
    auth.useAuthStore.setState({ session, profile });
    auth.useAuthStore.getState().setLocalAvatar("https://cdn.example/new.png");
    expect(auth.avatarUrl(auth.useAuthStore.getState().profile)).toBe("https://cdn.example/new.png");
  });
});
