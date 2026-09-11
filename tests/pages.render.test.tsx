// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

// jsdom 下无 Tauri internals，mock 掉 IPC 与事件入口。
// 列表类命令返回空数组，模拟「库里还没数据」的首次启动状态。
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (
      cmd === "get_local_tracks" ||
      cmd === "get_scan_dirs" ||
      cmd === "list_favorites" ||
      cmd === "list_history" ||
      cmd === "get_latest_songs" ||
      cmd === "get_recommendations"
    ) {
      return [];
    }
    return {};
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

async function renderAfterEffects(node: React.ReactElement): Promise<HTMLElement> {
  const { container } = render(node);
  // 等挂载后的 useEffect（加载数据）跑完一轮
  await new Promise((r) => setTimeout(r, 30));
  return container;
}

describe("页面渲染冒烟", () => {
  it("本地音乐页：渲染标题与目录引导", async () => {
    const { LibraryPage } = await import("@/components/library/LibraryPage");
    const container = await renderAfterEffects(<LibraryPage />);
    expect(container.textContent).toContain("本地音乐");
    expect(container.textContent).toContain("还没有扫描目录");
  });

  it("我的收藏页：空态提示", async () => {
    const { FavoritesPage } = await import("@/components/mine/FavoritesPage");
    const container = await renderAfterEffects(<FavoritesPage />);
    expect(container.textContent).toContain("我的收藏");
    // 收藏页只列歌单了（歌单是唯一组织单位），歌曲不再单列
    expect(container.textContent).toContain("还没有歌单");
  });

  it("最近播放页：空态提示", async () => {
    const { HistoryPage } = await import("@/components/mine/HistoryPage");
    const container = await renderAfterEffects(<HistoryPage />);
    expect(container.textContent).toContain("最近播放");
    expect(container.textContent).toContain("还没有播放记录");
  });

  it("每日新歌页：只渲染新歌列表", async () => {
    const { DailyPage } = await import("@/components/discovery/DailyPage");
    const container = await renderAfterEffects(<DailyPage />);
    expect(container.textContent).toContain("每日新歌");
    // 只保留新歌列表：没有「换一批」，也不再有推荐歌单区块
    expect(container.textContent).not.toContain("换一批");
    expect(container.textContent).not.toContain("推荐歌单");
  });

  it("意见反馈页：渲染表单", async () => {
    const { FeedbackPage } = await import("@/components/mine/FeedbackPage");
    const container = await renderAfterEffects(<FeedbackPage />);
    expect(container.textContent).toContain("意见反馈");
    expect(container.textContent).toContain("问题反馈");
  });
});
