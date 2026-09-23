/**
 * `scripts/sync-config.mjs` 的类型声明（供 tests/config.test.ts 引用；
 * .mjs 无类型，TS 侧 import 需要它，否则 strict 下报 TS7016）。
 */

/** app.config.json 的结构（与 docs/CONFIG.md 的字段表一一对应） */
export interface AppConfig {
  product: { name: string; displayName: string; identifier: string };
  version: { name: string; code: number };
  sourcePack: { code: number; name: string; hostApiVersion: number };
  backend: { dev: string; prod: string; active: "dev" | "prod" };
  platform: { android: number; ios: number; windows: number };
  feedback: { platform: string };
  devServer: { port: number; hmrPort: number };
}

/** 一个派生目标的同步状态 */
export interface SyncTarget {
  /** 相对仓库根的路径 */
  file: string;
  /** 这个文件承载哪些值（用于日志与测试失败信息） */
  desc: string;
  /** 当前内容是否与 app.config.json 不一致 */
  changed: boolean;
  /** 文件是否不存在 */
  missing: boolean;
}

export declare const CONFIG_FILE: string;
export declare function loadConfig(): AppConfig;
/** 版本名 → 版本号（1.0.7 → 107） */
export declare function versionCodeOf(name: string): number;
export declare function plan(config?: AppConfig): SyncTarget[];
export declare function sync(config?: AppConfig): SyncTarget[];
export declare function check(config?: AppConfig): SyncTarget[];
