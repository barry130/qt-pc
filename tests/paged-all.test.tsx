// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { usePagedList, type PageResult } from "@/hooks/usePagedList";
import { clearPagedAllJobs, createPagedAllJob } from "@/lib/paged-all";

/**
 * 全量取数（all 模式）的两条硬要求：
 * 1. 拉完必须收尾（finished），否则页面的进度条/「正在加载其余」永远停不掉；
 * 2. 卸载后任务继续跑完并缓存，第二次进同页直接拿到全量。
 */

class FakeIO {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

// @ts-expect-error 测试专用 stub，签名是子集
globalThis.IntersectionObserver = FakeIO;

type Probe = ReturnType<typeof usePagedList<string>>;

let last: Probe;

function Probe(props: {
  fetchPage: (p: number) => Promise<PageResult<string>>;
  resetKey: string;
  cacheKey?: string;
  maxPages?: number;
}): React.JSX.Element {
  last = usePagedList<string>({
    fetchPage: props.fetchPage,
    keyOf: (s) => s,
    resetKey: props.resetKey,
    pageSize: 2,
    mode: "all",
    cacheKey: props.cacheKey,
    maxPages: props.maxPages,
  });
  return <div ref={last.sentinelRef} data-testid="sentinel" />;
}

function settle(ms = 40): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

afterEach(() => {
  cleanup();
  clearPagedAllJobs();
});

describe("usePagedList all 模式收尾", () => {
  it("拉完后 finished 为 true（进度条能收掉，不再一直转）", async () => {
    const fetchPage = vi.fn(async (p: number) => {
      if (p <= 3) return [`p${p}-a`, `p${p}-b`];
      if (p === 4) return ["p4-a"];
      return [];
    });
    render(<Probe fetchPage={fetchPage} resetKey="k" />);
    await act(settle);
    expect(last.items).toHaveLength(7);
    expect(last.finished).toBe(true);
    expect(last.loading).toBe(false);
  });

  it("上游翻页失效（一直返回同一页）时及时收尾，不空转到 maxPages", async () => {
    // 每页都满页且内容完全相同：去重后一条都不新增
    const fetchPage = vi.fn(async () => ["same-a", "same-b"]);
    render(<Probe fetchPage={fetchPage} resetKey="k" maxPages={60} />);
    await act(settle);
    // 拉到第 2 页发现零新增就停，不会打满 60 页
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(last.items).toEqual(["same-a", "same-b"]);
    expect(last.finished).toBe(true);
  });

  it("包给了 hasMore=false 就按它收尾：条数不齐的过滤型列表不会被提前截断", async () => {
    // 歌手作品是「按名搜一批再按歌手 id 过滤」的过滤型列表，逐页条数天然不齐
    // （实测 QQ 周杰伦 100/90/96/93/…）。pageSize=2 时第 2 页只有 1 条，
    // 但包说还有 → 必须继续翻；第 4 页包说没了 → 停在这里。
    const fetchPage = vi.fn(async (p: number): Promise<PageResult<string>> => {
      const pages: string[][] = [["a1", "a2"], ["b1"], ["c1", "c2"], ["d1"]];
      return { list: pages[p - 1] ?? [], hasMore: p < 4 };
    });
    render(<Probe fetchPage={fetchPage} resetKey="k" />);
    await act(settle);
    expect(last.items).toEqual(["a1", "a2", "b1", "c1", "c2", "d1"]);
    expect(last.finished).toBe(true);
  });

  it("同一批并发里出现尾页后，后续越界页不再并入（换并发数不改条数）", async () => {
    // 第 4 页是尾页（hasMore=false），第 5/6 页是同批并发已飞出去的越界页：
    // 它们的内容属于列表之外（对歌手页就是别的歌手的搜索结果），不能并入。
    const fetchPage = vi.fn(async (p: number): Promise<PageResult<string>> => {
      if (p <= 3) return { list: [`p${p}-a`, `p${p}-b`], hasMore: true };
      if (p === 4) return { list: ["last"], hasMore: false };
      return { list: [`overshoot-${p}`], hasMore: true };
    });
    const job = createPagedAllJob<string>({
      fetchPage,
      keyOf: (s) => s,
      pageSize: 2,
      concurrency: 6,
      maxPages: 60,
    });
    job.subscribe(() => {});
    await settle(120);
    expect(job.snapshot().items).toEqual(["p1-a", "p1-b", "p2-a", "p2-b", "p3-a", "p3-b", "last"]);
    expect(job.snapshot().finished).toBe(true);
  });

  it("并发批次里每拿完一页就刷新一次，条数逐步上涨", async () => {
    // 直接订阅任务：React 在 act 里会把多次 setState 合成一次提交，
    // 组件的渲染次数看不出「逐页刷新」，订阅回调可以。
    const seenCounts: number[] = [];
    const fetchPage = vi.fn(async (p: number) => {
      // 第 3~5 页慢一点，让同一批并发的页先后完成
      await new Promise((r) => setTimeout(r, p >= 3 && p <= 5 ? 15 : 1));
      return p <= 6 ? [`p${p}-a`, `p${p}-b`] : [];
    });
    const job = createPagedAllJob<string>({
      fetchPage,
      keyOf: (s) => s,
      pageSize: 2,
      concurrency: 6,
      maxPages: 60,
    });
    job.subscribe((s) => {
      seenCounts.push(s.items.length);
    });
    await settle(160);
    // 最终 12 条
    expect(job.snapshot().items).toHaveLength(12);
    expect(job.snapshot().finished).toBe(true);
    // 中途出现过「部分条数」（逐页刷新），而不是整批完成后一次性蹦出全部
    expect(seenCounts.some((n) => n > 0 && n < 12)).toBe(true);
    expect(seenCounts[seenCounts.length - 1]).toBe(12);
  });
});

describe("usePagedList all 模式缓存", () => {
  it("卸载后任务继续跑完；再次挂载同 key 直接拿全量，不再发请求", async () => {
    // 每页都慢一点，保证卸载发生在「还没拉完」的中途
    const fetchPage = vi.fn(async (p: number) => {
      await new Promise((r) => setTimeout(r, 15));
      if (p <= 3) return [`p${p}-a`, `p${p}-b`];
      return ["p4-a"];
    });
    const first = render(<Probe fetchPage={fetchPage} resetKey="k" cacheKey="artist:kw:x:2" />);
    // 只等第一页就卸载（模拟「看一眼就切走」）
    await act(async () => {
      await settle(5);
    });
    first.unmount();
    const callsAtUnmount = fetchPage.mock.calls.length;
    expect(callsAtUnmount).toBeLessThan(4);

    // 卸载后后台继续跑完（4 页：3 个满页 + 1 个不满页）
    await act(async () => {
      await settle(200);
    });
    // 并发批次会多探几页（第 3 页起按 6 并发发一批），条数到 7 就收尾
    expect(fetchPage.mock.calls.length).toBeGreaterThanOrEqual(4);
    const callsAfterBackground = fetchPage.mock.calls.length;

    // 再次进页：命中缓存，一条请求都不再发
    render(<Probe fetchPage={fetchPage} resetKey="k" cacheKey="artist:kw:x:2" />);
    await act(async () => {
      await settle(20);
    });
    expect(fetchPage).toHaveBeenCalledTimes(callsAfterBackground);
    expect(last.items).toHaveLength(7);
    expect(last.finished).toBe(true);
  });

  it("reload 丢掉缓存重拉（不是拿回旧结果）", async () => {
    const fetchPage = vi
      .fn(async (p: number) => (p <= 1 ? ["a", "b"] : ["c"]));
    render(<Probe fetchPage={fetchPage} resetKey="k" cacheKey="artist:kw:y:2" />);
    await act(settle);
    expect(last.items).toEqual(["a", "b", "c"]);
    const before = fetchPage.mock.calls.length;

    await act(async () => {
      last.reload();
      await settle(60);
    });
    expect(fetchPage.mock.calls.length).toBeGreaterThan(before);
    expect(last.items).toEqual(["a", "b", "c"]);
    expect(last.finished).toBe(true);
  });

  it("换 key 不复用：不同歌手各自拉", async () => {
    const fetchPage = vi.fn(async (_p: number) => ["only"]);
    const first = render(<Probe fetchPage={fetchPage} resetKey="a" cacheKey="artist:kw:a:2" />);
    await act(settle);
    first.unmount();
    render(<Probe fetchPage={fetchPage} resetKey="b" cacheKey="artist:kw:b:2" />);
    await act(settle);
    // 两次各自拉第一页
    expect(fetchPage.mock.calls.filter(([p]) => p === 1)).toHaveLength(2);
  });
});
