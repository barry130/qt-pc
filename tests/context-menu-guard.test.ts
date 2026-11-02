// @vitest-environment jsdom
/**
 * 全局右键守卫（`useContextMenuGuard`，DESIGN R81）。
 *
 * 为什么要单独测：2026-11-02 用户反馈排行榜等页面右键弹出的是浏览器原生菜单
 * （返回 / 刷新 / 另存为 / 检查），对播放器一处用处都没有。守卫靠一条 window 级
 * `contextmenu` 监听拦掉它，但有三个例外不能误伤：输入框（要粘贴）、
 * 文本编辑处（要拼写检查）、划选后的文本（要复制）。例外一旦写错，
 * 用户要么在输入框里粘贴不了，要么复制不了歌词 —— 都是静默的功能退化，
 * 所以四条行为在这里钉死。
 */
import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useContextMenuGuard } from "@/hooks/useContextMenuGuard";

/** 派发一次可取消的右键事件，返回 defaultPrevented（true = 原生菜单被拦掉）。 */
function dispatchContextMenu(target: Element): boolean {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function append(tag: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  document.body.appendChild(el);
  return el;
}

describe("useContextMenuGuard", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = "";
  });

  it("普通区域右键被拦掉（不再弹浏览器原生菜单）", () => {
    renderHook(() => useContextMenuGuard());
    expect(dispatchContextMenu(append("div", "全部榜单"))).toBe(true);
  });

  it("输入框 / textarea / contenteditable 内右键放行（复制粘贴要靠系统菜单）", () => {
    renderHook(() => useContextMenuGuard());
    const input = append("input");
    const textarea = append("textarea");
    const editable = append("div");
    editable.setAttribute("contenteditable", "true");
    expect(dispatchContextMenu(input)).toBe(false);
    expect(dispatchContextMenu(textarea)).toBe(false);
    expect(dispatchContextMenu(editable)).toBe(false);
  });

  it("划选文本后右键放行（便于复制），清掉选区后恢复拦截", () => {
    renderHook(() => useContextMenuGuard());
    const div = append("div", "歌词片段");
    const range = document.createRange();
    range.selectNodeContents(div);
    const selection = window.getSelection();
    if (!selection) throw new Error("jsdom 没有 selection");
    selection.removeAllRanges();
    selection.addRange(range);
    expect(dispatchContextMenu(div)).toBe(false);
    selection.removeAllRanges();
    expect(dispatchContextMenu(div)).toBe(true);
  });

  it("卸载后恢复浏览器默认（守卫不留悬挂监听）", () => {
    const { unmount } = renderHook(() => useContextMenuGuard());
    unmount();
    expect(dispatchContextMenu(append("div"))).toBe(false);
  });
});