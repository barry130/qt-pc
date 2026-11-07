import type { LyricLine } from "@/lib/lrc";

export interface RhythmGlyph {
  text: string;
  startMs: number;
  durationMs: number;
}

// 按字素拆分，emoji / 组合音标不会在舞台上散成几个不可读的字符。
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), (part) => part.segment);

/** 有逐字时间轴就沿用；普通 LRC 只在行内均分动效，不推断音频节拍。 */
export function rhythmGlyphs(line: LyricLine, nextTimeMs: number | undefined, durationMs: number): RhythmGlyph[] {
  if (line.words?.length) {
    return line.words.flatMap((word) => {
      const chars = graphemes(word.text);
      const step = Math.max(0, word.durationMs) / Math.max(1, chars.length);
      return chars.map((text, index) => ({ text, startMs: word.startMs + index * step, durationMs: step }));
    });
  }
  const chars = graphemes(line.text);
  const endMs = nextTimeMs ?? (durationMs > line.timeMs ? durationMs : line.timeMs + 4000);
  const span = Math.max(1, Math.min(8000, endMs - line.timeMs));
  const step = span / Math.max(1, chars.length);
  return chars.map((text, index) => ({ text, startMs: index * step, durationMs: step }));
}
