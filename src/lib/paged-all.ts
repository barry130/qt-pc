import { errMsg } from "@/lib/utils";

/**
 * 「进页一次拉完」的全量取数：跑在 React 之外，结果按 key 缓存到本次退出。
 *
 * 为什么搬出 hook：
 * - 取数一旦跟着组件卸载一起取消，来回切歌手页就要重头再拉一遍几千首；
 *   这里把任务挂在模块上，组件卸载只是退订，**任务继续跑到收尾**，
 *   下次进同一个 key 直接拿到全量（用户体感：第二次进页是瞬时的）。
 * - 进度（`progress`）与「是否收尾」（`finished`）由任务自己维护，
 *   结束一定置 `finished`，页面据此收掉进度条 —— 以前只看 `progress !== null`，
 *   拉完也永远停不掉（用户看到的就是「条数不涨了，但一直在加载」）。
 *
 * 只缓存到进程退出（不做持久化）：歌曲对象是活的、且带播放态引用，
 * 落盘没有意义；退出即随 WebView 一起回收。
 */

/** 一页的返回：只有列表，或列表 + 是否还有下一页（拿不到就按「满页 = 还有」推断） */
export type PageResult<T> = T[] | { list: T[]; hasMore: boolean };

export function splitPage<T>(
  result: PageResult<T>,
  size: number,
): { list: T[]; hasMore: boolean } {
  if (Array.isArray(result)) {
    return { list: result, hasMore: result.length >= size };
  }
  const list = Array.isArray(result.list) ? result.list : [];
  return { list, hasMore: result.hasMore };
}

/**
 * 追加去重。`seen` 由调用方传入并**就地更新**（其中包含 `prev` 的全部 key）：
 * 每追加一页都 `new Set(prev.map(keyOf))` 全量重建，在几十页 × 几十条的规模下
 * 是纯粹的 O(n²) 重复扫描。
 *
 * 万一 `seen` 与 `prev` 对不上（理论不该发生：列表只经这里合并），按 prev 重建一次，
 * 保证结果永远正确——宁可多扫一次，也不能漏去重或放进重复项。
 */
export function appendUnique<T>(
  prev: T[],
  next: T[],
  keyOf: (item: T) => string,
  seen: Set<string>,
): T[] {
  if (seen.size !== prev.length) {
    seen.clear();
    for (const item of prev) seen.add(keyOf(item));
  }
  const out = [...prev];
  for (const item of next) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 缓存任务上限（LRU）：一个歌手全量可能上千首，别把内存吃干 */
export const PAGED_ALL_JOB_CAP = 16;

export interface PagedAllState<T> {
  items: T[];
  /** 首屏加载中（用于骨架屏）：一页都没拿到时为 true */
  loading: boolean;
  error: string | null;
  /** 已完成页数 / 已知总页数（上游不给 total 时为 null） */
  progress: { done: number; total: number | null } | null;
  /** 是否收尾（正常到底 / 出错 / 触及上限）。拉完仍为 false 说明还在跑 */
  finished: boolean;
}

type Listener<T> = (state: PagedAllState<T>) => void;

export interface PagedAllOptions<T> {
  fetchPage: (page: number) => Promise<PageResult<T>>;
  keyOf: (item: T) => string;
  /** 每页条数：数组返回时用它判断「满页 = 可能还有下一页」 */
  pageSize: number;
  /** 并发在飞请求数，默认 6 */
  concurrency?: number;
  /** 页数上限（安全阀），默认 120 */
  maxPages?: number;
}

export interface PagedAllJob<T> {
  snapshot(): PagedAllState<T>;
  /** 订阅；回调会立刻收到当前状态。返回退订函数 */
  subscribe(fn: Listener<T>): () => void;
  /** 不再需要这个任务（组件卸载且不复用）：后续页不再发请求 */
  cancel(): void;
}

const EMPTY_STATE: PagedAllState<never> = {
  items: [],
  loading: true,
  error: null,
  progress: null,
  finished: false,
};

interface Job<T> extends PagedAllJob<T> {
  key: string;
  state: PagedAllState<T>;
  listeners: Set<Listener<T>>;
  cancelled: boolean;
}

/** key → 任务。只在给了 cacheKey 时登记（没有 cacheKey 的任务是一次性的，不进表） */
const jobs = new Map<string, Job<unknown>>();

/**
 * 建一个不登记的一次性任务：进程里没有别人会用到它的结果
 * （没给 cacheKey 的调用方），卸载即取消，不留残骸。
 */
export function createPagedAllJob<T>(options: PagedAllOptions<T>): PagedAllJob<T> {
  return startJob<T>(`local:${jobSeq++}`, options, false);
}

/** 取（或新建）一个按 key 复用的任务：组件卸载后继续跑完，结果缓存到退出 */
export function startPagedAllJob<T>(key: string, options: PagedAllOptions<T>): PagedAllJob<T> {
  return startJob<T>(key, options, true);
}

/** 只看缓存里有没有（不新建）：判断「这次进页能否直接命中」 */
export function peekPagedAllJob(key: string): boolean {
  return jobs.has(key);
}

/** 丢弃某个 key 的缓存（reload 时用：用户要的是重拉，不是拿回旧结果） */
export function clearPagedAllJob(key: string): void {
  const hit = jobs.get(key);
  if (hit === undefined) return;
  hit.cancelled = true;
  jobs.delete(key);
}

/** 清空全部缓存任务（测试用 / 切账号等场景） */
export function clearPagedAllJobs(): void {
  for (const job of jobs.values()) job.cancelled = true;
  jobs.clear();
}

let jobSeq = 0;

function startJob<T>(key: string, options: PagedAllOptions<T>, cached: boolean): PagedAllJob<T> {
  if (cached) {
    const hit = jobs.get(key) as Job<T> | undefined;
    if (hit !== undefined) {
      // LRU：命中的挪到末尾，淘汰时先淘汰最久没用的
      jobs.delete(key);
      jobs.set(key, hit as unknown as Job<unknown>);
      return hit;
    }
  }
  const job: Job<T> = {
    key,
    state: { ...EMPTY_STATE as PagedAllState<T> },
    listeners: new Set(),
    cancelled: false,
    snapshot: () => job.state,
    subscribe(fn) {
      job.listeners.add(fn);
      fn(job.state);
      return () => {
        job.listeners.delete(fn);
        // 一次性任务没人听了就没意义，顺手取消（缓存任务要留着跑完）
        if (!cached && job.listeners.size === 0) job.cancelled = true;
      };
    },
    cancel() {
      job.cancelled = true;
    },
  };
  if (cached) {
    jobs.set(key, job as unknown as Job<unknown>);
    trimJobs();
  }
  void runJob(job, options);
  return job;
}

function trimJobs(): void {
  while (jobs.size > PAGED_ALL_JOB_CAP) {
    const oldest = jobs.keys().next().value;
    if (oldest === undefined) break;
    const drop = jobs.get(oldest);
    if (drop !== undefined) drop.cancelled = true;
    jobs.delete(oldest);
  }
}

async function runJob<T>(job: Job<T>, options: PagedAllOptions<T>): Promise<void> {
  const { fetchPage, keyOf } = options;
  const concurrency = options.concurrency ?? 6;
  const maxPages = options.maxPages ?? 120;
  const pageSize = options.pageSize;

  let done = 0;
  let total: number | null = null;
  let failed: string | null = null;
  let acc: T[] = [];
  let seen = new Set<string>();

  const publish = (): void => {
    job.state = {
      items: acc,
      loading: done === 0,
      error: failed,
      progress: { done, total },
      finished: job.state.finished,
    };
    for (const fn of [...job.listeners]) fn(job.state);
  };

  try {
    // 第 1 页单独拉：既拿首屏（立刻出列表），也用它判「还有没有下一页」
    const firstPage = splitPage(await fetchPage(1), pageSize);
    if (job.cancelled) return;
    acc = firstPage.list;
    seen = new Set(acc.map(keyOf));
    done = 1;
    total = firstPage.hasMore ? null : 1;
    publish();
    if (!firstPage.hasMore) return finish();

    const secondPage = splitPage(await fetchPage(2), pageSize);
    if (job.cancelled) return;
    const before = acc.length;
    acc = appendUnique(acc, secondPage.list, keyOf, seen);
    done = 2;
    publish();
    // 上游翻页失效时会一直返回同一页：这一页一条都没新增就别再往下探，
    // 否则要空转到 maxPages（用户看到的就是「条数不变但一直在转」）。
    if (!secondPage.hasMore || acc.length === before) return finish();

    let nextPage = 3;
    while (nextPage <= maxPages) {
      const batch: number[] = [];
      for (let i = 0; i < concurrency && nextPage <= maxPages; i++) batch.push(nextPage++);
      const settled = await Promise.all(
        batch.map(async (page) => {
          try {
            return { page, result: await fetchPage(page) };
          } catch {
            return { page, result: null };
          }
        }),
      );
      if (job.cancelled) return;

      let added = 0;
      let stop = false;
      for (const entry of settled) {
        if (entry.result === null) {
          failed = "部分页加载失败，列表可能不完整";
          stop = true;
          continue;
        }
        const pageData = splitPage(entry.result, pageSize);
        const prevLen = acc.length;
        acc = appendUnique(acc, pageData.list, keyOf, seen);
        added += acc.length - prevLen;
        done++;
        // 每拿完一页就发一次：并发 6 页在飞期间条数也要往上走
        publish();
        if (!pageData.hasMore || pageData.list.length === 0) {
          stop = true;
          // 这一页之后的批次内页**不能再并入**：本页已经是尾页，后面的页是同一批
          // 并发发出去的「越界页」，它们的内容属于列表之外（对过滤型歌手列表来说
          // 就是别的歌手的搜索结果）。以前继续并入，导致同一歌手改并发数就改显示
          // 条数（QQ 周杰伦：并发 6 → 768 首）。
          break;
        }
      }
      if (stop || added === 0) break;
    }
    finish();
  } catch (err) {
    failed = errMsg(err);
    finish();
  }

  function finish(): void {
    job.state = {
      items: acc,
      loading: false,
      error: failed,
      progress: { done, total },
      finished: true,
    };
    for (const fn of [...job.listeners]) fn(job.state);
  }
}
