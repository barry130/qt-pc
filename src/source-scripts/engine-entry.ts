/**
 * source-bundle.js 的入口（scripts/build-sources.mjs 用 Vite 库模式打包，
 * 音源包热更新开发方案 P3）。
 *
 * 只导出平台无关面：createSourceLayer（deps 注入 request/platform）与
 * chain 配置的解析/默认值（P1 引擎页装载与冒烟用）。刻意不包含：
 * - host-request.ts：HTTP 由宿主注入（uniappx 与 PC 各自实现）；
 * - @/services/ipc：仅主窗口使用（回填引擎缓存）。
 *
 * 同一份产物两种消费形态（见 qt-entries.ts 文件头）：
 * - PC：动态 import 取命名导出；
 * - 安卓/iOS：模块脚本执行，靠下方自注册写 globalThis.__qtEntries。
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
export { registerQtEntries, type QtHost, type QtGetPlayUrlArgs } from "./qt-entries";

import { registerQtEntries, type QtHost } from "./qt-entries";

// 安卓/iOS 宿主（prelude 注入 __qtHost）在 bundle 顶层完成入口注册；PC 引擎页
// 没有这个全局，导入本 bundle 只得到命名导出，不产生任何副作用。
const host = (globalThis as unknown as { __qtHost?: QtHost }).__qtHost;
if (host !== undefined && host !== null && typeof host.request === "function") {
  registerQtEntries(host);
}
