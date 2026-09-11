import { useEffect, useState } from "react";
import { Minus, Square, X, Copy } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTitleBarDrag } from "@/hooks/useFramelessWindow";
import { MusicSourceSwitcher } from "@/components/music-source/MusicSourceSwitcher";
import { cn } from "@/lib/utils";

/**
 * 自定义标题栏（DESIGN §5.3）：
 * - 拖动区（按下即 startDragging）+ 双击最大化
 * - Logo / 全局搜索框 / 音源切换器 / 窗口控制
 * - 按钮区 stopPropagation 防止误触发拖动
 */
export function TitleBar(): React.JSX.Element {
  const { ref, onDoubleClick } = useTitleBarDrag();
  const [maximized, setMaximized] = useState(false);
  const [keyword, setKeyword] = useState("");
  const navigate = useNavigate();
  const win = getCurrentWindow();

  useEffect(() => {
    let un: (() => void) | undefined;
    const run = (): void => {
      void win.isMaximized().then(setMaximized);
      void win.onResized(async () => {
        setMaximized(await win.isMaximized());
      }).then((u) => {
        un = u;
      });
    };
    run();
    return () => un?.();
  }, [win]);

  const goSearch = (): void => {
    const kw = keyword.trim();
    if (!kw) return;
    void navigate({ to: "/search", search: { q: kw } });
  };

  return (
    <div
      ref={ref}
      onDoubleClick={onDoubleClick}
      // relative + z-20 不能省：标题栏有 backdrop-blur，会自成层叠上下文，
      // 而它本身是非定位元素 —— 后面内容区的 `relative z-10` 会盖在它上面，
      // 把音源切换的下拉（z-50 被关在这个层叠上下文内）整个遮住，
      // 表现就是「点了没反应」。给标题栏一个高于内容区的层级即可。
      className="relative z-20 flex h-[40px] shrink-0 select-none items-center justify-between border-b border-border bg-sidebar pr-0 backdrop-blur-sm"
    >
      {/* 左：Logo + 应用名 */}
      <div className="flex h-full items-center gap-2 pl-3">
        <img src="/app-icon.svg" alt="" className="h-5 w-5" draggable={false} />
        <span className="text-sm font-semibold">轻听</span>
      </div>

      {/* 中：全局搜索框 + 音源切换器 */}
      <div className="flex h-full min-w-0 flex-1 items-center justify-center gap-3 px-6">
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") goSearch();
          }}
          placeholder="搜索歌曲 / 歌手 / 专辑 / 歌单"
          className="h-7 w-full max-w-72 rounded-full border border-input bg-background px-3 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <MusicSourceSwitcher />
      </div>

      {/* 右：窗口控制 */}
      <div className="flex h-full items-stretch">
        <WindowButton onClick={() => void win.minimize()} label="最小化">
          <Minus className="h-4 w-4" />
        </WindowButton>
        <WindowButton
          onClick={() => void win.toggleMaximize()}
          label={maximized ? "还原" : "最大化"}
        >
          {maximized ? (
            <Copy className="h-3.5 w-3.5 -scale-x-100" />
          ) : (
            <Square className="h-3 w-3" />
          )}
        </WindowButton>
        <WindowButton onClick={() => void win.close()} label="关闭" danger>
          <X className="h-4 w-4" />
        </WindowButton>
      </div>
    </div>
  );
}

function WindowButton(props: {
  onClick: () => void;
  label: string;
  danger?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={props.onClick}
      className={cn(
        "flex w-11 items-center justify-center text-foreground/80 transition-colors hover:bg-secondary hover:text-foreground",
        props.danger && "hover:bg-destructive hover:text-white",
      )}
    >
      {props.children}
    </button>
  );
}
