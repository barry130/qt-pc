// @vitest-environment jsdom
// Public panel -> actual preferences/player/search facade -> raw Tauri boundary.
// No provider/store/helper replacement, host Storage, Native Pause, or timer races.
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { PlayTarget, QueueCommitReply, Track } from "@/types";
import type { PlayActionResult } from "@/stores/player";
import { installMemoryStorageBoundary } from "./helpers/memory-storage-boundary";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  emitTo: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: native.invoke,
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  listen: native.listen,
  emitTo: native.emitTo,
  emit: native.emit,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("a source choice waiting for its preference ACK cannot become newer than a subsequent Web queue play", async () => {
  // Must precede every production value import: persisted stores hydrate at import.
  const storage = installMemoryStorageBoundary();
  const original: Track = {
    id: "owned-original-a", platform: "wyy", title: "Owned source-choice song",
    singer: "Owned artist", album: "Owned album", picUrl: "", duration: 180,
  };
  const candidate: Track = {
    ...original, id: "owned-candidate-b", platform: "qq", musicId: null,
  };
  const newer: Track = {
    id: "owned-newer-local", platform: "local", title: "Newer local choice",
    singer: "Owned artist", album: "", picUrl: "", duration: 210,
  };
  const settings = new Map<string, string>();
  const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
  const preferenceAck = deferred<void>();
  const cacheClear = deferred<{ clearedCount: number }>();
  const writes: { key: string; value: string }[] = [];
  const begins: { ticket: number; afterAck: boolean }[] = [];
  const abandoned: number[] = [];
  const queueRequests: { tracks: Track[]; startIndex: number; playIntent: unknown }[] = [];
  const acceptedQueues: Track[][] = [];
  const resolveRequests: Record<string, unknown>[] = [];
  const searchRequests: Record<string, unknown>[] = [];
  const picked: Track[] = [];
  const actions: Promise<unknown>[] = [];
  const newerReceipts: PlayActionResult[] = [];
  let preferenceAckReleased = false;
  let nextTicket = 700;
  let pendingNativeTicket: number | null = null;
  let nativeTarget: PlayTarget | null = null;
  let clearCount = 0;
  let unmount: (() => void) | undefined;
  let candidateButton: HTMLButtonElement | undefined;
  let clicked = false;

  const releasePreferenceAck = (): void => {
    preferenceAckReleased = true;
    preferenceAck.resolve();
  };
  const respond = (payload: Record<string, unknown>): void => {
    for (const callback of listeners.get("source-engine-response") ?? []) callback({ payload });
  };

  native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "get_setting") return settings.get(String(args?.key)) ?? null;
    if (command === "set_setting") {
      const entry = { key: String(args?.key), value: String(args?.value) };
      writes.push(entry);
      await preferenceAck.promise;
      settings.set(entry.key, entry.value); // Durable only when the raw ACK is released.
      return;
    }
    if (command === "begin_play_intent") {
      const ticket = ++nextTicket;
      pendingNativeTicket = ticket;
      begins.push({ ticket, afterAck: preferenceAckReleased });
      return ticket;
    }
    if (command === "abandon_play_intent") {
      const ticket = Number(args?.playIntent);
      abandoned.push(ticket);
      // Committed/replaced tickets cannot cancel a newer pending intent or mount.
      if (pendingNativeTicket === ticket) pendingNativeTicket = null;
      return;
    }
    if (command === "play_queue") {
      const tracks = (args?.tracks as Track[]).map((track) => ({ ...track }));
      const startIndex = Number(args?.startIndex);
      const playIntent = args?.playIntent;
      queueRequests.push({ tracks, startIndex, playIntent });
      if (typeof playIntent !== "number" || playIntent !== pendingNativeTicket) {
        return { applied: false, target: null } satisfies QueueCommitReply;
      }
      pendingNativeTicket = null;
      const target = tracks[startIndex];
      nativeTarget = target ? { generation: playIntent, platform: target.platform, id: target.id } : null;
      acceptedQueues.push(tracks);
      return { applied: true, target: nativeTarget } satisfies QueueCommitReply;
    }
    if (command === "clear_play_url_cache") {
      clearCount += 1;
      return cacheClear.promise;
    }
    // Let an incorrectly admitted old action finish all the way to play_queue;
    // an artificial resolution failure must not hide the user-visible overwrite.
    if (command === "set_resolved_play_url" || command === "seek") return;
    throw new Error(`Unexpected native command in source-choice fixture: ${command}`);
  });
  native.listen.mockImplementation(async (
    name: string,
    callback: (event: { payload: unknown }) => void,
  ) => {
    const handlers = listeners.get(name) ?? new Set();
    handlers.add(callback);
    listeners.set(name, handlers);
    return () => { handlers.delete(callback); };
  });
  native.emit.mockResolvedValue(undefined);
  native.emitTo.mockImplementation(async (
    _label: string,
    event: string,
    request: Record<string, unknown>,
  ) => {
    if (event !== "source-engine-request") throw new Error(`Unexpected engine event: ${event}`);
    if (request.kind === "status") {
      respond({ requestId: request.requestId, phase: "ready", pack: null });
    } else if (request.kind === "invoke" && request.entry === "sourceRegistry") {
      respond({ requestId: request.requestId, result: JSON.stringify({ sources: [], qualities: [] }) });
    } else if (request.kind === "invoke" && request.entry === "searchAll") {
      searchRequests.push(request);
      respond({
        requestId: request.requestId,
        result: JSON.stringify({ batches: [{
          source: "qq",
          list: [{
            id: "owned-candidate-b", name: "Owned source-choice song", singer: "Owned artist",
            album: "Owned album", picUrl: "", interval: 180, musicId: null,
          }],
        }] }),
      });
    } else if (request.kind === "resolve") {
      resolveRequests.push(request);
      respond({
        requestId: request.requestId, url: "https://audio.invalid/owned-candidate-b.mp3",
        line: null, referer: "", size: null, actualQuality: "320",
      });
    } else {
      throw new Error(`Unexpected source request: ${String(request.kind)} / ${String(request.entry)}`);
    }
  });

  try {
    const { SourceSwitchPanel } = await import("@/components/player/SourceSwitchPanel");
    const { usePlayerStore } = await import("@/stores/player");
    const { findSourceCandidates } = await import("@/lib/source-switch");
    const { preferredSource } = await import("@/lib/preferred-source");

    // Warm the real candidate cache through its public search API and the actual
    // source-engine request/listen path, not peek-cache or provider/store mocks.
    expect(await findSourceCandidates(original)).toEqual([{ track: candidate, score: 16 }]);
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]?.args).toEqual({ keyword: "Owned source-choice song Owned artist", page: 1, size: 5 });

    function PlaybackSurface() {
      const playQueue = usePlayerStore((store) => store.playQueue);
      return <>
        <SourceSwitchPanel track={original} onPick={(chosen, _original, beforeResolve) => {
          picked.push(chosen);
          // Equivalent to TrackList's forwarding callback: no wrong-original
          // helper guard, and no fresh reservation imported by this regression.
          const action = playQueue([chosen], 0, beforeResolve);
          actions.push(action);
          return action.then(() => undefined);
        }} />
        <button type="button" onClick={() => {
          const action = playQueue([newer], 0);
          actions.push(action);
          const capture = action.then((receipt) => { newerReceipts.push(receipt); });
          actions.push(capture);
          void capture.catch(() => undefined);
        }}>Play newer local queue</button>
      </>;
    }
    const view = render(<PlaybackSurface />);
    unmount = view.unmount;
    candidateButton = view.getByTitle("Owned source-choice song — Owned artist") as HTMLButtonElement;
    fireEvent.click(candidateButton);
    clicked = true;
    await waitFor(() => expect(writes).toHaveLength(1));
    // Observe the real save boundary, without requiring a not-yet-implemented
    // begin to arrive: capture now, assert reservation order after all work ends.
    const beginsWhileSaving = begins.length;
    expect(JSON.parse(writes[0]!.value)).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "wyy:owned-original-a", track: expect.objectContaining({ id: "owned-candidate-b", platform: "qq" }) }),
    ]));
    expect(candidateButton.disabled).toBe(true);
    expect(picked).toEqual([]);
    expect(clearCount).toBe(0);
    expect(acceptedQueues).toEqual([]);

    fireEvent.click(view.getByRole("button", { name: "Play newer local queue" }));
    await act(async () => { await Promise.all(actions); });
    expect(acceptedQueues).toEqual([[newer]]);
    expect(newerReceipts[0]).toMatchObject({ applied: true, target: { platform: "local", id: "owned-newer-local" } });
    const newerTarget = { ...newerReceipts[0]!.target! };
    const beginsBeforeAck = begins.length;

    await act(async () => {
      releasePreferenceAck();
      cacheClear.resolve({ clearedCount: 0 });
    });
    // Enabled again is the public completion of panel.pick's finally, including
    // the callback/clear promises if buggy code admitted the old choice.
    await waitFor(() => expect(candidateButton!.disabled).toBe(false));
    await act(async () => { await Promise.all(actions); });
    expect(await preferredSource(original)).toMatchObject({ id: "owned-candidate-b", platform: "qq" });

    // Check the final audible-effect boundary FIRST: the stale source choice must
    // not dispatch/commit after the newer Web action, even though its save succeeds.
    expect(acceptedQueues).toEqual([[newer]]);
    expect(queueRequests.map(({ tracks }) => tracks)).toEqual([[newer]]);
    expect(nativeTarget).toEqual(newerTarget);
    expect(picked).toEqual([]);
    expect(resolveRequests).toEqual([]);
    expect(native.invoke.mock.calls.filter(([command]) => command === "set_resolved_play_url" || command === "seek")).toEqual([]);
    expect(clearCount).toBe(0);
    expect(beginsWhileSaving).toBe(1);
    expect(beginsBeforeAck).toBe(2);
    expect(begins.map(({ afterAck }) => afterAck)).toEqual([false, false]);
    expect(abandoned).toContain(begins[0]!.ticket);
    expect(pendingNativeTicket).toBeNull();
  } finally {
    // Release both barriers before joining, including on a RED assertion. Waiting
    // for the public enabled button also captures actions admitted after ACK.
    try {
      await act(async () => {
        releasePreferenceAck();
        cacheClear.resolve({ clearedCount: 0 });
        await Promise.allSettled(actions);
      });
      if (clicked && candidateButton?.isConnected) {
        await waitFor(() => expect(candidateButton!.disabled).toBe(false));
      }
      await act(async () => { await Promise.allSettled(actions); });
    } finally {
      unmount?.();
      listeners.clear();
      storage.restore();
    }
  }
});
