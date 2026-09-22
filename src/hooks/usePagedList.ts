import { useCallback, useEffect, useRef, useState } from "react";
import { errMsg } from "@/lib/utils";

/**
 * 分页列表（滚到底自动追加下一页）。
 *
 * 详情类接口一次只给一页，写死 page=1 的页面就永远只有第一页
 * （歌手页只出 50 首、专辑页只出 50 首都是这个原因）。
 *
 * 约定：
 * - `fetchPage(page)` 页码从 1 开始；返回空数组视为到底
 * - 追加时按 `keyOf` 去重（部分音源分页参数不生效，会重复返回同一页）
 * - `resetKey` 变化（换音源 / 换详情 id）→ 回到第一页重拉
 */
export function usePagedList<T>(options: {
  fetchPage: (page: number) => Promise<T[]>;
  keyOf: (item: T) => string;
  /** 变化即重置（如 `${platform}:${id}`） */
  resetKey: string;
}): {
  items: T[];
  /** 第一页加载中（用于骨架屏） */
  loading: boolean;
  /** 追加下一页加载中（列表底部提示） */
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  /** 挂在列表末尾，进入视口即加载下一页 */
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  reload: () => void;
} {
  const { resetKey } = options;

  // fetchPage / keyOf 多为内联箭头（每次渲染都是新函数），用 ref 读，
  // 否则 effect 依赖它们会无限重跑。
  const fetchRef = useRef(options.fetchPage);
  fetchRef.current = options.fetchPage;
  const keyRef = useRef(options.keyOf);
  keyRef.current = options.keyOf;

  const [cursor, setCursor] = useState({ key: resetKey, page: 1 });
  const [view, setView] = useState<View<T>>(EMPTY_VIEW);

  // resetKey 变化 → 在同一帧里把「键 + 页码 + 视图」一起归位。
  // 放进 effect 会先用旧页码拉一页（还会把第 3 页追加到已清空的列表上）。
  // 这是 React 官方的「渲染期派生 state」写法，会立刻重渲染而不提交中间态。
  if (cursor.key !== resetKey) {
    setCursor({ key: resetKey, page: 1 });
    setView(EMPTY_VIEW);
  }

  useEffect(() => {
    let cancelled = false;
    const first = cursor.page <= 1;
    setView((v) => ({ ...v, loading: true, error: null }));
    void (async () => {
      try {
        const list = await fetchRef.current(cursor.page);
        if (cancelled) return;
        const arr = Array.isArray(list) ? list : [];
        setView((v) => ({
          items: first ? arr : appendUnique(v.items, arr, keyRef.current),
          loading: false,
          error: null,
          // 空页 = 到底；整页都被去重掉也算到底（最多提前认为到底）
          hasMore: arr.length > 0,
        }));
      } catch (err) {
        if (cancelled) return;
        setView((v) => ({
          items: first ? [] : v.items,
          loading: false,
          error: errMsg(err),
          // 出错后不再自动翻页，避免反复失败刷请求；重试走 reload
          hasMore: false,
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cursor]);

  const reload = useCallback(() => {
    setView(EMPTY_VIEW);
    // 新对象 → effect 必跑（即使 page 已经是 1 也能重拉）
    setCursor((c) => ({ ...c, page: 1 }));
  }, []);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const canLoadMore = view.hasMore && !view.loading;

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
    sentinelRef,
    reload,
  };
}

interface View<T> {
  items: T[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
}

const EMPTY_VIEW = { items: [], loading: true, error: null, hasMore: true };

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
