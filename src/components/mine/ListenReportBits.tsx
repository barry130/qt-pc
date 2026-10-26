import { Music4 } from "lucide-react";
import { ArtistAvatar } from "@/components/common/ArtistAvatar";
import { SourceLogo } from "@/components/common/SourceLogo";
import { qtresCoverUrl } from "@/lib/lrc";
import { cn } from "@/lib/utils";
import type { ListenReportEntry, ListenReportKind } from "@/types";

/**
 * 听歌报告条目的图片（收听详情页与「近 7 天」趋势区块共用的唯一实现）。
 *
 * 三档分组各自的图片口径（对齐移动端 pages/stats/index.uvue）：
 * - 歌曲行 → 封面（缺失回退音符图标）；
 * - 歌手行 → 歌手真实头像（失败回退首字）；
 * - 音源行 → 官方 logo。
 *
 * `size` 只有 32 / 40 两档：趋势区块的行更紧凑用 32，详情页列表用 40。
 * 两个页面曾经各写一份、尺寸写死，改一处忘另一处 —— 现在只有这一份。
 */
export function EntryPicture(props: {
  entry: ListenReportEntry;
  kind: ListenReportKind;
  name: string;
  size?: 32 | 40;
}): React.JSX.Element {
  const { entry, kind, name, size = 40 } = props;
  if (kind === "sources") return <SourceLogo platform={entry.id} size={size} />;
  if (kind === "singers") return <ArtistAvatar platform={entry.platform} name={name} size={size} />;

  const cover = entry.track ? qtresCoverUrl(entry.track.picUrl, 96) : "";
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary/10 text-primary",
        size === 40 ? "h-10 w-10 text-sm" : "h-8 w-8",
      )}
    >
      {cover ? (
        <img src={cover} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <Music4 className={size === 40 ? "h-5 w-5" : "h-4 w-4"} />
      )}
    </span>
  );
}
