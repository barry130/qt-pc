import { createContext, useContext } from "react";

/**
 * 「我当前是否可见」——由 KeepAliveOutlet 为每个常驻缓存页注入。
 *
 * 单独成模块（而不是放在 KeepAliveOutlet.tsx 里）是为了避免循环依赖：
 * KeepAliveOutlet 需要 import 各页面，各页面又需要 import 这个 hook。
 *
 * 默认 true：非缓存页（走 <Outlet /> 的普通路由）挂载着就说明它在显示，
 * 因此这些页面的加载 effect 写法与缓存页完全一致，不需要区分。
 */
export const KeepAliveActiveContext = createContext(true);

export function useKeepAliveActive(): boolean {
  return useContext(KeepAliveActiveContext);
}