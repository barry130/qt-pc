import { useEffect, useMemo, useRef, useState } from "react";
import { Download, ImageDown } from "lucide-react";
import { qtresCoverUrl } from "@/lib/lrc";
import * as ipc from "@/services/ipc";
import type { Track } from "@/types";
import { cn } from "@/lib/utils";
import { toastSuccess } from "@/stores/toast";
import { Spinner } from "@/components/ui";
import { drawShareQr } from "@/components/player/share-qr";
import {
  CARD_W,
  BOTTOM_H,
  FONT_SANS,
  PAD,
  RADIUS,
  SCALE,
  drawBrandFooter,
  drawCoverFill,
  readTheme,
  roundRect,
  wrapText,
} from "@/components/player/share-card-canvas";

/**
 * 歌单分享卡（A9，用户 m12833）：把歌单出成一张图发出去 ——
 * 2×2 的封面拼图 + 歌单名 + 曲目数 + 下载二维码。
 *
 * 与单曲卡（`ShareCardPanel`）共用 `share-card-canvas.ts` 的尺寸、取色、断行与
 * 底部品牌带：两张卡摆一起必须像一套东西。画法也同样是 canvas —— 预览即导出源，
 * 不会出现「预览一套样式、导出另一套」的偏差。
 *
 * **只画前 4 张封面**：100 首的歌单也只加载 4 张图（多的话光等封面就把面板卡住了），
 * 4 张也刚好把拼图铺满。
 */

/** 封面拼图边长（= 卡片宽），单格 150 */
const MOSAIC = CARD_W;
const CELL = MOSAIC / 2;
/** 最多取几首的封面 */
const COVER_COUNT = 4;

export function PlaylistShareCard(props: {
  /** 歌单名（可能是空串：本地歌单没设名时页面用「未命名歌单」兜底，这里同样兜底） */
  name: string;
  /** 歌单曲目（顺序即播放顺序，取前 4 首画封面） */
  tracks: Track[];
  /** 歌单总曲目数（不传就用 tracks.length；在线歌单 tracks 已是全量，通常一致） */
  count?: number;
  /** 歌单简介（有才画，最多 2 行） */
  description?: string;
}): React.JSX.Element {
  const [covers, setCovers] = useState<(HTMLImageElement | null)[]>([]);
  const [coverReady, setCoverReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const title = props.name.trim().length > 0 ? props.name.trim() : "未命名歌单";
  const count = props.count ?? props.tracks.length;

  // 前 4 首的封面地址（没有封面的曲目占一格灰块，不跳过去顶替 —— 否则拼图
  // 的排列与实际前 4 首对不上，看起来像"漏了一首"）
  const coverUrls = useMemo(
    () =>
      props.tracks
        .slice(0, COVER_COUNT)
        .map((t) => qtresCoverUrl(t.picUrl ?? "", 300)),
    [props.tracks],
  );

  // crossOrigin 必须带：qtres 响应有 ACAO:*，否则画布被污染、导出图会失败
  useEffect(() => {
    let alive = true;
    setCoverReady(false);
    const urls = coverUrls.filter((u): u is string => u !== null);
    if (urls.length === 0) {
      setCovers([]);
      setCoverReady(true);
      return;
    }
    const load = (url: string): Promise<HTMLImageElement | null> =>
      new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        // 单张失败不影响整张卡：那一格画灰块
        img.onerror = () => resolve(null);
        img.src = url;
      });
    void Promise.all(coverUrls.map((u) => (u === null ? Promise.resolve(null) : load(u)))).then(
      (imgs) => {
        if (!alive) return;
        setCovers(imgs);
        setCoverReady(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [coverUrls]);

  const draw = (): HTMLCanvasElement | null => {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return null;

    const t = readTheme();
    const inner = CARD_W - PAD * 2;

    // 先量高度：歌单名与简介都折行，卡片不能写死
    const probe = document.createElement("canvas").getContext("2d");
    let titleLines: string[] = [title];
    let descLines: string[] = [];
    if (probe !== null) {
      probe.font = `bold 18px ${FONT_SANS}`;
      titleLines = wrapText(probe, title, inner, 2);
      if ((props.description ?? "").trim().length > 0) {
        probe.font = `13px ${FONT_SANS}`;
        descLines = wrapText(probe, (props.description ?? "").trim(), inner, 2);
      }
    }
    const bodyH = 8 + titleLines.length * 26 + 6 + 18 + (descLines.length > 0 ? 6 + descLines.length * 20 : 0);
    const height = MOSAIC + bodyH + BOTTOM_H;

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

    // 2×2 封面拼图
    for (let i = 0; i < COVER_COUNT; i += 1) {
      const x = (i % 2) * CELL;
      const y = Math.floor(i / 2) * CELL;
      drawCoverFill(ctx, covers[i] ?? null, x, y, CELL, CELL, t.subtle);
    }
    // 格子之间压一条淡分割线，否则四张同色封面会糊成一整块
    ctx.strokeStyle = t.subtle;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(CELL, 0);
    ctx.lineTo(CELL, MOSAIC);
    ctx.moveTo(0, CELL);
    ctx.lineTo(MOSAIC, CELL);
    ctx.stroke();
    ctx.globalAlpha = 1;

    let y = MOSAIC + PAD + 16;
    ctx.fillStyle = t.text;
    ctx.font = `bold 18px ${FONT_SANS}`;
    ctx.textBaseline = "alphabetic";
    for (const ln of titleLines) {
      ctx.fillText(ln, PAD, y);
      y += 26;
    }
    y += 6;
    // 曲目数是分享卡的重点信息（对方先看"多大一张歌单"再决定要不要扫）
    ctx.fillStyle = t.subtle;
    ctx.font = `13px ${FONT_SANS}`;
    ctx.fillText(`共 ${count} 首歌曲`, PAD, y);
    y += 18;

    if (descLines.length > 0) {
      y += 6;
      ctx.fillStyle = t.subtle;
      ctx.font = `13px ${FONT_SANS}`;
      for (const ln of descLines) {
        ctx.fillText(ln, PAD, y);
        y += 20;
      }
    }

    // 底部一带：品牌在左，下载二维码在右
    ctx.restore();
    drawBrandFooter(ctx, height, t, drawShareQr);
    return canvas;
  };

  // 预览就是导出源：封面 / 曲目 / 简介任一变化都重画一次
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

  /** 动作收尾：失败留在面板里的红字（有补救建议，可操作），成功走右上角绿勾 */
  const finish = (ok: boolean, msg: string, okText: string): void => {
    setBusy(false);
    if (ok) {
      setHint(null);
      toastSuccess(okText);
    } else {
      setHint(msg);
    }
  };

  const copyImage = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setHint(null);
    const b64 = render();
    if (b64 === null) {
      finish(false, "生成图片失败", "");
      return;
    }
    try {
      const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob());
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      finish(true, "", "已复制图片到剪贴板");
    } catch {
      finish(false, "复制失败，可改用保存为图片", "");
    }
  };

  const saveImage = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setHint(null);
    const b64 = render();
    if (b64 === null) {
      finish(false, "生成图片失败", "");
      return;
    }
    try {
      const name = `${title}-歌单`.replace(/[\\/:*?"<>|]/g, "");
      const path = await ipc.pickSavePath(`${name}.png`, "保存分享卡片");
      if (path === null) {
        setBusy(false);
        return;
      }
      await ipc.saveBinaryFile(path, b64);
      finish(true, "", "已保存分享卡片");
    } catch (e: unknown) {
      finish(false, `保存失败：${e instanceof Error ? e.message : String(e)}`, "");
    }
  };

  return (
    <div className="w-[318px] max-w-[80vw]">
      <div className="mb-2 flex items-center gap-1.5 text-2xs text-muted-foreground">
        <ImageDown className="h-3 w-3" />
        <span className="min-w-0 flex-1 truncate">分享「{title}」</span>
      </div>

      {/* 预览：canvas 本身就是导出源，所见即所得 */}
      <div className="flex justify-center rounded-md bg-secondary/40 p-2">
        <canvas
          ref={canvasRef}
          className="h-auto w-[220px] rounded-lg"
          data-drawn={coverReady ? "1" : "0"}
        />
      </div>
      {!coverReady ? (
        <div className="mt-1 text-center text-2xs text-muted-foreground">封面加载中…</div>
      ) : null}

      {hint ? (
        <div className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-2xs text-destructive">
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
            <Spinner size="sm" className="h-3.5 w-3.5" />
          ) : (
            <ImageDown className="h-3.5 w-3.5" />
          )}
          复制图片
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
            <Spinner size="sm" className="h-3.5 w-3.5" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          保存为图片
        </button>
      </div>
      <div className="mt-1.5 text-center text-2xs text-muted-foreground">
        复制后可直接粘贴到聊天窗口
      </div>
    </div>
  );
}
