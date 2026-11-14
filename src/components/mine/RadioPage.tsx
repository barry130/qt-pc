import { Radio as RadioIcon, SkipForward, SlidersHorizontal, ThumbsDown, Play, Square } from "lucide-react";
import { DAILY_TASTE_HINT, DAILY_TASTE_LABEL } from "@/lib/daily-recommend";
import { accountRecommendationContextIsCurrent } from "@/lib/account-recommendation";
import type { DailyTaste } from "@/lib/recommend-types";
import type { Track } from "@/types";
import { useRadioStore } from "@/stores/radio";
import { usePlayerStore } from "@/stores/player";
import { useRecommendationSourceStore } from "@/stores/recommendation-source";
import { RecommendationSourceControl } from "@/components/common/RecommendationSourceControl";
import { Button, EmptyState, Segmented } from "@/components/ui";

/**
 * 私人 FM：页面只是旋钮，当前与接下来五首都读播放器的真实队列。
 * 补歌由 AppShell 的全局心跳驱动，绑定 FM 队列归属而不是页面可见性。
 * 应用口味与平台账号推荐独立：账号模式不做本地排序，也不发送上游反馈。
 */
const TASTE_OPTIONS: { value: DailyTaste; label: string; title: string }[] = (
  ["heart", "familiar", "explore"] as DailyTaste[]
).map((taste) => ({
  value: taste,
  label: DAILY_TASTE_LABEL[taste].replace("模式", ""),
  title: DAILY_TASTE_HINT[taste],
}));

function Cover(props: { track: Track; className: string }): React.JSX.Element {
  return props.track.picUrl ? (
    <img src={props.track.picUrl} alt="" className={`${props.className} shrink-0 rounded-md object-cover`} loading="lazy" />
  ) : (
    <div className={`${props.className} flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground`} aria-hidden="true">
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
  const account = useRadioStore((s) => s.account);
  const receivedCount = useRadioStore((s) => s.receivedCount);
  const start = useRadioStore((s) => s.start);
  const stop = useRadioStore((s) => s.stop);
  const setTaste = useRadioStore((s) => s.setTaste);
  const refill = useRadioStore((s) => s.refill);
  const dislike = useRadioStore((s) => s.dislike);
  const accountMode = useRecommendationSourceStore((s) => s.fm.origin === "account");

  const queue = usePlayerStore((s) => s.queue);
  const queueIndex = usePlayerStore((s) => s.queueIndex);
  const current = queueIndex === null ? undefined : queue[queueIndex];
  const upcoming = queueIndex === null ? [] : queue.slice(queueIndex + 1, queueIndex + 6);
  const currentAccount = accountMode && account && accountRecommendationContextIsCurrent(account) ? account : null;

  return (
    <div className="flex h-full flex-col overflow-y-auto px-6 py-4">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">私人 FM</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {accountMode ? "按平台返回的顺序收听，不使用本地口味排序。"
              : `按 ${DAILY_TASTE_LABEL[taste]} 一直听下去：每听几首自动补一批，同一位歌手一轮最多 3 首。`}
          </p>
        </div>
        {!accountMode ? <Segmented value={taste} options={TASTE_OPTIONS} onChange={setTaste} label="推荐口味" /> : null}
        {active ? (
          <Button variant="outline" size="sm" icon={<Square />} onClick={() => stop()} title="退出 FM（原来的播放列表会接着放）">停止 FM</Button>
        ) : (
          <Button size="sm" icon={<Play />} loading={loading} onClick={() => void start(null)}>
            {loading ? accountMode ? "正在读取平台 FM…" : "正在挑选…" : "开始收听"}
          </Button>
        )}
      </header>

      <RecommendationSourceControl feature="fm" className="mb-4">
        {active && currentAccount ? (
          <span aria-label="平台 FM 会话" className="hidden shrink-0 whitespace-nowrap text-xs text-muted-foreground @[32rem]:inline"
            title={`${currentAccount.sourceName} · ${currentAccount.nickname}（${currentAccount.accountId}）· 平台原始顺序`}>
            已接收 {receivedCount} 首
          </span>
        ) : null}
      </RecommendationSourceControl>
      {error !== null ? <p role="alert" className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p> : null}
      {exhausted ? (
        <p role="status" className="mb-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {accountMode ? "平台本轮 FM 已没有新歌曲。可停止后重新开始；不会用应用曲库补齐。"
            : "把曲库里能推的都排完了。换一批或切到别的口味能重新挑，也可以先把更多目录加进曲库。"}
        </p>
      ) : null}

      {!active ? (
        <EmptyState icon={RadioIcon} title="私人 FM 还没开始" className="mt-6"
          description={accountMode ? "登录所选平台并明确授权数据面后开始收听；歌曲由该账号的 FM 返回。" : "它会按你的口味画像挑歌，并且一直往后接，不用自己排队列。"} />
      ) : current === undefined ? (
        <EmptyState icon={RadioIcon} title="队列里还没有歌" description="点「换一批」让 FM 重新接收一批歌曲。" className="mt-6" />
      ) : (
        <>
          <section data-testid="radio-current" className="flex items-center gap-4 rounded-lg border border-border bg-card/60 p-4">
            <Cover track={current} className="h-24 w-24" />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">正在播放</p>
              <p className="truncate text-base font-medium" title={current.title}>{current.title}</p>
              <p className="truncate text-xs text-muted-foreground" title={current.singer}>{current.singer}{current.album ? ` · ${current.album}` : ""}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!accountMode ? (
                <Button variant="ghost" size="sm" icon={<ThumbsDown />} title="不喜欢：加入屏蔽并立刻换一首" onClick={() => void dislike(current)}>不喜欢</Button>
              ) : null}
              <Button variant="outline" size="sm" icon={<SkipForward />} onClick={() => void usePlayerStore.getState().nextTrack().catch(() => undefined)} title="下一首">下一首</Button>
              <Button variant="outline" size="sm" icon={<SlidersHorizontal />} loading={loading} disabled={exhausted} onClick={() => void refill()}
                title={accountMode ? "从平台接收下一批并接在队尾" : "按当前口味重新挑一批接在队尾"}>换一批</Button>
            </div>
          </section>

          <section className="mt-5">
            <h2 className="mb-2 text-xs font-medium text-muted-foreground">接下来</h2>
            {upcoming.length === 0 ? (
              <p className="text-xs text-muted-foreground">{exhausted ? "平台本轮没有更多歌曲。" : "队列已经见底，正在补下一批…"}</p>
            ) : (
              <ul data-testid="radio-upcoming" className="flex flex-col">
                {upcoming.map((track, index) => (
                  <li key={`${track.platform}:${track.id}:${index}`} className="flex items-center gap-3 border-b border-border/50 py-2 last:border-b-0">
                    <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{index + 1}</span>
                    <Cover track={track} className="h-9 w-9" />
                    <span className="min-w-0 flex-1 truncate text-sm" title={track.title}>{track.title}</span>
                    <span className="min-w-0 max-w-[35%] shrink-0 truncate text-xs text-muted-foreground" title={track.singer}>{track.singer}</span>
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
