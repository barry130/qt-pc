// @vitest-environment jsdom
/**
 * 播放页右键菜单（用户 m02782：右键要能看全部歌词、复制封面地址等）。
 *
 * 覆盖点：菜单项齐全、分组动作真的落到 IPC/剪贴板、本地播放时「播放地址」变成
 * 「本地文件路径」且「打开文件所在位置」可用、在线播放时这些项置灰、
 * 「查看全部歌词」摊开原始 LRC、桌面歌词项随窗口状态换文案。
 *
 * 菜单与面板都 portal 到 body，断言走 document 而非容器子树。
 * 子组件（窗口控制 / 歌词滚动 / 搜索 / 偏移 / 收藏面板 / 换源面板）在这里没有
 * 被测职责，mock 掉以免把它们的 IPC 依赖一起拖进来 —— 本文件只验证右键这一层。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const navigate = vi.hoisted(() => vi.fn());
const location = vi.hoisted(() => ({ pathname: "/playing" }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useLocation: () => location,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));

const checkDisliked = vi.hoisted(() => vi.fn(async (tracks: unknown[]) => tracks.map(() => false)));
const queueAddNext = vi.hoisted(() => vi.fn(async () => undefined));
const queueAppend = vi.hoisted(() => vi.fn(async () => undefined));
const resolveLocalFile = vi.hoisted(() =>
  vi.fn(async (): Promise<{ path: string; kind: string } | null> => null),
);
const revealLocalTrack = vi.hoisted(() => vi.fn(async () => undefined));
const getDesktopLyricState = vi.hoisted(() => vi.fn(async () => ({ visible: false })));
const showDesktopLyric = vi.hoisted(() => vi.fn(async () => ({ visible: true })));
const hideDesktopLyric = vi.hoisted(() => vi.fn(async () => ({ visible: false })));
const getSetting = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null));
const setSetting = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/services/ipc", () => ({
  checkDisliked,
  queueAddNext,
  queueAppend,
  resolveLocalFile,
  revealLocalTrack,
  getDesktopLyricState,
  showDesktopLyric,
  hideDesktopLyric,
  getSetting,
  setSetting,
}));

const banSong = vi.hoisted(() => vi.fn(async () => true));
const unbanSong = vi.hoisted(() => vi.fn(async () => true));
const banSinger = vi.hoisted(() => vi.fn(async () => undefined));
const unbanSinger = vi.hoisted(() => vi.fn(async () => true));
const singerBanned = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/stores/dislikes", () => {
  const store = { version: 0, banSong, unbanSong, banSinger, unbanSinger, singerBanned };
  const useDislikesStore = (sel: (s: typeof store) => unknown): unknown => sel(store);
  useDislikesStore.getState = () => store;
  return { useDislikesStore };
});

const lyric = vi.hoisted(() => ({ lrc: "[00:01.00]第一行\n[00:05.00]第二行", translation: "" }));
vi.mock("@/lib/localOnline", () => ({
  crossSourceForPlayback: () => null,
  getPlaybackLyric: async () => lyric,
}));

vi.mock("@/hooks/useInterpolatedPosition", () => ({ useInterpolatedPosition: () => 0 }));
const lyricReset = vi.hoisted(() => vi.fn());
const lyricOffsetMs = vi.hoisted(() => ({ value: 0 }));
vi.mock("@/hooks/useLyricOffset", () => ({
  useLyricOffset: () => ({
    offsetMs: lyricOffsetMs.value,
    draftMs: lyricOffsetMs.value,
    setDraftMs: vi.fn(),
    commit: vi.fn(),
    reset: lyricReset,
    nudge: vi.fn(),
  }),
}));
vi.mock("@/hooks/useNowPlayingLocalMedia", () => ({ useNowPlayingCover: () => null }));

vi.mock("@/components/WindowControls", () => ({ WindowControls: () => null }));
vi.mock("@/components/lyric/LyricSearchButton", () => ({ LyricSearchButton: () => null }));
vi.mock("@/components/lyric/LyricOffsetControl", () => ({ LyricOffsetControl: () => null }));
vi.mock("@/components/player/LyricScroller", () => ({ LyricScroller: () => null }));
vi.mock("@/components/mine/CollectMenu", () => ({
  CollectMenu: () => <div data-testid="collect-menu">收藏面板</div>,
}));
vi.mock("@/components/player/SourceSwitchPanel", () => ({
  SourceSwitchPanel: () => <div data-testid="switch-panel">换源面板</div>,
  replaceCurrentWithCandidate: vi.fn(async () => undefined),
}));
// 分享面板要画 canvas 且带保存 PNG 的 IPC，不测它本身的绘制细节（另有
// share-card-panel.test.tsx 专测），这里只验证右键能把面板叫出来。
vi.mock("@/components/player/ShareCardPanel", () => ({
  ShareCardPanel: (props: { track: { title: string } }) => (
    <div data-testid="share-panel">分享「{props.track.title}」</div>
  ),
}));

import { PlayingPage } from "@/components/PlayingPage";
import { usePlayerStore } from "@/stores/player";
import { useToastStore } from "@/stores/toast";
import type { PlaybackState, Track } from "@/types";

const writeText = vi.fn(async () => undefined);

function track(over: Partial<Track> = {}): Track {
  return {
    id: "1",
    platform: "qq",
    title: "歌1",
    singer: "周杰伦",
    album: "叶惠美",
    picUrl: "https://img.example.com/1.jpg",
    duration: 200,
    ...over,
  };
}

function snapshot(over: Partial<PlaybackState> = {}): PlaybackState {
  const t = over.track ?? track();
  return {
    trackId: t.id,
    sourceId: t.platform,
    status: "playing",
    positionMs: 0,
    durationMs: 200_000,
    bufferedMs: 0,
    volume: 0.8,
    muted: false,
    playMode: "listLoop",
    quality: "flac",
    queueIndex: 0,
    queueLen: 1,
    isLocal: false,
    urlFetchedAt: null,
    playUrl: "https://cdn.example.com/1.flac",
    error: null,
    sleepTimerMs: null,
    sleepAfterTrack: false,
    speed: 1,
    track: t,
    outputDevice: "",
    bitrateKbps: null,
    ...over,
  };
}

/** 在页面容器上右键（菜单监听挂最外层 div，页面里没有别的右键入口） */
function openMenu(): HTMLElement {
  const host = document.querySelector(".flex.h-full.w-full");
  if (!host) throw new Error("没找到播放页根容器");
  fireEvent.contextMenu(host, { clientX: 120, clientY: 90 });
  return screen.getByRole("menu");
}

function item(menu: HTMLElement, label: string): HTMLButtonElement {
  const el = within(menu).getByText(label).closest("button");
  if (!el) throw new Error(`没找到菜单项「${label}」`);
  return el;
}

describe("播放页右键菜单", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    writeText.mockClear();
    for (const fn of [
      checkDisliked,
      queueAddNext,
      queueAppend,
      resolveLocalFile,
      revealLocalTrack,
      getDesktopLyricState,
      showDesktopLyric,
      hideDesktopLyric,
      banSong,
      unbanSong,
      banSinger,
      unbanSinger,
      singerBanned,
      lyricReset,
    ]) {
      fn.mockClear();
    }
    checkDisliked.mockImplementation(async (tracks: unknown[]) => tracks.map(() => false));
    resolveLocalFile.mockImplementation(async () => null);
    getDesktopLyricState.mockImplementation(async () => ({ visible: false }));
    singerBanned.mockImplementation(() => false);
    lyricOffsetMs.value = 0;
    location.pathname = "/playing";
    useToastStore.setState({ items: [] });
    usePlayerStore.setState({ state: snapshot() });
  });
  afterEach(() => {
    cleanup(); // 菜单 portal 在 body 上，不清理会串到下一个用例
  });

  it("在线曲目：查看 / 复制 / 播放动作齐全", () => {
    render(<PlayingPage />);
    const menu = openMenu();
    for (const label of [
      "分享歌曲",
      "查看全部歌词",
      "显示桌面歌词",
      "查看歌手",
      "查看专辑",
      "复制歌曲信息",
      "复制歌曲 ID",
      "复制封面地址",
      "复制播放地址",
      "下一首播放",
      "加入播放队列",
      "收藏到歌单…",
      "换源播放…",
      "屏蔽这首歌",
      "屏蔽该歌手",
      "重置歌词偏移（当前 0 ms）",
    ]) {
      expect(within(menu).getByText(label)).toBeTruthy();
    }
    // 「复制调试信息」是管理员专属（canDebug）：普通用户/未登录时整项不渲染，
    // 与播放条「播放地址调试入口」同一道闸
    expect(within(menu).queryByText("复制调试信息")).toBeNull();
    // 在线播放没有本地文件：位置项在，但点不动
    expect(item(menu, "打开文件所在位置").disabled).toBe(true);
    // 偏移为 0 时重置项置灰
    expect(item(menu, "重置歌词偏移（当前 0 ms）").disabled).toBe(true);
  });

  it("分享歌曲：右键叫出分享卡片面板，带的是当前曲目", () => {
    render(<PlayingPage />);
    const menu = openMenu();
    fireEvent.click(item(menu, "分享歌曲"));
    // 菜单收起，面板到手
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByTestId("share-panel").textContent).toContain("歌1");
  });

  it("复制歌曲信息 / 封面地址 / 歌曲 ID 都进剪贴板，点完菜单收起", () => {
    render(<PlayingPage />);
    let menu = openMenu();
    fireEvent.click(item(menu, "复制歌曲信息"));
    expect(writeText).toHaveBeenLastCalledWith("歌1 - 周杰伦 - 叶惠美");
    expect(screen.queryByRole("menu")).toBeNull();

    menu = openMenu();
    fireEvent.click(item(menu, "复制封面地址"));
    expect(writeText).toHaveBeenLastCalledWith("https://img.example.com/1.jpg");

    menu = openMenu();
    fireEvent.click(item(menu, "复制歌曲 ID"));
    expect(writeText).toHaveBeenLastCalledWith("qq:1");
  });

  it("在线播放「复制播放地址」给的是实际取链地址", () => {
    render(<PlayingPage />);
    const menu = openMenu();
    fireEvent.click(item(menu, "复制播放地址"));
    expect(writeText).toHaveBeenLastCalledWith("https://cdn.example.com/1.flac");
    expect(queueAppend).not.toHaveBeenCalled();
  });

  it("本地优先命中：文案换成「本地文件路径 / 打开文件所在位置」可用", async () => {
    resolveLocalFile.mockImplementation(async () => ({ path: "D:/music/1.flac", kind: "ledger" }));
    usePlayerStore.setState({ state: snapshot({ isLocal: true, playUrl: null }) });
    render(<PlayingPage />);
    const menu = openMenu();
    // 路径是开菜单时异步查出来的：等它回来再断言
    await waitFor(() => expect(item(menu, "打开文件所在位置").disabled).toBe(false));
    expect(within(menu).queryByText("复制播放地址")).toBeNull();
    fireEvent.click(item(menu, "复制本地文件路径"));
    expect(writeText).toHaveBeenLastCalledWith("D:/music/1.flac");

    // 重新开菜单：本地路径是每次开菜单现查的，要等它回来再点
    const menu2 = openMenu();
    await waitFor(() => expect(item(menu2, "打开文件所在位置").disabled).toBe(false));
    fireEvent.click(item(menu2, "打开文件所在位置"));
    expect(revealLocalTrack).toHaveBeenCalledWith("D:/music/1.flac");
  });

  it("查看全部歌词：面板摊开原始 LRC（含时间轴）", async () => {
    render(<PlayingPage />);
    // 歌词是异步取的：等取回来（菜单项从置灰变可点）再点
    await waitFor(() => {
      expect(item(openMenu(), "查看全部歌词").disabled).toBe(false);
    });
    const menu = screen.getByRole("menu");
    fireEvent.click(item(menu, "查看全部歌词"));
    await waitFor(() => expect(screen.getByText("原始歌词", { exact: false })).toBeTruthy());
    expect(screen.getByText(/\[00:01\.00\]第一行/)).toBeTruthy();
  });

  it("桌面歌词项随窗口状态换文案并能切换", async () => {
    getDesktopLyricState.mockImplementation(async () => ({ visible: true }));
    render(<PlayingPage />);
    const menu = openMenu();
    await waitFor(() => expect(within(menu).getByText("隐藏桌面歌词")).toBeTruthy());
    fireEvent.click(item(menu, "隐藏桌面歌词"));
    expect(hideDesktopLyric).toHaveBeenCalledTimes(1);
    expect(showDesktopLyric).not.toHaveBeenCalled();
  });

  it("下一首播放 / 加入播放队列 / 收藏 / 换源 都接到对应动作", () => {
    render(<PlayingPage />);
    let menu = openMenu();
    fireEvent.click(item(menu, "下一首播放"));
    expect(queueAddNext).toHaveBeenCalledTimes(1);

    menu = openMenu();
    fireEvent.click(item(menu, "加入播放队列"));
    expect(queueAppend).toHaveBeenCalledTimes(1);

    menu = openMenu();
    fireEvent.click(item(menu, "收藏到歌单…"));
    expect(screen.getByTestId("collect-menu")).toBeTruthy();

    menu = openMenu();
    fireEvent.click(item(menu, "换源播放…"));
    expect(screen.getByTestId("switch-panel")).toBeTruthy();
  });

  it("屏蔽这首歌：点一次进屏蔽列表", () => {
    render(<PlayingPage />);
    const menu = openMenu();
    fireEvent.click(item(menu, "屏蔽这首歌"));
    expect(banSong).toHaveBeenCalledTimes(1);
    expect(unbanSong).not.toHaveBeenCalled();
  });

  it("本地曲目：查看歌手 / 专辑 / 换源置灰，路径直接用 track.id", async () => {
    const local = track({ id: "D:/music/a.flac", platform: "local", picUrl: "" });
    usePlayerStore.setState({ state: snapshot({ track: local, trackId: local.id, isLocal: true, playUrl: null }) });
    render(<PlayingPage />);
    const menu = openMenu();
    expect(item(menu, "查看歌手").disabled).toBe(true);
    expect(item(menu, "查看专辑").disabled).toBe(true);
    expect(item(menu, "换源播放…").disabled).toBe(true);
    // 本地曲目的封面没有在线地址可复制
    expect(item(menu, "复制封面地址").disabled).toBe(true);
    await waitFor(() => expect(item(menu, "打开文件所在位置").disabled).toBe(false));
    fireEvent.click(item(menu, "复制本地文件路径"));
    expect(writeText).toHaveBeenLastCalledWith("D:/music/a.flac");
    // 本地曲目不该再去查账本
    expect(resolveLocalFile).not.toHaveBeenCalled();
  });

  it("重置歌词偏移：有偏移时可点，点了归零", () => {
    lyricOffsetMs.value = 3200;
    render(<PlayingPage />);
    const menu = openMenu();
    const reset = item(menu, "重置歌词偏移（当前 3200 ms）");
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    expect(lyricReset).toHaveBeenCalledTimes(1);
  });

  it("歌词字号：菜单三项改的是同一份字号，面板按钮同步", async () => {
    render(<PlayingPage />);
    // 默认 20px：菜单里「重置」置灰，变大/变小都可点
    let menu = openMenu();
    expect(item(menu, "歌词字号变大").disabled).toBe(false);
    expect(item(menu, "歌词字号变小").disabled).toBe(false);
    expect(item(menu, "重置歌词字号（20px）").disabled).toBe(true);
    fireEvent.click(item(menu, "歌词字号变大"));
    await waitFor(() => expect(screen.getByTestId("lyric-font-size-toggle").textContent).toContain("22"));

    // 到上限：变大置灰
    const host = document.querySelector(".flex.h-full.w-full");
    if (!host) throw new Error("没找到播放页根容器");
    for (let i = 0; i < 10; i += 1) {
      fireEvent.contextMenu(host, { clientX: 120, clientY: 90 });
      const m = screen.getByRole("menu");
      fireEvent.click(item(m, "歌词字号变大"));
    }
    await waitFor(() => expect(screen.getByTestId("lyric-font-size-toggle").textContent).toContain("40"));
    menu = openMenu();
    expect(item(menu, "歌词字号变大").disabled).toBe(true);
    // 重置回默认
    fireEvent.click(item(menu, "重置歌词字号（20px）"));
    await waitFor(() => expect(screen.getByTestId("lyric-font-size-toggle").textContent).not.toContain("字号 4"));
  });

  it("点菜单外面 / Esc 都收起", () => {
    render(<PlayingPage />);
    openMenu();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();

    openMenu();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
