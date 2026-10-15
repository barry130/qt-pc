import { useEffect, useState } from "react";
import { Heart } from "lucide-react";
import type { Track } from "@/types";
import * as ipc from "@/services/ipc";
import { useFavoritesStore } from "@/stores/favorites";
import { CollectMenu } from "@/components/mine/CollectMenu";
import { Popover } from "@/components/common/Popover";

/**
 * 收藏选择器（播放条上的红心）。
 *
 * 收藏不能脱离歌单：点开是**本地歌单清单**（含「我喜欢的歌曲」），
 * 每点一行即在「收藏 / 取消收藏」之间切换 —— 与 qt-uniappx 的
 * `pickerPlaylists()` + `applyPickerSelection()` 同口径。
 * 一首歌可以挂在多个歌单（v6 起多对多），勾上新的不会放开旧的。
 *
 * 面板本体是 `CollectMenu`，与列表行的红心**共用同一个组件**：
 * 查重口径、新建歌单、勾选状态只存在一份实现，两边不可能漂移。
 * 这里只负责播放条特有的圆形按钮外观、定位，以及「曲目切换就收起」。
 */
export function CollectButton(props: { track: Track | null }): React.JSX.Element {
  const { track } = props;
  const [open, setOpen] = useState(false);
  const version = useFavoritesStore((s) => s.version);

  // 当前曲目是否已被收藏（面板没开时也要能点亮红心）
  const [liked, setLiked] = useState(false);
  useEffect(() => {
    if (!track) {
      setLiked(false);
      return;
    }
    let cancelled = false;
    void ipc
      .isFavorite(track)
      .then((v) => {
        if (!cancelled) setLiked(v);
      })
      .catch(() => {
        if (!cancelled) setLiked(false);
      });
    return () => {
      cancelled = true;
    };
    // version 参与依赖：在列表行里收藏了同一首歌，播放条的红心也要跟着亮
  }, [track, version]);

  // 曲目切了就把面板收起，避免对着上一首歌操作
  useEffect(() => setOpen(false), [track]);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={(t) => (
        <button
          type="button"
          aria-label="收藏到歌单"
          title="收藏到歌单"
          disabled={!track}
          onClick={t.toggle}
          className={[
            "flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-secondary/50",
            liked ? "text-primary" : "text-foreground/80",
            !track && "cursor-not-allowed opacity-40",
          ].join(" ")}
        >
          <Heart className={liked ? "h-4 w-4 fill-current" : "h-4 w-4"} />
        </button>
      )}
    >
      {() =>
        track ? (
          <CollectMenu
            track={track}
            onLikedChange={setLiked}
            onClose={() => setOpen(false)}
            className="absolute bottom-full left-1/2 z-30 mb-2 w-56 -translate-x-1/2 rounded-xl border border-border bg-popover/95 p-1 text-popover-foreground shadow-2xl backdrop-blur-xl"
          />
        ) : null
      }
    </Popover>
  );
}
