// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { SourceTag } from "@/components/common/SourceTag";
import { useSourceRegistryStore } from "@/stores/sourceRegistry";

/**
 * 歌名右侧的平台简称徽标：全站唯一实现，样式对齐正在播放页。
 *
 * 用真实 store（不 mock 注册表），因为要验证的正是「从注册表取简称/颜色」这条链路 ——
 * mock 掉注册表就只能测到 `props`，测不到「简称缺失时退回全名」这类真实分支。
 */
function seed(sources: { id: string; name: string; short?: string; color?: string }[]): void {
  useSourceRegistryStore.setState({
    sources: sources.map((item) => ({
      id: item.id,
      name: item.name,
      short: item.short ?? "",
      color: item.color ?? "#000000",
      searchPageMax: 50,
    })),
    qualities: [],
    ready: true,
  });
}

beforeEach(() => {
  seed([
    { id: "qq", name: "QQ音乐", short: "QQ", color: "#12B7F5" },
    { id: "netease", name: "网易云音乐", short: "网易云", color: "#C20C0C" },
    // 旧版数据包没有 short：应退回全名而不是显示空白
    { id: "old", name: "旧版音源", color: "#888888" },
  ]);
});

afterEach(() => {
  cleanup();
});

describe("SourceTag", () => {
  it("列表用小号：3xs 字号（10px）、px-1，标题是「来源：简称」", () => {
    const { container } = render(<SourceTag platform="qq" size="xs" />);
    const tag = container.firstElementChild as HTMLElement;
    expect(tag.textContent).toBe("QQ");
    expect(tag.className).toContain("text-3xs");
    expect(tag.className).toContain("px-1");
    expect(tag.title).toBe("来源：QQ");
  });

  it("正在播放页用默认尺寸：2xs 字号（11px）、px-1.5（与改造前的详情页一致）", () => {
    const { container } = render(<SourceTag platform="netease" />);
    const tag = container.firstElementChild as HTMLElement;
    expect(tag.textContent).toBe("网易云");
    expect(tag.className).toContain("text-2xs");
    expect(tag.className).toContain("px-1.5");
  });

  it("底色用音源颜色做 16% 淡底、文字用本色", () => {
    const { container } = render(<SourceTag platform="netease" size="xs" />);
    const style = (container.firstElementChild as HTMLElement).getAttribute("style") ?? "";
    expect(style).toContain("color-mix");
    expect(style).toContain("16%");
    // jsdom 会把十六进制颜色规范化成 rgb(...)，所以这里按规范化后的形式断言
    expect(style).toContain("rgb(194, 12, 12)");
  });

  it("简称缺失的旧数据包退回全名", () => {
    const { container } = render(<SourceTag platform="old" size="xs" />);
    expect((container.firstElementChild as HTMLElement).textContent).toBe("旧版音源");
  });

  it("注册表里没有这个音源时显示「未知」，不抛错也不空白", () => {
    const { container } = render(<SourceTag platform="ghost" size="xs" />);
    expect((container.firstElementChild as HTMLElement).textContent).toBe("未知");
  });

  it("本地曲目没有平台概念，整块不渲染", () => {
    const { container } = render(<SourceTag platform="local" size="xs" />);
    expect(container.firstChild).toBeNull();
  });

  it("不折行：简称是整体，不能被挤成两行", () => {
    const { container } = render(<SourceTag platform="netease" size="xs" />);
    expect((container.firstElementChild as HTMLElement).className).toContain("whitespace-nowrap");
  });
});
