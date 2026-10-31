// @vitest-environment jsdom
/**
 * 设置页不再有「外观」页签（用户 2026-10-31：「把设置里面的外观删掉，
 * 改为这个按键进去」—— 外观已提为一级页 /appearance，入口在标题栏皮肤按钮）。
 *
 * 各分节组件全量替身：本用例只关心**页签清单**与「外观」这一支的去向，
 * 不关心任何一节自己的取数与交互（那些由各自测试覆盖）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(async () => {}) }));
vi.mock("@/components/settings/sections/GeneralSection", () => ({
  GeneralSection: () => <div>通用内容</div>,
}));
vi.mock("@/components/settings/sections/DesktopLyricSection", () => ({
  DesktopLyricSection: () => <div>桌面歌词内容</div>,
}));
vi.mock("@/components/settings/sections/PlaybackSection", () => ({
  PlaybackSection: () => <div>播放内容</div>,
}));
vi.mock("@/components/settings/sections/PlayerBarSection", () => ({
  PlayerBarSection: () => <div>播放条内容</div>,
}));
vi.mock("@/components/settings/sections/SoundSection", () => ({
  SoundSection: () => <div>音效内容</div>,
}));
vi.mock("@/components/settings/sections/DownloadSection", () => ({
  DownloadSection: () => <div>下载内容</div>,
}));
vi.mock("@/components/settings/sections/NetworkSection", () => ({
  NetworkSection: () => <div>网络内容</div>,
}));
vi.mock("@/components/settings/sections/AiSection", () => ({
  AiSection: () => <div>AI 内容</div>,
}));
vi.mock("@/components/settings/sections/DislikeSection", () => ({
  DislikeSection: () => <div>不喜欢内容</div>,
}));
vi.mock("@/components/settings/sections/SourcePackageSection", () => ({
  SourcePackageSection: () => <div>音源包内容</div>,
}));
vi.mock("@/components/settings/sections/ShortcutSection", () => ({
  ShortcutSection: () => <div>快捷键内容</div>,
}));
vi.mock("@/components/settings/sections/AboutSection", () => ({
  AboutSection: () => <div>关于内容</div>,
}));
vi.mock("@/components/settings/sections/AppearanceSection", () => ({
  AppearanceSection: () => <div>外观内容</div>,
}));

import { SettingsPage } from "@/components/SettingsPage";

afterEach(cleanup);

function tabLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
}

describe("设置页页签", () => {
  it("页签里没有「外观」（已提为标题栏皮肤入口的一级页）", () => {
    const { container } = render(<SettingsPage section="general" />);
    const labels = tabLabels(container);
    expect(labels).not.toContain("外观");
    expect(labels).toEqual([
      "通用",
      "桌面歌词",
      "播放",
      "播放条",
      "音效",
      "下载",
      "网络",
      "AI 与模型",
      "不喜欢列表",
      "音源包",
      "快捷键",
      "关于",
    ]);
  });

  it("即便有人用旧地址进来，也不会再渲染外观那一支（旧地址由路由跳到 /appearance）", () => {
    const { container } = render(<SettingsPage section="appearance" />);
    expect(container.textContent).not.toContain("外观内容");
  });
});
