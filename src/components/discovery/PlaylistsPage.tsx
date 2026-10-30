import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { formatPlayCount } from "@/lib/format";
import { useNavigate } from "@tanstack/react-router";
import type { Playlist, PlaylistCategory } from "@/types";
import * as sourceApi from "@/source-scripts";
import { useMusicSourceStore } from "@/stores/musicSource";
import { usePlaylistSorts, useSourceRegistryStore } from "@/stores/sourceRegistry";
import { useKeepAliveActive } from "@/components/layout/keepAliveActive";
import { CoverCard, CoverGrid } from "./CoverCard";
import { CoverGridSkeleton, ErrorRetry, ListLoadProgress } from "./Skeletons";
import { usePagedList, type PageResult } from "@/hooks/usePagedList";

/**
 * 歌单广场（路由 /playlists，DESIGN §5.2）。
 * 分类来自当前音源（wyy/qq/kw/kg 各有自己的分类体系），切换音源重新拉分类。
 * 移动端同款行为：分类取不到时降级为「全部」，不阻断歌单列表。
 *
 * 列表**一次拉全量**（usePagedList 的 all 模式，用户 m05614：不要滚动续页、
 * 底部不要「已经到底了」）：进页就把所有页并发取完，底部只在没拉完时提示进度。
 * 已知降级：qq 等音源的分页参数不生效，会重复返回同一批，所以按 id 去重；
 * 一整批都是重复项时提前收尾，不会顺着满页判断空转到上限。
 */

/**
 * 歌单广场每页条数：包侧 recommendations 不接收条数参数，各家都是 30 条一页。
 * all 模式里 hasMore 是显式给的，这个值只用于任务内部的满页判断。
 */
const PLAYLIST_PAGE_SIZE = 30;
export function PlaylistsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);
  // 排序选项来自数据包注册表（v5 契约；未声明 = 空 = 不渲染选择器）
  const sorts = usePlaylistSorts(activeSourceId);
  // 注册表世代：装/卸/换数据包后 +1。本页 keep-alive 常驻，不盯世代的话，
  // 卸载包后旧分类与歌单列表会一直残留（activeSourceId 不变，effect 永不重跑）。
  const metaGeneration = useSourceRegistryStore((s) => s.generation);

  const [categories, setCategories] = useState<PlaylistCategory[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [sort, setSort] = useState("");

  // 音源切换 / 数据包变化 → 重取分类并回到「全部」第一页
  useEffect(() => {
    let cancelled = false;
    setCategories([]);
    setCategory(null);
    void (async () => {
      try {
        const cats = await sourceApi.getPlaylistCategories(activeSourceId);
        if (!cancelled) setCategories(Array.isArray(cats) ? cats : []);
      } catch {
        if (!cancelled) setCategories([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSourceId, metaGeneration]);

  // 排序随源声明变化（切源/换包后）：当前排序不在声明里就回退到第一项。
  useEffect(() => {
    // 排序不在声明里就回退到第一项。切排序不用手工清列表：resetKey 里有 sort，
    // key 一变 usePagedList 在同一帧归位重拉（#36 的两种排序混排由它保证）。
    if (sorts.length > 0 && !sorts.some((s) => s.id === sort)) setSort(sorts[0]!.id);
    if (sorts.length === 0 && sort !== "") setSort("");
  }, [sorts, sort]);

  /**
   * 取第 page 页。hasMore 显式给出：包侧 recommendations 基本不回总数，
   * 返回空页才是到底；重复页由 paged-all 的「一整批没有新增」兜住。
   */
  const fetchPage = useCallback(
    async (page: number): Promise<PageResult<Playlist>> => {
      const list = await sourceApi.getRecommendations(activeSourceId, category, page, sort);
      const arr = Array.isArray(list) ? list : [];
      return { list: arr, hasMore: arr.length > 0 };
    },
    [activeSourceId, category, sort],
  );

  // 一次拉全量：并发把所有页取完，不再自己维护 page/items/hasMore 和观察器。
  const { items, loading, error, finished, reload } = usePagedList<Playlist>({
    fetchPage,
    // 按 id 去重，替代原先 load() 里的手工 seen 集合
    keyOf: (p) => `${p.platform}:${p.id}`,
    // 音源 / 分类 / 排序 / 数据包世代变化都要整轮重拉（替代原先逐处 setPage+清空）
    resetKey: `${activeSourceId}:${category ?? "*"}:${sort}:${metaGeneration}`,
    pageSize: PLAYLIST_PAGE_SIZE,
    mode: "all",
    // 命中缓存：来回切分类/页签不重复拉同一批（任务在后台跑完并留在内存里）
    cacheKey: `playlists:${activeSourceId}:${category ?? "*"}:${sort}:${metaGeneration}`,
    // 推荐流没有「总数」可言：40 页 × 30 张 = 1200 张封顶。封面卡是
    // loading="lazy"，不会同时解码，但卡片节点本身占内存，别无限拉。
    maxPages: 40,
  });

  const pick = (cat: string | null): void => {
    setCategory(cat);
  };

  /** 切换排序（v5 契约：id 原样透传给包侧 recommendations），整轮重拉 */
  const pickSort = (id: string): void => {
    if (id === sort) return;
    setSort(id);
  };

  /**
   * 稳定回调（#12）：封面卡是 memo 组件，内联箭头每次渲染都换新引用会把 memo 打穿；
   * 全量模式下每批页到达都会重渲染一次，累积上千张卡时整网格重画代价很实在。
   */
  const openPlaylist = useCallback(
    (p: Playlist): void => {
      void navigate({
        to: "/playlist/$platform/$id",
        params: { platform: p.platform, id: p.id },
      });
    },
    [navigate],
  );

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <h1 className="text-xl font-bold tracking-tight">歌单广场</h1>
        {sorts.length > 1 && (
          <div className="mt-2 flex items-center gap-1.5">
            {sorts.map((s) => (
              <CategoryChip
                key={s.id}
                active={sort === s.id}
                label={s.name}
                onClick={() => pickSort(s.id)}
              />
            ))}
          </div>
        )}
        {categories.length > 0 && (
          <CategoryFilter categories={categories} category={category} onPick={pick} />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <ErrorRetry message={`加载失败：${error}`} onRetry={reload} />
        ) : loading ? (
          <CoverGridSkeleton />
        ) : items.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            该分类暂无歌单
          </div>
        ) : (
          <>
            <CoverGrid>
              {items.map((p) => (
                <CoverCard
                  key={`${p.platform}-${p.id}`}
                  name={p.name}
                  picUrl={p.picUrl}
                  subtitle={p.playCount ? `${formatPlayCount(p.playCount)}次播放` : undefined}
                  item={p}
                  onPick={openPlaylist}
                />
              ))}
            </CoverGrid>

            {/* 端到端拉完前才提示进度，拉到就没有底部文案（用户 m05614） */}
            <ListLoadProgress finished={finished} count={items.length} noun="歌单" unit="个" />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 分类筛选条：一行分类 + 最右侧「更多」，点更多在下拉面板里展示全部分类。
 * 音源分类常有 50+ 个，全展开会占掉近三分之一屏幕，所以行内只露一行，
 * 剩余的收进面板（参考主流播放器歌单广场的交互）。
 *
 * 行高用**实测值**而不是写死像素：设置里的字体缩放（0.85–1.25）会等比放大
 * chip 高度，写死 px 会在缩放后裁掉半行或留出一条空白。
 */
function CategoryFilter(props: {
  categories: PlaylistCategory[];
  category: string | null;
  onPick: (cat: string | null) => void;
}): React.JSX.Element {
  const { categories, category, onPick } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [rowHeight, setRowHeight] = useState(0);
  const [fullHeight, setFullHeight] = useState(0);
  // 本页在 keep-alive 里可能处于 display:none（用户在看别的页面）。
  // 那种状态下一切几何量都是 0，量出来的结果会把 collapsible 永久钉成 false。
  const active = useKeepAliveActive();

  const measure = useCallback((): void => {
    const list = listRef.current;
    const first = list?.firstElementChild;
    if (!list || !first) return;
    setRowHeight(first.getBoundingClientRect().height);
    // scrollHeight 不受 maxHeight 影响，收起状态下也能量出完整内容高度
    setFullHeight(list.scrollHeight);
  }, []);

  // 分类数量变化、以及**本页重新可见**时都要重测。
  // 只依赖 categories.length 是不够的：换源后新分类是在页面还隐藏着的时候
  // 到达的（keep-alive 不卸载），那一帧量到的全是 0，等用户切回来时
  // categories.length 没变、window 也没 resize，于是「更多」再也不会出现。
  // 放在 useLayoutEffect 里保证在浏览器绘制前完成，切回来不会闪一下「全部展开」。
  useLayoutEffect(() => {
    measure();
  }, [measure, categories.length, active]);

  useEffect(() => {
    // 换行取决于容器宽度；字体缩放改的是 html 的 font-size，容器宽高不变，
    // window resize 不会触发，所以额外观察 html 的 style 属性。
    const onResize = (): void => measure();
    window.addEventListener("resize", onResize);
    const mo = new MutationObserver(onResize);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
    // 再直接盯容器自身尺寸：display:none → 可见时它会从 0×0 变成真实尺寸，
    // ResizeObserver 必然触发，是比「猜触发时机」更可靠的兜底。
    let ro: ResizeObserver | null = null;
    const list = listRef.current;
    if (list && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(onResize);
      ro.observe(list);
    }
    return () => {
      window.removeEventListener("resize", onResize);
      mo.disconnect();
      ro?.disconnect();
    };
  }, [measure, active]);

  // 点击面板外面收起（标准下拉行为）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // 只有一行时没有必要给「更多」。
  // 行内**始终**裁到一行（展开面板时也不例外）：面板里已经是完整列表，
  // 行内若跟着展开就会上下重复两份分类。
  const collapsible = rowHeight > 0 && fullHeight > rowHeight + 1;

  const chips = (closeOnPick: boolean): React.JSX.Element => (
    <>
      <CategoryChip
        active={category === null}
        label="全部"
        onClick={() => {
          onPick(null);
          if (closeOnPick) setOpen(false);
        }}
      />
      {categories.map((c) => (
        <CategoryChip
          key={c.id}
          active={category === c.id}
          label={c.name}
          onClick={() => {
            onPick(c.id);
            if (closeOnPick) setOpen(false);
          }}
        />
      ))}
    </>
  );

  return (
    <div ref={rootRef} className="relative mt-2">
      {/* 分类行占满整宽，「更多」浮在行尾：把「更多」挪出 flex 布局，
          否则它先占位会把分类行挤窄，窄窗口下只能露出一两个分类。
          overflow-hidden + maxHeight 让行内恒定只露一行。 */}
      <div className="relative">
        <div
          ref={listRef}
          className={`flex flex-wrap gap-1.5 overflow-hidden ${
            collapsible ? "pr-16" : ""
          }`}
          style={collapsible ? { maxHeight: rowHeight } : undefined}
        >
          {chips(false)}
        </div>
        {collapsible && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "收起全部分类" : "展开全部分类"}
            className="absolute right-0 top-0 flex items-center gap-1 rounded-md bg-card/90 px-2 py-1 text-xs text-muted-foreground backdrop-blur-sm transition-colors hover:bg-secondary hover:text-foreground"
          >
            更多
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
            />
          </button>
        )}
      </div>

      {/* 下拉面板：全部分类（含行里已露出的），点选即生效并收起 */}
      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1.5 max-h-80 overflow-y-auto rounded-xl border border-border bg-popover/95 backdrop-blur-xl p-3 shadow-raised">
          <div className="flex flex-wrap gap-1.5">{chips(true)}</div>
        </div>
      )}
    </div>
  );
}

function CategoryChip(props: {
  active: boolean;
  label: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      className={`h-7 rounded-full border px-3 text-xs transition-colors ${
        props.active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:text-foreground"
      }`}
    >
      {props.label}
    </button>
  );
}
