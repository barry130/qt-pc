// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import type { MyPlaylistSummary, Track } from "@/types";

const io = vi.hoisted(() => ({
  list: vi.fn(), memberships: vi.fn(), get: vi.fn(), add: vi.fn(), remove: vi.fn(),
  epoch: vi.fn(), isFavorite: vi.fn(), create: vi.fn(), bump: vi.fn(), toast: vi.fn(),
}));
vi.mock("@/services/ipc", () => ({
  LOCAL_PLATFORM: "local",
  listMyPlaylists: io.list, listTrackPlaylists: io.memberships, getPlaylistTracks: io.get,
  addTracksToPlaylist: io.add, removeTracksFromPlaylist: io.remove, likeSessionEpoch: io.epoch,
  isFavorite: io.isFavorite, createPlaylist: io.create,
}));
vi.mock("@/stores/favorites", () => ({
  useFavoritesStore: (selector: (value: { bump: typeof io.bump; version: number }) => unknown) => selector({ bump: io.bump, version: 0 }),
}));
vi.mock("@/hooks/useFavoriteFlags", () => ({ useFavoriteFlags: (tracks: Track[]) => tracks.map(() => false) }));
vi.mock("@/stores/toast", () => ({ toastSuccess: io.toast, toastUndo: vi.fn() }));
vi.mock("@/stores/sourceRegistry", () => ({
  useSourceLabelFn: () => (id: string) => ({ qq: "QQ", wyy: "网易云", kw: "酷我" })[id as "qq" | "wyy" | "kw"] ?? id,
  clampQualityForPlatform: (_source: string, quality: string) => quality,
}));
vi.mock("@/lib/source-quality", () => ({ sourceDownloadQualityOf: () => "320" }));
vi.mock("@/lib/i18n", () => ({ useT: () => () => "收藏" }));

import { CollectMenu } from "@/components/mine/CollectMenu";
import { BatchBar } from "@/components/discovery/BatchBar";
import { trackSelectionKey } from "@/lib/track-selection";
import { CollectButton as PlayerCollectButton } from "@/components/player/CollectButton";
import { CollectButton as RowCollectButton } from "@/components/mine/CollectButton";

const song = (platform: string, id = "1", title = "稻香"): Track => ({
  platform, id, title, singer: "周杰伦", album: "魔杰座", duration: 220, picUrl: "",
});
const a = song("qq"), b = song("wyy"), c = song("kw");
const key = (track: Track) => `${track.platform}:${track.id}`;
let playlists: Map<string, Track[]>, session: number;
function summary(pid: string): MyPlaylistSummary {
  return { id: pid, pid, name: pid === "p1" ? "回归歌单" : pid === "p2" ? "其他歌单" : "新歌单", platform: "local", picUrl: "", trackCount: playlists.get(pid)?.length ?? 0, createdAt: 0, updatedAt: 0, isLocal: true };
}
beforeEach(() => {
  vi.clearAllMocks();
  session = 7;
  playlists = new Map([["p1", [a]], ["p2", [a]]]);
  io.epoch.mockImplementation(async () => session);
  io.list.mockImplementation(async () => [...playlists.keys()].map(summary));
  io.get.mockReset().mockImplementation(async (pid: string) => [...(playlists.get(pid) ?? [])]);
  io.memberships.mockImplementation(async (track: Track) => [...playlists.keys()].filter(pid => playlists.get(pid)?.some(t => key(t) === key(track))));
  io.isFavorite.mockImplementation(async (track: Track) => [...playlists.values()].some(tracks => tracks.some(t => key(t) === key(track))));
  io.add.mockReset().mockImplementation(async (pid: string, tracks: Track[], epoch: number) => {
    if (epoch !== session) throw new Error("账号已变化");
    const stored = playlists.get(pid) ?? [];
    const fresh = tracks.filter(t => !stored.some(old => key(old) === key(t)));
    playlists.set(pid, [...stored, ...fresh]);
    return fresh.length;
  });
  io.remove.mockReset().mockImplementation(async (pid: string, tracks: Track[], epoch: number) => {
    if (epoch !== session) throw new Error("账号已变化");
    const old = playlists.get(pid) ?? [];
    playlists.set(pid, old.filter(t => !tracks.some(drop => key(drop) === key(t))));
    return old.length - (playlists.get(pid)?.length ?? 0);
  });
  io.create.mockImplementation(async () => { playlists.set("new", []); return "new"; });
});

async function selectIncoming(ui: ReturnType<typeof render>) {
  const choice = within(await ui.findByTestId("collect-choice"));
  const inputs = choice.getAllByRole("checkbox") as HTMLInputElement[];
  for (const input of inputs) {
    const isIncoming = input.closest("label")?.textContent?.includes("待收藏") ?? false;
    if (input.checked !== isIncoming) fireEvent.click(input);
  }
  fireEvent.click(choice.getByRole("button", { name: "保存选择" }));
}

describe("collection choice production flow", () => {
  it.each(["player", "row"] as const)("%s keeps the open choice and checked draft across same-song snapshots, but closes on a real change", async (host) => {
    const component = (track: Track) => host === "player" ? <PlayerCollectButton track={track} /> : <RowCollectButton track={track} favorited={false} />;
    const ui = render(component(b));
    fireEvent.click(ui.getByRole("button", { name: "收藏" }));
    fireEvent.click(await ui.findByText("回归歌单"));
    const panel = await ui.findByTestId("collect-choice");
    const checks = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    for (const checkbox of checks) fireEvent.click(checkbox);
    const draft = checks.map(input => input.checked);
    // Native snapshots / list refreshes replace the object without changing its identity.
    for (let i = 0; i < 8; i++) {
      ui.rerender(component({ ...b, picUrl: `cover-${i}`, duration: 221 + i }));
      expect(ui.getByTestId("collect-choice")).toBe(panel);
      expect((within(panel).getAllByRole("checkbox") as HTMLInputElement[]).map(input => input.checked)).toEqual(draft);
    }
    expect(io.add).not.toHaveBeenCalled(); expect(io.remove).not.toHaveBeenCalled();
    // Even an equal raw id on another source is a different song identity.
    ui.rerender(component({ ...b, platform: "kw" }));
    expect(ui.queryByTestId("collect-choice")).toBeNull();
    fireEvent.click(ui.getByRole("button", { name: "收藏" }));
    await ui.findByText("回归歌单");
    ui.rerender(component({ ...b, platform: "kw", id: "other" }));
    expect(ui.queryByText("收藏到歌单")).toBeNull();
  });

  it("version checkboxes and cancel do not bubble into the song row and start playback", async () => {
    const play = vi.fn();
    const ui = render(<div onClick={play}><RowCollectButton track={b} favorited={false} /></div>);
    fireEvent.click(ui.getByRole("button", { name: "收藏" }));
    fireEvent.click(await ui.findByText("回归歌单"));
    const choice = within(await ui.findByTestId("collect-choice"));
    fireEvent.click(choice.getAllByRole("checkbox")[0]);
    fireEvent.click(choice.getByRole("button", { name: "取消" }));
    expect(play).not.toHaveBeenCalled();
    expect(io.add).not.toHaveBeenCalled(); expect(io.remove).not.toHaveBeenCalled();
    // User dismissal remains available after the automatic-close fix.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(ui.queryByText("收藏到歌单")).toBeNull();
    fireEvent.click(ui.getByRole("button", { name: "收藏" }));
    await ui.findByText("回归歌单");
    fireEvent.mouseDown(document.body);
    expect(ui.queryByText("收藏到歌单")).toBeNull();
  });

  it("single-song save replaces unchecked versions in the target playlist and keeps other playlists", async () => {
    playlists.set("p1", [a, c]);
    const close = vi.fn();
    const ui = render(<CollectMenu track={b} onClose={close} />);
    fireEvent.click(await ui.findByText("回归歌单"));
    await ui.findByTestId("collect-choice");
    expect(io.add).not.toHaveBeenCalled();
    expect(io.remove).not.toHaveBeenCalled();
    await selectIncoming(ui);
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(playlists.get("p1")).toEqual([b]);
    expect(playlists.get("p2")).toEqual([a]);
    expect(io.add).toHaveBeenCalledWith("p1", [b], 7);
    expect(io.remove).toHaveBeenCalledWith("p1", expect.arrayContaining([a, c]), 7);
  });

  it("cancelling a choice makes no collection mutation", async () => {
    const ui = render(<CollectMenu track={b} onClose={() => {}} />);
    fireEvent.click(await ui.findByText("回归歌单"));
    const choice = within(await ui.findByTestId("collect-choice"));
    fireEvent.click(choice.getByRole("button", { name: "取消" }));
    expect(io.add).not.toHaveBeenCalled(); expect(io.remove).not.toHaveBeenCalled();
    expect(playlists.get("p1")).toEqual([a]);
  });

  it("the version entry can clean up duplicates already collected", async () => {
    playlists.set("p1", [a, b]);
    const ui = render(<CollectMenu track={a} onClose={() => {}} />);
    fireEvent.click(await ui.findByRole("button", { name: "整理「回归歌单」的重复版本" }));
    const choice = within(await ui.findByTestId("collect-choice"));
    const inputs = choice.getAllByRole("checkbox") as HTMLInputElement[];
    fireEvent.click(inputs.find(input => input.closest("label")?.textContent?.includes("网易云"))!);
    fireEvent.click(choice.getByRole("button", { name: "保存选择" }));
    await waitFor(() => expect(playlists.get("p1")).toEqual([a]));
    expect(playlists.get("p2")).toEqual([a]);
  });

  it("an account change rejects a pending save before writes", async () => {
    const ui = render(<CollectMenu track={b} onClose={() => {}} />);
    fireEvent.click(await ui.findByText("回归歌单"));
    await ui.findByTestId("collect-choice");
    session++;
    await selectIncoming(ui);
    await ui.findByText(/账号已变化/);
    expect(io.add).not.toHaveBeenCalled(); expect(io.remove).not.toHaveBeenCalled();
  });

  it("changing tracks while duplicate lookup is pending cannot open the old choice", async () => {
    let resolve!: (tracks: Track[]) => void;
    const ui = render(<CollectMenu track={b} onClose={() => {}} />);
    await ui.findByText("回归歌单");
    io.get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    fireEvent.click(ui.getByText("回归歌单"));
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    ui.rerender(<CollectMenu track={song("qq", "2", "晴天")} onClose={() => {}} />);
    await act(async () => { resolve([a]); });
    expect(ui.queryByTestId("collect-choice")).toBeNull();
    expect(io.add).not.toHaveBeenCalled();
  });

  it("batch save uses the same version selection and updates the host playlist", async () => {
    const changed = vi.fn(), tracks = [b], selected = new Set(tracks.map(trackSelectionKey));
    const ui = render(<BatchBar tracks={tracks} selected={selected} selectionKey={trackSelectionKey} onSelectedChange={() => {}} hostPlaylistId="p1" onChanged={changed} />);
    fireEvent.click(ui.getByRole("button", { name: "批量收藏（1）" }));
    fireEvent.click(await ui.findByText("回归歌单"));
    await selectIncoming(ui);
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(playlists.get("p1")).toEqual([b]); expect(playlists.get("p2")).toEqual([a]);
  });

  it("creating a new playlist still checks duplicates inside the selected batch", async () => {
    const tracks = [a, b], selected = new Set(tracks.map(trackSelectionKey));
    const ui = render(<BatchBar tracks={tracks} selected={selected} selectionKey={trackSelectionKey} onSelectedChange={() => {}} />);
    fireEvent.click(ui.getByRole("button", { name: "批量收藏（2）" }));
    await ui.findByText("回归歌单");
    fireEvent.change(ui.getByPlaceholderText("新建歌单并收藏"), { target: { value: "新歌单" } });
    fireEvent.click(ui.getByRole("button", { name: "新建歌单并收藏" }));
    const choice = within(await ui.findByTestId("collect-choice"));
    expect(io.add).not.toHaveBeenCalled();
    const inputs = choice.getAllByRole("checkbox") as HTMLInputElement[];
    for (const input of inputs) {
      const wanted = input.closest("label")?.textContent?.includes("网易云") ?? false;
      if (input.checked !== wanted) fireEvent.click(input);
    }
    fireEvent.click(choice.getByRole("button", { name: "保存选择" }));
    await waitFor(() => expect(playlists.get("new")).toEqual([b]));
    expect(playlists.get("p1")).toEqual([a]);
  });

  it("a failed addition never removes the original working version", async () => {
    io.add.mockRejectedValueOnce(new Error("新增失败"));
    const ui = render(<CollectMenu track={b} onClose={() => {}} />);
    fireEvent.click(await ui.findByText("回归歌单"));
    await selectIncoming(ui);
    await ui.findByText(/新增失败/);
    expect(io.remove).not.toHaveBeenCalled(); expect(playlists.get("p1")).toEqual([a]);
  });
});
