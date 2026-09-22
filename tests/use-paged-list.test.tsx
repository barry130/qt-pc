// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { usePagedList } from "@/hooks/usePagedList";

/**
 * jsdom 没有 IntersectionObserver：stub 出可控实例，
 * 测试里手动 trigger 模拟「滚到底」。hook 会在 items 变化时重建 observer，
 * 所以每次翻页后 instances 里会多一个新实例。
 */
class FakeIO {
  static instances: FakeIO[] = [];
  private cb: (entries: IntersectionObserverEntry[]) => void;

  constructor(cb: (entries: IntersectionObserverEntry[]) => void) {
    this.cb = cb;
    FakeIO.instances.push(this);
  }

  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  trigger(): void {
    this.cb([
      { isIntersecting: true } as unknown as IntersectionObserverEntry,
    ]);
  }
}

// @ts-expect-error 测试专用 stub，签名是子集
globalThis.IntersectionObserver = FakeIO;

type Probe = ReturnType<typeof usePagedList<string>>;

let last: Probe;

function Probe(props: {
  fetchPage: (p: number) => Promise<string[]>;
  resetKey: string;
  mode?: "scroll" | "all";
}): React.JSX.Element {
  last = usePagedList<string>({
    fetchPage: props.fetchPage,
    keyOf: (s) => s,
    resetKey: props.resetKey,
    // 测试页固定 2 条/页：「满页 = 还有下一页」的推断按这个值走
    pageSize: 2,
    mode: props.mode,
  });
  return <div ref={last.sentinelRef} data-testid="sentinel" />;
}

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 40));
}

describe("usePagedList", () => {
  it("第一页加载后，滚动触发第二页并按 keyOf 去重", async () => {
    const pages: string[][] = [["a1", "a2"], ["a2", "a3"]];
    const fetchPage = vi.fn(async (p: number) => pages[p - 1] ?? []);
    render(<Probe fetchPage={fetchPage} resetKey="k" />);

    await act(settle);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(last.items).toEqual(["a1", "a2"]);
    expect(last.loading).toBe(false);
    expect(last.hasMore).toBe(true);

    // 滚到底 → 拉第二页；a2 与第一页重复，应被去重
    await act(async () => {
      FakeIO.instances[FakeIO.instances.length - 1].trigger();
      await settle;
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(last.items).toEqual(["a1", "a2", "a3"]);
  });

  it("空页视为到底，不再触发下一页", async () => {
    const fetchPage = vi.fn(async () => [] as string[]);
    render(<Probe fetchPage={fetchPage} resetKey="k" />);
    await act(settle);
    expect(last.hasMore).toBe(false);
    await act(async () => {
      FakeIO.instances[FakeIO.instances.length - 1].trigger();
      await settle;
    });
    // hasMore=false 时不建 observer，不会多发请求
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("resetKey 变化回到第一页重拉（且不把旧页追加进来）", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(["p1-a", "p1-b"])
      .mockResolvedValueOnce(["p2-a"])
      .mockResolvedValueOnce(["q1"]);
    const { rerender } = render(<Probe fetchPage={fetchPage} resetKey="A" />);
    await act(settle);
    await act(async () => {
      FakeIO.instances[FakeIO.instances.length - 1].trigger();
      await settle;
    });
    expect(last.items).toEqual(["p1-a", "p1-b", "p2-a"]);

    rerender(<Probe fetchPage={fetchPage} resetKey="B" />);
    await act(settle);
    expect(fetchPage).toHaveBeenLastCalledWith(1);
    expect(last.items).toEqual(["q1"]);
  });

  it("失败后给出错误、不再自动翻页；reload 回第一页重试", async () => {
    const fetchPage = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new Error("网络断了"))
      .mockResolvedValueOnce(["ok"]);
    render(<Probe fetchPage={fetchPage} resetKey="k" />);
    await act(settle);
    expect(last.error).toContain("网络断了");
    expect(last.items).toEqual([]);
    expect(last.hasMore).toBe(false);

    await act(async () => {
      last.reload();
      await settle;
    });
    expect(last.error).toBeNull();
    expect(last.items).toEqual(["ok"]);
  });

  it('all 模式：进页即并发拉完所有页，不满页收尾，不给滚动留 hasMore', async () => {
    // 3 个满页 + 1 个不满页（第 4 页只有 1 条）
    const fetchPage = vi.fn(async (p: number) => {
      if (p <= 3) return [`p${p}-a`, `p${p}-b`];
      if (p === 4) return ["p4-a"];
      return [];
    });
    render(<Probe fetchPage={fetchPage} resetKey="k" mode="all" />);

    await act(settle);
    expect(last.items).toEqual([
      "p1-a",
      "p1-b",
      "p2-a",
      "p2-b",
      "p3-a",
      "p3-b",
      "p4-a",
    ]);
    expect(last.loading).toBe(false);
    // all 模式不做滚动续页：hasMore 恒 false
    expect(last.hasMore).toBe(false);
    // 进度：已拉页数有值，总数未知（接口不给 total）
    expect(last.progress?.done).toBeGreaterThanOrEqual(4);
    expect(last.progress?.total).toBe(null);
    // 不满页即到底：不会再往后拉（并发批次里多探的几页都是空页）
    expect(fetchPage.mock.calls.every(([p]) => p <= 8)).toBe(true);
  });

  it("all 模式：第一页就不满页时只发一次请求", async () => {
    const fetchPage = vi.fn(async () => ["only"]);
    render(<Probe fetchPage={fetchPage} resetKey="k" mode="all" />);
    await act(settle);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(last.items).toEqual(["only"]);
    expect(last.hasMore).toBe(false);
    expect(last.progress).toEqual({ done: 1, total: 1 });
  });
});
