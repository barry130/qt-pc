// 单曲播放语义回归：点某一首 = 「加入播放列表并播放」，不清空正在排队的列表。
// 队列增删由 Rust 引擎线程原子完成，前端只发 play_track 并镜像 queue-changed。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => (cmd === "begin_play_intent" ? 1 : {})),
}));

// preResolvePlayUrl 会按降档阶梯走共享脚本包取链，测试里不需要真取（且会拖慢/发网络）。
// 阶梯本身在 @/lib/quality-fallback 里，连同它的重试循环一起 mock 掉，
// 才能精确控制「取链挂住多久」这个弱网窗口。
vi.mock("@/lib/quality-fallback", () => ({
  // preResolvePlayUrl 会先查这张专辑的档位上限决定要不要弹降档提示；
  // 这里返回 null（没有结论）＝每次都按「首次降档」走提示分支。
  peekQualityCeiling: vi.fn(() => null),
  // v11 档位归一：本测试不涉及官方清单，恒原样返回
  normalizeQualityForSource: vi.fn((_platform: string, wanted: string) => wanted),
  resolvePlayUrlWithFallback: vi.fn(async () => ({
    url: "",
    stalled: false,
    referer: "",
    size: null,
    actualQuality: "",
    quality: "",
  })),
}));

import { invoke } from "@tauri-apps/api/core";
import { usePlayerStore } from "@/stores/player";
import type { Track } from "@/types";

const invokeMock = vi.mocked(invoke);

const track: Track = {
  id: "t1",
  platform: "kw",
  title: "晴天",
  singer: "周杰伦",
  album: "",
  picUrl: "",
  duration: 200,
};

beforeEach(() => {
  usePlayerStore.setState({
    state: null,
    positionMs: 0,
    durationMs: 0,
    bufferedMs: 0,
    queue: [],
    queueIndex: null,
    positionAnchorMs: 0,
    positionAnchorValue: 0,
    isDraggingProgress: false,
    pendingSeekMs: null,
    pendingSeekAt: 0,
  });
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) =>
    cmd === "begin_play_intent" ? 1 : {},
  );
});

describe("单曲播放（play）", () => {
  it("发 play_track 而不是 play_queue，不清空播放列表", async () => {
    await usePlayerStore.getState().play(track);

    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds).toContain("play_track");
    // 关键回归点：以前这里是 play_queue([track], 0)，会把整张列表冲掉
    expect(cmds).not.toContain("play_queue");

    const playCall = invokeMock.mock.calls.find(([cmd]) => cmd === "play_track") as
      | [string, Record<string, unknown>]
      | undefined;
    expect(playCall).toBeDefined();
    expect((playCall![1].track as Track).id).toBe("t1");
  });

  it("quality 取当前快照默认档位，缺快照时回落 320", async () => {
    await usePlayerStore.getState().play(track);
    const playCall = invokeMock.mock.calls.find(([cmd]) => cmd === "play_track") as
      | [string, Record<string, unknown>]
      | undefined;
    expect(playCall?.[1].quality).toBe("320");
  });

  it("不动前端镜像队列：等 queue-changed 事件，避免追加后下标算错", async () => {
    usePlayerStore.setState({ queue: [{ ...track, id: "keep" }], queueIndex: 0 });

    await usePlayerStore.getState().play(track);

    const s = usePlayerStore.getState();
    expect(s.queue.map((t) => t.id)).toEqual(["keep"]);
    expect(s.queueIndex).toBe(0);
  });

  it("被更晚的播放动作超越时不发 IPC（最后一次点击获胜）", async () => {
    // 挂住第一次取链，模拟弱网下点歌 A 的 8s 窗口
    const fallback = await import("@/lib/quality-fallback");
    let release: () => void = () => {};
    vi.mocked(fallback.resolvePlayUrlWithFallback).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              url: "",
              stalled: false,
              referer: "",
              size: null,
              actualQuality: "",
              quality: "",
            });
        }),
    );

    const slow = usePlayerStore.getState().play(track);
    const fast = usePlayerStore.getState().play({ ...track, id: "t2" });
    // 先让两个动作都完成「登记 → 进入取链」，再放行挂住的取链
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    release();
    await Promise.all([slow, fast]);

    // 只有后点的 t2 落地
    const ids = invokeMock.mock.calls
      .filter(([cmd]) => cmd === "play_track")
      .map(([, args]) => ((args as Record<string, unknown>).track as Track).id);
    expect(ids).toEqual(["t2"]);
  });
});
