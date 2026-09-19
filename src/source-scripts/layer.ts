/**
 * 平台无关音源层（音源包热更新方案 P0/P3）。
 *
 * 取链面只依赖注入的 request/platform，不含任何 PC 宿主实现（不 import
 * host-request / @/services/ipc）——本文件是 source-bundle.js 的实现核心，
 * PC 主窗口（index.ts 注入 hostRequest+Windows）与 P1 音源引擎窗口、
 * 未来 uniappx 共用同一实现。
 */
import { LOCAL_PLATFORM, type PlatformId } from "./chain-config";
import { getChainConfig } from "./chain-store";
import type { MusicInfo, Quality, RequestBuiltin, Source } from "./contract";
import { ChainBudget } from "./budget";
import { getScheme } from "./scheme";
import { getPlayUrlHandler, resolveScheme } from "./schemes/registry";

export interface SourceLayerDeps {
  /** 宿主注入的 HTTP 执行（PC=hostRequest→Rust reqwest；引擎窗口/uniappx 各自注入） */
  request: RequestBuiltin;
  /** 宿主平台（chain 线路行级 platforms 过滤基准；PC=1103 Windows） */
  platform: PlatformId;
}

/**
 * 平台无关音源层入口：取链只依赖注入的 request/platform。当前承载取链动作；
 * 搜索/歌单/歌词等宿主面仍在主窗口直调，引擎窗口化时随 P1 扩展。
 */
export function createSourceLayer(deps: SourceLayerDeps) {
  return {
    async resolvePlayUrl(source: Source, song: MusicInfo, quality: Quality): Promise<string> {
      const scheme = resolveScheme(getScheme());
      const handler = scheme ? getPlayUrlHandler(scheme, source) : undefined;
      if (!handler) return "";
      // 外层预算兜底：金额随 ChainConfig（方案内部自带预算，但新方案/第三方
      // LX 宿主挂死时也要在引擎应答预算内给出答复，否则引擎白等才判失败）
      const config = await getChainConfig();
      const budget = new ChainBudget(config.budget.totalMs, config.budget.lineMs);
      // deps.platform 透传给执行器：chain.json 的行级 platforms 过滤按本机平台生效
      // （安卓 1101 与 PC 1103 共用同一份 bundle，这一步是两端唯一的平台差异入口）
      return budget.run(
        Promise.resolve(handler(deps.request, song, quality, deps.platform)),
        "",
      );
    },
  };
}

/** 缺省平台：行级 platforms 未声明的线路按本机平台参与过滤 */
export { LOCAL_PLATFORM };
