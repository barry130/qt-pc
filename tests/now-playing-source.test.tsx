// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, within } from "@testing-library/react";
import type { PlaybackState, Track } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/playing" }),
  useRouter: () => ({ history: { canGoBack: () => false, back: vi.fn() } }),
  useRouterState: (opts: { select: (state: { location: { pathname: string } }) => unknown }) => opts.select({ location: { pathname: "/playing" } }),
}));
// Use the real line cache, cross-source decoder, source registry and player store.
// Only lyric IO and unrelated native/animated panels are outside this test's scope.
vi.mock("@/lib/localOnline", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/localOnline")>(),
  getPlaybackLyric: vi.fn(async () => ({ lrc: "", translation: "" })),
}));
vi.mock("@/hooks/useInterpolatedPosition", () => ({ useInterpolatedPosition: () => 0 }));
vi.mock("@/hooks/useNowPlayingLocalMedia", () => ({ useNowPlayingCover: () => null }));
vi.mock("@/components/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("@/components/player/LyricScroller", () => ({ LyricScroller: () => null }));
vi.mock("@/components/podcast/PodcastSubtitles", () => ({ PodcastSubtitles: () => null }));

import { PlayerBar } from "@/components/PlayerBar";
import { PlayingPage } from "@/components/PlayingPage";
import { usePlayerStore } from "@/stores/player";
import { usePlayerBarStore } from "@/stores/playerBar";
import { usePlayingStyleStore } from "@/stores/playingStyle";
import { useSourceRegistryStore } from "@/stores/sourceRegistry";
import { clearPlayUrlLines, mirrorPlayUrlLine, rememberPlayUrlLine } from "@/source-scripts/playurl-line";

const original: Track = { id: "qq-liuli", platform: "qq", title: "琉璃", singer: "曲肖冰", album: "琉璃", picUrl: "", duration: 248 };
const crossLine = { id: "cross:kw", name: "酷我", kind: "cross", targetSong: { id: "kw-liuli", name: "琉璃", singer: "曲肖冰", album: "琉璃", picUrl: "", interval: 248 } };

function snapshot(over: Partial<PlaybackState> = {}): PlaybackState {
  return {
    trackId: original.id, sourceId: original.platform, track: original,
    status: "playing", positionMs: 15000, durationMs: 248000, bufferedMs: 0,
    volume: 0.8, muted: false, playMode: "listLoop", quality: "320", queueIndex: 0, queueLen: 1,
    isLocal: false, urlFetchedAt: null, playUrl: "https://audio.example/qq.mp3", error: null,
    sleepTimerMs: null, sleepAfterTrack: false, speed: 1, outputDevice: "", bitrateKbps: 1718,
    ...over,
  };
}

function renderBoth() {
  return render(<><section data-testid="page"><PlayingPage /></section><section data-testid="bar"><PlayerBar /></section></>);
}

function expectSource(ui: ReturnType<typeof renderBoth>, label: string | null): void {
  for (const id of ["page", "bar"]) {
    const tags = within(ui.getByTestId(id)).queryAllByTitle(/^来源：/);
    expect(tags.map(tag => tag.textContent), id).toEqual(label ? [label] : []);
  }
}

beforeEach(() => {
  clearPlayUrlLines();
  useSourceRegistryStore.setState({
    sources: [
      { id: "qq", name: "QQ音乐", short: "QQ", color: "#12B7F5", searchPageMax: 50 },
      { id: "kw", name: "酷我音乐", short: "酷我", color: "#ff8000", searchPageMax: 50 },
    ], qualities: [], profiles: {}, ready: true, generation: 1,
  });
  usePlayerBarStore.setState({ visible: [], loaded: true });
  usePlayingStyleStore.setState({ style: "classic", loaded: true, backgroundLoaded: true });
  usePlayerStore.setState({ state: snapshot() });
});

describe("顶部与底部的实际播放音源", () => {
  it("QQ跨源播放酷我时两处同步更新，暂停保持，回原源时同步还原", async () => {
    const ui = renderBoth();
    expectSource(ui, "QQ");
    await act(async () => {
      rememberPlayUrlLine(original, "320", crossLine);
      // Same track object and quality: the playback URL itself must invalidate the source.
      usePlayerStore.setState({ state: snapshot({ playUrl: "https://audio.example/kw.mp3" }) });
    });
    expectSource(ui, "酷我");
    expect(usePlayerStore.getState().state?.track).toBe(original);
    await act(async () => { usePlayerStore.setState({ state: snapshot({ status: "paused", playUrl: "https://audio.example/kw.mp3" }) }); });
    expectSource(ui, "酷我");
    await act(async () => {
      rememberPlayUrlLine(original, "320", { id: "qq-direct", name: "QQ", kind: "official", targetSong: null });
      usePlayerStore.setState({ state: snapshot({ playUrl: "https://audio.example/qq-new.mp3" }) });
    });
    expectSource(ui, "QQ");
  });

  it("切歌不串旧线路，显式换成酷我曲目后两处也显示酷我", async () => {
    rememberPlayUrlLine(original, "320", crossLine);
    const ui = renderBoth();
    expectSource(ui, "酷我");
    await act(async () => {
      const next = { ...original, id: "qq-next", title: "下一首" };
      usePlayerStore.setState({ state: snapshot({ track: next, trackId: next.id }) });
    });
    expectSource(ui, "QQ");
    await act(async () => {
      const selected = { ...original, id: "kw-liuli", platform: "kw" };
      usePlayerStore.setState({ state: snapshot({ track: selected, trackId: selected.id, sourceId: "kw" }) });
    });
    expectSource(ui, "酷我");
  });

  it("降档命中的来源按请求档镜像，换音质不会误读另一档位", async () => {
    rememberPlayUrlLine(original, "128", crossLine);
    mirrorPlayUrlLine(original, "128", "320");
    const ui = renderBoth();
    expectSource(ui, "酷我");
    await act(async () => { usePlayerStore.setState({ state: snapshot({ quality: "flac" }) }); });
    expectSource(ui, "QQ");
  });

  it("本地优先和尚未取链时不套用旧在线来源，本地曲目及播客保持原有标记", async () => {
    rememberPlayUrlLine(original, "320", crossLine);
    usePlayerStore.setState({ state: snapshot({ status: "loading", playUrl: null }) });
    const ui = renderBoth();
    expectSource(ui, "QQ");
    await act(async () => { usePlayerStore.setState({ state: snapshot({ isLocal: true }) }); });
    expectSource(ui, "QQ");
    await act(async () => {
      const local = { ...original, platform: "local", id: "C:/music/test.flac" };
      usePlayerStore.setState({ state: snapshot({ track: local, sourceId: "local", trackId: local.id, isLocal: true, playUrl: null }) });
    });
    expectSource(ui, null);
    await act(async () => {
      const podcast = { ...original, platform: "podcast" };
      usePlayerStore.setState({ state: snapshot({ track: podcast, sourceId: "podcast" }) });
    });
    expectSource(ui, "播客");
  });

  it("注册表加载或移除源时，两处同时重算当前来源", async () => {
    const sources = useSourceRegistryStore.getState().sources;
    useSourceRegistryStore.setState({ sources: [sources[0]], generation: 2 });
    rememberPlayUrlLine(original, "320", crossLine);
    const ui = renderBoth();
    expectSource(ui, "QQ");
    await act(async () => { useSourceRegistryStore.setState({ sources, generation: 3 }); });
    expectSource(ui, "酷我");
    await act(async () => { useSourceRegistryStore.setState({ sources: [sources[0]], generation: 4 }); });
    expectSource(ui, "QQ");
  });
});
