// C03：播放动作必须在取链预解析（最坏 8s）之前向后端登记「这次播放意图」，
// 拿到原生代次票，并把这个**原票**随实际播放 IPC 传回去。
//
// 为什么票要在 preResolve 之前拿：预解析窗口里用户可能按了原生媒体键
// （SMTC / 热键），Native 换了歌但 JS 的 playActionSeq 完全不知道。
// 若等 preResolve 之后才登记，Native 看到的就是「预解析结束后用户才表达了
// 播 A」——旧动作反而成了最新意图。票在入口登记，Native 才能用「登记之后
// 是否又发生过播放意图」来判断这个旧动作是否已过期。
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { resolvePlayUrl } = vi.hoisted(() => ({ resolvePlayUrl: vi.fn() }));
vi.mock("@/lib/quality-fallback", () => ({
  normalizeQualityForSource: (_platform: string, quality: string) => quality,
  peekQualityCeiling: () => null,
  resolvePlayUrlWithFallback: resolvePlayUrl,
}));
vi.mock("@/lib/source-quality", () => ({ sourcePlayQualityOf: () => "320" }));

import { usePlayerStore } from "@/stores/player";
import type { PlaybackState, Track } from "@/types";

function track(id: string, platform: Track["platform"] = "wyy"): Track {
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

beforeEach(() => {
  invoke.mockReset();
  resolvePlayUrl.mockReset();
  resolvePlayUrl.mockResolvedValue({ url: "http://example.test/a.mp3", quality: "320" });
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
  });
});

describe("播放动作的原生代次票", () => {
  it("入口先登记拿到票，再进入预解析；实际入队 IPC 原票传回", async () => {
    const begin = deferred<number>();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "begin_play_intent") return begin.promise;
      if (cmd === "play_queue") return Promise.resolve({ applied: true, target: null });
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    const tracks = [track("a")];

    const pending = usePlayerStore.getState().playQueue(tracks, 0);
    await flush();
    // 票还没回来：预解析不能先跑，否则窗口内原生换歌无法被感知
    expect(invoke).toHaveBeenCalledWith("begin_play_intent");
    expect(resolvePlayUrl).not.toHaveBeenCalled();

    begin.resolve(41);
    await flush();
    expect(resolvePlayUrl).toHaveBeenCalledTimes(1);

    await expect(pending).resolves.toEqual({ applied: true, ticket: expect.any(Number), target: null });
    expect(invoke).toHaveBeenCalledWith("play_queue", {
      tracks,
      startIndex: 0,
      playIntent: 41,
    });
  });

  it("票回来时已被更新的播放动作取代：这次动作早退，不发任何播放 IPC", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    let beginCalls = 0;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "begin_play_intent") {
        beginCalls += 1;
        return beginCalls === 1 ? first.promise : second.promise;
      }
      if (cmd === "play_queue") return Promise.resolve({ applied: true, target: null });
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });

    const a = usePlayerStore.getState().playQueue([track("a")], 0);
    await flush();
    const b = usePlayerStore.getState().playQueue([track("b")], 0);
    await flush();

    second.resolve(42);
    await flush();
    await expect(b).resolves.toMatchObject({ applied: true });

    first.resolve(41);
    await flush();
    await expect(a).resolves.toEqual({ applied: false, ticket: expect.any(Number), target: null });

    const queueCalls = invoke.mock.calls.filter(([cmd]) => cmd === "play_queue");
    expect(queueCalls).toHaveLength(1);
    expect(queueCalls[0]![1]).toMatchObject({
      tracks: [expect.objectContaining({ id: "b" })],
      playIntent: 42,
    });
  });

  it("play：先登记再预解析，原票随 play_track 传回", async () => {
    const begin = deferred<number>();
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "begin_play_intent") return begin.promise;
      if (cmd === "play_track") return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    const song = track("solo");

    const pending = usePlayerStore.getState().play(song);
    await flush();
    expect(invoke).toHaveBeenCalledWith("begin_play_intent");
    expect(resolvePlayUrl).not.toHaveBeenCalled();

    begin.resolve(51);
    await flush();
    expect(resolvePlayUrl).toHaveBeenCalledTimes(1);
    await pending;

    expect(invoke).toHaveBeenCalledWith("play_track", {
      track: song,
      quality: "320",
      playIntent: 51,
    });
  });

  it("playAt / next / previous：同样先登记，票随各自 IPC 传回", async () => {
    let beginCalls = 0;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "begin_play_intent") {
        beginCalls += 1;
        return Promise.resolve(51 + beginCalls);
      }
      if (cmd === "play_at" || cmd === "next" || cmd === "previous") {
        return Promise.resolve(undefined);
      }
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    const queue = [track("a"), track("b")];
    usePlayerStore.setState({
      queue,
      queueIndex: 0,
      state: {
        playMode: "listLoop",
        status: "playing",
      } as unknown as PlaybackState,
    });

    await usePlayerStore.getState().playAt(1);
    await usePlayerStore.getState().nextTrack();
    await usePlayerStore.getState().prevTrack();

    expect(invoke).toHaveBeenCalledWith("play_at", { index: 1, playIntent: 52 });
    expect(invoke).toHaveBeenCalledWith("next", { playIntent: 53 });
    expect(invoke).toHaveBeenCalledWith("previous", { playIntent: 54 });
  });

  // 修正旧规格：此前这里断言「登记失败退化为旧载荷、播放不阻断」——那是按旧
  // mock 便利写的错误假设。前后端同捆绑，PC 后端一定有 begin_play_intent；
  // fail-open 会用无票旧载荷重新打开 preResolve 窗口的 C03 漏洞（原生媒体键
  // 换歌后，晚到的无票动作被 Native 当成最新意图）。正确规格是 fail closed。
  it("登记失败时 fail closed：不发无票的 play_track", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "begin_play_intent") return Promise.reject(new Error("ipc down"));
      if (cmd === "play_track") return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    const song = track("local-song", "local");

    await expect(usePlayerStore.getState().play(song)).resolves.toBeUndefined();
    expect(invoke).not.toHaveBeenCalledWith("play_track", expect.anything());
  });

  it("票回来时已被更新的动作取代：play 早退，不发 play_track", async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    let calls = 0;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "begin_play_intent") {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      }
      if (cmd === "play_track") return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    });
    const songA = track("a", "local");
    const songB = track("b", "local");

    const a = usePlayerStore.getState().play(songA);
    await flush();
    const b = usePlayerStore.getState().play(songB);
    await flush();

    second.resolve(62);
    await flush();
    await b;

    first.resolve(61);
    await flush();
    await a;

    const trackCalls = invoke.mock.calls.filter(([cmd]) => cmd === "play_track");
    expect(trackCalls).toHaveLength(1);
    expect(trackCalls[0]![1]).toMatchObject({
      track: expect.objectContaining({ id: "b" }),
      playIntent: 62,
    });
  });
});
