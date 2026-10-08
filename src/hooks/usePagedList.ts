import { useCallback, useEffect, useRef, useState } from "react";
import { errMsg } from "@/lib/utils";
import {
  appendUnique,
  clearPagedAllJob,
  createPagedAllJob,
  splitPage,
  startPagedAllJob,
  type PagedAllState,
  type PageResult,
} from "@/lib/paged-all";

// 分页原语（PageResult / splitPage / appendUnique）与 all 模式的取数任务都住在
// @/lib/paged-all：任务要能在组件卸载后继续跑完并缓存，不能挂在 hook 生命周期上。
// 这里再导出一次，页面侧不用改 import。
export type { PageResult } from "@/lib/paged-all";

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
  /**
   * all 模式的缓存键（如 `artist:kw:周杰伦:50:`）。
   * 给了就按 key 复用任务：组件卸载后后台继续跑完，下次进同页直接拿全量；
   * reload 会丢掉这个 key 重拉。不给就一次性（卸载即取消）。
   */
  cacheKey?: string;
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
  /** all 模式是否收尾。进度条/「正在加载其余」必须看它，光看 progress 收不掉 */
  finished: boolean;
  /** 挂在列表末尾，进入视口即加载下一页（仅 scroll 模式有意义） */
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  reload: () => void;
} {
  const { resetKey, mode = "scroll", pageSize } = options;
  const isAll = mode === "all";

  // fetchPage / keyOf 多为内联箭头（每次渲染都是新函数），用 ref 读，
  // 否则 effect 依赖它们会无限重跑。
  //
  // ref 的同步放在 **effect** 里、且声明在取数 effect 之前：渲染期写 ref 在并发
  // 渲染下会写坏——一次被丢弃的渲染照样会执行函数体，把 ref 指向"不存在的那次
  // 渲染"的闭包。effect 按声明顺序执行，所以取数 effect 读到的总是最新值。
  const fetchRef = useRef(options.fetchPage);
  const keyRef = useRef(options.keyOf);
  const sizeRef = useRef(pageSize);
  const concurrency = options.concurrency ?? 6;
  const maxPages = options.maxPages ?? 120;
  const cacheKey = options.cacheKey;
  const cacheKeyRef = useRef(cacheKey);
  useEffect(() => {
    cacheKeyRef.current = options.cacheKey;
    fetchRef.current = options.fetchPage;
    keyRef.current = options.keyOf;
    sizeRef.current = pageSize;
  });

  const [cursor, setCursor] = useState({ key: resetKey, page: 1, nonce: 0 });
  const [view, setView] = useState<View<T>>(EMPTY_VIEW);

  // 已合并列表 + 已见 key 的镜像：appendUnique 复用同一个 Set，
  // 避免"每追加一页就 new Set(prev.map(keyOf)) 全量重建"（O(n²)）。
  const itemsRef = useRef<T[]>([]);
  const seenRef = useRef<Set<string>>(new Set());

  // resetKey 变化 → 在同一帧里把「键 + 页码 + 视图」一起归位。
  // 放进 effect 会先用旧页码拉一页（还会把第 3 页追加到已清空的列表上）。
  // 这是 React 官方文档里的「渲染期派生 state」写法（adjusting state when props
  // change）：同一个组件内渲染期 setState 不会提交中间态，React 会立刻用新 state
  // 重渲染。这里同步写两个 ref 也是安全的——它们只描述"归位"这一确定结果，
  // 不依赖本次渲染的数据；就算这次渲染被丢弃，下次渲染还会再判一次同样的条件。
  if (cursor.key !== resetKey) {
    setCursor({ key: resetKey, page: 1, nonce: cursor.nonce + 1 });
    setView(EMPTY_VIEW);
    itemsRef.current = [];
    seenRef.current = new Set();
  }

  useEffect(() => {
    let cancelled = false;
    const first = cursor.page <= 1;
    setView((v) => (first ? { ...EMPTY_VIEW } : { ...v, loading: true, error: null }));

    if (isAll && first) {
      // all 模式交给模块级任务（@/lib/paged-all）：卸载只退订，任务继续跑到收尾
      // 并按 cacheKey 缓存到退出 —— 来回切歌手页不再从头重拉几千首。
      const opts = {
        fetchPage: (p: number) => fetchRef.current(p),
        keyOf: (item: T) => keyRef.current(item),
        pageSize: sizeRef.current,
        concurrency,
        maxPages,
      };
      const job =
        cacheKey !== undefined && cacheKey.length > 0
          ? startPagedAllJob<T>(cacheKey, opts)
          : createPagedAllJob<T>(opts);
      const unsubscribe = job.subscribe((s) =>
        setView({ ...s, hasMore: false }),
      );
      return () => {
        unsubscribe();
      };
    }

    void (async () => {
      try {
        const result = await fetchRef.current(cursor.page);
        if (cancelled) return;
        const { list, hasMore } = splitPage(result, sizeRef.current);
        const keyOf = keyRef.current;
        if (first) {
          itemsRef.current = list;
          seenRef.current = new Set(list.map(keyOf));
        } else {
          itemsRef.current = appendUnique(
            itemsRef.current,
            list,
            keyOf,
            seenRef.current,
          );
        }
        setView({
          items: itemsRef.current,
          loading: false,
          error: null,
          hasMore,
          progress: null,
          finished: true,
        });
      } catch (err) {
        if (cancelled) return;
        if (first) {
          itemsRef.current = [];
          seenRef.current = new Set();
        }
        setView({
          items: itemsRef.current,
          loading: false,
          error: errMsg(err),
          // 出错后不再自动翻页，避免反复失败刷请求；重试走 reload
          hasMore: false,
          progress: null,
          finished: true,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
    // cursor.nonce 让 reload() 即使页码没变也能重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor.key, cursor.page, cursor.nonce, isAll, cacheKey]);

  const reload = useCallback(() => {
    setView(EMPTY_VIEW);
    itemsRef.current = [];
    seenRef.current = new Set();
    // all 模式：缓存任务必须一起丢掉，否则「重试」会立刻拿回旧结果
    if (cacheKeyRef.current !== undefined && cacheKeyRef.current.length > 0) {
      clearPagedAllJob(cacheKeyRef.current);
    }
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
    finished: view.finished,
    sentinelRef,
    reload,
  };
}

interface View<T> extends PagedAllState<T> {
  hasMore: boolean;
}

/**
 * 空视图：items 用 never[]，对任意 View<T> 都可赋值。
 *
 * `hasMore: false`（原本是 true）：重置后的首帧不该声称"还有下一页"——
 * 那会让哨兵 observer 在数据还没到时先挂上，且底部提示会闪一下"还有更多"。
 */
const EMPTY_VIEW: View<never> = {
  items: [],
  loading: true,
  error: null,
  hasMore: false,
  progress: null,
  finished: false,
};
