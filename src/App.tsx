import { lazy, Suspense } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { LYRICS_WINDOW_LABEL, MINI_WINDOW_LABEL } from "@/lib/window-labels";

const MainWindow = lazy(() => import("@/MainWindow"));
const LyricWindow = lazy(() => import("@/components/lyric/LyricWindow").then((module) => ({ default: module.LyricWindow })));
const MiniPlayer = lazy(() => import("@/components/player/MiniPlayer").then((module) => ({ default: module.MiniPlayer })));

/**
 * 应用入口：按窗口 label 分流（DESIGN §10.2）。
 * 桌面歌词窗口与迷你播放器窗口复用同一 index.html 入口，label 命中时渲染
 * 各自视图，主窗口走路由。
 */
export default function App(): React.JSX.Element {
  const label = getCurrentWindow().label;
  if (label === LYRICS_WINDOW_LABEL) {
    return (
      // autoReset：歌词窗是无边框透明窗、也没有「重试」按钮可点，一旦被错误边界
      // 接管就是永久停在错误卡片上（用户 2026-10-12 实测：整块变成「这块内容出错了
      // （桌面歌词）」且不自愈）。它没有 resetKey 可依赖 —— 这个窗口不换路由、
      // 不切页签，没有任何「状态变了」的时机能触发恢复，只能靠自动重试。
      // 重试之所以有效：边界接住异常时 React 会卸载整棵子树，重试＝重新挂载、
      // 重新走初始化与取词，偶发错误（越界、竞态）因此能自愈。
      <ErrorBoundary label="桌面歌词" autoReset>
        <Suspense fallback={null}><LyricWindow /></Suspense>
      </ErrorBoundary>
    );
  }
  if (label === MINI_WINDOW_LABEL) {
    // 迷你窗同理：无边框小窗没有可点的重试入口，错误边界只能靠自动重试自愈
    return (
      <ErrorBoundary label="迷你播放器" autoReset>
        <Suspense fallback={null}><MiniPlayer /></Suspense>
      </ErrorBoundary>
    );
  }
  return <Suspense fallback={<div role="status" className="flex h-full items-center justify-center text-sm text-muted-foreground">加载中…</div>}><MainWindow /></Suspense>;
}
