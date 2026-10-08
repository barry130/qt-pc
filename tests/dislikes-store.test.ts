// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DislikeRule, Track } from "@/types";

const listDislikes = vi.fn<() => Promise<DislikeRule[]>>();
const addDislikeSong = vi.fn<(t: Track) => Promise<number>>();
const addDislikeSinger = vi.fn<(s: string) => Promise<number[]>>();
const removeDislikeSinger = vi.fn<(s: string) => Promise<number>>();
const removeDislikeRule = vi.fn<(id: number) => Promise<boolean>>();
const clearDislikes = vi.fn<() => Promise<void>>();

vi.mock("@/services/ipc", () => ({
  listDislikes: (...a: unknown[]) => listDislikes(...(a as [])),
  addDislikeSong: (...a: unknown[]) => addDislikeSong(...(a as [Track])),
  addDislikeSinger: (...a: unknown[]) => addDislikeSinger(...(a as [string])),
  removeDislikeSinger: (...a: unknown[]) => removeDislikeSinger(...(a as [string])),
  removeDislikeRule: (...a: unknown[]) => removeDislikeRule(...(a as [number])),
  clearDislikes: () => clearDislikes(),
}));

import { useDislikesStore } from "@/stores/dislikes";

function track(title: string, singer: string): Track {
  return {
    id: `id-${title}`,
    platform: "wyy",
    title,
    singer,
    album: "",
    picUrl: "",
    duration: 210,
  };
}

function rule(id: number, nameRaw: string, singerRaw: string): DislikeRule {
  return {
    id,
    kind: "song",
    name: nameRaw,
    nameRaw,
    singer: singerRaw,
    singerRaw,
    createdAt: id,
  };
}

/** 歌手规则：name 是归一化键，nameRaw 是用户写的原文（Rust 侧 V12 之后的存法） */
function singerRule(id: number, name: string, nameRaw: string): DislikeRule {
  return {
    id,
    kind: "singer",
    name,
    nameRaw,
    singer: "",
    singerRaw: "",
    createdAt: id,
  };
}

describe("dislikes store", () => {
  beforeEach(() => {
    listDislikes.mockReset();
    addDislikeSong.mockReset();
    addDislikeSinger.mockReset();
    removeDislikeSinger.mockReset();
    removeDislikeRule.mockReset();
    clearDislikes.mockReset();
    listDislikes.mockResolvedValue([]);
    addDislikeSong.mockResolvedValue(7);
    addDislikeSinger.mockResolvedValue([9, 10]);
    removeDislikeSinger.mockResolvedValue(2);
    removeDislikeRule.mockResolvedValue(true);
    clearDislikes.mockResolvedValue(undefined);
    useDislikesStore.setState({
      rules: [],
      loaded: false,
      version: 0,
      songRuleIds: {},
      singerRuleIds: {},
    });
  });

  it("refresh 拉到规则并推进 version（行判定据此重查）", async () => {
    await useDislikesStore.getState().refresh();
    expect(useDislikesStore.getState().loaded).toBe(true);
    expect(useDislikesStore.getState().version).toBe(1);

    listDislikes.mockResolvedValue([rule(1, "稻香", "周杰伦")]);
    await useDislikesStore.getState().refresh();
    expect(useDislikesStore.getState().rules).toHaveLength(1);
    expect(useDislikesStore.getState().version).toBe(2);
  });

  it("refresh 失败时只是标记 loaded，不丢既有规则", async () => {
    listDislikes.mockResolvedValue([rule(1, "稻香", "周杰伦")]);
    await useDislikesStore.getState().refresh();
    listDislikes.mockRejectedValue(new Error("db down"));
    await expect(useDislikesStore.getState().refresh()).resolves.toBeUndefined();
    expect(useDislikesStore.getState().loaded).toBe(true);
    expect(useDislikesStore.getState().rules).toHaveLength(1);
  });

  it("banSong 记住规则 id 并刷新；id=0 视为没生效", async () => {
    const t = track("稻香", "周杰伦");
    const ok = await useDislikesStore.getState().banSong(t);
    expect(ok).toBe(true);
    expect(addDislikeSong).toHaveBeenCalledWith(t);
    expect(useDislikesStore.getState().ruleIdForSong(t)).toBe(7);

    addDislikeSong.mockResolvedValue(0);
    expect(await useDislikesStore.getState().banSong(track("空歌名", "x"))).toBe(false);
  });

  it("unbanSong 就地删掉并忘掉那个 id", async () => {
    const t = track("稻香", "周杰伦");
    await useDislikesStore.getState().banSong(t);
    expect(await useDislikesStore.getState().unbanSong(t)).toBe(true);
    expect(removeDislikeRule).toHaveBeenCalledWith(7);
    expect(useDislikesStore.getState().ruleIdForSong(t)).toBeNull();
  });

  it("重启后靠原文回查规则 id（内存记账丢了也能取消）", async () => {
    const t = track("稻香", "周杰伦");
    // 模拟冷启动：只有库里拉回来的规则，没有本会话的 id 记账
    useDislikesStore.setState({ rules: [rule(42, "稻香", "周杰伦")] });
    expect(useDislikesStore.getState().ruleIdForSong(t)).toBe(42);
    // 歌手对不上时不认这条规则（同名不同歌手不该被误取消）
    expect(useDislikesStore.getState().ruleIdForSong(track("稻香", "八三夭"))).toBeNull();
  });

  it("unbanSong 查不到规则时报 false（交给设置页兜底）", async () => {
    listDislikes.mockResolvedValue([]);
    await useDislikesStore.getState().refresh();
    expect(await useDislikesStore.getState().unbanSong(track("没影的歌", "x"))).toBe(false);
    expect(removeDislikeRule).not.toHaveBeenCalled();
  });

  it("clearAll 同时清掉本地 id 记账", async () => {
    const t = track("稻香", "周杰伦");
    await useDislikesStore.getState().banSong(t);
    await useDislikesStore.getState().clearAll();
    expect(clearDislikes).toHaveBeenCalledTimes(1);
    expect(useDislikesStore.getState().songRuleIds).toEqual({});
    expect(useDislikesStore.getState().ruleIdForSong(t)).toBeNull();
  });

  it("banSinger 记住这一串拆出的全部规则 id", async () => {
    await useDislikesStore.getState().banSinger("周杰伦、方文山");
    expect(addDislikeSinger).toHaveBeenCalledWith("周杰伦、方文山");
    // 早先只记一个 id，撤销时会漏掉第二位歌手 → 孤儿规则继续生效
    expect(useDislikesStore.getState().singerRuleIds["周杰伦、方文山"]).toEqual([9, 10]);
    expect(useDislikesStore.getState().singerBanned("周杰伦、方文山")).toBe(true);
  });

  it("unbanSinger 交给 Rust 按整串拆词删，不靠本地 id", async () => {
    await useDislikesStore.getState().banSinger("周杰伦、方文山");
    expect(await useDislikesStore.getState().unbanSinger("周杰伦、方文山")).toBe(true);
    expect(removeDislikeSinger).toHaveBeenCalledWith("周杰伦、方文山");
    expect(useDislikesStore.getState().singerRuleIds["周杰伦、方文山"]).toBeUndefined();

    removeDislikeSinger.mockResolvedValue(0);
    expect(await useDislikesStore.getState().unbanSinger("周杰伦、方文山")).toBe(false);
  });

  it("singerBanned 在冷启动后按原文回查（重启丢掉 id 记账也不误判）", async () => {
    useDislikesStore.setState({
      rules: [singerRule(1, "周杰伦", "周杰伦"), singerRule(2, "taylorswift", "Taylor Swift")],
    });
    expect(useDislikesStore.getState().singerBanned("周杰伦")).toBe(true);
    expect(useDislikesStore.getState().singerBanned("周杰伦、方文山")).toBe(true);
    expect(useDislikesStore.getState().singerBanned("方文山")).toBe(false);
    // 大小写不同也算同一人（name 列存的是归一化键，回显用 nameRaw 比对原文）
    expect(useDislikesStore.getState().singerBanned("Taylor Swift")).toBe(true);
  });

  it("singerBanned 不把歌曲规则误认成歌手规则", async () => {
    useDislikesStore.setState({ rules: [rule(3, "晴天", "周杰伦")] });
    expect(useDislikesStore.getState().singerBanned("周杰伦")).toBe(false);
  });
});
