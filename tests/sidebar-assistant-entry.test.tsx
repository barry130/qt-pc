// @vitest-environment jsdom
/**
 * 侧边栏「助手」分组对全部用户开放。
 *
 * 2026-10-24 起音乐助手不再要求 `user:ai:music:use`：后端普通 App 用户角色
 * `APP_USER` 本来就被授予了全部 `user:%` 权限，前端再拿权限码卡入口，
 * 只会让「明明能用」的账号看不到入口。管理员专属的是**服务端 AI 模式**
 * （`admin:qt:admin`），那条闸在设置页与执行层（`isAdmin`），不在侧边栏这里。
 *
 * 这里只盯「这一组到底渲不渲染」，音源相关能力全部桩成「都支持」，
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

describe("侧边栏 · 音乐助手入口始终展示", () => {
  it("未登录也显示助手分组（入口不再按权限卡）", () => {
    renderSidebar();
    expect(screen.getByText("助手")).toBeTruthy();
    expect(screen.getByText("音乐助手")).toBeTruthy();
    // 别的分组照常渲染，确认不是整页多渲染了
    expect(screen.getByText("听歌报告")).toBeTruthy();
  });

  it("普通用户（APP_USER，未带 user:ai:music:use）也显示", () => {
    useAuthStore.setState({ profile: { roles: ["APP_USER"], permissions: ["user:like:view"] } });
    renderSidebar();
    expect(screen.getByText("助手")).toBeTruthy();
    expect(screen.getByText("音乐助手")).toBeTruthy();
  });

  it("管理员同样显示（服务端 AI 的显隐在设置页，不影响入口）", () => {
    useAuthStore.setState({ profile: { permissions: ["admin:qt:admin"] } });
    renderSidebar();
    expect(screen.getByText("助手")).toBeTruthy();
    expect(screen.getByText("音乐助手")).toBeTruthy();
  });
});
