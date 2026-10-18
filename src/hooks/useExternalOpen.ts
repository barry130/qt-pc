import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import * as ipc from "@/services/ipc";
import { usePlayerStore } from "@/stores/player";
import { toast, toastError } from "@/stores/toast";

/**
 * 「外部打开」入口：把从应用外面带进来的本地文件播起来。
 *
 * 三条来源，一个动作（入队播放 + 入库）：
 * - **拖拽入窗**：路径由 `onDragDropEvent` 直接给出；
 * - **命令行参数**：`QuietMusic.exe 歌.flac`，Rust 在 `setup` 里入队（那时前端还没起来）；
 * - **第二实例转发**：已有一个实例在跑时，再次拉起只会把路径转给主实例（Rust 入队 + emit）。
 *
 * 后两条不走事件载荷而是「Rust 侧队列 + 空事件唤醒」，所以这里必须**先挂监听再取空**：
 * 先取空的话，两步之间到达的唤醒就没人听了。挂监听是异步的（`listen` 返回 Promise），
 * 这也是本 Hook 不直接用 `useTauriEvent` 的原因 —— 需要拿到注册完成的时机来排序。
 *
 * 返回拖拽悬停状态，供主壳显示「松手即播放」提示。
 */
export interface ExternalDragState {
  /** 是否有文件正悬停在窗口上（拖拽提示浮层的开关） */
  dragging: boolean;
  /** 本次悬停看到的条目数（`enter` 才会带路径；`over` 复用上一次的值） */
  count: number;
}

export function useExternalOpen(): ExternalDragState {
  const [dragCount, setDragCount] = useState(0);

  /** 打开一批路径：可播放的直接入队播放，跳过项与失败都给用户一句话回执。 */
  const open = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    try {
      const { tracks, skipped } = await ipc.openLocalPaths(paths);
      if (tracks.length > 0) {
        // 顺序即用户松手/传参的顺序（Rust 侧保序），所以从第 0 首开始放
        await usePlayerStore.getState().playQueue(tracks, 0);
      }
      if (tracks.length === 0) {
        toastError("没有可播放的音频文件");
      } else if (skipped.length > 0) {
        // 「播了几首、跳了几个」缺一不可：只说跳过会让用户以为没反应
        toast(`已播放 ${tracks.length} 首，跳过 ${skipped.length} 个无法打开的条目`);
      }
    } catch (err) {
      toastError(`打开本地文件失败：${String(err)}`);
    }
  }, []);

  /** 取空待打开队列并播放（取空是原子的，重复调用不会重播）。 */
  const drain = useCallback(async () => {
    try {
      await open(await ipc.takePendingOpenPaths());
    } catch {
      // 取队列都失败说明后端不可用，此时也没有别的补救动作
    }
  }, [open]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void (async () => {
      try {
        unlisten = await listen(ipc.OPEN_LOCAL_PATHS_EVENT, () => {
          void drain();
        });
      } catch {
        // 注册失败：后端不可用时队列里也不会有东西，不值得打断 UI
      }
      if (disposed) {
        unlisten?.();
        return;
      }
      // 监听就绪之后再取一次，接管「启动参数早于前端就绪」的那批路径
      await drain();
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [drain]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    // getCurrentWebview() 在没有 Tauri internals 的环境里会**同步**抛错（浏览器预览、
    // jsdom 单测）：拖拽监听挂不上不该让整个主壳被错误边界接管。
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "drop") {
            setDragCount(0);
            void open(payload.paths);
            return;
          }
          if (payload.type === "leave") {
            setDragCount(0);
            return;
          }
          // over 只有坐标没有路径：沿用 enter 记下的条目数
          if (payload.type === "enter") setDragCount(payload.paths.length);
        })
        .then((u) => {
          if (disposed) u();
          else unlisten = u;
        })
        .catch(() => undefined);
    } catch {
      // 没有 webview 事件源时拖拽不可用，其余功能不受影响
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [open]);

  return { dragging: dragCount > 0, count: dragCount };
}
