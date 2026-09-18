import { useCallback, useEffect, useRef, useState } from "react";
import { errMsg } from "@/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import type { Video } from "@/types";
import * as sourceApi from "@/source-scripts";
import { useMusicSourceStore } from "@/stores/musicSource";
import { CoverCard, CoverGrid } from "./CoverCard";

/**
 * MV 列表（路由 /mv，DESIGN §5.2）。
 * 跟随全局音源；四源均已实现 videos（wyy /api/mv/all、qq musicu.fcg、kw mvList、kg v5 video/list）。
 *
 * 列表是**下拉加载**（滚到底自动追加下一页），不再手动翻页。
 * qq 等音源的分页参数可能不生效会重复返回，追加时按 id 去重；
 * 一页全是被去重掉的旧数据也没关系，最多是提前认为到底。
 */
export function MvPage(): React.JSX.Element {
  const navigate = useNavigate();
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);

  const [items, setItems] = useState<Video[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);

  // 音源切换 → 回到第一页重新拉
  useEffect(() => {
    setPage(1);
    setItems([]);
    setHasMore(true);
  }, [activeSourceId]);

  const load = useCallback(
    async (p: number): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const list = await sourceApi.getVideos(activeSourceId, p, 30);
        const arr = Array.isArray(list) ? list : [];
        setItems((prev) => {
          if (p <= 1) return arr;
          const seen = new Set(prev.map((x) => `${x.platform}:${x.id}`));
          return [...prev, ...arr.filter((x) => !seen.has(`${x.platform}:${x.id}`))];
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
    void load(page);
  }, [page, load]);

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

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <h1 className="text-base font-medium">MV</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          当前音源的 MV 列表
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <div className="py-10 text-center text-sm text-destructive">
            加载失败：{error}
          </div>
        ) : !loading && items.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            暂无 MV
          </div>
        ) : (
          <>
            <CoverGrid>
              {items.map((v) => (
                <CoverCard
                  key={`${v.platform}-${v.id}`}
                  name={v.name}
                  picUrl={v.picUrl}
                  subtitle={v.singer}
                  onClick={() =>
                    void navigate({
                      to: "/mv/$platform/$id",
                      params: { platform: v.platform, id: v.id },
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