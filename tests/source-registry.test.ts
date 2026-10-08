// @vitest-environment jsdom
/**
 * 回归（2026-10-06 真机实测暴露）：设置页安装新数据包后，引擎页会热装载 meta
 * 槽，但主窗口的音源注册表 store 只在 ensure() 首次成功后就闩住（ready=true 不再
 * 请求），且只监听 source-pack-changed——没人消费 source-meta-changed。结果：
 * 新包把某源的功能面自述翻转（如咪咕 features.latest: false→true）后，侧栏
 * 「每日新歌」入口要**重启应用**才出现。
 *
 * 修复：sourceRegistry store 监听 source-meta-changed，无论 ready 与否一律
 * refresh()（延迟重试，等引擎页装完新包）。本用例删掉 bindMetaListener 后
 * 最后一条断言必然失败（注册表停在旧版）。
 *
 * 后续同日暴露第二缺陷：卸载全部数据包后首页仍残留旧包的榜单/歌单/新歌——
 * keep-alive 常驻页的数据 effect 只依赖 activeSourceId（卸载不改变它）。
 * 修复：store 每次**实际变化**递增 generation 世代，常驻页把它放进 effect 依赖。
 * 第二条用例锁定世代的增减语义（内容不变的重取不无谓递增，避免常驻页白刷）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** 捕获 store 注册的 source-meta-changed 处理器（模拟 Rust 广播） */
  metaChanged: null as null | (() => void),
  /** 当前「数据包」给出的注册表（测试中途换掉模拟装新包） */
  registry: null as unknown,
  calls: 0,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: () => void) => {
    if (name === "source-meta-changed") h.metaChanged = cb;
    return () => {};
  }),
}));

vi.mock("@/source-scripts", () => ({
  DEFAULT_SEARCH_PAGE_MAX: 20,
  getSourceRegistry: vi.fn(async () => {
    h.calls += 1;
    return h.registry;
  }),
}));

vi.mock("@/source-engine/client", () => ({
  onEnginePhaseChange: vi.fn(),
}));

vi.mock("@/stores/musicSource", () => ({
  useMusicSourceStore: {
    getState: () => ({ activeSourceId: "migu", setActiveSource: vi.fn() }),
  },
}));

const REGISTRY_V1 = {
  sources: [{ id: "migu", name: "咪咕音乐", features: { latest: false } }],
  qualities: [{ id: "128", name: "流畅" }],
};
const REGISTRY_V2 = {
  sources: [{ id: "migu", name: "咪咕音乐", features: { latest: true } }],
  qualities: [{ id: "128", name: "流畅" }],
};

describe("音源注册表：数据包热更新", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.metaChanged = null;
    h.registry = REGISTRY_V1;
    h.calls = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("安装新数据包（source-meta-changed）后注册表强制重取，ready 也不闩住", async () => {
    vi.resetModules();
    const { useSourceRegistryStore } = await import("@/stores/sourceRegistry");

    // 首次加载：旧包，咪咕无每日新歌
    await useSourceRegistryStore.getState().ensure();
    expect(useSourceRegistryStore.getState().ready).toBe(true);
    expect(useSourceRegistryStore.getState().sources[0]?.features?.latest).toBe(false);
    expect(h.metaChanged).not.toBeNull();

    // ensure 幂等闩住：再调不再请求
    await useSourceRegistryStore.getState().ensure();
    expect(h.calls).toBe(1);

    // 用户装了新数据包：Rust 广播 source-meta-changed，包侧 latest 翻 true
    h.registry = REGISTRY_V2;
    h.metaChanged!();

    // 引擎页装新包需要时间，store 延迟重试；800ms 后注册表必须已是新版
    await vi.advanceTimersByTimeAsync(800);
    expect(useSourceRegistryStore.getState().sources[0]?.features?.latest).toBe(true);
    expect(h.calls).toBeGreaterThan(1);
  });

  it("generation 世代：卸载清空后递增、内容不变的重取不递增（常驻页据此清旧数据）", async () => {
    vi.resetModules();
    const { useSourceRegistryStore } = await import("@/stores/sourceRegistry");

    // 首次加载 v1：0 → 1
    await useSourceRegistryStore.getState().ensure();
    const g1 = useSourceRegistryStore.getState().generation;
    expect(g1).toBe(1);

    // meta-changed 但包内容没变（引擎页重载同一份注册表）：两次延迟重试
    // 都跑完，世代也不动——常驻页不白刷一轮
    h.metaChanged!();
    await vi.advanceTimersByTimeAsync(2500);
    expect(useSourceRegistryStore.getState().generation).toBe(g1);

    // 用户卸载全部数据包：getSourceRegistry 变 null → 清空 + 世代 +1
    // （keep-alive 页面靠这个把残留的旧榜单/歌单/新歌清掉重取）
    h.registry = null;
    h.metaChanged!();
    await vi.advanceTimersByTimeAsync(800);
    const uninstalled = useSourceRegistryStore.getState();
    expect(uninstalled.ready).toBe(false);
    expect(uninstalled.sources).toEqual([]);
    expect(uninstalled.generation).toBe(g1 + 1);

    // 重装同款包：从空到有内容，世代再 +1，注册表恢复
    h.registry = REGISTRY_V1;
    h.metaChanged!();
    await vi.advanceTimersByTimeAsync(800);
    const reinstalled = useSourceRegistryStore.getState();
    expect(reinstalled.ready).toBe(true);
    expect(reinstalled.generation).toBe(g1 + 2);
  });
});
