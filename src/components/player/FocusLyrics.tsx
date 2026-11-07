import { useMemo, type CSSProperties } from "react";
import type { LyricLine } from "@/lib/lrc";
import { KaraokeWord } from "@/components/player/KaraokeWord";

/** 画廊与纯净模式共用三句呈现；只有当前句接收逐字进度。 */
export function FocusLyrics(props: {
  lines: LyricLine[];
  activeIndex: number;
  positionMs: number;
  fontSize: number;
  variant: "gallery" | "focus";
  onSeekMs: (ms: number) => void;
}): React.JSX.Element | null {
  const { lines, activeIndex, positionMs, fontSize, variant, onSeekMs } = props;
  const index = Math.max(0, activeIndex);
  const line = lines[index];
  const previous = useMemo(() => {
    for (let i = index - 1; i >= 0; i -= 1) if (lines[i].text.trim()) return lines[i];
    return undefined;
  }, [lines, index]);
  const next = useMemo(() => lines.slice(index + 1).find((item) => item.text.trim()), [lines, index]);
  if (!line) return null;
  return (
    <section className="qt-focus-lyrics" data-variant={variant} aria-label={variant === "gallery" ? "专辑画廊歌词" : "纯净歌词"}
      style={{ "--focus-font-size": `${fontSize / 16}rem` } as CSSProperties}>
      <div className="qt-focus-neighbor">
        {previous ? <button type="button" aria-label={`跳到上一句：${previous.text}`} onClick={() => onSeekMs(previous.timeMs)}>{previous.text}</button> : null}
      </div>
      <div className="qt-focus-current" key={`${index}:${line.timeMs}:${line.text}`}>
        <div role="group" aria-label={line.text.trim() || "间奏"} className="qt-focus-text" data-waiting={activeIndex < 0}>
          <span aria-hidden>{!line.text.trim() ? "···" : line.words?.length ? line.words.map((word, i) => (
            <KaraokeWord key={i} word={word} elapsedMs={activeIndex < 0 ? -1 : positionMs - line.timeMs} />
          )) : line.text}</span>
        </div>
        {line.romanization ? <p className="qt-focus-romanization">{line.romanization}</p> : null}
        {line.translation ? <p className="qt-focus-translation">{line.translation}</p> : null}
      </div>
      <div className="qt-focus-neighbor">
        {next ? <button type="button" aria-label={`跳到下一句：${next.text}`} onClick={() => onSeekMs(next.timeMs)}>{next.text}</button>
          : <span className="text-xs">尾声</span>}
      </div>
    </section>
  );
}
