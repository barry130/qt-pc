import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/types";
const native = vi.hoisted(() => ({ revision: 7, queue: [] as Track[], appendCalls: 0, releaseCalls: 0,
  malformed: false, appendWait: null as Promise<void> | null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === "queue_release_if_current") {
      native.releaseCalls += 1;
      const applied = args.expectedRevision === native.revision;
      if (applied) native.revision += 1;
      return { applied, queueRevision: native.revision };
    }
    if (command !== "queue_append_if_current") throw new Error(`Unexpected owned IPC: ${command}`);
    native.appendCalls += 1;
    await native.appendWait;
    if (native.malformed) return { applied: true, queueRevision: 1.5 };
    if (args.expectedRevision !== native.revision) return { applied: false, queueRevision: native.revision };
    const tracks = args.tracks as Track[];
    if (tracks.length) { native.queue.push(...tracks); native.revision += 1; }
    return { applied: true, queueRevision: native.revision };
  },
}));
import { queueAppendIfCurrent } from "@/services/ipc";
const track: Track = { id: "owned-42", platform: "wyy", title: "Owned queue song", singer: "Fixture", album: "", picUrl: "", duration: 120 };
beforeEach(() => { native.revision = 7; native.queue = []; native.appendCalls = 0; native.malformed = false;
  native.releaseCalls = 0; native.appendWait = null; });
describe("public account native queue ownership IPC", () => {
  it("applies to the acknowledged owner and leaves a replacement queue unchanged for the old owner", async () => {
    expect(await queueAppendIfCurrent([track], 7)).toEqual({ applied: true, queueRevision: 8 });
    expect(native.queue).toEqual([track]);
    native.revision = 20; native.queue = [{ ...track, id: "manual-user-queue" }];
    expect(await queueAppendIfCurrent([track], 8)).toEqual({ applied: false, queueRevision: 20 });
    expect(native.queue.map(item => item.id)).toEqual(["manual-user-queue"]);
  });
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid expected ownership %s without IPC", async revision => {
    await expect(queueAppendIfCurrent([track], revision)).rejects.toThrow("队列归属版本无效");
    expect(native.appendCalls).toBe(0); expect(native.queue).toEqual([]);
  });
  it("rejects a malformed native ownership receipt instead of treating it as an applied owner", async () => {
    native.malformed = true;
    await expect(queueAppendIfCurrent([track], 7)).rejects.toThrow("原生队列回执无效");
  });
  it("releases only its own pending append and preserves a later manual replacement", async () => {
    let unblock!: () => void;
    native.appendWait = new Promise<void>(resolve => { unblock = resolve; });
    const controller = new AbortController();
    const pending = queueAppendIfCurrent([track], 7, controller.signal);
    expect(native.appendCalls).toBe(1);
    controller.abort();
    expect(native.releaseCalls).toBe(1);
    expect(native.revision).toBe(8); expect(native.queue).toEqual([]);
    unblock();
    expect(await pending).toEqual({ applied: false, queueRevision: 8 });
    expect(native.queue).toEqual([]);

    native.revision = 20; native.queue = [{ ...track, id: "manual-user-queue" }];
    native.appendWait = new Promise<void>(resolve => { unblock = resolve; });
    const old = new AbortController();
    const stale = queueAppendIfCurrent([track], 8, old.signal);
    old.abort(); unblock();
    expect(await stale).toEqual({ applied: false, queueRevision: 20 });
    expect(native.revision).toBe(20);
    expect(native.queue.map(item => item.id)).toEqual(["manual-user-queue"]);
  });
  it("does not send an already-aborted append or revoke a completed owner on later abort", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(queueAppendIfCurrent([track], 7, controller.signal)).rejects.toThrow("队列追加已取消");
    expect(native.appendCalls).toBe(0); expect(native.releaseCalls).toBe(0);
    const live = new AbortController();
    expect(await queueAppendIfCurrent([track], 7, live.signal)).toEqual({ applied: true, queueRevision: 8 });
    live.abort();
    expect(native.releaseCalls).toBe(0); expect(native.revision).toBe(8); expect(native.queue).toEqual([track]);
  });
  it("matched empty append is effectless and retains the same acknowledged revision", async () => {
    expect(await queueAppendIfCurrent([], 7)).toEqual({ applied: true, queueRevision: 7 });
    expect(native.revision).toBe(7); expect(native.queue).toEqual([]);
  });
});
