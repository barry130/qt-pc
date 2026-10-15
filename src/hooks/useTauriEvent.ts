import { useEffect, useRef } from "react";
import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * 订阅 Tauri 事件的自定义 Hook：组件卸载自动退订，注册/卸载竞态自动处理。
 *
 * 为什么需要它：`listen` 是异步注册，Effect 清理函数可能在注册 Promise
 * 兑现之前执行（快速挂载/卸载、StrictMode 双调用）。如果不在 `.then` 里
 * 补一刀退订，监听器会在组件销毁后继续存活 —— 窗口级事件源下等于永久泄漏。
 * 这段防御逻辑此前散落在 5 处组件里各写一遍，这里收敛成一份。
 *
 * handler 采用 latest-ref 转发：调用方每次渲染传新闭包也不会触发重新订阅，
 * 因此不需要（也不应该）为 handler 背依赖数组。
 *
 * 注册失败静默处理（与各迁移点原有 `.catch(() => undefined)` 口径一致）：
 * 注册失败意味着本会话收不到该事件，通常伴随后端不可用，不值得打断 UI。
 */
export function useTauriEvent<T>(event: string, handler: EventCallback<T>): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<T>(event, (e) => handlerRef.current(e))
      .then((u) => {
        // 注册返回时组件可能已经卸载：这时必须自己把 unlisten 调掉，否则监听器
        // 会在组件销毁后继续挂在事件源上。
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [event]);
}
