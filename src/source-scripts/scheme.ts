/**
 * 取链方案开关（试点）。
 *
 * scheme 决定"调第三方源"的请求走共享脚本包还是宿主内置 Rust 实现：
 * - "rust"（默认）：现状行为，A/B 对拍基准；
 * - "script"：已迁移的动作走共享脚本包，未迁移的平台自动回落 Rust。
 *
 * 持久化在 localStorage（迁移期调试开关；转正后挪入 settings 表，
 * 与「取链方案」设置项对接）。
 */
import type { SchemeId } from "./contract";

const STORAGE_KEY = "lightlisten.source-scheme";

/** 内存覆盖（Node 测试环境没有 localStorage，setScheme 亦可直接注入） */
let override: SchemeId | null = null;

export function getScheme(): SchemeId {
  if (override !== null) return override;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "script" ? "script" : "rust";
  } catch {
    return "rust";
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
