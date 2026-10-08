import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/utils";

/** 窗口控制按钮的两种外观：标题栏内嵌（贴边无圆角）、悬浮（圆角胶囊） */
export type WindowControlsVariant = "titlebar" | "floating";

const VARIANT: Record<
  WindowControlsVariant,
  { group: string; button: string }
> = {
  titlebar: {
    group: "flex h-full items-stretch",
    button:
      "flex w-11 items-center justify-center text-foreground/80 transition-colors hover:bg-secondary hover:text-foreground",
  },
  floating: {
    group: "flex items-center gap-1",
    button:
      "flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
  },
};

/**
 * 跟踪当前窗口是否最大化（用于切换「最大化 / 还原」图标与提示）。
 * 单独抽成 hook：标题栏和播放页都要用，这段逻辑只留一份。
 */
export function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);

  // 依赖数组故意为空：`getCurrentWindow()` 每次调用都新建一个 Window 实例
  // （@tauri-apps/api 内部没有缓存），把它放进依赖里会让这个 effect 在**每次
  // 重渲染**时重新注册一遍 resize 监听。播放时进度条按帧插值（useInterpolatedPosition
  // 的 rAF 循环，约 60fps），于是监听器以每秒几十个的速度累积 —— 2026-10-05 日志里的
  // `event id 115851` 正是「播放约半小时」的累计注册数。监听器一多，事件分发要遍历
  // 整串回调，JS 侧回调表膨胀后随机 id 还会撞车：事件对象被当成某个 invoke 的失败值
  // 抛出来，冒泡成「未处理的 Promise 拒绝（main）：Object {event, payload, id}」。
  useEffect(() => {
    const win = getCurrentWindow();
    let disposed = false;
    let un: (() => void) | undefined;

    // 图标状态是纯装饰：窗口正在销毁、命令被拒时都不该弹全局致命错误浮层，
    // 因此这里每个 promise 都自带失败分支，回调本身永不以 rejected 结束。
    const sync = (): void => {
      void win.isMaximized().then(
        (v) => {
          if (!disposed) setMaximized(v);
        },
        () => {},
      );
    };

    sync();
    void win
      .onResized(() => {
        sync();
      })
      .then(
        (u) => {
          // 注册返回时组件可能已经卸载：这时必须自己把 unlisten 调掉，否则监听器
          // 会永久留在 Rust / JS 两侧（上面的泄漏就是这么攒起来的）。
          if (disposed) u();
          else un = u;
        },
        () => {},
      );

    return () => {
      disposed = true;
      un?.();
    };
  }, []);

  return maximized;
}

/**
 * 最小化 / 最大化（还原）/ 关闭 三个窗口控制按钮。
 *
 * 为什么播放页要自带一份：`AppShell` 里是 `{!isPlayingPage && <TitleBar />}`，
 * 播放页整页隐藏标题栏，全屏播放时窗口上没有任何窗口控制入口。
 *
 * 按钮区一律 stopPropagation：标题栏那层有「按下即拖窗」和「双击最大化」，
 * 不拦住就会变成拖窗口而不是点按钮。
 */
export function WindowControls(props: {
  variant?: WindowControlsVariant;
  className?: string;
  /** 关闭按钮的提示文案：标题栏用「关闭」，播放页用「退出」 */
  closeLabel?: string;
}): React.JSX.Element {
  const styles = VARIANT[props.variant ?? "titlebar"];
  const closeLabel = props.closeLabel ?? "关闭";
  const maximized = useWindowMaximized();
  const win = getCurrentWindow();

  const stop = (e: React.MouseEvent): void => e.stopPropagation();

  // 最小化 / 最大化是纯窗口手势：失败（窗口正在销毁等）只影响这一次点击，不该走
  // main.tsx 的未处理拒绝兜底弹致命浮层（与 startDragging 同一约定）。关闭按钮
  // 故意不加：真关不掉时用户必须看得见。
  return (
    <div className={cn(styles.group, props.className)}>
      <button
        type="button"
        aria-label="最小化"
        title="最小化"
        onMouseDown={stop}
        onDoubleClick={stop}
        onClick={() => void win.minimize().catch(() => {})}
        className={styles.button}
      >
        <Minus className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label={maximized ? "还原" : "最大化"}
        title={maximized ? "还原" : "最大化"}
        onMouseDown={stop}
        onDoubleClick={stop}
        onClick={() => void win.toggleMaximize().catch(() => {})}
        className={styles.button}
      >
        {maximized ? (
          <Copy className="h-3.5 w-3.5 -scale-x-100" />
        ) : (
          <Square className="h-3 w-3" />
        )}
      </button>
      <button
        type="button"
        aria-label={closeLabel}
        title={closeLabel}
        onMouseDown={stop}
        onDoubleClick={stop}
        onClick={() => void win.close()}
        className={cn(
          styles.button,
          "hover:bg-destructive hover:text-white",
        )}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
