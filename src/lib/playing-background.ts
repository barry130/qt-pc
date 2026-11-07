export const PLAYING_BACKGROUNDS = [
  { id: "auto", label: "风格默认" },
  { id: "cover", label: "封面氛围" },
  { id: "burgundy", label: "晚霞酒红" },
  { id: "midnight", label: "午夜蓝" },
  { id: "forest", label: "松林绿" },
  { id: "image", label: "本地图片" },
] as const;
export type PlayingBackgroundKind = (typeof PLAYING_BACKGROUNDS)[number]["id"];
export interface PlayingBackgroundPreference {
  kind: PlayingBackgroundKind;
  image: string;
}
export const DEFAULT_PLAYING_BACKGROUND: PlayingBackgroundPreference = { kind: "auto", image: "" };

export function parsePlayingBackground(raw: string | null): PlayingBackgroundPreference {
  try {
    const saved: unknown = JSON.parse(raw ?? "null");
    if (!saved || typeof saved !== "object") return DEFAULT_PLAYING_BACKGROUND;
    const { kind, image } = saved as Record<string, unknown>;
    if (!PLAYING_BACKGROUNDS.some((item) => item.id === kind)) return DEFAULT_PLAYING_BACKGROUND;
    const picture = typeof image === "string" && image.length < 6_000_000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(image) ? image : "";
    return { kind: kind === "image" && !picture ? "auto" : kind as PlayingBackgroundKind, image: picture };
  } catch {
    return DEFAULT_PLAYING_BACKGROUND;
  }
}

export function resolvePlayingBackground(style: string, background: PlayingBackgroundKind): Exclude<PlayingBackgroundKind, "auto"> | "theme" {
  if (background !== "auto") return background;
  if (style === "rhythm") return "burgundy";
  if (style === "gallery") return "cover";
  if (style === "focus") return "midnight";
  return "theme";
}

/** 只在用户选图时解码一次，缩至屏幕背景尺寸后保存，避免原图长期占用设置与内存。 */
export async function readPlayingBackgroundImage(file: File): Promise<string> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("请选择 JPG、PNG 或 WebP 图片");
  if (file.size > 12 * 1024 * 1024) throw new Error("图片不能超过 12 MB");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("图片无法读取，请重新选择");
    const ratio = Math.min(1, 1920 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("图片无法读取，请重新选择");
    context.fillStyle = "#101622";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    throw new Error("图片无法读取，请重新选择");
  } finally {
    URL.revokeObjectURL(url);
  }
}
