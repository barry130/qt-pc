import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useMusicSourceStore } from "@/stores/musicSource";
import { useSourceRegistryStore, useSourceLabel } from "@/stores/sourceRegistry";
import { cn } from "@/lib/utils";

/**
 * 标题栏音源切换器（DESIGN §6.2）——音源全局状态的唯一入口。
 * 选项清单来自数据包注册表（stores/sourceRegistry.ts），本端不内置音源列表；
 * 注册表未加载完成前列表为空，当前项展示名兜底「未知」。
 *
 * **切换不整页重载**（2026-10-06：同日早先的 `location.reload()` 方案撤掉）。
 * reload 把每次切源变成一次「前端冷启动」：公告（astral_active_messages）、
 * 登录态恢复、更新检查等 astral 通道全部重打一遍，公告弹窗也跟着每次切源
 * 重新弹出——用户明确要求 astral 部分只在启动时加载，切源只刷新第三方
 * 音源数据。改为响应式重拉：依赖 activeSourceId 的页面自己重取——
 * 发现/每日新歌/歌单广场/榜单四个常驻页都把它写进了数据 effect 依赖
 * （数据包装卸另有 generation 世代驱动），搜索页的 run callback 随 id 变化
 * 触发 URL effect 重搜当前词；本地页、播放队列与正在播的曲目不受影响
 * （曲目的 platform 是它自己的属性，跨源播放本就合法）。历史包袱（每源
 * 能力快照、请求结果就地转换）都按源隔离，reload 并不能额外「收干净」。
 */

export function MusicSourceSwitcher(): React.JSX.Element {
  const activeSourceId = useMusicSourceStore((s) => s.activeSourceId);
  const setActiveSource = useMusicSourceStore((s) => s.setActiveSource);
  const sources = useSourceRegistryStore((s) => s.sources);
  const ensureRegistry = useSourceRegistryStore((s) => s.ensure);
  const activeLabel = useSourceLabel(activeSourceId);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void ensureRegistry();
  }, [ensureRegistry]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  /** 切源：只改全局状态，各页按 activeSourceId / generation 依赖自己重取（见文件头注释）。 */
  const applySource = (id: string): void => {
    setActiveSource(id as Parameters<typeof setActiveSource>[0]);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="切换音源"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1 rounded-full border border-border bg-secondary/50 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent",
          open && "bg-accent",
        )}
      >
        {`音源：${activeLabel}`}
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open && (
        <ul
          role="listbox"
          // 语义令牌：写死 bg-white/70 dark:bg-black/40 会在换肤 / 深浅切换时脱节。
          // 透明度也别太靠页：80% 会让下面的内容明显透上来
          className="absolute left-1/2 top-full z-50 mt-1 w-36 -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover/95 py-1 shadow-2xl backdrop-blur-xl"
        >
          {sources.length === 0 && (
            <li className="px-3 py-1.5 text-xs text-muted-foreground">数据包未就绪</li>
          )}
          {sources.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                role="option"
                aria-selected={s.id === activeSourceId}
                onClick={() => {
                  setOpen(false);
                  if (s.id === activeSourceId) return;
                  applySource(s.id);
                }}
                className={cn(
                  "flex w-full items-center justify-between px-3 py-1.5 text-xs transition-colors hover:bg-secondary hover:text-foreground",
                  s.id === activeSourceId ? "text-primary" : "text-popover-foreground",
                )}
              >
                <span>{s.name}</span>
                {s.id === activeSourceId && (
                  <Check className="h-3.5 w-3.5 text-primary" aria-hidden />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
