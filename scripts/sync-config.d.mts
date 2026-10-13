/**
 * `scripts/sync-config.mjs` 的类型声明（供 tests/config.test.ts 引用；
 * .mjs 无类型，TS 侧 import 需要它，否则 strict 下报 TS7016）。
 *
 * 改同步器的导出时**必须同步改这里**：声明与实现不一致时 TS 只会说
 * "has no exported member"，看不出是声明过期。
 */

/** app.config.json 的结构（与 docs/CONFIG.md 的字段表一一对应） */
export interface AppConfig {
  product: { name: string; displayName: string; identifier: string };
  version: { name: string; code: number };
  sourcePack: { code: number; name: string; hostApiVersion: number };
  /**
   * 后端配置。**这里只有本机联调地址**：生产地址属于私有值，只存在于
   * `app.config.local.json`（被 .gitignore 忽略），所以没有 `prod` 字段。
   */
  backend: { dev: string; active: "dev" | "prod" };
  platform: { android: number; ios: number; windows: number };
  feedback: { platform: string };
  devServer: { port: number; hmrPort: number };
}

/**
 * `app.config.local.json` 的结构（私有值，字段全部可选）。
 *
 * 公开仓库 / CI 裸构建就是"没有这个文件"的形态，所以读取器返回的是
 * 空对象而不是抛错。
 */
export interface LocalConfig {
  /** 生产后端地址（形如 `https://<自有域名>/api/v1/`） */
  backendBaseUrl?: string;
  /** 官网地址（设置页的教程 / 协议 / 隐私 / 反馈入口） */
  officialSiteUrl?: string;
  /** 自有域名后缀（明文 http 放行的唯一依据） */
  ownDomains?: string[];
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
export declare const PRIVATE_FILE: string;
export declare function loadConfig(): AppConfig;
export declare function loadLocalConfig(): LocalConfig;
/** 版本名 → 版本号（1.0.7 → 107） */
export declare function versionCodeOf(name: string): number;
export declare function plan(config?: AppConfig): SyncTarget[];
export declare function sync(config?: AppConfig): SyncTarget[];
export declare function check(config?: AppConfig): SyncTarget[];
