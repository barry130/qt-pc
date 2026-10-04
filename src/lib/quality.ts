import type { Quality, RegistryQuality } from "@/types";

/**
 * 音质档位清单由数据包注册表声明（stores/sourceRegistry.ts）；这里只保留
 * 「可播值口径」与未就绪时的兜底菜单。
 *
 * 两个入口，语义不同（REQUIREMENTS：设置管默认，播放条管当前这首）：
 * - 设置页「默认播放音质 / 默认下载音质」→ 写 settings，长期有效；
 * - 播放条上的音质菜单 → 只对当前这首生效，换歌回到默认。
 */

/** 兜底三档（注册表未就绪/为空时的菜单选项，与 Rust 端 serde 值一致） */
export const QUALITY_OPTIONS: {
  value: Quality;
  label: string;
  short: string;
}[] = [
  { value: "128", label: "标准", short: "128K" },
  { value: "320", label: "高品", short: "320K" },
  { value: "flac", label: "无损", short: "FLAC" },
];

/** 菜单选项结构（value 可直接进播放/下载链路） */
export interface QualityOption {
  value: Quality;
  label: string;
  short: string;
}

/**
 * 可播音质口径：**只做形状校验**（非空字符串）。
 *
 * 2026-10 全开放改造后，Rust 侧 `Quality` 已是开放 newtype 字符串
 * （provider/types.rs），数据包声明什么档位就落库什么档位——这里不再持有
 * "128"/"320"/"flac" 白名单，新增档位只改音源包即可。空值仍拒（DB/命令
 * 层无法表达）。
 */
export function isQuality(v: unknown): v is Quality {
  return typeof v === "string" && v.trim().length > 0;
}

/** 数据包注册表声明的档位 → 菜单选项：名称按首个空格拆成「档名 + 短标」
 *  （包里是 “标准 128k” 这种写法）；未就绪/为空时退回内置三档，
 *  注册表加载完成前菜单不至于空白。 */
export function qualityOptionsFromRegistry(qualities: RegistryQuality[]): QualityOption[] {
  const fromPack: QualityOption[] = [];
  for (const q of qualities) {
    if (!isQuality(q.id)) continue;
    const sp = q.name.indexOf(" ");
    fromPack.push(
      sp > 0
        ? { value: q.id, label: q.name.slice(0, sp), short: q.name.slice(sp + 1) }
        : { value: q.id, label: q.name, short: q.id.toUpperCase() },
    );
  }
  return fromPack.length > 0 ? fromPack : QUALITY_OPTIONS;
}
