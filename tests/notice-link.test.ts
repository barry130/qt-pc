// 通知跳转地址解析：协议拼错 / 未知 host 的唯一允许后果是「不可点」，
// 绝不允许变成「打开任意路径」或「把 astral:// 当外链丢给系统」。
import { describe, expect, it } from "vitest";
import { parseNoticeLink } from "@/lib/notice-link";

describe("parseNoticeLink", () => {
  it("解析 astral://feedback/<id>", () => {
    expect(parseNoticeLink("astral://feedback/1024")).toEqual({
      kind: "feedback",
      id: 1024,
    });
  });

  it("解析 astral://notice/<id>，忽略查询参数与片段", () => {
    expect(parseNoticeLink("astral://notice/11?from=list#top")).toEqual({
      kind: "notice",
      id: 11,
    });
  });

  it("http(s) 走外链", () => {
    expect(parseNoticeLink("https://example.com/a?b=1")).toEqual({
      kind: "external",
      url: "https://example.com/a?b=1",
    });
    expect(parseNoticeLink("http://example.com")).toEqual({
      kind: "external",
      url: "http://example.com",
    });
  });

  it("未知 host / 非法 id / 裸路径 / 空值一律不可点", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "   ",
      "astral://order/1",
      "astral://feedback/abc",
      "astral://feedback/0",
      "astral://feedback/-1",
      "astral://feedback/1/2",
      "astral://feedback",
      "astral://",
      "/pages/feedback/detail?id=1",
      "javascript:alert(1)",
      "//evil.example.com",
    ]) {
      expect(parseNoticeLink(bad)).toBeNull();
    }
  });
});
