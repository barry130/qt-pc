import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { LyricWindow } from "@/components/lyric/LyricWindow";
import { installHiddenPause, installWindowErrorLog } from "./boot";

/**
 * 桌面歌词窗口的独立入口（lyric.html，由 src-tauri/src/lyric_window.rs 加载）。
 *
 * 以前这个窗口复用 index.html + src/main.tsx，再靠 App.tsx 按窗口 label 分流 ——
 * 也就是说一个只显示一条歌词的透明小窗，要先把主窗的入口模块、全局兜底、
 * App 分流逻辑全都跑一遍才轮到自己的视图。2026-10-30 的资源优化把它拆成
 * 独立入口：模块图只剩 React + 组件本身 + 共享样式。
 *
 * ErrorBoundary 的 autoReset 必须保留：这个窗口无边框透明、没有可点的
 * 「重试」按钮，一旦被错误边界接管就是永久停在错误卡片上（2026-10-12 实测）。
 */
installWindowErrorLog();
installHiddenPause();

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary label="桌面歌词" autoReset>
        <LyricWindow />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
