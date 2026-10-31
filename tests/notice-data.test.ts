// @vitest-environment jsdom
/**
 * 通告数据层（`lib/notice-data`）：后端 `app/message/active` 一次返回**所有展示位**，
 * 由客户端按 `display` 位掩码分发。这里守的契约：
 *
 * 1. 后端字段宽松归一到稳定结构（`display`/`url`/`isTop` 缺省或类型漂移都不炸）；
 * 2. 排序统一：`isTop` 优先，再按 `createTime` 倒序（三个展示位共用同一顺序）；
 * 3. 同内容去重（后端按渠道各建一行时会重复下发）；
 * 4. 开屏弹窗必须排除免责声明（`termsVersion` 非空，由 FirstRunDisclaimer 单独渲染），
 *    否则两个弹窗叠着弹；
 * 5. 开屏弹窗与首页通告栏**共用一次请求**（同时挂载只发一次），缓存 60s。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  astralActiveMessages: vi.fn(async (): Promise<unknown> => []),
}));

vi.mock("@/services/ipc", () => mocks);

import {
  DISPLAY_MESSAGE_CENTER,
  DISPLAY_NOTICE_BAR,
  DISPLAY_SPLASH,
  isAudienceVisible,
  loadActiveNotices,
  normalizeActiveNotices,
  noticeTypeLabel,
  pickNoticeBar,
  pickSplashNotices,
  resetActiveNoticeCache,
} from "@/lib/notice-data";

/** 一条后端形状的通告（只有 id/display/title/content 是必填的） */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    display: 1,
    title: "标题",
    content: "<p>正文</p>",
    createTime: "2026-10-01 10:00:00",
    isTop: 0,
    ...over,
  };
}

beforeEach(() => {
  mocks.astralActiveMessages.mockReset();
  mocks.astralActiveMessages.mockResolvedValue([]);
  resetActiveNoticeCache();
});

afterEach(() => {
  resetActiveNoticeCache();
});

describe("normalizeActiveNotices", () => {
  it("把后端字段归一成稳定结构并解析跳转链接", () => {
    const [notice] = normalizeActiveNotices([
      row({
        id: 7,
        display: 2,
        noticeType: "FEEDBACK",
        url: "astral://feedback/42",
        marquee: 1,
        isTop: 1,
        audience: "logged_in",
      }),
    ]);

    expect(notice).toMatchObject({
      id: 7,
      display: DISPLAY_NOTICE_BAR,
      // 类型统一小写，标签才能匹配
      noticeType: "feedback",
      isTop: true,
      marquee: true,
      audience: "LOGGED_IN",
    });
    expect(notice?.link).toEqual({ kind: "feedback", id: 42 });
  });

  it("兼容用老字段 type 承载展示位", () => {
    const [notice] = normalizeActiveNotices([row({ display: undefined, type: 4 })]);
    expect(notice?.display).toBe(DISPLAY_MESSAGE_CENTER);
  });

  it("没有展示位的条目直接丢掉（无法分发）", () => {
    expect(normalizeActiveNotices([row({ display: 0 })])).toHaveLength(0);
  });

  it("isTop 优先，其次按 createTime 倒序", () => {
    const ids = normalizeActiveNotices([
      row({ id: 1, title: "a1", createTime: "2026-10-01 10:00:00" }),
      row({ id: 2, title: "a2", createTime: "2026-10-03 10:00:00" }),
      row({ id: 3, title: "a3", createTime: "2026-10-02 10:00:00", isTop: 1 }),
    ]).map((notice) => notice.id);
    expect(ids).toEqual([3, 2, 1]);
  });

  it("同标题同正文的重复下发只留一条（后端按渠道各建一行）", () => {
    const notices = normalizeActiveNotices([
      row({ id: 1, title: "同一条", content: "正文" }),
      row({ id: 2, title: "同一条", content: "正文" }),
    ]);
    expect(notices).toHaveLength(1);
  });

  it("容忍 { list: [...] } 包裹与乱序字段", () => {
    const notices = normalizeActiveNotices({ list: [row({ id: 9, messageId: 9 })] });
    expect(notices[0]?.id).toBe(9);
  });

  it("不可点击的 url 解析成 undefined（未知 host / 非 http）", () => {
    const notices = normalizeActiveNotices([
      row({ id: 1, title: "u1", url: "astral://unknown/3" }),
      row({ id: 2, title: "u2", url: "javascript:alert(1)" }),
    ]);
    expect(notices.map((notice) => notice.link)).toEqual([undefined, undefined]);
  });
});

describe("展示位分发", () => {
  const notices = normalizeActiveNotices([
    row({ id: 1, display: DISPLAY_SPLASH, title: "s1", createTime: "2026-09-01 10:00:00" }),
    row({ id: 2, display: DISPLAY_NOTICE_BAR, title: "b2", createTime: "2026-09-02 10:00:00" }),
    row({ id: 3, display: DISPLAY_SPLASH | DISPLAY_NOTICE_BAR, title: "sb3", createTime: "2026-09-03 10:00:00" }),
    row({ id: 4, display: DISPLAY_MESSAGE_CENTER, title: "c4", createTime: "2026-09-04 10:00:00" }),
  ]);

  it("通告栏只取 display & 2，并叠加受众过滤", () => {
    expect(pickNoticeBar(notices, false).map((notice) => notice.id)).toEqual([3, 2]);
    const onlyGuest = normalizeActiveNotices([
      row({ id: 5, display: DISPLAY_NOTICE_BAR, audience: "NOT_LOGGED_IN", title: "g5" }),
      row({ id: 6, display: DISPLAY_NOTICE_BAR, audience: "LOGGED_IN", title: "l6" }),
    ]);
    expect(pickNoticeBar(onlyGuest, true).map((notice) => notice.id)).toEqual([6]);
    expect(pickNoticeBar(onlyGuest, false).map((notice) => notice.id)).toEqual([5]);
  });

  it("开屏弹窗排除免责声明、受众不符与已弹过的首次登录公告", () => {
    const splash = normalizeActiveNotices([
      row({ id: 11, display: DISPLAY_SPLASH, termsVersion: "2026.10", title: "s11", createTime: "2026-09-11 10:00:00" }),
      row({ id: 12, display: DISPLAY_SPLASH, audience: "NOT_LOGGED_IN", title: "s12", createTime: "2026-09-12 10:00:00" }),
      row({ id: 13, display: DISPLAY_SPLASH, firstLoginOnly: 1, title: "s13", createTime: "2026-09-13 10:00:00" }),
      row({ id: 14, display: DISPLAY_SPLASH, firstLoginOnly: 1, title: "s14", createTime: "2026-09-14 10:00:00" }),
      row({ id: 15, display: DISPLAY_SPLASH, title: "s15", createTime: "2026-09-15 10:00:00" }),
    ]);
    const picked = pickSplashNotices(splash, {
      loggedIn: true,
      // 13 已经弹过；14 还没
      isFirstLoginShown: (id) => id === 13,
    });
    expect(picked.map((notice) => notice.id)).toEqual([15, 14]);
  });

  it("未登录时「仅首次登录」的公告不弹（没有登录过就谈不上首次登录）", () => {
    const splash = normalizeActiveNotices([row({ id: 21, display: DISPLAY_SPLASH, firstLoginOnly: 1, title: "s21" })]);
    expect(
      pickSplashNotices(splash, { loggedIn: false, isFirstLoginShown: () => false }),
    ).toHaveLength(0);
  });
});

describe("标签与受众", () => {
  it("类型标签与移动端 noticeTypeLabel 一致", () => {
    expect(noticeTypeLabel("feedback")).toBe("反馈");
    expect(noticeTypeLabel("request")).toBe("需求");
    expect(noticeTypeLabel("announce")).toBe("公告");
    expect(noticeTypeLabel("notice")).toBe("公告");
    expect(noticeTypeLabel(undefined)).toBe("公告");
  });

  it("未知 audience 按 ALL 处理（新枚举不至于让所有端都看不见）", () => {
    expect(isAudienceVisible(undefined, false)).toBe(true);
    expect(isAudienceVisible("SOMETHING_NEW", true)).toBe(true);
    expect(isAudienceVisible("LOGGED_IN", false)).toBe(false);
    expect(isAudienceVisible("NOT_LOGGED_IN", true)).toBe(false);
  });
});

describe("取数缓存", () => {
  it("同时挂载（开屏弹窗 + 通告栏）只发一次请求", async () => {
    mocks.astralActiveMessages.mockResolvedValue([row({ id: 1, display: DISPLAY_SPLASH | DISPLAY_NOTICE_BAR })]);
    const [a, b] = await Promise.all([loadActiveNotices(), loadActiveNotices()]);
    expect(mocks.astralActiveMessages).toHaveBeenCalledTimes(1);
    expect(a.map((notice) => notice.id)).toEqual([1]);
    expect(b).toBe(a);
  });

  it("60s 内复用缓存，force 时才重新取", async () => {
    mocks.astralActiveMessages.mockResolvedValue([row({ id: 1 })]);
    await loadActiveNotices();
    await loadActiveNotices();
    expect(mocks.astralActiveMessages).toHaveBeenCalledTimes(1);

    await loadActiveNotices(true);
    expect(mocks.astralActiveMessages).toHaveBeenCalledTimes(2);
  });

  it("请求失败不写缓存，下次会重试", async () => {
    mocks.astralActiveMessages.mockRejectedValueOnce(new Error("boom"));
    await expect(loadActiveNotices()).rejects.toThrow("boom");
    mocks.astralActiveMessages.mockResolvedValue([row({ id: 2 })]);
    await expect(loadActiveNotices()).resolves.toHaveLength(1);
    expect(mocks.astralActiveMessages).toHaveBeenCalledTimes(2);
  });
});
