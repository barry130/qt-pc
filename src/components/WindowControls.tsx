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
  const win = getCurrentWindow();

  useEffect(() => {
    let un: (() => void) | undefined;
    void win.isMaximized().then(setMaximized);
    void win
      .onResized(async () => {
        setMaximized(await win.isMaximized());
      })
      .then((u) => {
        un = u;
      });
    return () => un?.();
  }, [win]);

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

  return (
    <div className={cn(styles.group, props.className)}>
      <button
        type="button"
        aria-label="最小化"
        title="最小化"
        onMouseDown={stop}
        onDoubleClick={stop}
        onClick={() => void win.minimize()}
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
        onClick={() => void win.toggleMaximize()}
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
