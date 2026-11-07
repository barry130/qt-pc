import { memo } from "react";
import type { PlayingBackgroundPreference } from "@/lib/playing-background";

/** 背景独立成层，不订阅播放进度；图片与遮罩不会跟着歌词重绘。 */
export const PlayingBackground = memo(function PlayingBackground(props: {
  kind: string;
  background: PlayingBackgroundPreference;
}): React.JSX.Element | null {
  if (props.kind !== "cover" && props.kind !== "image") return null;
  return (
    <div className="qt-playing-backdrop" aria-hidden>
      {props.kind === "image" ? (
        <img className="qt-playing-backdrop-image" src={props.background.image} alt="" draggable={false} />
      ) : <div className="qt-playing-backdrop-cover" />}
      <div className="qt-playing-backdrop-shade" />
    </div>
  );
});
