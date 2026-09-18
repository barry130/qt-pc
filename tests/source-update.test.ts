/**
 * 音源包更新判定单测（§2.3 客户端判定 6 步，纯函数）。
 */
import { describe, expect, it } from "vitest";
import {
  decideUpdate,
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
      { path: "chain.json", version: 8, url: "https://cdn.example/chain.json" },
      { path: "source-bundle.js", version: 3, url: "https://cdn.example/bundle.js" },
    ],
    published: true,
    bad: false,
    ...overrides,
  };
}

function local(overrides: Partial<SourceStateVo> = {}): Pick<SourceStateVo, "installed" | "bad"> {
  return {
    installed: {
      sourceVersionCode: 2026091701,
      dir: "2026091701",
      files: { "chain.json": 7, "source-bundle.js": 3 },
      sourceVersionName: "2026.09.17.1",
    },
    bad: [],
    ...overrides,
  };
}

describe("source-update 判定（§2.3）", () => {
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
    expect(d.reason).toContain("冒烟失败");
  });

  it("5a. 远端 > 本地 → 下载全部 artifacts", () => {
    const d = decideUpdate(release(), local());
    expect(d.action).toBe("download");
    if (d.action === "download") {
      expect(d.release.sourceVersionCode).toBe(2026091801);
      expect(d.release.artifacts).toHaveLength(2);
    }
  });

  it("5b. 未安装任何包且远端 > 内置版 → 下载", () => {
    const d = decideUpdate(release({ sourceVersionCode: 2026091902 }), local({ installed: null }));
    expect(d.action).toBe("download");
  });

  it("5c. 远端 < 本地 → 拒绝降级", () => {
    const d = decideUpdate(release({ sourceVersionCode: 2026091601 }), local());
    expect(d.action).toBe("none");
    expect(d.reason).toContain("拒绝降级");
  });

  it("5d. 未装远程包且远端 == 内置版 → 内置已带，不下载", () => {
    const d = decideUpdate(
      release({ sourceVersionCode: 2026091901 }),
      local({ installed: null }),
    );
    expect(d.action).toBe("none");
    expect(d.reason).toContain("内置版已是该版本");
  });

  it("5e. 未装远程包且远端 > 内置版 → 下载", () => {
    const d = decideUpdate(
      release({ sourceVersionCode: 2026092001 }),
      local({ installed: null }),
    );
    expect(d.action).toBe("download");
  });

  it("5f. 公开 manifest 的 published 为 null（管理端字段）→ 视为已发布", () => {
    const d = decideUpdate(
      release({
        sourceVersionCode: 2026092001,
        published: null as unknown as boolean,
      }),
      local({ installed: null }),
    );
    expect(d.action).toBe("download");
  });

  it("6a. 同版本但文件版本不同 → 只补差异（仍按全集下载，Rust 端跳过同版本文件）", () => {
    const d = decideUpdate(
      release({ sourceVersionCode: 2026091701, artifacts: [release().artifacts[0]] }),
      local(),
    );
    expect(d.action).toBe("download");
  });

  it("6b. 同版本且文件全一致 → 已是最新", () => {
    const d = decideUpdate(
      release({
        sourceVersionCode: 2026091701,
        artifacts: [
          { path: "chain.json", version: 7, url: "https://cdn.example/chain.json" },
          { path: "source-bundle.js", version: 3, url: "https://cdn.example/bundle.js" },
        ],
      }),
      local(),
    );
    expect(d.action).toBe("none");
    expect(d.reason).toContain("最新");
  });

  it("6c. 同版本但本地缺文件（装到一半）→ 补下", () => {
    const d = decideUpdate(release({ sourceVersionCode: 2026091701 }), {
      installed: {
        sourceVersionCode: 2026091701,
        dir: "2026091701",
        files: {},
        sourceVersionName: "x",
      },
      bad: [],
    });
    expect(d.action).toBe("download");
  });
});
