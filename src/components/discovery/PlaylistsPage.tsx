import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { errMsg } from "@/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import type { Playlist, PlaylistCategory } from "@/types";
import * as ipc from "@/services/ipc";
import { useMusicSourceStore } from "@/stores/musicSource";
import { CoverCard, CoverGrid } from "./CoverCard";

/**
 * 歌单广场（路由 /playlists，DESIGN §5.2）。
 * 分类来自当前音源（wyy/qq/kw/kg 各有自己的分类体系），切换音源重新拉分类。
 * 移动端同款行为：分类取不到时降级为「全部」，不阻断歌单列表。
 *
 * 列表是**下拉加载**（滚到底自动追加下一页），不再手动翻页。
 * 已知降级：qq 等音源的分页参数不生效，会重复返回同一批，所以追加时按 id 去重；
 * 一页全是被去重掉的旧数据也没关系，最多是提前认为到底。
 */
export function PlaylistsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);

  const [categories, setCategories] = useState<PlaylistCategory[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);

  // 音源切换 → 重取分类并回到「全部」第一页
  useEffect(() => {
    let cancelled = false;
    setCategories([]);
    setCategory(null);
    setPage(1);
    setItems([]);
    setHasMore(true);
    void (async () => {
      try {
        const cats = await ipc.getPlaylistCategories(activeSourceId);
        if (!cancelled) setCategories(Array.isArray(cats) ? cats : []);
      } catch {
        if (!cancelled) setCategories([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSourceId]);

  const load = useCallback(
    async (cat: string | null, p: number): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const list = await ipc.getRecommendations(activeSourceId, cat, p);
        const arr = Array.isArray(list) ? list : [];
        setItems((prev) => {
          if (p <= 1) return arr;
          const seen = new Set(prev.map((x) => `${x.platform}:${x.id}`));
          return [
            ...prev,
            ...arr.filter((x) => !seen.has(`${x.platform}:${x.id}`)),
          ];
        });
        // 空页 = 到底了
        if (arr.length === 0) setHasMore(false);
      } catch (err) {
        if (p <= 1) setItems([]);
        setError(errMsg(err));
      } finally {
        setLoading(false);
      }
    },
    [activeSourceId],
  );

  useEffect(() => {
    void load(category, page);
  }, [category, page, load]);

  // 滚到底自动加载下一页。loading 用 ref 读，避免 observer 被反复重建。
  const sentinel = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  loadingRef.current = loading;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingRef.current) {
          setPage((p) => p + 1);
        }
      },
      // 提前一屏触发，滚到底时通常已经加载好了
      { rootMargin: "240px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, items.length]);

  const pick = (cat: string | null): void => {
    setCategory(cat);
    setPage(1);
    setItems([]);
    setHasMore(true);
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <h1 className="text-base font-medium">歌单广场</h1>
        {categories.length > 0 && (
          <CategoryFilter categories={categories} category={category} onPick={pick} />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <div className="py-10 text-center text-sm text-destructive">
            加载失败：{error}
          </div>
        ) : !loading && items.length === 0 ? (
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
                  subtitle={p.playCount ? `${p.playCount} 次播放` : undefined}
                  onClick={() =>
                    void navigate({
                      to: "/playlist/$platform/$id",
                      params: { platform: p.platform, id: p.id },
                    })
                  }
                />
              ))}
            </CoverGrid>

            {/* 哨兵：进入视口就拉下一页 */}
            <div ref={sentinel} className="h-1" />

            <div className="py-4 text-center text-xs text-muted-foreground">
              {loading ? "加载中…" : hasMore ? "继续下拉加载更多" : "已经到底了"}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 分类筛选条：默认只露 1 行，右下角可展开查看全部。
 * 音源分类常有 50+ 个，全展开会占掉近三分之一屏幕，所以默认收起。
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
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [rowHeight, setRowHeight] = useState(0);
  const [fullHeight, setFullHeight] = useState(0);

  const measure = useCallback((): void => {
    const list = listRef.current;
    const first = list?.firstElementChild;
    if (!list || !first) return;
    setRowHeight(first.getBoundingClientRect().height);
    // scrollHeight 不受 maxHeight 影响，收起状态下也能量出完整内容高度
    setFullHeight(list.scrollHeight);
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure, categories.length]);

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
    return () => {
      window.removeEventListener("resize", onResize);
      mo.disconnect();
    };
  }, [measure]);

  // 只有一行时没必要给展开开关
  const collapsible = rowHeight > 0 && fullHeight > rowHeight + 1;

  return (
    <div className="mt-2">
      <div
        ref={listRef}
        className="flex flex-wrap gap-1.5 overflow-hidden"
        style={expanded || !collapsible ? undefined : { maxHeight: rowHeight }}
      >
        <CategoryChip
          active={category === null}
          label="全部"
          onClick={() => onPick(null)}
        />
        {categories.map((c) => (
          <CategoryChip
            key={c.id}
            active={category === c.id}
            label={c.name}
            onClick={() => onPick(c.id)}
          />
        ))}
      </div>
      {collapsible && (
        <div className="mt-1.5 flex justify-end">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {expanded ? "收起" : "展开全部"}
            <ChevronDown
              className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </button>
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
