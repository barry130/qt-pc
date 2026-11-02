import { Radio as RadioIcon, SkipForward, SlidersHorizontal, ThumbsDown, Play, Square } from "lucide-react";
import { DAILY_TASTE_HINT, DAILY_TASTE_LABEL } from "@/lib/daily-recommend";
import type { DailyTaste } from "@/lib/recommend-types";
import type { Track } from "@/types";
import { useRadioStore } from "@/stores/radio";
import { usePlayerStore } from "@/stores/player";
import { Button, EmptyState, Segmented } from "@/components/ui";

/**
 * 私人 FM（路由 /radio，A7，对照分析文档 §4.7）。
 *
 * ## 页面只是旋钮，队列在播放器里
 * "接下来几首"就是播放器队列本身 —— 本页**不持有英雄队列**，只读
 * `usePlayerStore` 的 `queue`/`queueIndex`，显示当前曲目与后面 5 首。
 * 这样「下一首」按钮、双击某首、队列面板三处永远是同一个真相，
 * 不会出现"页面说接下来是 A，播放器却放 B"。
 *
 * ## 谁来补歌
 * 页面不补歌。`AppShell` 挂的 `useRadioRefill()` 心跳每秒调一次
 * `useRadioStore.tick()`，按播放器余量自动补批 —— 离开本页也照常补。
 * 补歌绑定的是「FM 还持有队列」（`queueClaimed` + usedKeys 归属核对），
 * 不是页面可见性：页面 effect 一关队列放完就会绕回旧批次（2026-11-02 修复）。
 *
 * ## 为什么开始/停止是两个按钮状态
 * `stop()` 只停"继续推歌"，不打断正在响的音乐：队列里还剩什么就放什么，
 * 放完按普通队列的规矩停。停 FM 不该变成"把歌掐了"。
 */

const TASTE_OPTIONS: { value: DailyTaste; label: string; title: string }[] = (
  ["heart", "familiar", "explore"] as DailyTaste[]
).map((taste) => ({
  value: taste,
  label: DAILY_TASTE_LABEL[taste].replace("模式", ""),
  title: DAILY_TASTE_HINT[taste],
}));

/** 封面兜底：本地曲目常常没有图，用一个小音符占位，避免整卡塌陷 */
function Cover(props: { track: Track; className: string }): React.JSX.Element {
  return props.track.picUrl ? (
    <img
      src={props.track.picUrl}
      alt=""
      className={`${props.className} shrink-0 rounded-md object-cover`}
      loading="lazy"
    />
  ) : (
    <div
      className={`${props.className} flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground`}
      aria-hidden="true"
    >
      <RadioIcon className="h-6 w-6" />
    </div>
  );
}

export function RadioPage(): React.JSX.Element {
  const active = useRadioStore((s) => s.active);
  const loading = useRadioStore((s) => s.loading);
  const error = useRadioStore((s) => s.error);
  const taste = useRadioStore((s) => s.taste);
  const exhausted = useRadioStore((s) => s.exhausted);
  const start = useRadioStore((s) => s.start);
  const stop = useRadioStore((s) => s.stop);
  const setTaste = useRadioStore((s) => s.setTaste);
  const refill = useRadioStore((s) => s.refill);
  const dislike = useRadioStore((s) => s.dislike);

  const queue = usePlayerStore((s) => s.queue);
  const queueIndex = usePlayerStore((s) => s.queueIndex);
  const current = queueIndex === null ? undefined : queue[queueIndex];
  const upcoming = queueIndex === null ? [] : queue.slice(queueIndex + 1, queueIndex + 6);

  return (
    <div className="flex h-full flex-col overflow-y-auto px-6 py-4">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">私人 FM</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            按 {DAILY_TASTE_LABEL[taste]} 一直听下去：每听几首自动补一批，同一位歌手一轮最多 3 首。
          </p>
        </div>
        <Segmented
          value={taste}
          options={TASTE_OPTIONS}
          onChange={setTaste}
          label="推荐口味"
        />
        {active ? (
          <Button variant="outline" size="sm" onClick={() => stop()} title="退出 FM（原来的播放列表会接着放）">
            <Square className="mr-1 h-3.5 w-3.5" />
            停止 FM
          </Button>
        ) : (
          <Button size="sm" onClick={() => void start(null)} disabled={loading}>
            <Play className="mr-1 h-3.5 w-3.5" />
            {loading ? "正在挑选…" : "开始收听"}
          </Button>
        )}
      </header>

      {error !== null && (
        <p role="alert" className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {exhausted && (
        <p className="mb-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          把曲库里能推的都排完了。换一批或切到别的口味能重新挑，也可以先把更多目录加进曲库。
        </p>
      )}

      {!active ? (
        <EmptyState
          icon={RadioIcon}
          title="私人 FM 还没开始"
          description="它会按你的口味画像挑歌，并且一直往后接，不用自己排队列。"
          className="mt-6"
        />
      ) : current === undefined ? (
        <EmptyState
          icon={RadioIcon}
          title="队列里还没有歌"
          description="点「换一批」让 FM 重新挑一批出来。"
          className="mt-6"
        />
      ) : (
        <>
          <section
            data-testid="radio-current"
            className="flex items-center gap-4 rounded-lg border border-border bg-card/60 p-4"
          >
            <Cover track={current} className="h-24 w-24" />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">正在播放</p>
              <p className="truncate text-base font-medium" title={current.title}>
                {current.title}
              </p>
              <p className="truncate text-xs text-muted-foreground" title={current.singer}>
                {current.singer}
                {current.album ? ` · ${current.album}` : ""}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                title="不喜欢：加入屏蔽并立刻换一首"
                onClick={() => void dislike(current)}
              >
                <ThumbsDown className="mr-1 h-3.5 w-3.5" />
                不喜欢
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => usePlayerStore.getState().nextTrack()}
                title="下一首"
              >
                <SkipForward className="mr-1 h-3.5 w-3.5" />
                下一首
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={loading || exhausted}
                onClick={() => void refill()}
                title="按当前口味重新挑一批接在队尾"
              >
                <SlidersHorizontal className="mr-1 h-3.5 w-3.5" />
                换一批
              </Button>
            </div>
          </section>

          <section className="mt-5">
            <h2 className="mb-2 text-xs font-medium text-muted-foreground">接下来</h2>
            {upcoming.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                队列已经见底，正在补下一批…
              </p>
            ) : (
              <ul data-testid="radio-upcoming" className="flex flex-col">
                {upcoming.map((track, index) => (
                  <li
                    key={`${track.platform}:${track.id}:${index}`}
                    className="flex items-center gap-3 border-b border-border/50 py-2 last:border-b-0"
                  >
                    <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {index + 1}
                    </span>
                    <Cover track={track} className="h-9 w-9" />
                    <span className="min-w-0 flex-1 truncate text-sm" title={track.title}>
                      {track.title}
                    </span>
                    <span className="min-w-0 max-w-[35%] shrink-0 truncate text-xs text-muted-foreground" title={track.singer}>
                      {track.singer}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
