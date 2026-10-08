/**
 * 播放条按钮开关（lib/player-bar.ts + stores/playerBar.ts）。
 *
 * 覆盖四件事：脏数据不能把播放条搞空（解析兜底退默认集）、白名单清洗
 * （未知 id / 重复 id / 超名额截断）、左右分列按声明顺序对半分且音量固定
 * 最右、名额上限（除音量外 10 个）与开关落盘回滚。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/ipc", () => ({
  getSetting: vi.fn(async () => '["collect","mode","queue"]'),
  setSetting: vi.fn(async () => {}),
}));

import {
  PLAYER_BAR_BUTTONS,
  PLAYER_BAR_DEFAULT_VISIBLE,
  PLAYER_BAR_MAX_VISIBLE,
  countPlayerBarVisible,
  parseVisibleButtons,
  playerBarButtonMeta,
  serializeVisibleButtons,
  splitPlayerBarButtons,
} from "@/lib/player-bar";
import { PLAYER_BAR_VISIBLE_KEY, usePlayerBarStore } from "@/stores/playerBar";
import { getSetting, setSetting } from "@/services/ipc";

/** 声明顺序 = 播放条的左右分列顺序；音量（slot:"end"）不参与分列 */
const ALL = PLAYER_BAR_BUTTONS.map((b) => b.id);
const INLINE = PLAYER_BAR_BUTTONS.filter((b) => b.slot === "inline").map((b) => b.id);

describe("播放条按钮：默认集与名额口径", () => {
  it("默认集 = 收藏/播放模式/桌面歌词/下载/音质/音量", () => {
    expect(PLAYER_BAR_DEFAULT_VISIBLE).toEqual([
      "collect",
      "mode",
      "desktopLyric",
      "download",
      "quality",
      "volume",
    ]);
    expect(parseVisibleButtons(null)).toEqual(PLAYER_BAR_DEFAULT_VISIBLE);
  });

  it("歌手按钮在白名单里，默认关闭（新按钮不打扰老用户）", () => {
    expect(playerBarButtonMeta("artist")).not.toBeNull();
    expect(playerBarButtonMeta("artist")?.slot).toBe("inline");
    expect(PLAYER_BAR_DEFAULT_VISIBLE).not.toContain("artist");
  });

  it("音量不占 inline 名额，名额上限为 10", () => {
    expect(PLAYER_BAR_MAX_VISIBLE).toBe(10);
    expect(PLAYER_BAR_BUTTONS.filter((b) => b.slot === "end").map((b) => b.id)).toEqual([
      "volume",
    ]);
    expect(countPlayerBarVisible(PLAYER_BAR_DEFAULT_VISIBLE)).toBe(5);
    expect(countPlayerBarVisible([...PLAYER_BAR_DEFAULT_VISIBLE, "volume"])).toBe(5);
  });
});

describe("播放条按钮：解析设置值（可见白名单）", () => {
  it("非字符串 / 坏 JSON / 非数组一律按默认集", () => {
    expect(parseVisibleButtons(undefined)).toEqual(PLAYER_BAR_DEFAULT_VISIBLE);
    expect(parseVisibleButtons(42)).toEqual(PLAYER_BAR_DEFAULT_VISIBLE);
    expect(parseVisibleButtons("{oops")).toEqual(PLAYER_BAR_DEFAULT_VISIBLE);
    expect(parseVisibleButtons('{"queue":true}')).toEqual(PLAYER_BAR_DEFAULT_VISIBLE);
    expect(parseVisibleButtons("")).toEqual(PLAYER_BAR_DEFAULT_VISIBLE);
  });

  it("空数组 = 用户全关了，照用不兜底", () => {
    expect(parseVisibleButtons("[]")).toEqual([]);
  });

  it("只留下认得的 id，去重，超名额截断（音量不计入）", () => {
    expect(parseVisibleButtons('["queue","nope","queue",5,null]')).toEqual(["queue"]);
    expect(serializeVisibleButtons(["queue", "nope"])).toBe('["queue"]');

    const full = [...INLINE.slice(0, PLAYER_BAR_MAX_VISIBLE + 2), "volume"];
    const parsed = parseVisibleButtons(JSON.stringify(full));
    expect(countPlayerBarVisible(parsed)).toBe(PLAYER_BAR_MAX_VISIBLE);
    expect(parsed).toContain("volume");
    // 截断按声明顺序保留靠前的
    expect(parsed.filter((id) => id !== "volume")).toEqual(INLINE.slice(0, PLAYER_BAR_MAX_VISIBLE));
  });
});

describe("播放条按钮：左右分列", () => {
  it("音量固定在播放条最右侧，不参与分列", () => {
    const { left, right } = splitPlayerBarButtons(ALL);
    expect([...left, ...right]).not.toContain("volume");
  });

  it("按声明顺序对半分，任何组合下两侧条数差都不超过 1（播放键居中）", () => {
    for (let n = 0; n <= INLINE.length; n++) {
      const { left, right } = splitPlayerBarButtons(INLINE.slice(0, n));
      expect(left).toEqual(INLINE.slice(0, Math.ceil(n / 2)));
      expect(right).toEqual(INLINE.slice(Math.ceil(n / 2), n));
      expect(Math.abs(left.length - right.length)).toBeLessThanOrEqual(1);
    }
  });

  it("默认集下左 3 / 右 2", () => {
    const { left, right } = splitPlayerBarButtons(PLAYER_BAR_DEFAULT_VISIBLE);
    expect(left).toEqual(["collect", "mode", "desktopLyric"]);
    expect(right).toEqual(["download", "quality"]);
  });
});

describe("播放条按钮：读写设置", () => {
  it("load 读一次设置，toggle 乐观更新并落盘，重复 load 不再打 IPC", async () => {
    await usePlayerBarStore.getState().load();
    expect(usePlayerBarStore.getState().visible).toEqual(["collect", "mode", "queue"]);
    expect(usePlayerBarStore.getState().loaded).toBe(true);

    expect(usePlayerBarStore.getState().toggle("queue")).toBe(true);
    expect(usePlayerBarStore.getState().visible).toEqual(["collect", "mode"]);
    expect(setSetting).toHaveBeenCalledWith(PLAYER_BAR_VISIBLE_KEY, '["collect","mode"]');

    await usePlayerBarStore.getState().load();
    expect(getSetting).toHaveBeenCalledTimes(1);
  });

  it("名额已满时拒绝开启并返回 false，关掉永远成功", async () => {
    usePlayerBarStore.setState({ visible: [], loaded: false });
    vi.mocked(getSetting).mockResolvedValueOnce(
      JSON.stringify(INLINE.slice(0, PLAYER_BAR_MAX_VISIBLE)),
    );
    const store = usePlayerBarStore.getState();
    await store.load();
    expect(countPlayerBarVisible(usePlayerBarStore.getState().visible)).toBe(
      PLAYER_BAR_MAX_VISIBLE,
    );

    const nextInline = INLINE[PLAYER_BAR_MAX_VISIBLE];
    expect(store.toggle(nextInline)).toBe(false);
    expect(usePlayerBarStore.getState().visible).not.toContain(nextInline);
    expect(setSetting).not.toHaveBeenCalledWith(PLAYER_BAR_VISIBLE_KEY, expect.stringContaining(nextInline));

    // 音量不占名额，满了也能开
    expect(store.toggle("volume")).toBe(true);
    expect(usePlayerBarStore.getState().visible).toContain("volume");

    // 关掉永远成功
    expect(store.toggle("volume")).toBe(true);
    expect(usePlayerBarStore.getState().visible).not.toContain("volume");
  });

  it("落盘失败回滚，避免界面与磁盘不一致", async () => {
    usePlayerBarStore.setState({ visible: ["collect", "mode"], loaded: true });
    vi.mocked(setSetting).mockRejectedValueOnce(new Error("disk full"));
    expect(usePlayerBarStore.getState().toggle("queue")).toBe(true);
    expect(usePlayerBarStore.getState().visible).toEqual(["collect", "mode", "queue"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(usePlayerBarStore.getState().visible).toEqual(["collect", "mode"]);
  });
});
