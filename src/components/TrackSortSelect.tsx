/**
 * 歌曲列表排序控件（2026-10-24，用户 m02960：所有歌曲列表页都要有排序）。
 *
 * 2026-10-24 晚改口径（用户 m00002 / m00029）：「排序格式换一下，换成两个弹窗，
 * 上面显示按歌曲名、按专辑名、按歌手名，下面显示正序、倒序。默认顺序都不勾选。」
 * 所以这里不再是塞了 7 项的原生 `<select>`，而是**两个并排的触发按钮**（各带一个弹层）：
 *
 * - 左：维度弹窗（按歌曲名 / 按专辑名 / 按歌手名）；
 * - 右：方向弹窗（正序 / 倒序），没选维度时置灰 —— 没有维度就没有方向；
 *
 * 2026-10-29（用户 m03542「把排序和方向改为一行的吧」）：两个按钮原先上下堆叠，
 * 在页头右侧占掉两行高度、和旁边的搜索框对不齐；改成一排后整块矮 28px，
 * 右边缘仍与搜索框对齐。
 * - 默认两个都不勾选（value = `DEFAULT_TRACK_SORT`），列表保持音源给的原始顺序；
 *   不再显示「默认顺序」这个假选项，再点一次已选维度就是取消排序。
 *
 * 对外契约仍是 `{ value, onChange }` 的「维度-方向」字符串（见
 * `@/lib/track-sort` 的 `trackSortValue` / `parseTrackSort`），6 个已有列表页
 * 与 `DailyPage` 都只存一个 `sortValue`，不需要跟着改成两个 state。
 *
 * 弹层复用 `@/components/common/Popover`（点外面 / Esc 收起、条件挂载都收在一处），
 * 面板样式对齐标题栏的音源切换器：bg-popover/95 + backdrop-blur，不写死明暗色。
 */
import type { JSX } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover } from "@/components/common/Popover";
import { cn } from "@/lib/utils";
import {
  DEFAULT_TRACK_SORT,
  TRACK_SORT_DIRECTIONS,
  TRACK_SORT_FIELDS,
  parseTrackSort,
  trackSortValue,
} from "@/lib/track-sort";
import type { TrackSortKey } from "@/lib/track-sort";

interface TrackSortSelectProps {
  /** `@/lib/track-sort` 里的编码值（如 `album-desc`；`none` = 不排序） */
  value: string;
  onChange: (value: string) => void;
  /** 无障碍名，默认「排序方式」 */
  label?: string;
  className?: string;
}

/** 触发按钮的公共样式：与列表页工具列里的其它控件同高（h-7）、同边框 */
const TRIGGER_CLASS =
  "flex h-7 min-w-[4.5rem] shrink-0 items-center justify-between gap-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40";

/** 弹层面板的公共样式（absolute 定位由面板自己带，上下文由 Popover 包裹层提供） */
const PANEL_CLASS =
  "absolute right-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-border bg-popover/95 py-1 shadow-raised backdrop-blur-xl";

export function TrackSortSelect(props: TrackSortSelectProps): JSX.Element {
  const { value, onChange, label = "排序方式", className } = props;
  const { key, desc } = parseTrackSort(value);
  const field = key === "none" ? null : key;
  const fieldLabel = TRACK_SORT_FIELDS.find((item) => item.key === field)?.label ?? null;
  const direction = field === null ? null : desc ? "desc" : "asc";
  const directionLabel =
    TRACK_SORT_DIRECTIONS.find((item) => item.value === direction)?.label ?? null;

  /** 选维度：同维度再点一次 = 取消排序；换维度保留当前方向（默认正序） */
  const pickField = (nextKey: Exclude<TrackSortKey, "none">): void => {
    onChange(field === nextKey ? DEFAULT_TRACK_SORT : trackSortValue(nextKey, desc));
  };

  /** 选方向：必须已经有维度（按钮本身在无维度时是 disabled 的，这里兜底） */
  const pickDirection = (nextDesc: boolean): void => {
    if (field === null) return;
    onChange(trackSortValue(field, nextDesc));
  };

  return (
    <div
      role="group"
      aria-label={label}
      title="排序方式（只影响当前列表的显示顺序，不改歌单本身）"
      className={cn("flex shrink-0 items-center gap-1", className)}
    >
      <Popover
        trigger={(state) => (
          <button
            type="button"
            aria-label="排序字段"
            aria-haspopup="listbox"
            aria-expanded={state.open}
            onClick={state.toggle}
            className={cn(TRIGGER_CLASS, state.open && "bg-secondary")}
          >
            <span className={cn("truncate", fieldLabel === null && "text-muted-foreground")}>
              {fieldLabel ?? "排序"}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
          </button>
        )}
      >
        {(close) => (
          <ul role="listbox" aria-label="排序字段" className={cn(PANEL_CLASS, "w-32")}>
            {TRACK_SORT_FIELDS.map((item) => {
              const active = field === item.key;
              return (
                <li key={item.key}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    title={active ? "再点一次取消排序" : undefined}
                    onClick={() => {
                      close();
                      pickField(item.key);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between px-3 py-1.5 text-xs transition-colors hover:bg-secondary hover:text-foreground",
                      active ? "text-primary" : "text-popover-foreground",
                    )}
                  >
                    <span>{item.label}</span>
                    {active ? <Check className="h-3.5 w-3.5 text-primary" aria-hidden /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Popover>

      <Popover
        trigger={(state) => (
          <button
            type="button"
            aria-label="排序方向"
            aria-haspopup="listbox"
            aria-expanded={state.open}
            disabled={field === null}
            title={field === null ? "先选排序字段" : "排序方向"}
            onClick={state.toggle}
            className={cn(TRIGGER_CLASS, state.open && "bg-secondary")}
          >
            <span className={cn("truncate", directionLabel === null && "text-muted-foreground")}>
              {directionLabel ?? "方向"}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
          </button>
        )}
      >
        {(close) => (
          <ul role="listbox" aria-label="排序方向" className={cn(PANEL_CLASS, "w-24")}>
            {TRACK_SORT_DIRECTIONS.map((item) => {
              const active = direction === item.value;
              return (
                <li key={item.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      close();
                      pickDirection(item.desc);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between px-3 py-1.5 text-xs transition-colors hover:bg-secondary hover:text-foreground",
                      active ? "text-primary" : "text-popover-foreground",
                    )}
                  >
                    <span>{item.label}</span>
                    {active ? <Check className="h-3.5 w-3.5 text-primary" aria-hidden /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Popover>
    </div>
  );
}
