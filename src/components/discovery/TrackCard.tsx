import { Play } from "lucide-react";
import type { Track } from "@/types";
import { SourceTag } from "@/components/common/SourceTag";
import { EqBars } from "@/components/common/EqBars";
import { qtresCoverUrl } from "@/lib/lrc";
import { usePlayerStore } from "@/stores/player";

/**
 * 横向歌曲卡片（首页「新歌速递」）。
 * 点击整卡只播这一首（播放列表只留它），hover 显示播放按钮。
 * 封面经 qtres:// 走 Rust 侧 Range 透传（DESIGN §6.13，带 Referer 防盗链）。
 *
 * 当前在播的那张卡：悬停层常显 + 播放按钮换成跳动条、标题取主色、封面加细描边 ——
 * 卡片墙里滚过一眼就能认出「现在放的是这首」，不用回头看底栏。
 */
export function TrackCard(props: {
  track: Track;
  onPlay: () => void;
}): React.JSX.Element {
  const { track } = props;
  const cover = qtresCoverUrl(track.picUrl);
  const isCurrent = usePlayerStore((s) => {
    const cur = s.state?.track;
    return cur != null && cur.id === track.id && cur.platform === track.platform;
  });
  const playing = usePlayerStore((s) => s.state?.status === "playing");

  return (
    <button
      type="button"
      onClick={props.onPlay}
      title={`${track.title} - ${track.singer}`}
      className="group w-32 shrink-0 snap-start text-left"
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-xl shadow-surface transition-shadow duration-base group-hover:shadow-raised">
        {cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-slow group-hover:scale-105"
          />
        ) : null}
        {/* 在播：封面细描边（叠在卡片阴影上，暗色封面也看得出选中） */}
        {isCurrent ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-inset ring-primary/70"
          />
        ) : null}
        {/* 悬停：渐变遮罩 + 播放按钮；在播时遮罩常显、按钮换成跳动条 */}
        <div
          className={`absolute inset-0 flex items-end justify-end bg-gradient-to-t from-black/45 via-transparent to-transparent p-3 transition-opacity duration-base group-hover:opacity-100 ${
            isCurrent ? "opacity-100" : "opacity-0"
          }`}
        >
          {isCurrent ? (
            <span
              className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-raised"
              aria-label={playing ? "正在播放" : "已暂停"}
            >
              <EqBars playing={playing} />
            </span>
          ) : (
            <span className="flex h-9 w-9 translate-y-1 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform duration-base group-hover:translate-y-0">
              <Play className="h-4 w-4 fill-current" />
            </span>
          )}
        </div>
      </div>
      <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs font-medium">
        <span className={`truncate ${isCurrent ? "text-primary" : ""}`}>
          {track.title}
        </span>
        <SourceTag platform={track.platform} size="xs" />
      </div>
      <div className="mt-0.5 truncate text-2xs text-muted-foreground">
        {track.singer}
      </div>
    </button>
  );
}
