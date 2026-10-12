import { RouterProvider } from "@tanstack/react-router";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { router } from "@/lib/router";
import { LyricWindow } from "@/components/lyric/LyricWindow";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";

/**
 * 应用入口：按窗口 label 分流（DESIGN §10.2）。
 * 桌面歌词窗口复用同一 index.html 入口，label === "lyrics" 时渲染歌词视图，
 * 主窗口走路由。
 */
export default function App(): React.JSX.Element {
  if (getCurrentWindow().label === "lyrics") {
    return (
      // autoReset：歌词窗是无边框透明窗、也没有「重试」按钮可点，一旦被错误边界
      // 接管就是永久停在错误卡片上（用户 2026-10-12 实测：整块变成「这块内容出错了
      // （桌面歌词）」且不自愈）。它没有 resetKey 可依赖 —— 这个窗口不换路由、
      // 不切页签，没有任何「状态变了」的时机能触发恢复，只能靠自动重试。
      // 重试之所以有效：边界接住异常时 React 会卸载整棵子树，重试＝重新挂载、
      // 重新走初始化与取词，偶发错误（越界、竞态）因此能自愈。
      <ErrorBoundary label="桌面歌词" autoReset>
        <LyricWindow />
      </ErrorBoundary>
    );
  }
  return <RouterProvider router={router} />;
}
