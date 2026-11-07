// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { DlnaCastState, PlaybackState, Track } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { canGoBack: () => false, back: vi.fn() } }),
  useRouterState: (opts: { select: (state: { location: { pathname: string } }) => unknown }) => opts.select({ location: { pathname: "/" } }),
}));
vi.mock("@/hooks/useInterpolatedPosition", () => ({ useInterpolatedPosition: () => 0 }));
vi.mock("@/hooks/useNowPlayingLocalMedia", () => ({ useNowPlayingCover: () => null }));

import { invoke } from "@tauri-apps/api/core";
import { PlayerBar } from "@/components/PlayerBar";
import { usePlayerStore } from "@/stores/player";
import { usePlayerBarStore } from "@/stores/playerBar";

const track: Track = { id: "pause-control", platform: "local", title: "Pause control", singer: "", album: "", picUrl: "", duration: 30 };
const cast: DlnaCastState = {
  sessionId: 1, generation: 1, deviceId: "uuid:tv", deviceName: "客厅电视",
  capabilities: { seek: true, volume: true, pause: false },
};

function snapshot(overrides: Partial<PlaybackState> = {}): PlaybackState {
  return {
    trackId: track.id, sourceId: track.platform, track, cast,
    status: "playing", positionMs: 1000, durationMs: 30000, bufferedMs: 0,
    volume: 0.8, muted: false, playMode: "listLoop", quality: "320", queueIndex: 0, queueLen: 1,
    isLocal: true, urlFetchedAt: null, playUrl: null, error: null,
    sleepTimerMs: null, sleepAfterTrack: false, speed: 1, outputDevice: "", bitrateKbps: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePlayerBarStore.setState({ visible: [], loaded: true });
  usePlayerStore.setState({ state: snapshot() });
});

describe("投屏暂停能力", () => {
  it("设备不支持暂停时禁用暂停，但仍允许恢复播放", async () => {
    render(<PlayerBar />);
    const pause = screen.getByRole<HTMLButtonElement>("button", { name: "暂停" });
    expect(pause.disabled).toBe(true);
    expect(pause.title).toContain("不支持暂停");
    fireEvent.click(pause);
    expect(invoke).not.toHaveBeenCalledWith("pause");

    await act(async () => { usePlayerStore.setState({ state: snapshot({ status: "paused" }) }); });
    const play = screen.getByRole<HTMLButtonElement>("button", { name: "播放" });
    expect(play.disabled).toBe(false);
    fireEvent.click(play);
    expect(invoke).toHaveBeenCalledWith("resume");
  });

  it("支持暂停的设备和切回本机均可正常暂停", async () => {
    usePlayerStore.setState({ state: snapshot({ cast: { ...cast, capabilities: { ...cast.capabilities, pause: true } } }) });
    render(<PlayerBar />);
    const pause = screen.getByRole<HTMLButtonElement>("button", { name: "暂停" });
    expect(pause.disabled).toBe(false);
    fireEvent.click(pause);
    expect(invoke).toHaveBeenCalledWith("pause");

    await act(async () => { usePlayerStore.setState({ state: snapshot({ cast: null }) }); });
    expect(pause.disabled).toBe(false);
    vi.mocked(invoke).mockClear();
    fireEvent.click(pause);
    expect(invoke).toHaveBeenCalledWith("pause");
  });
});
