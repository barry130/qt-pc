// @vitest-environment jsdom
/**
 * 更新弹窗的「更新说明」支持富文本（用户 m10847：「qt-pc 的升级通知也要支持富文本格式」）。
 *
 * 后端 `versionInfo` 与移动端一致按 HTML 下发（qt-uniappx 的 qt-upgrade-popup 就是
 * `:html="info.versionInfo"`），PC 之前整段 `<p className="whitespace-pre-wrap">` 当纯文本
 * 渲染，标签会原样露出来。这里覆盖四条：
 * 1. HTML 真的被解析成元素（<b> → STRONG，标签串本身不出现在正文里）；
 * 2. 危险片段（<script>）被剔除，不会当正文显示；
 * 3. 纯文本照旧按段落渲染（含换行的老公告不能变成一坨）；
 * 4. 说明为空时仍显示「暂无更新说明」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/services/ipc", () => ({
  onUpdateDownloadProgress: vi.fn(async () => () => undefined),
  resolveUpdateUrl: vi.fn(async () => ({ downloadUrl: "https://example.com/app.exe" })),
  downloadUpdateFile: vi.fn(async () => "C:/tmp/app.exe"),
  runUpdateInstaller: vi.fn(async () => undefined),
  runUpdateBrowser: vi.fn(async () => undefined),
}));

import { UpdateDialog } from "@/components/update/UpdateDialog";
import { useUpdateStore } from "@/stores/update";
import type { AppUpdateInfo } from "@/types";

function info(over: Partial<AppUpdateInfo> = {}): AppUpdateInfo {
  return {
    versionCode: 260101,
    versionName: "v3.2.0",
    versionInfo: "",
    updateType: "1",
    downloadUrl: "https://example.com/app.exe",
    browserUrl: "https://quietmusic.canace.cn/download",
    isGithub: 0,
    channel: "official",
    isForce: 0,
    fileSize: 0,
    md5: "",
    ...over,
  };
}

function show(versionInfo: string): void {
  useUpdateStore.setState({ info: info({ versionInfo }), dismissed: false });
  render(<UpdateDialog />);
}

describe("更新弹窗的富文本更新说明", () => {
  beforeEach(() => {
    useUpdateStore.setState({ info: null, dismissed: false });
  });
  afterEach(() => {
    cleanup();
  });

  it("HTML 说明被解析成元素，标签不会原样露出", () => {
    show("<p>本次修复了<b>卡顿</b>问题</p><p>新增歌词逐字高亮</p>");
    const bold = screen.getByText("卡顿");
    expect(bold.tagName).toBe("STRONG");
    expect(screen.getByText("新增歌词逐字高亮")).toBeTruthy();
    // 标签串本身不该作为文本出现（纯文本渲染时会出现「<b>卡顿</b>」）
    expect(document.body.textContent).not.toContain("<b>");
    expect(document.body.textContent).not.toContain("</p>");
  });

  it("列表与链接：结构保留，链接可点", () => {
    show(
      '<ul><li>支持分享图片二维码</li><li>更新说明支持富文本</li></ul>' +
        '<p>详见 <a href="https://quietmusic.canace.cn/download">下载页</a></p>',
    );
    expect(document.querySelectorAll("li").length).toBe(2);
    const link = screen.getByText("下载页").closest("a");
    expect(link?.getAttribute("href")).toBe("https://quietmusic.canace.cn/download");
  });

  it("script 等危险片段被剔除，不进正文", () => {
    show("<p>正常说明</p><script>alert('xss')</script>");
    expect(screen.getByText("正常说明")).toBeTruthy();
    expect(document.body.textContent).not.toContain("alert('xss')");
  });

  it("纯文本说明仍按段落渲染（换行 / 链接可点）", () => {
    show("第一行：修复闪退\n第二行：见 https://quietmusic.canace.cn/download");
    expect(screen.getByText(/第一行：修复闪退/)).toBeTruthy();
    expect(screen.getByText(/第二行：见/)).toBeTruthy();
    const link = screen.getByText("https://quietmusic.canace.cn/download").closest("a");
    expect(link?.getAttribute("href")).toBe("https://quietmusic.canace.cn/download");
  });

  it("说明为空：仍然显示「暂无更新说明」", () => {
    show("   ");
    expect(screen.getByText("暂无更新说明")).toBeTruthy();
  });
});
