import { useEffect } from "react";

/**
 * 全局右键守卫（2026-11-02 用户反馈：排行榜等页面右键弹出的是浏览器原生菜单
 * 「返回 / 刷新 / 另存为 / 打印 / 检查」，对音乐播放器一处用处都没有）。
 *
 * 应用里右键只有两类地方有用：
 * ① 自定义曲目菜单（TrackList / PlayingPage）——它们的行处理器本来就
 *    `preventDefault` 并打开自家菜单，冒泡到 window 时我们再拦一次无副作用；
 * ② 输入框与划选的文本——要靠系统菜单的复制 / 粘贴 / 拼写检查，必须放行。
 *
 * 其余区域一律 `preventDefault`：选择「不展示」而不是「改为刷新」——
 * 刷新会丢滚动位置、打断正在进行的界面状态，且与 Ctrl+R 完全重复。
 */
const EDITABLE_SELECTOR =
  "input, textarea, select, [contenteditable], [contenteditable='true'], [contenteditable='plaintext-only']";

export function useContextMenuGuard(): void {
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      // 输入 / 文本编辑处保留系统菜单（复制、粘贴、撤销都在那里）
      if (target.closest(EDITABLE_SELECTOR)) return;
      // 划选了文本：保留系统菜单方便复制（歌词、简介等只读内容）
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.rangeCount > 0) return;
      // 其余区域右键没有用处，不再弹浏览器原生菜单
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);
}
