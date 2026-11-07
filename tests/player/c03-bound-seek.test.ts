// C03：带 Native 目标（回执里的 PlayTarget）的恢复 seek，不能把用户新歌的
// 界面位置改回旧会话的位置。
//
// 场景：JS 播放动作代次没有变化（用户没再点击），但 Native 已经因为 SMTC /
// 热键换了歌 —— 这时旧恢复动作的 seek 带着旧目标的 target 发下去，引擎会
// 忽略它。JS 若仍按「乐观落点」先改 positionMs / pendingSeekMs，用户看到
// 的就是新歌被拖到旧会话的 61 秒；迟到失败还会把新歌自己刚发出的 seek
// 标记清掉。带票据/带目标的调用必须完全不碰界面，只把受约束的 IPC 发出去。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { usePlayerStore } from "@/stores/player";
import type { PlaybackState, PlayTarget, Track } from "@/types";

function track(id: string, platform: Track["platform"] = "local"): Track {
  return {
    id,
    platform,
    title: `歌曲 ${id}`,
    singer: "歌手",
    album: "专辑",
    picUrl: "",
    duration: 240,
  };
}

function snapshot(t: Track, positionMs: number): PlaybackState {
  return {
    trackId: t.id,
    sourceId: t.platform,
    status: "playing",
    positionMs,
    durationMs: 240_000,
    bufferedMs: 0,
    volume: 0.8,
    muted: false,
    playMode: "listLoop",
    quality: "320",
    queueIndex: 0,
    queueLen: 1,
    isLocal: true,
    urlFetchedAt: null,
    playUrl: null,
    error: null,
    sleepTimerMs: null,
    track: t,
    outputDevice: "",
    bitrateKbps: null,
    sleepAfterTrack: false,
    speed: 1,
  };
}

const oldSession = track("old-session");
const newChoice = track("new-choice");

/** 原生已经提交的队列目标：代次 + 跨源身份（与 Rust PlayTarget 对齐） */
const oldTarget: PlayTarget = { generation: 73, platform: "local", id: oldSession.id };

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "begin_play_intent") return 99;
    if (cmd === "play_queue") return { applied: true, target: oldTarget };
    return undefined;
  });
  usePlayerStore.setState({
    state: null,
    positionMs: 0,
    durationMs: 0,
    bufferedMs: 0,
    queue: [],
    queueIndex: null,
    pendingSeekMs: null,
    pendingSeekAt: 0,
    positionAnchorMs: 0,
    positionAnchorValue: 0,
    isDraggingProgress: false,
    embeddedCover: "",
    embeddedCoverTrack: "",
  });
});

describe("C03 带 Native 目标的 bound seek", () => {
  it("Native 已播新歌且 JS 代次未变时，被引擎忽略的恢复 seek 不改新歌界面位置", async () => {
    const action = await usePlayerStore.getState().playQueue([oldSession], 0);
    expect(action).toEqual({
      applied: true,
      ticket: expect.any(Number),
      target: oldTarget,
    });

    // Native 因 SMTC / 热键换了歌；JS 侧没有新的点击，播放动作代次没变。
    usePlayerStore.setState({
      state: snapshot(newChoice, 2_000),
      positionMs: 2_000,
      pendingSeekMs: null,
      pendingSeekAt: 0,
    });

    // 恢复流程把旧会话的 61 秒 seek 发下去：引擎按旧目标忽略，IPC 本身成功。
    invoke.mockResolvedValueOnce(undefined);
    expect(
      await usePlayerStore.getState().seekTo(61_000, action.ticket, action.target),
    ).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("seek", {
      positionMs: 61_000,
      target: oldTarget,
    });

    const after = usePlayerStore.getState();
    expect(after.positionMs).toBe(2_000);
    expect(after.pendingSeekMs).toBeNull();
    expect(after.pendingSeekAt).toBe(0);
    expect(after.state?.trackId).toBe(newChoice.id);
    expect(after.state?.positionMs).toBe(2_000);
  });

  it("bound seek 迟到失败不清掉新歌自己刚发出的 pendingSeek", async () => {
    const action = await usePlayerStore.getState().playQueue([oldSession], 0);
    usePlayerStore.setState({
      state: snapshot(newChoice, 2_000),
      positionMs: 2_000,
      pendingSeekMs: null,
      pendingSeekAt: 0,
    });

    let rejectSeek: (err: Error) => void = () => {};
    invoke.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSeek = reject;
        }),
    );
    const pending = usePlayerStore
      .getState()
      .seekTo(61_000, action.ticket, action.target);
    // 新歌自己的 seek 在旧恢复 seek 返回前发出，写入了新的 pending 标记。
    const newPendingAt = performance.now();
    usePlayerStore.setState({ pendingSeekMs: 3_000, pendingSeekAt: newPendingAt });

    rejectSeek(new Error("seek failed"));
    await expect(pending).rejects.toThrow("seek failed");

    const after = usePlayerStore.getState();
    expect(after.pendingSeekMs).toBe(3_000);
    expect(after.pendingSeekAt).toBe(newPendingAt);
    expect(after.positionMs).toBe(2_000);
  });
});
