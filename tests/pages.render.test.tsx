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
  // BackButton（反馈页等页面内返回入口）用 router.history 做返回
  useRouter: () => ({ history: { canGoBack: () => false, back: vi.fn() } }),
}));

async function renderAfterEffects(node: React.ReactElement): Promise<HTMLElement> {
  const { container } = render(node);
  // 等挂载后的 useEffect（加载数据）跑完一轮
  await new Promise((r) => setTimeout(r, 30));
  return container;
}

describe("页面渲染冒烟", () => {
  it("本地音乐页：扫描设置默认收起，展开后显示目录引导", async () => {
    const { LibraryPage } = await import("@/components/library/LibraryPage");
    const { fireEvent } = await import("@testing-library/react");
    const container = await renderAfterEffects(<LibraryPage />);
    expect(container.textContent).toContain("本地音乐");
    // 扫描设置默认收起：右上只有「扫描设置 / 扫描」入口，目录引导藏起来
    expect(container.textContent).toContain("扫描设置");
    expect(container.textContent).not.toContain("还没有扫描目录");
    // 点「扫描设置」展开 → 显示添加目录引导
    const toggle = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("扫描设置"),
    );
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle!);
    expect(container.textContent).toContain("还没有扫描目录");
  });

  it("我的歌单页：空态提示（已与收藏合并为一页）", async () => {
    const { MyPlaylistsPage } = await import("@/components/mine/MyPlaylistsPage");
    const container = await renderAfterEffects(<MyPlaylistsPage />);
    expect(container.textContent).toContain("我的歌单");
    // 歌单是唯一组织单位：建单 / 导入 / 收藏都在这一页；
    // 云端收藏改为进页自动拉取，没有手动同步按钮（MyPlaylistsPage 头注）
    expect(container.textContent).toContain("还没有歌单");
    expect(container.textContent).toContain("导入");
  });

  it("个人中心页：未登录态渲染登录入口与本地统计", async () => {
    const { ProfilePage } = await import("@/components/mine/ProfilePage");
    const container = await renderAfterEffects(<ProfilePage />);
    expect(container.textContent).toContain("未登录");
    expect(container.textContent).toContain("登录 / 注册");
    expect(container.textContent).toContain("常用");
    // 统计格与常用入口是登录与否都在的
    expect(container.textContent).toContain("本地歌曲");
    expect(container.textContent).toContain("我的歌单");
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
