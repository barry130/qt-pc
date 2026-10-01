import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import * as ipc from "./services/ipc";
import { ErrorBoundary } from "./components/common/ErrorBoundary";

/**
 * React 挂载之前/之外的兜底提示。
 *
 * 原则：**不清空 #root、不替换界面**。这里以前是 `root.innerHTML = ""`，
 * 而它监听的是 `unhandledrejection` —— 前端有 30+ 处 `void xxx()` 形式的
 * 异步调用，任何一次没接住的 Promise 拒绝都会把整个应用打成一块不可恢复的
 * 红字（React 树已被摘掉，连重试都不可能）。
 *
 * 现在改成在 body 上叠加一个可关闭的浮层：界面还在、还能继续用，用户也能
 * 一键重载；错误照旧写进库（桌面端没有顺手的 devtools，排查时从库里读）。
 */
const OVERLAY_ID = "qt-error-overlay";
/** 浮层里最多保留几条错误，避免连环报错把屏幕刷满 */
const MAX_ENTRIES = 3;

function ensureOverlay(): HTMLElement | null {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) {
    const slot = existing.querySelector("[data-qt-error-slot]");
    return slot instanceof HTMLElement ? slot : null;
  }
  if (!document.body) return null;

  const host = document.createElement("div");
  host.id = OVERLAY_ID;
  host.setAttribute("role", "alert");
  host.style.cssText = [
    "position:fixed",
    "right:12px",
    "bottom:12px",
    "z-index:2147483647",
    "max-width:min(560px, calc(100vw - 24px))",
    "max-height:60vh",
    "overflow:auto",
    "padding:12px 14px",
    "border:1px solid rgba(185,28,28,0.45)",
    "border-radius:10px",
    "background:rgba(255,255,255,0.97)",
    "color:#7f1d1d",
    "box-shadow:0 12px 32px rgba(0,0,0,0.22)",
    "font:12px/1.6 Consolas, monospace",
  ].join(";");

  const title = document.createElement("div");
  title.textContent = "轻听遇到了一个错误（界面仍可继续使用）";
  title.style.cssText =
    "font:600 13px/1.5 system-ui, sans-serif; color:#7f1d1d; margin-bottom:6px";

  const slot = document.createElement("div");
  slot.setAttribute("data-qt-error-slot", "");

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex; gap:8px; justify-content:flex-end; margin-top:10px";

  const buttonStyle =
    "font:12px/1 system-ui, sans-serif; padding:6px 10px; border-radius:6px; cursor:pointer";

  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "重载界面";
  reload.style.cssText = `${buttonStyle}; border:1px solid rgba(185,28,28,0.45); background:#fff; color:#7f1d1d`;
  reload.addEventListener("click", () => window.location.reload());

  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "关闭";
  close.style.cssText = `${buttonStyle}; border:1px solid rgba(185,28,28,0.45); background:#b91c1c; color:#fff`;
  close.addEventListener("click", () => host.remove());

  actions.append(reload, close);
  host.append(title, slot, actions);
  document.body.appendChild(host);
  return slot;
}

function showFatalError(message: string): void {
  console.error("[qt] " + message);
  // 写库失败就算了（ipc 本身可能就是失败原因），浮层上已经能看到
  void ipc.setSetting("app.lastError", message).catch(() => {});
  // 同步落一份进文件日志（release 无 devtools，%APPDATA%/QuietMusic/logs 是唯一现场）
  void ipc.writeLog("error", message).catch(() => {});

  const slot = ensureOverlay();
  if (!slot) return;

  const pre = document.createElement("pre");
  pre.style.cssText = "margin:0 0 6px; white-space:pre-wrap; word-break:break-word";
  // 用 textContent 而不是 innerHTML：错误信息可能带任意字符
  pre.textContent = message;
  slot.appendChild(pre);

  while (slot.childElementCount > MAX_ENTRIES) {
    slot.firstElementChild?.remove();
  }
}

window.addEventListener("error", (e) => {
  showFatalError(`${e.message}\n${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  showFatalError(`未处理的 Promise 拒绝：\n${String(e.reason)}`);
});

try {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary label="应用根">
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
} catch (err) {
  showFatalError(err instanceof Error ? err.stack ?? err.message : String(err));
}