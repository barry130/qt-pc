// @vitest-environment jsdom
/**
 * 侧边栏「助手」分组的显隐。
 *
 * 后端 `/api/v1/app/ai/agents` 已按 `accessService.permitted()` 过滤智能体，
 * 没有 `user:ai:music:use` 的账号请求回来就是空列表；前端若照样渲染入口，
 * 用户点进去只会看到「后台还没有可用的音乐助手」——像配置坏了，其实是没授权。
 *
 * 这里只盯「渲染/不渲染这一组」，音源相关能力全部桩成「都支持」，
 * 免得在线分组的置灰逻辑干扰断言。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { useAuthStore } from "@/stores/auth";

vi.mock("@tanstack/react-router", () => ({
  Link: (props: { children?: React.ReactNode; title?: string }) => (
    <a href="#" title={props.title}>
      {props.children}
    </a>
  ),
}));

vi.mock("@/stores/sourceRegistry", () => ({
  useSourceLabel: () => "网易云",
  useSourceSupports: () => true,
  useAnySourceSupports: () => true,
}));

import { Sidebar } from "@/components/layout/Sidebar";

function renderSidebar(): void {
  render(<Sidebar />);
}

beforeEach(() => {
  useAuthStore.setState({ profile: null, session: null });
});

describe("侧边栏 · 音乐助手入口按权限显隐", () => {
  it("未登录不显示助手分组", () => {
    renderSidebar();
    expect(screen.queryByText("音乐助手")).toBeNull();
    expect(screen.queryByText("助手")).toBeNull();
    // 别的分组照常渲染，确认不是整页都没渲染
    expect(screen.getByText("听歌报告")).toBeTruthy();
  });

  it("有 user:ai:music:use 才显示", () => {
    useAuthStore.setState({ profile: { permissions: ["user:like:view", "user:ai:music:use"] } });
    renderSidebar();
    expect(screen.getByText("助手")).toBeTruthy();
    expect(screen.getByText("音乐助手")).toBeTruthy();
  });

  it("登录了但没有该权限码 → 不显示", () => {
    useAuthStore.setState({ profile: { roles: ["APP_USER"], permissions: ["user:like:view"] } });
    renderSidebar();
    expect(screen.queryByText("音乐助手")).toBeNull();
  });

  it("管理员码不隐含音乐助手权限", () => {
    useAuthStore.setState({ profile: { permissions: ["admin:qt:admin"] } });
    renderSidebar();
    expect(screen.queryByText("音乐助手")).toBeNull();
  });
});
