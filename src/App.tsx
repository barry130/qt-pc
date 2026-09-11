import { RouterProvider } from "@tanstack/react-router";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { router } from "@/lib/router";
import { LyricWindow } from "@/components/lyric/LyricWindow";

/**
 * 应用入口：按窗口 label 分流（DESIGN §10.2）。
 * 桌面歌词窗口复用同一 index.html 入口，label === "lyrics" 时渲染歌词视图，
 * 主窗口走路由。
 */
export default function App(): React.JSX.Element {
  if (getCurrentWindow().label === "lyrics") {
    return <LyricWindow />;
  }
  return <RouterProvider router={router} />;
}
