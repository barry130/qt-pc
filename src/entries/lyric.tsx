import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { LyricWindow } from "@/components/lyric/LyricWindow";
import { useSourceRegistryStore } from "@/stores/sourceRegistry";
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

/**
 * 桌面歌词是独立 WebView：主窗口 AppShell 启动时做的音源注册表 ensure()
 * 在这个窗口里不生效。而「按命中线路跨源取词」依赖注册表里的源清单
 * （crossSourceHitFromLine → registryHasSource）：注册表为空时，合法的跨源
 * 命中会被当成「目标源已下线」丢掉，歌词只能按原平台取，时间轴整体偏掉
 * （C08）。所以先等注册表落地再挂载视图。
 *
 * 拉取失败也必须照常挂载 —— 只退回按原平台取词，不能因为音源包没装/引擎没起来
 * 就让整个歌词窗空白。
 */
void (async () => {
  try {
    await useSourceRegistryStore.getState().ensure();
  } catch {
    /* 注册表拉取失败不阻断歌词窗：跨源判断退化为按原平台取词 */
  }
  const root = document.getElementById("root");
  if (!root) return;
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary label="桌面歌词" autoReset>
        <LyricWindow />
      </ErrorBoundary>
    </React.StrictMode>,
  );
})();
