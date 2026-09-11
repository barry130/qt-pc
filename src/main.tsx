import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import * as ipc from "./services/ipc";

// 白屏兜底：任何未捕获错误直接渲染进 DOM，避免只有空白窗口没有线索
function showFatalError(message: string): void {
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = "";
  const pre = document.createElement("pre");
  pre.style.cssText =
    "white-space:pre-wrap;padding:24px;font:12px/1.6 Consolas,monospace;color:#b91c1c;";
  pre.textContent = `前端启动失败：\n\n${message}`;
  root.appendChild(pre);
  // 桌面端没有顺手的 devtools，把错误也写进库，排查时直接从库里读。
  // 写失败就算了（比如 ipc 本身就加载不了），DOM 上已经能看到了。
  void ipc.setSetting("app.lastError", message).catch(() => {});
}

window.addEventListener("error", (e) => {
  showFatalError(`${e.message}\n${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  showFatalError(`Unhandled rejection:\n${String(e.reason)}`);
});

try {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} catch (err) {
  showFatalError(err instanceof Error ? err.stack ?? err.message : String(err));
}
