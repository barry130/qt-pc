import { useEffect, useState } from "react";
import { Heart } from "lucide-react";
import type { Track } from "@/types";
import { CollectMenu } from "./CollectMenu";
import { Popover } from "@/components/common/Popover";

/**
 * 列表行尾的「收藏」（取代原来的「＋歌单」）。
 *
 * 语义与播放控制栏的红心**完全一致**：点开是同一份本地歌单清单，点一行即
 * 收藏 / 取消收藏 —— 面板本身就用 `CollectMenu`，所以「一致」是结构上保证的。
 *
 * 红心高亮由列表层批量查出来（`useFavoriteFlags`，一次 IPC 查整屏）后以
 * **标量**传进来：这样 `TrackRow` 的 `memo` 才不会被破坏。本组件再拿一份
 * 本地副本，让「刚点完」立刻有反馈，不必等整列表重查回来。
 *
 * 列表行是 `div[role=button]`，所以触发按钮与面板内的每一次点击都必须
 * `stopPropagation`，否则会顺手把这首播了（面板里已统一处理，触发按钮在这里）。
 */
export function CollectButton(props: {
  track: Track;
  /** 这一行是否已收藏（列表层批量查得） */
  favorited: boolean;
}): React.JSX.Element {
  const { track, favorited } = props;
  const [open, setOpen] = useState(false);
  const [liked, setLiked] = useState(favorited);

  // 批量判定回来 / 别处收藏后，以列表层的结果为准
  useEffect(() => setLiked(favorited), [favorited]);

  // 换了一首歌就把面板收起，别对着上一首操作
  useEffect(() => setOpen(false), [track]);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="relative shrink-0"
      trigger={(t) => (
        <button
          type="button"
          title={liked ? "已收藏，点击管理收藏" : "收藏"}
          aria-label={liked ? "已收藏，点击管理收藏" : "收藏"}
          aria-expanded={t.open}
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            t.toggle();
          }}
          className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        >
          <Heart className={liked ? "h-3.5 w-3.5 fill-current text-primary" : "h-3.5 w-3.5"} />
        </button>
      )}
    >
      {() => (
        <CollectMenu
          track={track}
          onLikedChange={setLiked}
          onClose={() => setOpen(false)}
          className="absolute right-0 top-full z-20 mt-1 w-56 rounded-md border border-border bg-popover p-1 shadow-md"
        />
      )}
    </Popover>
  );
}
