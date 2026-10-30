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

/** 骨架形状：列表（歌单/下载/历史）、网格（封面墙）、详情（大封面+曲目行） */
export type PageFallbackShape = "list" | "grid" | "detail";

/**
 * 懒加载页面的统一兜底。
 *
 * 以前这里只有一行「加载中…」文字——与自家 Skeletons.tsx 的规范
 * （「加载中…」文字算空白态，超过 300ms 必须有形状反馈）自相矛盾，首次进页
 * 会先闪一块白再"跳"出内容。现在按页面形状给骨架：占位块与真实内容的列宽、
 * 行高对齐，chunk 到时直接换内容，不再有布局跳动。
 *
 * 形状由调用方传入（KeepAliveOutlet 按 pathname 定形状）：猜错也只是骨架
 * 长得不一样，不影响正确性。
 */
export function PageFallback(props: {
  label?: string;
  shape?: PageFallbackShape;
}): React.JSX.Element {
  const shape = props.shape ?? "list";
  return (
    <div
      className="flex h-full w-full flex-col"
      role="status"
      aria-live="polite"
      aria-label={props.label ?? "页面加载中"}
    >
      {/* 页头：标题条 + 右侧动作位，与真实页头同高同边距 */}
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="h-5 w-28 animate-pulse rounded bg-muted" />
          <div className="mt-1.5 h-3 w-52 max-w-full animate-pulse rounded bg-muted/60" />
        </div>
        <div className="h-8 w-16 animate-pulse rounded-lg bg-muted/70" />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden p-4">
        {shape === "grid" ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(128px,1fr))] gap-4">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="animate-pulse">
                <div className="aspect-square w-full rounded-xl bg-muted" />
                <div className="mt-2 h-3 w-4/5 rounded bg-muted" />
                <div className="mt-1.5 h-3 w-1/2 rounded bg-muted/60" />
              </div>
            ))}
          </div>
        ) : shape === "detail" ? (
          <div className="animate-pulse">
            <div className="flex items-center gap-5">
              <div className="h-36 w-36 shrink-0 rounded-2xl bg-muted" />
              <div className="min-w-0 flex-1">
                <div className="h-7 w-56 max-w-full rounded bg-muted" />
                <div className="mt-2.5 h-3 w-40 rounded bg-muted/70" />
                <div className="mt-2 h-3 w-64 max-w-full rounded bg-muted/60" />
                <div className="mt-4 h-9 w-32 rounded-lg bg-muted/80" />
              </div>
            </div>
            <div className="mt-6 space-y-2.5">
              {Array.from({ length: 7 }, (_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="h-8 w-8 shrink-0 rounded bg-muted/70" />
                  <div className="h-3 flex-1 rounded bg-muted/60" />
                  <div className="h-3 w-10 rounded bg-muted/50" />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="animate-pulse space-y-2.5">
            {Array.from({ length: 9 }, (_, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="h-10 w-10 shrink-0 rounded-lg bg-muted" />
                <div className="min-w-0 flex-1">
                  <div className="h-3 w-1/3 rounded bg-muted" />
                  <div className="mt-1.5 h-2.5 w-1/5 rounded bg-muted/60" />
                </div>
                <div className="h-3 w-10 shrink-0 rounded bg-muted/50" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
