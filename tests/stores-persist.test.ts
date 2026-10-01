// @vitest-environment jsdom
/**
 * P2-8：前端持久化的两个真问题。
 *
 * 1) `stores/musicSource.ts` 的 persist 没有版本/迁移，旧结构会被直接 hydrate
 *    进新代码（桌面端用户不清缓存，这类问题长期潜伏）；而且存档是用户可手改的，
 *    一个非法 `activeSourceId` 会让所有页面按未知音源请求而**不报错**。
 *    这里证明非法存档被收敛成默认值、合法存档原样保留。
 * 2) `stores/appearance.ts` 的写库失败被 `catch {}` 全吞，界面显示已生效、
 *    重启却回滚。这里证明失败会写成可见的 saveError、重试成功后清空。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getAppearance: vi.fn(),
  setAppearance: vi.fn(),
}));

vi.mock("@/services/ipc", () => ({
  getAppearance: h.getAppearance,
  setAppearance: h.setAppearance,
}));

const KEY = "quietmusic.music-source";

// Node 25 自带全局 localStorage（webstorage）且没有 clear，会盖过 jsdom 的实现
// （stat.test.ts 同款处理）：换成内存实现，保证测试间互不污染。
const memStore: Record<string, string> = {};
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string): string | null => (k in memStore ? memStore[k] : null),
    setItem: (k: string, v: string): void => {
      memStore[k] = String(v);
    },
    clear: (): void => {
      for (const k of Object.keys(memStore)) delete memStore[k];
    },
  },
});

/** 直接写 localStorage 再 import，模拟"上次运行留下的存档" */
async function hydrateWith(payload: unknown): Promise<{
  activeSourceId: string;
  aggregateMode: boolean;
}> {
  localStorage.setItem(KEY, JSON.stringify(payload));
  vi.resetModules();
  const mod = await import("@/stores/musicSource");
  const s = mod.useMusicSourceStore.getState();
  return { activeSourceId: s.activeSourceId, aggregateMode: s.aggregateMode };
}

describe("musicSource persist 版本与校验（P2-8）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("当前版本但字段非法 → 收敛为默认值", async () => {
    // 版本号一致 → zustand 不会调 migrate，只有 merge 里的 sanitize 能兜住
    const s = await hydrateWith({
      state: { activeSourceId: "bogus", aggregateMode: "yes" },
      version: 1,
    });
    expect(s).toEqual({ activeSourceId: "wyy", aggregateMode: false });
  });

  it("无版本号的旧存档（v0）也走 sanitize，且合法值原样保留", async () => {
    const s = await hydrateWith({ state: { activeSourceId: "kg", aggregateMode: true } });
    expect(s).toEqual({ activeSourceId: "kg", aggregateMode: true });
  });

  it("存档被截断成非对象时回落默认值（不抛错）", async () => {
    const s = await hydrateWith({ state: null, version: 1 });
    expect(s).toEqual({ activeSourceId: "wyy", aggregateMode: false });
  });
});

describe("appearance 写库失败可见并自动重试（P2-8）", () => {
  beforeEach(() => {
    vi.resetModules();
    h.getAppearance.mockReset();
    h.setAppearance.mockReset();
  });

  it("写失败 → saveError 可见；重试成功后清空", async () => {
    h.getAppearance.mockResolvedValue({ mode: "dark" });
    const { useAppearanceStore } = await import("@/stores/appearance");
    await useAppearanceStore.getState().load();
    expect(useAppearanceStore.getState().loadOk).toBe(true);

    // 第一次写库失败（自动重试用定时器，这里不等它，先看状态）
    h.setAppearance.mockRejectedValueOnce(new Error("disk full"));
    await useAppearanceStore.getState().update({ fontScale: 1.1 });
    expect(useAppearanceStore.getState().preference.fontScale).toBe(1.1);
    expect(useAppearanceStore.getState().saveError).toContain("保存失败");

    // 手动重试：这次写成功 → 提示清空
    h.setAppearance.mockResolvedValue(undefined);
    await useAppearanceStore.getState().retrySave();
    expect(useAppearanceStore.getState().saveError).toBeNull();
    expect(h.setAppearance).toHaveBeenLastCalledWith(
      expect.objectContaining({ fontScale: 1.1 }),
    );
  });

  it("首次读取失败时不拿默认值覆盖库里已有的值", async () => {
    // load 失败 → loadOk=false；此时 update 会先尝试把真实值读回来
    h.getAppearance.mockRejectedValueOnce(new Error("db locked"));
    const { useAppearanceStore } = await import("@/stores/appearance");
    await useAppearanceStore.getState().load();
    expect(useAppearanceStore.getState().loadOk).toBe(false);

    // 第二次读取成功：库里 mode=dark，用户这次只改 fontScale
    h.getAppearance.mockResolvedValue({ mode: "dark" });
    h.setAppearance.mockResolvedValue(undefined);
    await useAppearanceStore.getState().update({ fontScale: 1.2 });

    const pref = useAppearanceStore.getState().preference;
    expect(pref.mode).toBe("dark"); // 库里的值没有被默认值覆盖
    expect(pref.fontScale).toBe(1.2);
    expect(h.setAppearance).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "dark", fontScale: 1.2 }),
    );
  });
});
