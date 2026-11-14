import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { LyricLine } from "@/lib/lrc";
import { KaraokeWord } from "@/components/player/KaraokeWord";

/** 保留纯净模式的三句呈现；滚轮和触摸只切换视窗中的歌词。 */
export function FocusLyrics(props: {
  lines: LyricLine[];
  activeIndex: number;
  positionMs: number;
  fontSize: number;
  variant: "gallery" | "focus";
  onSeekMs: (ms: number) => void;
}): React.JSX.Element | null {
  const { lines, activeIndex, positionMs, fontSize, variant, onSeekMs } = props;
  const viewportRef = useRef<HTMLElement | null>(null);
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchY = useRef<number | null>(null);
  const [browse, setBrowse] = useState<{ lines: LyricLine[]; index: number } | null>(null);
  const playingIndex = Math.max(0, Math.min(activeIndex, lines.length - 1));
  const browsing = browse !== null && browse.lines === lines;
  const index = browsing ? browse.index : playingIndex;
  const line = lines[index];
  const previous = useMemo(() => {
    for (let i = index - 1; i >= 0; i -= 1) if (lines[i].text.trim()) return lines[i];
    return undefined;
  }, [lines, index]);
  const next = useMemo(() => lines.slice(index + 1).find((item) => item.text.trim()), [lines, index]);

  const resumeFollow = useCallback((): void => {
    if (resumeTimer.current !== null) clearTimeout(resumeTimer.current);
    resumeTimer.current = null;
    setBrowse(null);
  }, []);
  const browseLine = useCallback((direction: number): void => {
    if (!lines.length) return;
    setBrowse((current) => ({
      lines,
      index: Math.max(0, Math.min(lines.length - 1,
        (current?.lines === lines ? current.index : playingIndex) + direction)),
    }));
    if (resumeTimer.current !== null) clearTimeout(resumeTimer.current);
    resumeTimer.current = setTimeout(resumeFollow, 4000);
  }, [lines, playingIndex, resumeFollow]);

  useEffect(() => () => {
    if (resumeTimer.current !== null) clearTimeout(resumeTimer.current);
  }, []);

  // 使用非 passive 的原生监听拦住外层页面滚动，避免出现全局回顶按钮。
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let distance = 0;
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
      if (Math.sign(delta) !== Math.sign(distance)) distance = 0;
      distance += delta;
      if (Math.abs(distance) < 40) return;
      browseLine(Math.sign(distance));
      distance = 0;
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [browseLine, lines.length]);

  const seekLine = (timeMs: number): void => {
    resumeFollow();
    onSeekMs(timeMs);
  };
  if (!line) return null;
  const waiting = activeIndex < 0 || index !== activeIndex;
  const text = <span aria-hidden>{!line.text.trim() ? "···" : line.words?.length ? line.words.map((word, i) => (
    <KaraokeWord key={i} word={word} elapsedMs={waiting ? -1 : positionMs - line.timeMs} />
  )) : line.text}</span>;
  return (
    <section ref={viewportRef} className="qt-focus-lyrics" data-variant={variant}
      aria-label={variant === "gallery" ? "专辑画廊歌词" : "纯净歌词"} tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          browseLine(event.key === "ArrowDown" ? 1 : -1);
        } else if (event.key === "Escape") resumeFollow();
      }}
      onTouchStart={(event) => { touchY.current = event.touches[0]?.clientY ?? null; }}
      onTouchMove={(event) => {
        event.stopPropagation();
        const y = event.touches[0]?.clientY;
        if (touchY.current === null || y === undefined) return;
        const delta = touchY.current - y;
        if (Math.abs(delta) < 40) return;
        browseLine(Math.sign(delta));
        touchY.current = y;
      }}
      onTouchEnd={() => { touchY.current = null; }}
      onTouchCancel={() => { touchY.current = null; }}
      style={{ "--focus-font-size": `${fontSize / 16}rem` } as CSSProperties}>
      <div className="qt-focus-neighbor">
        {previous ? <button type="button" aria-label={`跳到上一句：${previous.text}`} onClick={() => seekLine(previous.timeMs)}>{previous.text}</button> : null}
      </div>
      <div className="qt-focus-current" key={`${index}:${line.timeMs}:${line.text}`}>
        <div role="group" aria-label={line.text.trim() || "间奏"} className="qt-focus-text" data-waiting={waiting}>
          {browsing ? <button type="button" className="qt-focus-seek" aria-label={`跳到这一句：${line.text.trim() || "间奏"}`} onClick={() => seekLine(line.timeMs)}>{text}</button> : text}
        </div>
        {line.romanization ? <p className="qt-focus-romanization">{line.romanization}</p> : null}
        {line.translation ? <p className="qt-focus-translation">{line.translation}</p> : null}
      </div>
      <div className="qt-focus-neighbor">
        {next ? <button type="button" aria-label={`跳到下一句：${next.text}`} onClick={() => seekLine(next.timeMs)}>{next.text}</button>
          : <span className="text-xs">尾声</span>}
      </div>
      {browsing ? <button type="button" className="qt-focus-resume" onClick={resumeFollow}>回到当前行</button> : null}
    </section>
  );
}
