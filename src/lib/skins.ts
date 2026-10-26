/**
 * 皮肤系统（DESIGN §9.2 skinId / R7 followCoverColor）。
 * 内置 5 套皮肤（SKINS 表）+ 一套由 getSkin() 按自定义主色合成的 "custom"，每套定义：
 * - 主色（primary）：按钮/链接/激活态
 * - 背景色（bg）：主区域底色，带皮肤色相微调
 * - 侧边栏色（sidebar）：侧边栏底色，比背景深/浅一档
 * 支持从专辑封面提取主色，动态覆盖 --primary。
 */

export interface SkinDef {
  id: string;
  name: string;
  /** 浅色模式主色 */
  primaryLight: string;
  /** 深色模式主色 */
  primaryDark: string;
  /** 浅色模式背景色 */
  bgLight: string;
  /** 深色模式背景色 */
  bgDark: string;
  /** 浅色模式侧边栏色 */
  sidebarLight: string;
  /** 深色模式侧边栏色 */
  sidebarDark: string;
}

export const SKINS: SkinDef[] = [
  {
    // 默认皮肤：Deep Indigo 影院深色（设计库 Music Streaming 配色）。
    // 深底用带靛蓝倾向的深蓝黑 #0F0F23，比中性近黑 #171717 更有氛围，
    // 也给封面渐变 banner 和主色辉光留了色彩空间。
    id: "default",
    name: "默认",
    primaryLight: "#4f46e5",
    primaryDark: "#6366f1",
    bgLight: "#ffffff",
    bgDark: "#0f0f23",
    sidebarLight: "#f4f4fb",
    sidebarDark: "#14142b",
  },
  {
    id: "sakura",
    name: "樱花",
    primaryLight: "#ec4899",
    primaryDark: "#f472b6",
    bgLight: "#fff5f8",
    bgDark: "#1a1518",
    sidebarLight: "#fef0f5",
    sidebarDark: "#262024",
  },
  {
    id: "ocean",
    name: "深海",
    primaryLight: "#0ea5e9",
    primaryDark: "#38bdf8",
    bgLight: "#f0f9ff",
    bgDark: "#151a1f",
    sidebarLight: "#e0f2fe",
    sidebarDark: "#20262c",
  },
  {
    id: "forest",
    name: "森林",
    primaryLight: "#22c55e",
    primaryDark: "#4ade80",
    bgLight: "#f0fdf4",
    bgDark: "#151f1a",
    sidebarLight: "#dcfce7",
    sidebarDark: "#202c26",
  },
  {
    id: "sunset",
    name: "暖阳",
    primaryLight: "#f97316",
    primaryDark: "#fb923c",
    bgLight: "#fff7ed",
    bgDark: "#1f1a15",
    sidebarLight: "#ffedd5",
    sidebarDark: "#2c2620",
  },
];

export function getSkin(id: string, customColor?: string): SkinDef {
  if (id === "custom" && customColor) {
    return {
      id: "custom",
      name: "自定义",
      primaryLight: customColor,
      primaryDark: customColor,
      bgLight: "#ffffff",
      bgDark: "#171717",
      sidebarLight: "#f8f9fa",
      sidebarDark: "#1f1f1f",
    };
  }
  return SKINS.find((s) => s.id === id) ?? SKINS[0];
}

/** 判断 RGB 颜色是否偏亮（需要暗色前景文本） */
export function isLightColor(r: number, g: number, b: number): boolean {
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6;
}

/**
 * 解析 `#rgb` / `#rrggbb` 为 [r, g, b]。
 * 解析失败（自定义色不是十六进制等）返回 null，由调用方回退默认前景色。
 */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * 封面取色缓存容量上限。封面 URL 可能来自任意外链（切歌 / 换源都会带来新
 * 键），进程生命期内不设限会随播放历史无限增长。Map 保持插入序：超限淘汰
 * 最旧键、命中时重新插入刷新位置（近似 LRU）。
 */
const COVER_CACHE_MAX = 256;

function cacheGet<T>(cache: Map<string, T>, url: string): T | undefined {
  if (!cache.has(url)) return undefined;
  const value = cache.get(url)!;
  cache.delete(url);
  cache.set(url, value);
  return value;
}

function cacheSet<T>(cache: Map<string, T>, url: string, value: T): T {
  if (!cache.has(url) && cache.size >= COVER_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(url, value);
  return value;
}

const coverColorCache = new Map<string, string | null>();

/**
 * 已解码封面的共享缓存 + 在飞去重。
 *
 * 主色与「醒目主色」都要同一张封面：原先两个函数各自 fetch + 解码一遍，播放页
 * 一进就白付一次网络往返 + 一次解码。这里把「下载并解码成 Image」收成一份，
 * 两个取色函数只负责各自的画布采样。
 */
const coverImageCache = new Map<string, HTMLImageElement | null>();
const coverImageInflight = new Map<string, Promise<HTMLImageElement | null>>();

async function loadCoverImage(url: string): Promise<HTMLImageElement | null> {
  const hit = cacheGet(coverImageCache, url);
  if (hit !== undefined) return hit;
  const pending = coverImageInflight.get(url);
  if (pending) return pending;

  const task = (async (): Promise<HTMLImageElement | null> => {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const img = new Image();
      try {
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("image load failed"));
          img.src = blobUrl;
        });
      } finally {
        // 解码完成即可释放 blob URL：Image 已持有位图，后续 drawImage 照常可用
        URL.revokeObjectURL(blobUrl);
      }
      return img;
    } catch {
      return null;
    }
  })();

  coverImageInflight.set(url, task);
  try {
    const img = await task;
    return cacheSet(coverImageCache, url, img);
  } finally {
    coverImageInflight.delete(url);
  }
}

/**
 * 从封面 URL 提取主色。
 * 通过 fetch → blob → canvas 采样，避免 CORS 问题。
 * 跳过灰度色（饱和度 < 15%）和全透明图。
 * 结果缓存，同一 URL 不重复提取。
 */
export async function extractCoverColor(url: string): Promise<string | null> {
  const hit = cacheGet(coverColorCache, url);
  if (hit !== undefined) return hit;

  try {
    const img = await loadCoverImage(url);
    if (!img) {
      return cacheSet(coverColorCache, url, null);
    }

    const size = 40;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return cacheSet(coverColorCache, url, null);
    }

    ctx.drawImage(img, 0, 0, size, size);

    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(0, 0, size, size).data;
    } catch {
      // 画布被跨源图污染时 getImageData 抛错：按取色失败处理，不拖垮调用方
      return cacheSet(coverColorCache, url, null);
    }
    let r = 0,
      g = 0,
      b = 0,
      count = 0;

    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue; // 跳过透明像素
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count++;
    }

    if (count === 0) {
      return cacheSet(coverColorCache, url, null);
    }

    r = Math.round(r / count);
    g = Math.round(g / count);
    b = Math.round(b / count);

    // 饱和度检查：跳过灰度色
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === 0 || (max - min) / max < 0.15) {
      return cacheSet(coverColorCache, url, null);
    }

    const color = `rgb(${r}, ${g}, ${b})`;
    return cacheSet(coverColorCache, url, color);
  } catch {
    return cacheSet(coverColorCache, url, null);
  }
}

const coverAccentCache = new Map<string, string | null>();

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [h, s, l];
}

/**
 * 提取封面「醒目主色」：不做平均，而是找饱和度最高的一簇像素，
 * 再归一到固定饱和度/亮度的 hsl()，保证每张封面都能得到一个干净的色调。
 *
 * 平均色在深色封面上会得出灰褐色（糊背景的来源），所以背景映射用它。
 * 返回 null 表示封面基本无彩色（灰阶/黑白封面），此时背景退回皮肤主色。
 */
export async function extractCoverAccent(url: string): Promise<string | null> {
  const hit = cacheGet(coverAccentCache, url);
  if (hit !== undefined) return hit;

  const record = (v: string | null): string | null => {
    cacheSet(coverAccentCache, url, v);
    return v;
  };

  try {
    const img = await loadCoverImage(url);
    if (!img) return record(null);

    const size = 48;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return record(null);

    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;

    let bestScore = -1;
    let bestHue = -1;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue; // 跳过透明
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = (max - min) / 255;
      // 跳过灰阶、近黑与过曝白
      if (sat < 0.2 || min < 26) continue;
      const light = (max + min) / 510;
      // 优先中高亮度 + 高饱和度的像素
      const score = sat * (1 - Math.abs(light - 0.52) * 1.5);
      if (score > bestScore) {
        bestScore = score;
        bestHue = rgbToHsl(r, g, b)[0];
      }
    }

    if (bestHue < 0) return record(null);

    // 固定饱和度 72% / 亮度 50%：无论原图脏不脏，输出都是干净的色调
    const h = Math.round(bestHue);
    return record(`hsl(${h}, 72%, 50%)`);
  } catch {
    return record(null);
  }
}
