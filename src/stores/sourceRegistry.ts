import { create } from "zustand";
import { useMemo } from "react";
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
 * 安装/切换触发的复位后由下次 ensure/refresh 兜住；数据包安装/启用/卸载/
 * 回滚（source-meta-changed）时**无论 ready 与否都强制 refresh**——注册表
 * 来自数据包，新包可能改功能面自述（如某源 latest 翻 true），不重取的话
 * 侧栏「每日新歌」这类入口要等重启才出现（2026-10-06 真机实测暴露）。
 * 注册表每次实际变化还会递增 generation 世代——常驻缓存页把它放进数据
 * effect 的依赖，装/卸/换包后页面旧数据自动清空重取（否则卸载包后首页
 * 仍残留旧包的榜单/歌单/新歌，因为那些 effect 只依赖 activeSourceId）。
 */
interface SourceRegistryStore {
  /** 数据包声明的音源清单（顺序即切换器/引导页的展示顺序） */
  sources: RegistrySource[];
  /** 数据包声明的音质档位（设置页/播放条的选项来源） */
  qualities: RegistryQuality[];
  /** 已成功取到注册表（区分「还没取到」与「取到但为空」） */
  ready: boolean;
  /** 注册表世代：每次 load() 落地且内容/就绪态有实际变化时 +1。常驻缓存页
   *  （KeepAlive 的发现/每日新歌/歌单广场/榜单）把它放进数据 effect 依赖——
   *  装/卸/换数据包后旧列表自动清空重取，不需要重启或切页（2026-10-06：
   *  用户卸载全部音源包后首页仍残留旧榜单/歌单/新歌，根因就是这些页面的
   *  effect 只依赖 activeSourceId，卸载包不改变它）。 */
  generation: number;
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

/** 数据包安装/启用/卸载/回滚会热装载引擎的 meta 槽：注册表由数据包声明，
 *  新包可能整个换掉内容（新源上线、功能面翻转），所以**不看 ready、一律强制
 *  refresh**。引擎页接到同一广播后要 fetch+import 新包才换 entries，立即取
 *  会撞到旧注册表——与播放包监听同款的延迟重试兜住这个装载窗口。模块内只绑一次。 */
let metaListenerBound = false;
function bindMetaListener(): void {
  if (metaListenerBound) return;
  metaListenerBound = true;
  void listen("source-meta-changed", () => {
    const retry = (): void => {
      void useSourceRegistryStore.getState().refresh();
    };
    window.setTimeout(retry, 800);
    window.setTimeout(retry, 2500);
  }).catch(() => {
    metaListenerBound = false;
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
  bindMetaListener();
  bindPhaseHook();
  try {
    const registry = await getSourceRegistry();
    const before = useSourceRegistryStore.getState();
    if (registry === null) {
      // 引擎未就绪 / 旧版数据包无入口 / 包被卸载：清空并保持未就绪。
      // 此前有内容（卸载包）才递增世代——本来就空就别惊动常驻页。
      const hadContent =
        before.ready || before.sources.length > 0 || before.qualities.length > 0;
      set({
        sources: [],
        qualities: [],
        ready: false,
        ...(hadContent ? { generation: before.generation + 1 } : {}),
      });
      return;
    }
    // 内容有实际变化才递增世代：source-meta-changed 的两次延迟重试
    // （800/2500ms）会各跑一次 refresh，包内容没变就不让常驻页白刷一轮。
    const changed =
      !before.ready ||
      JSON.stringify(before.sources) !== JSON.stringify(registry.sources) ||
      JSON.stringify(before.qualities) !== JSON.stringify(registry.qualities);
    set({
      sources: registry.sources,
      qualities: registry.qualities,
      ready: true,
      ...(changed ? { generation: before.generation + 1 } : {}),
    });
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
  generation: 0,
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

/**
 * 该源的 latest() 是否有 offset 分页语义（包侧 platforms/*.ts 的
 * `latestUsesOffset` 自述，宿主不硬编码「哪个源能翻页」）。
 *
 * 每日新歌页靠它决定要不要无限上拉：包侧只有 `latestUsesOffset === true`
 * 的平台才透传 offset（qt-sources actions/aggregate.ts 的 allLatestBatches），
 * 其余平台的 latest 恒取第一页——给它传递增的 offset 会每次拿回同一批数据，
 * 页面看起来一直在翻、列表却一条都不涨。这类平台应当取完第一页就停。
 *
 * 保守方向是**不翻页**：未声明（旧版数据包 / 注册表还没拉到）按 false，
 * 与包侧 `latestUsesOffset === true` 才透传的默认一致，最坏只是少翻几页，
 * 不会出现「翻了十页都是同一批歌」。
 */
export function useLatestUsesOffset(id: string): boolean {
  return useSourceRegistryStore(
    (s) => s.sources.find((item) => item.id === id)?.latestUsesOffset === true,
  );
}

/** ---------- 功能面门控（v4 契约，展示用） ---------- */

/** 数据包可声明的「功能面」：该源有没有排行榜 / 歌单载体 / 歌手页 / 专辑 / 新歌流 */
export type SourceFeature = "charts" | "playlists" | "artist" | "album" | "latest";

/**
 * 某音源是否支持某项功能（UI 展示门控的唯一入口，与移动端 stores/source-registry.ts
 * 的 supports() 同语义）。保守方向是**不隐藏**：
 * - 未声明（v3 及更早的旧包、`local`/未知 id、注册表还没拉到）→ true，与旧包行为一致；
 * - 声明为 false → false，页面据此不渲染该源的这个功能入口/区块/页签。
 */
export function useSourceSupports(id: string, feature: SourceFeature): boolean {
  return useSourceRegistryStore((s) => {
    const flag = s.sources.find((item) => item.id === id)?.features?.[feature];
    return flag !== false;
  });
}

/**
 * 是否**存在**支持某项功能的源（聚合级门控）。全部源都声明不支持 → false，
 * 页面级入口整体隐藏（如侧栏「排行榜」）。注册表还没拉到（空清单）按 true 处理——
 * 门控只在拿到明确声明后才收口。
 */
export function useAnySourceSupports(feature: SourceFeature): boolean {
  return useSourceRegistryStore((s) => {
    if (s.sources.length === 0) return true;
    return s.sources.some((item) => item.features?.[feature] !== false);
  });
}

/** ---------- 音质/排序门控（v5 契约） ---------- */

/** 音质档位的高低序（数组序 = 高到低；与包侧 QUALITIES 的声明序一致） */
const QUALITY_RANKS: string[] = ["flac", "320", "128"];

/**
 * 某源可用的音质档位（v5 契约：包侧 qualities 子集过滤全局档位）。
 *
 * 语义按「保守方向是不隐藏」：未声明（v4 及更早的旧包、`local`/未知 id、
 * 注册表还没拉到）→ 全部档位，与旧包行为一致；声明了子集 → 只保留子集里的
 * 档位（如 B 站无真无损，flac 不再出现在音质选项里）。声明的 id 与全局档位
 * 对不上时退回全部，宁可多展示也不把选项清空。
 *
 * 实现注意：zustand v5 的 selector 就是 useSyncExternalStore 的 getSnapshot，
 * 每次调用返回新数组（filter/`?? []`）会让快照不稳定并陷入无限重渲染——
 * 先取稳定的 store 字段，再用 useMemo 派生。
 */
export function useSourceQualities(id: string | null): RegistryQuality[] {
  const sources = useSourceRegistryStore((s) => s.sources);
  const qualities = useSourceRegistryStore((s) => s.qualities);
  return useMemo(() => {
    const declared =
      id === null ? undefined : sources.find((item) => item.id === id)?.qualities;
    if (declared === undefined || declared.length === 0) return qualities;
    const out = qualities.filter((q) => declared.includes(q.id));
    return out.length > 0 ? out : qualities;
  }, [sources, qualities, id]);
}

/** 稳定的空排序数组（快照稳定，见 useSourceQualities 的实现注意） */
const EMPTY_SORTS: { id: string; name: string }[] = [];

/**
 * 某源的歌单广场排序选项（v5 契约）。未声明 / 空数组（qq/kw/bili）→ []，
 * 页面据此不渲染排序选择器；有多个选项时展示（wyy 最热/最新、kg 最热/最新/推荐）。
 */
export function usePlaylistSorts(id: string | null): { id: string; name: string }[] {
  const sources = useSourceRegistryStore((s) => s.sources);
  return useMemo(() => {
    if (id === null) return EMPTY_SORTS;
    const sorts = sources.find((item) => item.id === id)?.playlistSorts;
    return sorts ?? EMPTY_SORTS;
  }, [sources, id]);
}

/**
 * 把期望音质钳到该源声明可用的档位（v5 契约；非响应式函数版，事件/下载
 * 发起层用）。不可用时取「最接近的一档」：先向下降（想要 flac 但该源只声明
 * 320/128 → 320），降不到再取最接近的更高一档。未声明（旧包）原样返回。
 */
export function clampQualityForPlatform(
  platform: string | null | undefined,
  wanted: string,
): string {
  const state = useSourceRegistryStore.getState();
  const declared =
    platform == null ? undefined : state.sources.find((item) => item.id === platform)?.qualities;
  if (declared === undefined || declared.length === 0) return wanted;
  if (declared.includes(wanted)) return wanted;
  const wantedRank = QUALITY_RANKS.indexOf(wanted);
  if (wantedRank < 0) return declared[0]!;
  // 向下降：可用档里取 ≤ 想要排名的最高一档
  let best: string | null = null;
  let bestRank = -1;
  for (const q of declared) {
    const rank = QUALITY_RANKS.indexOf(q);
    if (rank < 0) continue;
    if (rank <= wantedRank && rank > bestRank) {
      best = q;
      bestRank = rank;
    }
  }
  if (best !== null) return best;
  // 想要的档位以下没有可用档 → 取最接近的更高一档
  let up: string | null = null;
  let upRank = QUALITY_RANKS.length;
  for (const q of declared) {
    const rank = QUALITY_RANKS.indexOf(q);
    if (rank < 0) continue;
    if (rank < upRank) {
      up = q;
      upRank = rank;
    }
  }
  return up ?? wanted;
}
