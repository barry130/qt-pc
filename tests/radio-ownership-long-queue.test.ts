// @vitest-environment jsdom
/**
 * 私人 FM 让位时机（C07）：归属核对必须排在「余量够不够补歌」之前。
 *
 * 以前 `ensure()` 先看 `shouldRefill(remaining)`，长队列（余量充足）永远走不到
 * 归属核对：用户双击了自己的 50 首歌单，FM 的 `queueClaimed` 还挂着，之后退出
 * FM 会把原列表盖到用户自己的队列上。现在只要队列异主，哪怕余量再多也立刻让位。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => new Map<string, string>());
const ipcMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  getLocalTracks: vi.fn(),
  checkDisliked: vi.fn(),
  queueAppend: vi.fn(),
  addDislikeSong: vi.fn(),
  setPlayMode: vi.fn(),
  seek: vi.fn(),
  pause: vi.fn(),
}));

vi.mock("@/services/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ipc")>();
  return { ...ipcMocks, SOURCE_META_CHANGED_EVENT: actual.SOURCE_META_CHANGED_EVENT,
    SOURCE_PACK_CHANGED_EVENT: actual.SOURCE_PACK_CHANGED_EVENT };
});

const recommendMocks = vi.hoisted(() => ({
  loadPreference: vi.fn(),
}));

vi.mock("@/lib/daily-recommend", () => recommendMocks);

import { usePlayerStore } from "@/stores/player";
import { useRadioStore } from "@/stores/radio";
import { trackKey } from "@/lib/text";
import type { Track } from "@/types";
import type { StyleProfile } from "@/lib/recommend-types";

function track(id: string): Track {
  return { id, platform: "local", title: `歌曲 ${id}`, singer: `歌手 ${id}`, album: "专辑", picUrl: "", duration: 240 };
}

const fmTracks = Array.from({ length: 50 }, (_, index) => track(`fm${index}`));
const foreignTracks = Array.from({ length: 50 }, (_, index) => track(`x${index}`));

const profile: StyleProfile = {
  langs: { zh: 1 },
  bands: { normal: 1 },
  mainLang: "zh",
  mainBand: "normal",
  singers: {},
  albums: {},
  tags: [],
  sampleSize: 20,
};

beforeEach(() => {
  vi.clearAllMocks();
  settings.clear(); // An absent preference preserves the application FM default.
  ipcMocks.getSetting.mockImplementation(async (key: string) => settings.get(key) ?? null);
  ipcMocks.setSetting.mockImplementation(async (key: string, value: string) => { settings.set(key, value); });
  ipcMocks.setPlayMode.mockResolvedValue(undefined);
  ipcMocks.seek.mockResolvedValue(undefined);
  ipcMocks.pause.mockResolvedValue(undefined);
  usePlayerStore.setState({ queue: [], queueIndex: null, state: null });
  useRadioStore.setState({
    active: false,
    queueClaimed: false,
    restorePlayMode: null,
    stash: null,
    loading: false,
    error: null,
    taste: "heart",
    seed: null,
    usedKeys: new Set<string>(),
    pool: [],
    disliked: [],
    profile: null,
    quality: undefined,
    savedKeys: new Set<string>(),
    playedKeys: new Set<string>(),
    exhausted: false,
  });
});

describe("FM 让位时机（C07）", () => {
  it("长外部队列（余量充足）也立刻让位，退出时不再盖掉用户队列", async () => {
    useRadioStore.setState({
      active: true,
      queueClaimed: true,
      usedKeys: new Set(fmTracks.map(trackKey)),
      pool: fmTracks,
      disliked: fmTracks.map(() => false),
      profile,
      stash: { queue: [track("p1")], index: 0, positionMs: 30_000, playing: true },
    });
    // 用户双击了自己的 50 首歌单：位置在 0，余量 49 首，远高于补歌阈值
    usePlayerStore.setState({ queue: foreignTracks, queueIndex: 0 });

    await useRadioStore.getState().tick();

    const state = useRadioStore.getState();
    expect(state.active).toBe(false);
    expect(state.queueClaimed).toBe(false);
    expect(state.stash).toBeNull();
    expect(ipcMocks.queueAppend).not.toHaveBeenCalled();
    // 让位退出不还原原列表：用户自己的队列不能被 FM 的 stash 覆盖
    expect(usePlayerStore.getState().queue).toBe(foreignTracks);
  });

  it("长 FM 队列（余量充足）保持持有，不误让位也不补歌", async () => {
    useRadioStore.setState({
      active: true,
      queueClaimed: true,
      usedKeys: new Set(fmTracks.map(trackKey)),
      pool: fmTracks,
      disliked: fmTracks.map(() => false),
      profile,
    });
    usePlayerStore.setState({ queue: fmTracks, queueIndex: 0 });

    await useRadioStore.getState().tick();

    const state = useRadioStore.getState();
    expect(state.active).toBe(true);
    expect(state.queueClaimed).toBe(true);
    expect(ipcMocks.queueAppend).not.toHaveBeenCalled();
  });

  it("余量见底且队列仍归 FM：照常补一批", async () => {
    useRadioStore.setState({
      active: true,
      queueClaimed: true,
      usedKeys: new Set(fmTracks.map(trackKey)),
      pool: [...fmTracks, track("extra1"), track("extra2")],
      disliked: [...fmTracks, track("extra1"), track("extra2")].map(() => false),
      profile,
    });
    usePlayerStore.setState({ queue: fmTracks, queueIndex: fmTracks.length - 1 });

    await useRadioStore.getState().tick();

    expect(ipcMocks.queueAppend).toHaveBeenCalledTimes(1);
    expect(useRadioStore.getState().active).toBe(true);
  });
});
