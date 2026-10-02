/**
 * 统一音源包（v3）前端展示与包装层单测：
 * 纯文案 helper 直测；走 IPC 的包装函数用 vi.mock 桩掉 @/services/ipc。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOST_API_VERSION,
  activateSourcePack,
  installSourceFromLocalFile,
  installSourceLabel,
  installStagedSource,
  isPackLinkUrl,
  kindLabel,
  lastErrorSummary,
  offerLabel,
  packDisplayName,
  packVersionLabel,
  shortUpdateDate,
  stageSourceFromFile,
  stageSourceFromUrl,
  type PackUpdateOfferVo,
  type SourcePackVo,
} from "@/source-scripts/source-update";
import * as ipc from "@/services/ipc";

vi.mock("@/services/ipc", () => ({
  sourceState: vi.fn(),
  sourceDiscoverUpdates: vi.fn(),
  sourceApplyUpdate: vi.fn(),
  sourceInstallFromUrl: vi.fn(),
  sourceInstallLocalFile: vi.fn(),
  sourceStageFromUrl: vi.fn(),
  sourceStageFromFile: vi.fn(),
  sourceInstallStaged: vi.fn(),
  sourceActivatePack: vi.fn(),
  sourceUninstallPack: vi.fn(),
}));

function pack(overrides: Partial<SourcePackVo> = {}): SourcePackVo {
  return {
    id: "play-official",
    kind: "play",
    name: "官方播放包",
    versionCode: 3,
    versionName: "2026.09.18.1",
    updateUrl: "https://cdn.example/play-bundle.js",
    dir: "play-official",
    installedAt: 1_800_000_000,
    updatedAt: 1_800_000_000,
    skipCodes: [],
    lastProbeAt: 0,
    installSource: "url",
    installRef: "https://cdn.example/play-bundle.js",
    lastError: "",
    lastErrorAt: 0,
    ...overrides,
  };
}

function offer(overrides: Partial<PackUpdateOfferVo> = {}): PackUpdateOfferVo {
  return {
    kind: "play",
    targetId: "play-official",
    currentCode: 3,
    newCode: 4,
    newName: "官方播放包",
    notes: "",
    channel: "self",
    url: "https://cdn.example/play-bundle.js",
    fromBaseline: false,
    ...overrides,
  };
}

describe("source-update 文案 helper（v3）", () => {
  it("0. 宿主契约版本与配置一致（sync-config 从 config 同步此值）", () => {
    expect(HOST_API_VERSION).toBe(1);
  });

  it("1. kindLabel 数据/播放", () => {
    expect(kindLabel("meta")).toBe("数据包");
    expect(kindLabel("play")).toBe("播放包");
  });

  it("2. packDisplayName 缺名兜底到类型名", () => {
    expect(packDisplayName(pack())).toBe("官方播放包");
    expect(packDisplayName(pack({ name: "" }))).toBe("播放包");
  });

  it("3. packVersionLabel versionName 缺省时落到 v{code}", () => {
    expect(packVersionLabel(pack())).toBe("2026.09.18.1");
    expect(packVersionLabel(pack({ versionName: "" }))).toBe("v3");
  });

  it("4a. offerLabel 播放包：current → new（含新名）", () => {
    expect(offerLabel(offer())).toBe(
      "播放包有新版本：v3 → v4（官方播放包）",
    );
  });

  it("4b. offerLabel 数据包基线通道：内置基线 → new", () => {
    const text = offerLabel(
      offer({
        kind: "meta",
        targetId: "meta-official",
        currentCode: 0,
        newCode: 2,
        newName: "官方数据包",
        channel: "manifest",
        fromBaseline: true,
      }),
    );
    expect(text).toBe("数据包有新版本：内置基线 → v2（官方数据包）");
  });

  it("4c. installSourceLabel 四种来源", () => {
    expect(installSourceLabel("url")).toBe("链接安装");
    expect(installSourceLabel("file")).toBe("本地安装");
    expect(installSourceLabel("manifest")).toBe("官方渠道");
    expect(installSourceLabel("")).toBe("—");
  });

  it("4d. shortUpdateDate unix 秒 → MM-DD（本地时区构造，测试跨时区稳定）", () => {
    const local = new Date(2026, 8, 2, 12, 0, 0); // 2026-09-02 正午
    expect(shortUpdateDate(Math.floor(local.getTime() / 1000))).toBe("09-02");
    expect(shortUpdateDate(0)).toBe("");
  });

  it("4e. lastErrorSummary 40 字内原样、超长截断加省略号、空安全", () => {
    expect(lastErrorSummary("  装载失败：SyntaxError  ")).toBe("装载失败：SyntaxError");
    const over = "x".repeat(41);
    expect(lastErrorSummary(over)).toBe(`${"x".repeat(40)}…`);
    expect(lastErrorSummary("x".repeat(40))).toBe("x".repeat(40));
    expect(lastErrorSummary("")).toBe("");
  });

  it("4f. isPackLinkUrl 只认 https 直链 .js（允许 ?query）", () => {
    expect(isPackLinkUrl("https://cdn.example/play-bundle.js")).toBe(true);
    expect(isPackLinkUrl("https://cdn.example/a/play-bundle.js?v=2")).toBe(true);
    expect(isPackLinkUrl("  https://cdn.example/x.JS  ")).toBe(true);
    expect(isPackLinkUrl("http://cdn.example/play-bundle.js")).toBe(false);
    expect(isPackLinkUrl("https://cdn.example/play-bundle.jsp")).toBe(false);
    expect(isPackLinkUrl("看看这个 https://cdn.example/play-bundle.js")).toBe(false);
    expect(isPackLinkUrl("")).toBe(false);
  });
});

describe("source-update IPC 包装（v3）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("5. activateSourcePack 透传 packId + kind（空串 = 切回内置基线）", async () => {
    const spy = vi.spyOn(ipc, "sourceActivatePack").mockResolvedValue(undefined);
    await activateSourcePack("", "meta");
    await activateSourcePack("play-official", "play");
    await activateSourcePack("play-official");
    expect(spy).toHaveBeenNthCalledWith(1, "", "meta");
    expect(spy).toHaveBeenNthCalledWith(2, "play-official", "play");
    expect(spy).toHaveBeenNthCalledWith(3, "play-official", undefined);
  });

  it("6. installSourceFromLocalFile 取消（Rust 返回 null）原样返回 null", async () => {
    vi.spyOn(ipc, "sourceInstallLocalFile").mockResolvedValue(null);
    expect(await installSourceFromLocalFile()).toBeNull();
  });

  it("7. installSourceFromLocalFile 成功返回安装结果对象", async () => {
    const outcome = {
      kind: "meta",
      activated: false,
      replaced: false,
      pack: pack({ kind: "meta", id: "meta-official", name: "官方数据包" }),
    };
    vi.spyOn(ipc, "sourceInstallLocalFile").mockResolvedValue(outcome);
    expect(await installSourceFromLocalFile()).toEqual(outcome);
  });

  it("8. stageSourceFromUrl 透传 URL、返回预览对象", async () => {
    const preview = {
      token: "t-1",
      kind: "play",
      id: "play-x",
      name: "X",
      versionCode: 2,
      versionName: "",
      channel: "url",
      reference: "https://cdn.example/x.js",
      signatureVerified: false,
      installedCode: 0,
    };
    const spy = vi.spyOn(ipc, "sourceStageFromUrl").mockResolvedValue(preview);
    expect(await stageSourceFromUrl("https://cdn.example/x.js")).toEqual(preview);
    expect(spy).toHaveBeenCalledWith("https://cdn.example/x.js");
  });

  it("9. stageSourceFromFile 取消返回 null、有文件返回预览", async () => {
    vi.spyOn(ipc, "sourceStageFromFile").mockResolvedValue(null);
    expect(await stageSourceFromFile()).toBeNull();
    const preview = {
      token: "t-2",
      kind: "meta",
      id: "meta-official",
      name: "官方数据包",
      versionCode: 1,
      versionName: "m.1",
      channel: "file",
      reference: "meta-bundle.js",
      signatureVerified: true,
      installedCode: 0,
    };
    vi.spyOn(ipc, "sourceStageFromFile").mockResolvedValue(preview);
    expect(await stageSourceFromFile()).toEqual(preview);
  });

  it("10. installStagedSource 按一次性 token 落盘", async () => {
    const outcome = {
      kind: "play",
      activated: true,
      replaced: false,
      pack: pack(),
    };
    const spy = vi.spyOn(ipc, "sourceInstallStaged").mockResolvedValue(outcome);
    expect(await installStagedSource("t-1")).toEqual(outcome);
    expect(spy).toHaveBeenCalledWith("t-1");
  });
});
