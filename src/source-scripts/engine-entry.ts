/**
 * source-bundle.js 的入口（scripts/build-sources.mjs 用 esbuild 打包，
 * 音源包热更新开发方案 P3）。
 *
 * 只导出平台无关面：createSourceLayer（deps 注入 request/platform）与
 * chain 配置的解析/默认值（P1 引擎页装载与冒烟用）。刻意不包含：
 * - host-request.ts：HTTP 由宿主注入（uniappx 与 PC 各自实现）；
 * - @/services/ipc：仅主窗口使用（回填引擎缓存）。
 */
export { createSourceLayer, type SourceLayerDeps } from "./layer";
export {
  defaultChainConfig,
  parseChainConfig,
  LOCAL_PLATFORM,
  PLATFORMS,
  type ChainConfig,
  type ChainLine,
} from "./chain-config";
