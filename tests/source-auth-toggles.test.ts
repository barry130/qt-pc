// 音源账号开关（per-source 化）：核心要守住的是
// 1) 解析链优先级：per-source 表 → 旧全局键（升级继承）→ 双开；
// 2) 开关只影响**该源该面**——关 B 站的播放登录态不能动网易的任何面；
// 3) 坏设置只损失「记住的选择」，绝不让注入整体失效。
// v10 的官方线路档位展示走 lib/source-auth 的播放面登录态判定 +
// stores/sourceRegistry 的档位切换，无独立配置表（2026-10-25 需求澄清后撤除）。
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  store: new Map<string, string>(),
  sets: [] as { scope: "meta" | "play"; source?: string; cookie?: string }[],
  clears: [] as { scope: "meta" | "play"; source?: string }[],
  setThrows: false,
}));

vi.mock("@/services/ipc", () => ({
  getSetting: (key: string) => Promise.resolve(state.store.get(key) ?? null),
  setSetting: (key: string, value: string) => {
    state.store.set(key, value);
    return Promise.resolve();
  },
  SOURCE_META_CHANGED_EVENT: "source-meta-changed",
  SOURCE_PACK_CHANGED_EVENT: "source-pack-changed",
}));

vi.mock("@/source-scripts", () => ({
  authSetCredential: (scope: "meta" | "play", source: string, cookie: string) => {
    if (state.setThrows) return Promise.reject(new Error("engine not ready"));
    state.sets.push({ scope, source, cookie });
    return Promise.resolve();
  },
  authClearCredential: (scope: "meta" | "play", source?: string) => {
    state.clears.push({ scope, source });
    return Promise.resolve();
  },
}));

vi.mock("@/source-engine/client", () => ({
  onEnginePhaseChange: () => () => undefined,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async () => () => undefined,
}));

import {
  ensureSourceAuthInjected,
  parseSourceAuthToggles,
  readSourceAuthTogglesFor,
  removeSourceAuthAccount,
  resetSourceAuthCaches,
  saveSourceAuthAccount,
  setSourceAuthToggle,
} from "@/lib/source-auth";
import {
  SOURCE_AUTH_ACCOUNTS_KEY,
  SOURCE_AUTH_TOGGLES_KEY,
  SOURCE_AUTH_USE_META_KEY,
  SOURCE_AUTH_USE_PLAY_KEY,
} from "@/lib/storageKeys";

const USER = {
  id: "1",
  nickname: "测试用户",
  avatar: "",
  vip: false,
  vipLabel: "",
} as const;

function seedAccount(source: string): void {
  const raw = JSON.parse(state.store.get(SOURCE_AUTH_ACCOUNTS_KEY) ?? "{}");
  raw[source] = { cookie: `${source}-cookie`, user: USER, savedAt: "2026-10-24T00:00:00.000Z" };
  state.store.set(SOURCE_AUTH_ACCOUNTS_KEY, JSON.stringify(raw));
}

beforeEach(() => {
  state.store.clear();
  state.sets.length = 0;
  state.clears.length = 0;
  state.setThrows = false;
  resetSourceAuthCaches();
});

describe("parseSourceAuthToggles", () => {
  it("坏输入一律归空表，不抛错", () => {
    expect(parseSourceAuthToggles(null)).toEqual({});
    expect(parseSourceAuthToggles("   ")).toEqual({});
    expect(parseSourceAuthToggles("{{{")).toEqual({});
    expect(parseSourceAuthToggles("[]")).toEqual({});
    expect(parseSourceAuthToggles('"x"')).toEqual({});
  });

  it("形状不对的源条目丢弃，正常条目保留", () => {
    const raw = JSON.stringify({
      bili: { useMeta: true, usePlay: false },
      wyy: { useMeta: "yes", usePlay: true }, // 布尔缺失
      kw: null,
      "bad source!": { useMeta: true, usePlay: true }, // 源名非法
    });
    expect(parseSourceAuthToggles(raw)).toEqual({ bili: { useMeta: true, usePlay: false } });
  });
});

describe("生效开关解析链（per-source 表 → 旧全局键 → 登录态缺省）", () => {
  it("未登录的源 = 双关（v14 口径：没账号谈不上使用登录态）", async () => {
    expect(await readSourceAuthTogglesFor("bili")).toEqual({ useMeta: false, usePlay: false });
  });

  it("已登录但什么都没配置过 = 双开（登录了缺省生效）", async () => {
    seedAccount("bili");
    expect(await readSourceAuthTogglesFor("bili")).toEqual({ useMeta: true, usePlay: true });
  });

  it("旧全局键半配置按原语义继承：缺的那面=关（与升级前 readSourceAuthToggles 完全同口径）", async () => {
    state.store.set(SOURCE_AUTH_USE_META_KEY, "false");
    seedAccount("bili");
    expect(await readSourceAuthTogglesFor("bili")).toEqual({ useMeta: false, usePlay: false });
  });

  it("旧全局键成对写入时整体继承（登录态下）", async () => {
    state.store.set(SOURCE_AUTH_USE_META_KEY, "false");
    state.store.set(SOURCE_AUTH_USE_PLAY_KEY, "true");
    seedAccount("bili");
    expect(await readSourceAuthTogglesFor("bili")).toEqual({ useMeta: false, usePlay: true });
  });

  it("per-source 表优先于旧全局键", async () => {
    state.store.set(SOURCE_AUTH_USE_META_KEY, "false");
    state.store.set(SOURCE_AUTH_USE_PLAY_KEY, "false");
    state.store.set(
      SOURCE_AUTH_TOGGLES_KEY,
      JSON.stringify({ bili: { useMeta: true, usePlay: false } }),
    );
    expect(await readSourceAuthTogglesFor("bili")).toEqual({ useMeta: true, usePlay: false });
    // 未登录的未物化源按 v14 口径双关
    expect(await readSourceAuthTogglesFor("wyy")).toEqual({ useMeta: false, usePlay: false });
  });
});

describe("saveSourceAuthAccount", () => {
  it("首登物化双开并双面注入", async () => {
    await saveSourceAuthAccount("bili", "SESSDATA=fake", USER);
    const map = JSON.parse(state.store.get(SOURCE_AUTH_TOGGLES_KEY) ?? "{}");
    expect(map.bili).toEqual({ useMeta: true, usePlay: true });
    expect(state.sets).toEqual([
      { scope: "meta", source: "bili", cookie: "SESSDATA=fake" },
      { scope: "play", source: "bili", cookie: "SESSDATA=fake" },
    ]);
    expect(state.clears).toEqual([]);
  });

  it("升级用户全局关着 play 时，新登录的源继承关态（不绕过用户选择）", async () => {
    state.store.set(SOURCE_AUTH_USE_META_KEY, "true");
    state.store.set(SOURCE_AUTH_USE_PLAY_KEY, "false");
    await saveSourceAuthAccount("bili", "SESSDATA=fake", USER);
    const map = JSON.parse(state.store.get(SOURCE_AUTH_TOGGLES_KEY) ?? "{}");
    expect(map.bili).toEqual({ useMeta: true, usePlay: false });
    expect(state.sets.map((c) => `${c.scope}:${c.source}`)).toEqual(["meta:bili"]);
    expect(state.clears).toContainEqual({ scope: "play", source: "bili" });
  });

  it("已物化的源重新登录不覆盖开关选择", async () => {
    state.store.set(
      SOURCE_AUTH_TOGGLES_KEY,
      JSON.stringify({ bili: { useMeta: false, usePlay: false } }),
    );
    await saveSourceAuthAccount("bili", "SESSDATA=fake", USER);
    const map = JSON.parse(state.store.get(SOURCE_AUTH_TOGGLES_KEY) ?? "{}");
    expect(map.bili).toEqual({ useMeta: false, usePlay: false });
    expect(state.sets).toEqual([]);
    expect(state.clears).toEqual([
      { scope: "meta", source: "bili" },
      { scope: "play", source: "bili" },
    ]);
  });
});

describe("setSourceAuthToggle（按源独立）", () => {
  it("关一个源的 play 面只清单源单面，别的源不动", async () => {
    seedAccount("bili");
    seedAccount("wyy");
    await setSourceAuthToggle("bili", "play", false);
    expect(state.clears).toEqual([{ scope: "play", source: "bili" }]);
    // 只对账被切的源：bili 的 meta 面仍注入；wyy 不在本次动作范围内
    expect(state.sets.map((c) => `${c.scope}:${c.source}`)).toEqual(["meta:bili"]);
    // 开关表里只有 bili 被物化，wyy 留在解析链下一级（旧全局/双开）
    const map = JSON.parse(state.store.get(SOURCE_AUTH_TOGGLES_KEY) ?? "{}");
    expect(map).toEqual({ bili: { useMeta: true, usePlay: false } });
  });

  it("切换把旧全局值一并物化进表（此后旧键不再影响该源）", async () => {
    state.store.set(SOURCE_AUTH_USE_META_KEY, "false");
    state.store.set(SOURCE_AUTH_USE_PLAY_KEY, "true");
    seedAccount("bili");
    await setSourceAuthToggle("bili", "play", false);
    const map = JSON.parse(state.store.get(SOURCE_AUTH_TOGGLES_KEY) ?? "{}");
    expect(map.bili).toEqual({ useMeta: false, usePlay: false });
  });

  it("值没变化时短路：不写库不注入", async () => {
    state.store.set(
      SOURCE_AUTH_TOGGLES_KEY,
      JSON.stringify({ bili: { useMeta: true, usePlay: true } }),
    );
    seedAccount("bili");
    await setSourceAuthToggle("bili", "meta", true);
    expect(state.sets).toEqual([]);
    expect(state.clears).toEqual([]);
  });
});

describe("退出登录 / 全量对账", () => {
  it("退出只清该源两面，开关选择保留", async () => {
    seedAccount("bili");
    seedAccount("wyy");
    state.store.set(
      SOURCE_AUTH_TOGGLES_KEY,
      JSON.stringify({ bili: { useMeta: false, usePlay: true } }),
    );
    await removeSourceAuthAccount("bili");
    expect(state.clears).toEqual([
      { scope: "meta", source: "bili" },
      { scope: "play", source: "bili" },
    ]);
    expect(JSON.parse(state.store.get(SOURCE_AUTH_TOGGLES_KEY) ?? "{}").bili).toEqual({
      useMeta: false,
      usePlay: true,
    });
  });

  it("ensureSourceAuthInjected 按源逐面对账：关的面显式清，引擎炸了整轮吞掉", async () => {
    seedAccount("bili"); // 双开
    seedAccount("wyy"); // meta 关
    state.store.set(
      SOURCE_AUTH_TOGGLES_KEY,
      JSON.stringify({ wyy: { useMeta: false, usePlay: true } }),
    );
    await ensureSourceAuthInjected();
    expect(state.sets.map((c) => `${c.scope}:${c.source}`).sort()).toEqual([
      "meta:bili",
      "play:bili",
      "play:wyy",
    ]);
    expect(state.clears).toEqual([{ scope: "meta", source: "wyy" }]);

    state.setThrows = true;
    state.sets.length = 0;
    await expect(ensureSourceAuthInjected()).resolves.toBeUndefined();
    expect(state.sets).toEqual([]);
  });
});

