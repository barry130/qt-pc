// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(async () => vi.fn()) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));

import { SoundSection } from "@/components/settings/sections/SoundSection";
import type { FxState } from "@/types";
import { usePitchStore } from "@/stores/pitch";

const fx: FxState = {
  eq: { enabled: false, preampDb: 0, gainsDb: Array(10).fill(0) },
  loudnorm: false,
  fade: { enabled: false, durationMs: 300 },
  spectrum: false,
  replayGain: "off",
  pitchSemitones: 3,
};

beforeEach(() => {
  native.invoke.mockReset();
  native.listen.mockClear();
  native.invoke.mockImplementation(async (command: string, args?: { semitones: number }) => {
    if (command === "get_fx_state") return fx;
    if (command === "set_pitch") return args?.semitones;
    return null;
  });
});

describe("音效页独立升降调", () => {
  it("回读半音，逐级调节、滑条与恢复原调都立即写入，保持倍速不变", async () => {
    render(<SoundSection />);
    const slider = await screen.findByRole("slider", { name: "升降调（半音）" });
    expect((slider as HTMLInputElement).value).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: "升高一个半音" }));
    await waitFor(() => expect((slider as HTMLInputElement).value).toBe("4"));
    fireEvent.click(screen.getByRole("button", { name: "降低一个半音" }));
    await waitFor(() => expect((slider as HTMLInputElement).value).toBe("3"));
    fireEvent.change(slider, { target: { value: "-9" } });
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("set_pitch", { semitones: -9 }));
    fireEvent.click(screen.getByRole("button", { name: "恢复原调" }));
    await waitFor(() => expect((slider as HTMLInputElement).value).toBe("0"));
    await waitFor(() => expect(native.invoke).toHaveBeenLastCalledWith("set_pitch", { semitones: 0 }));
    expect(native.invoke.mock.calls.some(([command]) => command === "set_speed")).toBe(false);
  });

  it("连续拖动串行合并；卸载音效入口仍保存最后一次目标", async () => {
    let resolveFirst!: (value: number) => void;
    let saved = 3;
    native.invoke.mockImplementation((command: string, args?: { semitones: number }) => {
      if (command === "get_fx_state") return Promise.resolve({ ...fx, pitchSemitones: saved });
      if (command === "set_pitch" && args?.semitones === 4) {
        return new Promise<number>((resolve) => { resolveFirst = resolve; }).then((value) => { saved = value; return value; });
      }
      if (command === "set_pitch") { saved = args?.semitones ?? saved; return Promise.resolve(saved); }
      return Promise.resolve();
    });
    const view = render(<SoundSection />);
    const slider = await screen.findByRole("slider", { name: "升降调（半音）" });
    fireEvent.change(slider, { target: { value: "4" } });
    fireEvent.change(slider, { target: { value: "6" } });
    fireEvent.change(slider, { target: { value: "9" } });
    fireEvent.change(slider, { target: { value: "-7" } });
    expect(native.invoke.mock.calls.filter(([command]) => command === "set_pitch")).toEqual([["set_pitch", { semitones: 4 }]]);
    view.unmount();
    await act(async () => { resolveFirst(4); });
    await waitFor(() => expect(usePitchStore.getState().saving).toBe(false));
    expect(native.invoke.mock.calls.filter(([command]) => command === "set_pitch")).toEqual([
      ["set_pitch", { semitones: 4 }], ["set_pitch", { semitones: -7 }],
    ]);
    render(<SoundSection />);
    const restored = await screen.findByRole("slider", { name: "升降调（半音）" });
    expect((restored as HTMLInputElement).value).toBe("-7");
  });

  it("写失败回滚至已确认值，显示错误，下一次成功调整清除错误", async () => {
    const original = native.invoke.getMockImplementation();
    native.invoke.mockImplementation((command: string, args?: { semitones: number }) => {
      if (command === "set_pitch" && args?.semitones === 4) return Promise.reject(new Error("pitch-save-failed"));
      return original?.(command, args);
    });
    render(<SoundSection />);
    const slider = await screen.findByRole("slider", { name: "升降调（半音）" });
    fireEvent.change(slider, { target: { value: "4" } });
    await waitFor(() => expect((slider as HTMLInputElement).value).toBe("3"));
    expect(screen.getByRole("alert").textContent).toContain("pitch-save-failed");
    fireEvent.change(slider, { target: { value: "5" } });
    await waitFor(() => expect(usePitchStore.getState().saving).toBe(false));
    expect((slider as HTMLInputElement).value).toBe("5");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("晚到写ACK不会覆盖写入期间收到的更新native值", async () => {
    let resolveWrite!: (value: number) => void;
    const original = native.invoke.getMockImplementation();
    native.invoke.mockImplementation((command: string, args?: { semitones: number }) => {
      if (command === "set_pitch") return new Promise<number>((resolve) => { resolveWrite = resolve; });
      return original?.(command, args);
    });
    render(<SoundSection />);
    const slider = await screen.findByRole("slider", { name: "升降调（半音）" });
    fireEvent.change(slider, { target: { value: "7" } });
    const subscriptions = native.listen.mock.calls as unknown as Array<[string, (event: { payload: number }) => void]>;
    const subscription = subscriptions.find(([event]) => event === "pitch-changed");
    const callback = subscription?.[1];
    expect(callback).toBeDefined();
    act(() => callback?.({ payload: -4 }));
    expect((slider as HTMLInputElement).value).toBe("7");
    await act(async () => { resolveWrite(7); });
    await waitFor(() => expect((slider as HTMLInputElement).value).toBe("-4"));
  });
});
