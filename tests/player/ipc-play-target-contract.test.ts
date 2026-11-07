// C03：播放/暂停/进度 IPC 的可选 Native 目标契约。
//
// 恢复流程要把队列回执里的 PlayTarget 原样带给 seek/pause，让引擎按
// 「代次 + 曲目身份」判断是否还该执行；手动调用不传 target 时必须保持旧
// 载荷（少一个字段都算破坏兼容）。restoreLastSession 的外部协议仍是
// PlaybackState | null，不能改成队列回执。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import * as ipc from "@/services/ipc";
import type { PlaybackState, PlayTarget, Track } from "@/types";

const track: Track = {
  id: "t1",
  platform: "wyy",
  title: "歌曲",
  singer: "歌手",
  album: "专辑",
  picUrl: "",
  duration: 240,
};

const target: PlayTarget = { generation: 73, platform: "wyy", id: "t1" };

function snapshot(): PlaybackState {
  return {
    trackId: "t1",
    sourceId: "wyy",
    status: "playing",
    positionMs: 1_000,
    durationMs: 240_000,
    bufferedMs: 0,
    volume: 0.8,
    muted: false,
    playMode: "listLoop",
    quality: "320",
    queueIndex: 0,
    queueLen: 1,
    isLocal: false,
    urlFetchedAt: null,
    playUrl: null,
    error: null,
    sleepTimerMs: null,
    track,
    outputDevice: "",
    bitrateKbps: null,
    sleepAfterTrack: false,
    speed: 1,
  };
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("C03 播放 IPC 的 Native 目标契约", () => {
  it("play_queue 透传队列参数并原样返回 { applied, target } 回执", async () => {
    const receipt = { applied: true, target };
    invoke.mockResolvedValueOnce(receipt);
    await expect(ipc.playQueue([track], 0)).resolves.toBe(receipt);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("play_queue", { tracks: [track], startIndex: 0 });
  });

  it("seek 无目标时保持旧载荷，带目标时附加 target", async () => {
    await ipc.seek(1_234);
    await ipc.seek(5_678, target);
    expect(invoke.mock.calls).toEqual([
      ["seek", { positionMs: 1_234 }],
      ["seek", { positionMs: 5_678, target }],
    ]);
  });

  it("pause 无目标时保持无参调用，带目标时附加 target", async () => {
    await ipc.pause();
    await ipc.pause(target);
    expect(invoke.mock.calls).toEqual([["pause"], ["pause", { target }]]);
  });

  it("set_speed 无目标时保持旧载荷，带目标时附加 target", async () => {
    await ipc.setSpeed(1.5);
    await ipc.setSpeed(2.0, target);
    expect(invoke.mock.calls).toEqual([
      ["set_speed", { speed: 1.5 }],
      ["set_speed", { speed: 2.0, target }],
    ]);
  });

  it("restore_last_session 仍返回 PlaybackState | null，不改成队列回执", async () => {
    const state = snapshot();
    invoke.mockResolvedValueOnce(state);
    invoke.mockResolvedValueOnce(null);
    await expect(ipc.restoreLastSession()).resolves.toBe(state);
    await expect(ipc.restoreLastSession()).resolves.toBeNull();
    expect(invoke.mock.calls).toEqual([["restore_last_session"], ["restore_last_session"]]);
  });
});
