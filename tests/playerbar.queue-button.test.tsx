// @vitest-environment jsdom
/**
 * 播放队列按钮的开启态点亮（m04140 / m04442 / m04741 用户口径）。
 *
 * 用户原话 m04741：「我要和左边桌面歌词打开后效果一样就行」——要的是**队列按钮
 * 自身点亮**，和「桌面歌词」按钮开启态同一套填充，不是整条播放条换表面。
 * 先前两次跑偏（bg-card/70 → bg-card、整条换 bg-secondary）都被判定「没有变色 /
 * 不是我要的」，这里按最终口径锁住：
 *   1. 队列关闭：按钮不铺底色（走 hover 浅底那一套）；
 *   2. 队列打开：按钮铺主色填充，与桌面歌词开启态完全同款；
 *   3. 播放条根节点底色不随队列开关变化（恒为 bg-card/70）；
 *   4. 播放页（m04913）：队列按钮禁用 —— 播放页不渲染 QueuePanel，点了没用。
 * 回归测试文件：tests/playerbar.queue-button.test.tsx。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({})),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

/** 当前路由（用例里可改，模拟播放页 / 普通页） */
let pathname = "/";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { canGoBack: () => false, back: vi.fn() } }),
  useRouterState: (opts?: { select?: (s: unknown) => unknown }) => {
    const snapshot = { location: { pathname } };
    return opts?.select ? opts.select(snapshot) : snapshot;
  },
}));

import { PlayerBar } from "@/components/PlayerBar";
import { PLAYER_BAR_DEFAULT_VISIBLE } from "@/lib/player-bar";
import { usePlayerBarStore } from "@/stores/playerBar";
import { usePlayerStore } from "@/stores/player";

/** 根节点的 class 集合（空格切分，避免 `bg-card` 误命中 `bg-card/70`） */
function rootClasses(container: HTMLElement): string[] {
  const root = container.firstElementChild;
  expect(root).toBeTruthy();
  return (root as HTMLElement).className.split(/\s+/);
}

/** 按 aria-label 取按钮 */
function button(label: string): HTMLElement {
  return screen.getByRole("button", { name: label });
}

function renderBar(): HTMLElement {
  const { container } = render(<PlayerBar />);
  return container;
}

/** 默认展示集不含「播放队列」（见 lib/player-bar.ts），用例里显式打开它 */
const WITH_QUEUE = [...PLAYER_BAR_DEFAULT_VISIBLE, "queue"];

beforeEach(() => {
  // 本文件的 vitest 配置没开 globals，@testing-library/react 的自动清理不会生效，
  // 上一用例的 DOM 会留在 document 里 → getByRole 报 "Found multiple elements"
  cleanup();
  pathname = "/";
  usePlayerStore.setState({ queueOpen: false });
  usePlayerBarStore.setState({ visible: WITH_QUEUE, loaded: true });
});

describe("播放队列按钮：开启态点亮（与桌面歌词同款）", () => {
  it("队列关闭：按钮不铺底色", () => {
    renderBar();
    const queue = button("播放队列");
    expect(queue.className).not.toContain("bg-primary/60");
    expect(queue.getAttribute("aria-pressed")).toBe("false");
  });

  it("队列打开：按钮铺主色填充，和桌面歌词开启态同款", () => {
    usePlayerStore.setState({ queueOpen: true });
    renderBar();

    const queue = button("播放队列");
    expect(queue.getAttribute("aria-pressed")).toBe("true");
    // 与「桌面歌词」等按钮共用 ControlButton 的 emphasis 点亮：同一串主色填充，
    // 逐个 token 锁住，避免日后有人只改其中一处导致两种开启态长得不一样。
    // （见 PlayerBar.tsx ControlButton 的 `fill` 常量）
    for (const token of [
      "bg-primary/60",
      "text-primary-foreground",
      "hover:brightness-110",
      "active:brightness-95",
    ]) {
      expect(queue.className).toContain(token);
    }
    expect(queue.className).toMatch(/shadow-\[0_2px_8px_color-mix/);
  });

  it("播放条底色不随队列开关变化：恒为 bg-card/70", () => {
    const closed = rootClasses(renderBar());
    expect(closed).toContain("bg-card/70");

    usePlayerStore.setState({ queueOpen: true });
    const open = rootClasses(renderBar());
    expect(open).toContain("bg-card/70");
    expect(open).not.toContain("bg-secondary");
  });

  it("播放页不受队列开关影响：根节点仍走封面色渐变", () => {
    pathname = "/playing";
    usePlayerStore.setState({ queueOpen: true });
    const container = renderBar();
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.background).toContain("linear-gradient");
  });

  // 用户 m04913：「增加在播放页时不允许点击播放列表按钮」
  // QueuePanel 是 AppShell 主区里的布局级面板，播放页走 isPlayingPage 分支不渲染它，
  // 所以那儿的队列按钮点了只会亮一下、面板永远不出现 —— 等同于坏按钮，必须置灰。
  it("播放页：队列按钮禁用且不铺底色", () => {
    pathname = "/playing";
    usePlayerStore.setState({ queueOpen: true });
    renderBar();

    const queue = button("播放队列（播放页不可用）");
    // 项目没装 jest-dom，直接断言原生 disabled 属性（<button disabled>）
    expect((queue as HTMLButtonElement).disabled).toBe(true);
    // 禁用态不保留开启态填充：铺主色会读成「队列正开着」，而播放页根本没有队列可开
    expect(queue.className).not.toContain("bg-primary/60");
    expect(queue.className).toContain("opacity-40");
    expect(queue.className).toContain("cursor-not-allowed");
  });

  it("播放页：点击禁用按钮不会切换 queueOpen", () => {
    pathname = "/playing";
    usePlayerStore.setState({ queueOpen: false });
    renderBar();

    fireEvent.click(button("播放队列（播放页不可用）"));
    expect(usePlayerStore.getState().queueOpen).toBe(false);
  });

  it("非播放页：队列按钮可点，点击即切换", () => {
    renderBar();
    expect((button("播放队列") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button("播放队列"));
    expect(usePlayerStore.getState().queueOpen).toBe(true);
  });
});
