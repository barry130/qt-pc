// @vitest-environment jsdom
/**
 * 私人 FM 接管队列期间（A7，用户 m18755）播放条的两处口径：
 *   1. 播放队列按钮置灰 —— FM 用的是它自己往下补的那条队列，不给开"播放列表"；
 *   2. 播放模式显示「无限循环」并置灰 —— 模式归 FM 管，退出 FM 时还回用户原模式。
 * 回归测试文件：tests/playerbar-radio.test.tsx。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { canGoBack: () => false, back: vi.fn() } }),
  useRouterState: (opts?: { select?: (s: unknown) => unknown }) => {
    const snapshot = { location: { pathname: "/" } };
    return opts?.select ? opts.select(snapshot) : snapshot;
  },
}));

import { PlayerBar } from "@/components/PlayerBar";
import { PLAYER_BAR_DEFAULT_VISIBLE } from "@/lib/player-bar";
import { usePlayerBarStore } from "@/stores/playerBar";
import { usePlayerStore } from "@/stores/player";
import { useRadioStore } from "@/stores/radio";

function button(label: string): HTMLButtonElement {
  return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

/** FM 接管：active 与 queueClaimed 一起翻（真实路径由 stores/radio.ts 维护） */
function setRadio(active: boolean): void {
  act(() => useRadioStore.setState({ active, queueClaimed: active }));
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  usePlayerStore.setState({ queueOpen: false });
  // 默认展示集不含「播放队列」（见 lib/player-bar.ts），用例里显式打开它
  usePlayerBarStore.setState({
    visible: [...PLAYER_BAR_DEFAULT_VISIBLE, "queue"],
    loaded: true,
  });
  useRadioStore.setState({ active: false, queueClaimed: false });
});

describe("私人 FM 期间的播放条", () => {
  it("平时：模式按钮可点、队列按钮可用", () => {
    render(<PlayerBar />);
    expect(button("播放模式：列表循环").disabled).toBe(false);
    expect(button("播放队列").disabled).toBe(false);
  });

  it("FM 接管：模式显示「无限循环」并置灰，队列按钮也置灰", () => {
    render(<PlayerBar />);
    setRadio(true);
    const mode = button("播放模式：无限循环（私人 FM）");
    expect(mode.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "播放模式：列表循环" })).toBeNull();
    const queue = button("播放队列（私人 FM 期间不可用）");
    expect(queue.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "播放队列" })).toBeNull();
  });

  it("退出 FM：模式与队列按钮立刻恢复原样", () => {
    render(<PlayerBar />);
    setRadio(true);
    setRadio(false);
    expect(button("播放模式：列表循环").disabled).toBe(false);
    expect(button("播放队列").disabled).toBe(false);
  });
});