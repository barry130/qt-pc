import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CrossSourceHit } from "@/lib/localOnline";
import type { Lyric, PlaybackState, Track } from "@/types";

const boundary = vi.hoisted(() => ({
  events: new Map<string, () => void>(),
  cached: new Set<(track: Track, cross: CrossSourceHit | null, lyric: Lyric) => void>(),
  entries: new Map<string, Promise<Lyric>>(),
  cross: null as CrossSourceHit | null,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: () => void) => {
    boundary.events.set(name, callback);
    return () => { boundary.events.delete(name); };
  }),
  emit: vi.fn(async () => {}),
  emitTo: vi.fn(async () => {}),
}));
vi.mock("@/lib/localOnline", () => ({
  crossSourceForPlayback: vi.fn(() => boundary.cross),
  playbackLyricKey: (track: Track, cross: CrossSourceHit | null = null) =>
    `${track.platform}:${track.id}:${cross?.target ?? ""}:${cross?.song?.id ?? ""}`,
  onPlaybackLyricCached: vi.fn((callback: (track: Track, cross: CrossSourceHit | null, lyric: Lyric) => void) => {
    boundary.cached.add(callback);
    return () => { boundary.cached.delete(callback); };
  }),
  peekCachedPlaybackLyric: vi.fn((track: Track, cross: CrossSourceHit | null = null) =>
    boundary.entries.get(`${track.platform}:${track.id}:${cross?.target ?? ""}:${cross?.song?.id ?? ""}`)),
  getPlaybackLyric: vi.fn(),
}));

import { emitTo, listen } from "@tauri-apps/api/event";
import { getPlaybackLyric, peekCachedPlaybackLyric } from "@/lib/localOnline";
import { publishPlaybackLyric, requestPlaybackLyric } from "@/lib/playback-lyric-sync";
import { startPlaybackLyricBroadcast } from "@/hooks/usePlaybackLyricBroadcast";
import { usePlayerStore as player } from "@/stores/player";

const song = (id: string, platform = "wyy"): Track => ({
  id, platform, title: "红豆", singer: "测试歌手", album: "", picUrl: "", duration: 240,
});
const lyric: Lyric = { lrc: "[00:41.00]走过荒芜的沙丘", translation: "" };
let stop: (() => void) | undefined;
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function play(track: Track | null, quality = "320"): void {
  player.setState({ state: { status: "playing", track, quality } as PlaybackState });
}
function cache(track: Track, cross: CrossSourceHit | null, value = lyric): void {
  for (const listener of boundary.cached) listener(track, cross, value);
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  boundary.events.clear(); boundary.cached.clear(); boundary.entries.clear(); boundary.cross = null;
  player.setState({ state: null });
});
afterEach(async () => { stop?.(); stop = undefined; await flush(); });

it("主缓存成功更新只把当前曲目与当前来源的正文发给桌面，不跟随进度重复广播", async () => {
  play(song("A"));
  stop = startPlaybackLyricBroadcast();
  await flush();
  cache(song("old"), null);
  expect(emitTo).not.toHaveBeenCalled();
  cache(song("A"), null);
  expect(emitTo).toHaveBeenCalledExactlyOnceWith("lyrics", "playback-lyric-updated", {
    trackId: "wyy:A", lyricKey: "wyy:A::", lyric,
  });
  vi.mocked(emitTo).mockClear();
  player.setState({ positionAnchorValue: 42000 });
  expect(emitTo).not.toHaveBeenCalled();
  expect(getPlaybackLyric).not.toHaveBeenCalled();
});

it.each(["track", "source"])("补发等待期间%s改变时，旧正文晚到也不发给桌面", async (change) => {
  const pending = deferred<Lyric>();
  boundary.entries.set("wyy:A::", pending.promise);
  play(song("A"));
  stop = startPlaybackLyricBroadcast();
  await flush();
  boundary.events.get("request-playback-lyric")?.();
  if (change === "track") play(song("B"));
  else boundary.cross = { target: "kw", song: song("match", "kw") };
  pending.resolve(lyric);
  await flush();
  expect(emitTo).not.toHaveBeenCalled();
  expect(getPlaybackLyric).not.toHaveBeenCalled();
});

it("挂载与切歌换源只补发预热缓存，旧源通知与播客不串入歌曲歌词", async () => {
  boundary.entries.set("wyy:A::", Promise.resolve(lyric));
  const second = { lrc: "[00:41.00]第二首的歌词", translation: "" };
  boundary.entries.set("wyy:B::", Promise.resolve(second));
  play(song("A"));
  stop = startPlaybackLyricBroadcast();
  await flush();
  expect(emitTo).toHaveBeenCalledExactlyOnceWith("lyrics", "playback-lyric-updated", {
    trackId: "wyy:A", lyricKey: "wyy:A::", lyric,
  });
  vi.mocked(emitTo).mockClear();
  play(song("B"));
  await flush();
  expect(emitTo).toHaveBeenCalledExactlyOnceWith("lyrics", "playback-lyric-updated", {
    trackId: "wyy:B", lyricKey: "wyy:B::", lyric: second,
  });
  vi.mocked(emitTo).mockClear();
  boundary.cross = { target: "kw", song: song("match", "kw") };
  boundary.entries.set("wyy:B:kw:match", Promise.resolve(lyric));
  play(song("B"), "flac");
  await flush();
  expect(emitTo).toHaveBeenCalledExactlyOnceWith("lyrics", "playback-lyric-updated", {
    trackId: "wyy:B", lyricKey: "wyy:B:kw:match", lyric,
  });
  vi.mocked(emitTo).mockClear();
  cache(song("B"), null);
  play(song("episode", "podcast"));
  cache(song("episode", "podcast"), null);
  await flush();
  expect(emitTo).not.toHaveBeenCalled();
  expect(getPlaybackLyric).not.toHaveBeenCalled();
});

it("卸载清掉缓存与请求订阅，已排队回调、缓存结果和player更新均不再发正文", async () => {
  const pending = deferred<Lyric>();
  play(song("A"));
  boundary.entries.set("wyy:A::", pending.promise);
  stop = startPlaybackLyricBroadcast();
  await flush();
  const request = boundary.events.get("request-playback-lyric");
  const cachedCallback = [...boundary.cached][0];
  request?.();
  stop(); stop = undefined;
  expect(boundary.events.size).toBe(0);
  expect(boundary.cached.size).toBe(0);
  vi.mocked(peekCachedPlaybackLyric).mockClear();
  cachedCallback(song("A"), null, lyric);
  request?.();
  play(song("B"));
  pending.resolve(lyric);
  await flush();
  expect(peekCachedPlaybackLyric).not.toHaveBeenCalled();
  expect(emitTo).not.toHaveBeenCalled();
});

it("异步listen在卸载后完成时立即解绑，不留下StrictMode的旧监听", async () => {
  const registration = deferred<() => void>();
  const off = vi.fn();
  vi.mocked(listen).mockReturnValueOnce(registration.promise);
  stop = startPlaybackLyricBroadcast();
  stop(); stop = undefined;
  registration.resolve(off);
  await flush();
  expect(off).toHaveBeenCalledTimes(1);
  expect(boundary.cached.size).toBe(0);
  expect(emitTo).not.toHaveBeenCalled();
});

it("事件投递失败与已有缓存失败不影响播放，也不启动新取词", async () => {
  const snapshot = { trackId: "wyy:A", lyricKey: "wyy:A::", lyric };
  requestPlaybackLyric();
  expect(emitTo).toHaveBeenLastCalledWith("main", "request-playback-lyric");
  vi.mocked(emitTo).mockImplementationOnce(() => { throw new Error("no native bus"); });
  expect(() => publishPlaybackLyric(snapshot)).not.toThrow();
  vi.mocked(emitTo).mockRejectedValueOnce(new Error("desktop closed"));
  publishPlaybackLyric(snapshot);
  vi.mocked(emitTo).mockImplementationOnce(() => { throw new Error("no native bus"); });
  expect(requestPlaybackLyric).not.toThrow();
  vi.mocked(emitTo).mockRejectedValueOnce(new Error("main closed"));
  requestPlaybackLyric();
  play(song("A"));
  boundary.entries.set("wyy:A::", Promise.reject(new Error("existing lyric request failed")));
  vi.mocked(listen).mockRejectedValueOnce(new Error("event listener failed"));
  stop = startPlaybackLyricBroadcast();
  await flush();
  expect(getPlaybackLyric).not.toHaveBeenCalled();
});

it("同一曲目的缓存已换成新词时，旧补发Promise晚到不会盖回去", async () => {
  const pending = deferred<Lyric>();
  play(song("A"));
  boundary.entries.set("wyy:A::", pending.promise);
  stop = startPlaybackLyricBroadcast();
  await flush();
  boundary.events.get("request-playback-lyric")?.();
  const picked = { lrc: "[00:41.00]手动选中的新歌词", translation: "" };
  boundary.entries.set("wyy:A::", Promise.resolve(picked));
  cache(song("A"), null, picked);
  expect(emitTo).toHaveBeenCalledExactlyOnceWith("lyrics", "playback-lyric-updated", {
    trackId: "wyy:A", lyricKey: "wyy:A::", lyric: picked,
  });
  vi.mocked(emitTo).mockClear();
  pending.resolve(lyric);
  await flush();
  expect(emitTo).not.toHaveBeenCalled();
});

it("桌面打开后仅从已有缓存补发同一份歌词，缓存未命中也不启动额外网络", async () => {
  play(song("A"));
  stop = startPlaybackLyricBroadcast();
  await flush();
  const request = boundary.events.get("request-playback-lyric");
  expect(request).toBeTypeOf("function");
  request?.();
  await flush();
  expect(emitTo).not.toHaveBeenCalled();
  boundary.entries.set("wyy:A::", Promise.resolve(lyric));
  request?.();
  await flush();
  expect(emitTo).toHaveBeenCalledExactlyOnceWith("lyrics", "playback-lyric-updated", {
    trackId: "wyy:A", lyricKey: "wyy:A::", lyric,
  });
  expect(getPlaybackLyric).not.toHaveBeenCalled();
});
