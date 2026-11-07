import type { LyricWord } from "@/lib/lrc";

/** 各种歌词布局共用逐字染色，时间均相对于当前行。 */
export function KaraokeWord(props: { word: LyricWord; elapsedMs: number }): React.JSX.Element {
  const { word, elapsedMs } = props;
  const passed = elapsedMs - word.startMs;
  const raw = word.durationMs > 0 ? passed / word.durationMs : passed >= 0 ? 1 : 0;
  const pct = Math.round(Math.max(0, Math.min(1, raw)) * 100);
  return (
    <span style={{
      backgroundImage: `linear-gradient(90deg, var(--lyric-highlight) ${pct}%, var(--lyric-inactive) ${pct}%)`,
      WebkitBackgroundClip: "text",
      backgroundClip: "text",
      color: "transparent",
    }}>{word.text}</span>
  );
}
