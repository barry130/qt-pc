/**
 * 本地曲目在数据库、音源注册表与 IPC 层里统一的 platform 取值。
 *
 * 单独抽一个模块而不是从 `@/services/ipc` 取：像 `SourceTag` 这种「只判一下是不是本地」
 * 的展示组件，不该为了一个字符串常量把整个 IPC 层拖进依赖图 —— 否则组件单测也得给
 * 整个 `@/services/ipc` 铺 mock，反而更容易与真实实现漂移。
 */
export const LOCAL_PLATFORM = "local";
