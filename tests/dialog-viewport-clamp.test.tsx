// @vitest-environment jsdom
/**
 * 弹层高度口径：**面板永远不高过窗口，正文超出就在弹层内部自动纵向滚动**。
 *
 * 用户反馈「更新公告不会滚动，一下把全部更新内容展开，字数一多就把整个通知容器弄得比
 * 软件屏幕还大」，并明确要求**不要「展开全文」之类的东西**——超了就直接能滚。
 * 这里锁住三层保障：
 * 1. `Modal` 按实测视口像素夹紧面板（CSS 的 dvh 失效时也兜得住）；
 * 2. 滚动区就是弹层 body（`min-h-0 + overflow-y-auto`），标题与按钮 `shrink-0` 不随内容跑；
 * 3. 更新说明直接铺在 body 里，不给折叠按钮，也不额外套一层内滚。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/services/ipc", () => ({
  onUpdateDownloadProgress: vi.fn(async () => () => undefined),
  resolveUpdateUrl: vi.fn(async () => ({ downloadUrl: "https://example.com/app.exe" })),
  downloadUpdateFile: vi.fn(async () => "C:/tmp/app.exe"),
  runUpdateInstaller: vi.fn(async () => undefined),
  runUpdateBrowser: vi.fn(async () => undefined),
}));

import { Modal } from "@/components/ui";
import { UpdateDialog } from "@/components/update/UpdateDialog";
import { useUpdateStore } from "@/stores/update";
import type { AppUpdateInfo } from "@/types";

function info(over: Partial<AppUpdateInfo> = {}): AppUpdateInfo {
  return {
    versionCode: 310,
    versionName: "v3.0.10",
    versionInfo: "",
    updateType: "1",
    downloadUrl: "https://example.com/app.exe",
    browserUrl: "https://example.com/download",
    isGithub: 0,
    channel: "official",
    isForce: 0,
    fileSize: 0,
    md5: "",
    ...over,
  };
}

const LONG_NOTES = Array.from(
  { length: 12 },
  (_, i) => `## 第 ${i + 1} 节\n- **条目**：这是一段把内容撑长的说明文字\n- 另一条说明文字`,
).join("\n");

describe("弹层高度口径", () => {
  afterEach(() => {
    cleanup();
    useUpdateStore.setState({ info: null, dismissed: false });
  });

  it("Modal 按视口实测像素夹紧面板，body 就是滚动区", () => {
    render(
      <Modal open onClose={() => undefined} title="标题">
        <p>正文</p>
      </Modal>,
    );
    const panel = screen.getByRole("dialog");
    expect(panel.style.maxHeight).toBe(`${window.innerHeight - 32}px`);
    const body = panel.querySelector(".overflow-y-auto");
    expect(body?.className).toContain("min-h-0");
    expect(body?.className).toContain("flex-1");
  });

  it("更新说明直接铺在 body 里：无「展开全文」，也不套内层滚动", () => {
    useUpdateStore.setState({ info: info({ versionInfo: LONG_NOTES }), dismissed: false });
    render(<UpdateDialog />);

    // 说明是真的排版出来了（不是一坨带 ## 的段落）
    expect(document.querySelectorAll("h3").length).toBe(12);
    expect(document.body.textContent).not.toContain("##");
    expect(document.body.textContent).not.toContain("**");

    // 用户明确不要折叠：既没有按钮，也没有 data-expandable 那种内滚容器
    expect(screen.queryByText("展开全文")).toBeNull();
    expect(screen.queryByText("收起")).toBeNull();
    expect(document.querySelector('[data-expandable="content"]')).toBeNull();

    // 面板被夹住 + 底部按钮仍在（footer 是 shrink-0，不会被正文挤走）
    const panel = screen.getByRole("dialog");
    expect(panel.style.maxHeight).toBe(`${window.innerHeight - 32}px`);
    expect(panel.querySelector("footer")?.textContent).toContain("暂不更新");
  });

  it("说明很短时同样没有任何多余按钮", () => {
    useUpdateStore.setState({ info: info({ versionInfo: "## 修复\n- 卡顿" }), dismissed: false });
    render(<UpdateDialog />);
    expect(document.querySelectorAll("h3").length).toBe(1);
    expect(screen.queryByText("展开全文")).toBeNull();
  });
});
