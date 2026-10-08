import { Play } from "lucide-react";
import type { Track } from "@/types";
import { qtresCoverUrl } from "@/lib/lrc";

/**
 * 横向歌曲卡片（首页「新歌速递」）。
 * 点击整卡只播这一首（播放列表只留它），hover 显示播放按钮。
 * 封面经 qtres:// 走 Rust 侧 Range 透传（DESIGN §6.13，带 Referer 防盗链）。
 */
export function TrackCard(props: {
  track: Track;
  onPlay: () => void;
}): React.JSX.Element {
  const { track } = props;
  const cover = qtresCoverUrl(track.picUrl);

  return (
    <button
      type="button"
      onClick={props.onPlay}
      title={`${track.title} - ${track.singer}`}
      className="group w-32 shrink-0 snap-start text-left"
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-xl shadow-md transition-shadow duration-200 group-hover:shadow-xl">
        {cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : null}
        {/* 悬停：渐变遮罩 + 播放按钮 */}
        <div className="absolute inset-0 flex items-end justify-end bg-gradient-to-t from-black/45 via-transparent to-transparent p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="flex h-9 w-9 translate-y-1 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform duration-200 group-hover:translate-y-0">
            <Play className="h-4 w-4 fill-current" />
          </span>
        </div>
      </div>
      <div className="mt-2 truncate text-xs font-medium">{track.title}</div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
        {track.singer}
      </div>
    </button>
  );
}
