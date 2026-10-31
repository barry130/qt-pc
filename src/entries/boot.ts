import { getCurrentWindow } from "@tauri-apps/api/window";
import * as ipc from "@/services/ipc";

/**
 * 小窗（桌面歌词 / 迷你播放器）的公共启动垫片。
 *
 * 这两个窗口从 2026-10-30 起走各自的 HTML 入口（lyric.html / mini.html），
 * 不再复用主窗的 index.html + src/main.tsx。主窗那套启动代码里的**全局兜底
 * 浮层**刻意不搬过来：它是给带边框、有标题栏的主窗准备的常驻提示块，糊在
 * 透明无边框的小窗上反而会挡住歌词/封面。
 *
 * 但「出错必须有现场」这条不能丢（release 没有 devtools，库里的日志与
 * %APPDATA%/QuietMusic/logs 是唯一线索），所以这里只保留落库/落文件那一半。
 */
export function installWindowErrorLog(): void {
  const label = ((): string => {
    try {
      return getCurrentWindow().label;
    } catch {
      return "?";
    }
  })();

  const report = (kind: string, detail: string): void => {
    const message = `${kind}（${label}）：${detail}`;
    console.error("[qt] " + message);
    void ipc.writeLog("error", message).catch(() => {});
  };

  window.addEventListener("error", (e) => {
    report("未捕获异常", `${e.message}\n${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason: unknown = e.reason;
    report(
      "未处理的 Promise 拒绝",
      reason instanceof Error
        ? (reason.stack ?? `${reason.name}: ${reason.message}`)
        : String(reason),
    );
  });
}

let hiddenPauseInstalled = false;

/**
 * 窗口不可见时收手（三端共用：主窗 / 桌面歌词窗 / 迷你窗）。
 *
 * 做两件事，都是为了压下后台白占的资源：
 * 1. 切 `html.qt-window-hidden` —— index.css 那条规则会暂停全部 CSS 动画与
 *    过渡（唱片旋转、频谱条、淡入淡出都停在这个 class 上）；
 * 2. 让 Rust 把 WebView2 的内存档位降到 Low（src-tauri/src/webview_mem.rs）。
 *    降档后浏览器会主动回收可丢弃的缓存；切回来会重新走一遍合成，代价是
 *    恢复后的头一两帧略慢，换的是后台少占几十 MB。
 *
 * 只跟随 `document.hidden`（最小化、切到别的虚拟桌面、被完全遮挡都算），
 * 不做轮询；visibilitychange 在 WebView2 里由系统遮挡检测触发，可靠。
 */
export function installHiddenPause(): void {
  // 幂等：三个入口各调一次是正常用法，但重复调用不该叠出一串监听
  // （每个监听都带自己的 last，等于把去重也叠废了）。
  if (hiddenPauseInstalled) return;
  hiddenPauseInstalled = true;

  const root = document.documentElement;
  let last: boolean | null = null;
  const apply = (): void => {
    const hidden = document.hidden;
    if (hidden === last) return;
    last = hidden;
    root.classList.toggle("qt-window-hidden", hidden);
    void ipc.setWebviewMemoryLow(hidden).catch(() => {});
  };
  apply();
  document.addEventListener("visibilitychange", apply);
}
