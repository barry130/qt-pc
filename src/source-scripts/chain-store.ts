/**
 * chain.json 本地覆盖层（P0）。
 *
 * 读取 appData/source-bundle/chain.json（Rust 命令 source_chain_overlay 返回
 * 原文，读取失败/文件不存在返回 null）→ parseChainConfig 校验 → 失败回退
 * defaultChainConfig()。三层把关的第①层（JSON 能解析 + schema 校验）在这里
 * 兑现：坏配置绝不进入执行器。
 *
 * 启动后读一次并缓存（与「配置读一次，切换需重启」的既有语义一致）；
 * 远端包下载链路（P2）落盘后重启即生效。测试可注入固定配置。
 */
import { invoke } from "@tauri-apps/api/core";
import type { ChainConfig } from "./chain-config";
import { defaultChainConfig, parseChainConfig } from "./chain-config";

let cached: ChainConfig | null = null;

/** 取生效的 chain 配置（overlay 加载失败回退内置默认；结果进程内缓存） */
export async function getChainConfig(): Promise<ChainConfig> {
  if (cached !== null) return cached;
  try {
    const raw = await invoke<string | null>("source_chain_overlay");
    if (raw !== null && raw.length > 0) {
      cached = parseChainConfig(JSON.parse(raw));
      return cached;
    }
  } catch {
    // 文件不存在 / JSON 坏 / schema 坏：一律回退默认（坏 overlay 等同没有）
  }
  cached = defaultChainConfig();
  return cached;
}

/** 测试注入 / P2 重建引擎时的缓存失效入口（null = 下次重新从盘加载） */
export function setChainConfigCache(config: ChainConfig | null): void {
  cached = config;
}
