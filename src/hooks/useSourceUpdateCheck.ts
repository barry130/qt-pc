/**
 * 音源包启动静默检查（v3 统一包模型）：
 * - 启动延迟几秒做一次**发现**（discoverSourceUpdates(false)，4h/包 节流在
 *   Rust 生效），失败完全静默（后端没起/离线都正常）；
 * - 发现只提示不自动装：offers 进全局 store，由 SourceUpdatePrompt 逐条
 *   向用户确认（数据包优先）；Rust 侧仅对已装包发 offer，未装不主动
 *   宣传（安装由用户在设置页自行发起）；
 * - 顺带刷新本地状态（设置页/红点/首页引导消费）。
 */
import { useEffect } from "react";
import {
  discoverSourceUpdates,
  getSourceState,
} from "@/source-scripts/source-update";
import { useSourceUpdateStore } from "@/stores/source-update";

/** 启动后延迟（ms）：避开冷启动高负载窗口 */
const STARTUP_DELAY_MS = 3000;

/** 启动挂一次；检查动作静默，结果进全局 store（SourceUpdatePrompt/设置页消费） */
export function useSourceUpdateCheck(): void {
  useEffect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await discoverSourceUpdates(false);
          const store = useSourceUpdateStore.getState();
          store.setOffers(result.offers);
          store.setLocal(await getSourceState());
        } catch {
          // 发现失败完全静默（后端没起/离线都正常）
        }
      })();
    }, STARTUP_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
}
