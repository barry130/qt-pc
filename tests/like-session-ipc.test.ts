import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import * as ipc from "@/services/ipc";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(7);
});

describe("account-bound synchronization IPC", () => {
  it("reads a native session epoch without returning any credential", async () => {
    expect(await ipc.likeSessionEpoch()).toBe(7);
    expect(invoke).toHaveBeenCalledWith("like_session_epoch");
  });

  it("carries the same captured epoch through requests, commits and cursor writes", async () => {
    await ipc.likePull(12, 7);
    await ipc.likePullAll(2, 100, 7);
    await ipc.likeApply([], 7);
    await ipc.likeFlushPending(7);
    await ipc.likeReconcile(7);
    await ipc.likeClearLocal(7);
    await ipc.setSetting("like.sync.seq", "20", 7);
    expect(invoke.mock.calls).toEqual([
      ["like_pull", { since: 12, sessionEpoch: 7 }],
      ["like_pull_all", { page: 2, size: 100, sessionEpoch: 7 }],
      ["like_apply", { changes: [], sessionEpoch: 7 }],
      ["like_flush_pending", { sessionEpoch: 7 }],
      ["like_reconcile", { sessionEpoch: 7 }],
      ["like_clear_local", { sessionEpoch: 7 }],
      ["set_setting", { key: "like.sync.seq", value: "20", sessionEpoch: 7 }],
    ]);
  });

  it("binds authentication and logout housekeeping to the captured epoch", async () => {
    await ipc.astralMe(7);
    await ipc.astralUpdateProfile({ nickname: "account-A" }, 7);
    await ipc.likeResetSync(7);
    await ipc.astralLogout(7);
    expect(invoke.mock.calls).toEqual([
      ["astral_me", { sessionEpoch: 7 }],
      ["astral_update_profile", { patch: { nickname: "account-A" }, sessionEpoch: 7 }],
      ["like_reset_sync", { sessionEpoch: 7 }],
      ["astral_logout", { sessionEpoch: 7 }],
    ]);
  });

  it("carries the original session epoch through secure refresh", async () => {
    await ipc.astralRefresh(7);
    expect(invoke.mock.calls).toEqual([
      ["astral_refresh", { sessionEpoch: 7 }],
    ]);
  });

  it("preserves existing invocation payloads when no epoch is supplied", async () => {
    await ipc.likePull(12);
    await ipc.likePullAll(2);
    await ipc.likeApply([]);
    await ipc.likeFlushPending();
    await ipc.likeReconcile();
    await ipc.likeClearLocal();
    await ipc.setSetting("appearance.test", "value");
    expect(invoke.mock.calls).toEqual([
      ["like_pull", { since: 12 }],
      ["like_pull_all", { page: 2, size: 100 }],
      ["like_apply", { changes: [] }],
      ["like_flush_pending"],
      ["like_reconcile"],
      ["like_clear_local"],
      ["set_setting", { key: "appearance.test", value: "value" }],
    ]);
  });
});
