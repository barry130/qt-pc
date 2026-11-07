// @vitest-environment jsdom
/**
 * 外观设置落库排水（C05）：写库成功只清掉「自己写出去的那一版」。
 *
 * 以前 `doFlushSave` 成功后无条件 `pendingSave = null`：用户在慢写库期间又改了
 * 一次，新值刚排进 pendingSave 就被旧请求的成功回调清掉，之后排队的 flush 看到
 * null 直接返回 —— 界面显示新值、库里还是旧值，重启回滚，且 saveError 是 null
 * （用户完全无从察觉）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcMocks = vi.hoisted(() => ({
  getAppearance: vi.fn(),
  setAppearance: vi.fn(),
}));

vi.mock("@/services/ipc", () => ipcMocks);

import { DEFAULT_APPEARANCE } from "@/types";

/** 每个用例都拿一份干净的 store（模块级 pendingSave / saveChain / retryTimer 不串味） */
async function freshStore() {
  vi.resetModules();
  const mod = await import("@/stores/appearance");
  return mod.useAppearanceStore;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  ipcMocks.getAppearance.mockResolvedValue({ ...DEFAULT_APPEARANCE });
  ipcMocks.setAppearance.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("外观写库排水（C05）", () => {
  it("慢写库期间用户又改了：最新值不会被旧请求的成功回调清掉", async () => {
    const store = await freshStore();
    await store.getState().load();

    let release: () => void = () => {};
    ipcMocks.setAppearance.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = () => resolve())),
    );

    const first = store.getState().update({ mode: "dark" });
    await flush();
    // 第一版还在 IPC 里飞，用户把字号也改了
    const second = store.getState().update({ fontScale: 1.2 });
    await flush();

    release();
    await first;
    await second;
    await flush();

    // 两版都落了库，最后写的是合并后的最新值
    expect(ipcMocks.setAppearance).toHaveBeenCalledTimes(2);
    expect(ipcMocks.setAppearance.mock.calls.at(-1)![0]).toMatchObject({
      mode: "dark",
      fontScale: 1.2,
    });
    expect(store.getState().preference).toMatchObject({ mode: "dark", fontScale: 1.2 });
    expect(store.getState().saveError).toBeNull();
  });

  it("写库失败后的自动重试不会覆盖用户刚改的新值", async () => {
    vi.useFakeTimers();
    const store = await freshStore();
    await store.getState().load();

    ipcMocks.setAppearance.mockRejectedValueOnce(new Error("db locked"));
    await store.getState().update({ mode: "dark" });
    expect(store.getState().saveError).toContain("外观设置保存失败");

    // 失败重试还挂在定时器上，用户继续改了字号
    ipcMocks.setAppearance.mockResolvedValue(undefined);
    await store.getState().update({ fontScale: 1.2 });
    expect(ipcMocks.setAppearance.mock.calls.at(-1)![0]).toMatchObject({
      mode: "dark",
      fontScale: 1.2,
    });

    // 到点的自动重试不能再拿旧版 payload 写回去
    const writes = ipcMocks.setAppearance.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ipcMocks.setAppearance.mock.calls.length).toBe(writes);
    expect(store.getState().saveError).toBeNull();
  });
});
