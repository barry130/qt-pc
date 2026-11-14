import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getPitchVersion, invalidatePitchRead, usePitchStore } from "@/stores/pitch";
import { errMsg } from "@/lib/utils";
import type { FxState } from "@/types";

type Consumer = { ready: (fx: FxState) => void; error: (message: string) => void };
let refs = 0;
let generation = 0;
let unlisten: UnlistenFn | null = null;
let pendingRegistration: Promise<void> | null = null;
const consumers = new Set<Consumer>();

function startRegistration(): void {
  const token = ++generation;
  invalidatePitchRead();
  const baseline = getPitchVersion();
  const current = (): boolean => refs > 0 && token === generation;
  const hydrate = async (): Promise<void> => {
    if (!current()) return;
    try {
      const fx = await usePitchStore.getState().readFx(baseline);
      if (current()) for (const consumer of consumers) consumer.ready(fx);
    } catch (error) {
      if (current()) for (const consumer of consumers) consumer.error(errMsg(error));
    }
  };
  const registration = listen<number>("pitch-changed", ({ payload }) => {
    if (current()) usePitchStore.getState().applyNative(payload);
  }).then(async (stop) => {
    if (!current()) { stop(); return; }
    unlisten = stop;
    // Start the read after listen ACK. Events before/during the read advance the
    // store watermark, so their persisted value wins over an older snapshot.
    await hydrate();
  }, hydrate).finally(() => {
    if (pendingRegistration === registration) pendingRegistration = null;
  });
  pendingRegistration = registration;
}

/** One shared native listener, refreshed on every 0→1 mount. Late ACKs are disposed. */
export function usePitchSync(
  onReady?: (fx: FxState) => void,
  onError?: (message: string) => void,
): void {
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };
  useEffect(() => {
    const consumer: Consumer = {
      ready: (fx) => callbacks.current.onReady?.(fx),
      error: (message) => callbacks.current.onError?.(message),
    };
    consumers.add(consumer);
    refs += 1;
    if (refs === 1) startRegistration();
    else if (!pendingRegistration) {
      void usePitchStore.getState().readFx().then((fx) => {
        if (consumers.has(consumer)) consumer.ready(fx);
      }).catch((error: unknown) => {
        if (consumers.has(consumer)) consumer.error(errMsg(error));
      });
    }
    return () => {
      consumers.delete(consumer);
      refs -= 1;
      if (refs === 0) {
        generation += 1;
        invalidatePitchRead();
        unlisten?.();
        unlisten = null;
      }
    };
  }, []);
}
