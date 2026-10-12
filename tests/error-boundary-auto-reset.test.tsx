// @vitest-environment jsdom
/**
 * ErrorBoundary 的无人值守自愈（autoReset，2026-10-12）。
 *
 * 背景：桌面歌词窗口被错误边界接住后是**永久**停在「这块内容出错了（桌面歌词）」
 * 卡片上的 —— 它没有 resetKey 可依赖（这个窗口不换路由、不切页签），也几乎没人会
 * 去点那个「重试」按钮（无边框透明窗，且用户未必在看）。所以边界要能自己重试。
 *
 * 这里锁四件事：
 * 1. 偶发错误（第一次渲染抛、之后正常）能被自动重试救回来 —— 这是主场景；
 * 2. 确定性错误（每次渲染都抛）重试到额度上限就**停下**，不能无限刷屏；
 * 3. 没开 autoReset 的边界行为完全不变（不自动重试）—— 其余边界都靠 resetKey；
 * 4. 额度按「连续失败」计：隔了一段时间再出错，算新故障、额度重置。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

vi.mock("@/services/ipc", () => ({
  setSetting: vi.fn(async () => {}),
  // 边界同时会把错误写一份进文件日志（设置页「诊断日志」指向的目录）
  writeLog: vi.fn(async () => {}),
}));

import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { setSetting, writeLog } from "@/services/ipc";

/**
 * 可控炸弹：`shouldThrow()` 为真时渲染即抛。
 * 抛在渲染期才能被错误边界接住（事件回调里抛的不算）。
 */
function Bomb(props: { shouldThrow: () => boolean; label: string }): React.JSX.Element {
  if (props.shouldThrow()) throw new Error(`boom:${props.label}`);
  return <div data-testid="ok">{props.label} 正常</div>;
}

/** 放弃自动重试时的那条 warn（每个用例在 beforeEach 里挂上） */
let warnSpy: ReturnType<typeof vi.spyOn>;

/** 卡片出现即说明错误被接住了 */
function showingCard(): boolean {
  return screen.queryByText(/这块内容出错了/) !== null;
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    // 让 setState 触发的重渲染跑完
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  // 用例故意让组件在渲染期抛错，React 会往 stderr 打整棵组件栈（外加边界自己的
  // console.error）——预期行为，压掉即可，否则 4 个用例能刷出上千行。
  vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ErrorBoundary 自动恢复", () => {
  it("偶发错误：等待后自动重试，界面自己恢复", async () => {
    let broken = true;
    render(
      <ErrorBoundary label="测试" autoReset={{ delayMs: 1000 }}>
        <Bomb shouldThrow={() => broken} label="A" />
      </ErrorBoundary>,
    );

    expect(showingCard()).toBe(true);
    expect(screen.queryByTestId("ok")).toBeNull();
    // 出错照旧落库，便于事后排查
    expect(setSetting).toHaveBeenCalled();
    // 同时落一份进文件日志 —— 设置页「诊断日志」指的是那个目录，只写库等于用户翻不到
    expect(writeLog).toHaveBeenCalledWith("error", expect.stringContaining("boom:A"));

    // 故障消失（真实场景：竞态过去了 / 数据到了）
    broken = false;
    await tick(1000);

    expect(showingCard()).toBe(false);
    expect(screen.getByTestId("ok").textContent).toBe("A 正常");
  });

  it("确定性错误：重试到上限就停下，停在卡片上不再自动重试", async () => {
    render(
      <ErrorBoundary label="测试" autoReset={{ delayMs: 1000, maxAttempts: 3 }}>
        <Bomb shouldThrow={() => true} label="B" />
      </ErrorBoundary>,
    );
    expect(showingCard()).toBe(true);

    // 每次重试都再抛一次；额度 3 次，之后不再排新的重试
    for (let i = 0; i < 6; i += 1) await tick(1000);

    expect(showingCard()).toBe(true);
    // 停在卡片上，并如实告知自动重试已停（而不是让用户干等一个不会来的重试）
    expect(screen.queryByText(/自动重试已停止/)).toBeTruthy();
    // 放弃时留一条 warn，便于事后从日志看出「它试过了、不是没管」
    expect(warnSpy).toHaveBeenCalled();
  });

  it("未开启 autoReset 的边界不会自动重试（其余边界仍靠 resetKey）", async () => {
    let broken = true;
    render(
      <ErrorBoundary label="测试">
        <Bomb shouldThrow={() => broken} label="C" />
      </ErrorBoundary>,
    );
    expect(showingCard()).toBe(true);

    broken = false;
    await tick(60_000);

    // 老行为不变：卡片一直挂着，等用户点「重试」或 resetKey 变化
    expect(showingCard()).toBe(true);
  });

  it("额度按连续失败计：间隔够久再出错，算新故障、重新给满额度", async () => {
    let broken = true;
    const view = render(
      <ErrorBoundary label="测试" autoReset={{ delayMs: 1000, maxAttempts: 1 }}>
        <Bomb shouldThrow={() => broken} label="D" />
      </ErrorBoundary>,
    );
    expect(showingCard()).toBe(true);

    // 第一次自动重试成功（额度 1 已用尽）
    broken = false;
    await tick(1000);
    expect(showingCard()).toBe(false);

    // 界面好了很久（远超 10s 的重置窗口）
    await tick(60_000);
    expect(showingCard()).toBe(false);

    // 再偶发一次故障 ⇒ 额度应已重置，还能自愈；没重置就会永久卡在卡片上
    broken = true;
    await act(async () => {
      view.rerender(
        <ErrorBoundary label="测试" autoReset={{ delayMs: 1000, maxAttempts: 1 }}>
          <Bomb shouldThrow={() => broken} label="D" />
        </ErrorBoundary>,
      );
    });
    expect(showingCard()).toBe(true);

    broken = false;
    await tick(1000);
    expect(showingCard()).toBe(false);
    expect(screen.getByTestId("ok").textContent).toBe("D 正常");
  });
});