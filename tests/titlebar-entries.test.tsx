// @vitest-environment jsdom
/**
 * 标题栏右侧入口（用户 2026-10-31 要求）：
 *   「顺序改一下，用户头像、通知(把那个图标改为铃铛)、设置、皮肤
 *    (把设置里面的外观删掉，改为这个按键进去)」
 *
 * 两条约束各一个用例：
 * 1. 顺序 —— 头像 → 通知 → 设置 → 皮肤 → 窗口控制（窗口控制始终贴右沿）；
 * 2. 皮肤按钮走 `/appearance` 一级页，不再回到 `settings/$section` 分节。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
  Link: (props: {
    to: string;
    children?: React.ReactNode;
    "aria-label"?: string;
    title?: string;
  }) => (
    <a data-to={props.to} aria-label={props["aria-label"]} title={props.title}>
      {props.children}
    </a>
  ),
  useNavigate: () => vi.fn(async () => {}),
  useRouter: () => ({ history: { back: vi.fn(), canGoBack: () => true } }),
}));
vi.mock("@/hooks/useFramelessWindow", () => ({
  useTitleBarDrag: () => ({ ref: { current: null }, onDoubleClick: vi.fn() }),
}));
vi.mock("@/components/WindowControls", () => ({
  WindowControls: () => <span data-testid="window-controls" />,
}));
vi.mock("@/components/music-source/MusicSourceSwitcher", () => ({
  MusicSourceSwitcher: () => null,
}));
// 通知入口用标记节点代替：本用例只关心它在右侧一列里的**位置**
vi.mock("@/components/mine/MessagesPopover", () => ({
  MessagesPopover: () => <a data-testid="messages" aria-label="消息中心" />,
}));

import { TitleBar } from "@/components/TitleBar";

afterEach(cleanup);

/** 标题栏右侧那一列（头像 / 通知 / 设置 / 皮肤 / 窗口控制） */
function rightColumn(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>(".items-stretch");
  if (found === null) throw new Error("没有找到标题栏右侧容器");
  return found;
}

describe("标题栏右侧入口", () => {
  it("顺序是 账号 → 通知 → 设置 → 皮肤，窗口控制排在最后", () => {
    const { container } = render(<TitleBar />);
    const right = rightColumn(container);
    const labels = [...right.querySelectorAll("[aria-label]")].map((el) =>
      el.getAttribute("aria-label"),
    );
    expect(labels).toEqual(["登录", "消息中心", "设置", "皮肤"]);
    expect(right.lastElementChild?.getAttribute("data-testid")).toBe("window-controls");
  });

  it("「皮肤」按钮去的是外观独立页 /appearance，不是设置页签", () => {
    const { getByLabelText, getAllByLabelText } = render(<TitleBar />);
    expect(getByLabelText("皮肤").getAttribute("data-to")).toBe("/appearance");
    // 设置入口仍在，且仍是设置页（外观已从它的页签列表里移除）
    expect(getByLabelText("设置").getAttribute("data-to")).toBe("/settings/$section");
    // 右侧一列里只有「皮肤」这一个入口指向外观页
    expect(
      getAllByLabelText("皮肤").filter((el) => el.getAttribute("data-to") === "/appearance"),
    ).toHaveLength(1);
  });
});
