import { useMemo, type CSSProperties } from "react";
import type { LyricLine } from "@/lib/lrc";
import { rhythmGlyphs } from "@/lib/lyric-rhythm";
import { LYRIC_FONT_SIZE_DEFAULT } from "@/hooks/useLyricFontSize";

export function RhythmLyrics(props: {
  lines: LyricLine[];
  activeIndex: number;
  positionMs: number;
  durationMs: number;
  playing: boolean;
  fontSize: number;
  onSeekMs: (ms: number) => void;
}): React.JSX.Element {
  const { lines, activeIndex, positionMs, durationMs, playing, fontSize, onSeekMs } = props;
  // 开唱前预览首行；空白时间行显示间奏，避免沿用上一句。
  const index = Math.max(0, activeIndex);
  const line = lines[index];
  const nextTimeMs = lines[index + 1]?.timeMs;
  const nextLine = useMemo(() => lines.slice(index + 1).find((item) => item.text.trim()), [lines, index]);
  const glyphs = useMemo(() => line ? rhythmGlyphs(line, nextTimeMs, durationMs) : [], [line, nextTimeMs, durationMs]);
  if (!line) return <div className="flex h-full items-center justify-center text-muted-foreground">暂无歌词</div>;

  const elapsedMs = activeIndex < 0 ? -1 : positionMs - line.timeMs;
  const instrumental = !line.text.trim();
  const density = glyphs.length > 80 ? 0.55 : glyphs.length > 40 ? 0.72 : 1;
  const scale = fontSize / LYRIC_FONT_SIZE_DEFAULT * density;

  return (
    <section className="qt-rhythm-stage" aria-label="歌词律动" data-playing={playing}>
      <div className="qt-rhythm-viewport" key={`${index}:${line.timeMs}:${line.text}`}>
        <div
          className="qt-rhythm-line"
          role="group"
          aria-label={instrumental ? "间奏" : line.text}
          style={{ "--rhythm-font-scale": scale } as CSSProperties}
        >
          {instrumental ? (
            <span className="qt-rhythm-interlude" aria-hidden>···</span>
          ) : glyphs.map((glyph, glyphIndex) => {
            const passed = elapsedMs - glyph.startMs;
            const progress = glyph.durationMs > 0 ? Math.max(0, Math.min(1, passed / glyph.durationMs)) : passed >= 0 ? 1 : 0;
            const pulse = Math.sin(progress * Math.PI);
            // 整句有轻微错峰波动，当前字再抬起；全部由播放位置计算，暂停/seek 不会漂移。
            const sway = elapsedMs >= 0 ? Math.sin(elapsedMs / 750 - glyphIndex * 0.72) * 0.07 : 0;
            return (
              <span
                key={glyphIndex}
                aria-hidden
                className="qt-rhythm-glyph"
                data-sung={passed >= 0}
                style={{
                  "--rhythm-lift": `${(-pulse * 0.16 + sway).toFixed(3)}em`,
                  "--rhythm-tilt": `${(pulse * (glyphIndex % 2 ? 6 : -6) + sway * 60).toFixed(2)}deg`,
                  "--rhythm-zoom": (1 + pulse * 0.08).toFixed(3),
                } as CSSProperties}
              >{glyph.text}</span>
            );
          })}
        </div>
        {line.romanization ? <p className="qt-rhythm-romanization">{line.romanization}</p> : null}
        {line.translation ? <p className="qt-rhythm-translation">{line.translation}</p> : null}
      </div>
      <div className="qt-rhythm-next">
        {activeIndex < 0 ? (
          <span>等待歌词开始</span>
        ) : nextLine ? (
          <button type="button" title="跳到下一句" aria-label={`跳到下一句：${nextLine.text}`} onClick={() => onSeekMs(nextLine.timeMs)}>
            {nextLine.text}
          </button>
        ) : <span>尾声</span>}
      </div>
    </section>
  );
}
