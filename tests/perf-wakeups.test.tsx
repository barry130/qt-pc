// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInterpolatedPosition } from "@/hooks/useInterpolatedPosition";
import { usePlayerStore } from "@/stores/player";

/**
 * 锁住 2026-10-30 的资源优化：进度插值不再跑 60fps 的 rAF 循环，而是按量化步长
 * （QUANTUM_MS = 100ms）定时推进。
 *
 * 为什么值得一条测试：这处改动没有可见效果（量化值本来就只有 10 次/秒会变），
 * 唯一的收益是每秒唤醒次数从 60 降到 10 —— 而播放条 / 播放页 / 迷你播放器各有一份
 * 实例。谁哪天「顺手改回 requestAnimationFrame 更丝滑」，CPU 会静悄悄涨回去，
 * 肉眼和现有测试都发现不了，所以这里直接锁住调度方式。
 */

const QUANTUM_MS = 100;

function Probe(): React.JSX.Element {
  const ms = useInterpolatedPosition();
  return <span data-testid="pos">{ms}</span>;
}

function seedPlaying(): void {
  usePlayerStore.setState({
    state: { status: "playing" } as never,
    positionAnchorMs: 0,
    positionAnchorValue: 0,
    durationMs: 0,
    isDraggingProgress: false,
    // 用可控的假时钟替掉真实插值：每次被问到就前进一个量子步长，
    // 这样「循环有没有真的在按步长推进」可以被观察到。
    interpolatedPositionMs: () => {
      const prev = calls;
      calls += 1;
      return prev * QUANTUM_MS;
    },
  });
}

let calls = 0;

describe("进度插值的调度方式（资源优化）", () => {
  beforeEach(() => {
    calls = 0;
    vi.useFakeTimers();
    seedPlaying();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("按量化步长定时推进，不再占用 rAF 帧循环", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const interval = vi.spyOn(window, "setInterval");

    render(<Probe />);

    expect(interval).toHaveBeenCalledWith(expect.any(Function), QUANTUM_MS);
    // 关键断言：整个挂载过程一次 rAF 都不申请
    expect(raf).not.toHaveBeenCalled();
  });

  it("每秒最多推进 10 次，且卸载时清掉定时器", () => {
    const interval = vi.spyOn(window, "setInterval");
    const clear = vi.spyOn(window, "clearInterval");

    const view = render(<Probe />);
    // 10 秒 = 100 次量子步长；每次 loop 只读一次插值
    // 定时器回调里会 setState，必须在 act 里推进才会落到 DOM
    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    const intervalId = interval.mock.results[0]?.value;
    const shown = screen.getByTestId("pos").textContent;
    // 先卸载再断言清账：cleanup 发生在 unmount 时
    view.unmount();
    expect(clear).toHaveBeenCalledWith(intervalId);
    expect(shown).not.toBe("0");
  });

  it("暂停态不挂定时器（没有可推进的位移）", () => {
    usePlayerStore.setState({ state: { status: "paused" } as never });
    const interval = vi.spyOn(window, "setInterval");

    render(<Probe />);

    expect(interval).not.toHaveBeenCalled();
  });
});
