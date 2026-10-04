import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import type { RegistryQuality, RegistrySource } from "@/types";
import { DEFAULT_SEARCH_PAGE_MAX, getSourceRegistry } from "@/source-scripts";
import { onEnginePhaseChange } from "@/source-engine/client";
import { useMusicSourceStore } from "@/stores/musicSource";

/**
 * 音源/音质注册表（数据包声明，宿主不内置清单）——DESIGN §6.2/§6.4。
 *
 * 数据包经 `__qtEntries.sourceRegistry()` 声明音源（id/名称/短名/色值，
 * 顺序即 UI 展示顺序）与音质档位；后续新增/下线音源、调整音质只需发新
 * 数据包。PC 的数据包在线安装（不随应用内置），清单随安装/升级的数据包
 * 版本变化；引擎未就绪或旧版包无该入口时列表为空且 ready=false，各页面
 * 选项为空、展示名兜底「未知」，本地音乐不受影响。
 *
 * 刷新时机：AppShell 挂载后 ensure()（幂等，成功过就不再请求）；引擎
 * phase 变为 ready（onEnginePhaseChange，含 error→ready 自愈）与播放包
 * 安装/切换触发的复位后由下次 ensure/refresh 兜住。
 */
interface SourceRegistryStore {
  /** 数据包声明的音源清单（顺序即切换器/引导页的展示顺序） */
  sources: RegistrySource[];
  /** 数据包声明的音质档位（设置页/播放条的选项来源） */
  qualities: RegistryQuality[];
  /** 已成功取到注册表（区分「还没取到」与「取到但为空」） */
  ready: boolean;
  /** 幂等拉取：成功过就直接返回，未成功则发起/搭车同一次加载 */
  ensure: () => Promise<void>;
  /** 强制重取（失败静默——注册表不是页面主数据，维持原清单） */
  refresh: () => Promise<void>;
}

let inflight: Promise<void> | null = null;

/** 播放包安装/切换/卸载会热切换引擎页：若注册表还没取到（首次 ensure 时
 *  引擎未就绪），换页完成后补取。模块内只绑一次。 */
let packListenerBound = false;
function bindPackListener(): void {
  if (packListenerBound) return;
  packListenerBound = true;
  void listen("source-pack-changed", () => {
    if (useSourceRegistryStore.getState().ready) return;
    const retry = (): void => {
      void useSourceRegistryStore.getState().ensure();
    };
    window.setTimeout(retry, 800);
    window.setTimeout(retry, 2500);
  }).catch(() => {
    packListenerBound = false;
  });
}

/** 引擎 error→ready 自愈（后台重探恢复）不广播 source-pack-changed——直接
 *  订阅引擎相位：转 ready 且注册表还没取到时立刻补取，避免「引擎恢复了、
 *  音源清单却一直空到下一次手动刷新」。模块内只绑一次。 */
let phaseHookBound = false;
function bindPhaseHook(): void {
  if (phaseHookBound) return;
  phaseHookBound = true;
  onEnginePhaseChange((p) => {
    if (p !== "ready") return;
    if (useSourceRegistryStore.getState().ready) return;
    void useSourceRegistryStore.getState().ensure();
  });
}

async function load(set: (partial: Partial<SourceRegistryStore>) => void): Promise<void> {
  bindPackListener();
  bindPhaseHook();
  try {
    const registry = await getSourceRegistry();
    if (registry === null) {
      // 引擎未就绪 / 旧版数据包无入口：清空并保持未就绪，下次 ensure 再试
      set({ sources: [], qualities: [], ready: false });
      return;
    }
    set({ sources: registry.sources, qualities: registry.qualities, ready: true });
    validateActiveSource(registry.sources);
  } finally {
    inflight = null;
  }
}

/** 注册表加载后纠正全局音源：换包后原音源可能已下线（存档里也可能存着
 *  脏值），回退到数据包声明的第一个音源，避免页面拿死 id 请求。 */
function validateActiveSource(sources: RegistrySource[]): void {
  if (sources.length === 0) return;
  const music = useMusicSourceStore.getState();
  const current = music.activeSourceId;
  if (current === "local") return;
  if (sources.some((s) => s.id === current)) return;
  music.setActiveSource(sources[0].id);
}

export const useSourceRegistryStore = create<SourceRegistryStore>()((set, get) => ({
  sources: [],
  qualities: [],
  ready: false,
  ensure: () => {
    if (get().ready) return Promise.resolve();
    if (inflight) return inflight;
    inflight = load(set);
    return inflight;
  },
  refresh: () => {
    if (inflight) return inflight;
    inflight = load(set);
    return inflight;
  },
}));

// ---------- 非响应式读取（事件/工具层用；组件请用下面的 hook 版本） ----------

export function registrySourceIds(): string[] {
  return useSourceRegistryStore.getState().sources.map((s) => s.id);
}

export function registryHasSource(id: string): boolean {
  return useSourceRegistryStore.getState().sources.some((s) => s.id === id);
}

/** ---------- 响应式展示辅助（组件用，注册表加载完成后自动重渲染） ---------- */

/** 音源展示名：本地固定「本地」，注册表外的 id 兜底「未知」（加载中短暂可见） */
export function useSourceLabel(id: string): string {
  return useSourceRegistryStore((s) => {
    if (id === "local") return "本地";
    return s.sources.find((item) => item.id === id)?.name ?? "未知";
  });
}

/**
 * 取展示名的函数版本：列表/循环渲染里逐项调 hook 不行，先在组件顶层拿一次
 * 这个函数再在 map 里用（内部订阅注册表，加载完成后整页自动重渲染）。
 */
export function useSourceLabelFn(): (id: string) => string {
  const sources = useSourceRegistryStore((s) => s.sources);
  return (id: string): string => {
    if (id === "local") return "本地";
    return sources.find((item) => item.id === id)?.name ?? "未知";
  };
}

/** 音源徽标底色（#rrggbb；本地与未知源用中性灰） */
export function useSourceColor(id: string): string {
  return useSourceRegistryStore((s) =>
    s.sources.find((item) => item.id === id)?.color ?? (id === "local" ? "#8b93a7" : "#8b92a1"),
  );
}

/**
 * 该音源的搜索类接口每页条数上限 —— 由数据包声明（包侧 platforms/*.ts 的
 * searchPageMax 自述），宿主不再内置「哪个源最多几条」的清单。
 *
 * 详情页（歌手/专辑）用它当每页条数：上游对超限请求的处理各不相同
 * （qq 要 100 会返回 0 条、酷狗恒给 30），而 usePagedList 靠
 * 「本页条数 === 请求条数」判断还有没有下一页，所以这个值必须等于上游真实上限。
 * 注册表未就绪/旧版包未声明时退回 DEFAULT_SEARCH_PAGE_MAX。
 */
export function useSearchPageMax(id: string): number {
  return useSourceRegistryStore((s) => {
    if (id === "local") return DEFAULT_SEARCH_PAGE_MAX;
    const declared = s.sources.find((item) => item.id === id)?.searchPageMax;
    return typeof declared === "number" && Number.isFinite(declared) && declared > 0
      ? Math.floor(declared)
      : DEFAULT_SEARCH_PAGE_MAX;
  });
}
