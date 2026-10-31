// @vitest-environment jsdom
/**
 * 首页通告栏（`components/notice/qt-NoticeBar`，后端展示位 `display & 2`）。
 *
 * 守的契约：
 * 1. 正文是富文本，横条里只显示压平后的单行；
 * 2. 跑马灯是**测量驱动**的：后端要求 `marquee=1` 且文字真的放不下才滚，
 *    放得下就静止省略（桌面窗口很宽，动不动就滚反而看不清）；
 * 3. 减弱动效（`html.reduce-motion`）时一律不滚；
 * 4. 关闭是会话级（回调外抛，由 Host 记内存标记），多条可手动翻页；
 * 5. 只有真正点得动的链接才渲染成按钮（`astral://notice/<id>` 桌面端没有落地页）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { NoticeBar } from "@/components/notice/qt-NoticeBar";
import type { ActiveNotice } from "@/lib/notice-data";

/** 一条归一后的通告（字段与 normalizeActiveNotices 产出对齐） */
function notice(over: Partial<ActiveNotice> = {}): ActiveNotice {
  return {
    id: 1,
    display: 2,
    noticeType: "announce",
    title: "标题",
    content: "<p>通告正文</p>",
    isTop: false,
    marquee: false,
    dialogClosable: true,
    firstLoginOnly: false,
    termsVersion: "",
    audience: "ALL",
    createTime: "2026-10-01 10:00:00",
    readSeconds: 0,
    ...over,
  };
}

/** jsdom 不做布局，量出来的宽高都是 0：这里把「文字比容器宽」直接钉死 */
function mockOverflow(textWidth: number, boxWidth: number): void {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get: () => textWidth,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => boxWidth,
  });
}

beforeEach(() => {
  document.documentElement.classList.remove("reduce-motion");
  mockOverflow(0, 0);
});

describe("NoticeBar", () => {
  it("富文本压成单行显示，并带上关闭按钮", () => {
    render(<NoticeBar notices={[notice({ content: "<p>维护<strong>通知</strong></p>" })]} />);
    expect(screen.getByText("维护通知")).toBeTruthy();
    expect(screen.getByLabelText("关闭通告")).toBeTruthy();
  });

  it("正文为空时退回标题（不留一条空白横条）", () => {
    render(<NoticeBar notices={[notice({ content: "   " })]} />);
    expect(screen.getByText("标题")).toBeTruthy();
  });

  it("marquee=0 时即使放不下也静止", () => {
    mockOverflow(900, 300);
    const { container } = render(<NoticeBar notices={[notice({ marquee: false })]} />);
    expect(container.querySelector(".qt-notice-scroll")).toBeNull();
  });

  it("marquee=1 且溢出时连续滚动，位移与时长按测量值算", () => {
    mockOverflow(900, 300);
    const { container } = render(<NoticeBar notices={[notice({ marquee: true })]} />);
    const track = container.querySelector<HTMLElement>(".qt-notice-scroll");
    expect(track).not.toBeNull();
    // 位移 = 文案宽 + 间隔（48）；时长 = 位移 / 60px·s⁻¹
    expect(track?.style.getPropertyValue("--nb-shift")).toBe("-948px");
    expect(track?.style.animationDuration).toBe("15.80s");
    // 第二份文案负责接续循环，对读屏隐藏
    const hidden = container.querySelectorAll('[aria-hidden="true"]');
    expect(hidden.length).toBeGreaterThanOrEqual(1);
  });

  it("marquee=1 但放得下时不滚（只溢出几个像素也不滚）", () => {
    mockOverflow(300, 300);
    const { container } = render(<NoticeBar notices={[notice({ marquee: true })]} />);
    expect(container.querySelector(".qt-notice-scroll")).toBeNull();
  });

  it("减弱动效时不滚", () => {
    document.documentElement.classList.add("reduce-motion");
    mockOverflow(900, 300);
    const { container } = render(<NoticeBar notices={[notice({ marquee: true })]} />);
    expect(container.querySelector(".qt-notice-scroll")).toBeNull();
  });

  it("关闭回调由外部记账（会话级）", () => {
    const onClose = vi.fn();
    render(<NoticeBar notices={[notice()]} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("关闭通告"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("多条通告可前后翻页，并显示计数", () => {
    render(
      <NoticeBar
        notices={[notice({ id: 1, content: "第一条" }), notice({ id: 2, content: "第二条" })]}
      />,
    );
    expect(screen.getByText("1/2")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("下一条通告"));
    expect(screen.getByText("第二条")).toBeTruthy();
    expect(screen.getByText("2/2")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("下一条通告"));
    expect(screen.getByText("第一条")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("上一条通告"));
    expect(screen.getByText("第二条")).toBeTruthy();
  });

  it("单条通告不显示翻页控件", () => {
    render(<NoticeBar notices={[notice()]} />);
    expect(screen.queryByLabelText("下一条通告")).toBeNull();
  });

  it("外链通告渲染成可点按钮，点击走 onOpen", () => {
    const onOpen = vi.fn();
    const target = notice({ link: { kind: "external", url: "https://example.com/a" } });
    render(<NoticeBar notices={[target]} onOpen={onOpen} />);
    fireEvent.click(screen.getByText("通告正文"));
    expect(onOpen).toHaveBeenCalledWith(target);
  });

  it("astral://notice 在桌面端没有落地页，不做成可点按钮", () => {
    const onOpen = vi.fn();
    render(
      <NoticeBar notices={[notice({ link: { kind: "notice", id: 5 } })]} onOpen={onOpen} />,
    );
    fireEvent.click(screen.getByText("通告正文"));
    expect(onOpen).not.toHaveBeenCalled();
  });
});
