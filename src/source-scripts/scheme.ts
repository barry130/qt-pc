/**
 * 音源方案（取链方案）开关 —— 只指定一个方案，没有方案间优先级。
 *
 * 2026-09-18 起不再有「换源顺序」：每个方案内部已经自带多线路换源与跨源
 * 兜底（脚本包 = 官方接口 + 实测第三方线路聚合链；优选聚合 = 脚本包放不下
 * 的剩余线路），方案之间再排优先级只会串行等待、越换越慢。选中谁就只走谁，
 * 它自己失败即该曲本次播放失败（返回空串，由引擎兜底/报错）。
 *
 * scheme（lightlisten.source-scheme）取值：
 * - "script"（默认）：内置脚本包方案；
 * - 其他 id：drop-in 自注册方案（schemes/ 任意子目录下的 scheme.ts，如 premium）。
 *
 * 原生 Rust Provider 已整体删除，第三方音源接口只由脚本层承担；
 * 历史遗留的 "rust" 存值读取时归一为 "script"。
 * 历史键 lightlisten.source-fallback-order（旧的换源顺序）已不再读取。
 *
 * 持久化在 localStorage（调试开关；转正后挪入 settings 表）。
 */
import type { SchemeId } from "./contract";
import { isKnownSchemeId } from "./schemes/registry";

const STORAGE_KEY = "lightlisten.source-scheme";

/** 内存覆盖（Node 测试环境没有 localStorage，setScheme 亦可直接注入） */
let override: SchemeId | null = null;

/** "rust" 是删除原生实现前的历史存值，读取时归一为 "script" */
function normalizeScheme(value: string | null): SchemeId {
  if (value === "rust") return "script";
  return value !== null && isKnownSchemeId(value) ? value : "script";
}

export function getScheme(): SchemeId {
  if (override !== null) return override;
  try {
    return normalizeScheme(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "script";
  }
}

export function setScheme(scheme: SchemeId): void {
  override = scheme;
  try {
    localStorage.setItem(STORAGE_KEY, scheme);
  } catch {
    // 无 localStorage（测试环境）：仅内存覆盖生效
  }
}
