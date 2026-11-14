// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));

import { usePitchSync } from "@/hooks/usePitchSync";
import { usePitchStore } from "@/stores/pitch";
import type { FxState } from "@/types";

function fx(pitchSemitones: number): FxState {
  return {
    eq: { enabled: false, preampDb: 0, gainsDb: Array(10).fill(0) },
    loudnorm: false,
    fade: { enabled: false, durationMs: 300 },
    spectrum: false,
    replayGain: "off",
    pitchSemitones,
  };
}

function Probe(): React.JSX.Element {
  const [ready, setReady] = useState(false);
  const value = usePitchStore((state) => state.semitones);
  usePitchSync(() => setReady(true));
  return <output aria-label="pitch-snapshot">{ready ? value : "unset"}</output>;
}

beforeEach(() => {
  native.invoke.mockReset();
  native.listen.mockReset();
  usePitchStore.setState({ semitones: 0, loaded: false, saving: false, error: null });
});

describe("升降调共享订阅生命周期", () => {
  it("等待 listen ACK 再读取，监听期间到达的事件优先于旧快照", async () => {
    let resolveListen!: (stop: () => void) => void;
    const listenReady = new Promise<() => void>((resolve) => { resolveListen = resolve; });
    let resolveRead!: (state: FxState) => void;
    const read = new Promise<FxState>((resolve) => { resolveRead = resolve; });
    native.listen.mockReturnValue(listenReady);
    native.invoke.mockReturnValue(read);
    render(<Probe />);

    expect(native.invoke).not.toHaveBeenCalled();
    resolveListen(vi.fn());
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("get_fx_state"));
    const callback = native.listen.mock.calls[0][1] as (event: { payload: number }) => void;
    callback({ payload: 7 });
    resolveRead(fx(2));
    await waitFor(() => expect(screen.getByLabelText("pitch-snapshot").textContent).toBe("7"));
  });

  it("最后一个入口卸载后重新挂载会重新读取原生值", async () => {
    let resolveFirst!: (stop: () => void) => void;
    native.listen.mockReturnValueOnce(new Promise<() => void>((resolve) => { resolveFirst = resolve; }));
    native.invoke.mockResolvedValueOnce(fx(2));
    const first = render(<Probe />);
    resolveFirst(vi.fn());
    await waitFor(() => expect(screen.getByLabelText("pitch-snapshot").textContent).toBe("2"));
    first.unmount();

    let resolveSecond!: (stop: () => void) => void;
    native.listen.mockReturnValueOnce(new Promise<() => void>((resolve) => { resolveSecond = resolve; }));
    native.invoke.mockResolvedValueOnce(fx(9));
    render(<Probe />);
    resolveSecond(vi.fn());
    await waitFor(() => expect(screen.getByLabelText("pitch-snapshot").textContent).toBe("9"));
  });
});
