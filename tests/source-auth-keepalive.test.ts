// 音源账号后台保活（refreshAllSourceAccounts）：核心要守住的是
// 1) 轮换持久化：包侧下发了新 credential 时，新 cookie + 应答随行的
//    refresh_token（并入 extras）一并落库；
// 2) 未轮换跳过不写库、失效（ok:false）跳过且**绝不删账号**——自动退出
//    是用户禁区，凭据失效只能标记引导重登；
// 3) 并发重入去重：进行中再调用复用同一轮 Promise，不并发两轮校验；
// 4) 空账号表直接返回（无账号谈不上保活）。
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  store: new Map<string, string>(),
  sets: [] as { scope: "meta" | "play"; source?: string; cookie?: string }[],
  clears: [] as { scope: "meta" | "play"; source?: string }[],
  checks: [] as { source: string; cookie: string; extras?: Record<string, string> }[],
  /** 每源的下一次 authCheckUser 应答（未设 = 凭据仍有效但未轮换） */
  checkResults: new Map<
    string,
    { ok: boolean; credential: string | null; refreshToken?: string }
  >(),
  /** 并发测试用的闸门：置上后 authCheckUser 挂起直到放行 */
  gate: null as Promise<void> | null,
}));

vi.mock("@/services/ipc", () => ({
  getSetting: (key: string) => Promise.resolve(state.store.get(key) ?? null),
  setSetting: (key: string, value: string) => {
    state.store.set(key, value);
    return Promise.resolve();
  },
  SOURCE_META_CHANGED_EVENT: "source-meta-changed",
  SOURCE_PACK_CHANGED_EVENT: "source-pack-changed",
}));

vi.mock("@/source-scripts", () => ({
  authCheckUser: (source: string, cookie: string, extras?: Record<string, string>) => {
    state.checks.push({ source, cookie, extras });
    const scripted = state.checkResults.get(source);
    const result = scripted ?? { ok: true, user: null, credential: null };
    return state.gate === null
      ? Promise.resolve(result)
      : state.gate.then(() => result);
  },
  authSetCredential: () => Promise.resolve(),
  authClearCredential: () => Promise.resolve(),
}));

vi.mock("@/source-engine/client", () => ({
  onEnginePhaseChange: () => () => undefined,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => undefined,
}));

import {
  mergeCredentialExtras,
  refreshAllSourceAccounts,
  resetSourceAuthCaches,
} from "@/lib/source-auth";
import { SOURCE_AUTH_ACCOUNTS_KEY } from "@/lib/storageKeys";

const USER = {
  id: "1",
  nickname: "测试用户",
  avatar: "",
  vip: false,
  vipLabel: "",
} as const;

function seedAccount(source: string, extras?: Record<string, string>): void {
  const raw = JSON.parse(state.store.get(SOURCE_AUTH_ACCOUNTS_KEY) ?? "{}");
  raw[source] = {
    cookie: `${source}-cookie`,
    user: USER,
    savedAt: "2026-10-24T00:00:00.000Z",
    ...(extras !== undefined ? { extras } : {}),
  };
  state.store.set(SOURCE_AUTH_ACCOUNTS_KEY, JSON.stringify(raw));
}

function storedAccounts(): Record<string, Record<string, unknown>> {
  return JSON.parse(state.store.get(SOURCE_AUTH_ACCOUNTS_KEY) ?? "{}");
}

beforeEach(() => {
  state.store.clear();
  state.sets.length = 0;
  state.clears.length = 0;
  state.checks.length = 0;
  state.checkResults.clear();
  state.gate = null;
  resetSourceAuthCaches();
});

describe("refreshAllSourceAccounts", () => {
  it("①轮换持久化：新 cookie + 应答 refresh_token 并入 extras 落库", async () => {
    seedAccount("bili", { refresh_token: "rt-old" });
    state.checkResults.set("bili", { ok: true, credential: "bili-cookie-new", refreshToken: "rt-new" });

    await expect(refreshAllSourceAccounts("测试轮换")).resolves.toEqual({
      checked: 1,
      rotated: 1,
    });
    expect(state.checks).toEqual([
      { source: "bili", cookie: "bili-cookie", extras: { refresh_token: "rt-old" } },
    ]);
    const bili = storedAccounts().bili;
    expect(bili.cookie).toBe("bili-cookie-new");
    expect(bili.extras).toEqual({ refresh_token: "rt-new" });
    // 用户信息原样保留，savedAt 刷新为轮换时间
    expect(bili.user).toEqual(USER);
    expect(bili.savedAt).not.toBe("2026-10-24T00:00:00.000Z");
  });

  it("①b 旧 extras 的其他键在轮换时保留，refresh_token 覆盖", async () => {
    seedAccount("bili", { device_id: "dev-1", refresh_token: "rt-old" });
    state.checkResults.set("bili", { ok: true, credential: "bili-cookie-new", refreshToken: "rt-new" });

    await refreshAllSourceAccounts();
    expect(storedAccounts().bili.extras).toEqual({ device_id: "dev-1", refresh_token: "rt-new" });
  });

  it("②未轮换（credential 为空）跳过不写库", async () => {
    seedAccount("bili", { refresh_token: "rt-old" });

    await expect(refreshAllSourceAccounts()).resolves.toEqual({ checked: 1, rotated: 0 });
    expect(state.checks).toEqual([
      { source: "bili", cookie: "bili-cookie", extras: { refresh_token: "rt-old" } },
    ]);
    // 账号记录原样未动（savedAt 还是种下的旧值）
    expect(storedAccounts()).toEqual({
      bili: {
        cookie: "bili-cookie",
        user: USER,
        savedAt: "2026-10-24T00:00:00.000Z",
        extras: { refresh_token: "rt-old" },
      },
    });
    expect(state.sets).toEqual([]);
  });

  it("③失效（ok:false）跳过且不删账号——绝不自动退出", async () => {
    seedAccount("bili");
    seedAccount("wyy");
    state.checkResults.set("bili", { ok: false, credential: null });

    await expect(refreshAllSourceAccounts()).resolves.toEqual({ checked: 2, rotated: 0 });
    expect(storedAccounts().bili.cookie).toBe("bili-cookie");
    expect(storedAccounts().wyy.cookie).toBe("wyy-cookie");
    // 没有任何退出动作（removeSourceAuthAccount 会 clear 双面凭据）
    expect(state.clears).toEqual([]);
  });

  it("④并发重入去重：进行中再调用复用同一轮 Promise", async () => {
    seedAccount("bili");
    seedAccount("wyy");
    let release!: () => void;
    state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.checkResults.set("bili", { ok: true, credential: "bili-new", refreshToken: "rt-b" });
    state.checkResults.set("wyy", { ok: true, credential: "wyy-new", refreshToken: "rt-w" });

    const p1 = refreshAllSourceAccounts("并发1");
    const p2 = refreshAllSourceAccounts("并发2");
    // 模块锁：第二次调用拿到的就是进行中的同一个 Promise
    expect(p2).toBe(p1);
    release();
    await expect(p1).resolves.toEqual({ checked: 2, rotated: 2 });
    // 一轮只查一次/源，不是两轮四查
    expect(state.checks).toHaveLength(2);
    // 锁释放后可再次触发新一轮
    await expect(refreshAllSourceAccounts("并发3")).resolves.toEqual({ checked: 2, rotated: 2 });
    expect(state.checks).toHaveLength(4);
  });

  it("⑤空账号表直接返回", async () => {
    await expect(refreshAllSourceAccounts("空表")).resolves.toEqual({
      checked: 0,
      rotated: 0,
    });
    expect(state.checks).toEqual([]);
  });
});

describe("mergeCredentialExtras", () => {
  it("旧键保留、refresh_token 覆盖、全空归 undefined", () => {
    expect(mergeCredentialExtras(undefined, "rt")).toEqual({ refresh_token: "rt" });
    expect(mergeCredentialExtras({ device_id: "d", refresh_token: "old" }, "new")).toEqual({
      device_id: "d",
      refresh_token: "new",
    });
    expect(mergeCredentialExtras({ device_id: "d" }, undefined)).toEqual({ device_id: "d" });
    expect(mergeCredentialExtras(undefined, undefined)).toBeUndefined();
    expect(mergeCredentialExtras({ refresh_token: "" }, undefined)).toBeUndefined();
  });
});
