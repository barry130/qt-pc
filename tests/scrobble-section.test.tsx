// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * 听歌上报（A8 / 分析文档 §4.8）设置页口径（按用户反馈改成「先选目标、只看选中那家」）：
 * - 顶部分段器选目标，只渲染选中目标的配置；未手动选择时默认ListenBrainz（免自建应用）；
 * - Last.fm 没凭据 → 只给 key/secret 两个输入 + 保存，保存后重新读视图（这时才出现连接入口）；
 * - 有凭据未连接 → 「连接 Last.fm」拿授权地址并交给系统浏览器；授权中多一个
 *   「我已完成授权」按钮换 session；
 * - ListenBrainz 只认 token，填了才能点连接；
 * - 另一家也在上报时给「只上报当前目标」的快捷关闭（后端两路独立，这里只是聚焦展示）；
 * - 队列概览与「立即重试」：有 pending 才可点，结果按 sent/retrying/dead 报出来。
 */
const mocks = vi.hoisted(() => ({
  getScrobbleSettings: vi.fn(),
  setLastfmCredentials: vi.fn(async (): Promise<void> => undefined),
  beginLastfmAuth: vi.fn(async (): Promise<string> => "https://www.last.fm/api/auth/?token=t"),
  finishLastfmAuth: vi.fn(async (): Promise<string> => "listener"),
  disconnectLastfm: vi.fn(async (): Promise<void> => undefined),
  connectListenBrainz: vi.fn(async (): Promise<string> => "brainz-user"),
  disconnectListenBrainz: vi.fn(async (): Promise<void> => undefined),
  setScrobbleEnabled: vi.fn(async (): Promise<void> => undefined),
  scrobbleFlush: vi.fn(async () => ({ sent: 2, retrying: 1, dead: 0, error: null })),
  openExternalUrl: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock("@/services/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ipc")>();
  return {
    ...actual,
    getScrobbleSettings: mocks.getScrobbleSettings,
    setLastfmCredentials: mocks.setLastfmCredentials,
    beginLastfmAuth: mocks.beginLastfmAuth,
    finishLastfmAuth: mocks.finishLastfmAuth,
    disconnectLastfm: mocks.disconnectLastfm,
    connectListenBrainz: mocks.connectListenBrainz,
    disconnectListenBrainz: mocks.disconnectListenBrainz,
    setScrobbleEnabled: mocks.setScrobbleEnabled,
    scrobbleFlush: mocks.scrobbleFlush,
    openExternalUrl: mocks.openExternalUrl,
  };
});

import { ScrobbleSection } from "@/components/settings/sections/ScrobbleSection";

type View = Awaited<ReturnType<typeof mocks.getScrobbleSettings.mockResolvedValue>>;

function view(patch?: {
  lastfm?: Partial<Record<string, unknown>>;
  listenbrainz?: Partial<Record<string, unknown>>;
  queue?: Partial<Record<string, unknown>>;
}): Record<string, unknown> {
  return {
    lastfm: {
      connected: false,
      hasCredentials: false,
      enabled: false,
      user: "",
      awaitingAuth: false,
      ...patch?.lastfm,
    },
    listenbrainz: { connected: false, enabled: false, user: "", ...patch?.listenbrainz },
    queue: {
      pending: 0,
      sent: 0,
      dead: 0,
      lastError: null,
      recent: [],
      ...patch?.queue,
    },
  };
}

function setView(v: Record<string, unknown>): void {
  mocks.getScrobbleSettings.mockResolvedValue(v as unknown as View);
}

/** 分段器是 radiogroup + radio，切目标要走这一步 */
function pickTarget(name: "ListenBrainz" | "Last.fm"): void {
  fireEvent.click(screen.getByRole("radio", { name }));
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) {
    (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  mocks.setLastfmCredentials.mockResolvedValue(undefined);
  mocks.beginLastfmAuth.mockResolvedValue("https://www.last.fm/api/auth/?token=t");
  mocks.finishLastfmAuth.mockResolvedValue("listener");
  mocks.connectListenBrainz.mockResolvedValue("brainz-user");
  mocks.scrobbleFlush.mockResolvedValue({ sent: 2, retrying: 1, dead: 0, error: null });
  mocks.openExternalUrl.mockResolvedValue(undefined);
  setView(view());
});

describe("ScrobbleSection", () => {
  it("默认展示 ListenBrainz：填 token 才能连接，成功后回显用户名", async () => {
    render(<ScrobbleSection />);
    const input = await screen.findByLabelText("ListenBrainz user token");
    const connect = screen.getByRole("button", { name: "连接" }) as HTMLButtonElement;
    expect(connect.disabled).toBeTruthy();
    fireEvent.change(input, { target: { value: "tok-1" } });
    expect(connect.disabled).toBeFalsy();
    fireEvent.click(connect);
    await waitFor(() => expect(mocks.connectListenBrainz).toHaveBeenCalledWith("tok-1"));
    await waitFor(() =>
      expect((screen.getByRole("status") as HTMLElement).textContent).toContain("brainz-user"),
    );
  });

  it("切到 Last.fm 才出现 key/secret 输入，保存后调用 setLastfmCredentials", async () => {
    render(<ScrobbleSection />);
    expect(screen.queryByLabelText("Last.fm API key")).toBeNull();
    pickTarget("Last.fm");
    const key = await screen.findByLabelText("Last.fm API key");
    const secret = screen.getByLabelText("Last.fm Shared secret");
    const save = screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
    expect(save.disabled).toBeTruthy();

    fireEvent.change(key, { target: { value: "k123" } });
    fireEvent.change(secret, { target: { value: "s456" } });
    expect(save.disabled).toBeFalsy();

    fireEvent.click(save);
    await waitFor(() => expect(mocks.setLastfmCredentials).toHaveBeenCalledWith("k123", "s456"));
  });

  it("有凭据未连接时发授权并把地址交给系统浏览器", async () => {
    setView(view({ lastfm: { hasCredentials: true } }));
    render(<ScrobbleSection />);
    pickTarget("Last.fm");
    fireEvent.click(await screen.findByRole("button", { name: "连接 Last.fm" }));
    await waitFor(() => expect(mocks.beginLastfmAuth).toHaveBeenCalled());
    await waitFor(() =>
      expect(mocks.openExternalUrl).toHaveBeenCalledWith("https://www.last.fm/api/auth/?token=t"),
    );
    expect((await screen.findByRole("status")).textContent).toContain("已打开浏览器");
  });

  it("授权中显示「我已完成授权」，点完读到用户名", async () => {
    setView(view({ lastfm: { hasCredentials: true, awaitingAuth: true } }));
    render(<ScrobbleSection />);
    pickTarget("Last.fm");
    expect((await screen.findByText(/已发起授权/)).textContent).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "我已完成授权" }));
    await waitFor(() => expect(mocks.finishLastfmAuth).toHaveBeenCalled());
    await waitFor(() =>
      expect((screen.getByRole("status") as HTMLElement).textContent).toContain("listener"),
    );
  });

  it("已连接 Last.fm 时开关走 setScrobbleEnabled('lastfm')", async () => {
    setView(
      view({ lastfm: { hasCredentials: true, connected: true, enabled: false, user: "me" } }),
    );
    render(<ScrobbleSection />);
    pickTarget("Last.fm");
    const toggle = await screen.findByRole("switch");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mocks.setScrobbleEnabled).toHaveBeenCalledWith("lastfm", true),
    );
  });

  it("另一家也在上报时出现「只上报当前目标」并可关掉", async () => {
    setView(
      view({
        lastfm: { hasCredentials: true, connected: true, enabled: true, user: "me" },
        listenbrainz: { connected: true, enabled: true, user: "brainz-user" },
      }),
    );
    render(<ScrobbleSection />);
    // 两家都在上报，顶部应出现提示与快捷关闭（当前目标 = ListenBrainz，关掉 Last.fm）
    fireEvent.click(await screen.findByRole("button", { name: "只上报 ListenBrainz" }));
    await waitFor(() =>
      expect(mocks.setScrobbleEnabled).toHaveBeenCalledWith("lastfm", false),
    );
  });

  it("队列有待发才可重试，结果按 sent/retrying/dead 报出", async () => {
    setView(
      view({
        queue: {
          pending: 3,
          sent: 10,
          lastError: "网络断了",
          recent: [{ target: "lastfm", artist: "某人", title: "某歌", playedAt: 1 }],
        },
      }),
    );
    render(<ScrobbleSection />);
    expect((await screen.findByText(/待发 3/)).textContent).toBeTruthy();
    expect(screen.getByText(/最近一次失败：网络断了/)).toBeTruthy();
    expect(screen.getByText(/某歌 · 某人/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "立即重试" }));
    await waitFor(() => expect(mocks.scrobbleFlush).toHaveBeenCalled());
    await waitFor(() =>
      expect((screen.getByRole("status") as HTMLElement).textContent).toContain(
        "成功 2、待重试 1、放弃 0",
      ),
    );
  });

  it("没连任何服务时重试按钮不可点", async () => {
    render(<ScrobbleSection />);
    const button = await screen.findByRole("button", { name: "立即重试" });
    expect((button as HTMLButtonElement).disabled).toBeTruthy();
  });
});
