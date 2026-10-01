// 启动恢复登录态的回归：本地没过期的 token 也要向服务端确认一次，
// 否则后端重启/会话被撤销后界面一直显示「已登录」但接口全 401。
// 关键约束：网络不可达时不能把用户登出（离线容忍）。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/ipc", () => ({
  astralSession: vi.fn(),
  astralMe: vi.fn(),
  astralLogout: vi.fn(async () => {}),
  getSetting: vi.fn(async () => "1"),
  setSetting: vi.fn(async () => {}),
  likePull: vi.fn(async () => ({ changes: [], maxSeq: 0 })),
  likePullAll: vi.fn(async () => ({ songs: [], playlists: [], maxSeq: 0 })),
  likeApply: vi.fn(async () => {}),
}));

import * as ipc from "@/services/ipc";
import { useAuthStore, isAdmin } from "@/stores/auth";
import type { AuthSession } from "@/types";

const ipcMock = vi.mocked(ipc);

/** 本地看还在有效期内（留足 60s 余量）的会话 */
function validSession(): AuthSession {
  return {
    token: "stale-token",
    refreshToken: "stale-token",
    expiresAt: Date.now() + 3_600_000,
  };
}

describe("auth store 启动恢复", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ session: null, profile: null, loading: false, error: null });
  });

  it("服务端否认（401）时清掉登录态，不留假登录", async () => {
    ipcMock.astralSession
      .mockResolvedValueOnce(validSession()) // init 首次读本地会话
      .mockResolvedValueOnce(null); // me 失败后再读：Rust 已清掉
    ipcMock.astralMe.mockRejectedValue(new Error("登录状态已失效，请重新登录"));

    await useAuthStore.getState().init();

    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().profile).toBeNull();
    expect(ipcMock.astralLogout).toHaveBeenCalled();
  });

  it("网络不可达时保留登录态（离线容忍）", async () => {
    ipcMock.astralSession.mockResolvedValue(validSession());
    ipcMock.astralMe.mockRejectedValue(
      new Error("Astral 请求失败: error sending request"),
    );

    await useAuthStore.getState().init();

    expect(useAuthStore.getState().session).not.toBeNull();
    expect(useAuthStore.getState().profile).toBeNull();
    expect(ipcMock.astralLogout).not.toHaveBeenCalled();
  });

  it("服务端确认通过时写入会话与用户信息", async () => {
    ipcMock.astralSession.mockResolvedValue(validSession());
    ipcMock.astralMe.mockResolvedValue({ nickname: "轻听用户" });

    await useAuthStore.getState().init();

    expect(useAuthStore.getState().session?.token).toBe("stale-token");
    expect(useAuthStore.getState().profile).toEqual({ nickname: "轻听用户" });
    expect(ipcMock.astralLogout).not.toHaveBeenCalled();
  });
});

// 权限判定回归：2026-09-30 权限模型重构（V20260930001）后，roles 回的是角色名
// （TESTER/APP_USER），权限码在顶层 permissions（分层码），超管合成 *:*:* 不落库。
// 判定对齐后端 PermissionChecker：新码精确匹配 + 超管/层级通配 + 旧扁平码兜底。
describe("isAdmin（轻听管理权限判定）", () => {
  it("permissions 含新码 admin:qt:admin → true", () => {
    expect(isAdmin({ permissions: ["user:like:view", "admin:qt:admin"] })).toBe(true);
  });

  it("旧扁平码 qt_admin 兜底（未跑迁移的库）", () => {
    expect(isAdmin({ roles: ["qt_admin"] })).toBe(true);
    expect(isAdmin({ permissions: ["qt_admin"] })).toBe(true);
  });

  it("超管与层级通配", () => {
    expect(isAdmin({ permissions: ["*:*:*"] })).toBe(true);
    expect(isAdmin({ permissions: ["admin:qt:*"] })).toBe(true);
    expect(isAdmin({ permissions: ["admin:*"] })).toBe(true);
  });

  it("普通用户（角色名 + user 侧权限）→ false", () => {
    expect(
      isAdmin({ roles: ["TESTER", "APP_USER"], permissions: ["user:like:view"] }),
    ).toBe(false);
  });

  it("通配不跨段误判", () => {
    expect(isAdmin({ permissions: ["user:admin:*"] })).toBe(false);
    // admin:system:* 只覆盖管理端 system 子树，不含 admin:qt:admin
    expect(isAdmin({ permissions: ["admin:system:*"] })).toBe(false);
  });

  it("roles / permissions 挂在 user 下也认（兼容变体）", () => {
    expect(isAdmin({ user: { roles: ["qt_admin"] } })).toBe(true);
    expect(isAdmin({ user: { permissions: ["admin:qt:admin"] } })).toBe(true);
  });

  it("未登录 / 无权限数据 → false（失败即隐藏）", () => {
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin({})).toBe(false);
    expect(isAdmin({ roles: [] })).toBe(false);
    expect(isAdmin({ roles: "qt_admin" })).toBe(false);
    expect(isAdmin({ roles: ["TESTER"] })).toBe(false);
  });
});
