/**
 * 反馈数据层纯函数：响应规整（后端可空字段 → 默认值）、类型/状态文案与配色、
 * 头像字符与时间显示。口径对齐 astral-plugin-feedback（issue/request + 五态状态机）。
 */
import { describe, expect, it } from "vitest";
import {
  feedbackAvatarChar,
  feedbackStatusClass,
  feedbackStatusLabel,
  feedbackTypeClass,
  feedbackTypeLabel,
  formatFeedbackTime,
  normalizeFeedback,
  normalizePage,
  normalizeReply,
} from "@/lib/feedback";

describe("normalizeFeedback", () => {
  it("null / 空对象 → 全默认值（issue / pending / 未公开）", () => {
    for (const raw of [null, undefined, {}]) {
      const f = normalizeFeedback(raw);
      expect(f.id).toBe(0);
      expect(f.type).toBe("issue");
      expect(f.status).toBe("pending");
      expect(f.isPublic).toBe(false);
      expect(f.title).toBe("");
      expect(f.createTime).toBe("");
    }
  });

  it("完整对象原样保留", () => {
    const f = normalizeFeedback({
      id: 7,
      type: "request",
      title: "加个功能",
      content: "希望支持…",
      status: "published",
      isPublic: true,
      device: "PC-01",
      os: "Windows 11",
      appVersion: "1.0.9",
      platform: "windows",
      createTime: "2026-09-28 10:00:00",
    });
    expect(f.id).toBe(7);
    expect(f.type).toBe("request");
    expect(f.status).toBe("published");
    expect(f.isPublic).toBe(true);
    expect(f.appVersion).toBe("1.0.9");
  });

  it("isPublic 只认布尔 true（字符串/1 不算公开）", () => {
    expect(normalizeFeedback({ isPublic: "true" }).isPublic).toBe(false);
    expect(normalizeFeedback({ isPublic: 1 }).isPublic).toBe(false);
    expect(normalizeFeedback({ isPublic: true }).isPublic).toBe(true);
  });
});

describe("normalizeReply / normalizePage", () => {
  it("回复规整：缺失字段补默认", () => {
    const r = normalizeReply({ id: 3, content: "收到", userType: "ADMIN" });
    expect(r.id).toBe(3);
    expect(r.feedbackId).toBe(0);
    expect(r.nickname).toBe("");
    expect(r.userType).toBe("ADMIN");
  });

  it("分页规整：records 非数组按空列表，total 缺省 0", () => {
    expect(normalizePage(null)).toEqual({ records: [], total: 0 });
    expect(normalizePage({ records: "oops" })).toEqual({ records: [], total: 0 });
    const p = normalizePage({
      records: [{ id: 1, title: "a" }, { id: 2 }],
      total: 12,
      current: 1,
      pages: 2,
    });
    expect(p.total).toBe(12);
    expect(p.records).toHaveLength(2);
    expect(p.records[0].title).toBe("a");
    expect(p.records[1].type).toBe("issue");
  });
});

describe("类型 / 状态文案与配色", () => {
  it("类型：request→需求，其余（含未知值）→问题", () => {
    expect(feedbackTypeLabel("request")).toBe("需求");
    expect(feedbackTypeLabel("issue")).toBe("问题");
    expect(feedbackTypeLabel("whatever")).toBe("问题");
    expect(feedbackTypeClass("request")).not.toBe(feedbackTypeClass("issue"));
  });

  it("状态：五态各有中文名，未知值回落「提出」", () => {
    expect(feedbackStatusLabel("pending")).toBe("提出");
    expect(feedbackStatusLabel("received")).toBe("已接收");
    expect(feedbackStatusLabel("resolved")).toBe("已解决");
    expect(feedbackStatusLabel("published")).toBe("已发布");
    expect(feedbackStatusLabel("deprecated")).toBe("已废弃");
    expect(feedbackStatusLabel("???")).toBe("提出");
    // 五态配色互不相同（徽标靠它区分）
    const classes = ["pending", "received", "resolved", "published", "deprecated"].map(
      feedbackStatusClass,
    );
    expect(new Set(classes).size).toBe(5);
  });
});

describe("头像字符与时间", () => {
  it("昵称首字；官方无昵称兜底「官」，普通用户兜底「用」", () => {
    expect(feedbackAvatarChar("小明", "APP")).toBe("小");
    expect(feedbackAvatarChar("", "ADMIN")).toBe("官");
    expect(feedbackAvatarChar("  ", "ADMIN")).toBe("官");
    expect(feedbackAvatarChar("", "APP")).toBe("用");
  });

  it("时间取「MM-DD HH:mm」，长度不足原样返回", () => {
    expect(formatFeedbackTime("2026-09-28 17:30:00")).toBe("09-28 17:30");
    expect(formatFeedbackTime("2026-09-28 17:30")).toBe("09-28 17:30");
    expect(formatFeedbackTime("")).toBe("");
  });
});
