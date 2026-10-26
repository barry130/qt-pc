// @vitest-environment jsdom
/**
 * 标题栏的搜索入口：点一下打开**独立的搜索页**（/search 的落地页 = 历史 +
 * 热门搜索 + 热门歌单），而不是在标题栏里就地输入。
 *
 * 为什么改：标题栏里的输入框和搜索页输入框重复，且落地内容（历史 / 热搜）
 * 在标题栏那个小框里根本放不下 —— 用户点开搜索却只能盲打一个词。
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

const nav = vi.hoisted(() => ({ navigate: vi.fn(async () => {}) }));
vi.mock("@tanstack/react-router", () => ({
  Link: (props: { children?: React.ReactNode }) => <a>{props.children}</a>,
  useNavigate: () => nav.navigate,
  useRouter: () => ({ history: { back: vi.fn(), canGoBack: () => true } }),
}));
vi.mock("@/hooks/useFramelessWindow", () => ({
  useTitleBarDrag: () => ({ ref: { current: null }, onDoubleClick: vi.fn() }),
}));
vi.mock("@/components/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("@/components/music-source/MusicSourceSwitcher", () => ({
  MusicSourceSwitcher: () => null,
}));
vi.mock("@/components/mine/MessagesPopover", () => ({ MessagesPopover: () => null }));

import { TitleBar } from "@/components/TitleBar";

describe("标题栏搜索入口", () => {
  it("点搜索框跳到搜索页（不带关键词，落在历史 / 热搜那一屏）", () => {
    const { getByRole } = render(<TitleBar />);
    fireEvent.click(getByRole("button", { name: "搜索" }));
    expect(nav.navigate).toHaveBeenCalledWith({
      to: "/search",
      search: { q: "", type: "song" },
    });
  });

  it("不再内嵌可输入框：只有一个入口按钮，文案是提示语", () => {
    const { getByRole, queryByRole } = render(<TitleBar />);
    expect(getByRole("button", { name: "搜索" }).textContent).toContain(
      "搜索歌曲 / 歌手 / 专辑 / 歌单",
    );
    // 标题栏里不该再有文本框（输入统一在搜索页）
    expect(queryByRole("textbox")).toBeNull();
  });
});
