// @vitest-environment jsdom
/**
 * 无障碍（B7）：窗口内播放键 + 读屏播报。
 *
 * 这里只验「用什么键、在什么情况下不抢键」这类纯前端契约；
 * 引擎侧的播放状态由 Rust 单测覆盖，播放条本身的鼠标行为由 player-bar 用例覆盖。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/ipc", () => ({}));

import { SEEK_STEP_MS, useTransportKeys } from "@/hooks/useTransportKeys";
import { ScreenReaderAnnouncer } from "@/components/layout/ScreenReaderAnnouncer";
import { usePlayerStore } from "@/stores/player";

const toggle = vi.fn(async () => {});
const seekTo = vi.fn(async () => {});

function Harness(): React.JSX.Element {
  useTransportKeys();
  return (
    <div>
      <input aria-label="搜索框" />
      <button type="button">播放这一行</button>
    </div>
  );
}

function prime(over: Record<string, unknown> = {}): void {
  const { state: stateOver, ...rest } = over as { state?: Record<string, unknown> };
  usePlayerStore.setState({
    state: {
      ...usePlayerStore.getState().state,
      track: {
        id: "t1",
        platform: "wyy",
        title: "晴天",
        singer: "周杰伦",
        album: "叶惠美",
        picUrl: "",
        duration: 269,
      },
      status: "playing",
      ...stateOver,
    } as never,
    positionMs: 30_000,
    durationMs: 200_000,
    toggle,
    seekTo,
    ...rest,
  } as never);
}

describe("窗口内播放键", () => {
  beforeEach(() => {
    toggle.mockReset();
    seekTo.mockReset();
    prime();
  });

  it("空格切换播放/暂停", () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: " " });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(seekTo).not.toHaveBeenCalled();
  });

  it("输入框里的空格是打字，不切播放", () => {
    render(<Harness />);
    const input = screen.getByLabelText("搜索框");
    input.focus();
    fireEvent.keyDown(input, { key: " " });
    expect(toggle).not.toHaveBeenCalled();
  });

  it("焦点在按钮上时空格让给按钮", () => {
    render(<Harness />);
    const button = screen.getByRole("button", { name: "播放这一行" });
    button.focus();
    fireEvent.keyDown(button, { key: " " });
    expect(toggle).not.toHaveBeenCalled();
  });

  it("带修饰键的组合交给别人（Ctrl+K / 全局媒体键）", () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: " ", ctrlKey: true });
    fireEvent.keyDown(window, { key: " ", altKey: true });
    expect(toggle).not.toHaveBeenCalled();
  });

  it("方向键按 10 秒步长快进快退", () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(seekTo).toHaveBeenLastCalledWith(30_000 + SEEK_STEP_MS);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(seekTo).toHaveBeenLastCalledWith(30_000 - SEEK_STEP_MS);
  });

  it("跨过边界时夹在 0..时长 之间", () => {
    prime({ positionMs: 199_000, durationMs: 200_000 });
    render(<Harness />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(seekTo).toHaveBeenLastCalledWith(200_000);

    prime({ positionMs: 3_000, durationMs: 200_000 });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(seekTo).toHaveBeenLastCalledWith(0);
  });

  it("没有在播（时长 0）时不吞方向键", () => {
    prime({ durationMs: 0 });
    const event = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true });
    render(<Harness />);
    window.dispatchEvent(event);
    expect(seekTo).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("读屏播报", () => {
  beforeEach(() => {
    prime();
  });

  it("播放中播报歌名与歌手", () => {
    render(<ScreenReaderAnnouncer />);
    expect(screen.getByRole("status").textContent).toBe("正在播放：晴天 - 周杰伦");
  });

  it("暂停与播放失败各自有条目", () => {
    prime({ state: { status: "paused" } });
    const { unmount } = render(<ScreenReaderAnnouncer />);
    expect(screen.getByRole("status").textContent).toBe("已暂停：晴天 - 周杰伦");
    unmount();

    prime({ state: { status: "error" } });
    render(<ScreenReaderAnnouncer />);
    expect(screen.getByRole("status").textContent).toBe("播放失败：晴天 - 周杰伦");
  });

  it("没有曲目时不播报", () => {
    prime({ state: { track: null, status: "stopped" } });
    render(<ScreenReaderAnnouncer />);
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
