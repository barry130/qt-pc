import { useEffect } from "react";
import { usePlayerStore } from "@/stores/player";

/**
 * 播放器的窗口内键盘操作（B7 无障碍：只用键盘也能完成播放控制）。
 *
 * - `空格`：播放 / 暂停
 * - `←` / `→`：快退 / 快进 10 秒（与播放条按钮、播放页手势同一步长）
 *
 * 三条不抢键的规矩（缺一条都会踩坑）：
 * 1. **输入框里不拦** —— 搜索框、歌单名、标签编辑里打空格是打字，不是暂停；
 *    用 `isTypingTarget` 判 `input/textarea/select/contenteditable`。
 * 2. **别的控件自己会处理** —— 曲目行、菜单项、按钮上的空格是「激活当前项」，
 *    这里再拦一次就会「播了这一首、又把那一条重新播一遍」。判据用 `closest`
 *    覆盖原生可聚焦控件与常见 ARIA 角色。
 * 3. **带修饰键 / 已被处理的不管** —— `Ctrl+K`（命令面板）、`Ctrl+Alt+*`
 *    （全局媒体键）各自有归属；`defaultPrevented` 说明前面已经有人处理了。
 *
 * 全局媒体键（Ctrl+Alt+…）在 Rust 侧由 `src-tauri/src/shortcuts.rs` 注册、
 * 走 `media::dispatch_media_action`，主窗口不在前台也能用；本 hook 只补
 * 「窗口在前台、手已经在键盘上」这一档，两者不冲突。
 */
export const SEEK_STEP_MS = 10_000;

/** 焦点在可输入区域里：空格是打字，方向键是移光标 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

/** 焦点落在「自己会响应空格」的控件上：让给它们 */
function ownsSpace(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.closest(
      'button, a, [role="button"], [role="option"], [role="menuitem"], [role="switch"], [role="tab"], [role="checkbox"], [role="radio"]',
    ) !== null
  );
}

/** 打开着模态框时不让底层偷键（对话框有自己的键盘处理与焦点陷阱） */
function insideModal(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"]') !== null;
}

export function useTransportKeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      // 输入法合成中（中文选字）不当作播放控制
      if (event.isComposing) return;
      if (isTypingTarget(event.target) || insideModal(event.target)) return;

      const store = usePlayerStore.getState();
      // 用 store 顶层的 positionMs / durationMs：这两个才是心脏跳 tick 持续刷新的值，
      // `state` 里那份是最近一次快照，拖动进度条期间会落后。
      const { positionMs, durationMs } = store;

      switch (event.key) {
        case " ":
          if (ownsSpace(event.target)) return;
          event.preventDefault();
          void store.toggle();
          return;
        case "ArrowRight":
        case "ArrowLeft": {
          if (ownsSpace(event.target)) return;
          // 没有在播/没有时长时别把方向键吞掉（列表页的横向滚动还要用）
          if (durationMs <= 0) return;
          const delta = event.key === "ArrowRight" ? SEEK_STEP_MS : -SEEK_STEP_MS;
          event.preventDefault();
          void store.seekTo(Math.max(0, Math.min(durationMs, positionMs + delta)));
          return;
        }
        default:
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
