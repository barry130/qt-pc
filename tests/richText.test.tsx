// 富文本渲染回归：白名单过滤（脚本 / 事件 / 非 http 链接）+ 常见标签 + 纯文本兼容。
// 纯 node 环境，mock 掉 Tauri invoke（外部链接打开用）。
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({})),
}));

import { RichText, htmlToText, looksLikeHtml } from "@/lib/richText";

const renderHtml = (html: string): string =>
  renderToStaticMarkup(<RichText text={html} />);

describe("looksLikeHtml", () => {
  it("识别标签，且不把纯文本里的小于号误判", () => {
    expect(looksLikeHtml("<p>hi</p>")).toBe(true);
    expect(looksLikeHtml("1 < 2 是成立的")).toBe(false);
  });
});

describe("htmlToText", () => {
  it("去标签、块级标签之间换行，并剔除 script 正文", () => {
    const text = htmlToText(
      "<p>第一段</p><script>alert(1)</script><p>第二段<br>换行</p>",
    );
    expect(text).toContain("第一段");
    expect(text).toContain("第二段");
    expect(text).not.toContain("alert(1)");
    expect(text).not.toContain("<p>");
  });

  it("纯文本原样返回", () => {
    expect(htmlToText("就是一段话")).toBe("就是一段话");
  });
});

describe("RichText", () => {
  it("渲染常见富文本标签", () => {
    const html = renderHtml("<p>你好 <strong>世界</strong></p>");
    expect(html).toContain("你好");
    expect(html).toContain("<strong");
    expect(html).toContain("世界");
    // 标签被解析成元素，而不是当正文显示
    expect(html).not.toContain("&lt;p&gt;");
  });

  it("丢弃脚本与事件属性", () => {
    const html = renderHtml(
      '<script>alert(1)</script><p onclick="steal()">安全内容</p>',
    );
    expect(html).toContain("安全内容");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("onclick");
  });

  it("过滤非 http(s) 链接", () => {
    const html = renderHtml('<a href="javascript:alert(1)">点我</a>');
    expect(html).toContain("点我");
    expect(html).not.toContain("href");
    expect(html).not.toContain("javascript");
  });

  it("保留 http(s) 链接", () => {
    const html = renderHtml('<a href="https://example.com/x">官网</a>');
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain("官网");
  });

  it("纯文本正文保留换行", () => {
    const html = renderHtml("第一行\n第二行");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).toContain("第一行");
    expect(html).toContain("第二行");
  });

  it("空正文给出占位", () => {
    expect(renderHtml("")).toContain("这条消息没有正文");
  });
});
