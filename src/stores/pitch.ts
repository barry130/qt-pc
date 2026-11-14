import { create } from "zustand";
import { getFxState, setPitch } from "@/services/ipc";
import { errMsg } from "@/lib/utils";
import type { FxState } from "@/types";

export const PITCH_LIMIT = 12;

export function normalizePitch(value: number): number {
  return Number.isFinite(value)
    ? Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, Math.round(value)))
    : 0;
}

interface PitchStore {
  semitones: number;
  loaded: boolean;
  saving: boolean;
  error: string | null;
  readFx: (watermark?: number) => Promise<FxState>;
  change: (semitones: number) => void;
  applyNative: (semitones: number) => void;
}

let epoch = 0;
let eventVersion = 0;
let applied = 0;
let sequence = 0;
let pending: { value: number; sequence: number } | null = null;
let writing = false;
let reading: Promise<FxState> | null = null;

export function getPitchVersion(): number { return epoch; }

/** Invalidate a detached reader before another lifecycle can share its snapshot. */
export function invalidatePitchRead(): void {
  epoch += 1;
  reading = null;
}

/** Owned by the store, not a mounted control: closing the popup never drops a final drag. */
async function drain(): Promise<void> {
  if (writing) return;
  writing = true;
  while (pending) {
    const request = pending;
    const eventsAtStart = eventVersion;
    pending = null;
    try {
      const receipt = normalizePitch(await setPitch(request.value));
      // A newer persisted native event (including another window) wins over the
      // response to an older request. Our own event carries the same value.
      if (eventsAtStart === eventVersion) applied = receipt;
      if (request.sequence === sequence) {
        usePitchStore.setState({ semitones: applied, error: null });
      }
    } catch (error) {
      if (request.sequence === sequence) {
        usePitchStore.setState({ semitones: applied, error: errMsg(error) });
      }
    }
  }
  writing = false;
  usePitchStore.setState({ saving: false });
}

export const usePitchStore = create<PitchStore>((set) => ({
  semitones: 0,
  loaded: false,
  saving: false,
  error: null,
  readFx: (watermark = epoch) => {
    if (reading) return reading;
    const wasIdle = !writing;
    const request = getFxState()
      .then((fx) => {
        // Native events and local edits after registration/read began win. Reads
        // started during a write may still contain a pre-persistence value.
        if (wasIdle && watermark === epoch) {
          applied = normalizePitch(fx.pitchSemitones);
          set({ semitones: applied, loaded: true, error: null });
        }
        return fx;
      })
      .catch((error: unknown) => {
        if (watermark === epoch) set({ error: errMsg(error) });
        throw error;
      })
      .finally(() => { if (reading === request) reading = null; });
    reading = request;
    return request;
  },
  change: (value) => {
    epoch += 1;
    sequence += 1;
    const next = normalizePitch(value);
    pending = { value: next, sequence };
    set({ semitones: next, loaded: true, saving: true, error: null });
    void drain();
  },
  applyNative: (value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    epoch += 1;
    eventVersion += 1;
    applied = normalizePitch(value);
    // Keep the latest optimistic target while local requests are still pending.
    set(writing
      ? { loaded: true }
      : { semitones: applied, loaded: true, error: null });
  },
}));
