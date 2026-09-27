/**
 * 页面级代码分割。
 *
 * 背景：打包产物原本几乎是**一个**大 chunk，进应用第一屏（哪怕只是搜索页/发现页）
 * 就要解析全部 27 个路由组件与 10 个常驻页面的代码，冷启动首帧被白白拖慢。
 * 这里把每个页面包成 `React.lazy`，首次真正进入该页时才拉对应 chunk。
 *
 * 两个前提：
 * 1. 使用方必须提供 `Suspense` 兜底（见 AppShell / KeepAliveOutlet）。没有边界时
 *    懒加载组件首次渲染会同步挂起，React 直接抛错。
 * 2. chunk 与主包同源：Tauri 用内置资源协议加载 `dist/`，动态 import 的产物
 *    走同一套解析，CSP 的 `'self'` 与 `script-src` 也覆盖得到，不需要额外放行。
 */
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * 把一个具名导出包装成懒加载组件。
 *
 * @param loader 形如 `() => import("@/components/XxxPage")`
 * @param name   该模块里要取的**具名导出**名（写错时下面会抛出可读的错误）
 */
export function lazyPage<P extends object = object>(
  loader: () => Promise<Record<string, unknown>>,
  name: string,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(async () => {
    const mod = await loader();
    const component = mod[name];
    if (typeof component !== "function") {
      // 导出名对不上时给一条看得懂的错误，而不是 React 那句
      // "Element type is invalid"，让人去猜是哪个页面坏了
      throw new Error(`动态导入的模块没有导出组件 ${name}()`);
    }
    return { default: component as ComponentType<P> };
  });
}

/** 懒加载页面的统一兜底：只是进程内 chunk 加载，通常只闪现一帧 */
export function PageFallback(props: { label?: string }): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-full w-full items-center justify-center py-16 text-sm text-muted-foreground"
    >
      {props.label ?? "加载中…"}
    </div>
  );
}
