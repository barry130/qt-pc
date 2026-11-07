import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/types";
import { installMemoryStorageBoundary } from "./helpers/memory-storage-boundary";

const io = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: io.invoke }));

const KEY = "qt-song-source-choice-v1";
const song = (platform: string): Track => ({
  id: "durable-choice", platform, title: "歌曲", singer: "歌手",
  album: "专辑", picUrl: "", duration: 220,
});

beforeEach(() => {
  vi.resetModules();
  io.invoke.mockReset();
});

describe("preferred source settings ownership", () => {
  it("acknowledges an explicit choice in settings and restores it without browser storage on the next load", async () => {
    // Only the final native IPC boundary is replaced. Both preference APIs and
    // getSetting below are the real public helpers; no database implementation
    // or production collaborator is mocked.
    const browser = installMemoryStorageBoundary().storage;
    const settings = new Map<string, string>();
    let acknowledge!: () => void;
    let writeRequested!: () => void;
    const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
    const request = new Promise<void>(resolve => { writeRequested = resolve; });
    io.invoke.mockImplementation(async (command: string, args: { key: string; value?: string }) => {
      if (command === "get_setting") return settings.get(args.key) ?? null;
      if (command === "set_setting" && typeof args.value === "string") {
        writeRequested();
        await acknowledgement;
        settings.set(args.key, args.value);
        return;
      }
      throw new Error(`Unexpected final IPC: ${command}`);
    });

    const preference = await import("@/lib/preferred-source");
    const ipc = await import("@/services/ipc");
    const original = song("qq"), selected = song("wyy");
    const saving = Promise.resolve(preference.savePreferredSource(original, selected));
    try {
      // A synchronous legacy save may finish without requesting IPC. Racing its
      // completion keeps that implementation testable, rather than timing out
      // on a rendezvous it never reaches. The RED is the settings assertion.
      await Promise.race([request, saving]);
      expect(await ipc.getSetting(KEY)).toBeNull();
      acknowledge();
      await saving;

      const durable = await ipc.getSetting(KEY);
      expect(durable).not.toBeNull();
      expect(JSON.parse(durable!)).toEqual([
        { key: "qq:durable-choice", track: selected },
        { key: "wyy:durable-choice", track: selected },
      ]);

      // A new frontend lifetime cannot recover from the old module cache or
      // synthetic browser storage. The final settings owner alone survives.
      browser.clear();
      vi.resetModules();
      const reloaded = await import("@/lib/preferred-source");
      expect(await reloaded.preferredSource(original)).toEqual(selected);
      expect(await reloaded.preferredSource(selected)).toBeNull();
    } finally {
      acknowledge();
      await saving;
    }
  });
});
