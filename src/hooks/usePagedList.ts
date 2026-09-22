import { useCallback, useEffect, useRef, useState } from "react";
import { errMsg } from "@/lib/utils";

/** 一页的返回：只有列表，或列表 + 是否还有下一页（拿不到就按「满页 = 还有」推断） */
export type PageResult<T> = T[] | { list: T[]; hasMore: boolean };

function splitPage<T>(result: PageResult<T>, size: number): { list: T[]; hasMore: boolean } {
  if (Array.isArray(result)) {
    return { list: result, hasMore: result.length >= size };
  }
  const list = Array.isArray(result.list) ? result.list : [];
  return { list, hasMore: result.hasMore };
}

/**
 * 分页列表。两种收尾方式，由 `mode` 决定：
 *
 * - `"scroll"`（默认）：滚到底自动追加下一页（哨兵 + IntersectionObserver）
 * - `"all"`  ：进入即**并发把所有页拉完**，不做滚动续页，带进度
 *
 * 详情类接口一次只给一页，写死 page=1 的页面就永远只有第一页
 * （歌手页只出 50 首、专辑页只出 50 首都是这个原因）。
 *
 * 约定：
 * - `fetchPage(page)` 页码从 1 开始；返回空数组（或 hasMore=false）视为到底
 * - 追加时按 `keyOf` 去重（部分音源分页参数不生效，会重复返回同一页）
 * - `resetKey` 变化（换音源 / 换详情 id / 换字母档）→ 回到第一页重拉
 *
 * all 模式的并发与上限：`concurrency` 控制同时在飞的请求数（默认 6，别调太高，
 * 上游对同 IP 突发有限流），`maxPages` 是安全阀——上游报的 total 不可信时
 * （酷狗总量 265 万），没有上限会一直拉下去。
 */
export function usePagedList<T>(options: {
  fetchPage: (page: number) => Promise<PageResult<T>>;
  keyOf: (item: T) => string;
  /** 变化即重置（如 `${platform}:${id}`） */
  resetKey: string;
  /** 每页条数：数组返回时用它判断「满页 = 可能还有下一页」 */
  pageSize: number;
  mode?: "scroll" | "all";
  /** all 模式的并发数，默认 6 */
  concurrency?: number;
  /** all 模式的页数上限（安全阀），默认 120 页 */
  maxPages?: number;
}): {
  items: T[];
  /** 首屏加载中（用于骨架屏）；all 模式在整轮拉完前都为 true */
  loading: boolean;
  /** 追加/后台补页中（列表底部提示） */
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  /** all 模式进度：已完成页数 / 已知总页数（总页数未知时为 null） */
  progress: { done: number; total: number | null } | null;
  /** 挂在列表末尾，进入视口即加载下一页（仅 scroll 模式有意义） */
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  reload: () => void;
} {
  const { resetKey, mode = "scroll", pageSize } = options;

  // fetchPage / keyOf 多为内联箭头（每次渲染都是新函数），用 ref 读，
  // 否则 effect 依赖它们会无限重跑。
  const fetchRef = useRef(options.fetchPage);
  fetchRef.current = options.fetchPage;
  const keyRef = useRef(options.keyOf);
  keyRef.current = options.keyOf;
  const sizeRef = useRef(pageSize);
  sizeRef.current = pageSize;
  const concurrency = options.concurrency ?? 6;
  const maxPages = options.maxPages ?? 120;

  const [cursor, setCursor] = useState({ key: resetKey, page: 1, nonce: 0 });
  const [view, setView] = useState<View<T>>(EMPTY_VIEW);

  // resetKey 变化 → 在同一帧里把「键 + 页码 + 视图」一起归位。
  // 放进 effect 会先用旧页码拉一页（还会把第 3 页追加到已清空的列表上）。
  // 这是 React 官方的「渲染期派生 state」写法，会立刻重渲染而不提交中间态。
  if (cursor.key !== resetKey) {
    setCursor({ key: resetKey, page: 1, nonce: cursor.nonce + 1 });
    setView(EMPTY_VIEW);
  }

  useEffect(() => {
    let cancelled = false;
    const first = cursor.page <= 1;
    setView((v) => (first ? { ...EMPTY_VIEW } : { ...v, loading: true, error: null }));

    if (mode === "all" && first) {
      void fetchAllPages();
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const result = await fetchRef.current(cursor.page);
        if (cancelled) return;
        const { list, hasMore } = splitPage(result, sizeRef.current);
        setView((v) => ({
          items: first ? list : appendUnique(v.items, list, keyRef.current),
          loading: false,
          error: null,
          hasMore,
          progress: null,
        }));
      } catch (err) {
        if (cancelled) return;
        setView((v) => ({
          items: first ? [] : v.items,
          loading: false,
          error: errMsg(err),
          // 出错后不再自动翻页，避免反复失败刷请求；重试走 reload
          hasMore: false,
          progress: null,
        }));
      }
    })();

    /**
     * all 模式：并发把 1..N 页全部拉完。
     *
     * 先单独拉第 1 页：拿到 total 才知道要拉多少页（且首屏能立刻显示）。
     * 之后按 concurrency 分片并发，每完成一页就增量合并 + 更新进度，
     * 用户能看到「已加载 3200/9204」而不是干等。
     * 任何一页失败：已拿到的照常显示，只记错误提示，不再往后加页。
     */
    async function fetchAllPages(): Promise<void> {
      let done = 0;
      let total: number | null = null;
      let acc: T[] = [];
      let failed: string | null = null;

      const publish = (): void => {
        setView({
          items: acc,
          loading: done === 0,
          error: failed,
          hasMore: false,
          progress: { done, total },
        });
      };

      try {
        const firstResult = await fetchRef.current(1);
        if (cancelled) return;
        const firstPage = splitPage(firstResult, sizeRef.current);
        acc = firstPage.list;
        done = 1;
        total = firstPage.hasMore ? null : 1;
        publish();

        if (firstPage.hasMore) {
          // 最后一页不满 = 到底；先探测第 2 页决定还要不要继续
          const second = await fetchRef.current(2);
          if (cancelled) return;
          const secondPage = splitPage(second, sizeRef.current);
          acc = appendUnique(acc, secondPage.list, keyRef.current);
          done = 2;
          publish();

          if (secondPage.hasMore) {
            // 总数未知（契约只给 hasMore）：按 maxPages 上限一直拉，直到空页或不满页
            let nextPage = 3;
            while (!cancelled && nextPage <= maxPages) {
              const batch: number[] = [];
              for (let i = 0; i < concurrency && nextPage <= maxPages; i++) {
                batch.push(nextPage++);
              }
              const settled = await Promise.all(
                batch.map(async (page) => {
                  try {
                    return { page, result: await fetchRef.current(page) };
                  } catch {
                    return { page, result: null };
                  }
                }),
              );
              if (cancelled) return;
              let exhausted = false;
              for (const entry of settled) {
                if (entry.result === null) {
                  failed = "部分页加载失败，列表可能不完整";
                  exhausted = true;
                  continue;
                }
                const page = splitPage(entry.result, sizeRef.current);
                acc = appendUnique(acc, page.list, keyRef.current);
                done++;
                if (!page.hasMore || page.list.length === 0) exhausted = true;
              }
              publish();
              if (exhausted) break;
            }
          }
        }
      } catch (err) {
        if (cancelled) return;
        failed = errMsg(err);
      }
      if (cancelled) return;
      publish();
    }

    return () => {
      cancelled = true;
    };
    // cursor.nonce 让 reload() 即使页码没变也能重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor.key, cursor.page, cursor.nonce, mode]);

  const reload = useCallback(() => {
    setView(EMPTY_VIEW);
    // nonce 自增 → effect 必跑（即使 page 已经是 1 也能重拉）
    setCursor((c) => ({ ...c, page: 1, nonce: c.nonce + 1 }));
  }, []);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const canLoadMore = mode === "scroll" && view.hasMore && !view.loading;

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !canLoadMore) return;
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setCursor((c) => ({ ...c, page: c.page + 1 }));
        }
      },
      // 提前一屏触发，滚到底时通常已经加载好了
      { rootMargin: "240px" },
    );
    io.observe(el);
    return () => io.disconnect();
    // items.length 变化时重建 observer：新 observer 会立刻回调一次当前相交状态，
    // 因此「首页不满一屏」时也能继续把后续页拉进来，不会卡住。
  }, [canLoadMore, view.items.length]);

  return {
    items: view.items,
    loading: view.loading && cursor.page <= 1,
    loadingMore: view.loading && cursor.page > 1,
    error: view.error,
    hasMore: view.hasMore,
    progress: view.progress,
    sentinelRef,
    reload,
  };
}

interface View<T> {
  items: T[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  progress: { done: number; total: number | null } | null;
}

/** 空视图：items 用 never[]，对任意 View<T> 都可赋值 */
const EMPTY_VIEW: View<never> = {
  items: [],
  loading: true,
  error: null,
  hasMore: true,
  progress: null,
};

function appendUnique<T>(
  prev: T[],
  next: T[],
  keyOf: (item: T) => string,
): T[] {
  const seen = new Set(prev.map(keyOf));
  const out = [...prev];
  for (const item of next) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
