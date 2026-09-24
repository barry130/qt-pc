// @vitest-environment jsdom
/**
 * 播放条「播放地址」面板（qt_admin 专属）：
 * 除了地址本身，还要显示这条地址是**音源包里哪条源**取到的（line）。
 * 这里覆盖三种状态：命中线路 / 未知（包内缓存）/ 非管理员看不到入口。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({})),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: { canGoBack: () => false, back: vi.fn() } }),
  useRouterState: (opts?: { select?: (s: unknown) => unknown }) => {
    const snapshot = { location: { pathname: "/" } };
    return opts?.select ? opts.select(snapshot) : snapshot;
  },
}));

import { PlayerBar } from "@/components/PlayerBar";
import { clearPlayUrlLines, rememberPlayUrlLine } from "@/source-scripts/playurl-line";
import { useAuthStore } from "@/stores/auth";
import { usePlayerStore } from "@/stores/player";
import type { PlaybackState, Track } from "@/types";

const track: Track = {
  id: "000iBXhy1RQDgL",
  platform: "qq",
  title: "微光",
  singer: "任歌飞",
  album: "",
  picUrl: "",
  duration: 161,
  musicId: null,
};

function snapshot(playUrl: string | null): PlaybackState {
  return {
    trackId: track.id,
    sourceId: "qq",
    status: "playing",
    positionMs: 1000,
    durationMs: 161_000,
    bufferedMs: 0,
    volume: 0.8,
    muted: false,
    playMode: "listLoop",
    quality: "320",
    queueIndex: 0,
    queueLen: 1,
    isLocal: false,
    urlFetchedAt: null,
    playUrl,
    error: null,
    sleepTimerMs: null,
    track,
    outputDevice: "",
  };
}

/** 点开「播放地址」面板（入口按钮按 label 找） */
function openPanel(container: HTMLElement): void {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.title === "播放地址（仅管理员）",
  );
  expect(button).toBeTruthy();
  fireEvent.click(button!);
}

beforeEach(() => {
  clearPlayUrlLines();
  usePlayerStore.setState({ state: snapshot("http://dl.music.example/weiguang.mp3") });
  useAuthStore.setState({ profile: { roles: ["qt_admin"] } });
});

describe("播放地址面板：音源线路", () => {
  it("命中过线路：显示「名称 · 机制 · 线路 id」+ 地址", () => {
    rememberPlayUrlLine(track, "320", {
      id: "qq-molan-tx",
      name: "墨澜 tx（聚合内核）",
      kind: "lx",
    });
    const { container } = render(<PlayerBar />);
    openPanel(container);
    expect(container.textContent).toContain("音源线路：");
    expect(container.textContent).toContain("墨澜 tx（聚合内核） · lx · qq-molan-tx");
    expect(container.textContent).toContain("http://dl.music.example/weiguang.mp3");
  });

  it("没记录过（包内缓存命中/旧包）：显示「未知」而不是空白", () => {
    const { container } = render(<PlayerBar />);
    openPanel(container);
    expect(container.textContent).toContain("音源线路：");
    expect(container.textContent).toContain("未知");
  });

  it("音质不同不算命中：换档后线路按 key 区分", () => {
    rememberPlayUrlLine(track, "128", {
      id: "qq-molan-tx",
      name: "墨澜 tx（聚合内核）",
      kind: "lx",
    });
    const { container } = render(<PlayerBar />);
    openPanel(container);
    // 当前在播是 320，128 的记录不该串过来
    expect(container.textContent).not.toContain("qq-molan-tx");
    expect(container.textContent).toContain("未知");
  });

  it("非管理员：入口整个不渲染", () => {
    useAuthStore.setState({ profile: { roles: ["qt_user"] } });
    const { container } = render(<PlayerBar />);
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.title === "播放地址（仅管理员）",
    );
    expect(button).toBeUndefined();
  });
});
