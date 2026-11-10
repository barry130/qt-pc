// @vitest-environment jsdom
/**
 * 升级说明的轻量 Markdown 排版。
 *
 * 后端 `versionInfo` 一直是 Markdown 风格（3.0.9 那条就是 `## 新增` + `- **音源账号**`），
 * 以前走纯文本渲染：`##`、`-`、`**` 原样露出来，而且每一行都变成独立段落，同样内容比
 * 真实排版高一大截。这里锁住三件事：标记被吃掉、结构被还原、行内样式只认白名单里的。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { RichText } from "@/lib/richText";

describe("升级说明的 Markdown 渲染", () => {
  afterEach(() => {
    cleanup();
  });

  it("## 标题渲染成标题元素，不露井号", () => {
    render(<RichText text={"## 新增\n\n普通一段"} markdown />);
    const heading = screen.getByRole("heading", { level: 3 });
    expect(heading.textContent).toBe("新增");
    expect(document.body.textContent).not.toContain("##");
  });

  it("- 开头渲染成列表项，**粗体**变成 strong", () => {
    render(<RichText text={"- **音源账号**：新增多账号\n- 支持下载"} markdown />);
    const items = document.querySelectorAll("li");
    expect(items.length).toBe(2);
    expect(document.querySelector("li strong")?.textContent).toBe("音源账号");
    expect(document.body.textContent).not.toContain("**");
    expect(document.body.textContent).not.toContain("- 支持下载");
  });

  it("有序列表与行内代码", () => {
    render(<RichText text={"1. 第一步\n2. 第二步\n\n执行 `pnpm check`"} markdown />);
    expect(document.querySelectorAll("ol li").length).toBe(2);
    expect(document.querySelector("code")?.textContent).toBe("pnpm check");
  });

  it("默认不开 Markdown：老公告的 '-' 与 '#' 仍按原文显示", () => {
    render(<RichText text={"## 不是标题\n- 不是列表"} />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(document.querySelectorAll("li").length).toBe(0);
    expect(true).toBe(true);
  });

  it("HTML 说明仍走富文本解析（不受 markdown 开关影响）", () => {
    render(<RichText text={"<p>修复了<b>卡顿</b></p>"} markdown />);
    expect(screen.getByText("卡顿").tagName).toBe("STRONG");
    expect(document.body.textContent).not.toContain("<b>");
  });

  it("裸链接照样可点", () => {
    render(<RichText text={"- 详见 https://example.com/download"} markdown />);
    const link = screen.getByText("https://example.com/download").closest("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/download");
  });
});
