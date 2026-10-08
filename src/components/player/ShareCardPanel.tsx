import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, Loader2, Share2 } from "lucide-react";
import { getPlaybackLyric } from "@/lib/localOnline";
import { parseLrc, qtresCoverUrl } from "@/lib/lrc";
import * as ipc from "@/services/ipc";
import type { Track } from "@/types";
import { cn } from "@/lib/utils";

export const SHARE_CARD_BRAND = "轻听音乐";
export const SHARE_CARD_BRAND_SUB = "QuietMusic";
export const SHARE_CARD_NO_LYRIC = "暂无歌词";
export const SHARE_CARD_LYRIC_LOADING = "歌词加载中…";

/**
 * 分享卡片面板（用户 m10417，对齐移动端 pages/share-card）：
 * 点分享按钮弹出卡片预览，可切「歌曲卡片 / 歌词卡片」，底下两个按钮把卡片**出成图**
 * ——复制到剪贴板（直接粘进聊天窗口）或另存为 PNG。
 *
 * 为什么是 canvas 画而不是截图 DOM：项目没有引入 html2canvas 之类的依赖，
 * canvas 绘制更可控（尺寸、圆角、主题色都能算准），也顺便避开了
 * 「预览是一套样式、导出图是另一套」的偏差。
 */

/** 卡片逻辑尺寸；导出按 2 倍像素出图，够清晰又不至于太大 */
const CARD_W = 300;
const COVER = 300;
const SCALE = 2;
const PAD = 18;
const RADIUS = 16;

/** 歌词卡片最多带几行词（与移动端一致） */
const LYRIC_LINES = 6;

const FONT_SANS =
  '"PingFang SC","Microsoft YaHei","Noto Sans SC","Helvetica Neue",Arial,sans-serif';

type Mode = 0 | 1;

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v.length > 0 ? v : fallback;
}

/**
 * 画布不认 CSS 变量，也不接受 oklch 之外的随意字符串——这里统一取实值。
 * 主题切换（skins.ts 覆写 --primary 等）后重开弹层即可拿到新值。
 */
function readTheme(): { bg: string; text: string; subtle: string; accent: string } {
  return {
    bg: cssVar("--card", "#ffffff"),
    text: cssVar("--card-foreground", "#1f2937"),
    subtle: cssVar("--muted-foreground", "#64748b"),
    accent: cssVar("--primary", "#4f46e5"),
  };
}

/** 按最大宽度断行（中文逐字、英文按空格/连字符，够用即可） */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const out: string[] = [];
  let line = "";
  const push = (s: string): void => {
    if (out.length < maxLines) out.push(s);
  };
  const tokens = text.match(/[A-Za-z0-9''\-]+|\s+|[^\s]/g) ?? [];
  for (const tk of tokens) {
    const next = line + tk;
    if (ctx.measureText(next).width > maxWidth && line.length > 0) {
      push(line.trimEnd());
      line = /^\s+$/.test(tk) ? "" : tk;
      if (out.length >= maxLines) return out;
    } else {
      line = next;
    }
  }
  if (line.trim().length > 0) push(line.trimEnd());
  return out;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function ShareCardPanel(props: { track: Track }): React.JSX.Element {
  const [mode, setMode] = useState<Mode>(0);
  const [lines, setLines] = useState<string[]>([]);
  const [lyricLoading, setLyricLoading] = useState(false);
  const [coverReady, setCoverReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [done, setDone] = useState<"copy" | "save" | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const coverRef = useRef<HTMLImageElement | null>(null);

  const coverUrl = useMemo(
    () => qtresCoverUrl(props.track.picUrl ?? "", 600),
    [props.track.picUrl],
  );

  // 歌词只在切到「歌词卡片」时才取：歌曲卡片模式没必要为此等一次网络
  useEffect(() => {
    if (mode !== 1) return;
    let alive = true;
    setLyricLoading(true);
    void getPlaybackLyric(props.track)
      .then((lyric) => {
        if (!alive) return;
        const parsed = parseLrc(lyric.lrc ?? "")
          .map((l) => l.text.trim())
          .filter((t) => t.length > 0);
        setLines(parsed.slice(0, LYRIC_LINES));
      })
      .catch(() => {
        if (alive) setLines([]);
      })
      .finally(() => {
        if (alive) setLyricLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [mode, props.track]);

  // 封面：crossOrigin 是必须的（qtres 响应带 ACAO:*），否则画布被污染、导出图失败
  useEffect(() => {
    setCoverReady(false);
    if (coverUrl === null) {
      coverRef.current = null;
      setCoverReady(true);
      return;
    }
    let alive = true;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!alive) return;
      coverRef.current = img;
      setCoverReady(true);
    };
    img.onerror = () => {
      // 加载失败也放行：画成占位灰块，不至于卡住整个分享
      if (!alive) return;
      coverRef.current = null;
      setCoverReady(true);
    };
    img.src = coverUrl;
    return () => {
      alive = false;
    };
  }, [coverUrl]);

  const draw = (): HTMLCanvasElement | null => {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return null;

    const t = readTheme();
    const inner = CARD_W - PAD * 2;
    // 先算高度：歌词行数不固定，卡片不能写死
    const probe = document.createElement("canvas").getContext("2d");
    let titleLines: string[] = [props.track.title];
    let lyricOut: string[] = [];
    if (probe !== null) {
      probe.font = `bold 18px ${FONT_SANS}`;
      titleLines = wrapText(probe, props.track.title, inner, 2);
      if (mode === 1) {
        probe.font = `14px ${FONT_SANS}`;
        lyricOut = lines.slice(0, LYRIC_LINES);
      }
    }
    const lyricH = mode === 1 ? 14 + lyricOut.length * 24 + (lyricOut.length > 0 ? 0 : 24) : 0;
    const bodyH = 8 + titleLines.length * 26 + 6 + 18 + lyricH;
    const height = COVER + bodyH + 46;

    canvas.width = CARD_W * SCALE;
    canvas.height = height * SCALE;
    ctx.scale(SCALE, SCALE);
    ctx.clearRect(0, 0, CARD_W, height);

    // 卡片底 + 圆角裁剪
    ctx.fillStyle = t.bg;
    roundRect(ctx, 0, 0, CARD_W, height, RADIUS);
    ctx.fill();
    ctx.save();
    ctx.clip();

    // 封面（aspectFill 等价：按长边铺满后居中裁）
    if (coverRef.current !== null) {
      const img = coverRef.current;
      const scale = Math.max(COVER / img.width, COVER / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (COVER - dw) / 2, (COVER - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = t.subtle;
      ctx.globalAlpha = 0.18;
      ctx.fillRect(0, 0, COVER, COVER);
      ctx.globalAlpha = 1;
    }

    let y = COVER + PAD + 16;
    ctx.fillStyle = t.text;
    ctx.font = `bold 18px ${FONT_SANS}`;
    ctx.textBaseline = "alphabetic";
    for (const ln of titleLines) {
      ctx.fillText(ln, PAD, y);
      y += 26;
    }
    y += 6;
    ctx.fillStyle = t.subtle;
    ctx.font = `13px ${FONT_SANS}`;
    ctx.fillText(props.track.singer, PAD, y);
    y += 18;

    if (mode === 1) {
      y += 14;
      ctx.font = `14px ${FONT_SANS}`;
      if (lyricOut.length === 0) {
        ctx.fillStyle = t.subtle;
        ctx.fillText(lyricLoading ? SHARE_CARD_LYRIC_LOADING : SHARE_CARD_NO_LYRIC, PAD, y);
      } else {
        lyricOut.forEach((ln, i) => {
          ctx.fillStyle = i === 0 ? t.accent : t.subtle;
          ctx.fillText(ln, PAD, y);
          y += 24;
        });
      }
    }

    // 品牌行
    ctx.restore();
    ctx.fillStyle = t.accent;
    ctx.font = `bold 13px ${FONT_SANS}`;
    ctx.fillText(SHARE_CARD_BRAND, PAD, height - 18);
    ctx.fillStyle = t.subtle;
    ctx.font = `10px ${FONT_SANS}`;
    ctx.textAlign = "right";
    ctx.fillText(SHARE_CARD_BRAND_SUB, CARD_W - PAD, height - 18);
    ctx.textAlign = "left";
    return canvas;
  };

  // 预览就是导出源：主题/模式/歌词/封面任一变化都重画一次，所见即所得
  useEffect(() => {
    if (!coverReady) return;
    draw();
  });

  /** 出图 → base64（不含 data: 前缀） */
  const render = (): string | null => {
    const canvas = draw();
    if (canvas === null) return null;
    return canvas.toDataURL("image/png").split(",")[1] ?? null;
  };

  const flash = (kind: "copy" | "save", ok: boolean, msg: string): void => {
    setBusy(false);
    setHint(ok ? null : msg);
    if (!ok) return;
    setDone(kind);
    setTimeout(() => setDone(null), 1600);
  };

  const copyImage = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setHint(null);
    const b64 = render();
    if (b64 === null) {
      flash("copy", false, "生成图片失败");
      return;
    }
    try {
      const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob());
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      flash("copy", true, "");
    } catch {
      flash("copy", false, "复制失败，可改用保存为图片");
    }
  };

  const saveImage = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setHint(null);
    const b64 = render();
    if (b64 === null) {
      flash("save", false, "生成图片失败");
      return;
    }
    try {
      const name = `${props.track.title}-${props.track.singer}`.replace(/[\\/:*?"<>|]/g, "");
      const path = await ipc.pickSavePath(`${name}.png`, "保存分享卡片");
      if (path === null) {
        setBusy(false);
        return;
      }
      await ipc.saveBinaryFile(path, b64);
      flash("save", true, "");
    } catch (e: unknown) {
      flash("save", false, `保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="w-[318px] max-w-[80vw]">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Share2 className="h-3 w-3" />
        <span className="min-w-0 flex-1 truncate">分享「{props.track.title}」</span>
      </div>

      <div className="mb-2 flex gap-1 rounded-md bg-secondary/60 p-0.5">
        {(
          [
            [0, "歌曲卡片"],
            [1, "歌词卡片"],
          ] satisfies [Mode, string][]
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => setMode(v)}
            className={cn(
              "flex-1 rounded px-2 py-1 text-xs transition-colors",
              mode === v
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 预览：canvas 本身就是导出源，所见即所得 */}
      <div className="flex justify-center rounded-md bg-secondary/40 p-2">
        <canvas ref={canvasRef} className="h-auto w-[220px] rounded-lg" data-drawn={coverReady ? "1" : "0"} />
      </div>
      {!coverReady ? (
        <div className="mt-1 text-center text-[11px] text-muted-foreground">封面加载中…</div>
      ) : null}

      {hint ? (
        <div className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          {hint}
        </div>
      ) : null}

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={busy || !coverReady}
          onClick={() => void copyImage()}
          className={cn(
            "flex flex-1 items-center justify-center gap-1 rounded-md bg-primary/90 px-2 py-1.5 text-xs text-primary-foreground transition-colors",
            busy || !coverReady ? "opacity-50" : "hover:bg-primary",
          )}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : done === "copy" ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Share2 className="h-3.5 w-3.5" />
          )}
          {done === "copy" ? "已复制" : "复制图片"}
        </button>
        <button
          type="button"
          disabled={busy || !coverReady}
          onClick={() => void saveImage()}
          className={cn(
            "flex flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs text-foreground transition-colors",
            busy || !coverReady ? "opacity-50" : "hover:bg-secondary/60",
          )}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : done === "save" ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {done === "save" ? "已保存" : "保存为图片"}
        </button>
      </div>
      <div className="mt-1.5 text-center text-[10px] text-muted-foreground">
        复制后可直接粘贴到聊天窗口
      </div>
    </div>
  );
}
