// @vitest-environment jsdom
/**
 * 音质钳位 `clampQualityForPlatform` 的回归测试。
 *
 * 为什么必须有：旧实现用硬编码 `QUALITY_RANKS = ["flac","320","128"]` 推断档位
 * 高低，音源包 2026-10 加了 `flac24bit` 之后这张表就不再完整——
 * `indexOf("flac24bit") = -1` ⇒ 走 `return declared[0]` ⇒
 * **任何**平台选「母带 24bit」下载都被钳成「标准 128k」。
 * 播放路径不经过这个函数，所以现场表现为「播放是 24bit，下载回来是 128k」。
 *
 * 现在档位序从注册表的 `qualities` 派生（包侧按低→高声明，这里反转），
 * 本测试把「加新档位不需要改宿主」这件事钉死。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@/source-scripts", () => ({
  DEFAULT_SEARCH_PAGE_MAX: 50,
  getSourceRegistry: () => Promise.resolve(null),
}));
vi.mock("@/source-engine/client", () => ({ onEnginePhaseChange: () => () => {} }));
vi.mock("@/stores/musicSource", () => ({
  useMusicSourceStore: { getState: () => ({ activeSourceId: null }) },
}));

import { clampQualityForPlatform, useSourceRegistryStore } from "@/stores/sourceRegistry";
import type { RegistryQuality, RegistrySource } from "@/types";

/** 包侧 `QUALITIES` 的声明序：低 → 高 */
const QUALITIES: RegistryQuality[] = [
  { id: "128", name: "标准 128k" },
  { id: "320", name: "高品 320k" },
  { id: "flac", name: "无损 FLAC" },
  { id: "flac24bit", name: "母带 24bit" },
];

function source(id: string, qualities: string[]): RegistrySource {
  return {
    id,
    name: id,
    short: id,
    color: "#888888",
    qualities,
  };
}

function loadRegistry(sources: RegistrySource[]): void {
  useSourceRegistryStore.setState({ sources, qualities: QUALITIES, ready: true });
}

describe("clampQualityForPlatform", () => {
  beforeEach(() => {
    useSourceRegistryStore.setState({
      sources: [],
      qualities: [],
      ready: false,
      generation: 0,
    });
  });

  it("源声明了 flac24bit 时原样保留（**旧实现在这里返回 128**）", () => {
    loadRegistry([
      source("wyy", ["128", "320", "flac", "flac24bit"]),
      source("qq", ["128", "320", "flac", "flac24bit"]),
      source("kw", ["128", "320", "flac", "flac24bit"]),
      source("kg", ["128", "320", "flac", "flac24bit"]),
    ]);
    for (const id of ["wyy", "qq", "kw", "kg"]) {
      expect(clampQualityForPlatform(id, "flac24bit")).toBe("flac24bit");
    }
  });

  it("源只有三档时，24bit 降到 flac 而不是掉到 128", () => {
    loadRegistry([source("bili", ["128", "320", "flac"]), source("migu", ["128", "320", "flac"])]);
    expect(clampQualityForPlatform("bili", "flac24bit")).toBe("flac");
    expect(clampQualityForPlatform("migu", "flac24bit")).toBe("flac");
  });

  it("向下取「最接近」的一档，而不是 declared[0]", () => {
    loadRegistry([source("k1", ["128", "320"])]);
    // 源没有 flac24bit → 就近给 320（而不是掉到 declared[0] = 128）
    expect(clampQualityForPlatform("k1", "flac24bit")).toBe("320");
    // 想要 flac，源只有 320/128 → 就近向上取 320
    expect(clampQualityForPlatform("k1", "flac")).toBe("320");
    // 只声明 128 的源：想要什么都只能给 128
    loadRegistry([source("k1b", ["128"])]);
    expect(clampQualityForPlatform("k1b", "flac")).toBe("128");
  });

  it("降不到时向上一档取（不会静默退到最低档）", () => {
    loadRegistry([source("k2", ["128", "flac24bit"])]);
    expect(clampQualityForPlatform("k2", "flac")).toBe("flac24bit");
  });

  it("未声明 qualities 的源原样返回（行为不变）", () => {
    loadRegistry([source("k3", [])]);
    expect(clampQualityForPlatform("k3", "flac24bit")).toBe("flac24bit");
    expect(clampQualityForPlatform("unknown-platform", "flac24bit")).toBe("flac24bit");
    expect(clampQualityForPlatform(null, "flac24bit")).toBe("flac24bit");
  });

  it("注册表还没装好（qualities 为空）时不动请求值", () => {
    // 源已声明档位但全局档位序未知＝对高低一无所知，宁可原样发出去
    useSourceRegistryStore.setState({
      sources: [source("k4", ["128", "320"])],
      qualities: [],
      ready: false,
    });
    expect(clampQualityForPlatform("k4", "flac24bit")).toBe("flac24bit");
  });

  it("档位序由注册表派生：包侧加档位不需要改宿主", () => {
    // 模拟包侧将来再加一档 32bit（最低档）与 dolby（最高档）
    useSourceRegistryStore.setState({
      sources: [
        source("k5", ["128", "320", "flac", "flac24bit"]),
        source("k6", ["128", "flac"]),
      ],
      qualities: [
        { id: "32", name: "省流 32k" },
        ...QUALITIES,
        { id: "dolby", name: "全景声" },
      ],
      ready: true,
    });
    // dolby 比 flac24bit 更高：k6 没有 dolby 也不该退到 flac 以下
    expect(clampQualityForPlatform("k5", "dolby")).toBe("flac24bit");
    // 32k 最低：想要 32 且源不支持时向上取 128
    expect(clampQualityForPlatform("k6", "32")).toBe("128");
  });

  it("注册表里没有的开放档位（如 hires）退回 declared[0]", () => {
    // 保持旧行为：包侧声明了、但全局 qualities 没收录的档位不参与推断
    loadRegistry([source("k7", ["320", "128"])]);
    expect(clampQualityForPlatform("k7", "hires")).toBe("320");
  });
});