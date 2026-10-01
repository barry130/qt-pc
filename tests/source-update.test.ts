/**
 * 播放音源包更新判定单测（双音源包架构：官方包 bootstrap/更新，自定义包不参与）。
 */
import { describe, expect, it } from "vitest";
import {
  decideUpdate,
  type PlayPackVo,
  type SourceReleaseVo,
  type SourceStateVo,
} from "@/source-scripts/source-update";

function release(overrides: Partial<SourceReleaseVo> = {}): SourceReleaseVo {
  return {
    sourceVersionCode: 2026091801,
    sourceVersionName: "2026.09.18.1",
    platforms: [1101, 1103],
    hostApiVersion: 1,
    channel: "stable",
    notes: "测试版本",
    artifacts: [
      { path: "play-bundle.js", version: 3, url: "https://cdn.example/play-bundle.js" },
    ],
    published: true,
    bad: false,
    ...overrides,
  };
}

function pack(overrides: Partial<PlayPackVo> = {}): PlayPackVo {
  return {
    id: "official",
    name: "play-bundle",
    version: "chain.10",
    versionCode: 2026091701,
    versionName: "2026.09.17.1",
    source: "official",
    dir: "2026091701",
    installedAt: 1_800_000_000,
    ...overrides,
  };
}

function local(overrides: Partial<SourceStateVo> = {}): SourceStateVo {
  return {
    schema: 2,
    packs: [pack()],
    activeId: "official",
    bad: [],
    lastCheckAt: 0,
    previousOfficial: null,
    ...overrides,
  };
}

describe("source-update 判定（双音源包）", () => {
  it("1. 无 release → 不更新", () => {
    const d = decideUpdate(null, local());
    expect(d.action).toBe("none");
  });

  it("2. 撤回（bad=true / 未发布）→ 忽略", () => {
    expect(decideUpdate(release({ bad: true }), local()).action).toBe("none");
    expect(decideUpdate(release({ published: false }), local()).action).toBe("none");
  });

  it("3. hostApiVersion 超本机契约 → 提示升级应用", () => {
    const d = decideUpdate(release({ hostApiVersion: 2 }), local());
    expect(d.action).toBe("need_app_update");
    expect(d.reason).toContain("v2");
  });

  it("4. 本地 bad[] 含该 code → 跳过", () => {
    const d = decideUpdate(release(), local({ bad: [2026091801] }));
    expect(d.action).toBe("none");
    expect(d.reason).toContain("装载失败");
  });

  it("5a. 官方包未装 → bootstrap 安装", () => {
    const d = decideUpdate(release(), local({ packs: [], activeId: null }));
    expect(d.action).toBe("download");
    if (d.action === "download") {
      expect(d.release.sourceVersionCode).toBe(2026091801);
    }
  });

  it("5b. 已装自定义包但无官方包 → 仍引导安装官方包（两者共存）", () => {
    const d = decideUpdate(
      release(),
      local({
        packs: [pack({ id: "custom-20261001-120000", source: "custom", versionCode: 0 })],
        activeId: "custom-20261001-120000",
      }),
    );
    expect(d.action).toBe("download");
  });

  it("5c. 远端 > 本地官方包 → 更新", () => {
    const d = decideUpdate(release(), local());
    expect(d.action).toBe("download");
    expect(d.reason).toContain("新版本");
  });

  it("5d. 远端 < 本地官方包 → 拒绝降级", () => {
    const d = decideUpdate(release({ sourceVersionCode: 2026091601 }), local());
    expect(d.action).toBe("none");
    expect(d.reason).toContain("拒绝降级");
  });

  it("5e. 远端 == 本地官方包 → 已是最新（同一 code 目录重装由 Rust 幂等处理）", () => {
    const d = decideUpdate(release({ sourceVersionCode: 2026091701 }), local());
    expect(d.action).toBe("none");
    expect(d.reason).toContain("最新");
  });

  it("5f. 公开 manifest 的 published 为 null（管理端字段）→ 视为已发布", () => {
    const d = decideUpdate(
      release({ sourceVersionCode: 2026091801, published: null as unknown as boolean }),
      local({ packs: [], activeId: null }),
    );
    expect(d.action).toBe("download");
  });

  it("5g. 本地只有自定义包不影响官方包更新通道（官方包在列表时按官方包比较）", () => {
    const custom = pack({
      id: "custom-20261001-120000",
      source: "custom",
      versionCode: 0,
      dir: "custom-20261001-120000",
    });
    const d = decideUpdate(release(), local({ packs: [pack(), custom] }));
    expect(d.action).toBe("download");
  });
});
