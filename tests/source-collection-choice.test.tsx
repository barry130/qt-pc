// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { preferredSource, savePreferredSource } from "@/lib/preferred-source";
import { buildCollectChoice, collectKey, resolveCollectChoice } from "@/lib/collect-choice";
import { CollectChoice } from "@/components/mine/CollectChoice";
import { applyCollectChoice } from "@/lib/apply-collect-choice";
import type { Track } from "@/types";
const io = vi.hoisted(() => ({ likeSessionEpoch: vi.fn(), getPlaylistTracks: vi.fn(), addTracksToPlaylist: vi.fn(), removeTracksFromPlaylist: vi.fn() }));
const native = vi.hoisted(() => ({ invoke: vi.fn(), settings: new Map<string, string>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@/services/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/ipc")>()), ...io,
}));
vi.mock("@/stores/sourceRegistry", () => ({ useSourceLabelFn: () => (id: string) => id }));
const song = (platform: string, id = "1", title = "稻香"): Track => ({ id, platform, title, singer: "周杰伦", album: "魔杰座", duration: 220, picUrl: "" });
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); native.settings.clear();
  io.likeSessionEpoch.mockResolvedValue(7);
  native.invoke.mockImplementation(async (command: string, args: { key: string; value?: string }) => {
    if (command === "get_setting") return native.settings.get(args.key) ?? null;
    if (command === "set_setting" && typeof args.value === "string") { native.settings.set(args.key, args.value); return; }
    throw new Error(`Unexpected final native IPC: ${command}`);
  });
});
describe("explicit preferred source", () => {
  it("persists A→B→C, restores via original identity, strips transient fields, returns to A without loops", async () => {
    const a = song("qq"), b = song("wyy"), c = song("kw");
    await savePreferredSource(a, { ...b, url: "https://temporary" } as Track);
    expect(await preferredSource(a)).toEqual(b);
    await savePreferredSource(b, c); expect(await preferredSource(a)).toEqual(c); expect(await preferredSource(b)).toEqual(c);
    await savePreferredSource(c, a); expect(await preferredSource(a)).toBeNull(); expect(await preferredSource(b)).toEqual(a);
    expect(JSON.stringify(await preferredSource(b))).not.toContain("temporary");
  });
  it("never overrides local audio or another song", async () => {
    await savePreferredSource(song("qq"), song("wyy"));
    expect(await preferredSource(song("qq", "other"))).toBeNull();expect(await preferredSource(song("local"))).toBeNull();
  });
  it("keeps early choices after more than 600 songs are saved and uses an index for repeated reads", async () => {
    const original = song("qq", "first"), selected = song("wyy", "first");
    await savePreferredSource(original, selected);
    for (let i = 0; i < 600; i++) await savePreferredSource(song("qq", "bulk-" + i), song("wyy", "bulk-" + i));
    expect(await preferredSource(original)).toEqual(selected);
    // SQLite is reread for freshness; its unchanged acknowledged value must not
    // repeatedly deserialize the bulk array instead of using the indexed cache.
    const parse = vi.spyOn(JSON, "parse");
    for (let i = 0; i < 50; i++) expect(await preferredSource(original)).toEqual(selected);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });
});
describe("collection version choice", () => {
  it("selecting a new version replaces all unchecked existing versions, unrelated tracks stay outside the plan", () => {
    const old = song("qq"), old2 = song("kw"), incoming = song("wyy"), unrelated = song("qq", "2", "晴天");
    const plan = buildCollectChoice([old, old2, unrelated], [incoming]);
    expect(plan.groups).toHaveLength(1);
    const chosen = resolveCollectChoice(plan, [collectKey(incoming)]);
    expect(chosen.adds).toEqual([incoming]); expect(chosen.removes).toEqual(expect.arrayContaining([old, old2]));expect(chosen.removes).not.toContain(unrelated);
  });
  it("finds duplicates inside an incoming batch and requires one kept version per group", () => {
    const a = song("qq"), b = song("wyy");const plan = buildCollectChoice([], [a, b, a]);
    expect(plan.groups).toHaveLength(1);expect(() => resolveCollectChoice(plan, [])).toThrow();
    expect(resolveCollectChoice(plan, [collectKey(b)]).adds).toEqual([b]);
  });
  it("shows source, singer, album and selectable old/new versions; no writes until save", () => {
    const a = song("qq"), b = song("wyy"), save = vi.fn();
    const ui = render(<CollectChoice plan={buildCollectChoice([a], [b])} busy={false} onCancel={() => {}} onSave={save} />);
    const checks = ui.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checks[0].checked).toBe(false);expect(checks[1].checked).toBe(true);
    fireEvent.click(checks[0]);fireEvent.click(checks[1]);expect(save).not.toHaveBeenCalled();
    fireEvent.click(ui.getByText("保存选择"));expect(save.mock.calls[0][0].removes).toEqual([a]);expect(save.mock.calls[0][0].adds).toEqual([b]);
  });
  it("adds and verifies before removal; a failed add never deletes the old version", async () => {
    const a = song("qq"), b = song("wyy"), plan = resolveCollectChoice(buildCollectChoice([a], [b]), [collectKey(b)]);
    io.getPlaylistTracks.mockResolvedValue([a]);io.addTracksToPlaylist.mockRejectedValueOnce(new Error("offline"));
    await expect(applyCollectChoice("p1", plan, [a], 7)).rejects.toThrow("offline");expect(io.removeTracksFromPlaylist).not.toHaveBeenCalled();
    io.addTracksToPlaylist.mockResolvedValue(1);io.getPlaylistTracks.mockResolvedValueOnce([a]).mockResolvedValueOnce([a,b]).mockResolvedValueOnce([b]);
    await applyCollectChoice("p1", plan, [a], 7);expect(io.removeTracksFromPlaylist).toHaveBeenCalledWith("p1", [a], 7);
  });
  it("rejects account and playlist changes before mutations", async () => {
    const a = song("qq"), b = song("wyy"), plan = resolveCollectChoice(buildCollectChoice([a], [b]), [collectKey(b)]);
    io.likeSessionEpoch.mockResolvedValueOnce(8);await expect(applyCollectChoice("p",plan,[a],7)).rejects.toThrow("账号");
    io.getPlaylistTracks.mockResolvedValue([]);await expect(applyCollectChoice("p",plan,[a],7)).rejects.toThrow("歌单");expect(io.addTracksToPlaylist).not.toHaveBeenCalled();
  });
  it("closing the panel after an acknowledged addition finishes the explicitly saved replacement", async () => {
    const a = song("qq"), b = song("wyy"), plan = resolveCollectChoice(buildCollectChoice([a], [b]), [collectKey(b)]);
    let active = true;
    io.getPlaylistTracks.mockResolvedValueOnce([a]).mockResolvedValueOnce([a, b]).mockResolvedValueOnce([b]);
    io.addTracksToPlaylist.mockImplementationOnce(async () => { active = false; return 1; });
    await applyCollectChoice("p", plan, [a], 7, () => active);
    expect(io.removeTracksFromPlaylist).toHaveBeenCalledWith("p", [a], 7);
  });
});
