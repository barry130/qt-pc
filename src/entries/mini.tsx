import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { MiniPlayer } from "@/components/player/MiniPlayer";
import { installHiddenPause, installWindowErrorLog } from "./boot";

/**
 * 迷你播放器窗口的独立入口（mini.html，由 src-tauri/src/mini_window.rs 加载）。
 *
 * 见 src/entries/lyric.tsx 的说明：小窗不再复用主窗入口，模块图只剩
 * React + MiniPlayer + 共享样式。autoReset 同样必须保留 —— 无边框小窗
 * 没有重试入口，只能靠错误边界自动重挂载自愈。
 */
installWindowErrorLog();
installHiddenPause();

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary label="迷你播放器" autoReset>
        <MiniPlayer />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
