/**
 * 音源方案注册表 —— import.meta.glob 自动发现所有 drop-in scheme.ts，
 * 加上内置基线（builtin.ts）。
 *
 * 新增歌源 = 在 schemes/ 下任意子目录写一个 scheme.ts（export default
 * defineScheme({...})），本文件自动收录，无需改任何其它文件。
 */
import type { Source } from "../contract";
import type { PlayUrlResolver, SourceScheme } from "./define";
import { BUILTIN_SCHEMES, getBuiltinScheme } from "./builtin";
import premiumScheme from "./premium/scheme";

/**
 * drop-in 方案自动发现（Vite 专用 import.meta.glob，eager=true 构建期展开成
 * 静态对象，运行时不会抛错）。P3 bundle 构建用 esbuild（无 glob 转换）：
 * 运行时 import.meta.glob 为 undefined → TypeError → catch 走静态表兜底
 * （premium 一家；方案收敛后 drop-in 不再增长）。
 */
let modules: Record<string, { default: SourceScheme }> = {};
try {
  modules = import.meta.glob<{ default: SourceScheme }>("./**/scheme.ts", {
    eager: true,
  });
} catch {
  // esbuild bundle（build-sources.mjs）/ Node 冒烟：走下方静态注册表
}

const REGISTRY = new Map<string, SourceScheme>();

/** 方案是否声明了至少一个取链接口 */
function hasPlayUrl(scheme: SourceScheme): boolean {
  if (typeof scheme.playUrl === "function") return true;
  return (
    scheme.playUrl !== undefined &&
    Object.values(scheme.playUrl).some((handler) => typeof handler === "function")
  );
}

/** 动态注册（drop-in 发现与测试用）；重复 id / 内置 id / 无取链接口的方案被忽略 */
export function registerScheme(scheme: SourceScheme, origin?: string): boolean {
  const from = origin ?? scheme?.id ?? "(unknown)";
  if (!scheme || !scheme.id) {
    console.warn(`[source-scripts] 方案缺少 id，已忽略: ${from}`);
    return false;
  }
  if (scheme.id === "script") {
    console.warn(`[source-scripts] ${scheme.id} 是内置基线，drop-in 不能占用: ${from}`);
    return false;
  }
  if (!hasPlayUrl(scheme)) {
    console.warn(`[source-scripts] 方案没有任何 playUrl 取链接口，已忽略: ${from}`);
    return false;
  }
  if (REGISTRY.has(scheme.id)) {
    console.warn(`[source-scripts] 方案 id 重复，后者被忽略: ${scheme.id} (${from})`);
    return false;
  }
  REGISTRY.set(scheme.id, scheme);
  return true;
}

/** 注销（测试用） */
export function unregisterScheme(id: string): void {
  REGISTRY.delete(id);
}

for (const [file, mod] of Object.entries(modules)) {
  if (mod?.default) registerScheme(mod.default, file);
}
// esbuild bundle / Node 冒烟的静态兜底（glob 未展开时 premium 需手动收录）
if (!REGISTRY.has("premium")) registerScheme(premiumScheme, "./premium/scheme.ts");

/** 是否为可选方案 id（内置基线 + drop-in；"rust" 已随原生实现删除） */
export function isKnownSchemeId(id: string): boolean {
  return id === "script" || REGISTRY.has(id);
}

/** 按 id 取方案（含内置基线） */
export function resolveScheme(id: string): SourceScheme | undefined {
  return getBuiltinScheme(id) ?? REGISTRY.get(id);
}

/** 取 drop-in 注册的方案（不含内置基线） */
export function getRegisteredScheme(id: string): SourceScheme | undefined {
  return REGISTRY.get(id);
}

/** 是否为 drop-in 注册的方案 */
export function isRegisteredScheme(id: string): boolean {
  return REGISTRY.has(id);
}

/** 取方案在指定平台的取链接口（函数形式 = 全平台；未覆盖该平台返回 undefined） */
export function getPlayUrlHandler(
  scheme: SourceScheme,
  platform: Source,
): PlayUrlResolver | undefined {
  const playUrl = scheme.playUrl;
  if (typeof playUrl === "function") return playUrl;
  return playUrl?.[platform];
}

/** 全部可选方案（内置基线 + drop-in），设置页「音源方案」单选列表用 */
export function listSchemes(): { id: string; name: string; description?: string }[] {
  return [
    ...BUILTIN_SCHEMES.map((s) => ({ id: s.id, name: s.name, description: s.description })),
    ...[...REGISTRY.values()].map((s) => ({ id: s.id, name: s.name, description: s.description })),
  ];
}
