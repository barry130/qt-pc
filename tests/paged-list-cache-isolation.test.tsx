// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { usePagedList } from "@/hooks/usePagedList";
import {
  clearPagedAllJobs,
  startPagedAllJob,
  type PageResult,
} from "@/lib/paged-all";

/**
 * C06：all 模式的后台任务按 cacheKey 缓存，切换 resetKey 只是退订、任务接着跑。
 * 以前任务每次取数都读 fetchRef/keyRef（每帧指向最新页面的函数），于是 A 页
 * 还没跑完就切到 B 时，A 的后续页会拿 B 的 fetchPage 去拉，结果写进 A 的缓存；
 * 切回 A 看到的是「A1 + B2」。这里用延迟首页把时序固定下来。
 */

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 30));
}

type Fetch = (page: number) => Promise<PageResult<string>>;

let last!: ReturnType<typeof usePagedList<string>>;

function Probe(props: { id: string; fetchPage: Fetch }) {
  last = usePagedList<string>({
    fetchPage: props.fetchPage,
    keyOf: (item) => item,
    resetKey: props.id,
    cacheKey: `daily:${props.id}`,
    pageSize: 1,
    mode: "all",
    maxPages: 4,
  });
  return null;
}

function opts(fetchPage: Fetch) {
  return { fetchPage, keyOf: (item: string) => item, pageSize: 1 };
}

describe("usePagedList 缓存任务隔离", () => {
  afterEach(() => {
    clearPagedAllJobs();
  });

  it("切到别的 key 后，旧 key 的后台任务只用旧 key 的取数函数", async () => {
    const firstPage = deferred<PageResult<string>>();
    const calls: string[] = [];
    const fetchA: Fetch = async (page) => {
      calls.push(`A:${page}`);
      if (page === 1) return firstPage.promise;
      return { list: [`A${page}`], hasMore: false };
    };
    const fetchB: Fetch = async (page) => {
      calls.push(`B:${page}`);
      return { list: [`B${page}`], hasMore: false };
    };

    const view = render(<Probe id="A" fetchPage={fetchA} />);
    await act(settle);
    // A 的首页还挂在预取上时切到 B
    view.rerender(<Probe id="B" fetchPage={fetchB} />);
    await act(settle);
    expect(calls).toEqual(["A:1", "B:1"]);

    // A 的首页这时才回来，还有下一页：后续页必须继续用 A 的取数函数
    await act(async () => {
      firstPage.resolve({ list: ["A1"], hasMore: true });
      await settle;
    });
    expect(calls).toEqual(["A:1", "B:1", "A:2"]);

    expect(startPagedAllJob("daily:A", opts(fetchA)).snapshot().items).toEqual([
      "A1",
      "A2",
    ]);
    expect(startPagedAllJob("daily:B", opts(fetchB)).snapshot().items).toEqual([
      "B1",
    ]);

    // 切回 A：展示的是 A 自己的全量，而不是被 B 的页污染的结果
    view.rerender(<Probe id="A" fetchPage={fetchA} />);
    await act(settle);
    expect(last.items).toEqual(["A1", "A2"]);
    expect(last.finished).toBe(true);
  });

  it("resetKey 回到 A 时复用已收尾的缓存，不重新发请求", async () => {
    const calls: string[] = [];
    const fetchA: Fetch = async (page) => {
      calls.push(`A:${page}`);
      return { list: [`A${page}`], hasMore: page < 2 };
    };
    const fetchB: Fetch = async (page) => {
      calls.push(`B:${page}`);
      return { list: [`B${page}`], hasMore: false };
    };

    const view = render(<Probe id="A" fetchPage={fetchA} />);
    await act(settle);
    expect(calls).toEqual(["A:1", "A:2"]);

    view.rerender(<Probe id="B" fetchPage={fetchB} />);
    await act(settle);
    view.rerender(<Probe id="A" fetchPage={fetchA} />);
    await act(settle);

    expect(last.items).toEqual(["A1", "A2"]);
    expect(calls).toEqual(["A:1", "A:2", "B:1"]);
  });
});
