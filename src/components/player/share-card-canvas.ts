/**
 * 分享卡的共用画布工具（单曲卡 `ShareCardPanel` + 歌单卡 `PlaylistShareCard`）。
 *
 * 为什么单独抽一份：两张卡尺寸、取色、断行、圆角、底部「品牌 + 二维码」那一带
 * 必须一致 —— 各抄一遍的话，改一个常量就只有一张卡跟着变，分享出去的两张图
 * 摆一起立刻看得出不是一套东西。
 */

/** 卡片逻辑尺寸；导出按 2 倍像素出图，够清晰又不至于太大 */
export const CARD_W = 300;
export const SCALE = 2;
export const PAD = 18;
export const RADIUS = 16;

/**
 * 底部那一带（品牌 + 下载二维码）的高度。
 * 二维码 64 + 上下各 16 = 96，比原来的 46 高出一半 —— 二维码小到 48 以下
 * 在手机上就很难对焦了，宁可卡片长一点。
 */
export const BOTTOM_H = 96;

/** 二维码方块边长（含四周 4 格安静区，见 share-qr.ts） */
export const QR_BLOCK = 64;

export const FONT_SANS =
  '"PingFang SC","Microsoft YaHei","Noto Sans SC","Helvetica Neue",Arial,sans-serif';

/** 卡片品牌（底部那一带） */
export const SHARE_CARD_BRAND = "轻听音乐";
export const SHARE_CARD_BRAND_SUB = "QuietMusic";

/** 卡片取到的主题实值（画布不认 CSS 变量） */
export interface CardTheme {
  bg: string;
  text: string;
  subtle: string;
  accent: string;
}

export function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v.length > 0 ? v : fallback;
}

/**
 * 画布不认 CSS 变量，也不接受 oklch 之外的随意字符串——这里统一取实值。
 * 主题切换（skins.ts 覆写 --primary 等）后重开弹层即可拿到新值。
 */
export function readTheme(): CardTheme {
  return {
    bg: cssVar("--card", "#ffffff"),
    text: cssVar("--card-foreground", "#1f2937"),
    subtle: cssVar("--muted-foreground", "#64748b"),
    accent: cssVar("--primary", "#4f46e5"),
  };
}

/** 按最大宽度断行（中文逐字、英文按空格/连字符，够用即可） */
export function wrapText(
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
  const tokens = text.match(/[A-Za-z0-9''-]+|\s+|[^\s]/g) ?? [];
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

export function roundRect(
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

/**
 * 画一张封面（`aspectFill` 等价：按长边铺满后居中裁）。
 *
 * 图还没加载完（`img` 为 null）时画一块淡色占位，卡片其余部分照常画完 ——
 * 分享卡不该因为一张封面挂了就整个出不了图。
 */
export function drawCoverFill(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  x: number,
  y: number,
  w: number,
  h: number,
  subtle: string,
): void {
  if (img === null || img.width === 0 || img.height === 0) {
    ctx.fillStyle = subtle;
    ctx.globalAlpha = 0.18;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    return;
  }
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/**
 * 底部那一带：右侧二维码，左侧三行（品牌 / 引导语 / 英文名）与二维码垂直居中。
 *
 * 两张卡都调它，`height` 传卡片总高 —— 二维码永远贴右下角，左侧文字跟着它对齐，
 * 卡片长高时不用各调一遍坐标。
 */
export function drawBrandFooter(
  ctx: CanvasRenderingContext2D,
  height: number,
  t: CardTheme,
  drawQr: (ctx: CanvasRenderingContext2D, x: number, y: number, block: number) => void,
): void {
  const qrX = CARD_W - PAD - QR_BLOCK;
  const qrY = height - PAD - QR_BLOCK;
  drawQr(ctx, qrX, qrY, QR_BLOCK);

  const centerY = qrY + QR_BLOCK / 2;
  ctx.fillStyle = t.accent;
  ctx.font = `bold 13px ${FONT_SANS}`;
  ctx.fillText(SHARE_CARD_BRAND, PAD, centerY - 10);
  ctx.fillStyle = t.text;
  ctx.font = `10px ${FONT_SANS}`;
  ctx.fillText("扫码下载客户端", PAD, centerY + 6);
  ctx.fillStyle = t.subtle;
  ctx.font = `9px ${FONT_SANS}`;
  ctx.fillText(SHARE_CARD_BRAND_SUB, PAD, centerY + 20);
}
